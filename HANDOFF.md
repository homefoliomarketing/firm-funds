# Firm Funds — Session 12 Handoff Document

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
- **Deal status flow** — `under_review → approved → funded → completed`. Status transition validation with optimistic locking in `deal-actions.ts`. "Completed" replaced the old "Repaid"/"Closed" split (Session 12).

---

## Bud's Working Style — READ THIS

- **Go through features ONE AT A TIME for testing.** Do NOT give him a list of things to test all at once. He hates that. Walk him through each feature individually.
- **Paste SQL directly in chat.** Don't create .sql files and tell him to open them. Just paste the SQL he needs to copy into Supabase SQL Editor.
- **Don't be lazy.** Do the work. Don't defer tasks or give partial solutions.
- **He's casual and direct.** Swearing is fine, sarcasm is fine. Be a bro but get shit done.
- **Push everything at once.** He prefers to test locally/on staging, then push all changes in one batch at the end of the session.
- **Don't over-explain** what's in a file he can see himself. Give him the file and a short summary.
- **Provide git/SQL commands ready to copy-paste.** He runs PowerShell on Windows. Always `cd C:\Users\randi\Dev\firm-funds` first, always quote paths with parentheses.
- **Always provide copyable code.** Never say "run this migration" without pasting the actual SQL. Never say "push the code" without giving the exact git commands.

---

## Session 12 — What Was Completed

### Migrations Applied

| # | File | Status |
|---|------|--------|
| 024 | `024_status_completed_rename.sql` — Updates all deals with status 'repaid' or 'closed' to 'completed'. No constraint changes needed (no check constraint existed on status column). | ✅ Applied |
| 025 | `025_kill_duplicate_checklist_trigger.sql` — Drops the old `auto_create_checklist` trigger and `create_default_checklist()` function permanently. This was the root cause of the bloated underwriting checklist bug. | ✅ Applied |

### Features Completed & Tested

1. **Status Rename: Repaid/Closed → Completed**
   - Merged two terminal statuses ("Repaid" and "Closed") into a single "Completed" status — because this is a commission purchase, not a loan
   - Updated ~20 files across the entire codebase: types, constants, Zod schemas, email templates, server actions, admin/agent/brokerage pages, API routes, reports
   - Deal status flow is now: `under_review → approved → funded → completed`
   - Admin deal page: "Mark as Repaid" and "Close Deal" buttons replaced with single "Mark Complete"
   - Admin dashboard: Repaid and Closed tabs merged into single "Completed" tab
   - Status badge color: teal (`bg: '#0F2A24', text: '#5FB8A0', border: '#1E4A3C'`)
   - Migration 024 applied to update existing deals in DB
   - **Files changed:** `types/database.ts`, `lib/constants.ts`, `lib/validations.ts`, `lib/email.ts`, `lib/actions/deal-actions.ts`, `lib/actions/report-actions.ts`, `lib/actions/admin-actions.ts`, `lib/actions/notification-actions.ts`, `app/(dashboard)/admin/deals/[id]/page.tsx`, `app/(dashboard)/admin/page.tsx`, `app/(dashboard)/admin/reports/page.tsx`, `app/(dashboard)/admin/payments/page.tsx`, `app/(dashboard)/agent/page.tsx`, `app/(dashboard)/agent/deals/[id]/page.tsx`, `app/(dashboard)/agent/messages/page.tsx`, `app/(dashboard)/brokerage/page.tsx`, `app/api/reports/referral-fees/route.ts`

2. **Agent Messaging Fix — Agents Can Now Initiate Conversations**
   - **Problem:** Agents could only reply to messages, not start conversations. Two bugs:
     - `getAgentInbox()` in `notification-actions.ts` skipped deals with zero messages (line 181 had `if (msgs.length === 0 && returns.length === 0) continue`)
     - Agent deal detail page's `handleSendReply` used direct Supabase client calls which were blocked by RLS
   - **Fix (Inbox):** Changed `getAgentInbox()` to include ALL active deals (only skips denied/cancelled). Added `created_at` to deals query. Sort puts unread messages first, then by most recent activity.
   - **Fix (Deal Detail):** Replaced direct Supabase client `handleSendReply` with `sendAgentReply` server action that uses `createServiceRoleClient()`. Server action returns full message object for optimistic UI update.
   - **Fix (Messages Page):** Updated empty states — "No active deals" when agent has zero deals, "No messages yet — tap to start a conversation" for deals with no messages, thread empty state with icon + "Send a message to the Firm Funds team below"
   - **Files changed:** `lib/actions/notification-actions.ts`, `app/(dashboard)/agent/deals/[id]/page.tsx`, `app/(dashboard)/agent/messages/page.tsx`

