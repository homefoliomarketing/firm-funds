# Firm Funds — Developer Handoff Document

**Last Updated:** April 4, 2026 (Session 6)
**Owner:** Bud (homefoliomarketing@gmail.com)
**Project:** Firm Funds Inc. (firmfunds.ca) — Commission Advance Platform for Ontario Real Estate Agents
**Repo:** GitHub (`github.com/homefoliomarketing/firm-funds`) → deployed via Netlify (every push to `main` auto-deploys to production, NO staging environment)

---

## About Bud (The User)

Bud is the **non-developer owner** of this company. He interacts via Cowork/Claude sessions. He:
- Runs SQL migrations manually in the **Supabase SQL Editor** (you give him the SQL, he pastes and runs it)
- Pushes code via **PowerShell** on Windows at `C:\Users\randi\Dev\firm-funds` (you give him git commands, he runs them)
- Tests features directly on the **live production site** (firmfunds.ca)
- Prefers casual, bro-like conversation — swearing is fine, sarcasm appreciated, but always do your best work
- Needs **exact copy-paste commands** — he can't write code himself
- **PowerShell gotcha:** Paths with parentheses like `app/(dashboard)/...` must be wrapped in double quotes or PowerShell interprets them as expressions
- **PowerShell uses semicolons (`;`), not `&&`** for chaining commands

---

## Tech Stack

| Layer | Tech | Notes |
|-------|------|-------|
| Framework | **Next.js 16.2.1** (Turbopack) | BREAKING CHANGES from older Next.js — read `node_modules/next/dist/docs/` before writing code. Middleware is deprecated in favor of "proxy" but still works. `params` in dynamic routes are Promises. |
| Frontend | **React 19.2.4** | Client components with `'use client'` directive |
| Database | **Supabase PostgreSQL** | With Row Level Security (RLS) — THE #1 source of bugs |
| Auth | **Supabase Auth** | JWT-based, role-based access (super_admin, firm_funds_admin, brokerage_admin, agent) |
| Storage | **Supabase Storage** | Buckets: `deal-documents`, `agent-kyc` |
| Email | **Resend** | Branded HTML emails |
| Hosting | **Netlify** | Auto-deploy on push to main. Serverless functions have significant limitations (see below). |
| Styling | **Tailwind CSS + inline styles** | Dark mode permanently locked via `useTheme()` hook |
| PDF Rendering | **pdf.js 3.11.174** (CDN) | UMD build from cdnjs.cloudflare.com, renders to canvas elements |

---

## CRITICAL PATTERNS — Read These First

### 1. RLS & Service Role Client (THE #1 Bug Source)

The regular Supabase client (created from cookies/anon key) is subject to RLS policies. Agent-level clients typically can't UPDATE/SELECT on the `agents` table or other admin tables.

**Rule:** Any server-side mutation on `agents`, `user_profiles`, `deals` (admin context), or storage operations MUST use `createServiceRoleClient()` from `@/lib/supabase/server`. This client bypasses RLS entirely.

```typescript
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'

// For reading with user's permissions:
const supabase = await createClient()

// For admin mutations (bypasses RLS):
const serviceClient = createServiceRoleClient()
```

### 2. NEVER Send File Payloads Through Netlify

**This is the most painful lesson from multiple debugging sessions.** Netlify's serverless functions have strict limitations:

- **Server Actions with file uploads HANG** — the request never completes
- **API routes with multipart FormData HANG** — same issue
- **Only small JSON request/response API routes work reliably**

**The working pattern for file uploads:**
1. Client requests **signed upload URLs** from a lightweight JSON API route
2. Client uploads files **directly to Supabase Storage** using the signed URLs (bypasses Netlify entirely)
3. Client calls another lightweight JSON API route to **update DB records**

This pattern is used in both the mobile KYC upload (`/api/kyc-mobile-upload`) and should be used for ANY future file upload feature.

### 3. Client-Side Supabase = Most Reliable

The browser Supabase client (`createClient()` from `@/lib/supabase/client`) talks **directly to Supabase**, completely bypassing Netlify. For auth operations, storage operations, and simple reads, this is the most reliable approach.

### 4. Content Security Policy (CSP)

The CSP in `next.config.ts` controls what external resources can load. If you add any external script, font, image source, or API endpoint, you MUST update the CSP or it will be silently blocked with no visible error.

Current CSP allows (hardened in Session 5):
- Scripts: `'self' 'unsafe-inline' https://cdnjs.cloudflare.com` (unsafe-eval REMOVED)
- Styles: `'self' 'unsafe-inline'`
- Images: `'self' data: blob: https://*.supabase.co`
- Fonts: `'self' https://fonts.gstatic.com`
- Connect: `'self' https://*.supabase.co wss://*.supabase.co`
- Workers: `'self' blob: https://cdnjs.cloudflare.com`
- Object: `'none'` (added Session 5)
- Also: `upgrade-insecure-requests` (added Session 5)

### 5. Theme System

Dark mode is permanently locked. All colors come from `useTheme()`:

