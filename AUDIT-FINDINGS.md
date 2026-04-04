# Firm Funds — Project Audit: Redundancy & Complexity Review

**Date:** April 3, 2026
**Auditor:** Claude (Session 4)
**Scope:** Full codebase — every `.ts`, `.tsx`, config, and dependency
**Status:** Audit only — NO changes made

---

## Summary

| Category | Issues Found | Highest Severity |
|----------|:---:|:---:|
| Unused Dependencies | 4 | **High** |
| Dead / Orphaned Files | 7 | **High** |
| Duplicate Utility Functions | 3 families across 7+ files | **Medium** |
| Duplicate Auth Helper Pattern | 3 identical copies | **Medium** |
| Unused Exports / Dead Functions | 5 | **Medium** |
| Over-Sized Monolith Files | 2 | **Medium** |
| Abandoned Infrastructure (Light Mode) | 1 system | **Low** |
| Redundant Inline Style Patterns | Pervasive | **Low** |
| Config / Setup Issues | 1 | **Low** |
| **TOTAL** | **~27 individual findings** | |

**Estimated dead/orphaned code:** ~1,600 lines across 7 files
**Estimated duplicated code:** ~200+ lines across 7+ files
**Unused npm packages:** 4 (potentially significant bundle impact)

---

## Detailed Findings

---

### 1. Unused Dependencies

**[High] `zustand` (^5.0.12) — completely unused**
- File: `package.json` line 27
- Evidence: `grep` for `zustand`, `useStore`, `create(` from zustand — zero imports in entire codebase
- Impact: Added to production bundle for nothing. Zustand is ~3KB but signals intent for state management that was never implemented.
- Recommendation: Remove from `package.json`

**[High] `@tanstack/react-query` (^5.96.0) — completely unused**
- File: `package.json` line 13
- Evidence: Zero imports of `useQuery`, `useMutation`, `QueryClient`, or anything from `@tanstack/react-query`
- Impact: Significant bundle addition (~40KB) with no usage. All data fetching is done via server actions or direct `fetch()` calls.
- Recommendation: Remove from `package.json`

**[High] `react-hook-form` (^7.72.0) — completely unused**
- File: `package.json` line 22
- Evidence: Zero imports of `useForm`, `Controller`, or anything from `react-hook-form`
- Impact: All forms use plain React state (`useState`) with manual `onChange` handlers.
- Recommendation: Remove from `package.json`

**[High] `@hookform/resolvers` (^5.2.2) — completely unused**
- File: `package.json` line 12
- Evidence: Companion to `react-hook-form`, which is also unused. Zero imports.
- Recommendation: Remove from `package.json`

**[Low] `pdf-lib` (^1.17.1) — used in exactly 1 file**
- File: `app/api/reports/referral-fees/route.ts` (line 3)
- Note: This IS used for PDF report generation. Not dead — but worth knowing it exists only for this single route. Justified.

**[Low] `xlsx` (^0.18.5) — used in exactly 1 file**
- File: `app/(dashboard)/admin/brokerages/page.tsx` (line 9)
- Note: Used for bulk agent import from spreadsheets. Justified — just narrow usage.

---

### 2. Dead / Orphaned Files

**[High] `_ready-to-place/` directory — 3 orphaned files (1,103 lines total)**
- `_ready-to-place/agent-deal-detail.tsx` (393 lines) — older version of `agent/deals/[id]/page.tsx`
- `_ready-to-place/agent-page.tsx` (300 lines) — older version of `agent/page.tsx`
- `_ready-to-place/deal-detail-admin.tsx` (410 lines) — older version of `admin/deals/[id]/page.tsx`
- Evidence: Zero imports reference `_ready-to-place` anywhere. These are outdated drafts with hardcoded Tailwind classes (pre-theme system), missing features (no PDF viewer, no KYC gate, no admin notes).
- Recommendation: Delete entire `_ready-to-place/` directory

**[High] `app/(dashboard)/admin/agents/page.tsx` (5 lines) — dead page**
- Content: Empty stub with comment "Agent management moved to brokerages page"
- Evidence: Confirmed in HANDOFF.md. No navigation link points here.
- Recommendation: Delete file and directory

**[Medium] `app/api/change-password/route.ts` (56 lines) — unused API route**
- Description: Server-side password change endpoint, kept as "backup"
- Evidence: Password change is fully client-side since Session 3. No code calls this endpoint. The client-side flow uses `supabase.auth.updateUser()` + `/api/clear-reset-flag`.
- Recommendation: Delete

**[Medium] `app/api/documents/signed-url/route.ts` (47 lines) — superseded API route**
- Description: Server-side endpoint for generating document signed URLs
- Evidence: Both admin and agent deal detail pages now use client-side `supabase.storage.createSignedUrl()` directly. HANDOFF.md confirms superseded.
- Recommendation: Delete

