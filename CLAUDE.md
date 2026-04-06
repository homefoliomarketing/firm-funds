@AGENTS.md

# Firm Funds — Project Constitution

**Live:** firmfunds.ca (Netlify auto-deploys from main)
**DB:** Supabase PostgreSQL with RLS
**Owner:** Bud (homefoliomarketing@gmail.com)

## Agent Capabilities — READ THIS FIRST

You have FULL autonomy to run commands. Bud should never have to copy-paste anything.

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

- Discount rate: $0.75 per $1,000 per day. +1 day processing offset in `lib/calculations.ts`
- Late closing interest: same rate, 5-day grace period (`LATE_CLOSING_GRACE_DAYS` in `lib/constants.ts`)
- Deal status flow: `under_review → approved → funded → completed`
- `brokerage_split_pct` stores whole numbers (5 = 5%), NOT decimals. Do NOT multiply by 100.

## Middleware Warning

If you create API routes that accept external POSTs (webhooks, callbacks), add them to the exclusion list in `middleware.ts` or they'll get 302'd to `/login`. Current exclusions: `/login`, `/auth`, `/kyc-upload`, `/api/kyc-*`, `/invite`, `/api/magic-link`, `/api/rate-limit`, `/api/docusign/webhook`

## Working with Bud

- Non-technical founder. Casual, direct, funny. Swearing and sarcasm welcome.
- **Don't be lazy.** Do the work. Don't defer or give partial solutions.
- **Don't over-explain.** Give him files and short summaries.
- **Walk through features ONE AT A TIME** for testing. Don't dump lists.
- **Run commands yourself.** He should never have to copy-paste into PowerShell.
- **Still paste SQL in chat** so he can see what's happening to his database.
- He works on Windows/PowerShell from `C:\Users\randi\Dev\firm-funds`.
- **commission-advance-startup skill** — Use when he asks about business formation, compliance, or operational questions.

## Memory System

Accumulated project knowledge is stored in the Claude Code memory system. Check `MEMORY.md` index for available context on: DocuSign integration, session history, planned features, key files, resolved gotchas, underwriting checklist.

## Git Workflow

Push directly — no copy-paste needed. Always confirm with Bud before pushing.
```bash
cd /c/Users/randi/Dev/firm-funds && git add -A && git commit -m "description" && git push origin main
```