```typescript
const { colors, isDark } = useTheme()
```

**Important:** The variable named `gold` is actually **green** (`#5FA873`). This is the brand accent color. There is NO `colors.accent` property — use `colors.gold`.

Key color properties: `pageBg`, `cardBg`, `textPrimary`, `textSecondary`, `textMuted`, `gold`, `goldBg`, `goldDark`, `border`, `inputBg`, `inputBorder`, `inputText`, `errorBg`, `errorBorder`, `errorText`, `successBg`, `successBorder`, `successText`, `shadowColor`, `overlayBg`

---

## Project Structure

```
app/
├── (auth)/
│   ├── login/page.tsx              # Login page (+ login success/failure audit logging)
│   └── change-password/page.tsx    # Force password change (first login) — FULLY CLIENT-SIDE
├── (dashboard)/
│   ├── admin/
│   │   ├── page.tsx                # Admin dashboard (3 KPI cards, quick links, deals table)
│   │   ├── audit/page.tsx          # Audit explorer — search, filter, paginate, export (Session 6)
│   │   ├── brokerages/page.tsx     # Brokerage & agent management (HUGE file ~1800+ lines)
│   │   ├── deals/[id]/page.tsx     # Deal detail + underwriting checklist + doc viewer + audit trail
│   │   └── reports/page.tsx        # Reports
│   ├── agent/
│   │   ├── page.tsx                # Agent dashboard
│   │   ├── new-deal/page.tsx       # Submit new deal
│   │   └── deals/[id]/page.tsx     # Agent deal detail
│   └── brokerage/page.tsx          # Brokerage admin dashboard
├── api/
│   ├── audit/export/route.ts       # Audit log CSV/JSON export (auth + CSRF protected) (Session 6)
│   ├── clear-reset-flag/route.ts   # Clears must_reset_password DB flag (fire-and-forget)
│   ├── kyc-mobile-upload/route.ts  # Mobile KYC: POST=get signed URLs, PUT=finalize DB
│   ├── kyc-validate-token/route.ts # Validate KYC upload tokens
│   ├── cron/closing-date-alerts/   # Scheduled cron job
│   ├── reports/referral-fees/      # Report generation
│   └── seed/                       # DB seed (dev only)
├── kyc-upload/[token]/page.tsx     # Public mobile KYC upload (token-based, no auth)
├── layout.tsx
├── page.tsx                        # Root redirect
└── globals.css

components/
├── AgentKycGate.tsx                # KYC upload + mobile link + 5s polling for status
├── AuditTimeline.tsx               # Visual audit timeline with severity dots, diffs (Session 6)
├── SessionTimeout.tsx
└── SignOutModal.tsx                 # (+ logout audit logging, Session 6)

lib/
├── actions/
│   ├── admin-actions.ts            # All admin CRUD + EFT/payment audit logging (Session 6)
│   ├── audit-actions.ts            # Audit log queries: timeline, global search, export (Session 6)
│   ├── deal-actions.ts             # Deal CRUD + checklist/status/edit audit with diffs (Session 6)
│   ├── kyc-actions.ts              # KYC submit, verify, reject, mobile token, document URLs
│   └── report-actions.ts           # Reporting queries
├── supabase/
│   ├── client.ts                   # Browser client (sync, createBrowserClient)
│   └── server.ts                   # Server client (async, uses cookies) + service role client (sync)
├── audit.ts                        # Audit logging (server actions): logAuditEvent, diffValues (Session 6 rewrite)
├── audit-labels.ts                 # Client-safe audit labels/types — NO 'use server' (Session 6)
├── auth-helpers.ts                 # Shared getAuthenticatedAdmin() + getAuthenticatedUser()
├── calculations.ts                 # Deal financial calculations (server-side ONLY)
├── constants.ts                    # Status badges, KYC types, upload limits
├── csrf.ts                         # CSRF origin validation utility (Session 5)
├── email.ts                        # All Resend email templates
├── file-validation.ts              # Magic byte file content verification (Session 5)
├── formatting.ts                   # Shared formatCurrency, formatCurrencyWhole, formatDate, formatDateTime
├── theme.tsx                       # Theme context + color definitions
└── validations.ts                  # Zod schemas (expanded Session 5: admin action schemas)

middleware.ts                       # Auth, role-based routing, force password change
                                    # Excludes: /login, /auth, /kyc-upload, /api/kyc-*
                                    # Fixed: signs out users with missing profiles (prevents redirect loop)
```

---

## Database Schema (Key Tables)

### agents
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| brokerage_id | uuid | FK → brokerages |
| first_name, last_name, email | text | email has partial unique index (excludes archived) |
| phone, reco_number | text | Optional |
| status | text | active, inactive, suspended, archived (CHECK constraint) |
| kyc_status | text | not_submitted, submitted, verified, rejected |
| kyc_document_path | text | JSON array of storage paths (multi-file) |
| kyc_document_type | text | drivers_license, passport, etc. |
| kyc_submitted_at, kyc_verified_at | timestamp | |
| kyc_rejection_reason | text | |
| flagged_by_brokerage | boolean | |
| outstanding_recovery | numeric | |

