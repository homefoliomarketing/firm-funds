# Firm Funds — Session 11 Handoff Document

**Date:** April 5, 2026
**Owner:** Bud (homefoliomarketing@gmail.com)
**Repo:** `C:\Users\randi\Dev\firm-funds` (Windows/PowerShell)
**Live:** firmfunds.ca (Netlify auto-deploys from main)
**DB:** Supabase PostgreSQL with RLS

---

## Tech Stack & Critical Rules

- **Next.js 16.2.1 + Turbopack** — Breaking changes from training data. `params` in dynamic routes are Promises. `'use server'` files can ONLY export async functions. `useSearchParams()` requires `<Suspense>` boundary. **Read `node_modules/next/dist/docs/` before writing any code.**
- **Supabase** — RLS is the #1 bug source. Use `createServiceRoleClient()` for all server-side mutations. `createClient()` from `@/lib/supabase/client` is a synchronous browser client. `createClient()` from `@/lib/supabase/server` is async/cookie-based. `createServiceRoleClient()` from `@/lib/supabase/server` bypasses RLS.
- **Netlify** — Serverless functions. File uploads MUST use signed URLs (never send through Netlify functions). Auto-deploys from main branch. **Netlify's TypeScript checking is STRICTER than local `tsc --noEmit`** — be extra careful with null checks and unused imports.
- **Theme** — Dark mode permanently locked. `useTheme()` hook. `colors.gold` is actually green (#5FA873).
- **Audit logging** — `logAuditEvent()` / `logAuditEventServiceRole()` in `lib/audit.ts`. INSERT-only (DB triggers prevent UPDATE/DELETE).
- **Financial calculations** — Discount rate: $0.75 per $1,000 per day. +1 day processing offset applied in `lib/calculations.ts`. Late closing interest: same rate, 5-day grace period (`LATE_CLOSING_GRACE_DAYS` in `lib/constants.ts`).
- **PowerShell** — Use semicolons not `&&`. Quote paths with parentheses (e.g. `"app/(dashboard)/admin/page.tsx"`).
- **TypeScript** — Run `npx tsc --noEmit` to type-check. Exclude `.next/` errors (auto-generated route types). SWC binaries aren't available in sandbox, so `next build` won't work there.
- **Email throttling** — Admin message emails are throttled to 1 per deal per 15 minutes to prevent spam during back-and-forth conversations. Status change emails (approved, funded, denied, etc.) are NOT throttled — they fire once per status change.

---

## Bud's Working Style — READ THIS

- **Go through features ONE AT A TIME for testing.** Do NOT give him a list of things to test all at once. He hates that. Walk him through each feature individually.
- **Paste SQL directly in chat.** Don't create .sql files and tell him to open them. Just paste the SQL he needs to copy into Supabase SQL Editor.
- **Don't be lazy.** Do the work. Don't defer tasks or give partial solutions.
- **He's casual and direct.** Swearing is fine, sarcasm is fine. Be a bro but get shit done.
- **Push everything at once.** He prefers to test locally/on staging, then push all changes in one batch at the end of the session.
- **Don't over-explain** what's in a file he can see himself. Give him the file and a short summary.
- **Provide git/SQL commands ready to copy-paste.** He runs PowerShell on Windows. Always `cd C:\Users\randi\Dev\firm-funds` first, always quote paths with parentheses.

---

## Session 11 — What Was Completed

### Migrations Applied

| # | File | Status |
|---|------|--------|
| 021 | `021_agent_banking_profile.sql` — Banking fields (transit 5-digit, institution 3-digit, account 7-12 digit), banking_verified, preauth_form_path, address fields. Storage bucket `agent-preauth-forms` with 3 RLS policies. | ✅ Applied |
| 022 | `022_checklist_document_linking.sql` — Adds `linked_document_id` (UUID FK → deal_documents) to `underwriting_checklist`. Enables drag-and-drop document linking to checklist items. | ✅ Applied |
| 023 | `023_checklist_auto_check_kyc.sql` — Updates `create_underwriting_checklist()` trigger to auto-check "Agent ID - FINTRAC Verification" when agent's `kyc_status = 'verified'`. Also still auto-checks "Agent in good standing" based on `flagged_by_brokerage`. | ✅ Applied |

### Features Completed & Tested

1. **Dashboard KPI Tiles Removed (Both Portals)**
   - Removed all KPI tile cards from admin dashboard (data already exists in Reports page with its own date range filter)
   - Removed all KPI cards from agent dashboard
   - Kept all functional elements (deal table, quick links, status tabs, etc.)

2. **Agent Banking & Profile System**
   - **Agent Profile page** (`app/(dashboard)/agent/profile/page.tsx`) — Personal info (read-only name/email/brokerage/RECO, editable phone/address), banking info display (verified with masked account, or pending warning), preauth form upload using signed URL pattern
   - **Admin banking entry** — Banking section in expanded agent view on brokerages page. Form with digit-only input masks. "View Pre-Auth Form" button. Save/cancel.
   - **Deal approval blocked** if agent banking not verified — check in `updateDealStatus()` before 'approved' status
   - **Preauth form auto-attaches** to deal documents when admin verifies banking

3. **Admin Deal Page Complete Overhaul**
   - Agent/Brokerage info: consolidated from two big cards into single compact horizontal bar
   - Deal Details + Financial: side-by-side 2-column grid with tighter typography
   - Property address made more prominent
   - **Section reorder (top to bottom):** Header + Pipeline + Action Bar → EFT Section → Brokerage Payments → Agent/Brokerage bar → Deal Details + Financial → **Underwriting** (moved UP) → **Messages** (full width, collapsible, audit-trail style) → Late Closing Interest → **Admin Notes** (audit-trail style, collapsed) → Audit Trail → Delete Deal
   - Underwriting: tighter padding, gold uppercase heading
   - Status badge in action bar properly styled with padding/border-radius/font-weight

4. **Drag-and-Drop Documents to Underwriting Checklist**
   - Documents in the right panel are now draggable (grip handle icon)
   - Drag a document over any unchecked checklist item — dashed green outline appears
   - Drop links the document to that checklist item via `linked_document_id`
   - Linked document shows as green badge with filename on the checklist item
   - Click the badge to view/download the linked file
   - Unlink button (broken chain icon) to remove — only visible when item is unchecked
   - **Locking:** When checklist item is checked (confirmed), linked document is locked. Must uncheck first to change. Enforced both in UI and server action (`linkDocumentToChecklist`)

5. **KYC Auto-Check Bug Fix + Auto-Linking**
   - **BUGFIX:** KYC auto-check was silently failing — code searched for `"Agent ID & KYC/FINTRAC verification"` but actual checklist item is `"Agent ID - FINTRAC Verification"`. Fixed to match migration 017 exactly.
   - When admin verifies KYC: auto-checks the checklist item on ALL agent's deals, auto-inserts KYC doc into `deal_documents`, AND auto-links it to the checklist item via `linked_document_id`
   - When KYC-verified agent submits a NEW deal: trigger function auto-checks "Agent ID - FINTRAC Verification" on creation (migration 023)

6. **Agent Portal UX Improvements**
   - **Deal cards go straight to detail page** — Removed expand/collapse middleman entirely. No more "View Deal & Upload Documents" button. Single click → full deal page. Cleaner card layout with chevron-right arrow.
   - **KYC "Take Photo" button** — Separate camera capture input (`capture="environment"`) for mobile. "Take Photo" button with camera icon below the file browse area. On desktop, camera button still appears but opens file dialog.
   - **KYC Verification Congratulations Modal** — Full-screen modal with checkmark animation: "Identity Verified! Congratulations, [name]! You can now submit advance requests." Shows once per agent using localStorage. "Get Started" dismiss button.
   - **Mobile header fix** — Agent deal detail header split into two rows: top row (logo + back + nav), bottom row (address + date). Status badge and sign out no longer overlap on narrow screens.

7. **Admin Deals Table — Agent Name Column**
   - Added Agent column to admin dashboard deals table (first_name + last_name)
   - Deals query now joins `agents(first_name, last_name)`
   - Search filters by both property address AND agent name

8. **Messages Section Restyled**
   - Messages section now matches Admin Notes/Audit Trail visual style (goldBg header, same padding/font/chevron)
   - Starts collapsed by default
   - Auto-scroll to newest messages fixed with sentinel div + `scrollIntoView` (replaces unreliable timeout approach)

### Bug Fixes (Session 11)

- **KYC auto-check silent failure** — Wrong checklist item name in `verifyAgentKyc()`. Has been broken since the checklist was finalized in Session 9. Fixed.
- **Missing DollarSign import** — Removed from admin dashboard but still used in Payments quick link. Netlify build failed. Re-added.
- **Missing formatCurrency import** — Same pattern. Re-added.
- **Null check on outstanding_recovery** — Netlify stricter than local TS. Fixed with proper null check.
- **Messages not scrolling to newest** — Old timeout-based approach was unreliable. Replaced with sentinel ref div + `scrollIntoView`.
- **Status badge unstyled** — Action bar status badge had no padding/border-radius. Fixed.
- **Git index corruption** — Lock file got stuck. Worked around with temp clone.

---

## Session 10 — What Was Completed (Previous Session)

### Migrations Applied (Session 10)

| # | File | Status |
|---|------|--------|
| 019 | `019_agent_message_reads.sql` — Agent read-tracking table. | ✅ Applied |
| 020 | `020_admin_message_dismissals.sql` — Admin notification dismissal table. | ✅ Applied |

### Features (Session 10)
1. Agent Notifications & Dedicated Messages Page — Full inbox, unread badges, returned doc indicators, AgentHeader with 30s polling
2. Admin Messages Page — Full inbox, "Needs Reply" filter, dismiss notification, red pulsing badges
3. Admin Notification Dismissal System — Timestamp-based, auto-returns if new message after dismissal
4. Email Throttling — 15-minute per-deal cooldown on admin message emails
5. Admin Dashboard Cleanup — Removed "Action Needed" bar, red pulse notification badges

---

## Session 9 — What Was Completed

### Migrations Applied (Session 9)

| # | File | Status |
|---|------|--------|
| 017 | `017_underwriting_checklist_final.sql` — Definitive 12 items, 3 categories. DO NOT MODIFY. | ✅ Applied |
| 018 | `018_account_balance_messages_doc_returns.sql` — Account balance, transactions, invoices, messages, doc returns tables. | ✅ Applied |

### Features (Session 9)
1. Underwriting Checklist — Final 12 items, 3 categories, auto-check logic
2. Messaging System (Admin ↔ Agent) — Thread UI, email notifications, deep links
3. Document Return System — Admin returns docs with reason, agent gets email, red alert
4. Late Closing Interest — Date picker, grace period, charges to agent balance, invoicing
5. Email Link Deep-Linking — Hash anchors, auto-scroll, login redirect preservation
6. Removed Underwriting Checklist from Agent View

---

## Key Files Map

| File | Purpose |
|------|---------|
| `app/(dashboard)/admin/page.tsx` | Admin dashboard — deal table with Agent column, quick links, notification badges |
| `app/(dashboard)/admin/deals/[id]/page.tsx` | Admin deal detail — redesigned compact layout, underwriting with drag-drop docs, messages, notes |
| `app/(dashboard)/admin/brokerages/page.tsx` | Brokerages page — includes banking entry section for agents |
| `app/(dashboard)/admin/messages/page.tsx` | Admin messages inbox, dismiss notification, needs reply filter |
| `app/(dashboard)/agent/page.tsx` | Agent dashboard — deal cards (direct link, no expand), KYC verified modal |
| `app/(dashboard)/agent/deals/[id]/page.tsx` | Agent deal detail — mobile-responsive header, timeline, docs, messages |
| `app/(dashboard)/agent/profile/page.tsx` | **NEW** — Agent profile: personal info, banking display, preauth upload |
| `app/(dashboard)/agent/messages/page.tsx` | Agent messages inbox with unread badges |
| `app/(dashboard)/agent/new-deal/page.tsx` | Deal submission form |
| `app/api/preauth-upload/route.ts` | **NEW** — Signed URL upload for preauth debit forms |
| `components/AgentHeader.tsx` | Shared agent header with nav links (Dashboard, Messages, Profile), notification bell |
| `components/AgentKycGate.tsx` | KYC upload component — now includes "Take Photo" camera button for mobile |
| `lib/actions/deal-actions.ts` | Deal CRUD, checklist toggle/NA, **linkDocumentToChecklist** (new), status changes |
| `lib/actions/kyc-actions.ts` | KYC verify/reject, auto-check checklist, auto-attach + auto-link docs |
| `lib/actions/profile-actions.ts` | **NEW** — Agent profile update, admin banking entry, preauth auto-attach |
| `lib/actions/notification-actions.ts` | All notification/messaging server actions (agent/admin inboxes) |
| `lib/actions/account-actions.ts` | Late interest, balance mgmt, invoicing, deal-page messaging, doc returns |
| `lib/email.ts` | All email templates (Resend) |
| `lib/calculations.ts` | Financial calculations |
| `lib/constants.ts` | Status badges, doc types, financial constants, grace period |
| `lib/supabase/server.ts` | `createClient()` (async) and `createServiceRoleClient()` (sync, bypasses RLS) |
| `lib/audit.ts` | Audit logging |
| `types/database.ts` | TypeScript interfaces for DB tables (includes banking/preauth fields) |
| `supabase/migrations/` | Migrations 017-023 are current — run manually in Supabase SQL Editor |

---

## Pending Work (Priority Order)

### 1. 🔴 Late Closing Interest — Needs Rethinking
Bud said **"I need to do some more thinking on this part"** at the start of Session 11. Current issues:
- Should show calculated amount and ask for confirmation before applying (currently applies immediately)
- Should prevent or warn about charging interest multiple times
- Bud is uncertain about how to handle additional commission charges
- The late interest section exists in the admin deal page (collapsible, funded/repaid only) but the UX flow needs Bud's input
- **DO NOT implement changes to this without discussing with Bud first.**

### 2. 🟡 Agent-Side Improvements
- Agent returned docs section design could be improved (Bud noted this previously)
- Agent deal detail page: consider removing redundant Deal Timeline section (it duplicates the progress bar). Bud said "the page is great" so this is low priority.
- Mobile testing needed — the header fix was done but other mobile glitches may exist

### 3. 🟡 Brokerage Portal Enhancements
- Brokerage admin features haven't been touched in recent sessions
- May need attention as platform grows

### 4. 🟢 Polish & Testing
- Email template testing (will test organically as deals flow)
- End-to-end testing of the full deal lifecycle with the new banking verification gate
- Test drag-and-drop document linking across different browsers
- Verify KYC auto-check + auto-link works correctly for existing agents with verified KYC submitting new deals

---

## Current Underwriting Checklist (IN DB — CORRECT & LOCKED)

**Agent Verification:**
1. Agent ID - FINTRAC Verification — *auto-checked if agent KYC verified (migration 023), auto-linked to KYC document*
2. Agent has no outstanding recovery balance from previous fallen-through deals
3. Agent in good standing with Brokerage (Not flagged) — *auto-checked if agent NOT flagged*

**Deal Verification:**
4. Agreement of Purchase and Sale, Schedules and Confirmation of Co-Operation
5. Amendments
6. Notices of Fulfillment/Waivers
7. Trade Record - Agent/Brokerage Split verified
8. Deal verified as unconditional
9. Address verification on Google & Street View
10. Double-check Discount Fee and Referral Fee Calculated Correctly

**Firm Fund Documents:**
11. Commission Purchase Agreement - Signed and Executed
12. Irrevocable Direction to Pay - Signed and Executed

**⚠️ DO NOT MODIFY THIS LIST. Migration 017 is the definitive version. Migration 023 updated the trigger function for auto-check logic only (did not change the items).**

---

## Auto-Linking Behavior Summary

| Trigger | What Happens |
|---------|-------------|
| Admin verifies agent KYC | Auto-checks "Agent ID - FINTRAC Verification" on all agent's deals. Auto-inserts KYC doc into deal_documents. Auto-links KYC doc to checklist item. |
| KYC-verified agent submits new deal | Trigger auto-checks "Agent ID - FINTRAC Verification" on creation. |
| Agent not flagged + new deal | Trigger auto-checks "Agent in good standing". |
| Admin verifies banking | Auto-attaches preauth form to all agent's deal_documents. |
| Admin drags document to checklist item | Links via `linked_document_id`. Locked when item is checked. |