**[Medium] `lib/actions/auth-actions.ts` (48 lines) — entire file is dead code**
- Contains: Single export `changePasswordAndClearFlag()` server action
- Evidence: Zero imports of this function anywhere. Password change is client-side. The file's only export is unused.
- Recommendation: Delete entire file

---

### 3. Duplicate Utility Functions

**[Medium] `formatCurrency()` — duplicated in 7 active files**
Identical function defined locally in each of these files:
1. `app/(dashboard)/admin/deals/[id]/page.tsx` (line 721)
2. `app/(dashboard)/admin/page.tsx` (line 141)
3. `app/(dashboard)/admin/reports/page.tsx` (line 33)
4. `app/(dashboard)/agent/deals/[id]/page.tsx` (line 216)
5. `app/(dashboard)/agent/new-deal/page.tsx` (line 179)
6. `app/(dashboard)/agent/page.tsx` (line 95)
7. `app/(dashboard)/brokerage/page.tsx` (line 252)

Also exists in: `app/api/reports/referral-fees/route.ts` (line 99), `lib/email.ts` (internal)

Pattern: `(amount: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)`

- Recommendation: Extract to `lib/formatting.ts`, import everywhere

**[Medium] `formatDate()` — duplicated in 5+ active files**
Same situation — identical date formatting logic in every page that shows dates:
1. `app/(dashboard)/admin/deals/[id]/page.tsx` (line 722)
2. `app/(dashboard)/agent/deals/[id]/page.tsx` (line 217)
3. `app/(dashboard)/agent/page.tsx` (line 99)
4. `app/(dashboard)/brokerage/page.tsx` (line 253)
5. `app/api/reports/referral-fees/route.ts` (line 102)

Pattern: `(date: string) => new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })`

`formatDateTime()` is also duplicated in 3+ files.

- Recommendation: Extract to `lib/formatting.ts` alongside `formatCurrency`

**[Low] `DOCUMENT_TYPES` array — duplicated in orphaned files**
- Active version: Likely in page components or `lib/constants.ts`
- Orphaned copies: All 3 `_ready-to-place/` files define their own
- Impact: Goes away when `_ready-to-place/` is deleted

---

### 4. Duplicate Auth Helper Pattern

**[Medium] `getAuthenticatedAdmin()` — defined 3 separate times**
Identical (or near-identical) function defined independently in:
1. `lib/actions/admin-actions.ts` (line 21) — called 14 times in that file
2. `lib/actions/kyc-actions.ts` (line 23) — called 5 times in that file
3. `lib/actions/report-actions.ts` (line 84) — called 2 times in that file

Each copy: ~25 lines, creates Supabase client, gets user, checks profile role, returns user/profile/supabase or error.

Additionally, `lib/actions/deal-actions.ts` (line 47) has a related `getAuthenticatedUser()` variant with a `requiredRoles` parameter.

- Total: ~100 lines of duplicated auth boilerplate across 4 files
- Recommendation: Extract to `lib/auth-helpers.ts` with `getAuthenticatedAdmin()` and `getAuthenticatedUser(requiredRoles)` as shared utilities

---

### 5. Unused Exports / Dead Functions

**[Medium] `validateDealInputs()` in `lib/calculations.ts` (line 39) — export never imported externally**
- The function IS called internally (line 59, within `calculateDealFinancials()`), but the `export` keyword means it's offered as a public API that nothing uses directly.
- Minor issue: The export is unnecessary since consumers only call `calculateDealFinancials()`.
- Recommendation: Remove `export` keyword (make it a private helper)

**[Medium] `DocumentUploadSchema` in `lib/validations.ts` (line 57) — exported but never imported**
- Evidence: Only appears in its own definition file. No action file or API route imports it.
- Also: `DocumentUpload` type (line 68) is likewise never imported.
- Recommendation: Remove both, or implement validation where file uploads happen

**[Low] `DealStatusChangeSchema` in `lib/validations.ts` (line 50) — IS used**
- Imported and used in `lib/actions/deal-actions.ts` (line 5, line 302)
- Status: NOT dead — initially suspected but verified as active

**[Low] `ThemeToggle.tsx` component (7 lines) — renders `null`, never imported**
- Content: `export default function ThemeToggle() { return null }`
- Comment says: "Light mode removed — kept to avoid import errors from stale references"
- Evidence: Zero files import `ThemeToggle`. The "stale references" concern is unfounded.
- Recommendation: Delete

**[Low] `statusColor()` / `statusLabel()` in `lib/email.ts` — possibly over-exported**
- These appear to be internal helpers used only within email template functions. If they're exported, nothing outside `email.ts` imports them. Verify and reduce visibility if confirmed.

---

### 6. Over-Sized Monolith Files

**[Medium] `app/(dashboard)/admin/brokerages/page.tsx` — 1,867 lines**
- Contains: Brokerage list, brokerage CRUD modals, agent list within each brokerage, agent CRUD, bulk spreadsheet import, KYC verification UI, agent invite flow, archive flow, resend welcome email
- Concern: 6+ distinct features in one file. Difficult to navigate, test, or maintain. Likely has 20+ `useState` hooks.
- Recommendation: Extract into sub-components: `BrokerageList`, `AgentTable`, `BulkImportModal`, `KycVerificationPanel`