### user_profiles
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, matches auth.users.id |
| email | text | |
| role | text | super_admin, firm_funds_admin, brokerage_admin, agent |
| full_name | text | |
| agent_id | uuid | FK → agents (null for non-agents) |
| brokerage_id | uuid | FK → brokerages |
| is_active | boolean | |
| must_reset_password | boolean | Set true on invite, cleared after password change |

### deals
Has: agent_id, brokerage_id, property_address, status (draft, submitted, under_review, approved, funded, completed, denied, cancelled), advance_amount, closing_date, commission amounts, discount fee, etc.

### deal_documents
Has: deal_id, file_name, file_path, file_size, document_type, uploaded_by, upload_source

### underwriting_checklist_items
Has: deal_id, label, checked, category (Agent Verification, Deal Document Review, Financial Verification, Compliance & Risk)

### kyc_upload_tokens
Has: token (32 hex bytes), agent_id, expires_at (30 min), used_at (single-use)

### audit_log (Enhanced Session 6)
Has: action, entity_type, entity_id, user_id, metadata (JSONB), created_at, severity (info/warning/critical), actor_email, actor_role, old_value (JSONB), new_value (JSONB), user_agent, session_id
- INSERT-only (DB triggers prevent UPDATE/DELETE even via service_role)
- RLS: authenticated can INSERT, admins can SELECT
- 7 indexes including composite, partial (severity='critical'), and GIN (metadata)
- 50+ action types mapped in `lib/audit-labels.ts`

---

## Completed Work (All Sessions Combined)

### Session 1-2: Core Platform
- Admin dashboard (KPI cards, deal list, pagination, time range filter)
- Admin deal detail (underwriting checklist, doc viewer, EFT tracking, admin notes, forward + backward status transitions with amber warning modal)
- Brokerage management (CRUD, expandable rows, bulk agent import from Excel/CSV)
- Reports dashboard with PDF export
- Agent portal (deal submission with live financial preview, deal editing, doc uploads, cancel)
- Brokerage portal (agent list, deal activity, referral fees)
- Full auth with role-based routing + RLS
- Email notifications via Resend (new deal → admin, status change → agent, doc uploaded → admin)
- Sign out confirmation modal, session timeout, audit logging
- Brokerage payments redesign (multiple payments tracked, "Mark as Repaid" gated by payment match)
- Admin notes timeline (timestamped append-only)
- Closing date inline edit with server-side recalc
- Agent cancel/withdraw from dashboard
- Underwriting checklist cleanup (11 clean items) + UI redesign
- File upload crash fix (25MB limit)
- Dark mode date picker fix
- Closing date cron alerts API route
- Agent archive (soft delete: status='archived', auth user deleted, login deactivated)
- Email reuse after archiving (partial unique index, app-level `.neq('status', 'archived')`)
- Resend welcome email button (new temp password, resets must_reset_password flag)
- Agent invite with email notification
- Bulk agent import from spreadsheet

### Session 3: Critical Bug Fixes (April 3, 2026)

#### Password Change Page — FIXED ✅
**Problem:** Page hung on submit. Server actions hung on Netlify. API routes also hung.
**Solution:** Fully client-side flow:
1. `supabase.auth.updateUser({ password, data: { password_changed: true } })` — direct to Supabase
2. `supabase.auth.refreshSession()` — forces JWT cookie update
3. Fire-and-forget `fetch('/api/clear-reset-flag')` — clears DB flag via service role
4. `window.location.href = redirectPath` — hard redirect (not `router.push()`)
**Files:** `app/(auth)/change-password/page.tsx`, `app/api/clear-reset-flag/route.ts`

#### Document Viewer PDF Rendering — FIXED ✅
**Problem:** PDFs showed blank in `<object>`, `<iframe>`, and `<embed>` tags. Root cause: CSP was blocking external scripts AND blob URLs in embedded contexts.
**Solution:**
- pdf.js 3.11.174 (UMD build) loaded from cdnjs.cloudflare.com via `<script>` tag
- Renders PDF pages to `<canvas>` elements (no browser PDF plugin dependency)
- CSP updated: added `https://cdnjs.cloudflare.com` to `script-src` and `worker-src`
- `PdfCanvasViewer` component with zoom controls
**Files:** `app/(dashboard)/admin/deals/[id]/page.tsx`, `next.config.ts`

#### Mobile KYC Upload — FIXED ✅
**Problem:** Upload hung because Netlify can't handle multipart FormData in serverless functions.
**Solution:** Three-step flow bypassing Netlify for file transfer:
1. POST `/api/kyc-mobile-upload` (tiny JSON) → get signed upload URLs
2. PUT files directly to Supabase Storage signed URLs (bypasses Netlify)
3. PUT `/api/kyc-mobile-upload` (tiny JSON) → update DB records
**Files:** `app/kyc-upload/[token]/page.tsx`, `app/api/kyc-mobile-upload/route.ts`, `app/api/kyc-validate-token/route.ts`

