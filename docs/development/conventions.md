# Coding Conventions and Gotchas

_Last updated: 2026-06-02_

Project-specific rules and known traps. Read this before writing code, because several conventions here override defaults you might assume from older Next.js or Supabase versions.

## Next.js 16 (this is not the Next.js you may know)

This version has breaking changes from older releases. When in doubt, read the relevant guide under `node_modules/next/dist/docs/` before writing code.

- `params` in dynamic routes are Promises. Await them.
- `'use server'` files can only export async functions.
- `useSearchParams()` requires a `<Suspense>` boundary.
- The project uses the App Router with route groups. Server components and server actions are the default.

## A `'use server'` file may only export async functions

This is stricter than it looks, and the production build will not warn you. A runtime `export const` (an object or array) in a `'use server'` module is tolerated by the production webpack build but **rejected by a cold Turbopack dev compile** with:

```
A "use server" file can only export async functions, found object
```

So a constant can ride along undetected until the next clean `next dev` start, then break it. Keep shared constants and types in a plain (non-`'use server'`) module instead, and import them into the action file.

Concrete example found and fixed during the impersonation work: `MONEY_AND_COMPLIANCE_ACTIONS` (the array powering the audit page's "Money & compliance" preset) was exported from `lib/actions/audit-actions.ts` (a `'use server'` file). It now lives in `lib/audit-labels.ts` (a plain, client-safe module), and the admin audit page (`app/(dashboard)/admin/audit/page.tsx`) imports it from there.

## Supabase and Row Level Security

RLS is the number one source of bugs. The rules:

- `createClient()` from `@/lib/supabase/client` is synchronous and for the browser.
- `createClient()` from `@/lib/supabase/server` is async (it reads cookies).
- `createServiceRoleClient()` from `@/lib/supabase/server` bypasses RLS. Use it for all server-side mutations.
- All agent balance writes must go through the `apply_agent_balance_delta` RPC (migration 052). Never read-modify-write a balance directly. The same rule applies to `record_brokerage_late_strike` and `apply_remediation_remittance`.

See [docs/architecture/database.md](../architecture/database.md) and [docs/architecture/authentication.md](../architecture/authentication.md).

## Internal staff capabilities (least-privilege roles)

`super_admin` / `firm_funds_admin` are split into Owner / Manager / General Staff tiers via `user_profiles.staff_role` (migration 102). When you add or touch an admin server action, gate it by capability, not by role:

- Sensitive action: use `getAuthenticatedCapable('<capability>')` (a drop-in for `getAuthenticatedAdmin()`). Money writes use `money.write`, KYC uses `kyc.verify`, deletes use `account.delete` / `deal.delete`, brokerage onboarding uses `brokerage.manage`.
- Read-only action: keep `getAuthenticatedAdmin()` (all internal tiers hold the read baseline).
- Payload-dependent sensitivity: gate at the baseline, then branch on `hasCapability(profile, ...)` (see `updateDealStatus`, `updateAgent`).
- Inline role checks (no helper): select `role, staff_role` and call `hasCapability(profile, cap)` directly (see the banking actions in `profile-actions.ts`).
- New restricted `/admin` page: add it to `ADMIN_ROUTE_CAPABILITIES` in `lib/access.ts`, gate the page server-side, and hide its nav link in `app/(dashboard)/admin/page.tsx`.

Bundles live in `lib/access.ts` and are unit-tested in `lib/access.test.ts`. Do NOT add new values to `user_profiles.role` or its CHECK constraint to express a tier; use `staff_role`. Full reference: [authentication.md](../architecture/authentication.md).

## Middleware allowlist

External POST endpoints (webhooks, callbacks) must be in the `PUBLIC_PATHS` array in `proxy.ts` (the Next.js 16 request middleware at the repo root, function `proxy`) or they get redirected (302) to `/login`. The `/api/kyc-*` wildcard was replaced with exact matches, so add new KYC routes explicitly.

## Netlify serverless

- Always `await` async operations in serverless functions or they get killed mid-flight.
- File uploads must use signed URLs.
- Netlify TypeScript checking is stricter than local `tsc --noEmit`. Watch null checks and unused imports.

## Theme

Dark mode is permanently locked. Use the `useTheme()` hook. Note that `colors.gold` is actually green (`#5FA873`).

## TypeScript

- Type check with `npx tsc --noEmit`. Exclude `.next/` errors.

## Financial code

All money math lives in `lib/calculations.ts` and `lib/constants.ts`. Do not hardcode rates inline. Key invariants:

- Discount rate: $0.80 per $1,000 per day, chargeable days = `days_until_closing - 1` via `getChargeDays()`.
- `brokerage_split_pct` stores whole numbers (5 means 5%), not decimals. Do not multiply by 100.
- Settlement days are snapshotted at submission into `deals.settlement_days_at_funding`.

Full detail in [docs/business/financial-model.md](../business/financial-model.md).

## Copy and writing style

- Do not use em dashes in any user-facing copy or in documentation. The owner treats them as an AI tell. Use commas, colons, or parentheses instead. This applies to these docs too.
- No emojis unless explicitly requested.

## Git workflow

Push directly to `main`. No feature branches, no pull request workflow. Confirm with the owner before pushing. Commit messages follow the existing style in `git log` (for example `feat(area): summary`, `fix(area): summary`, `docs(area): summary`).

## Documentation upkeep

When you change behavior, update the matching doc in `docs/` in the same change. Treat an out-of-date doc as a bug. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the doc-to-code mapping.
