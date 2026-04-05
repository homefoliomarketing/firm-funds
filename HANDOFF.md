# Firm Funds — Session 10 Handoff Document

**Date:** April 4, 2026
**Owner:** Bud (homefoliomarketing@gmail.com)
**Repo:** `C:\Users\randi\Dev\firm-funds` (Windows/PowerShell)
**Live:** firmfunds.ca (Netlify auto-deploys from main)
**DB:** Supabase PostgreSQL with RLS

---

## Tech Stack & Critical Rules

- **Next.js 16.2.1 + Turbopack** — Breaking changes from training data. `params` in dynamic routes are Promises. `'use server'` files can ONLY export async functions. `useSearchParams()` requires `<Suspense>` boundary. **Read `node_modules/next/dist/docs/` before writing any code.**
- **Supabase** — RLS is the #1 bug source. Use `createServiceRoleClient()` for all server-side mutations. `createClient()` from `@/lib/supabase/client` is a synchronous browser client. `createClient()` from `@/lib/supabase/server` is async/cookie-based. `createServiceRoleClient()` from `@/lib/supabase/server` bypasses RLS.
- **Netlify** — Serverless functions. File uploads MUST use signed URLs (never send through Netlify functions). Auto-deploys from main branch.
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

## Session 10 — What Was Completed

### Migrations Applied

| # | File | Status |
|---|------|--------|
| 019 | `019_agent_message_reads.sql` — Agent read-tracking table for unread message counts. `agent_message_reads` with `agent_id`, `deal_id`, `last_read_at`. Also adds `sender_name` to `deal_messages`. | ✅ Applied |
| 020 | `020_admin_message_dismissals.sql` — Admin notification dismissal table. `admin_message_dismissals` with `admin_id`, `deal_id`, `dismissed_at`. Unique constraint on (admin_id, deal_id). Allows admins to dismiss notifications without replying. Notification returns if agent sends a new message after dismissal. | ✅ Applied |

### Features Completed & Tested

1. **Agent Notifications & Dedicated Messages Page**
   - **AgentHeader component** (`components/AgentHeader.tsx`) — Shared header for all agent pages. Shows logo, "Dashboard" and "Messages" nav links on main pages. Shows back arrow + title on deal pages. Red notification badge (bell icon) with count of unread messages + pending doc returns. Polls every 30 seconds.
   - **Agent Messages Inbox** (`app/(dashboard)/agent/messages/page.tsx`) — Full inbox-style page. Left panel: deal list with search, message previews, green unread badges, red `!` for returned docs. Right panel: chat thread with bubbles, returned doc alert bar, reply input. Uses `h-screen flex flex-col overflow-hidden` to prevent page scroll. Auto-scrolls to latest message. Marks messages as read on deal selection.
   - **Agent deal page integration** — Replaced inline header with `<AgentHeader>`. Calls `markDealMessagesRead()` after messages load. Calls `autoResolvePendingReturns()` after successful document upload to clear returned doc alerts.

2. **Admin Messages Page**
   - **Admin Messages Inbox** (`app/(dashboard)/admin/messages/page.tsx`) — Mirrors agent side. Shows agent name per deal. "Needs Reply" filter tab (red). Red pulsing "Reply" badge on deals where agent sent last message. Sends email to agent on reply (throttled). Container-based scrolling (not page scroll). "Dismiss Notification" button in thread header to acknowledge without replying.
   - **Admin dashboard integration** — "Messages" quick link button with red pulsing badge showing unread count. Red "New" tag next to deals in table that have unread agent messages. Red pulsing badge on "Under Review" status tab. Red pulsing badge on "Brokerages" quick link for pending KYC count.

3. **Admin Notification Dismissal System**
   - `admin_message_dismissals` table tracks when admin acknowledged a conversation
   - "Dismiss Notification" button in admin messages thread header
   - Dismissal is timestamp-based: if agent sends a NEW message after the dismissal, notification returns automatically
   - Replying still auto-clears notifications (admin becomes last sender)
   - Both admin dashboard and admin messages page respect dismissals

4. **Email Throttling**
   - Both `sendAdminMessage()` (notification-actions.ts) and `sendDealMessage()` (account-actions.ts) now check for recent admin messages on the same deal within 15 minutes
   - First message → sends email. Messages within 15 min → no extra emails
   - If 15+ min passes and admin sends again → email fires again
   - Status change emails (deal approved, funded, etc.) are completely unaffected

5. **Admin Dashboard Cleanup**
   - Removed the ugly yellow "Action Needed" bar entirely
   - All notification badges changed from green to red with pulse animation
   - Notifications moved to inline locations: Messages quick link, Brokerages quick link, Under Review tab, deal table rows

### Bug Fixes (Session 10)
- **Agent messages page stuck loading** — No try/catch in load function, so if `getAgentInbox` threw, loading spinner never stopped. Fixed with try/catch/finally.
- **Ambiguous FK join on document_returns** — Two FKs to `deal_documents` caused Supabase join ambiguity. Fixed with two separate queries merged via Map.
- **Messages won't send (SUPABASE_SERVICE_ROLE_KEY missing)** — `.env.local` was missing the service role key. Bud added it.
- **Admin dashboard 400 error / KYC count showing 11** — Query used `user_profiles` table with `kyc_status = 'pending'` but KYC is on `agents` table with status `'submitted'`. Fixed.
- **Admin/agent message scroll moving entire browser** — `scrollIntoView()` scrolled the window. Fixed with container ref + `container.scrollTop = container.scrollHeight`.
- **Agent messages page body scroll** — `min-h-screen` allowed overflow. Changed to `h-screen flex flex-col overflow-hidden`.
- **TypeScript error on lucide `title` prop** — Wrapped icon in `<span>` instead.