#### Desktop Auto-Refresh After Mobile KYC Upload — FIXED ✅
**Problem:** After agent uploads ID on phone, the desktop page didn't update.
**Solution:** 5-second polling interval in `AgentKycGate.tsx` checking `kyc_status` on `agents` table. Triggers `onKycSubmitted()` callback when status changes to 'submitted'.
**Files:** `components/AgentKycGate.tsx`

#### Document Viewer Zoom Controls — ADDED ✅
**Solution:**
- `PdfCanvasViewer`: zoom levels [0.75, 1, 1.25, 1.5, 2, 2.5, 3], re-renders canvases at each scale
- `ImageZoomViewer`: zoom levels [1, 1.5, 2, 2.5, 3], CSS width scaling
- Both have toolbar with −/percentage/+ buttons and page count
**Files:** `app/(dashboard)/admin/deals/[id]/page.tsx`

#### Middleware Updated for Public KYC API Routes ✅
Added `/api/kyc-*` to auth exclusion list so unauthenticated mobile uploads work.
**Files:** `middleware.ts`

#### Client-Side Signed URLs for Documents ✅
Replaced server action `getDocumentSignedUrl` with client-side `supabase.storage.createSignedUrl()` in both admin and agent deal detail pages.
**Files:** `app/(dashboard)/admin/deals/[id]/page.tsx`, `app/(dashboard)/agent/deals/[id]/page.tsx`

### Session 4: Codebase Audit & Cleanup (April 3, 2026)

#### Dead File Removal ✅
Deleted 8 files (~1,266 lines) that were confirmed dead/orphaned:
- `_ready-to-place/` directory (3 orphaned draft files — old versions of active pages)
- `app/(dashboard)/admin/agents/page.tsx` (empty stub, agent management lives in brokerages page)
- `app/api/change-password/route.ts` (unused backup — password change is client-side)
- `app/api/documents/signed-url/route.ts` (superseded by client-side `createSignedUrl()`)
- `lib/actions/auth-actions.ts` (entire file unused — password change is client-side)
- `components/ThemeToggle.tsx` (rendered `null`, never imported)

#### Shared Formatting Utilities ✅
Created `lib/formatting.ts` with `formatCurrency`, `formatCurrencyWhole`, `formatDate`, `formatDateTime`.
Replaced 7+ duplicate inline definitions across all dashboard pages and API routes.
**Files:** `lib/formatting.ts` (new), all page files updated to import from it

#### Shared Auth Helpers ✅
Created `lib/auth-helpers.ts` with `getAuthenticatedAdmin()` and `getAuthenticatedUser()`.
Replaced 3 identical copies (~100 lines of duplicated auth boilerplate) across action files.
**Files:** `lib/auth-helpers.ts` (new), `admin-actions.ts`, `kyc-actions.ts`, `report-actions.ts`, `deal-actions.ts` updated

#### Unused Export Cleanup ✅
- Removed `export` from `validateDealInputs()` in `calculations.ts` (still used internally, just not exported)
- Removed unused `DocumentUploadSchema` and `DocumentUpload` type from `validations.ts`
- Cleaned up unused constant imports in `validations.ts`

### Session 5: Security Hardening & Viewer UX (April 3, 2026)

Full security audit performed — `SECURITY-AUDIT.md` in project root documents all 24 findings.
19 of 24 findings fixed in code + 1 SQL migration. Remaining 5 need infrastructure or config changes.

#### Security Fixes Implemented ✅

**CRITICAL:**
- **C1 — Seed route lockdown:** Replaced hardcoded `SEED_KEY` with `process.env.SEED_SECRET`. Added `guardProduction()` check on GET + DELETE handlers — route is blocked in production unless `ENABLE_SEED` env var is set.
- **C2 — Cron auth fail-closed:** If `CRON_SECRET` env var isn't set, route now returns 500 instead of allowing unauthenticated access.
- **C4 — Password complexity:** Upgraded from 8-char minimum to 12 chars + uppercase + lowercase + number + special character. Placeholder updated.
- **C6 — KYC agentId trust removed:** Server now derives `agentId` from the token record, never from client request body. Client-side upload page updated to stop sending it.

**HIGH:**
- **H1 — CSP hardened:** Removed `unsafe-eval`, added `object-src 'none'` and `upgrade-insecure-requests`.
- **H2 — CSRF origin validation:** Created `lib/csrf.ts`. Applied to `clear-reset-flag` route. KYC routes use tokens (not cookies) so CSRF N/A.
- **H3 — Token error normalization:** All KYC token validation failures now return identical "Invalid or expired link" — prevents token enumeration.
- **H5 — Document access authorization:** `getDocumentSignedUrl` now verifies agents own the deal and brokerage admins belong to the correct brokerage before generating signed URLs.
- **H6 — Zod validation on admin actions:** Created schemas in `lib/validations.ts` for create/update brokerage, create/update agent, create user account. All text fields sanitized (HTML stripped), email/phone/UUID validated. Applied in `admin-actions.ts`.
- **H7 — Magic byte file verification:** Created `lib/file-validation.ts`. Checks file header bytes match declared MIME type (PDF, JPEG, PNG, GIF, WebP, HEIC). Applied in `uploadDocument` in `deal-actions.ts`.
- **H8 — Audit log immutability:** SQL migration `migrations/004_audit_log_immutable.sql` — RLS set to INSERT-only for authenticated, SELECT-only for admins, database triggers prevent UPDATE/DELETE even via service_role.

