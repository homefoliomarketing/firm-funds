# Authentication and Authorization

_Last updated: 2026-05-29_

This document explains how Firm Funds authenticates users, how it determines a user's role and access, how the request proxy gates routes, and how Row Level Security and the service-role client divide security responsibilities.

## Supabase Auth

Authentication is handled by Supabase Auth. Sessions are stored in cookies and refreshed by the request proxy (`proxy.ts`). The app validates the session server-side with `supabase.auth.getUser()` (which verifies the JWT) rather than trusting a client-reported session.

There are three Supabase client factories, and choosing the right one matters:

| Factory | File | Sync or async | RLS | Use for |
| --- | --- | --- | --- | --- |
| `createClient()` (browser) | `lib/supabase/client.ts` | synchronous | enforced | Client components that read or subscribe on behalf of the signed-in user. |
| `createClient()` (server) | `lib/supabase/server.ts` | async (`await`, reads cookies) | enforced | Server components and server actions acting as the signed-in user. |
| `createServiceRoleClient()` | `lib/supabase/server.ts` | synchronous | **bypassed** | Server-side mutations and privileged reads, after the caller has been verified. |

The two server factories share the name `createClient`, so always note which module an import comes from. The browser factory and the cookie-aware server factory both use the anon key and operate under the calling user's RLS policies. The service-role factory uses `SUPABASE_SERVICE_ROLE_KEY`, disables session persistence and token refresh, and bypasses RLS entirely. Its own doc comment warns: only use it in code that has already verified the caller is allowed.

## Magic links and invites

New users are onboarded with single-use invite tokens rather than self-signup.

- **Invite token validation and password set:** `app/api/magic-link/route.ts`.
  - `POST` validates an `invite_tokens` row (checks existence, `used_at`, and `expires_at`) and returns the email and agent name for the welcome screen. All failure modes return an identical error message to prevent token enumeration. The `invite_tokens` table is defined in the root `migrations/006_invite_tokens.sql` (the hand-applied set, separate from `supabase/migrations/`).
  - `PUT` sets the user's password. It enforces a strong-password policy (minimum 12 characters with upper, lower, number, and special), then atomically claims the token with a compare-and-swap on `used_at` (update where `used_at IS NULL`) to close a TOCTOU window where two concurrent requests could both redeem the same token. It sets the password via the admin API, clears `must_reset_password` on `user_profiles`, and writes an audit log entry (logging only a short token prefix, never the full token).
  - Both verbs are rate limited to the sensitive bucket (5 per minute per IP) because the response shape is an enumeration oracle.
- **Email change confirmation:** `app/auth/email-confirmed/route.ts`. Supabase sends a confirmation link to the new address; this route exchanges the PKCE code for a session, reconciles `auth.users.email` against `user_profiles.email` (mirroring if they differ), and redirects to the role's dashboard. This URL must be registered in Supabase Auth redirect URLs. A cross-device safety net in `lib/auth-helpers.ts` (`maybeReconcileEmail`) reconciles on the next authenticated server-action call if the dedicated route never ran.

> The task brief referenced `app/api/auth/callback/route.ts`. That path does not exist in this codebase. The equivalent auth callback is the email-confirmation route above, and the invite redemption flow lives in `app/api/magic-link/route.ts`.

## Roles and how access is determined

The role enum (`types/database.ts`):

```
type UserRole = 'agent' | 'brokerage_admin' | 'firm_funds_admin' | 'super_admin'
```

A user's role lives on their `user_profiles` row, keyed by the Supabase auth user id. Resolution is the same everywhere: read `user_profiles` by `user.id`, then take `profile.role`.

Role alone is not enough to grant access. The app also checks status across linked tables:

- **Profile status:** `user_profiles.is_active`. An inactive user is signed out.
- **Agent status:** for `agent` profiles, the linked `agents` row must have `status = 'active'` and must not be `flagged_by_brokerage`. The agent's `brokerage_id` must point to an active brokerage.
- **Brokerage status:** for `brokerage_admin` profiles (and indirectly for agents), the linked `brokerages` row must have `status = 'active'`.

This composite check is implemented twice for defense in depth, using the same helper predicates in `lib/access.ts`:

- In the proxy: `validateProfileIsAllowed()` in `proxy.ts`, run on every authenticated request.
- In server actions: `getAuthenticatedUser()` / `getAuthenticatedAdmin()` in `lib/auth-helpers.ts`, which return a typed result of `{ error, user, profile, supabase }` and reject before any mutation runs.

The shared helpers in `lib/access.ts` include `getProfileStatusError`, `getAgentStatusError`, `isActiveBrokerageStatus`, `getBrokerageStatusError`, and `isInternalAdminRole` (true for `super_admin` and `firm_funds_admin`). `INTERNAL_ADMIN_ROLES` is the canonical admin role list.

There is also a finer-grained permission for commercially sensitive data: `canViewBrokerageReferralFees()` limits referral-fee visibility to brokerage staff whose `staff_title` is "Broker of Record" or "Brokerage Manager".

## Request proxy: route gating

The request middleware is `proxy.ts` at the repo root. In Next.js 16 this file is named `proxy.ts` and exports a function named `proxy` (the older `middleware.ts` / `middleware` convention does not apply here). Its `config.matcher` runs it on all routes except static assets and a few well-known paths.

What `proxy` does on each request, in order:

