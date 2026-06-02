# Authentication and Authorization

_Last updated: 2026-06-02_

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

## Internal staff capabilities (least-privilege roles)

_Added 2026-06-01 (migration 102)._

`super_admin` and `firm_funds_admin` historically shared one all-powerful admin surface. Internal staff are now split into three least-privilege tiers so help can be hired without handing over money movement, deletes, or PII:

- **Owner** - everything, including money, brokerage onboarding, permanent deletes, credential resets, role assignment, and impersonation.
- **Manager** - runs day-to-day operations: deals, KYC, audit, agent invites, paperwork. No money movement, no brokerage onboarding, no deletes, no role management.
- **General Staff** - read dashboards, message users, handle document requests. Nothing sensitive.

### Where the tier lives

A nullable column `user_profiles.staff_role` (`owner | manager | staff`, migration 102) holds the tier. It is deliberately **separate** from `role`:

- `role` stays the coarse identity (`agent | brokerage_admin | firm_funds_admin | super_admin`) and remains the only thing RLS and the proxy route-prefix gate read. **No RLS policy changed**, so no internal user loses read access on day one.
- `staff_role` drives the capability layer in application code. `super_admin` is always treated as `owner` regardless of the column; a `firm_funds_admin` with no `staff_role` defaults to `manager`.

This works because **every mutation uses `createServiceRoleClient()`, which bypasses RLS** - so the real write boundary is the server action's own check, not RLS. The capability layer lives exactly there.

### The capability model (`lib/access.ts`)

- `Capability` - the fine-grained verbs (`money.write`, `deal.underwrite`, `kyc.verify`, `pii.identity`, `pii.banking`, `account.delete`, `brokerage.manage`, `users.credentials`, `audit.read`, `audit.export`, `roles.manage`, `impersonate`, and more).
- `resolveStaffRole(profile)` - maps a profile to `owner | manager | staff | null`.
- `getCapabilities(profile)` / `hasCapability(profile, cap)` - the tier's capability set / a single check.
- `STAFF_ROLE_CAPABILITIES` - the owner/manager/staff bundles. Owner = every capability; Manager = operations minus the dangerous/structural keys; General Staff = `read`, `comms`, `documents.write`.

Unit-tested in `lib/access.test.ts`, including regression guards for the exact policy (money and brokerage onboarding Owner-only, agent invites Manager and up, deletes/credentials/role-management/view-as Owner-only).

### How a server action is gated

Use `getAuthenticatedCapable(capability)` from `lib/auth-helpers.ts` - a drop-in replacement for `getAuthenticatedAdmin()` that returns the same `{ error, user, profile, supabase }` shape and sets `error` when the caller lacks the capability:

```ts
const { error, profile, supabase } = await getAuthenticatedCapable('money.write')
if (error) return { success: false, error }
```

Read-only actions keep `getAuthenticatedAdmin()` (every internal tier holds the read baseline). For actions whose sensitivity depends on the payload (e.g. `updateDealStatus` funding vs underwriting, `updateAgent` touching `outstanding_recovery`), gate at the baseline then branch on `hasCapability(profile, ...)`. Actions that use inline role checks instead of the helpers (e.g. the banking actions in `profile-actions.ts`, `app/api/audit/export`) select `role, staff_role` and call `hasCapability` directly.

### Route gating

`ADMIN_ROUTE_CAPABILITIES` in `lib/access.ts` lists `/admin` sub-paths that need more than read access (`/admin/balance-adjustment` and `/admin/payments` need `money.write`; `/admin/audit` needs `audit.read`). The proxy bounces a staffer lacking the capability back to `/admin` (not signed out). The pages re-check as defense in depth, and the admin dashboard hides nav links a tier cannot use. Assigning tiers and inviting new staff is the Owner-only `/admin/staff` page (`roles.manage`), backed by `lib/actions/staff-role-actions.ts`.

## Impersonation (view as user)

_Added 2026-06-02 (migration 103)._

"View as user" lets an Owner view the app **as** a specific agent or brokerage user to diagnose problems ("I can't see my deal", "the form won't submit"). It carries four guarantees:

- **Look-only.** Every write is blocked while a view-as is active. The Owner can see exactly what the target sees, but cannot change anything on their behalf.
- **Owner-only.** Gated by the `impersonate` capability (migration 102), which only the Owner tier holds.
- **Time-limited.** A hard 30-minute cap (`IMPERSONATION_MAX_DURATION_MS` in `lib/constants.ts`). The on-screen banner counts down to it and auto-exits at zero.
- **Fully audited.** Start, stop, and any blocked action are written to the audit log, always attributed to the real staffer.

Crucially, the Owner's real Supabase auth cookie is **never touched**, so the staffer stays the actor and audit subject everywhere automatically. The target's credentials are never read or changed.

### Source of truth