**MEDIUM:**
- **M1 — Password change audit logging:** `clear-reset-flag` route now writes `user.password_changed` event to `audit_log`.
- **M3 — Race condition fix:** Password change page now `await`s the `clear-reset-flag` API call instead of fire-and-forget.

**LOW:**
- **L1 — Referrer-Policy:** Changed to `no-referrer` (was `strict-origin-when-cross-origin`).
- **L2 — X-XSS-Protection:** Removed obsolete header entirely.

**Files changed:** `app/api/seed/route.ts`, `app/api/cron/closing-date-alerts/route.ts`, `app/(auth)/change-password/page.tsx`, `app/api/clear-reset-flag/route.ts`, `app/api/kyc-mobile-upload/route.ts`, `app/api/kyc-validate-token/route.ts`, `app/kyc-upload/[token]/page.tsx`, `lib/actions/admin-actions.ts`, `lib/actions/deal-actions.ts`, `lib/validations.ts`, `next.config.ts`
**Files created:** `lib/csrf.ts`, `lib/file-validation.ts`, `migrations/004_audit_log_immutable.sql`, `SECURITY-AUDIT.md`

#### Security Items Deferred to Launch ⏳
- **C3/H4 — Rate limiting:** Needs infrastructure (Upstash Redis or similar rate-limit store)
- **C5 — Temp passwords in email:** Architecture change to magic links. `must_reset_password` flow provides interim protection.
- **M2 — Server-side session timeout:** Needs DB `last_active_at` tracking
- **M5 — Pin dependency versions:** Config change, low risk
- **M6 — Verify KYC storage encryption:** Supabase dashboard check
- **MFA:** Bud plans to add multi-factor auth at launch

#### PDF/Image Viewer — Drag to Pan ✅
Added click-and-drag panning on both PDF and image viewers when zoomed in.
- `useDragToPan` hook: tracks mouse down/move/up, scrolls container proportionally
- Cursor changes to grab hand when zoomed past default, grabbing while dragging
- `draggable={false}` on images to prevent browser native image drag conflict
**Files:** `app/(dashboard)/admin/deals/[id]/page.tsx`

#### PDF/Image Viewer — Zoom Fix ✅ (carried from Session 4)
**Problem:** Zoom buttons changed the percentage display but didn't change actual visual size. Then it jumped to one huge zoom with no in-between.
**Solution (PDF):** Always render at 2x resolution for crispness, control visual size via CSS `width` percentage proportional to zoom level. No more re-rendering canvases at different scales.
**Solution (Image):** Removed flex container that was absorbing width increases. Used block layout with `maxWidth: 'none'`.
**Files:** `app/(dashboard)/admin/deals/[id]/page.tsx`

### Session 6: Audit Trail System + Dashboard Cleanup (April 4, 2026)

#### Full Audit Trail & Event Ledger System ✅
Built a comprehensive audit trail with enhanced schema, backend logging, query/export APIs, deal-level timeline UI, and global audit explorer page.

**Schema Enhancement (migration `005_audit_log_enhanced.sql`):**
- Added 7 columns to audit_log: severity, actor_email, actor_role, old_value, new_value, user_agent, session_id
- CHECK constraint on severity ('info', 'warning', 'critical')
- 7 new indexes including composite, partial (severity='critical'), GIN (metadata)
- Recreated SELECT RLS policy

**Backend (`lib/audit.ts` rewrite + `lib/audit-labels.ts` new):**
- `audit.ts` is `'use server'` — ONLY async function exports (Next.js 16 Turbopack requirement)
- Contains: logAuditEvent(), logAuditEventServiceRole(), extractRequestContext(), diffValues()
- Now populates severity, actor_email, actor_role, old_value, new_value from user profile
- `audit-labels.ts` is client-safe (NO `'use server'`) — contains ACTION_LABELS map (50+ action→label mappings), getActionLabel(), AuditSeverity type
- **Critical pattern:** client components import from `audit-labels.ts`, server actions import from `audit.ts`. Mixing this up causes Turbopack build failures.

**Query & Export APIs (`lib/actions/audit-actions.ts` + `app/api/audit/export/route.ts`):**
- getEntityAuditTimeline() — fetches deal + related document audit events
- queryAuditLogs() — paginated, filterable global query with parallel count+data
- exportAuditLogs() — up to 10,000 records
- getDistinctAuditActions(), getDistinctEntityTypes() — for filter dropdowns
- Export route supports CSV and JSON with auth + CSRF validation