3. **Duplicate Checklist Trigger Bug — Permanently Fixed**
   - **Problem:** New deals were getting bloated checklists with old items mixed in with correct items. Bud found this on "91 Laura Street" deal.
   - **Root cause:** TWO INSERT triggers existed on the `deals` table: `auto_create_checklist` (old function `create_default_checklist()`) and `on_deal_created` (correct function `create_underwriting_checklist()`). Both fired on every new deal.
   - **Fix:** Migration 025 drops the old trigger and function permanently. Cleaned up 91 Laura Street by deleting and regenerating its checklist items.
   - **Verification:** Queried `information_schema.triggers` to confirm only `on_deal_created` and `update_deals_updated_at` remain on the deals table.
   - **This will never happen again.** The old trigger and function are completely gone from the database.

4. **Admin Deals Table — Mobile Card Layout**
   - Added responsive card layout for the admin dashboard deals table on mobile
   - Desktop: unchanged table with `hidden md:block`
   - Mobile: card-based layout with `md:hidden` showing property address, agent name + status badge, commission + advance amounts, closing date
   - **File changed:** `app/(dashboard)/admin/page.tsx`

5. **Agent Deal List — Pagination**
   - Added pagination to agent dashboard deal list (10 deals per page)
   - Page controls with previous/next buttons, "Page X of Y" display
   - Search and filter changes auto-reset to page 1
   - **File changed:** `app/(dashboard)/agent/page.tsx`

6. **KYC Polling — Exponential Backoff**
   - Changed KYC status polling from fixed 5-second `setInterval` to recursive `setTimeout` with exponential backoff
   - Intervals: 5s → 10s → 15s → 20s → 30s (cap)
   - Stops polling after 30 minutes total elapsed time
   - **File changed:** `components/AgentKycGate.tsx`

7. **Mobile Scroll-to-Messages Bug Fix**
   - **Problem:** On mobile agent portal, clicking a deal with messages auto-scrolled to the messages section instead of showing the top of the page. Caused by a `useEffect` that called `messagesEndRef.scrollIntoView` whenever `dealMessages.length` changed, including on initial load.
   - **Fix:** Added `initialMessageCountRef` to track the initial message count. On first load, records the count without scrolling. Only auto-scrolls when the count increases after initial load (i.e., when user sends a new message). Hash-based deep link scrolling (`#messages` from email links or inbox) still works as before.
   - **File changed:** `app/(dashboard)/agent/deals/[id]/page.tsx`

### Bug Fixes (Session 12)

- **Migration 024 constraint error** — Initial attempt to update status to 'completed' failed with check constraint violation. Investigation revealed NO check constraint existed on the status column (only `deals_source_check` on source column). Just ran the UPDATE directly.
- **Duplicate checklist trigger** — Found and killed `auto_create_checklist` trigger. See Feature #3 above.
- **Agent messaging RLS block** — Direct Supabase client calls blocked by RLS. Replaced with server action using `createServiceRoleClient()`. See Feature #2 above.
- **Agent inbox dead end** — `getAgentInbox()` skipped deals with no messages, making it impossible for agents to start conversations. See Feature #2 above.
- **Mobile scroll hijack** — `useEffect` scrolling to messages on every page load. Fixed with initial count tracking. See Feature #7 above.

---

## Session 11 — What Was Completed (Previous Session)

### Migrations Applied (Session 11)

| # | File | Status |
|---|------|--------|
| 021 | `021_agent_banking_profile.sql` — Banking fields, preauth form, address fields, storage bucket. | ✅ Applied |
| 022 | `022_checklist_document_linking.sql` — `linked_document_id` FK on underwriting_checklist. | ✅ Applied |
| 023 | `023_checklist_auto_check_kyc.sql` — Updated trigger for KYC auto-check on new deals. | ✅ Applied |

### Features (Session 11)
1. Dashboard KPI Tiles Removed (Both Portals)
2. Agent Banking & Profile System — Profile page, admin banking entry, approval gate, preauth auto-attach
3. Admin Deal Page Complete Overhaul — Compact layout, section reorder, styled messages/notes
4. Drag-and-Drop Documents to Underwriting Checklist — Grip handles, green outline, linking, locking
5. KYC Auto-Check Bug Fix + Auto-Linking — Fixed wrong checklist item name, auto-insert + auto-link docs
6. Agent Portal UX — Direct deal links, camera button, KYC congrats modal, mobile header fix
7. Admin Deals Table — Agent Name Column + search
8. Messages Section Restyled — Collapsible, audit-trail style

---

