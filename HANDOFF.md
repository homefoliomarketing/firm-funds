# Firm Funds Incorporated — Complete Handoff Document
**Last Updated:** April 3, 2026
**Project:** firmfunds.ca — Commission advance platform for Ontario real estate agents
**Owner:** Bud (bud@firmfunds.ca) — Non-developer, needs copy-paste PowerShell commands
**GitHub:** github.com/homefoliomarketing/firm-funds
**Production:** https://firmfunds.ca (Netlify auto-deploy from `main` branch)

---

## 1. What Firm Funds Does

Firm Funds purchases pending real estate commissions from Ontario agents at a discount, giving agents cash before closing. The web portal manages the entire workflow: deal submission by agents, underwriting by admins, document collection, funding via EFT, repayment tracking, and brokerage referral fee management.

---

## 2. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | **Next.js 16.2.1** | BREAKING CHANGES — `params` are Promises in dynamic routes. MUST read `node_modules/next/dist/docs/` before writing route code |
| React | **19.2.4** | |
| Database | **Supabase PostgreSQL** | Row Level Security enabled. Supabase URL: `bzijzmxhrpiwuhzhbiqc.supabase.co` |
| Auth | **Supabase Auth** | JWT cookies, role-based routing in middleware |
| Email | **Resend** | Transactional email from `notifications@firmfunds.ca`, domain verified with DKIM |
| Hosting | **Netlify** | Auto-deploy from GitHub `main` branch — NO staging environment |
| DNS | **GoDaddy** | firmfunds.ca |
| Email/Workspace | **Google Workspace** | @firmfunds.ca email accounts |

---

## 3. Codebase Architecture

### Directory Structure
```
app/
  (auth)/login/page.tsx              — Login page (no ThemeToggle, dark mode only)
  (dashboard)/
    admin/page.tsx                   — Main admin dashboard (KPI cards, deal list, time range filter)
    admin/deals/[id]/page.tsx        — Admin deal detail (status transitions, backward revert, underwriting
                                       checklist, doc viewer, EFT tracking, admin notes)
    admin/brokerages/page.tsx        — Brokerage + agent CRUD management (expandable rows, bulk import)
    admin/reports/page.tsx           — Reports dashboard (1070 lines, PDF export, charts)
    admin/agents/page.tsx            — DEAD CODE — nothing links to it, should be deleted
    agent/page.tsx                   — Agent dashboard (their deals list)
    agent/deals/[id]/page.tsx        — Agent deal detail (view, edit while under_review, upload docs, cancel)
    agent/new-deal/page.tsx          — New deal submission (4-field address, live financial preview)
    brokerage/page.tsx               — Brokerage portal (agent list, deal activity, referral fee tracking)
  layout.tsx                         — Root layout with favicon metadata
  globals.css                        — CSS variables (green theme)

lib/
  actions/deal-actions.ts            — Server actions: submit deal, update status (with backward transitions),
                                       upload docs, delete docs, signed URLs, edit deal, cancel deal,
                                       delete deal (TEMP for testing), save admin notes
  actions/admin-actions.ts           — Server actions: brokerage CRUD, agent CRUD, bulk import, create user
                                       account, EFT tracking (record/confirm/remove)
  actions/report-actions.ts          — Server actions: report metrics, brokerage detail
  calculations.ts                    — Financial calculations (server-side ONLY, integer-cent rounding)
  constants.ts                       — ALL business constants (discount rate, limits, status badges, roles)
  email.ts                           — Resend email service (4 email types, branded HTML templates)
  theme.tsx                          — Theme system via useTheme() hook (~40 color tokens)
  validations.ts                     — Zod schemas for deal submission, status changes, document uploads
  audit.ts                           — Audit log helper (writes to audit_log table)
  supabase/client.ts                 — Browser Supabase client
  supabase/server.ts                 — Server Supabase client

components/
  SignOutModal.tsx                    — Sign out confirmation modal (on every dashboard page)
  SessionTimeout.tsx                 — Session timeout handler
  ThemeToggle.tsx                    — DEPRECATED stub (returns null, kept to avoid import errors)

middleware.ts                        — Auth + role-based route protection

public/brand/
  white.png                          — White logo on transparent (used in dark headers + emails)
  black.png, grey.png                — Other logo variants

supabase/migrations/
  003_audit_log.sql                  — Audit log table (CONFIRMED RUN)
  004_rls_hardening.sql              — RLS policies (CONFIRMED RUN)
  005_fix_storage_policies.sql       — Storage policy fixes
```

