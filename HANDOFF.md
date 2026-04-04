# Firm Funds — Developer Handoff Document

**Last Updated:** April 3, 2026 (Session 4)
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

Current CSP allows:
- Scripts: `'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com`
- Styles: `'self' 'unsafe-inline'`
- Images: `'self' data: blob: https://*.supabase.co`
- Fonts: `'self' https://fonts.gstatic.com`
- Connect: `'self' https://*.supabase.co wss://*.supabase.co`
- Workers: `'self' blob: https://cdnjs.cloudflare.com`

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
│   ├── login/page.tsx              # Login page
│   └── change-password/page.tsx    # Force password change (first login) — FULLY CLIENT-SIDE
├── (dashboard)/
│   ├── admin/
│   │   ├── page.tsx                # Admin dashboard
│   │   ├── brokerages/page.tsx     # Brokerage & agent management (HUGE file ~1800+ lines)
│   │   ├── deals/[id]/page.tsx     # Deal detail + underwriting checklist + doc viewer + PDF/Image zoom
│   │   └── reports/page.tsx        # Reports
│   ├── agent/
│   │   ├── page.tsx                # Agent dashboard
│   │   ├── new-deal/page.tsx       # Submit new deal
│   │   └── deals/[id]/page.tsx     # Agent deal detail
│   └── brokerage/page.tsx          # Brokerage admin dashboard
├── api/
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
├── SessionTimeout.tsx
└── SignOutModal.tsx

lib/
├── actions/
│   ├── admin-actions.ts            # All admin CRUD (agents, brokerages, archive, invite, resend welcome)
│   ├── deal-actions.ts             # Deal CRUD, document management, checklist
│   ├── kyc-actions.ts              # KYC submit, verify, reject, mobile token, document URLs
│   └── report-actions.ts           # Reporting queries
├── supabase/
│   ├── client.ts                   # Browser client (sync, createBrowserClient)
│   └── server.ts                   # Server client (async, uses cookies) + service role client (sync)
├── auth-helpers.ts                 # Shared getAuthenticatedAdmin() + getAuthenticatedUser() — used by all action files
├── calculations.ts                 # Deal financial calculations (server-side ONLY)
├── constants.ts                    # Status badges, KYC types, upload limits
├── email.ts                        # All Resend email templates
├── formatting.ts                   # Shared formatCurrency, formatCurrencyWhole, formatDate, formatDateTime
├── theme.tsx                       # Theme context + color definitions
├── audit.ts                        # Audit logging utilities
└── validations.ts                  # Zod schemas

middleware.ts                       # Auth, role-based routing, force password change
                                    # Excludes: /login, /auth, /kyc-upload, /api/kyc-*
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

### audit_log
Has: action, entity_type, entity_id, user_id, metadata (JSONB), created_at

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

### 3. Dead Code — CLEANED UP ✅ (Session 4)
All dead code identified in Sessions 1-3 has been removed. See Session 4 notes below.

---

## Planned / Future Work (Priority Order)

1. **Convert desktop KYC upload to signed URL pattern** — prevent potential Netlify hang
2. **Document request UI** — admin button to request specific documents from agents (email function `sendDocumentRequestNotification()` exists, no UI yet)
3. **FINTRAC compliance reporting/documentation** — needs legal guidance
4. **Brokerage payment tracking completion** — migration 010 exists, UI may be incomplete
5. **Agent deal history and commission tracking improvements**
6. **Additional admin reporting features**
7. **Mobile-responsive optimization**
9. **Set up CRON_SECRET env var** + external scheduler for daily closing date alerts
10. **E-signature integration** (DocuSign/HelloSign) — needs account + API key
11. **Nexone integration** — waiting on API response

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

**New migration workflow:** Write `.sql` in `supabase/migrations/`, give Bud the SQL to run in Supabase SQL Editor, then push the code.

---

## Environment

- **GitHub**: `github.com/homefoliomarketing/firm-funds`
- **Supabase project**: `bzijzmxhrpiwuhzhbiqc.supabase.co`
- **Production**: `firmfunds.ca` (Netlify)
- **Admin login**: `bud@firmfunds.ca` (super_admin)
- **Test agent**: `bud.jones@century21.ca` at Century 21 Choice Realty

### Environment Variables (Netlify)
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`

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
await supabase.auth.updateUser({ password: newPassword, data: { password_changed: true } })
await supabase.auth.refreshSession()
fetch('/api/clear-reset-flag', { method: 'POST' }).catch(() => {}) // fire-and-forget
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
8. **CSP in `next.config.ts`** — update when adding external resources
9. **Next.js 16.2.1 breaking changes** — `params` are Promises, read docs first
10. **Email notifications go to bud@firmfunds.ca ONLY** — James has admin access but no emails
