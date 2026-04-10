# Session 30 — Handoff Prompt

**Copy everything below the line and paste it as your first message in the new Claude Code session.** Make sure the session is opened in `C:\Users\randi\Dev\firm-funds` (or a worktree off it) so it has access to `CLAUDE.md`, `AGENTS.md`, and the memory system.

---

Hey, it's Bud. You're picking up Session 30 of Firm Funds (firmfunds.ca, commission-advance platform, Next.js 16.2.1 + Supabase + Netlify).

**Read these FIRST — they tell you everything about the codebase and how to work with me:**
1. `CLAUDE.md` (project root) — tech stack rules, financial rules, middleware warning, agent capabilities, working style
2. `AGENTS.md` (project root) — Next.js 16 breaking changes, read `node_modules/next/dist/docs/` before touching dynamic routes
3. `MEMORY.md` index (memory system) — pointers into all accumulated project knowledge. **Specifically open `project_session29.md` and `reference_auth_testing.md` before you start.**

**Big picture:** Session 29 did a sloppy first pass at testing the Session 28 fee overhaul. I caught Claude taking shortcuts (seeding amendments via SQL instead of using the real submission flow, counting email reminders without actually rendering them, etc.). Session 29 still shipped 6 bug fix commits to main — two of them serious — but 4 of the 8 Priority-1 tests need to be re-run properly with no shortcuts.

**This session has two priorities:**
1. **Re-run the Session 28 tests PROPERLY with zero shortcuts**
2. **DocuSign production cutover + DocuSign tests** — only after priority 1 is green

I am NOT running the tests — you are. Claude in Chrome might be up (try it first). If not, use Claude Preview with local dev. Don't make me copy-paste anything.

---

## Priority 1 — Proper re-test of the Session 28 fee overhaul

