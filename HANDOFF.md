# Firm Funds — Session 8 Handoff Document

**Date:** April 4, 2026
**Owner:** Bud (homefoliomarketing@gmail.com)
**Repo:** `C:\Users\randi\Dev\firm-funds` (Windows/PowerShell)
**Live:** firmfunds.ca (Netlify auto-deploys from main)
**DB:** Supabase PostgreSQL with RLS

---

## Tech Stack & Critical Rules

- **Next.js 16.2.1 + Turbopack** — Breaking changes from training data. `params` in dynamic routes are Promises. `'use server'` files can ONLY export async functions. **Read `node_modules/next/dist/docs/` before writing any code.**
- **Supabase** — RLS is the #1 bug source. Use `createServiceRoleClient()` for all server-side mutations. `createClient()` is async/cookie-based for client components.
- **Netlify** — Serverless functions. File uploads MUST use signed URLs (never send through Netlify functions). Auto-deploys from main branch.
- **Theme** — Dark mode permanently locked. `useTheme()` hook. `colors.gold` is actually green (#5FA873).
- **Audit logging** — `logAuditEvent()` / `logAuditEventServiceRole()` in `lib/audit.ts`. INSERT-only (DB triggers prevent UPDATE/DELETE).
- **Financial calculations** — Discount rate: $0.75 per $1,000 per day. +1 day processing offset applied in `lib/calculations.ts`.
- **PowerShell** — Use semicolons not `&&`. Quote paths with parentheses.
- **TypeScript** — Run `npx tsc --noEmit` to type-check (SWC binaries aren't available in sandbox, so `next build` won't work there).

---

## Session 8 — What Was Completed

### Round 1 (3 features — all pushed)
1. **Session Timeout Hardening** — Full React modal with 2-min warning, activity tracking, server heartbeat
2. **Brokerage Payment Tracking** — Admin payments overview + brokerage portal payments tab
3. **Agent Deal History Improvements** — Timeline, "What Happens Next" cards, pipeline viz

### Round 2 (bug fixes + improvements — all pushed)

#### Admin Dashboard (`app/(dashboard)/admin/page.tsx`)
- Added **Discounts Collected** KPI tile (4th card) — sum of discount_fee from funded deals, respects D/W/M/Y time range
- **Partner Brokerages** tile — now shows agent count, no longer clickable (removed "Manage →")
- **Action Needed** alert bar — amber bar showing pending KYC count + deals under review, with clickable buttons
- KPI grid changed from 3-col to 4-col

#### Agent Dashboard (`app/(dashboard)/agent/page.tsx`)
- Removed "Total Discount Fees Paid" bar and "Net Commission" KPI entirely
- Replaced with **"Avg. Turnaround"** (days from submission to funding) and friendlier subtitles
- KPI cards: Funds Received, Active Deals, Completed, Avg. Turnaround

#### Email Templates (`lib/email.ts`)
- **Centered logo** in email header (was left-aligned)
- **Better subject lines** — approval: "Good News — Your Advance for [address] is Approved!", funded: "Funds on the Way — [address]", denied: "Advance Update — [address]"
- **Prettier approval/funded emails** — celebratory colored cards instead of plain text
- **New: KYC Approved email** (`sendKycApprovedNotification`) — verification badge, feature list, dashboard link

#### KYC Flow (`lib/actions/kyc-actions.ts`)
- Wired `sendKycApprovedNotification` to fire when admin verifies agent ID (non-blocking)

#### Agent Deal Detail — Document Checklist (`app/(dashboard)/agent/deals/[id]/page.tsx`)
- Fixed disconnect: approved/funded/repaid deals show **"Accepted"** badge instead of "3 needed"
- Warning triangles replaced with green checkmarks when deal is past review stage

#### Underwriting Checklist (`app/(dashboard)/admin/deals/[id]/page.tsx`)
- Added **N/A toggle** button on each checklist item (grey circle, strikethrough, dimmed)
- N/A items count as complete for approval blocking
- New `toggleChecklistItemNA` server action in `lib/actions/deal-actions.ts`
- Migration `016_checklist_na_option.sql` — adds `is_na BOOLEAN DEFAULT FALSE` column (**already applied**)

#### Document Viewer — Inline Layout
- **Viewer now renders inline** next to the underwriting checklist (right column) instead of a fixed side panel
- When viewing a doc: right column = viewer, document list collapses into a **compact horizontal tab bar** above the columns
- Clickable doc tabs in the bar let you switch between docs without closing
- Old side panel removed entirely

#### PDF/Image Viewer — Ctrl+Scroll Zoom
- Added **Ctrl+scroll to zoom** for both PDF and image viewers
- Uses native `addEventListener('wheel', handler, { passive: false })` to prevent browser zoom hijacking
- Image viewer now supports up to 4x zoom (was 3x)

#### Deal Submission (`app/(dashboard)/agent/new-deal/page.tsx`)
- Replaced generic file picker with **specific document upload slots**: APS (required), NOF/Waiver (optional), Amendments (optional)
- **Banking Info** slot appears only on first advance (checks for existing funded deals), marked required
- Trade Record slot intentionally excluded — added by brokerage admin
- Each slot accepts multiple files via programmatic `document.createElement('input')` (fixes browser compat issue with nested label/input)
- Submit button disabled until APS uploaded (and banking info on first advance)
- Subtitle updated: "Upload ALL documents associated with this trade (Agreement of Purchase and Sale, Schedules, Amendments, NOFs/Waivers)."

#### Other Fixes
- **Referral fee display** — `admin/deals/[id]/page.tsx` line 1747: `(brokerage.referral_fee_percentage * 100).toFixed(0)%` (DB stores as decimal)
- **Processing day offset** — `lib/calculations.ts`: `effectiveDays = input.daysUntilClosing + 1`

---

## Migrations Applied This Session

| # | File | Status |
|---|------|--------|
| 016 | `016_checklist_na_option.sql` — adds `is_na` boolean to `underwriting_checklist` | ✅ Applied |

---

## Pending Work (Priority Order)

### 1. 🔴 Underwriting Checklist Items — MUST FIX
**Bud says the current list is wrong.** He needs to provide the correct items grouped by category. Once provided:
- Update the DB trigger function `create_underwriting_checklist()` in a new migration
- Delete all existing checklist items and recreate with correct items + categories
- The `is_na` column and N/A toggle UI are already working — just need correct items
- **This list must be locked and NEVER changed unless Bud explicitly asks.** Previous sessions have messed it up multiple times and it's a sore point.

### 2. Agent Document Checklist ↔ Underwriting Connection
Bud wants the agent-facing document checklist (on agent deal detail page) to mirror/connect to the underwriting checklist. When we fix the underwriting items, these two systems should be aligned.

### 3. Agent Profiles (Large Feature — Flagged for Future)
- Personal info, banking details, address from ID
- Banking info section on agent profile
- Check that blocks deal approval if banking info missing from agent profile

### 4. Remaining Items from Bud's Original List (Lower Priority)
- Documents should be draggable to underwriting categories (drag-drop)
- Email template testing (will test organically as deals flow)

---

## Key File Map

| File | Purpose |
|------|---------|
| `app/(dashboard)/admin/page.tsx` | Admin dashboard — KPIs, alerts, deal table |
| `app/(dashboard)/admin/deals/[id]/page.tsx` | Admin deal detail — underwriting, viewer, status changes |
| `app/(dashboard)/agent/page.tsx` | Agent dashboard — KPIs, deal list |
| `app/(dashboard)/agent/deals/[id]/page.tsx` | Agent deal detail — timeline, doc checklist |
| `app/(dashboard)/agent/new-deal/page.tsx` | Deal submission form — slot-based doc uploads |
| `app/(dashboard)/brokerage/page.tsx` | Brokerage portal — deals, agents, payments tabs |
| `lib/email.ts` | All email templates (Resend) |
| `lib/calculations.ts` | Financial calculations (discount fee, advance amount) |
| `lib/constants.ts` | Timeouts, status badges, document types, financial constants |
| `lib/actions/deal-actions.ts` | Server actions for deals, checklist toggle, N/A toggle |
| `lib/actions/kyc-actions.ts` | KYC verify/reject, auto-attach docs, KYC approval email |
| `lib/supabase/server.ts` | `createClient()` (async) and `createServiceRoleClient()` (sync, bypasses RLS) |
| `lib/audit.ts` | Audit logging functions |
| `middleware.ts` | Auth, role routing, force password change |
| `components/SessionTimeout.tsx` | Session timeout modal component |
| `supabase/migrations/` | All DB migrations (run manually in Supabase SQL Editor) |

---

## Current Underwriting Checklist (IN DB — NEEDS REPLACING)

Categories and items currently in the `create_underwriting_checklist()` trigger:

**Agent Verification:**
1. Agent ID & KYC/FINTRAC verification
2. Agent has no outstanding recovery amounts from fallen-through deals
3. Agent is in good standing (not flagged by brokerage)

**Deal Document Review:**
4. Agreement of Purchase and Sale (APS) received and reviewed
5. APS is fully executed (signed by all parties)
6. Property address verified against MLS listing
7. Brokerage split percentage confirmed via trade record
8. Brokerage is an active partner in good standing
9. Deal status is firm/unconditional (no outstanding conditions)
10. Trade record received confirming agent commission split
11. Closing date is confirmed and within acceptable range
12. Commission amount matches APS and trade record
13. Discount fee calculated correctly

**Financial:**
14. Void cheque or banking information on file

**Firm Funds Documents:**
15. Commission Purchase Agreement - Signed
16. Irrevocable Direction to Pay - Signed

**⚠️ Bud has confirmed these items are wrong and will provide the correct list.**
