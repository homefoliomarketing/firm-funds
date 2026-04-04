# Session 9 — Firm Funds Commission Advance Platform

You are continuing development on **Firm Funds** (firmfunds.ca), a commission advance platform for Ontario real estate agents. The owner is **Bud**, a non-technical founder who runs SQL in Supabase SQL Editor and pushes code via PowerShell on Windows at `C:\Users\randi\Dev\firm-funds`.

---

## CRITICAL RULES — READ BEFORE WRITING ANY CODE

1. **Next.js 16.2.1 with Turbopack** — This has breaking changes from your training data. `params` in dynamic routes are Promises that must be awaited. Files marked `'use server'` can ONLY export async functions (no constants, no types, no non-async helpers). **Read the relevant guide in `node_modules/next/dist/docs/` before writing any code.**

2. **Supabase RLS** — This is the #1 source of bugs. Server-side mutations MUST use `createServiceRoleClient()` (from `lib/supabase/server.ts`), which bypasses RLS. The regular `createClient()` is async/cookie-based and subject to RLS policies.

3. **Netlify deployment** — Auto-deploys from main. Serverless functions have strict size/timeout limits. File uploads MUST use Supabase signed URLs — NEVER send file data through Netlify serverless functions.

4. **Theme system** — Dark mode is permanently locked on. Use `useTheme()` hook. `colors.gold` is green (#5FA873), not gold.

5. **PowerShell** — Bud uses Windows PowerShell. Use semicolons (`;`) not `&&` to chain commands. Quote paths containing parentheses.

6. **Type checking** — Use `npx tsc --noEmit` to verify. `next build` won't work in sandbox (missing SWC binaries for linux).

7. **Audit logging** — All significant actions must be logged via `logAuditEvent()` or `logAuditEventServiceRole()` from `lib/audit.ts`.

8. **Financial calculations** — Discount rate: $0.75 per $1,000 per day. A +1 processing day offset is applied in `lib/calculations.ts`. Don't change this without Bud's approval.

---

## IMMEDIATE PRIORITY: Fix the Underwriting Checklist

**Context:** The underwriting checklist has been messed up across multiple sessions and it's a frustration point for Bud. He has confirmed the current items are wrong and needs to provide the correct list.

**What needs to happen:**
1. Ask Bud for the correct checklist items, grouped by category
2. Create a new migration (next number is `017`) that:
   - `DELETE FROM underwriting_checklist;` (wipes all existing items)
   - Replaces the `create_underwriting_checklist()` trigger function with the correct items
   - Re-inserts checklist items for all existing deals
3. The migration must include the `category` column (text) and `is_na` column (boolean, default false) — both already exist in the table schema
4. **LOCK IT IN** — After this is done, the checklist items must NEVER be modified again unless Bud explicitly asks. No "improving" or "reorganizing" the list. What Bud gives you is what goes in, word for word.

**Current trigger function location:** `supabase/migrations/012_checklist_categories.sql`
**N/A toggle action:** `lib/actions/deal-actions.ts` → `toggleChecklistItemNA()`

### Also: Connect Agent Document Checklist to Underwriting
Bud wants the agent-facing document checklist (in `app/(dashboard)/agent/deals/[id]/page.tsx`, around line 736) to be connected to/mirror the underwriting checklist system. Currently it's a hardcoded list that doesn't reflect the actual underwriting items. When fixing the underwriting list, align these two systems.

---

## What Was Completed in Session 8 (for your awareness)

Read `HANDOFF.md` in the repo root for the full detailed summary. Key highlights:

- **Admin Dashboard**: 4 KPI tiles (Total Deals, Total Advanced, Discounts Collected, Partner Brokerages with agent count), Action Needed alerts bar
- **Agent Dashboard**: Friendly KPIs (Funds Received, Active Deals, Completed, Avg Turnaround), removed all discount fee references
- **Email Templates**: Centered logo, better subject lines for approval/funded, new KYC approval email
- **Underwriting Checklist UI**: N/A toggle button on each item (working), inline document viewer next to checklist (no more side panel)
- **Document Viewer**: Ctrl+scroll zoom (native listener with passive:false), inline rendering next to checklist, compact doc tab bar when viewing
- **Deal Submission**: Slot-based document uploads (APS required, NOF/Waiver, Amendments optional; Banking Info required on first advance only)
- **Agent Deal Detail**: Document checklist shows "Accepted" on approved deals instead of "3 needed"
- **Bug Fixes**: Referral fee display (decimal→percentage), +1 processing day offset

---

## Key File Map

| File | Purpose |
|------|---------|
| `app/(dashboard)/admin/page.tsx` | Admin dashboard |
| `app/(dashboard)/admin/deals/[id]/page.tsx` | Admin deal detail — underwriting checklist + inline viewer |
| `app/(dashboard)/agent/page.tsx` | Agent dashboard |
| `app/(dashboard)/agent/deals/[id]/page.tsx` | Agent deal detail — doc checklist to fix |
| `app/(dashboard)/agent/new-deal/page.tsx` | Deal submission with slot-based uploads |
| `lib/email.ts` | All email templates |
| `lib/calculations.ts` | Financial calculations |
| `lib/actions/deal-actions.ts` | Deal server actions incl. checklist toggle + N/A toggle |
| `lib/actions/kyc-actions.ts` | KYC actions + KYC approval email trigger |
| `lib/supabase/server.ts` | Supabase clients |
| `lib/constants.ts` | Shared constants |
| `supabase/migrations/` | DB migrations (run manually in Supabase SQL Editor) |

---

## Other Pending Items (After Checklist Fix)

1. **Agent Profiles** (large feature) — personal info, banking details, address from ID
2. **Drag-drop documents** to underwriting categories
3. **Email testing** — will test organically as deals flow through the system

---

## Working With Bud

- He's non-technical but sharp. Explain what you're doing in plain terms.
- He tests everything hands-on and gives direct feedback.
- He prefers casual communication — friendly, no BS, get things done.
- He runs SQL migrations himself in Supabase SQL Editor — give him the SQL to copy-paste.
- He pushes code via PowerShell — give him the exact commands to run.
- Don't change things he didn't ask you to change. Especially the underwriting checklist.