You have full autonomy on these. Before each test, create a real test fixture the RIGHT way (no SQL seeding of deals or amendments unless it's literally the only way — and if you shortcut, call it out and flag the test as "low trust" in your summary). Use TodoWrite to track progress.

**Dev environment setup for a worktree (from Session 29 — don't repeat the hour I wasted on this):**

```bash
# In the worktree directory (not the main repo):
cp /c/Users/randi/Dev/firm-funds/.env.local .env.local       # env file is gitignored
npm install                                                    # DO NOT use a junction; it breaks lightningcss
cp node_modules/lightningcss-win32-x64-msvc/lightningcss.win32-x64-msvc.node node_modules/lightningcss/   # Turbopack Windows quirk
# CRON_SECRET is not in my .env.local — add it locally if you need to test the cron endpoint:
echo "CRON_SECRET=local-dev-test-secret" >> .env.local
# Also set a RESEND API key temporarily if you want to actually render reminder emails (see Test 8)
```

Then use Claude Preview's `preview_start` with `.claude/launch.json`. Next.js will come up on a random high port because 3000 is usually in use by someone else.

**Test agent credentials** (may need password reset via Supabase admin API — see `reference_auth_testing.md`):
- Firm Funds admin: `bud@firmfunds.ca`
- Agent: `bud.jones@century21.ca` (THIS is the agent. `budjonez12@gmail.com` is a BROKERAGE admin, not an agent. Old memory was wrong.)

### Prep work — before you start testing

Build or find these dummy assets in the repo or in `C:\Users\randi\OneDrive\Desktop\`:
- A real PDF that passes magic-byte validation (any small PDF will do). Call it `test-aps.pdf` and drop it in `C:\Users\randi\Dev\firm-funds\.claude\test-assets\` if that dir doesn't exist, create it. Same PDF can double as the APS, amendment, and void cheque upload.
- Verify the test agent `bud.jones@century21.ca` has fresh state: KYC verified, banking verified, `account_balance = 0`, no existing deals. Reset via SQL if needed.

### Test 1 — New deal calculator preview

**Already high-trust in Session 29.** Just re-verify for regression since 6 commits landed since. Log in as the agent, fill the form with these 3 scenarios, and confirm every line matches the Node math:

| Scenario | Gross | Split | Days | Expected Discount | Expected Settlement | Expected Total | Expected Advance |
|---|---|---|---|---|---|---|---|
| A | $10,000 | 20% | 30 | $174.00 (×29d) | $84.00 | $258.00 | $7,742.00 |
| B | $25,000 | 15% | 45 | $701.25 (×44d) | $223.13 | $924.38 | $20,325.63 |
| C | $50,000 | 10% | 14 | $438.75 (×13d) | $472.50 | $911.25 | $44,088.75 |

Screenshot the Advance Preview card for Scenario A and paste a small diff summary if anything is off.

### Test 2 — Agent submits a REAL deal, admin funds it through the REAL funnel

No SQL seeding of the deal. No SQL seeding of the checklist check-offs. This is the test Session 29 skipped.

1. Log in as the agent, go to `/agent/new-deal`, fill it in, upload the dummy PDF as the APS, upload the dummy PDF as banking (first advance), check "I confirm this deal is firm", click Review & Submit → Confirm. Verify you see the success state and a row in `deals` with `status='under_review'`.
2. Log in as admin. Find the deal in `/admin/deals` or deep-link. Click through each of the 12 underwriting checklist items **in the UI** (do NOT update them via SQL). For items that reference uploaded documents, link them via the UI's document-linker.
3. Transition: under_review → approved. Verify the status change email fired in logs.
4. Click Mark as Funded. Verify the Confirm Funding modal shows:
   - Funding Date, Charges Start (+1 day), Closing Date, **Payment Due Date (+14d)**, Days Charged (effective, not calendar)
   - Gross Commission, Brokerage Split, Net Commission
   - Discount Fee (effective-days × rate), Settlement Period Fee (14d × rate)
   - Gross Advance, Outstanding Balance Deduction (hidden if 0), Agent Receives (EFT)
   - **Editable Brokerage Referral % input** — pre-populated from brokerage default. Change it to 15% and verify discount-fee-derived values live-recalculate.
   - Confirm Funding button is disabled if the % is out of [0,100]
5. Click Confirm Funding. Verify the real DB writes: `status=funded`, `funding_date=today`, `due_date=closing+14`, `brokerage_referral_pct` = your override value, `payment_status='pending'`.

### Test 3 — Outstanding balance warning + auto-deduction

Use a DIFFERENT real-submission deal than Test 2. Before the agent submits:
- Set `UPDATE agents SET account_balance = 500 WHERE email = 'bud.jones@century21.ca'` (this is the ONE place I'm OK with a SQL shortcut — we need a positive starting balance to exercise the deduction path, and there's no UI for an admin to ledger-adjust an agent's balance today)
- Agent fills the new-deal form. Verify the red warning renders with the EXACT copy: *"Your Firm Funds account has an outstanding balance of $500.00, which will be deducted from this advance before processing."*
- Verify the headline shows Gross Advance + a sub-line "After outstanding balance deducted, deposited to your bank: $X"
- Submit the deal, admin approves + funds. The admin funding modal should show "Outstanding Balance Deduction: −$500.00" and "Agent Receives (EFT): $7,242.00" (for the Scenario A numbers).
- After funding, verify: `agents.account_balance = 0`, `deals.balance_deducted = 500`, `agent_transactions` has a `balance_deduction` row with running_balance=0.

### Test 4 — Closing date amendment on APPROVED deal (full recalc)

**This is the test Session 29 bypassed. `submitClosingDateAmendment` must actually be called.**

Use a fresh real-submitted, real-approved (not yet funded) deal. Closing date should be at least 20 days out so you can shift it.

1. Log in as agent. Navigate to the deal detail page. Click the **Amend Closing Date** button.
2. Fill the modal: new closing date 10 days later than current, upload the dummy PDF as the executed APS amendment. Submit.
3. Verify the submission actually wrote: row in `closing_date_amendments` with `status='pending'`, row in `deal_documents` with `document_type='closing_date_amendment'`, a file in the `deal-documents` storage bucket at the right path, an admin notification email was attempted.
4. **Verify the magic-byte validation fires** by trying to rename a `.txt` file to `.pdf` and uploading — it should be rejected. Then upload the real PDF.
5. Verify the duplicate-pending guard: try to submit another amendment for the same deal — it should refuse with "There is already a pending amendment request for this deal."
6. Log in as admin. See the "Closing Date Amendments" card on the deal. Click Approve & Send Amended CPA.
7. Verify the deal was fully recalculated: new closing_date, new days_until_closing, new discount_fee, new settlement_period_fee (same flat $, 14d doesn't change), new advance_amount, new brokerage_referral_fee, new amount_due_from_brokerage, new due_date (= new closing + 14). Amendment row: `status='approved'`, `adjustment_scenario='approved_recalc'`, `fee_adjustment_amount=0`.
8. The admin approval also tries to send an Amended CPA via DocuSign. If still on sandbox, it will land in sandbox (fine). If on production (after Priority 2), verify the envelope.

### Test 5 — Closing date amendment on FUNDED deal EXTENDED

Use a fresh real-submitted, real-approved, real-FUNDED deal. Repeat the amendment submission flow via the agent UI (NOT SQL). Extend closing by 10 days.

Verify after admin approval:
- Deal: `closing_date` updated, `days_until_closing` updated, `due_date` updated. **`discount_fee`, `settlement_period_fee`, `advance_amount`, `brokerage_referral_fee`, `amount_due_from_brokerage` all UNCHANGED (locked).**
- Agent balance: increased by the discount-fee delta for the extension days
- `agent_transactions`: row with `type='adjustment'`, positive amount equal to the delta, description mentioning "Closing date extension"
- Amendment row: `adjustment_scenario='funded_extended'`, `fee_adjustment_amount` = the positive delta

### Test 6 — Closing date amendment on FUNDED deal EARLIER

Same flow as Test 5 but pull closing IN by 5-10 days. Verify:
- Deal: same locked fields preserved
- Agent balance: decreased (credited) by the delta
- `agent_transactions`: row with `type='credit'`, negative amount, description mentioning "Closing date moved earlier"
- Amendment row: `adjustment_scenario='funded_earlier'`, `fee_adjustment_amount` = the negative delta

### Test 7 — Late interest cron (verify idempotency + multi-day catch-up)

Session 29 verified this test was real. Extend it to cover more scenarios.

1. Seed (or if you can, naturally create) a funded deal with `due_date` = 7 days ago, `late_interest_charged = 0`, `late_interest_calculated_at = NULL`.
2. Hit the cron endpoint: `curl -H "Authorization: Bearer local-dev-test-secret" "http://localhost:<PORT>/api/cron/closing-date-alerts"`
3. Verify: `deals_charged: 1`, `late_interest_charged ≈ $X` matching `7 × advance × 0.24/365` (single row in ledger).
4. Run the cron AGAIN. Verify: `deals_charged: 0`, nothing new in the ledger, `late_interest_charged` unchanged. **This is the idempotency check.**
5. Manually bump the deal's `due_date` one day earlier (to simulate the next day's cron run). Hit cron again. Verify: one more day's interest charged, a SINGLE new ledger row, total `late_interest_charged` now matches 8 days.
6. Verify `payment_status` flipped to `'overdue'`.
7. Verify the `/api/cron/closing-date-alerts` endpoint no longer 302s to `/login` (middleware fix `87efaa9` landed, but regression-check it).

### Test 8 — Settlement reminder emails, **actually rendered and delivered**

Session 29 only checked the counter. This time you render a real email.

1. Temporarily set `RESEND_API_KEY` in the worktree `.env.local` to a real Resend test key. (Ask me if you don't have one — I'll grab it from Netlify env vars.)
2. Temporarily set a test recipient: either the test agent's email, or update the test agent's email to a Resend-verified `onboarding@resend.dev` style address so you can see what was delivered without cluttering my real inbox. Ask me before spamming my gmail.
3. Seed (or naturally create) 3 funded deals with closing dates = today, 7 days ago, and 11 days ago respectively. Give each a different property address so the emails are distinguishable.
4. Hit the cron. Verify `reminders_sent: 3`.
5. **Check the Resend dashboard (or logs) for the actual delivered emails.** Open each one and verify:
   - Subject line is sensible and has the property address
   - Body copy is correct for the stage (closing day / 7 days remaining / 3 days remaining)
   - `{{DUE_DATE}}` and other merge fields are populated, not literal `{{}}`
   - The dollar amount shown matches `amount_due_from_brokerage`
   - Links to `/agent/deals/<id>` use the correct host (`firmfunds.ca` in prod config, `localhost` in dev)
   - Brokerage copy goes to the brokerage email too, with different wording
6. Screenshot one email rendering for the summary.
7. **Un-set the temporary RESEND_API_KEY and test recipient before you wrap up Priority 1.**

### After Priority 1 — summary for Bud

Write a concrete summary:
- What you actually tested end-to-end (tests that were real)
- Anything you shortcut and why (shouldn't be much this time)
- Any bugs found and fixed with commit SHAs
- Anything still needing a human eye (e.g., "the 7-day email subject reads weird, want a copy edit?")

**Do NOT proceed to DocuSign cutover until I've reviewed the Priority 1 summary and said go.**

---

## Priority 2 — DocuSign production cutover

See `reference_docusign_production.md` for account details. The production account is Canadian-region, approved, and ready.

1. **Clear the sandbox token**:
   ```sql
   DELETE FROM docusign_tokens WHERE id = 1;
   ```
2. **Re-authenticate OAuth via `/admin/settings`** against the production account (Account ID `1528175589`, user ID `1614583e-c6f4-4010-a996-2a4d57cee079`, base URI `https://ca.docusign.net`). Verify the Netlify env vars listed in `reference_docusign_production.md` are all set before attempting the OAuth handshake.
3. **Test BCA send on a test brokerage**. Pick a test brokerage, trigger the BCA generation, verify the envelope is created with the "Commission Purchase Program" title (not the old "Commission Advance Program"), signed by Bud Jones (not Bud Dickie), with Firm Funds address 121 Brock Street, Sault Ste. Marie, ON P6A 3B6.
4. **Test CPA + IDP send on a funded test deal**. Verify:
   - CPA has new Article 5 split (5.1 non-closing, 5.2 partial shortfall, 5.3 separate seller repayment interest)
   - CPA Article 3.4 Purchase Price = Face Value − Purchase Discount − Settlement Period Fee
   - IDP uses `{{DUE_DATE}}` tied to expected closing + 14, not actual closing
   - The per-deal brokerage referral % override actually propagates into the CPA merge field (verify by funding a deal with an override and comparing the rendered PDF to the brokerage default)
5. **Test CPA Amendment send** for each of the 3 scenarios (`approved_recalc`, `funded_extended`, `funded_earlier`). Verify the `{{SCENARIO}}` merge field branches correctly and the Article 2 account-charge/credit language shows up only on funded-extended/earlier amendments.
6. **Verify the webhook round-trip**: after each signed envelope, confirm the webhook at `https://firmfunds.ca/api/docusign/webhook` (Config ID 21724734) receives the event and the signed PDF is downloaded into the `deal-documents` bucket under the right path.

### After DocuSign tests
Summarize what worked, what didn't, anything still looking sketchy. DO NOT delete the agent-email-nullable migration until I explicitly say so — we still might need it if a DocuSign test surfaces something weird.

---

## Final cleanup before handoff to the NEXT session

- Remove `CRON_SECRET=local-dev-test-secret` from the worktree `.env.local` if you added it
- Remove any test `RESEND_API_KEY` from the worktree `.env.local`
- Revert any test-agent email override on the agents row
- Clean up seeded test deals, amendments, ledger rows, checklist items
- Reset `bud.jones@century21.ca` `account_balance` to 0
- Drop the dummy test PDFs if you added them
- Run `npx tsc --noEmit` clean
- Commit + push after each real fix (I already said pushes don't need confirmation but keep commit messages detailed so the git log tells the story)

---

## Working style reminders (from memory — read `feedback_style.md` for full version)

- I can't write code. You do it all.
- Run commands yourself via Bash. Do NOT make me copy-paste.
- Still paste SQL in chat so I can see what's touching production.
- Don't over-explain. Files + short summaries.
- Walk through ONE test at a time. Don't dump simulation lists.
- Casual tone. Sarcasm welcome. Don't be a corporate robot.
- When something is ambiguous, ask me ONE question and stop. Don't ask 4 at once.
- When you find a bug, fix it immediately (commit + push). Don't just flag it for later.
- **If you catch yourself taking a shortcut, STOP and flag it.** Session 29 had to be redone because of shortcuts. Don't repeat that.

Read `project_session29.md` carefully before you start — it documents exactly what Session 29 got wrong so you don't repeat it.

Let's go. First thing: confirm you've read CLAUDE.md, AGENTS.md, MEMORY.md index, `project_session29.md`, and `reference_auth_testing.md`. Then start Priority 1, Test 1.
