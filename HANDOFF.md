# ⚠️ THIS FILE IS SUPERSEDED

**As of Session 16 (2026-04-05), project knowledge has been moved to:**
- **`CLAUDE.md`** — Permanent project rules (auto-loaded every session)
- **Memory system** — Accumulated knowledge at `~/.claude/projects/.../memory/` (auto-indexed)
- **Handoff prompts** — Short session deltas only (~20 lines)

This file is kept for historical reference only. Do not maintain or update it.

---

# Firm Funds — Session 15 Handoff Document (ARCHIVED)

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
- **He works in Cowork mode** — Claude has browser access via "Claude in Chrome" MCP tools. Bud may ask you to interact with DocuSign, Netlify, Supabase, or other dashboards directly in his browser.

---

## Session 15 — What Was Completed (Current Session)

This session focused entirely on **DocuSign e-signature integration** — contract generation, sending for signature, webhook processing, and signed document storage.

### Migrations Applied

| # | File | Status |
|---|------|--------|
| 029 | `029_broker_of_record.sql` — Adds broker_of_record fields to brokerages table. | ✅ Applied (Session 15) |
| 030 | `030_esignature_envelopes.sql` — Creates `esignature_envelopes` table for tracking DocuSign envelope status per document. | ✅ Applied (Session 15) |

### Features Completed & Tested

1. **Contract Document Generation (CPA + IDP)**
   - Built `.docx` contract generator using `docx` npm package
   - Commission Purchase Agreement (CPA) — multi-section with main body, Schedule A, and signature page
   - Irrevocable Direction to Pay (IDP) — separate document
   - **All black text, no color** — removed Word's default blue `HeadingLevel.HEADING_2` theme styling; all headings use manual bold with explicit `color: '000000'`
   - Removed all table shading/fill colors
   - Footer on every page: initials line (right-aligned with underline) + hidden DocuSign anchor + page numbers
   - **File:** `lib/contract-docx.ts`

2. **DocuSign Anchor Tabs for Signature Placement**
   - Uses anchor strings: `/sig1/` (signature), `/ini1/` (initials), `/dat1/` (date)
   - DocuSign scans the rendered PDF for these strings and places interactive fields
   - **Initials on every page** — achieved by putting `/ini1/` anchor in the page footer (footer repeats on every page). Body content anchors only appear on the last page of each section.
   - **Hidden anchor technique** — anchor text uses white color (`FFFFFF`) and 2pt font size, making it invisible to humans but still detectable by DocuSign
   - `makeFooterWithInitials(label)` — used on body/Schedule A pages
   - `makeFooterNoInitials()` — used on signature pages (signature anchor is in the body)
   - **File:** `lib/contract-docx.ts`

3. **DocuSign API Integration**
   - OAuth2 JWT Grant flow for server-to-server auth
   - Token management with refresh logic in `getValidAccessToken()`
   - Callback route at `/api/docusign/callback/route.ts` for initial consent flow
   - `sendForESignature()` server action — generates CPA + IDP docs, creates DocuSign envelope with both as documents (docId 1 = CPA, docId 2 = IDP), sends to agent for signature
   - Stores envelope tracking records in `esignature_envelopes` table (one per document type per deal)
   - **Files:** `lib/docusign.ts`, `lib/actions/esign-actions.ts`, `app/api/docusign/callback/route.ts`