**Deal-Level Timeline (`components/AuditTimeline.tsx`):**
- Visual timeline with severity-colored dots (green=info, amber=warning, red=critical)
- Action-specific icons, expandable entries showing metadata
- Old→new value diffs with strikethrough/green styling
- "Show All X Events" toggle when >10 events
- Integrated into deal detail page as collapsible "Audit Trail" section

**Global Audit Explorer (`app/(dashboard)/admin/audit/page.tsx`):**
- Full admin page at /admin/audit with search bar, 6 filter types
- Collapsible filter panel, paginated table (50/page), expandable row details
- CSV and JSON export buttons, entity click-through to deal detail

**Instrumented Audit Events:**
- Login success/failure (login page)
- Logout (SignOutModal)
- Checklist toggle with old/new values (deal-actions)
- Deal edit with field-level diffs (deal-actions)
- Deal status change with old/new (deal-actions)
- Closing date update with old/new + fee recalc (deal-actions)
- EFT confirm/remove (admin-actions, severity: critical)
- Brokerage payment remove (admin-actions, severity: critical)
- Document view/download (deal detail page, fire-and-forget)

**Files created:** `lib/audit-labels.ts`, `lib/actions/audit-actions.ts`, `components/AuditTimeline.tsx`, `app/(dashboard)/admin/audit/page.tsx`, `app/api/audit/export/route.ts`, `migrations/005_audit_log_enhanced.sql`
**Files modified:** `lib/audit.ts`, `lib/actions/deal-actions.ts`, `lib/actions/admin-actions.ts`, `app/(dashboard)/admin/deals/[id]/page.tsx`, `app/(dashboard)/admin/page.tsx`, `app/(auth)/login/page.tsx`, `components/SignOutModal.tsx`

#### Middleware Redirect Loop Fix ✅
**Problem:** After data wipe, users with auth sessions but no user_profiles row caused infinite redirect loop: `/login` → `/agent` → `/login`.
**Solution:** Updated middleware to call `supabase.auth.signOut()` and stay on login page when profile is missing (instead of redirecting to role-based route).
**Files:** `middleware.ts`

#### Test Data Wipe ✅
Wiped all test data (brokerages, agents, deals, documents, audit logs) while preserving Bud and James admin accounts.
- Must DROP audit immutability triggers before DELETE, then recreate them
- Individual SQL statements (NOT `DO $` blocks — Supabase rolls back entire block if any statement fails)
- Storage buckets must be emptied via Supabase Dashboard (direct DELETE from storage.objects blocked)

#### Admin Dashboard Cleanup ✅
- Removed "Registered Agents" KPI tile (redundantly linked to brokerages page)
- Removed "Manage Brokerages" quick link button (Partner Brokerages card already links there)
- Changed KPI grid from 4-column to 3-column layout (Total Deals, Total Advanced, Partner Brokerages)
- Removed unused `totalAgents` query (one fewer DB call per page load)
- Quick links trimmed to just Reports and Audit Trail
**Files:** `app/(dashboard)/admin/page.tsx`

---

## Server Actions Still in Use (Potential Hang Risk)

These server actions are still called from the codebase. Most work fine for small JSON payloads, but any that handle file uploads could hang on Netlify:

| File | Functions | Risk |
|------|-----------|------|
| `admin-actions.ts` | Agent CRUD, brokerage CRUD, archive, invite, resend welcome | Low (JSON only) |
| `deal-actions.ts` | Deal CRUD, status changes, checklist, document metadata | Low (JSON only) |
| `kyc-actions.ts` | `submitAgentKyc` (DESKTOP upload), verify, reject, mobile token | **HIGH for submitAgentKyc** — sends files through Netlify |
| `report-actions.ts` | Report queries | Low (JSON only) |

**⚠️ `submitAgentKyc` in `kyc-actions.ts` is still used for DESKTOP KYC uploads via `AgentKycGate.tsx`.** This could hang just like the mobile upload did. It should be converted to the same signed-upload-URL pattern.

---

## Known Issues / Needs Attention

### 1. Desktop KYC Upload May Hang — MEDIUM PRIORITY
`AgentKycGate.tsx` still uses the `submitAgentKyc` server action for desktop uploads, which sends files through Netlify. This is the same pattern that caused mobile uploads to hang. Should be converted to signed upload URLs.

### 2. `.claude/worktrees` Git Corruption — RECURRING
A `.claude/worktrees` submodule reference sometimes gets staged. Fix: `git reset HEAD .claude` on Bud's machine before committing.

### 3. Rate Limiting Not Yet Implemented — LAUNCH BLOCKER
Login, API routes, and password change have no rate limiting. Needs Upstash Redis or similar infrastructure. See SECURITY-AUDIT.md items C3/H4.

### 4. Dead Code — CLEANED UP ✅ (Session 4)
All dead code identified in Sessions 1-3 has been removed.

### 5. Security Audit — MOSTLY COMPLETE ✅ (Session 5)
19 of 24 findings fixed. See `SECURITY-AUDIT.md` for full details. Remaining items need infrastructure changes (rate limiting, magic links, session timeout).

