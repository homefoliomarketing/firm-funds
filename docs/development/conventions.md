# Coding Conventions and Gotchas

_Last updated: 2026-06-11_

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
- Deal numbers (`deals.deal_number`) are assigned by the `assign_deal_number()` DB trigger at submission (migration 108). Never assign one in app code; the daily counter lives in `deal_number_counters` and is written only by that trigger.

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
- **Previewing a private-bucket file in the admin UI** (KYC ID, void cheque / pre-auth form): fetch the signed URL as a blob and render the local object URL - do NOT point an `<img>`/`<iframe>` straight at the signed URL. Supabase serves storage objects with headers that block inline rendering, and an upload can land as `application/octet-stream`; either one makes a naive `<iframe src={signedUrl}>` render a blank box (this was the "admin can't view the pre-auth form" bug). The shared helper is `loadSignedUrlAsBlob()` in `components/admin/AgentVerificationDialog.tsx`; it re-tags the blob from the file extension so PDFs and images both render. Always pair the inline preview with an "Open in new tab" link as a fallback.
- Netlify TypeScript checking is stricter than local `tsc --noEmit`. Watch null checks and unused imports.

## SheetJS (`xlsx`) is pinned to the SheetJS CDN, not the npm registry

The roster importer parses Excel files with SheetJS. The copy on the npm registry is abandoned at 0.18.5 (published 2022) and carries two known CVEs (CVE-2023-30533 prototype pollution, CVE-2024-22363 ReDoS). SheetJS distributes fixed versions only from its own CDN, so `package.json` pins a tarball URL:

```
npm i --save https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

Never run `npm i xlsx@latest` or accept a dependabot-style bump to a registry version; that would silently downgrade to the vulnerable 0.18.5. To upgrade, swap the version in the tarball URL (check https://cdn.sheetjs.com for the latest). Parse uploads from a buffer (`XLSX.read(bytes, ...)`), never `XLSX.readFile`, so bundlers do not pull in the `fs` codepath. On the write side (the report exporter in `lib/reports/xlsx.ts`), build the workbook and emit it with `XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })` and return it from the route as `new Response(Buffer.from(buf), ...)`; never `XLSX.writeFile` (same `fs` reason). The `Buffer.from(...)` wrapper matters: a raw `Buffer<ArrayBufferLike>` (and a bare `Uint8Array`) is not assignable to the DOM `BodyInit` type under the current TS lib, but `Buffer.from(...)` returns `Buffer<ArrayBuffer>`, which is. The same applies to the pdf-lib bytes.

## Financial report exports (`lib/reports/`)

The admin report exporter (`/api/admin/reports/export`) is structured so the numbers are computed once and rendered two ways. `lib/reports/build.ts` (`buildReportPackage`) runs a single scoped `deals` query (service-role, RLS-bypassing) and produces a normalized `ReportPackage` (`lib/reports/types.ts`); `lib/reports/pdf.ts` (pdf-lib, branded) and `lib/reports/xlsx.ts` (SheetJS, multi-sheet) only format that object. Add a new section by extending the `ReportPackage` type and the builder, then both exporters. Money semantics live in the builder header comment: there is no `deals.funded_at`/`completed_at` (use `funding_date` + `status`); a deal counts as money-moved once `status` is in `funded`/`completed`/`failed_to_close`/`cured`. The report shows fee revenue, advances, collections, brokerage share, and amounts owed only; operating expenses are not tracked in this app (they live in the accounting software), so the bottom line is "Firm Funds gross profit," not net income.

The package carries an `audience: 'internal' | 'brokerage' | 'agent'` flag, and the data is rendered differently per audience. `'brokerage'` (used by `/api/brokerage/reports/export`, scoped to the caller's own brokerage) strips every Firm Funds margin figure (the fee charged to the agent, total fee revenue, and gross profit). `'agent'` (used by `/api/agent/reports/export`, scoped to the caller's own agent record) is a personal statement: the agent DOES see the fee they paid (their money / a deductible expense), but Firm Funds gross profit and the brokerage's referral cut are stripped, and the brokerage/Firm-Funds AR sections (revenue share, aging, collections) are dropped. Stripping happens in BOTH the data (the builder zeroes/clears the hidden fields) and the rendered output (the generators drop those boxes/columns/sections, so a generator stays safe even if called with un-zeroed data). When adding a field, decide which audiences may see it; if it is Firm Funds margin or another party's money, zero/clear it for that audience in the builder AND hide it in both generators. `lib/reports/audience.test.ts` is a regression guard that fails if a margin value leaks into a brokerage or agent workbook.

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

## Dates and timezones

Format date-only values (Postgres `date` columns like `deals.closing_date`, `deals.funding_date`, `deals.repayment_date`) through `formatDate()` in `lib/formatting.ts`. It is timezone-safe: a bare `"YYYY-MM-DD"` is anchored at noon UTC (not UTC midnight) and rendered in `America/Toronto`, so the calendar day does not roll back one day on a host behind UTC. Netlify functions run in UTC, which is exactly where the naive `new Date("2026-08-05").toLocaleDateString()` bug bites (it renders "Aug 4"). Never format a date string with a bare `new Date(dateString).toLocaleDateString()`; route it through `formatDate` (or, in the report exporters, through the existing noon-UTC `ymd()`/`longDate()` helpers in `lib/reports/build.ts`). `formatDateTime()` likewise pins `America/Toronto` so timestamps render in business time. The stored DB values are already correct; this is a display-only concern. Regression coverage lives in `lib/formatting.test.ts` (it forces a non-UTC host TZ).

## Phone numbers

Phones are stored E.164 (`+1XXXXXXXXXX`), entered in any human format, and formatted for display via `lib/phone.ts`. Users can type `(416) 555-1234`, `416-555-1234`, `4165551234`, and so on; `normalizeE164()` canonicalizes the input on save and `formatPhoneForDisplay()` renders it back. Use `PHONE_VALIDATION_MESSAGE` for the rejection copy. This replaced the old strict "+1XXXXXXXXXX required" rejection in the profile actions and the loose regex in `phoneSchema` (`lib/validations.ts`). Do not re-introduce a strict input format: validate by normalizing through `lib/phone.ts` instead.

## Copy and writing style

- Do not use em dashes in any user-facing copy or in documentation. The owner treats them as an AI tell. Use commas, colons, or parentheses instead. This applies to these docs too.
- No emojis unless explicitly requested.

## Git workflow

Push directly to `main`. No feature branches, no pull request workflow. Confirm with the owner before pushing. Commit messages follow the existing style in `git log` (for example `feat(area): summary`, `fix(area): summary`, `docs(area): summary`).

## Documentation upkeep

When you change behavior, update the matching doc in `docs/` in the same change. Treat an out-of-date doc as a bug. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the doc-to-code mapping.