4. **DocuSign Connect Webhook — Signed Document Processing**
   - Webhook endpoint at `/api/docusign/webhook/route.ts` — receives POST from DocuSign when envelope status changes
   - **Auth middleware fix** — `/api/docusign/webhook` was being 302 redirected to `/login` because middleware treated it as an unauthenticated request. Fixed by adding it to the exclusion list in `middleware.ts`.
   - When envelope status is `completed` (signed):
     1. Gets DocuSign auth token via `getValidAccessToken()`
     2. Downloads signed PDFs from DocuSign REST API (doc 1 = CPA, doc 2 = IDP)
     3. Uploads to Supabase storage bucket `deal-documents` with path `{dealId}/{timestamp}_{uuid}.pdf`
     4. Creates `deal_documents` records with proper types (`commission_agreement` / `direction_to_pay`)
     5. Finds matching underwriting checklist items via `ilike` pattern match
     6. Updates checklist: `is_checked: true`, `linked_document_id` set, `checked_at` timestamped
   - **Critical: `checked_by` must be `null`, not a string** — the column is UUID-typed. Passing `'system'` caused silent update failures. Fixed to use `null` with explanation in `notes` field.
   - **No fallback checking** — if auth token unavailable or docs can't be downloaded, checklist items are NOT checked off. Must have signed PDFs in hand before funding.
   - **Error checking** — all Supabase update results are now checked and logged
   - Always returns 200 to DocuSign to prevent retry loops
   - **File:** `app/api/docusign/webhook/route.ts`

5. **Approval vs Funding Checklist Split**
   - Changed blocking logic on admin deal page: CPA/IDP signed docs (Firm Fund Documents category) are only required for **funding**, not for **approval**
   - `approvalItems` = checklist items NOT in 'Firm Fund Documents' category
   - `allApprovalItemsComplete` gates the Approve button
   - `allChecklistComplete` (all items including Firm Fund Docs) gates the Fund button
   - Tooltip shows different messages for approval blocks vs funding blocks
   - **File:** `app/(dashboard)/admin/deals/[id]/page.tsx`

6. **Brokerage Split Fix**
   - `brokerage_split_pct` in DB stores the value as a whole number (e.g., `5` for 5%), not a decimal (`0.05`)
   - Code was multiplying by 100, showing 500%. Fixed by removing the `* 100`.
   - **File:** `lib/actions/esign-actions.ts`

### Bug Fixes (Session 15)

- **Blue headings in contracts** — Word's `HeadingLevel.HEADING_2` applies default blue theme color. Removed `HeadingLevel` entirely; use manual bold styling with explicit `color: '000000'`.
- **`/ini1/` showing as visible text in contracts** — DocuSign anchor string was rendering visibly. Fixed with white color + 2pt font size (invisible to humans, visible to DocuSign scanner).
- **Initials only on last page** — When anchor was in body content, it only appeared on the page where that paragraph rendered. Fixed by moving anchor to footer (repeats on every page).
- **Brokerage split showing 500%** — DB stores `5` not `0.05`; removed `* 100` multiplication.
- **DocuSign webhook getting 302 redirected to login** — Auth middleware in `middleware.ts` was intercepting the POST. Added `/api/docusign/webhook` to the public route exclusion list.
- **Checklist items not updating after webhook** — `checked_by: 'system'` failed silently because the column is UUID-typed. Changed to `checked_by: null` with auto-check info in `notes` field.

### DocuSign Configuration (Sandbox)

- **Account:** bud@firmfunds.ca, Account ID 47005378
- **App:** Registered in DocuSign Developer portal with JWT Grant consent
- **Connect Webhook:** "Firm Funds Webhook", Config ID 22115872, Status: Active
  - URL: `https://firmfunds.ca/api/docusign/webhook`
  - Data Format: REST v2.1 (JSON)
  - Events: Envelope completed
- **Sandbox limitation:** Emails don't deliver to external addresses. Use "Correct" feature to change signer email to bud@firmfunds.ca (sandbox account) for testing.
- **To resend a webhook:** DocuSign Admin → Connect → Publish tab → check the envelope → Publish → select Firm Funds Webhook → Publish

---

## Session 14 — What Was Completed

This was a continuation of Session 13. Session 13 built the server actions and email templates; Session 14 wired them to the UI and fixed bugs.

### Migrations Applied (Session 14)