---

## Planned / Future Work (Priority Order)

1. **Rate limiting (C3/H4)** — needs Upstash Redis or Netlify rate limit config. Login, password change, and API routes are unprotected.
2. **Multi-factor authentication** — Bud plans to add at launch. Supabase Auth supports TOTP.
3. **E-signature integration** (DocuSign/HelloSign) — needs account + API key. Required for agents to sign commission purchase agreements digitally.
4. **Nexone integration** — see detailed notes below
5. **Convert desktop KYC upload to signed URL pattern** — prevent potential Netlify hang
6. **Document request UI** — admin button to request specific documents from agents (email function `sendDocumentRequestNotification()` exists, no UI yet)
7. **Magic link invites (C5)** — replace temp passwords in emails with secure magic links
8. **FINTRAC compliance reporting/documentation** — needs legal guidance
9. **Brokerage payment tracking completion** — migration 010 exists, UI may be incomplete
10. **Agent deal history and commission tracking improvements**
11. **Additional admin reporting features**
12. **Mobile-responsive optimization**
13. **Set up external scheduler** for daily closing date alerts (CRON_SECRET env var is configured)
14. **Professional penetration test** — recommended before handling real financial data

### Nexone Integration — Strategic Priority

Nexone is a trade record management platform used by some Ontario real estate brokerages. Agents use Nexone to complete trade records, fill out commission details, and submit deal documents to their office admin. Integrating with Nexone would create a seamless pipeline where agents can request commission advances directly from within their existing workflow.

**Desired User Flow:**
1. Agent completes their trade record in Nexone (fills commissions, uploads documents)
2. Agent sees a "Get Paid Tomorrow with Firm Funds" button in the commission calculator section
3. Agent clicks the button → redirected to Firm Funds login (or already logged in)
4. After authentication, Firm Funds pulls trade data + documents from Nexone automatically
5. Deal is created in Firm Funds with docs attached, brokerage admin notified, pipeline begins
6. Agent sees two options: receive $X tomorrow (minus brokerage split) or wait for full amount at closing

**The login/auth step is critical** — it confirms agent identity AND acts as explicit consent to transfer their data.

**Integration Paths (in order of preference):**

- **Path 1 — Nexone API (gold standard):** If Nexone exposes a REST/OAuth API, Firm Funds authenticates the agent, then calls back to Nexone to pull the trade record + documents. Brokerage authorizes the connection at the account level, agents authorize per-deal via login. Standard integration pattern.

- **Path 2 — Nexone partner/embed program:** Many SaaS platforms offer partner integrations or iframe embeds. Approach Nexone as a technology partner — their brokerage clients get a new revenue feature, agents get faster pay. Similar to "Buy Now Pay Later" buttons embedded in other platforms.

- **Path 3 — Webhook + brokerage bridge:** Even without a full API, most platforms support webhooks or email notifications. Brokerage sets up automated export from Nexone. Firm Funds watches that feed and matches incoming trade records to agent accounts. The "button" in Nexone is a branded link the brokerage adds to their workspace.

- **Fully manual flow is NOT acceptable** — Bud has stated the integration must be seamless regardless of what Nexone offers.

**First Step:** Reach out to Nexone directly. Ask about partner API, integration program, or webhook support. Frame as value-added service for their brokerage clients.

**Even if Nexone won't cooperate:** The brokerage can still bridge the gap by adding a branded link in their Nexone workspace → agent clicks → logs into Firm Funds → brokerage admin exports/forwards the trade file. From the agent's perspective it still feels like: click, login, done. The current Firm Funds system already handles everything after that point.

---

## Migration Status

| # | Description | Status |
|---|-------------|--------|
| 003-011 | Core schema, RLS, audit, storage, KYC, payments | Applied |
| 012 | Checklist categories | Applied |
| 013 | KYC upload tokens | Applied |
| 014 | Agent archived status constraint | Applied |
| 015 | must_reset_password column | Applied |
| — | Partial unique index on agents.email (excludes archived) | Applied manually |
| 004* | Audit log immutability (RLS + triggers, prevents UPDATE/DELETE) | Applied (Session 5) |
| 005* | Audit log enhanced (7 new columns, severity, diffs, indexes) | Applied (Session 6) |

*Note: `migrations/004_*` and `005_*` — numbering is in the `migrations/` directory (separate from `supabase/migrations/`).

**New migration workflow:** Write `.sql` in `supabase/migrations/`, give Bud the SQL to run in Supabase SQL Editor, then push the code.

---

## Environment

- **GitHub**: `github.com/homefoliomarketing/firm-funds`
- **Supabase project**: `bzijzmxhrpiwuhzhbiqc.supabase.co`
- **Production**: `firmfunds.ca` (Netlify)
- **Admin login**: `bud@firmfunds.ca` (super_admin)
- **Admin login**: James (super_admin) — second admin account
- **Test data**: Wiped clean in Session 6. No brokerages, agents, or deals. Fresh start.
- **Previous test agent**: `bud.jones@century21.ca` at Century 21 Choice Realty (deleted in wipe)

