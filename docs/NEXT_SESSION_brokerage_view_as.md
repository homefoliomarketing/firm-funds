# Next Session: brokerage-side "View as user"

_Created 2026-06-02. Small, well-scoped follow-up to the impersonation feature._

## Context: what already shipped

"View as user" (look-only impersonation) shipped to main on 2026-06-02 (commit `bea25a3`). It is Owner-only, look-only, 30-minute time-limited, and fully audited. Today only the **agent** entry point exists: a "View as this agent" button on the admin deal page. The whole engine already supports brokerage users too; this task is mostly **adding the brokerage entry-point button plus live verification**.

Read first: `docs/architecture/authentication.md` (the "Impersonation (view as user)" section) and the memory note `project_staff_roles_shipped.md` (Task 2 section). This is NOT the Next.js in your training data; read `node_modules/next/dist/docs/` before writing code.

## What already works for brokerage (no new backend needed)

- `POST /api/impersonation/start` already accepts `{ targetUserId }` (a `user_profiles.id`) and validates the target role is `agent` OR `brokerage_admin`. So a brokerage button just calls it with the brokerage user's id.
- `getAuthenticatedUser` swaps to the target for reads; the browser `auth.getUser()` override renders the target's world; the proxy confines the viewer to the target's role routes. `dashboardPathForRole('brokerage_admin')` returns `/brokerage`, so start returns `redirectTo: '/brokerage'` automatically.
- Brokerage **write** actions are already guarded with `getAuthenticatedWriter` (sendBrokerageMessage, submitDealAsBrokerage, addAgentAsBrokerage, brokerageUpdateAgentContact, toggleAgentBrokerageFlag, brokerageResendWelcomeEmail, submitBrokeragePaymentClaim, submitClosingDateAmendmentAsBrokerage, declineFirmDealOffer, updateBrokerageContactEmail, markBrokerageMessagesRead). So look-only should already hold.
- Banner, time limit, Exit, logout-ends-session, and audit all work for any target role.

## The task

### 1. Add a "View as" button per brokerage user
- File: `components/admin/BrokerageAdminsPanel.tsx`. It renders each brokerage admin row (the list around lines 339-417, with a "Remove" button near line 398). Each row is a `BrokerageAdminRow` (line 155) and has `user_id` (the auth user id), `full_name`, `email`, `role`.
- Add a "View as" button next to "Remove", calling `/api/impersonation/start` with `{ targetUserId: admin.user_id }`, then hard-redirect to `data.redirectTo` (will be `/brokerage`).
- **Reuse the agent button as the template:** `components/admin/ViewAsAgentButton.tsx` is the exact pattern (confirm step, POST to start, `window.location.href = data.redirectTo`). Best move: generalize it into a `ViewAsUserButton` that accepts either `{ agentId }` or `{ targetUserId }` plus a display `name`, and use it in both the deal page and the brokerage panel. (Or add a sibling `ViewAsBrokerageUserButton`; generalizing is cleaner.)
- **Hide/disable the button when `!admin.user_id`** (an invited-but-not-accepted admin has no login yet; start would 404).
- **Owner-only gating:** the panel doesn't currently know the viewer's tier. Pass a `canImpersonate` prop down from the brokerage detail page `app/(dashboard)/admin/brokerages/[id]/page.tsx`. That page currently selects `'role, is_active'`; change it to also select `staff_role`, compute `hasCapability(profile, 'impersonate')`, and pass it to `<BrokerageAdminsPanel canImpersonate={...} />`. The start endpoint re-checks the capability server-side regardless.

### 2. Verify live (Owner = bud@firmfunds.ca / FirmFunds123!)
Brokerage test user: **budjonez12@gmail.com / BrokerTest123!** (brokerage_admin, Century 21 Choice Realty, id `d0d206a4-90e0-49b1-a472-18edd8f76f6c`).
- Log in as Owner, open `/admin/brokerages/d0d206a4-90e0-49b1-a472-18edd8f76f6c`, click "View as" on a brokerage admin.
- Confirm you land on `/brokerage` showing the brokerage's real dashboard, with the amber banner + countdown.
- Confirm look-only: try sending a brokerage message (or any brokerage write) and confirm it is refused ("viewing as another user (look-only)...") and nothing is written to the DB.
- Confirm audit rows (start/blocked/stop) are written and attributed to bud@firmfunds.ca with `impersonated_target_id` = the brokerage user.
- Confirm Exit returns to `/admin` and clears the `ff_view_as` cookie.
- Screenshot the brokerage dashboard under the banner for Bud.

### 3. Also check (defense in depth)
- `lib/actions/brokerage-admin-actions.ts` invite/remove/authorize-manager actions: confirm they are NOT reachable as a write during a view-as. They don't use `getAuthenticatedUser(['brokerage_admin'])` (so no swap); verify their own auth rejects the Owner, or convert to `getAuthenticatedWriter` if they do swap. Trigger an admin invite/remove while viewing-as and confirm it's blocked.

## Gotchas (already learned, don't re-discover)
- If `next dev` throws `A "use server" file can only export async functions, found object`: it is a **stale `.next` after running a prod build**, OR a real const exported from a `'use server'` file. Clear `.next` and restart. (`next dev` defaults to Turbopack in Next 16.)
- The hint cookie is plain JSON; encoding is the cookie layer's job. Don't double-encode.
- `AsyncLocalStorage.enterWith` does NOT propagate across the `getAuthenticatedUser` await boundary; use the returned `isImpersonating` flag (that's what `getAuthenticatedWriter` does). Do not try the read-only-service-client wrapper again.

## Process
Present a short plan, build, run `npx tsc --noEmit` + `npm test` + a production build (`NODE_OPTIONS=--max-old-space-size=4096 npm run build`), verify live with screenshots, then push to main (Bud auto-approves; confirm before pushing per his rule). Update `docs/architecture/authentication.md` (note the brokerage entry point) in the same commit.

## Optional stretch (only if Bud asks)
An admin "impersonation report" page: list `impersonation_sessions` (who viewed whom, when, duration) and filter the audit log by `impersonated_target_id`. Owner-only, read-only.