| # | File | Status |
|---|------|--------|
| 026 | `026_notification_preferences.sql` — Adds `notification_preferences JSONB` column to user_profiles. | ✅ Applied (Session 13) |
| 027 | `027_swap_agent_checklist_order.sql` — Swaps sort_order for agent verification checklist items. | ✅ Applied (Session 13) |
| 028 | `028_allow_brokerage_admin_messages.sql` — Adds `brokerage_admin` to deal_messages sender_role CHECK constraint. | ✅ Applied (Session 14) |

### Features (Session 14)
1. Brokerage Admin Invite Flow (Magic Link)
2. Settings Pages (All Three Portals)
3. Admin User Management (Reset Passwords / Change Emails)
4. Permanent Delete for Archived Agents
5. Notification Badge Improvements
6. Brokerage Messaging Fix
7. Underwriting Checklist UI Fixes
8. Brokerage Portal KPI Tiles Removed
9. Password Visibility Toggle on Login
10. Enhanced Referral Fee Reporting
11. Manage Logins Button Styling Fix
12. Change Email Refresh Bug Fix

---

## Session 12 — What Was Completed

### Migrations: 024 (status_completed_rename), 025 (kill_duplicate_checklist_trigger)
### Features:
1. Status Rename: Repaid/Closed → Completed
2. Agent Messaging Fix
3. Duplicate Checklist Trigger killed
4. Admin Deals Table — Mobile card layout
5. Agent Deal List — Pagination
6. KYC Polling — Exponential backoff
7. Mobile Scroll-to-Messages Bug Fix

---

## Session 11 — What Was Completed

### Migrations: 021 (agent_banking_profile), 022 (checklist_document_linking), 023 (checklist_auto_check_kyc)
### Features:
1. Dashboard KPI Tiles Removed
2. Agent Banking & Profile System
3. Admin Deal Page Complete Overhaul
4. Drag-and-Drop Documents to Underwriting Checklist
5. KYC Auto-Check Bug Fix + Auto-Linking
6. Agent Portal UX improvements
7. Admin Deals Table — Agent Name Column + search
8. Messages Section Restyled

---

## Sessions 9-10 Summary

### Session 10: Migrations 019-020. Agent notifications, admin messages page, dismissal system, email throttling.
### Session 9: Migrations 017-018. Underwriting checklist, messaging system, document returns, late closing interest, deep-linking.

---

## Key Files Map

