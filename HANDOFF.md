# Firm Funds — Session 14 Handoff Document

**Date:** April 5, 2026
**Owner:** Bud (homefoliomarketing@gmail.com)
**Repo:** `C:\Users\randi\Dev\firm-funds` (Windows/PowerShell)
**Live:** firmfunds.ca (Netlify auto-deploys from main)
**DB:** Supabase PostgreSQL with RLS

---

## Tech Stack & Critical Rules

- **Next.js 16.2.1 + Turbopack** — Breaking changes from training data. `params` in dynamic routes are Promises. `'use server'` files can ONLY export async functions. `useSearchParams()` requires `<Suspense>` boundary. **Read `node_modules/next/dist/docs/` before writing any code.**
- **Supabase** — RLS is the #1 bug source. Use `createServiceRoleClient()` for all server-side mutations. `createClient()` from `@/lib/supabase/client` is a synchronous browser client. `createClient()` from `@/lib/supabase/server` is async/cookie-based. `createServiceRoleClient()` from `@/lib/supabase/server` bypasses RLS.
- **Netlify** — Serverless functions. File uploads MUST use signed URLs (never send through Netlify functions). Auto-deploys from main branch. **Netlify's TypeScript checking is STRICTER than local `tsc --noEmit`** — be extra careful with null checks and unused imports. **Serverless functions kill execution context after response — always `await` async operations like email sends or they'll be terminated.**
- **Theme** — Dark mode permanently locked. `useTheme()` hook. `colors.gold` is actually green (#5FA873).
- **Audit logging** — `logAuditEvent()` / `logAuditEventServiceRole()` in `lib/audit.ts`. INSERT-only (DB triggers prevent UPDATE/DELETE).
- **Financial calculations** — Discount rate: $0.75 per $1,000 per day. +1 day processing offset applied in `lib/calculations.ts`. Late closing interest: same rate, 5-day grace period (`LATE_CLOSING_GRACE_DAYS` in `lib/constants.ts`).
- **PowerShell** — Use semicolons not `&&`. Quote paths with parentheses (e.g. `"app/(dashboard)/admin/page.tsx"`).
- **TypeScript** — Run `npx tsc --noEmit` to type-check. Exclude `.next/` errors (auto-generated route types). SWC binaries aren't available in sandbox, so `next build` won't work there.
- **Email throttling** — Admin message emails are throttled to 1 per deal per 15 minutes to prevent spam during back-and-forth conversations. Status change emails (approved, funded, denied, etc.) are NOT throttled — they fire once per status change.
- **Deal status flow** — `under_review → approved → funded → completed`. Status transition validation with optimistic locking in `deal-actions.ts`. "Completed" replaced the old "Repaid"/"Closed" split (Session 12).
- **Magic link invite flow** — Used for both agents and brokerage admins. Creates temp password → `invite_tokens` table (72hr expiry) → branded email with setup link → user sets own password on `/setup-account` page.
- **Migrations** — ALWAYS paste SQL inline in chat so Bud can run it in Supabase SQL Editor. Never make him ask for it. Never just reference a migration file.

---

## Bud's Working Style — READ THIS

- **Paste SQL directly in chat.** Don't create .sql files and tell him to open them. Just paste the SQL he needs to copy into Supabase SQL Editor.
- **Don't be lazy.** Do the work. Don't defer tasks or give partial solutions.
- **He's casual and direct.** Swearing is fine, sarcasm is fine. Be a bro but get shit done.
- **Don't over-explain** what's in a file he can see himself. Give him the file and a short summary.
- **Provide git/SQL commands ready to copy-paste.** He runs PowerShell on Windows. Always quote paths with parentheses.
- **Always provide copyable code.** Never say "run this migration" without pasting the actual SQL. Never say "push the code" without giving the exact git commands.
- **Commission-advance-startup skill** — There is a custom skill loaded for this project. Use it when Bud asks about business formation, compliance, or operational questions.

---

## Session 14 — What Was Completed (Current Session)

This was a continuation of Session 13. Session 13 built the server actions and email templates; Session 14 wired them to the UI and fixed bugs.

### Migrations Applied

| # | File | Status |
|---|------|--------|
| 026 | `026_notification_preferences.sql` — Adds `notification_preferences JSONB` column to user_profiles. | ✅ Applied (Session 13) |
| 027 | `027_swap_agent_checklist_order.sql` — Swaps sort_order for agent verification checklist items (recovery balance → 3, good standing → 2). | ✅ Applied (Session 13) |
| 028 | `028_allow_brokerage_admin_messages.sql` — Adds `brokerage_admin` to deal_messages sender_role CHECK constraint. Adds RLS policies for brokerage read/insert on deal_messages. | ✅ Applied (Session 14) |

### Features Completed & Tested

1. **Brokerage Admin Invite Flow (Magic Link)**
   - Replaced manual password-based brokerage login creation with `inviteBrokerageAdmin` server action
   - Create Login form now only needs Full Name + Email (no password field)
   - Button says "Create Login & Send Setup Link" with Mail icon
   - Sends branded welcome email with magic link — brokerage admin sets their own password
   - Added `resendBrokerageSetupLink` server action + "Resend Setup Link" button on existing brokerage admins in Manage Logins panel
   - Helper text: "A branded setup email will be sent with a magic link. They'll set their own password — no credentials to share."
   - **Files changed:** `app/(dashboard)/admin/brokerages/page.tsx`, `lib/actions/admin-actions.ts`, `lib/email.ts`

2. **Settings Pages (All Three Portals)**
   - Agent settings: password change, display name, email, notification toggles, link to profile
   - Admin settings: password change, display name, email, notification toggles
   - Brokerage settings: password change, display name, login email, brokerage contact email, notification toggles
   - Shared server actions in `lib/actions/settings-actions.ts`
   - **Files created:** `app/(dashboard)/agent/settings/page.tsx`, `app/(dashboard)/admin/settings/page.tsx`, `app/(dashboard)/brokerage/settings/page.tsx`, `lib/actions/settings-actions.ts`

3. **Admin User Management (Reset Passwords / Change Emails)**
   - `adminResetUserPassword` — generates temp password, creates magic link, sends reset email
   - `adminChangeUserEmail` — updates Supabase Auth + user_profiles + agents table, sends notification to old email
   - Per-agent buttons: KeyRound (reset password), AtSign (change email) with inline email change row
   - Brokerage admin: same buttons in Manage Logins panel
   - **Files changed:** `app/(dashboard)/admin/brokerages/page.tsx`, `lib/actions/admin-actions.ts`, `lib/email.ts`

4. **Permanent Delete for Archived Agents**
   - `permanentlyDeleteAgent` server action — only works on archived agents
   - Deletes user_profile, auth user, and agent record (FK cascades handle deals, transactions, invoices, etc.)
   - Red "Delete" button with Trash2 icon, double-confirms with scary warning
   - Visible only when "Show Archived" toggle is on
   - **Files changed:** `app/(dashboard)/admin/brokerages/page.tsx`, `lib/actions/admin-actions.ts`

5. **Notification Badge Improvements**
   - Admin dashboard: Under Review tab badge now shows actual count (was showing `!`)
   - Admin dashboard: Tab badges show count exclusively inside red badge OR as grey parenthetical — no more duplicate numbers
   - Admin dashboard: Messages badge now counts brokerage_admin messages too (was only counting agent messages)
   - Brokerage portal: Deals tab gets red badge with count of deals missing trade records
   - Brokerage portal: Messages tab gets red badge with count of unanswered admin messages
   - Brokerage portal: Inbox data pre-loads on page load so badges show immediately
   - Badge styling: `h-5 min-w-[20px] px-1.5 rounded-full text-[11px] font-bold animate-pulse` with `#DC2626` background
   - **Files changed:** `app/(dashboard)/admin/page.tsx`, `app/(dashboard)/brokerage/page.tsx`

6. **Brokerage Messaging Fix**
   - **Root cause:** `deal_messages` table had CHECK constraint `sender_role IN ('admin', 'agent')` — rejected `brokerage_admin`
   - Migration 028 adds `brokerage_admin` to the constraint + RLS policies
   - Fixed missing `await` on email notification send (Netlify serverless was killing the function before email went out)
   - Added error feedback (alert) when message send fails — was silently failing before
   - **Files changed:** `lib/actions/notification-actions.ts`, `app/(dashboard)/brokerage/page.tsx`

7. **Underwriting Checklist UI Fixes (Session 13)**
   - Fixed ugly white/light-mode category headers — now use dark-friendly translucent rgba colors
   - `CATEGORY_STYLES` updated: Agent Verification (purple), Deal Verification (blue), Firm Fund Documents (green)
   - Swapped order of Agent Verification items 2 and 3 (recovery balance moved to bottom)
   - Added collapsible wrapper matching Messages/Audit Trail pattern
   - **Files changed:** `app/(dashboard)/admin/deals/[id]/page.tsx`

8. **Brokerage Portal KPI Tiles Removed**
   - Removed the 4 KPI cards from brokerage dashboard top (matches agent/admin layout)
   - Same data still available in Referral Fees tab
   - **File changed:** `app/(dashboard)/brokerage/page.tsx`

9. **Password Visibility Toggle on Login**
   - Eye/EyeOff icon on password field, toggles between text/password input type
   - Uses `tabIndex={-1}` to not disrupt tab flow, turns green on hover
   - **File changed:** `app/(auth)/login/page.tsx`

10. **Enhanced Referral Fee Reporting (Brokerage Portal, Session 13)**
    - 4-column summary grid (Earned, Pending, Avg Fee/Deal, Combined Total)
    - Monthly trend bar chart (CSS-only, collapsible, last 12 months)
    - CSV export button
    - Monthly summary table with earned/pending/total per month
    - **File changed:** `app/(dashboard)/brokerage/page.tsx`

11. **Manage Logins Button Styling Fix**
    - Was greyed out when inactive — now uses `colors.gold` text matching Add Agent button style
    - Green fill with white text when active/selected
    - **File changed:** `app/(dashboard)/admin/brokerages/page.tsx`

12. **Change Email Refresh Bug Fix**
    - Changing a brokerage admin's email showed success but reverted visually
    - Root cause: handler refreshed `loadBrokerages()` but not `brokerageUserProfiles` state
    - Now also calls `getBrokerageUserProfiles()` after successful email change
    - **File changed:** `app/(dashboard)/admin/brokerages/page.tsx`

### Bug Fixes (Session 14)

- **Brokerage messages silently failing** — CHECK constraint on `deal_messages.sender_role` rejected `brokerage_admin`. Fixed with migration 028.
- **Brokerage message email notification not sending** — `sendBrokerageMessageNotification` was not `await`-ed; Netlify killed the function before Resend sent the email. Added `await`.
- **Admin unread count missing brokerage messages** — Only counted `sender_role === 'agent'`. Now also counts `brokerage_admin`.
- **Notification badges showing `!` instead of numbers** — Replaced fallback `!` with actual counts.
- **Manage Logins appearing greyed out** — Wrong text color (`textMuted` instead of `gold`).
- **Change Email not persisting visually** — Forgot to refresh `brokerageUserProfiles` state after update.

---

## Session 13 — What Was Completed (Previous Session)

Settings pages for all portals, admin user management (reset passwords, change emails), underwriting UI fixes, brokerage onboarding flow server actions and email templates, enhanced referral reporting. See Session 14 above for the items that were completed in this session (they span both 13 and 14).

---

## Session 12 — What Was Completed

### Migrations Applied (Session 12)

| # | File | Status |
|---|------|--------|
| 024 | `024_status_completed_rename.sql` — Updates deals with status 'repaid'/'closed' to 'completed'. | ✅ Applied |
| 025 | `025_kill_duplicate_checklist_trigger.sql` — Drops old `auto_create_checklist` trigger permanently. | ✅ Applied |

### Features (Session 12)
1. Status Rename: Repaid/Closed → Completed (single "Completed" status across entire codebase)
2. Agent Messaging Fix — Agents can now initiate conversations (fixed RLS block + inbox filtering)
3. Duplicate Checklist Trigger Bug — Permanently killed old trigger
4. Admin Deals Table — Mobile card layout
5. Agent Deal List — Pagination (10/page)
6. KYC Polling — Exponential backoff (5s→30s cap, 30min timeout)
7. Mobile Scroll-to-Messages Bug Fix

---

## Session 11 — What Was Completed

### Migrations Applied (Session 11)

| # | File | Status |
|---|------|--------|
| 021 | `021_agent_banking_profile.sql` — Banking fields, preauth form, address fields, storage bucket. | ✅ Applied |
| 022 | `022_checklist_document_linking.sql` — `linked_document_id` FK on underwriting_checklist. | ✅ Applied |
| 023 | `023_checklist_auto_check_kyc.sql` — Updated trigger for KYC auto-check on new deals. | ✅ Applied |

### Features (Session 11)
1. Dashboard KPI Tiles Removed (Agent & Admin Portals)
2. Agent Banking & Profile System
3. Admin Deal Page Complete Overhaul
4. Drag-and-Drop Documents to Underwriting Checklist
5. KYC Auto-Check Bug Fix + Auto-Linking
6. Agent Portal UX improvements
7. Admin Deals Table — Agent Name Column + search
8. Messages Section Restyled

---

## Sessions 9-10 Summary

### Session 10 Migrations: 019 (agent_message_reads), 020 (admin_message_dismissals)
### Session 10 Features: Agent notifications, admin messages page, dismissal system, email throttling

### Session 9 Migrations: 017 (underwriting_checklist_final), 018 (account_balance_messages_doc_returns)
### Session 9 Features: Underwriting checklist, messaging system, document returns, late closing interest, deep-linking

---

## Key Files Map

| File | Purpose |
|------|---------|
| `app/(auth)/login/page.tsx` | Login page — rate limiting, password visibility toggle, forgot password |
| `app/(auth)/setup-account/page.tsx` | Magic link setup page — where invited users set their password |
| `app/(dashboard)/admin/page.tsx` | Admin dashboard — deal table, notification badges (agents + brokerages), mobile cards |
| `app/(dashboard)/admin/deals/[id]/page.tsx` | Admin deal detail — underwriting with dark-friendly headers, drag-drop docs, messages, notes |
| `app/(dashboard)/admin/brokerages/page.tsx` | Brokerages page — agent management, banking entry, Manage Logins (invite + resend), permanent delete |
| `app/(dashboard)/admin/messages/page.tsx` | Admin messages inbox, dismiss notification, needs reply filter |
| `app/(dashboard)/admin/settings/page.tsx` | Admin settings — password, display name, email, notifications |
| `app/(dashboard)/admin/reports/page.tsx` | Reports page |
| `app/(dashboard)/admin/payments/page.tsx` | Payments page |
| `app/(dashboard)/agent/page.tsx` | Agent dashboard — deal cards, pagination |
| `app/(dashboard)/agent/deals/[id]/page.tsx` | Agent deal detail — messages, sendAgentReply server action |
| `app/(dashboard)/agent/profile/page.tsx` | Agent profile: personal info, banking, preauth upload |
| `app/(dashboard)/agent/settings/page.tsx` | Agent settings — password, display name, email, notifications |
| `app/(dashboard)/agent/messages/page.tsx` | Agent messages inbox |
| `app/(dashboard)/agent/new-deal/page.tsx` | Deal submission form |
| `app/(dashboard)/brokerage/page.tsx` | Brokerage portal — deals, agents, referrals, payments, messages, notification badges |
| `app/(dashboard)/brokerage/settings/page.tsx` | Brokerage settings — password, display name, emails, notifications |
| `lib/actions/admin-actions.ts` | Admin actions — CRUD, inviteBrokerageAdmin, resendBrokerageSetupLink, permanentlyDeleteAgent, resetPassword, changeEmail |
| `lib/actions/deal-actions.ts` | Deal CRUD, checklist toggle/NA, linkDocumentToChecklist, status changes |
| `lib/actions/notification-actions.ts` | Messaging — sendAgentReply, sendAdminMessage, sendBrokerageMessage, getBrokerageInbox |
| `lib/actions/settings-actions.ts` | Shared settings actions — changePassword, updateDisplayName, updateEmail, notification prefs |
| `lib/actions/profile-actions.ts` | Agent profile update, admin banking entry, preauth auto-attach |
| `lib/actions/kyc-actions.ts` | KYC verify/reject, auto-check checklist, auto-attach + auto-link docs |
| `lib/actions/account-actions.ts` | Late interest, balance mgmt, invoicing |
| `lib/actions/report-actions.ts` | Report generation |
| `lib/email.ts` | All email templates (Resend) — includes sendBrokerageInviteNotification, sendPasswordResetNotification, sendEmailChangeNotification, sendBrokerageMessageNotification |
| `lib/calculations.ts` | Financial calculations |
| `lib/constants.ts` | Status badges, doc types, financial constants |
| `lib/theme.ts` | useTheme hook, colors object |
| `lib/supabase/server.ts` | `createClient()` (async) and `createServiceRoleClient()` (sync, bypasses RLS) |
| `lib/audit.ts` | Audit logging |
| `types/database.ts` | TypeScript interfaces |
| `components/AgentHeader.tsx` | Shared agent header with nav + settings |
| `components/AgentKycGate.tsx` | KYC upload with exponential backoff polling |
| `components/SignOutModal.tsx` | Logout confirmation modal |
| `supabase/migrations/` | Migrations 017-028 are current |

---

## Planned Next Steps (Priority Order)

### 1. 🔴 E-Signature Integration
Agents and brokerages need to sign the Commission Purchase Agreement and Irrevocable Direction to Pay digitally before funding. DocuSign or equivalent. This is a gating requirement for processing any advance.

### 2. 🔴 Funding Workflow / Commission Calculator
Right now "Funded" is just a status change. Need to build:
- Commission calculation engine: fee = $0.75 per $1,000/day from funding date to closing date + 10 business days
- Clear breakdown visible to admin before clicking "Fund": agent receives X, fee is Y, brokerage referral is Z
- Payment disbursement tracking (even if manual initially — mark when EFT sent, confirmation)

### 3. 🔴 Portfolio / Collections Dashboard
Track outstanding advances, aging (days since funding), upcoming closings, and deals at risk. Admin needs a bird's-eye view of capital deployed and expected returns.

### 4. 🟡 White-Label Branding
Brokerage-specific branding on the agent-facing experience. Each brokerage partner should be able to show their logo/colors. This is the key differentiator of the business model.

### 5. 🟡 Agent-Side Improvements
- Agent returned docs section design could be improved
- Consider removing redundant Deal Timeline section (duplicates progress bar)

### 6. ⚫ NOT DOING: PPSA Registration Tracking
Bud explicitly decided against this — cost vs. transaction revenue doesn't make sense.

### 7. ⏳ Business Prerequisites (In Progress, Not Blocking Dev)
These are in the works on Bud's end and not things the dev agent can help with:
- Legal contracts (Commission Purchase Agreement, Irrevocable Direction to Pay, Brokerage Cooperation Agreement)
- FINTRAC registration (4-6 week processing time)
- Banking with EFT capability

---

## Current Underwriting Checklist (IN DB — CORRECT & LOCKED)

**Agent Verification:**
1. Agent ID - FINTRAC Verification — *auto-checked if agent KYC verified, auto-linked to KYC document*
2. Agent in good standing with Brokerage (Not flagged) — *auto-checked if agent NOT flagged*
3. Agent has no outstanding recovery balance from previous fallen-through deals

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

**⚠️ DO NOT MODIFY THIS LIST. Migration 017 is the definitive version. Migration 023 updated trigger for auto-check. Migration 025 killed duplicate trigger. Migration 027 swapped sort_order of items 2 and 3.**

---

## Known Resolved Gotchas (For Future Reference)

- **No check constraint on deals.status column** — Only `deals_source_check` on source column. Status validation is in application code.
- **Only two triggers on deals table:** `on_deal_created` (creates underwriting checklist) and `update_deals_updated_at` (timestamp).
- **Agent messaging uses server actions, not direct Supabase calls** — `sendAgentReply` uses `createServiceRoleClient()`.
- **Messages scroll behavior** — Only auto-scrolls on: (a) `#messages` hash in URL, or (b) user sends new message.
- **deal_messages.sender_role** — CHECK constraint now allows `'admin'`, `'agent'`, `'brokerage_admin'` (migration 028).
- **Netlify serverless + async** — Always `await` email sends and other async operations. Unawaited promises get killed when the function returns.
- **Supabase rate limiting** — IP-level, not account-level. Too many auth attempts from one IP locks ALL accounts from that IP for ~10 minutes.