## Session 10 — What Was Completed

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
| `app/(dashboard)/admin/page.tsx` | Admin dashboard — deal table with Agent column, mobile card layout, quick links, notification badges |
| `app/(dashboard)/admin/deals/[id]/page.tsx` | Admin deal detail — compact layout, underwriting with drag-drop docs, messages, notes, "Mark Complete" button |
| `app/(dashboard)/admin/brokerages/page.tsx` | Brokerages page — includes banking entry section for agents |
| `app/(dashboard)/admin/messages/page.tsx` | Admin messages inbox, dismiss notification, needs reply filter |
| `app/(dashboard)/admin/reports/page.tsx` | Reports page — pipeline uses 'completed' status |
| `app/(dashboard)/admin/payments/page.tsx` | Payments page — filters by funded/completed |
| `app/(dashboard)/agent/page.tsx` | Agent dashboard — deal cards (direct link), pagination (10/page), KYC verified modal |
| `app/(dashboard)/agent/deals/[id]/page.tsx` | Agent deal detail — mobile-responsive, messages always visible, no auto-scroll on load, sendAgentReply server action |
| `app/(dashboard)/agent/profile/page.tsx` | Agent profile: personal info, banking display, preauth upload |
| `app/(dashboard)/agent/messages/page.tsx` | Agent messages inbox — shows ALL active deals, empty state for no-message deals |
| `app/(dashboard)/agent/new-deal/page.tsx` | Deal submission form |
| `app/(dashboard)/brokerage/page.tsx` | Brokerage portal — uses funded/completed statuses |
| `app/api/preauth-upload/route.ts` | Signed URL upload for preauth debit forms |
| `app/api/reports/referral-fees/route.ts` | Referral fee report — uses completed status |
| `components/AgentHeader.tsx` | Shared agent header with nav links, notification bell |
| `components/AgentKycGate.tsx` | KYC upload — camera button, exponential backoff polling (5s→30s cap, 30min timeout) |
| `lib/actions/deal-actions.ts` | Deal CRUD, checklist toggle/NA, linkDocumentToChecklist, status changes (completed replaces repaid/closed) |
| `lib/actions/kyc-actions.ts` | KYC verify/reject, auto-check checklist, auto-attach + auto-link docs |
| `lib/actions/profile-actions.ts` | Agent profile update, admin banking entry, preauth auto-attach |
| `lib/actions/notification-actions.ts` | All notification/messaging server actions — getAgentInbox (all active deals), sendAgentReply (service role) |
| `lib/actions/account-actions.ts` | Late interest, balance mgmt, invoicing, deal-page messaging, doc returns |
| `lib/actions/report-actions.ts` | Report generation — uses completed status |
| `lib/actions/admin-actions.ts` | Admin actions — brokerage payment validation uses funded/completed |
| `lib/email.ts` | All email templates (Resend) — completed status color |
| `lib/calculations.ts` | Financial calculations |
| `lib/constants.ts` | Status badges (completed = teal), doc types, financial constants, grace period |
| `lib/validations.ts` | Zod schemas — DealStatusChangeSchema includes 'completed' |
| `lib/supabase/server.ts` | `createClient()` (async) and `createServiceRoleClient()` (sync, bypasses RLS) |
| `lib/audit.ts` | Audit logging |
| `types/database.ts` | TypeScript interfaces — DealStatus includes 'completed' (not repaid/closed) |
| `supabase/migrations/` | Migrations 017-025 are current — run manually in Supabase SQL Editor |

---

## Pending Work (Priority Order)

### 1. 🔴 Late Closing Interest — Needs Rethinking
Bud said **"I need to do some more thinking on this part"** at the start of Session 11. Current issues:
- Should show calculated amount and ask for confirmation before applying (currently applies immediately)
- Should prevent or warn about charging interest multiple times
- Bud is uncertain about how to handle additional commission charges
- The late interest section exists in the admin deal page (collapsible, funded/completed only) but the UX flow needs Bud's input
- **DO NOT implement changes to this without discussing with Bud first.**

### 2. 🟡 Agent-Side Improvements
- Agent returned docs section design could be improved (Bud noted this previously)
- Agent deal detail page: consider removing redundant Deal Timeline section (it duplicates the progress bar). Bud said "the page is great" so this is low priority.

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

**⚠️ DO NOT MODIFY THIS LIST. Migration 017 is the definitive version. Migration 023 updated the trigger function for auto-check logic only (did not change the items). Migration 025 killed the duplicate trigger that was causing bloated checklists.**

---

## Auto-Linking Behavior Summary

| Trigger | What Happens |
|---------|-------------|
| Admin verifies agent KYC | Auto-checks "Agent ID - FINTRAC Verification" on all agent's deals. Auto-inserts KYC doc into deal_documents. Auto-links KYC doc to checklist item. |
| KYC-verified agent submits new deal | Trigger auto-checks "Agent ID - FINTRAC Verification" on creation. |
| Agent not flagged + new deal | Trigger auto-checks "Agent in good standing". |
| Admin verifies banking | Auto-attaches preauth form to all agent's deal_documents. |
| Admin drags document to checklist item | Links via `linked_document_id`. Locked when item is checked. |

---

## Known Resolved Gotchas (For Future Reference)

- **No check constraint on deals.status column** — There's only `deals_source_check` on the source column. Status validation is done in application code (Zod + STATUS_FLOW map), not at the DB level.
- **Only two triggers remain on deals table:** `on_deal_created` (creates underwriting checklist) and `update_deals_updated_at` (timestamp). The old `auto_create_checklist` was permanently killed in migration 025.
- **Agent messaging uses server actions, not direct Supabase calls** — `sendAgentReply` in `notification-actions.ts` uses `createServiceRoleClient()` to bypass RLS.
- **Messages scroll behavior** — Deal detail page only auto-scrolls to messages when: (a) URL has `#messages` hash, or (b) user sends a new message. Does NOT scroll on initial page load.