| File | Purpose |
|------|---------|
| `app/(auth)/login/page.tsx` | Login page — rate limiting, password visibility toggle, forgot password |
| `app/(auth)/setup-account/page.tsx` | Magic link setup page |
| `app/(dashboard)/admin/page.tsx` | Admin dashboard — deal table, notification badges, mobile cards |
| `app/(dashboard)/admin/deals/[id]/page.tsx` | Admin deal detail — underwriting (approval vs funding split), drag-drop docs, e-sign send, messages |
| `app/(dashboard)/admin/brokerages/page.tsx` | Brokerages — agent mgmt, banking, Manage Logins, permanent delete |
| `app/(dashboard)/admin/messages/page.tsx` | Admin messages inbox |
| `app/(dashboard)/admin/settings/page.tsx` | Admin settings |
| `app/(dashboard)/admin/reports/page.tsx` | Reports page |
| `app/(dashboard)/admin/payments/page.tsx` | Payments page |
| `app/(dashboard)/agent/page.tsx` | Agent dashboard — deal cards, pagination |
| `app/(dashboard)/agent/deals/[id]/page.tsx` | Agent deal detail — messages |
| `app/(dashboard)/agent/profile/page.tsx` | Agent profile: personal info, banking, preauth upload |
| `app/(dashboard)/agent/settings/page.tsx` | Agent settings |
| `app/(dashboard)/agent/messages/page.tsx` | Agent messages inbox |
| `app/(dashboard)/agent/new-deal/page.tsx` | Deal submission form |
| `app/(dashboard)/brokerage/page.tsx` | Brokerage portal — deals, agents, referrals, payments, messages |
| `app/(dashboard)/brokerage/settings/page.tsx` | Brokerage settings |
| `app/api/docusign/callback/route.ts` | DocuSign OAuth callback — handles consent redirect |
| `app/api/docusign/webhook/route.ts` | DocuSign Connect webhook — receives signed status, downloads PDFs, stores in Supabase, auto-checks checklist |
| `app/api/docusign/signing-url/route.ts` | **UNWANTED — DELETE THIS.** Created during debugging, not needed. |
| `lib/docusign.ts` | DocuSign auth (JWT Grant), token management, `getValidAccessToken()` |
| `lib/contract-docx.ts` | Contract .docx generator — CPA + IDP with hidden DocuSign anchors, black-only formatting |
| `lib/actions/esign-actions.ts` | `sendForESignature()` — generates contracts, creates DocuSign envelope, sends to agent |
| `lib/actions/admin-actions.ts` | Admin CRUD, invites, password resets, email changes, permanent delete |
| `lib/actions/deal-actions.ts` | Deal CRUD, checklist toggle/NA, linkDocumentToChecklist, status changes |
| `lib/actions/notification-actions.ts` | Messaging — agent, admin, brokerage message actions |
| `lib/actions/settings-actions.ts` | Shared settings actions |
| `lib/actions/profile-actions.ts` | Agent profile update, admin banking entry |
| `lib/actions/kyc-actions.ts` | KYC verify/reject, auto-check checklist |
| `lib/actions/account-actions.ts` | Late interest, balance mgmt, invoicing |
| `lib/actions/report-actions.ts` | Report generation |
| `lib/email.ts` | All email templates (Resend) |
| `lib/calculations.ts` | Financial calculations |
| `lib/constants.ts` | Status badges, doc types, financial constants |
| `lib/theme.ts` | useTheme hook, colors object |
| `lib/supabase/server.ts` | `createClient()` (async) and `createServiceRoleClient()` (sync, bypasses RLS) |
| `lib/audit.ts` | Audit logging |
| `middleware.ts` | Auth middleware — redirects unauthenticated users to login. **Public routes excluded:** `/login`, `/auth`, `/kyc-upload`, `/api/kyc-*`, `/invite`, `/api/magic-link`, `/api/rate-limit`, `/api/docusign/webhook` |
| `types/database.ts` | TypeScript interfaces |
| `components/AgentHeader.tsx` | Shared agent header with nav + settings |
| `components/AgentKycGate.tsx` | KYC upload with exponential backoff polling |
| `components/SignOutModal.tsx` | Logout confirmation modal |
| `supabase/migrations/` | Migrations 017-030 are current |

---

## Planned Next Steps (Priority Order)

