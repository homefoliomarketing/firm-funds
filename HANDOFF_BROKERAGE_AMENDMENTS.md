# Handoff — Brokerage-Submitted Amendments

**Goal:** Let brokerage admins request changes to one of their deals (closing-date change is the primary case) without having to email Bud. The change is auto-recalculated and held in a "pending" state until a Firm Funds admin approves it.

## What you're building (UI)

1. **Entry point on the brokerage dashboard** — a "Request a Deal Change" button somewhere prominent on `app/(dashboard)/brokerage/page.tsx`.
2. **Deal picker** — list the brokerage's deals that are eligible for amendment. Eligibility: status in (`approved`, `funded`). One pending amendment at a time per deal — block if one already exists.
3. **Amendment form** — the brokerage chooses what to change. **Phase 1: closing-date change only** (mirror the agent flow). Form fields:
    - New closing date (date picker, validated against `MIN_DAYS_UNTIL_CLOSING`/`MAX_DAYS_UNTIL_CLOSING` in `lib/constants.ts`)
    - Reason / notes (free text)
    - File upload — executed Closing Date Amendment doc (PDF/JPEG/PNG)
    - **Live preview**: before submission, show old vs new discount fee, settlement fee, brokerage referral fee, agent advance — so the brokerage sees the financial impact. Use `calculateDeal()` from `lib/calculations.ts`.
4. **Status visibility** — show pending/approved/rejected amendments on the brokerage's deal list and the dashboard. The brokerage should see "Pending admin review" with a timestamp.

## What already exists (don't rebuild this)

- **DB table** `closing_date_amendments` — single source of truth. Has `deal_id`, `requested_by`, `old_closing_date`, `new_closing_date`, `old_discount_fee`, `new_discount_fee`, `old_settlement_period_fee`, `new_settlement_period_fee`, `status`, `amendment_doc_path`, etc.
- **Server actions in `lib/actions/amendment-actions.ts`:**
    - `submitClosingDateAmendment(formData)` — **agent-only** (line 35: `getAuthenticatedUser(['agent'])`). You'll either expand this to accept `brokerage_admin` or write a sibling `submitClosingDateAmendmentAsBrokerage`. Either is fine — sibling is cleaner for permission scoping (brokerage_admin needs `deal.brokerage_id === profile.brokerage_id`, agent needs `deal.agent_id === profile.agent_id`).
    - `approveClosingDateAmendment` / `rejectClosingDateAmendment` — admin actions. **No changes needed** — they just update the deal record and recompute via `calculateDeal()`. Whoever submitted is irrelevant at approval time.
    - `getDealAmendments(dealId)` — fetches all amendments for a deal. Reusable on the brokerage side.
- **Admin review UI** at `app/(dashboard)/admin/deals/[id]/page.tsx` — already shows pending amendments and has approve/reject buttons. Untouched.
- **Agent request UI** at `app/(dashboard)/agent/deals/[id]/page.tsx` — read this first, it's the pattern to mirror.
- **Email templates** — `sendAmendmentRequestedNotification`, `sendAmendmentApprovedNotification`, `sendAmendmentRejectedNotification` in `lib/email.ts` already exist. Wire the new submit action to fire `sendAmendmentRequestedNotification` (admin notification).

## Critical gotchas (we hit these recently)

1. **RLS for brokerage_admin** — the `deal_documents` table had policies for agents and admins but not `brokerage_admin`, so INSERTs silently failed. **Lesson:** any time you `.insert()` from a brokerage_admin context, either (a) verify there's an RLS policy that lets them or (b) do the mutation through `createServiceRoleClient()`. The existing `amendment-actions.ts` uses `createServiceRoleClient()` for the `closing_date_amendments` table — keep that pattern. See commit `b32b5b5` for context. CLAUDE.md says: "Use `createServiceRoleClient()` for ALL server-side mutations."
2. **File-input "Add" button** — don't use `className="hidden"` on `<input type="file">`. Use the screen-reader-only positioning pattern (absolute, 1px, clipped). `display:none` file inputs drop the change event in some browser/extension combos. See commit `69c80d9` for the working pattern in `app/(dashboard)/brokerage/deals/new/page.tsx` (DOC_SLOTS section).
3. **Required-doc validation** — the brokerage submit form has a `missing` array that drives the disabled state on the submit button. Add the new amendment doc to that array. See commit `b32b5b5`.
4. **Recent commission rule change** — `brokerageReferralFee = referralPct × (discountFee + settlementPeriodFee)`. The new formula is in `lib/calculations.ts`. Already applied across the codebase. Just trust `calculateDeal()` for previews.
5. **Next.js 16.2.1 + Turbopack quirks** — `params` in dynamic routes are Promises. `'use server'` files can ONLY export async functions. Read `node_modules/next/dist/docs/` if anything compiles strangely.

## Suggested phasing

**Phase 1 — closing-date amendments only (this session):**
- Build `submitClosingDateAmendmentAsBrokerage` server action (sibling of the agent one)
- Brokerage dashboard "Request a Deal Change" button → modal or new page at `app/(dashboard)/brokerage/amendments/new/page.tsx`
- Deal picker + closing-date form + file upload + live preview
- Pending-amendments visible on the brokerage dashboard

**Phase 2 — other amendable fields (don't do unless Bud asks):**
- Gross commission, brokerage split %, transaction type, property address typo fixes
- Each new amendment type needs: a new column or a new table, recompute logic in `calculateDeal`, admin approval UI extension

## What to ask Bud before starting

- **Where exactly on the brokerage dashboard should the entry button live?** (Top-right next to "Submit Advance Request"? A dedicated "Amendments" card?)
- **Should the brokerage be able to amend on behalf of any of their agents' deals, or only deals the brokerage itself submitted?** Permission-wise the cleanest answer is "any deal where `deal.brokerage_id === profile.brokerage_id`."
- **Does the brokerage need to upload the executed amendment doc, or can they request first and upload later?** Agent flow requires it upfront. Probably mirror that.
- **Phase 1 scope confirmation** — closing date only, or also gross commission? (Recommend closing-date-only for v1.)

## Files you'll likely touch

- `lib/actions/amendment-actions.ts` — new server action
- `app/(dashboard)/brokerage/page.tsx` — entry button + pending amendments section
- `app/(dashboard)/brokerage/amendments/new/page.tsx` — new file (the form)
- `app/(dashboard)/brokerage/deals/[id]/page.tsx` — if a brokerage deal-detail page exists, surface amendments there too (check first)
- Maybe `lib/email.ts` — verify the existing notification templates work for brokerage submitters; tweak copy if needed

## Recent context (last session highlights)

- `lib/calculations.ts` — referral formula change (commit `ae18caf`)
- `lib/contract-docx.ts` — Brokerage Cooperation Agreement updated to match (§1.7, §4.4, §4.6)
- File-upload picker fix in brokerage submit form (commit `69c80d9`)
- Doc upload RLS bypass via service role (commit `b32b5b5`)
- PDF viewer multi-page scroll fix in admin underwriting (commit `6e8c494`)
- Test data already recomputed on the new referral formula (raw SQL, no migration needed — pre-launch)

Today's date: 2026-04-30. Live: firmfunds.ca. Branch: main, auto-deploys via Netlify.