### Environment Variables (Netlify)
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `SEED_SECRET` — random string for seed route auth (added Session 5)
- `CRON_SECRET` — random string for cron job Bearer token auth (added Session 5)
- `ENABLE_SEED` — only set to `true` if you need to seed in production (leave absent to block)

---

## Key Patterns & Code Examples

### 1. Service role client for mutations
```typescript
const serviceClient = createServiceRoleClient()
await serviceClient.from('agents').update({...}).eq('id', agentId)
```

### 2. Client-side signed URLs (preferred for documents)
```typescript
const supabase = createClient() // from @/lib/supabase/client
const { data, error } = await supabase.storage
  .from('deal-documents')
  .createSignedUrl(filePath, 3600, { download: false })
```

### 3. PDF rendering with pdf.js (canvas approach)
```typescript
const PDFJS_VERSION = '3.11.174'
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`

function loadPdfJs(): Promise<any> {
  if ((window as any).pdfjsLib) return Promise.resolve((window as any).pdfjsLib)
  // Load UMD script, set workerSrc, return pdfjsLib
}
// Then: pdfjsLib.getDocument({ data: arrayBuffer }) → render pages to <canvas>
```

### 4. File upload via signed URLs (bypasses Netlify)
```typescript
// Step 1: Get signed URL from lightweight API route
const { data } = await fetch('/api/kyc-mobile-upload', {
  method: 'POST',
  body: JSON.stringify({ token, fileNames, documentType })
}).then(r => r.json())

// Step 2: Upload directly to Supabase Storage
await fetch(data.uploadUrls[0].signedUrl, {
  method: 'PUT',
  headers: { 'Content-Type': file.type },
  body: file,
})

// Step 3: Finalize in DB via lightweight API route
await fetch('/api/kyc-mobile-upload', {
  method: 'PUT',
  body: JSON.stringify({ token, filePaths, documentType, agentId })
})
```

### 5. Token pattern for public routes
32 random hex bytes, stored with agent_id + 30min expiry + used_at, validate on load, mark used after.

### 6. Multi-file storage
`JSON.stringify(filePaths)` in single text column. Always handle backward compat (string vs JSON array).

### 7. Password change (fully client-side)
```typescript
// Password policy: 12+ chars, uppercase, lowercase, number, special char
await supabase.auth.updateUser({ password: newPassword, data: { password_changed: true } })
await supabase.auth.refreshSession()
await fetch('/api/clear-reset-flag', { method: 'POST' }) // awaited (writes audit log)
window.location.href = redirectPath
```

---

## Git Workflow

1. You make code changes
2. Give Bud exact `git add` + `git commit` + `git push` commands
3. Bud runs them in PowerShell at `C:\Users\randi\Dev\firm-funds`
4. Netlify auto-deploys from main
5. Bud tests on production
6. If SQL migration needed: give SQL FIRST, then push code

```powershell
cd C:\Users\randi\Dev\firm-funds
git add -A
git commit -m "your message here"
git push origin main
```

---

## Key Rules Summary

1. **Always use `createServiceRoleClient()`** for server-side mutations
2. **NEVER send files through Netlify** — use signed upload URLs + direct Supabase Storage
3. **All colors from `useTheme()`** — dark mode locked, `colors.gold` = green (#5FA873)
4. **Business constants in `lib/constants.ts`** — never hardcode rates/limits
5. **Financial calculations server-side only** in `lib/calculations.ts` — dollars not cents
6. **Run `npx tsc --noEmit` before telling Bud to push** — zero errors or don't ship
7. **Every push auto-deploys** — no staging environment
8. **CSP in `next.config.ts`** — update when adding external resources (no unsafe-eval!)
9. **Next.js 16.2.1 breaking changes** — `params` are Promises, read docs first
10. **Email notifications go to bud@firmfunds.ca ONLY** — James has admin access but no emails
11. **Zod validate all user input** — admin actions use schemas from `lib/validations.ts`, strip HTML
12. **Never trust client-provided IDs** — always derive entity ownership server-side from auth/tokens
13. **Audit log is immutable** — INSERT-only, no UPDATE/DELETE even via service_role (DB triggers)
14. **CSRF protection on cookie-auth API routes** — use `validateOrigin()` from `lib/csrf.ts`
15. **Magic byte verification on file uploads** — use `verifyFileMagicBytes()` from `lib/file-validation.ts`
16. **`'use server'` files can ONLY export async functions** — no constants, no sync functions, no types. If client components need shared labels/types, put them in a separate file WITHOUT `'use server'`. See `audit.ts` vs `audit-labels.ts` split.
17. **Audit log diffs** — when editing deals or changing status, always capture old_value and new_value via `diffValues()` from `lib/audit.ts`
18. **Data wipe gotchas** — must DROP audit immutability triggers before DELETE; use individual SQL statements (not `DO $` blocks); storage buckets must be emptied via Supabase Dashboard