### 1. 🔴 Cleanup from Session 15
- **Delete `app/api/docusign/signing-url/route.ts`** — unwanted file created during debugging
- **Full end-to-end test on a fresh deal** — send contracts → agent signs → webhook fires → docs stored → checklist auto-checked → admin can fund
- **Send CPA, IDP, and BCA contracts to lawyer for review** (Bud's task, not dev)

### 2. 🔴 Admin Notification System for Pending Banking Info Approvals
Bud mentioned this during Session 15 — "we will get into that in a bit." When agents submit banking info, admins need to be notified so they can review/approve it. Currently there's no notification or indicator.

### 3. 🔴 Funding Workflow / Commission Calculator
Right now "Funded" is just a status change. Need to build:
- Commission calculation engine: fee = $0.75 per $1,000/day from funding date to closing date + 10 business days
- Clear breakdown visible to admin before clicking "Fund": agent receives X, fee is Y, brokerage referral is Z
- Payment disbursement tracking (even if manual initially — mark when EFT sent, confirmation)

### 4. 🔴 Portfolio / Collections Dashboard
Track outstanding advances, aging (days since funding), upcoming closings, and deals at risk. Admin needs a bird's-eye view of capital deployed and expected returns.

### 5. 🟡 White-Label Branding
Brokerage-specific branding on the agent-facing experience. Each brokerage partner should be able to show their logo/colors. This is the key differentiator of the business model.

### 6. 🟡 Late Closing Interest — Needs Rethinking
Bud has been putting this off since Session 11. He said "I need to do some more thinking on this part." **ASK BUD what he's decided before touching this.**

### 7. 🟡 Agent-Side Improvements
- Agent returned docs section design could be improved
- Consider removing redundant Deal Timeline section

### 8. ⚫ NOT DOING: PPSA Registration Tracking
Bud explicitly decided against this.

### 9. ⏳ Business Prerequisites (In Progress, Not Blocking Dev)
- Legal contracts review by lawyer (CPA, IDP, BCA)
- FINTRAC registration (4-6 week processing time)
- Banking with EFT capability
- DocuSign production account (currently using sandbox)

---

## DocuSign Integration — Technical Reference

### Architecture
```
Admin clicks "Send for E-Signature" on deal page
  → sendForESignature() server action
    → generates CPA + IDP .docx files via lib/contract-docx.ts
    → creates DocuSign envelope with both documents
    → sends to agent's email for signing
    → stores envelope records in esignature_envelopes table

Agent signs in DocuSign
  → DocuSign Connect fires webhook POST to /api/docusign/webhook
    → webhook downloads signed PDFs from DocuSign API
    → uploads to Supabase storage (deal-documents bucket)
    → creates deal_documents records
    → links to underwriting checklist items
    → auto-checks "Commission Purchase Agreement" and "Irrevocable Direction to Pay"

Admin sees checklist items checked + signed PDFs attached
  → can now proceed to Fund the deal
```

### Key Gotchas
- **DocuSign anchor strings** (`/sig1/`, `/ini1/`, `/dat1/`) must be in the rendered PDF text. Put them in footers for per-page placement. Use white color + 2pt font to hide them.
- **DocuSign sandbox** doesn't deliver emails to external addresses. Use "Correct" feature to change signer email.
- **`checked_by` column is UUID** — never pass a plain string. Use `null` for system-initiated checks.
- **Auth middleware** must exclude webhook routes — DocuSign POSTs without auth cookies.
- **Always return 200** from webhook — DocuSign retries on non-200 responses.
- **Document IDs in envelope**: CPA = docId `1`, IDP = docId `2`. These correspond to the order documents are added to the envelope in `sendForESignature()`.

### Environment Variables (Netlify)
- `DOCUSIGN_INTEGRATION_KEY` — OAuth app client ID
- `DOCUSIGN_USER_ID` — The impersonated user's GUID
- `DOCUSIGN_ACCOUNT_ID` — DocuSign account ID
- `DOCUSIGN_RSA_PRIVATE_KEY` — RSA private key for JWT Grant (newlines as `\n`)
- `DOCUSIGN_BASE_URL` — `https://demo.docusign.net` (sandbox) or `https://www.docusign.net` (production)
- `DOCUSIGN_API_BASE_URL` — `https://demo.docusign.net/restapi` (sandbox) or `https://na4.docusign.net/restapi` (production)

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

**Firm Fund Documents (required for FUNDING, not approval):**
11. Commission Purchase Agreement - Signed and Executed — *auto-checked when signed doc received via DocuSign webhook*
12. Irrevocable Direction to Pay - Signed and Executed — *auto-checked when signed doc received via DocuSign webhook*

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
- **DocuSign webhook auth** — `/api/docusign/webhook` MUST be in middleware's public route exclusion list. DocuSign POSTs without cookies.
- **DocuSign `checked_by` field** — underwriting_checklist.checked_by is UUID-typed. Passing string `'system'` causes silent update failure. Use `null` for system-initiated checks.
- **Brokerage split percentage** — `brokerage_split_pct` stores whole number (5 = 5%), NOT decimal (0.05). Do NOT multiply by 100.
- **Word HeadingLevel blue theme** — `HeadingLevel.HEADING_2` in the `docx` npm package applies Word's default blue theme color. For black-only documents, use manual bold TextRun styling with explicit `color: '000000'` instead.