1. **CSP nonce.** Generates a per-request nonce and attaches a strict Content Security Policy to the response.
2. **CSRF enforcement.** For state-changing methods (`POST`, `PUT`, `PATCH`, `DELETE`) on `/api/*`, it requires a matching `Origin` (via `isAllowedOrigin` in `lib/csrf.ts`). This runs before the Supabase client is built, so a forged POST is rejected with `403` and never reaches the auth subsystem. Exemptions are listed explicitly (see below).
3. **Session validation.** Builds a cookie-aware server client and calls `auth.getUser()` to validate the JWT.
4. **Public-path gate.** If the user is unauthenticated and the path is not public, redirect to `/login` with a `redirect` query param so the user returns to their destination after login.
5. **Status enforcement.** For authenticated users, re-run the profile/agent/brokerage status checks; sign out and redirect if not allowed.
6. **Password-reset gate.** If `must_reset_password` is set and the password has not been changed, redirect to `/change-password` (or return `403` JSON for API calls). Only a small allowlist of API paths needed by the change-password flow is exempt.
7. **Login redirect.** An authenticated user hitting `/login` is bounced to their role's dashboard, honoring a same-origin, role-prefixed `redirect` param (open-redirect protected).
8. **Role gate.** For protected routes, `ROUTE_ROLES` maps a path prefix to allowed roles and signs out anyone whose role does not match:

| Prefix | Allowed roles |
| --- | --- |
| `/admin` | `super_admin`, `firm_funds_admin` |
| `/brokerage` | `brokerage_admin` |
| `/agent` | `agent` |

### The PUBLIC_PATHS allowlist

`PUBLIC_PATHS` in `proxy.ts` is the explicit list of paths reachable without a session. A path is public if it equals an entry or starts with an entry plus `/`. Anything under `/api/cron/` is also treated as public. Current entries:

| Path | Why it is public |
| --- | --- |
| `/login`, `/auth` | Sign-in and auth callbacks. |
| `/kyc-upload` | Token-authenticated KYC upload page. |
| `/invite` | Invite redemption landing page. |
| `/api/magic-link` | Invite token validation and password set. |
| `/api/rate-limit` | Pre-check used by the change-password page. |
| `/api/docusign/webhook` | DocuSign Connect callback (HMAC verified in handler). |
| `/api/kyc-mobile-upload`, `/api/kyc-desktop-upload`, `/api/kyc-validate-token` | Token-authenticated KYC endpoints. The old `/api/kyc-*` wildcard was replaced with exact matches so a future route cannot accidentally inherit public access. |
| `/api/brokerage/confirm-contact-email` | Single-use token confirms a brokerage contact email; recipient may have no account. |
| `/agent/firm-deal` | Firm-deal offer magic link; the URL token authenticates and mints a session. |
| `/unsubscribe`, `/api/unsubscribe` | CASL unsubscribe landing page and RFC 8058 one-click POST. |

**Why external POST endpoints must be added here.** Any route that accepts a POST from a non-browser caller (a webhook, a provider callback, a mail-client one-click unsubscribe) has no Supabase session and often no browser `Origin`. If it is not in `PUBLIC_PATHS`, the unauthenticated-user gate redirects it to `/login` (a `302`), and the handler never runs. So such routes must be added to `PUBLIC_PATHS`. Separately, state-changing API routes with no browser `Origin` must also be added to the CSRF exemption lists in `proxy.ts` (`API_CSRF_EXEMPT_EXACT` for exact paths, `API_CSRF_EXEMPT_PREFIX` for prefixes like `/api/cron/`), and each such route must carry its own out-of-band authentication (HMAC, a bearer `CRON_SECRET`, or a single-use token in the body).

## RLS as the primary security boundary

Row Level Security in Postgres is the real security boundary. Browser and cookie-aware server clients operate under the calling user's RLS policies, so even a bug in application code cannot read or write rows the policies forbid. The bulk of the `supabase/migrations/` history is RLS policy work (hardening, tightening, closing holes).

The service-role client (`createServiceRoleClient`) is the deliberate exception: it bypasses RLS so server code can perform privileged operations (creating users, funding deals, writing ledger entries, processing webhooks). Because it bypasses RLS, every code path that uses it must verify the caller first, typically through `getAuthenticatedUser()` / `getAuthenticatedAdmin()`. As a rule of thumb, all server-side mutations go through the service-role client after an auth check, and certain balance-affecting writes must use dedicated RPCs (for example `apply_agent_balance_delta`, `record_brokerage_late_strike`, `apply_remediation_remittance`) rather than read-modify-write.

## KYC flow (high level)

KYC (FINTRAC identity verification) uses single-use, time-limited tokens so an agent can upload identity documents without logging in, including from a separate mobile device.

1. A token is issued for an agent and stored in `kyc_upload_tokens` (with `expires_at` and `used_at`).
2. The agent opens the token-bearing upload page (`app/kyc-upload/[token]/`).
3. The page validates the token via `app/api/kyc-validate-token/route.ts`, which checks existence, `used_at`, and `expires_at`. All failure modes return an identical "Invalid or expired link" message to prevent enumeration, and the endpoint is rate limited to the sensitive bucket.
4. Documents are uploaded through `app/api/kyc-mobile-upload/route.ts` or `app/api/kyc-desktop-upload/route.ts` (signed-URL uploads to Supabase Storage).
5. All three KYC routes and the upload page are in `PUBLIC_PATHS` because the token, not a session, is the credential.

See [overview.md](./overview.md) for where KYC sits in the deal lifecycle and [directory-structure.md](./directory-structure.md) for where these files live.
