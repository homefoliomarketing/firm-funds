# Next Session: Internal Staff Roles + "Log in as User"

_Created 2026-06-01. This is a briefing for a fresh Claude Code session. Start by reading `CLAUDE.md` and the memory index at `MEMORY.md`, then read this file._

These two features were deliberately deferred to their own session because both are architectural and security sensitive. **Plan first and get Bud's approval on the design before writing any code.** Bud is a non-technical founder: explain in plain English, no em dashes, walk through one thing at a time, and push to `main` only after he confirms.

---

## Where things stand (context)

- **App:** Firm Funds, a real estate commission advance platform. Next.js 16.2.6 (App Router, middleware is `proxy.ts`), React 19, Supabase (Postgres + RLS + Auth + Storage), Netlify auto-deploys from `main`.
- **Roles today** (`types/database.ts` `UserRole`): `super_admin`, `firm_funds_admin`, `agent`, `brokerage_admin`. The two admin roles share one all-powerful dashboard and are treated identically almost everywhere.
- **Where access is decided:**
  - `lib/access.ts` — role predicates (`isInternalAdminRole`, `INTERNAL_ADMIN_ROLES`, `canViewBrokerageReferralFees`, status predicates). Has unit tests in `lib/access.test.ts`.
  - `lib/auth-helpers.ts` — `getAuthenticatedAdmin()` / `getAuthenticatedUser()` (the gate every server action calls).
  - `proxy.ts` — `ROUTE_ROLES` route gating + `PUBLIC_PATHS`.
  - `supabase/migrations/` — the RLS policies (the real security boundary). Server actions use `createServiceRoleClient()` which BYPASSES RLS, so each action must verify the caller itself.
- **Test infrastructure now exists:** Vitest. `npm test`, `npm run typecheck`, `npm run build` (use `NODE_OPTIONS=--max-old-space-size=4096` for build). Write real permission tests for both features.
- **Running SQL / migrations:** use `SUPABASE_DB_URL` from `.env.local`; apply multi-statement migrations with `node scripts/apply-migration.mjs <file.sql>`. Paste SQL in chat so Bud can see it. Make migrations additive and idempotent (`IF NOT EXISTS`), and check preconditions before anything irreversible.

---

## Task 1: Separate internal staff roles (least privilege)

**Problem.** `firm_funds_admin` can do everything: approve and fund deals, adjust agent balances, permanently delete brokerages and agents, export the full audit log and PII, verify KYC. Bud wants to hire help (bookkeeper, support, compliance) without handing over all of that.

**Goal.** Introduce scoped internal sub-roles. Propose a model to Bud (do not invent the final set without his sign-off). A reasonable starting proposal to react to:
- `super_admin` — everything, including managing roles and destructive deletes (Bud).
- `finance` — record/confirm EFTs and brokerage payments, balance adjustments, reports. No deletes, no role management.
- `compliance` — KYC verify/reject, view PII, read and export audit log. No money movement.
- `support` — help users, resend invites, read deals. No money, no deletes, no PII reveal.
- `viewer` / read-only — see dashboards, change nothing.

**Suggested approach (present a plan before coding):**
1. **Research with subagents (read-only, run in parallel, disjoint scopes):**
   - Enumerate EVERY `getAuthenticatedAdmin()` call site across `lib/actions/*` and classify what each does (money, delete, PII reveal, KYC, read-only, role/user management).
   - Map `proxy.ts` `ROUTE_ROLES` and every `/admin` route to the capability it needs.
   - Inventory every RLS policy in `supabase/migrations/` that references `super_admin` / `firm_funds_admin`.
   - List the destructive / money actions specifically: `permanentlyDeleteAgent` / `permanentlyDeleteBrokerage`, `balance-adjustment-actions.ts`, `recordEftTransfer` / `confirmEftTransfer`, `recordBrokeragePayment`, `updateDealStatus` (approved -> funded), `recordLateStrike`, remediation remittance.
2. **Decide the model.** Recommended: a small set of named roles mapped to **capabilities**, enforced by a `requireCapability('money.write')`-style helper layered over `getAuthenticatedAdmin`. Capabilities are more flexible than hard-coding role checks at every call site.
3. **Implement** (after approval): extend the role/permission data model (migration), update `lib/access.ts` + `lib/auth-helpers.ts` with capability checks, gate routes in `proxy.ts`, gate each server action by capability, update RLS policies that key on the admin role, and build a super-admin-only UI to assign roles.
4. **Migrate safely.** Default every existing `firm_funds_admin` to a role that preserves today's behavior so nothing breaks on day one. Bud becomes `super_admin`. Backfill carefully and verify.
5. **Test.** Extend `lib/access.test.ts` with capability-predicate tests; verify each gate allows/denies the right roles.

**Risks to flag to Bud:** RLS changes can accidentally lock people out; do everything additively, test against the live policies, and keep a rollback path. This is the larger of the two features; get the permission model approved before building.

---

## Task 2: "Log in as this user" (impersonation) with full audit

**Goal.** Let an authorized staffer view the app AS a specific agent or brokerage user to diagnose a problem ("I can't see my deal", "the form won't submit").

**Hard requirements:**
- **Authorization:** only `super_admin` (or an explicit `support.impersonate` capability from Task 1) can start it.
- **Fully audit-logged** (`lib/audit.ts`): record who impersonated whom, start and stop times. Every action taken while impersonating must remain attributable to the real staffer, not the target user.
- **Always visible:** a persistent on-screen banner ("You are viewing as <name>. Exit.") so staff never forget they are impersonating. Time-limit the impersonation session.
- **Read-mostly:** block or heavily guard money and destructive actions while impersonating (no funding, no balance changes, no deletes, no password changes as someone else). Decide the exact policy with Bud.
- **Never** bypass the target user's own authentication or change their credentials.

**Implementation notes:** study `lib/supabase/server.ts` (`createClient` vs `createServiceRoleClient`), `lib/auth-helpers.ts`, `proxy.ts` (session validation + role gating), the `SessionTimeout` component, and `lib/audit.ts`. Likely approach: a server-side impersonation state bound to the staffer's real session (not a second real login), with the dashboards rendering the target user's data and a guard that audits every request and enforces the read-mostly policy. This pairs naturally with the capability system from Task 1, so build Task 1 first.

**Test:** non-authorized roles cannot start impersonation; money/destructive actions are blocked or correctly attributed; audit rows are written on start, stop, and any guarded action.

---

## Process for the session

1. Read `CLAUDE.md` and `MEMORY.md`.
2. Use subagents for the read-only research/audits above (parallel, non-overlapping file scopes) to keep context lean.
3. Present a **categorized plan for both features** and get Bud's approval BEFORE coding, especially the role/permission model.
4. Build **one feature at a time**: roles first, then impersonation (which builds on the capability system).
5. Before pushing: `npx tsc --noEmit`, `npm test`, and a production build (`NODE_OPTIONS=--max-old-space-size=4096 npm run build`).
6. Push to `main` after Bud confirms. Update the matching docs in the same commit (see `CONTRIBUTING.md`).

---

## Decisions already made (do NOT re-raise these)

- **`deal-documents` bucket size/type limit:** not needed right now.
- **Overpayment override button:** not needed right now (overpayments stay blocked by default).
- **`$0.75` mention in `docs/REMEDIATION_PLAN.md`:** leave it, it is only a historical note that the old rate was corrected to $0.80.
- **Bank reconciliation (Plaid / Flinks, a paid service):** on hold until Bud knows his current banking system better. Do not propose building it.
