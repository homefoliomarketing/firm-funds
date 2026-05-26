@AGENTS.md

# Firm Funds — Project Constitution

**Live:** firmfunds.ca (Netlify auto-deploys from main)
**DB:** Supabase PostgreSQL with RLS
**Owner:** Bud (homefoliomarketing@gmail.com)

## Agent Capabilities — READ THIS FIRST

You have FULL autonomy to run commands. Bud should never have to copy-paste anything.
You don't need to ask permission to push to git. Just send it if we are completing something worth sending.

- **Shell commands** — Run anything directly: npm, git, builds, dev server
- **Git** — Commit and push directly. Confirm with Bud before pushing to main.
- **SQL** — Run against Supabase via: `npx supabase db query --db-url "$(grep SUPABASE_DB_URL .env.local | cut -d= -f2-)" "YOUR SQL HERE"`
  - Connection string is in `.env.local` as `SUPABASE_DB_URL`
  - Use this for migrations, queries, schema changes — anything
  - Still paste SQL in chat so Bud can see what's being run
- **Browser** — Claude in Chrome MCP tools available. Bud may ask you to interact with DocuSign, Netlify, Supabase dashboards directly.

## Tech Stack Rules

- **Next.js 16.2.1 + Turbopack** — Breaking changes from training data. `params` in dynamic routes are Promises. `'use server'` files can ONLY export async functions. `useSearchParams()` requires `<Suspense>` boundary. **Read `node_modules/next/dist/docs/` before writing any code.**
- **Supabase** — RLS is the #1 bug source. Use `createServiceRoleClient()` for ALL server-side mutations. `createClient()` from `@/lib/supabase/client` is synchronous (browser). `createClient()` from `@/lib/supabase/server` is async (cookies). `createServiceRoleClient()` from `@/lib/supabase/server` bypasses RLS.
- **Netlify** — Serverless functions. File uploads MUST use signed URLs. **TS checking is STRICTER than local `tsc --noEmit`** — careful with null checks and unused imports. **Always `await` async ops in serverless functions or they get killed.**
- **Theme** — Dark mode permanently locked. `useTheme()` hook. `colors.gold` is actually green (#5FA873).
- **TypeScript** — `npx tsc --noEmit` to type-check. Exclude `.next/` errors.

## Financial Rules

- Discount rate: $0.80 per $1,000 per day. Effective chargeable days = days_until_closing - 1 via `getChargeDays()` in `lib/calculations.ts` (closing day not charged)
- Late payment interest: 24% per annum **true APR**, compounded daily as `(1.24)^(1/365) - 1`, accrual starts day 31 after closing (30-day grace)
- Settlement window: 7 days standard, snapshotted at submission into `deals.settlement_days_at_funding`. Auto-bumps to 14 days after 5 manual strikes on a brokerage.
- Deal status flow: `under_review → approved → funded → completed`. Failed deals: `funded → failed_to_close → cured` (after remediation IDP fully paid).
- `brokerage_split_pct` stores whole numbers (5 = 5%), NOT decimals. Do NOT multiply by 100.
- All agent balance writes MUST go through `apply_agent_balance_delta` RPC (migration 052) — never read-modify-write directly. Same for `record_brokerage_late_strike` and `apply_remediation_remittance`.

## Middleware Warning

If you create API routes that accept external POSTs (webhooks, callbacks), add them to the EXPLICIT allowlist in `middleware.ts` (PUBLIC_PATHS array) or they'll get 302'd to `/login`. Current exclusions: `/login`, `/auth`, `/kyc-upload`, `/api/kyc-mobile-upload`, `/api/kyc-desktop-upload`, `/api/kyc-validate-token`, `/invite`, `/api/magic-link`, `/api/rate-limit`, `/api/docusign/webhook`, `/api/cron/*`. The `/api/kyc-*` wildcard was replaced with exact matches in Session 6 — add new KYC routes explicitly.

## Working with Bud

- Non-technical founder. Casual, direct, funny. Swearing and sarcasm welcome.
- **Don't be lazy.** Do the work. Don't defer or give partial solutions.
- **Don't over-explain.** Give him files and short summaries.
- **Walk through features ONE AT A TIME** for testing. Don't dump lists.
- **Run commands yourself.** He should never have to copy-paste into PowerShell.
- **Still paste SQL in chat** so he can see what's happening to his database but do not ask for permissions each time to run it.
- He works on Windows/PowerShell from `C:\Users\randi\Dev\firm-funds`.
- **commission-advance-startup skill** — Use when he asks about business formation, compliance, or operational questions.

## Memory System

Accumulated project knowledge is stored in the Claude Code memory system. Check `MEMORY.md` index for available context on: DocuSign integration, session history, planned features, key files, resolved gotchas, underwriting checklist.

## Git Workflow

Push directly — no copy-paste needed. Always confirm with Bud before pushing.
```bash
cd /c/Users/randi/Dev/firm-funds && git add -A && git commit -m "description" && git push origin main
```