---

## Session 9 — What Was Completed (Previous Session)

### Migrations Applied (Session 9)

| # | File | Status |
|---|------|--------|
| 017 | `017_underwriting_checklist_final.sql` — Wipes all existing checklist items, recreates with Bud's approved 12 items in 3 categories. DO NOT MODIFY. | ✅ Applied |
| 018 | `018_account_balance_messages_doc_returns.sql` — Account balance, transactions, invoices, messages, doc returns tables. Full RLS. | ✅ Applied |

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
| `app/(dashboard)/admin/page.tsx` | Admin dashboard — KPIs, deal table, quick links, notification badges |
| `app/(dashboard)/admin/deals/[id]/page.tsx` | Admin deal detail — underwriting, viewer, messages, doc returns, late interest |
| `app/(dashboard)/admin/messages/page.tsx` | **NEW** — Admin messages inbox, dismiss notification, needs reply filter |
| `app/(dashboard)/agent/page.tsx` | Agent dashboard — KPIs, deal list, uses AgentHeader |
| `app/(dashboard)/agent/deals/[id]/page.tsx` | Agent deal detail — timeline, docs, messages, returned doc alerts, uses AgentHeader |
| `app/(dashboard)/agent/messages/page.tsx` | **NEW** — Agent messages inbox with unread badges and returned doc indicators |
| `app/(dashboard)/agent/new-deal/page.tsx` | Deal submission form — slot-based doc uploads |
| `app/(dashboard)/brokerage/page.tsx` | Brokerage portal — deals, agents, payments tabs |
| `components/AgentHeader.tsx` | **NEW** — Shared agent header with nav links, notification bell, 30s polling |
| `lib/actions/notification-actions.ts` | **NEW** — All notification/messaging server actions (agent inbox, admin inbox, send/reply, dismiss, auto-resolve returns) |
| `lib/actions/account-actions.ts` | Late interest, balance mgmt, invoicing, messaging (with email throttle), doc returns |
| `lib/actions/deal-actions.ts` | Server actions for deals, checklist toggle, N/A toggle |
| `lib/actions/kyc-actions.ts` | KYC verify/reject, auto-attach docs, KYC approval email |
| `lib/email.ts` | All email templates (Resend) — messages, doc returns, invoices, KYC, deal status |
| `lib/calculations.ts` | Financial calculations (discount fee, advance amount, late interest) |
| `lib/constants.ts` | Timeouts, status badges, doc types, financial constants, grace period |
| `lib/supabase/server.ts` | `createClient()` (async) and `createServiceRoleClient()` (sync, bypasses RLS) |
| `lib/audit.ts` | Audit logging functions + severity mappings |
| `middleware.ts` | Auth, role routing, force password change, redirect preservation |
| `components/SessionTimeout.tsx` | Session timeout modal component |
| `types/database.ts` | All TypeScript interfaces for DB tables |
| `supabase/migrations/` | All DB migrations (017-020 are current) — run manually in Supabase SQL Editor |

---

## Pending Work (Priority Order)

### 1. 🔴 Admin Deal Page Redesign
The admin deal page is overloaded — underwriting checklist, documents, document viewer, messages, document returns, late closing interest all on one page. Bud's latest thinking (end of Session 10): **get rid of the big tiles** on the admin dashboard and move useful info into the reports section. This needs further discussion with Bud to nail down exactly what stays, what moves, and the new layout. Consider tabs, collapsible sections, or a multi-panel layout for the deal detail page itself.

Bud's words: "for the redesign, i think it may actually just be getting rid of the big tiles, and putting whatever info that is good into the reports section"

### 2. 🟡 Late Closing Interest Improvements
- Should show calculated amount and **ask for confirmation before applying** (currently just applies immediately)
- Should prevent or warn about **charging interest multiple times** on the same deal (currently allows repeated charges)
- Bud said "I'm not sure how we should be handling the additional commission charges yet" — this needs a conversation with him

### 3. 🟡 Agent Profiles (Large Feature — Flagged for Future)
- Personal info, banking details, address from ID
- Banking info section on agent profile
- Check that blocks deal approval if banking info missing from agent profile

### 4. 🟢 Remaining Items (Lower Priority)
- Documents should be draggable to underwriting categories (drag-drop)
- Email template testing (will test organically as deals flow)
- Agent-side returned docs section design improvement (Bud noted it needs a rethink)

---

## Current Underwriting Checklist (IN DB — CORRECT & LOCKED)

**Agent Verification:**
1. Agent ID & KYC/FINTRAC verification
2. Agent has no outstanding recovery amounts from fallen-through deals
3. Agent is in good standing (not flagged by brokerage) — *auto-checked/unchecked based on `flagged_by_brokerage` field*

**Deal Verification:**
4. Agreement of Purchase and Sale (APS) received and reviewed
5. APS is fully executed (signed by all parties)
6. Property address verified against MLS listing
7. Brokerage split percentage confirmed via trade record
8. Deal status is firm/unconditional (no outstanding conditions)
9. Closing date is confirmed and within acceptable range
10. Commission amount matches APS and trade record

**Firm Fund Documents:**
11. Commission Purchase Agreement - Signed
12. Irrevocable Direction to Pay - Signed

**⚠️ DO NOT MODIFY THIS LIST. It has been a recurring problem across sessions 6-9. Migration 017 is the definitive version.**