### Key Patterns — MUST FOLLOW

**Theme System:** All colors from `lib/theme.tsx` via `useTheme()` hook. Dark mode is permanently locked (toggle is a no-op). Brand accent is green (#5FA873). Variable names still say "gold" — that's legacy naming from the original palette. Never hardcode colors.

**Server Actions Pattern:** Authenticate → Zod validate → act → audit log → email notification (fire-and-forget). See `lib/actions/deal-actions.ts` for the canonical pattern.

**Financial Calculations:** Server-side only in `lib/calculations.ts`. Uses integer-cent rounding via `roundToCents()`. Discount rate: $0.75 per $1,000 of net commission per day until closing. All amounts stored in the DB as DOLLARS (not cents).

**Business Constants:** Everything in `lib/constants.ts` — discount rates, EFT limits, upload constraints, session timeouts, roles, status badges. Never hardcode these anywhere.

**Status Flow (including backward transitions):**
```
under_review → approved, denied, cancelled
approved     → funded, denied, cancelled, under_review (backward)
funded       → repaid, approved (backward)
denied       → under_review (backward)
cancelled    → under_review (backward)
repaid       → closed, funded (backward)
```
Backward transitions show an amber warning modal with contextual messaging before confirming. Server-side cleanup: reverting from denied clears `denial_reason`, reverting from repaid clears `repayment_date`.

**Email Notifications (lib/email.ts):**
- FROM: `Firm Funds <notifications@firmfunds.ca>` (via Resend)
- Admin alerts go to: `bud@firmfunds.ca` (hardcoded as `ADMIN_EMAIL`)
- James (james@firmfunds.ca) does NOT receive automatic emails — this is intentional
- 4 email types: new deal → admin, status change → agent, doc requested → agent, doc uploaded → admin
- Branded dark HTML template with green (#5FA873) accents and Firm Funds logo
- Fire-and-forget — `catch` logs the error but never blocks the server action
- `formatCurrency(dollars)` takes DOLLARS, not cents (this was a bug that was fixed)
- Funded email says "our goal is to have the funds in your account within 24 business hours"
- `RESEND_API_KEY` env var must be set in Netlify

**Critical Business Rules — NEVER violate:**
1. No "submitted" status — deals go straight to `under_review`
2. Agents are admin-onboarded ONLY — never build self-registration
3. Financial calculations are ALWAYS server-side
4. All amounts stored in DOLLARS in the database
5. `calcDaysUntilClosing()` uses Eastern Time (America/Toronto)
6. When funding, financials are recalculated server-side using actual days to closing

---

## 4. User Accounts

| Email | Role | Purpose | Notes |
|-------|------|---------|-------|
| bud@firmfunds.ca | super_admin | Bud's main admin account | Primary admin, receives all email notifications |
| james@firmfunds.ca | super_admin | James Caicco's admin account | Forwards to james.caicco@century21.ca via Google Groups. Does NOT receive automatic email notifications. |
| bud.jones@century21.ca | agent | Test agent at Century 21 Choice Realty | Created via Supabase dashboard + SQL user_profile link. Real email Bud has access to. |

**Roles in the system:**
- `super_admin` — Full access to everything (admin dashboard)
- `firm_funds_admin` — Same as super_admin currently (future tier differentiation)
- `brokerage_admin` — Only their brokerage's deals/agents (brokerage dashboard)
- `agent` — Only their own deals (agent dashboard)

**Role-based routing (middleware.ts):**
- `/admin/*` → super_admin, firm_funds_admin
- `/brokerage/*` → brokerage_admin
- `/agent/*` → agent
- Unauthenticated → redirected to `/login`
- Logged in on `/login` → redirected to role-appropriate dashboard

---

## 5. Infrastructure & Environment

| Service | Details |
|---------|---------|
| Supabase | `bzijzmxhrpiwuhzhbiqc.supabase.co` — PostgreSQL + Auth + Storage (deal-documents bucket) |
| Netlify | Auto-deploy from GitHub main branch |
| Resend | Domain verified (firmfunds.ca), DKIM verified via GoDaddy |
| GoDaddy | DNS for firmfunds.ca |
| Google Workspace | @firmfunds.ca email accounts |

**Netlify Environment Variables:**
- `RESEND_API_KEY` — Resend API key for transactional email
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key

**Important:** Every push to `main` auto-deploys to Netlify. There is NO staging environment. Always run `npx tsc --noEmit` before pushing.

---

## 6. What Is Fully Built & Working (as of April 3, 2026)

### Admin Portal
- Dashboard with KPI cards (total deals, funded amounts, pipeline value), deal list with pagination and time range filter
- Deal detail page (~1600 lines) with:
  - Full underwriting checklist (3 categories, 11 items total, auto-created by DB trigger) — whole row clickable, green filled circles for checked, no strikethrough
  - Document viewer with signed download URLs
  - EFT transfer tracking (record/confirm/remove) with dark-mode date pickers
  - Admin notes timeline — timestamped append-only entries (replaces old single textarea), Ctrl+Enter shortcut, legacy notes shown read-only
  - Closing date inline edit with pencil icon — "Update & Recalc" recalculates all financials server-side, shows before/after comparison, updates state from server response (not client refetch, to avoid RLS issues)
  - **Brokerage Payments section** (funded/repaid deals) — record multiple payments with amount, date, method (EFT/cheque/wire/other), reference number. Payment tracker shows received vs expected (green=match, yellow=outstanding, red=overpaid). Remove individual payments. "Mark as Repaid" button is GATED — only enabled when brokerage payment total matches amount_due_from_brokerage.
  - Financial summary shows brokerage payment count + total (replaced old single repayment_amount display)
  - Delete deal button for under_review/cancelled/denied deals (double-confirm)
- Forward AND backward status transitions with optimistic locking (prevents concurrent admin conflicts)
- Backward transitions show amber warning modal with contextual cleanup messaging
- Checklist gate: forward transition buttons disabled when checklist incomplete OR (for repaid) when brokerage payments don't match
- Brokerage management with expandable rows showing inline agent rosters, bulk agent import from Excel/CSV via `xlsx` library
- Reports dashboard (1070 lines) with PDF export

### Agent Portal
- Dashboard showing agent's deals with inline "Withdraw Request" (under_review) / "Cancel Advance" (approved) buttons in expanded deal cards
- New deal submission form with 4-field address, live financial preview, firmness confirmation checkbox, multi-file document upload with per-file error handling
- Deal detail with edit capability while under_review, document upload, cancel/withdraw button
- Withdraw (under_review) = full deletion (documents, checklist, storage files, deal record)
- Cancel (approved) = set status to cancelled

### Brokerage Portal
- Agent list, deal activity, referral fee tracking

### Auth & Security
- Supabase Auth with JWT cookies
- Role-based middleware routing
- Row Level Security enforced at DB level
- Session timeout handling (15 min admin, 30 min agent)
- Sign out confirmation modal on every dashboard page
- Audit logging on all deal actions

### Email Notifications
- New deal submitted → admin (bud@firmfunds.ca) AND brokerage admins for that brokerage
- Status change → agent (with custom messaging per status: approved says "funded shortly", funded says "24 business hours", denied shows reason)
- Document uploaded by agent → admin
- Document request → agent (function exists, NO UI to trigger it yet)
- Closing date alert digest (cron) → admin (overdue + approaching deals tables)

### Theme
- Dark mode permanently locked, green (#5FA873) brand accent
- ~40 color tokens via `useTheme()` hook
- All date inputs have `colorScheme: 'dark'` for proper native calendar rendering
- Light mode code still exists but toggle is disabled

### Cron / Scheduled Jobs
- `/api/cron/closing-date-alerts` — daily check for approaching (≤7 days) and overdue funded/approved deals, updates days_until_closing, protected by CRON_SECRET bearer token, uses service role client

---

## 7. What's NOT Built Yet (Priority Order)

### High Priority — Next Code Tasks
1. **Document request UI** — `sendDocumentRequestNotification()` exists in `lib/email.ts` but there's no admin button/flow to request specific documents from agents. Need a "Request Document" UI on the admin deal detail page.
2. **Agent onboarding flow** — Currently agents are created manually (SQL/dashboard). Need admin-created invite flow with email. NOT self-registration — agents are always admin-onboarded.
3. **Delete dead code** — Remove `app/(dashboard)/admin/agents/page.tsx` (nothing links to it)
4. **Remove temporary delete button** — The `deleteDeal` action and its UI button on the admin deal page are for testing only. Should be removed or gated before real production use.
5. **Mobile-responsive optimization** — App is currently desktop-focused

### Medium Priority
6. **Agent portal document request system** — After admin requests a doc (see #1), agent should see the request notification and have a streamlined upload response
7. **Brokerage portal upgrades** — More detailed views, agent performance metrics
8. **CPA (Commission Purchase Agreement) PDF generation** — Auto-generate from deal data

### Needs Third-Party Services
9. **E-signature integration** (DocuSign/HelloSign) — Needs account + API key
10. **Nexone Integration** — Waiting on API response from Nexone (auto-pull deal data)
11. **FINTRAC/AML compliance** — Needs legal counsel for ID verification requirements
12. **Legal document templates** — Commission Purchase Agreement and Irrevocable Direction to Pay (needs lawyer)

### Infrastructure / Ops Tasks
- **Set up CRON_SECRET env var** in Netlify + external scheduler (e.g. cron-job.org) for daily closing date alerts at `GET /api/cron/closing-date-alerts` with `Authorization: Bearer <CRON_SECRET>` header
- Run migration 005 (fix_storage_policies) — STATUS UNKNOWN, check if done
- Enable MFA in Supabase Auth settings (TOTP)
- Check rate limiting in Supabase Auth
- Check Netlify SSL certificate is active and auto-renewing

---

## 8. Known Issues & Gotchas

1. **Supabase auth user creation via SQL is unreliable** — Raw SQL inserts into `auth.users` break because of missing `auth.identities` records. ALWAYS use the Supabase dashboard "Add user" button, then link via SQL `INSERT INTO user_profiles`.

2. **`createUserAccount` server action needs `SUPABASE_SERVICE_ROLE_KEY`** — The admin action in `admin-actions.ts` uses `supabase.auth.admin.createUser()` which requires the service role key. This key may not be set in Netlify env vars. Until it is, user creation must be done via Supabase dashboard.

3. **Variable names say "gold" but colors are green** — `gold`, `goldDark`, `goldBg` in `theme.tsx` are actually green (#5FA873). Legacy naming from original palette. Don't be confused.

4. **ThemeToggle.tsx is a stub** — Returns null. Kept only to prevent import errors from any stale references. Can be safely deleted if all imports are cleaned up.

5. **RLS blocks agent-level clients from UPDATE/SELECT on deals** — Agent Supabase clients (anon key) can't update deals or refetch deal data after server mutations. Pattern: use `createServiceRoleClient()` for mutations, use server action response data for state updates instead of client-side refetches. This has bitten us multiple times (cancelDeal, updateClosingDate).

6. **Next.js server actions have a default 1MB body size limit** — File uploads will crash silently. Currently configured to 25MB in `next.config.ts` via `experimental.serverActions.bodySizeLimit: '25mb'`.

7. **Underwriting checklist duplication** — Multiple DB trigger versions created stacked items. Fixed with migration 009 that deletes all and recreates with a clean 11-item list. If it happens again, check the DB trigger function for `create_underwriting_checklist`.

8. **`.claude/worktrees/` was accidentally committed** — Removed with `git rm --cached`. If it reappears, re-run `git rm --cached .claude/worktrees/distracted-pasteur`.

---

## 9. Color Reference

The app uses green as the primary brand accent. Here are the key tokens:

| Token | Dark Mode Value | Usage |
|-------|----------------|-------|
| gold | #C4B098 | Primary accent (yes, it's called "gold" but it's used alongside green) |
| Brand green | #5FA873 | Headers, buttons, email accents, CSS `--ff-sand` |
| pageBg | #121212 | Main background |
| cardBg | #1C1C1C | Card/panel backgrounds |
| textPrimary | #E8E4DF | Primary text |
| textSecondary | #999999 | Secondary text |
| border | #2E2E2E | Card borders |

Status badge colors (from `constants.ts`):
- under_review: blue (#3D5A99)
- approved: green (#1A7A2E)
- funded: purple (#5B3D99)
- repaid: teal (#0D7A5F)
- denied: red (#993D3D)
- cancelled: orange (#995C1A)
- closed: grey (#5A5A5A)

---

## 10. Working With Bud

- **NOT a developer.** Give copy-paste PowerShell commands every time. His project path: `C:\Users\randi\Dev\firm-funds`
- **PowerShell uses semicolons** (`;`) not `&&` for chaining commands
- **Casual, direct, friendly.** He appreciates humor and sarcasm. Don't be lazy or take shortcuts. He'll call you out.
- **He says what he means.** If something looks wrong, he'll tell you bluntly. Don't get defensive, just fix it.
- **Always run `npx tsc --noEmit` before telling him to push.** Zero TypeScript errors or don't ship.
- **Auto-deploy means zero room for error.** Every push goes straight to production at firmfunds.ca.
- **When in doubt about Supabase, use the dashboard.** SQL auth user creation is fragile.
- **James Caicco is his business partner.** james@firmfunds.ca has super_admin access but should NOT receive automatic notification emails.

---

## 11. Database Schema (Key Tables)

These are the main tables. RLS is enforced on all of them.

- **deals** — Core deal records. Fields: id, agent_id, brokerage_id, status, property_address, closing_date, gross_commission, brokerage_split_pct, net_commission, days_until_closing, discount_fee, advance_amount, brokerage_referral_fee, amount_due_from_brokerage, funding_date, repayment_date, repayment_amount, eft_transfers (JSONB array), brokerage_payments (JSONB array — `[{amount, date, reference?, method?}]`), admin_notes_timeline (JSONB array — `[{id, text, author_name, created_at}]`), source, denial_reason, notes, admin_notes (legacy, replaced by admin_notes_timeline), created_at, updated_at
- **agents** — Agent profiles. Fields: id, brokerage_id, first_name, last_name, email, phone, reco_number, status, flagged_by_brokerage, outstanding_recovery
- **brokerages** — Brokerage records. Fields: id, name, email, brand, address, phone, referral_fee_percentage, transaction_system, notes, status
- **user_profiles** — Auth user → role mapping. Fields: id (matches auth.users.id), email, full_name, role, agent_id, brokerage_id, is_active
- **deal_documents** — Document metadata. Fields: id, deal_id, uploaded_by, document_type, file_name, file_path, file_size, upload_source, notes, created_at
- **underwriting_checklist** — Per-deal checklist items (auto-created by DB trigger). Fields: id, deal_id, checklist_item, is_checked, checked_by, checked_at, notes
- **audit_log** — Immutable action log. Fields: id, action, entity_type, entity_id, metadata (JSONB), created_at

Storage bucket: `deal-documents` in Supabase Storage

---

## 12. NPM Dependencies

Key packages: next@16.2.1, react@19.2.4, @supabase/ssr, @supabase/supabase-js, resend@^6.10.0, zod, lucide-react, xlsx, date-fns, zustand, react-hook-form, @hookform/resolvers, @tanstack/react-query

---

## 13. Git / Deploy Workflow

```powershell
# From Bud's machine:
cd C:\Users\randi\Dev\firm-funds
git add -A
git commit -m "your message here"
git push origin main
```
Netlify watches `main` and auto-deploys. No CI checks, no staging. What you push is what goes live.

---

## 14. SQL Migrations History

All migrations live in `supabase/migrations/`. Bud runs them manually in the Supabase SQL Editor.

| Migration | Purpose | Status |
|-----------|---------|--------|
| 003_audit_log.sql | Audit logging table | ✅ RUN |
| 004_rls_hardening.sql | Row Level Security policies | ✅ RUN |
| 005_fix_storage_policies.sql | Storage bucket RLS fixes | ⚠️ UNKNOWN |
| 006_add_admin_notes.sql | admin_notes_timeline JSONB column | ✅ RUN |
| 007_document_requests.sql | Document request tracking columns | ✅ RUN |
| 008_audit_fixes.sql | repayment_amount column, brokerage_documents table | ✅ RUN |
| 008_underwriting_checklist_cleanup.sql | First checklist cleanup attempt | ✅ RUN (superseded by 009) |
| 009_checklist_cleanup_v2.sql | Delete all checklist items + recreate clean 11-item list | ✅ RUN |
| 010_brokerage_payments.sql | brokerage_payments JSONB column on deals | ✅ RUN |

---

## 15. Recent Session Work Log (April 3, 2026)

### Completed — 10-Step Audit Fix Plan
1. ✅ Deal submission improvements — firmness confirmation checkbox, multi-file document upload with per-file error handling
2. ✅ Brokerage admin email notifications — new deal submission emails sent to brokerage admins
3. ✅ Admin notes timeline — replaced single textarea with timestamped append-only entries
4. ✅ Closing date recalculation — inline edit with server-side recalc, before/after comparison
5. ✅ Closing date cron alerts — `/api/cron/closing-date-alerts` route for daily digest emails

### Completed — Bug Fixes
- ✅ File upload crash (Next.js 1MB body limit → bumped to 25MB)
- ✅ Agent cancel button missing from dashboard (was only on detail page)
- ✅ RLS blocking agent deal cancellation (switched to service role client)
- ✅ Under_review deals now fully deleted on withdrawal (not just cancelled)
- ✅ Admin delete deal button added
- ✅ Underwriting checklist duplication fixed (clean 11-item migration)
- ✅ Checklist UI redesigned (whole row clickable, no strikethrough, green circles)
- ✅ Closing date update not persisting (RLS on client refetch — use server response data)
- ✅ Date picker calendar not working in dark mode (added colorScheme: 'dark')

### Completed — Brokerage Payments Redesign
- ✅ Multiple brokerage payments tracked via JSONB array (replaces old single repayment_amount)
- ✅ Record Payment form (amount, date, method, reference)
- ✅ Payment tracker (received vs expected, color-coded)
- ✅ Remove individual payments
- ✅ "Mark as Repaid" gated by payment total matching amount_due_from_brokerage
- ✅ Financial summary updated to show brokerage payment count + total
- ✅ Old repayment state variables cleaned up

### Last Push
- Commit: `fix: date picker calendar not working in dark mode - add colorScheme dark to all date inputs`
- All TypeScript compiling clean (`npx tsc --noEmit` = 0 errors)
- All SQL migrations have been run
