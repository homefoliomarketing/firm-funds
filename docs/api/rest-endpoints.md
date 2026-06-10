# REST Endpoints

_Last updated: 2026-06-10_

This document describes every request-driven HTTP route under `app/api/` (excluding the scheduled cron routes and inbound webhooks, which are documented separately in `cron-jobs.md` and `webhooks.md`).

## How auth works here

Most routes resolve the caller through Supabase, then read the matching `user_profiles` row to check `role`. The common patterns you will see in the tables below:

- **Session (Supabase cookie):** the route calls `supabase.auth.getUser()` and rejects when there is no user.
- **Role-gated:** after authenticating, the route reads `user_profiles.role` and requires a specific value (`super_admin`, `firm_funds_admin`, `brokerage_admin`, or `agent`).
- **Token in body/query:** unauthenticated by design. A single-use or per-entity token is the authentication (invite tokens, KYC upload tokens, unsubscribe tokens, contact-email confirmation tokens).
- **Secret query key:** a shared secret passed as `?key=` (the seed route only).

Separately, `proxy.ts` (this project's middleware, exported as `proxy`) enforces two things before any handler runs:

1. **CSRF / Origin check** on every state-changing (`POST`, `PUT`, `PATCH`, `DELETE`) `/api/*` request, unless the path is on the CSRF-exempt list (`/api/docusign/webhook`, `/api/unsubscribe`, and any `/api/cron/*`). A forged cross-origin request is rejected with `403` before it reaches the handler.
2. **Auth redirect:** unauthenticated requests to non-public paths are redirected (`302`) to `/login`. Public API paths (allowlisted in `PUBLIC_PATHS`) skip this. See `webhooks.md` for the full note on adding new external POST endpoints to that allowlist.

Several handlers also call `validateOrigin()` themselves as defense in depth even though middleware already covers it.

---

## Auth and session

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/rate-limit` | Public (allowlisted) | Pre-flight rate-limit probe used by client pages (login, password change) before they attempt the real auth call. | JSON body `{ action: 'login' \| 'password' \| 'reset' }` | `{ allowed: true, remaining }` or `429` with `{ allowed: false, retryAfter }`. Invalid action returns `400`. Fails open (returns allowed) on internal error. |
| POST | `/api/session-heartbeat` | Session | Updates `user_profiles.last_active_at` for the current user. Called periodically by the session-timeout client component. Best-effort. | None | `{ ok: true }`. Returns `401` when not authenticated. Fails open on error. |
| DELETE | `/api/session-heartbeat` | Session | Logs a session-end event (`auth.session_timeout`) to the audit trail just before logout. | JSON body `{ reason }` where reason is one of `timeout`, `inactivity`, `manual`, `forced` (defaults to `timeout`) | `{ ok: true }`. Invalid reason returns `400`. Origin-checked and rate-limited. |
| POST | `/api/clear-reset-flag` | Session | Clears the forced-password-reset flag after the user has actually changed their password. Verifies via the Supabase admin API that `updated_at` moved past `created_at` by more than the 60s grace before clearing, so a temp password cannot bypass the reset. | None | `{ success: true }`. Returns `403` if the password is unchanged since invite, `401` if not authenticated. Origin-checked and rate-limited. |

Source files: `app/api/rate-limit/route.ts`, `app/api/session-heartbeat/route.ts`, `app/api/clear-reset-flag/route.ts`.

### Magic-link invite tokens

`/api/magic-link` backs the invite acceptance flow. It is unauthenticated by design: the invite token in the request body is the credential. Both methods use the tighter "sensitive" rate-limit bucket (5/min) to slow token enumeration, and normalize error text so a caller cannot distinguish "token exists" from "token invalid".

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/magic-link` | Public (allowlisted) | Validate an invite token; returns the associated email and agent name for the welcome screen. | JSON body `{ token }` | `{ success: true, data: { email, agentName } }` or `{ success: false, error }` for missing/used/expired tokens. |
| PUT | `/api/magic-link` | Public (allowlisted) | Set the user's password using the invite token. Enforces password strength (min 12 chars, upper, lower, number, special). Atomically claims the token (`used_at` compare-and-swap) to prevent concurrent reuse, then sets the password via the Supabase admin API and clears `must_reset_password`. | JSON body `{ token, password }` | `{ success: true }` on success; `{ success: false, error }` for weak password, used/expired token, or failure. |

Source file: `app/api/magic-link/route.ts`.

---

## Impersonation (view as user)

These two routes drive the look-only "view as user" feature (migration 103): an Owner views the app as a specific agent or brokerage user to diagnose problems. Neither is a public path; both require an authenticated session and are same-origin (CSRF) enforced. Full design, including the look-only / Owner-only / 30-minute / audited guarantees, is in [authentication.md](../architecture/authentication.md#impersonation-view-as-user).

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/impersonation/start` | Session, Owner only (`impersonate` capability via `getAuthenticatedCapable`) | Begin a view-as session. Validates the target is an agent or brokerage_admin, is not the caller, and has a login. Ends any existing active session for the caller, inserts a new one (30-minute expiry), sets the `ff_view_as` hint cookie, and writes an `impersonation.start` audit row. The caller's real auth cookie is never touched. | JSON body `{ targetUserId }` (a `user_profiles.id`) **or** `{ agentId }` (an `agents.id`, resolved to that agent's login); optional `{ reason }` free-text note (truncated to 500 chars) | `{ success: true, redirectTo, target: { id, name, role }, expiresAt }`. `403` if the caller lacks the capability or the target is not an agent/brokerage user; `400` if no id is supplied or the target is the caller; `404` if no login exists for the target; `500` on failure. |
| POST | `/api/impersonation/stop` | Session | End the caller's active view-as session (the banner's Exit button). Clears the `ff_view_as` hint cookie and writes an `impersonation.stop` audit row. Uses the real auth cookie directly (never the impersonation swap), so it ends the session keyed to the actual signed-in staffer. Idempotent: a no-op if no session is active. Allowlisted in the proxy so it works while a look-only session is active. | None (empty JSON body) | `{ success: true, redirectTo: '/admin' }`. `401` if not authenticated. |

Source files: `app/api/impersonation/start/route.ts`, `app/api/impersonation/stop/route.ts`.

---

## KYC document upload

KYC uploads use the signed-URL pattern: the route returns a Supabase storage signed upload URL so the file is uploaded directly from the browser (no file bytes pass through Netlify), then a finalize call records the paths on the `agents` row. Every finalize call validates that each `filePath` begins with the agent's own folder, so a caller cannot point their KYC record at another agent's storage path.

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/kyc-mobile-upload` | Public (allowlisted), KYC token | Validate the KYC upload token, then mint signed upload URLs for each file. Used by the mobile hand-off flow. | JSON body `{ token, fileNames[], documentType }` | `{ success: true, data: { uploadUrls[], agentId, tokenRecordId } }` or `{ success: false, error }`. Rate-limited. |
| PUT | `/api/kyc-mobile-upload` | Public (allowlisted), KYC token | Finalize: atomically claim the single-use token (`used_at` + expiry check in one UPDATE), validate paths, then set the agent's `kyc_status='submitted'` and store the document paths. | JSON body `{ token, filePaths[], documentType }` | `{ success: true }` or `{ success: false, error }` (invalid token, used/expired, or path mismatch). Rate-limited. |
| POST | `/api/kyc-desktop-upload` | Session, role `agent` | Same as mobile POST but for a logged-in agent (agent id derived from the session, not a token). Mints signed upload URLs. | JSON body `{ fileNames[], documentType }` | `{ success: true, data: { uploadUrls[], agentId } }`. `401` if unauthenticated, `403` if not an agent. Rate-limited. |
| PUT | `/api/kyc-desktop-upload` | Session, role `agent` | Finalize the desktop upload: validate paths against the agent's folder, set `kyc_status='submitted'`, store paths. | JSON body `{ filePaths[], documentType }` | `{ success: true }`. `401`/`403` on auth failure, `400` on path mismatch. |
| POST | `/api/kyc-validate-token` | Public, KYC token | Validate a KYC upload token and return the agent's first name (for the upload landing page). Returns an identical error for all failure modes to prevent enumeration. | JSON body `{ token }` | `{ success: true, data: { agentName } }` or `{ success: false, error: 'Invalid or expired link' }`. Rate-limited (sensitive bucket). |

Source files: `app/api/kyc-mobile-upload/route.ts`, `app/api/kyc-desktop-upload/route.ts`, `app/api/kyc-validate-token/route.ts`.

---

## Agent document upload (preauthorized debit)

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/preauth-upload` | Session, role `agent` | Mint a signed Supabase storage upload URL for the agent's preauthorized debit (PAD) form. | JSON body `{ fileName }` | `{ success: true, data: { signedUrl, token, path, agentId } }`. `401` if unauthenticated, `403` if not an agent. Rate-limited. |
| PUT | `/api/preauth-upload` | Session, role `agent` | Finalize: validate the path belongs to this agent's folder, then write `preauth_form_path` and `preauth_form_uploaded_at` on the `agents` row and audit-log it. | JSON body `{ filePath }` | `{ success: true }`. `400` on missing/invalid path, `401`/`403` on auth failure. |

Source file: `app/api/preauth-upload/route.ts`.

---

## Brokerage

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/brokerage/confirm-contact-email` | Public (allowlisted), confirmation token | Click target for the brokerage contact-email change confirmation email. Validates the token (compared by sha256 hash, never raw), and atomically flips `brokerages.email` to the pending address via a compare-and-swap update. Never auto-signs-in the new address. | Query `?token=...` | Always a `302` redirect to `/login?brokerage_email=<status>` where status is `confirmed`, `invalid`, `expired`, or `error`. Rate-limited (sensitive bucket). |

Source file: `app/api/brokerage/confirm-contact-email/route.ts`.

---

## Reports and audit export

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/reports/referral-fees` | Session, role `brokerage_admin`, senior staff only | Generate a branded PDF referral-fee report for the caller's brokerage. Access is further restricted to senior contacts via `canViewBrokerageReferralFees(staff_title)` (Broker of Record + Brokerage Manager), enforced server-side so the tab being hidden client-side cannot be bypassed. | Query `?month=YYYY-MM` (optional) or `?all=true` | `200` PDF (`application/pdf`, attachment). `401` unauthenticated, `403` if not a senior brokerage admin, `400` on malformed month, `404` brokerage not found. |
| GET | `/api/audit/export` | Session, role `super_admin` or `firm_funds_admin` | Export the audit log as CSV or JSON. Re-enforces the Origin check on this GET (unusual: GETs are normally exempt) because it exposes the full audit log. Search input is sanitized before being passed to the PostgREST `or()` filter. | Query `entityType`, `entityId`, `action`, `severity`, `actorEmail`, `search`, `dateFrom`, `dateTo`, `format` (`csv` default or `json`). Capped at 10,000 rows. | `200` CSV or JSON file (attachment). `401` unauthenticated, `403` forbidden (non-admin or bad origin), `429` rate-limited. |
| GET | `/api/admin/reports/export` | Session, internal staff (any tier via `getAuthenticatedAdmin`) | Generate a downloadable financial report as a branded PDF (pdf-lib) or multi-sheet Excel workbook (SheetJS). Scoped to the whole company, a single brokerage, or a single agent (agent reports also include the agent ledger + current balance). Sections: summary, advances funded, repayments collected, brokerage revenue share, receivables aging, failed/flagged deals, full deal detail. Data is built once by `lib/reports/build.ts` (`buildReportPackage`) and rendered by `lib/reports/pdf.ts` / `lib/reports/xlsx.ts`. Not in `proxy.ts` PUBLIC_PATHS (session-cookie auth). | Query `format` (`pdf` default or `xlsx`), `scope` (`company` default, `brokerage`, or `agent`), `id` (required for brokerage/agent scope), optional `start`/`end` (`YYYY-MM-DD`) and `status`. | `200` PDF or XLSX file (attachment). `400` invalid scope/format or missing `id` for a scoped report, `401` unauthenticated, `500` on build/generation failure. |

| GET | `/api/brokerage/reports/export` | Session, role `brokerage_admin`, senior contacts only | Brokerage-facing version of the report export: the SAME engine, but scope and brokerage id come from the session (never the query) and it renders with `audience='brokerage'`, which strips every Firm Funds margin figure (the fee charged to the agent, total fee revenue, gross profit) in both the data and the output. Shows the brokerage's own deals, their agents' advances, their referral earnings, what they owe Firm Funds + aging, and failed deals. Access mirrors `/api/reports/referral-fees` exactly (`canViewBrokerageReferralFees`: Broker of Record + Brokerage Manager). | Query `format` (`pdf` default or `xlsx`), `month` (`YYYY-MM` or `all`) or explicit `start`/`end` (`YYYY-MM-DD`), optional `status`. | `200` PDF or XLSX file (attachment, scoped to the caller's own brokerage). `400` invalid format/month, `401` unauthenticated, `403` not a senior brokerage contact, `500` on build/generation failure. |

| GET | `/api/agent/reports/export` | Session, role `agent` | Agent-facing personal statement: the SAME engine, scoped to the caller's OWN agent record (scope/id from the session, never the query), rendered with `audience='agent'`. The agent DOES see the fees they personally paid (their money / a deductible expense), but Firm Funds gross profit and the brokerage's referral cut are stripped, and the brokerage/Firm-Funds AR sections (revenue share, aging, collections) are dropped. Includes the agent's deals, advances, fees paid, current balance, and ledger. | Query `format` (`pdf` default or `xlsx`), `month` (`YYYY-MM` or `all`) or `start`/`end`, optional `status`. | `200` PDF or XLSX file (attachment, scoped to the caller's own agent record). `400` invalid format/month, `401` unauthenticated, `403` not an agent, `500` on build/generation failure. |

Source files: `app/api/reports/referral-fees/route.ts`, `app/api/audit/export/route.ts`, `app/api/admin/reports/export/route.ts`, `app/api/brokerage/reports/export/route.ts`, `app/api/agent/reports/export/route.ts` (with `lib/reports/build.ts`, `lib/reports/pdf.ts`, `lib/reports/xlsx.ts`, `lib/reports/types.ts`; `audience` of `brokerage`/`agent` strips Firm Funds margin per the rules in `conventions.md`).

---

## DocuSign OAuth (admin connect flow)

These two routes link a DocuSign account to the Firm Funds integration. They are distinct from the DocuSign Connect webhook, which is documented in `webhooks.md`.

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/docusign/connect` | Session, role `super_admin` or `firm_funds_admin` | Start the DocuSign OAuth flow. Generates a one-time CSRF `state`, stores it in an httpOnly cookie (5-min TTL), and redirects to DocuSign's authorize URL with `scope=signature impersonation`. | None | `302` redirect to DocuSign. Non-admins and unauthenticated callers are redirected to `/login`. Misconfiguration redirects to `/admin/settings?docusign=error`. |
| GET | `/api/docusign/callback` | Session, role `super_admin` or `firm_funds_admin` | OAuth callback. Verifies the returned `state` matches the single-use cookie, re-verifies the caller is still an active admin, exchanges the code for tokens, saves them, and records who linked the integration. | Query `code`, `state`, `error` (from DocuSign) | `302` redirect to `/admin/settings?docusign=connected` on success. `400` on state mismatch; redirects to `/login` or `/admin/settings?docusign=error` on other failures. |

Source files: `app/api/docusign/connect/route.ts`, `app/api/docusign/callback/route.ts`.

---

## Test and seed utilities (non-production)

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/admin/test-settlement-reminder` | Session, role `super_admin` or `firm_funds_admin` | One-shot smoke test that sends a settlement-reminder email through the production Resend client using a hard-coded fixture payload. | Query `?scenario=closing_day` (default) or `payment_check_in`; optional `?to=<email>` to override recipient (defaults to caller's profile email) | `{ ok: true, scenario, sent_to }` or `500` on send failure. `401` if not an admin. |
| GET | `/api/seed` | Secret query key, non-production only | Seed test data: 4 brokerages, agents, and deals, plus brokerage-admin logins. Hard-disabled in production (rejects when `NODE_ENV=production` or when the Supabase URL targets the prod project ref). | Query `?key=<SEED_SECRET>` | `{ success: true, ... }` with generated credentials, or `403` (disabled / invalid key) / `500`. |
| DELETE | `/api/seed` | Secret query key, non-production only | Wipe all `[SEED]`-tagged test data (deals, agents, brokerage-admin auth users and profiles, brokerages). | Query `?key=<SEED_SECRET>` | `{ success: true, ... }` or `403` / `500`. |

Source files: `app/api/admin/test-settlement-reminder/route.ts`, `app/api/seed/route.ts`.

---

## Unsubscribe (CASL)

`/api/unsubscribe` is CSRF-exempt because mailbox providers POST to it without an Origin header. The per-entity token in the query string or body is the authentication. All methods use the sensitive rate-limit bucket. The human-facing landing page lives at `/unsubscribe` (a server component); this route is the machine endpoint. See `webhooks.md` for more detail on the one-click POST semantics.

| Method | Path | Who can call | Purpose | Request | Returns / effect |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/unsubscribe` | Public (allowlisted), token | Sanity probe / fallback: validate the token and report the entity type. | Query `?token=...` | `{ ok: true, entityType }`, or `400`/`404` for missing/invalid token. |
| POST | `/api/unsubscribe` | Public (allowlisted, CSRF-exempt), token | RFC 8058 one-click unsubscribe. Sets the entity's `email_notifications_enabled=false`. | `?token=...` in query, or token in JSON / form body | `{ ok: true, action: 'unsubscribed' }`, or `400`/`404`/`500`. |
| PUT | `/api/unsubscribe` | Public (allowlisted), token | Resubscribe (used by the landing page's resubscribe button). Sets `email_notifications_enabled=true`. | JSON body `{ token }` or `?token=...` | `{ ok: true, action: 'resubscribed' }`, or `400`/`404`/`500`. |

Source file: `app/api/unsubscribe/route.ts`.

---

## Note on route coverage

This file documents the request-driven routes that exist in `app/api/` as of the last-updated date. Endpoint families described in earlier planning notes (for example `/api/admin/agents`, `/api/admin/brokerages`, `/api/deals`, `/api/firm-deals`, and a ParcLabs webhook) are **not** present as `app/api/.../route.ts` handlers in the current tree. Much of that admin, deal, and firm-deal logic is implemented as Next.js Server Actions and server components rather than REST routes, so it does not appear here. If those routes are added later, document them in the matching section above and cite the new route file path.