**[Medium] `app/(dashboard)/admin/deals/[id]/page.tsx` — 2,082 lines**
- Contains: Deal detail view, underwriting checklist, document viewer panel, PDF canvas renderer (~200 lines), image zoom viewer (~100 lines), EFT payment tracker, admin notes timeline, status transition logic with confirmation modals
- Concern: `PdfCanvasViewer` and `ImageZoomViewer` are fully self-contained sub-components defined inline — perfect candidates for extraction.
- Recommendation: Extract `PdfCanvasViewer`, `ImageZoomViewer`, and `UnderwritingChecklist` to `components/`

---

### 7. Abandoned Infrastructure (Light Mode)

**[Low] Light mode theme — fully built, permanently disabled**
- File: `lib/theme.tsx`
- `lightColors` object (lines 72-120): ~50 properties defining a complete light theme. Never active — dark mode is hardcoded.
- `ThemeProvider` maintains `mode` state (line 210) but a `useEffect` forces it to `'dark'` (line 215).
- Toggle function is neutered: `const toggle = () => {}` (line 219)
- Line 223: `colors: mode === 'dark' ? darkColors : lightColors` — the ternary can never resolve to `lightColors`
- Impact: ~50 lines of dead theme definitions, plus unnecessary state management in the provider
- Recommendation: Remove `lightColors`, simplify `ThemeProvider` to always return `darkColors`, remove toggle from context value

---

### 8. Redundant Inline Style Patterns

**[Low] Focus/blur event handlers with hardcoded colors — duplicated across auth pages**
- Files: `app/(auth)/login/page.tsx`, `app/(auth)/change-password/page.tsx`
- Pattern: Every `<input>` has inline `onFocus`/`onBlur` handlers that set `borderColor` to `'#5FA873'` and a box shadow. Repeated per input field, per page.
- Issue: Hardcodes the brand color instead of using `colors.gold`. If the brand color changes, these break.
- Recommendation: Extract to a reusable `<ThemedInput>` component or a shared hook

**[Low] Card container styling — repeated throughout dashboard pages**
- Pattern: `{ background: colors.cardBg, border: \`1px solid ${colors.border}\`, borderRadius: 12, padding: 32 }` appears in similar forms across virtually every dashboard page and component.
- Impact: Maintainability debt — changing the card style means editing 20+ locations.
- Recommendation: Eventually extract to a `<Card>` wrapper or shared style object. Low priority since it works.

---

### 9. Config / Setup

**[Low] `.claude/worktrees/` directory — git submodule artifact**
- HANDOFF.md notes this as a recurring issue: a `.claude/worktrees` submodule reference sometimes gets staged.
- The worktree (`distracted-pasteur`) contains a full copy of the codebase and shows up in greps.
- Fix: `git reset HEAD .claude` before committing (already documented)
- Recommendation: Add `.claude/` to `.gitignore` if not already there

**[Low] `app/api/seed/route.ts` — dev-only seed endpoint in production**
- This route is deployed to production on every push. If it has no auth guard, it could be a security concern.
- Recommendation: Verify it has proper protection or remove it before going live with real users

---

## Files Safe to Delete Today

These files can be removed with zero impact on the running application:

| File | Lines | Reason |
|------|:-----:|--------|
| `_ready-to-place/agent-deal-detail.tsx` | 393 | Orphaned draft |
| `_ready-to-place/agent-page.tsx` | 300 | Orphaned draft |
| `_ready-to-place/deal-detail-admin.tsx` | 410 | Orphaned draft |
| `app/(dashboard)/admin/agents/page.tsx` | 5 | Dead stub page |
| `app/api/change-password/route.ts` | 56 | Unused backup route |
| `app/api/documents/signed-url/route.ts` | 47 | Superseded by client-side |
| `lib/actions/auth-actions.ts` | 48 | Entire file unused |
| `components/ThemeToggle.tsx` | 7 | Renders null, never imported |
| **Total** | **1,266** | |

## Packages Safe to Remove Today

```bash
npm uninstall zustand @tanstack/react-query react-hook-form @hookform/resolvers
```

---

## Quick Wins (Low Effort, High Impact)

1. **Delete the 8 dead files** listed above (~1,266 lines gone)
2. **Remove 4 unused npm packages** (smaller bundle, fewer phantom dependencies)
3. **Create `lib/formatting.ts`** with shared `formatCurrency`, `formatDate`, `formatDateTime` — replace 15+ duplicate definitions
4. **Create `lib/auth-helpers.ts`** with shared `getAuthenticatedAdmin()` — replace 3 duplicate definitions (~100 lines saved)
5. **Remove `lightColors` from `lib/theme.tsx`** and simplify `ThemeProvider`
