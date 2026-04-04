# Session 8 Prompt

Copy and paste everything below the line into a new chat:

---

You are continuing work on Firm Funds (firmfunds.ca), a commission advance platform for Ontario real estate agents. Read HANDOFF.md in the project root first — it contains everything you need: tech stack, critical patterns, project structure, database schema, all completed work from Sessions 1-7, known issues, and planned work.

**IMPORTANT — Read these before writing ANY code:**
1. `HANDOFF.md` — full project context, patterns, and history
2. `AGENTS.md` — Next.js 16 breaking changes warning (read the docs in `node_modules/next/dist/docs/` before writing code)
3. `SECURITY-AUDIT.md` — security findings and fixes

**Session 8 Focus — Three features to build:**

## 1. Session Timeout Hardening (Security Audit Item M2)

A `components/SessionTimeout.tsx` component already exists — review it first to understand what's there. Then enhance/rebuild as needed:

- **Idle detection:** Track mouse movement, keyboard input, scroll, and click activity. Reset timer on any interaction.
- **Configurable timeout:** Default 30 minutes of inactivity.
- **Warning modal:** Show a "Your session is about to expire" modal ~2 minutes before timeout, with a "Stay Logged In" button that resets the timer.
- **Auto-logout:** If no response to warning, call `supabase.auth.signOut()` and redirect to login.
- **Server-side tracking (defense-in-depth):** Add a `last_active_at` timestamp column to `user_profiles`. Update it periodically (not on every interaction — throttle to once per minute or so). Middleware can optionally check this to reject stale sessions.
- **Audit logging:** Log session timeout events to the audit trail.
- Follow the existing theme system (`useTheme()` / `colors`) and dark mode patterns.

## 2. Brokerage Payment Tracking Completion

Migration 010 (`010_brokerage_payments`) created database tables for tracking payments between Firm Funds and brokerages. The admin deal detail page (`app/(dashboard)/admin/deals/[id]/page.tsx`) has some payment UI.

**Audit what exists first**, then complete:
- Admin view: outstanding balances per brokerage, record payments received, track partial payments, payment history
- Reconciliation: "Mark as Repaid" should be gated by payment amounts matching
- The brokerage admin portal (`app/(dashboard)/brokerage/page.tsx`) should show their payment status/history
- All payment actions (record, confirm, remove) must be audit logged with severity: 'critical'
- Use `createServiceRoleClient()` for all payment mutations (RLS will block otherwise)

## 3. Agent Deal History & Commission Tracking Improvements

Agents can currently see their deals on their dashboard. Improve the experience:
- Cleaner timeline/history view of all past and current advances
- Running totals: total advanced, total earned, outstanding balance
- Better status tracking through the deal lifecycle (visual pipeline or timeline)
- Search/filter on agent dashboard (by status, date range, property address)
- The agent deal detail page (`app/(dashboard)/agent/deals/[id]/page.tsx`) could show more useful info

**Audit the current agent pages first** to understand what exists before building.

---

**Critical reminders:**
- `params` in dynamic routes are Promises in Next.js 16 — use `use(params)` or `await params`
- `'use server'` files can ONLY export async functions (no types, no constants, no sync functions)
- Use `createServiceRoleClient()` for ALL server-side mutations (RLS will bite you otherwise)
- NEVER send file uploads through Netlify serverless functions — use signed upload URLs
- Dark mode is locked — use `useTheme()` hook, `colors.gold` is actually green (#5FA873)
- CSP in `next.config.ts` must be updated if you add any external resources
- Bud is non-technical — give him exact copy-paste commands for SQL migrations and git pushes
- PowerShell on Windows: use semicolons not `&&`, quote paths with parentheses

**When done with each feature:** Update HANDOFF.md, give Bud the git commands to push, and provide any SQL migrations to run in Supabase SQL Editor.