A view-as is "on" when there is an **active** row in `impersonation_sessions` (migration 103): `ended_at IS NULL` and `expires_at` in the future, keyed by the real (JWT-verified) user id. A partial unique index (`real_user_id WHERE ended_at IS NULL`) guarantees at most one active session per staffer, so "am I viewing as someone?" is simply "is there an active, unexpired row for `auth.uid()`?". There is nothing to forge: the state lives entirely in this table, written only by the service-role client.

### Gating

Starting a session requires the `impersonate` capability (Owner only). The start endpoint (`app/api/impersonation/start/route.ts`) uses `getAuthenticatedCapable('impersonate')`, and `resolveActiveImpersonation` re-checks the capability on every read. Because only Owners can hold the capability, only Owners ever incur the per-request session lookup; for every normal user the impersonation resolution short-circuits to a no-op with no database hit.

### Read path: the identity swap

Server-side, `getAuthenticatedUser()` (`lib/auth-helpers.ts`) swaps the returned `user` + `profile` to the **target** when a session is active, so server components and read actions return the target's data. It also sets `isImpersonating` and carries the actual staffer in `realUser` / `realProfile`. Client-side, the browser Supabase factory (`lib/supabase/client.ts`) overrides `auth.getUser()` to report the target when the non-httpOnly `ff_view_as` hint cookie is present, so the client-rendered dashboards (which resolve their own identity in the browser) render the target's world without each page needing to know about impersonation.

This identity swap is **UI-only**, not a security boundary. RLS is still evaluated on the **real** `auth.uid()` (an Owner is a `super_admin`, who can already read everything), and the dashboards' explicit `agent_id` / `brokerage_id` filters scope the visible data to the target. A forged or hand-edited `ff_view_as` cookie therefore cannot widen what the real user is allowed to read: the worst it can do is point the UI's filters at a different id the Owner could already query directly.

### Write block: look-only

The block lives at the **action layer**, not the transport, because Server Actions are POST whether they read or write (the dashboards read their data via Server Action POSTs, so blocking POST at the proxy would break the faithful view that impersonation exists to provide). Three mechanisms enforce look-only:

- **Self-service writes.** Agent and brokerage WRITE actions use `getAuthenticatedWriter` instead of `getAuthenticatedUser`; it returns a look-only error when `isImpersonating` is set. Reads keep using `getAuthenticatedUser` so the target's world still renders.
- **Admin / money / destructive actions** are blocked automatically: the swapped target holds no admin role or capability, so `getAuthenticatedAdmin` / `getAuthenticatedCapable` deny (the swapped identity is a non-privileged agent or brokerage user, and `getAuthenticatedUser` returns an error rather than swapping when the caller asks for a role the target does not hold).
- **Credential changes** (`changePassword` / `updateEmail`) operate on the cookie session, which is always the real Owner, never the target.

The proxy adds a coarse safety net on top: while a view-as is active it blocks every state-changing `/api/*` request (allowlist: `/api/impersonation/stop` and `/api/session-heartbeat`), confines the Owner to the target's role routes (a `POST` to `/admin/*` and the like is redirected to the target's dashboard, which also prevents admin Server Actions from running), and softens an internal-admin route-role mismatch to a redirect to `/admin` instead of a sign-out (so an expired view-as bounces the Owner home rather than logging them out).

### Banner and time limit

`components/ImpersonationBanner.tsx` is mounted once in `app/(dashboard)/layout.tsx` via `getViewContext()`, so it appears on every dashboard page during a view-as. It shows "Viewing as <name>", a live countdown to the hard expiry (`IMPERSONATION_MAX_DURATION_MS` = 30 minutes), and an Exit button. The countdown auto-fires Exit at zero; Exit ends the session server-side and hard-reloads to `/admin` so the browser drops the view-as identity entirely.

### Logout ends it

The `/api/session-heartbeat` DELETE handler (fired just before logout) ends any active session (`ended_reason = 'logout'`) and clears the hint cookie, so a view-as never silently resumes on the staffer's next login (the session is keyed to the real user id, which is stable across logins).

### Audit

Three actions are emitted, always attributed to the **real** staffer (the actor columns `user_id` / `actor_email` / `actor_role` stay the Owner):

- `impersonation.start` (critical), on start.
- `impersonation.stop` (warning), on Exit, logout, or expiry-driven end.
- `impersonation.blocked` (warning), when a state-changing request is blocked by the proxy.

The target is recorded separately in `audit_log.impersonated_target_id` (migration 103), so a reviewer can filter the log to "everything that happened while viewing as X".

### Entry point

The only way to start a view-as today is an Owner-only "View as this agent" button (`components/admin/ViewAsAgentButton`) on the admin deal detail page (`app/(dashboard)/admin/deals/[id]/page.tsx`), which targets the deal's agent. The button is gated by a `hasCapability(profile, 'impersonate')` check.

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
