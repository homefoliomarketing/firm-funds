# Help Center Audit and Trim Plan

_Audit only. No code was changed in this session. This document is the deliverable._
_Date: 2026-06-02_
_Goal Bud set: make the Help Center simple and easy to use. Skim the fat. Fix the unrealistic $50,000 pricing example (real average advance is closer to $10,000)._

---

## TL;DR (plain English)

The Help Center works, but it is heavier than a product this size needs. Think of it as a small house with a commercial-grade security system, two separate intercoms, and a custom-built elevator that only goes to one room. The content is fine; the machinery wrapped around it is doing too much.

Five headline findings:

1. **The $50,000 example is unrealistic and it cascades.** It is the headline number on the live fee calculator and on the main "how the advance is calculated" article. Changing it to $10,000 touches 3 user-facing spots (one of which then recalculates six follow-on numbers).
2. **Two real math bugs, separate from the pricing.** One brokerage worked example and one late-interest example have wrong arithmetic today, regardless of the dollar amount. Both verified by re-computing against `lib/calculations.ts` in this session.
3. **There are too many articles, and they repeat each other.** 22 articles, with the same three concepts (late interest, settlement window, Remediation IDP) explained 3 to 4 times each. Target: roughly 12 to 14.
4. **There are too many FAQs, and several just echo an article.** 28 FAQs, about 14 of which can be cut or merged. Target: roughly 12.
5. **About 500 to 600 lines of component "machinery" can go with zero user-visible loss.** Dead screenshot code, a hand-drawn SVG diagram used once, a fancy command-palette search, and a second duplicate search box.

Nothing here is on fire. This is a "skim the fat" pass, exactly what Bud asked for.

---

## Part 1: The pricing problem Bud flagged

### 1a. The $50,000 example (change to ~$10,000)

The unrealistic $50,000 figure shows up in **3 user-facing places**. There is no $100k example anywhere.

| # | File | Line(s) | What it is | Fix |
|---|------|---------|-----------|-----|
| 1 | `content/help/articles/shared/how-the-advance-is-calculated.tsx` | 26, 28 | The flagship worked example. "$50,000 gross commission... net $47,500..." This one number cascades into $47,500, $1,140, $266, $1,406, and $46,094 further down the article. | $50,000 to **$10,000**, and recompute the 6 derived figures (see below). |
| 2 | `content/help/articles/brokerage/settle-a-funded-deal.tsx` | 51 | Brokerage "Worked example" money callout, also built on $50,000. | $50,000 to **$10,000**, recompute. |
| 3 | `components/help/HelpFeeWorksheet.tsx` | 37 (`defaultGross = 50000`) | The **live calculator** default. It is always rendered with no props, so every first-time user sees $50,000 pre-filled. | Change default to **10000** (or pass `defaultGross={10000}` at the single call site in `how-the-advance-is-calculated.tsx:110`). Slider/min/max bounds already allow $10,000, no other change needed. |

One more inflated figure worth dropping for consistency (not strictly $50k, but oversized):

| 4 | `content/help/articles/agent/account-balance-and-ledger.tsx` | 37 to 38 | Illustration uses a **$20,000** advance ("$500 owing on a $20,000 advance"). | Drop the advance to **$10,000** so it matches the new norm. The $500 / $9,500 shape still reads fine. |

Recomputed numbers if the main article moves to $10,000 (net of a 5% split, 30 days to closing, 7-day settlement):

- Net commission: **$9,500**
- Discount fee: **$228.00**
- Settlement fee: **$53.20**
- Total fees: **$281.20**
- Advance amount: **$9,218.80**

For the brokerage `settle-a-funded-deal` example at $10,000: net $9,500, referral fee $56.24, amount due from brokerage **$9,443.76**.

### 1b. Two math bugs (true regardless of the dollar amount)

These were verified in this session by re-running the exact rate logic ($0.80 per $1,000 per day) and the 24%/year daily-compound formula `(1.24)^(1/365) - 1` from `lib/calculations.ts`.

| File | Line(s) | Shows | Should be | Why |
|------|---------|-------|-----------|-----|
| `content/help/articles/brokerage/settle-a-funded-deal.tsx` | 53, 56 to 57 | Referral fee **$273.60**, amount due **$47,226.40** | Referral fee **$281.20**, amount due **$47,218.80** (at the current $50k) | $273.60 is 20% of $1,368, which is the total fee for a **6-day** settlement window. The real window is 7 days, so the total is $1,406 and 20% of that is $281.20. The example silently used a stale day count. (Note: the article never states the day count, so a reader cannot reconstruct the number either way.) |
| `content/help/articles/agent/what-happens-if-deal-falls-through.tsx` | 74 to 75 | Day-120 interest **$556**, total **$10,556** | Day-120 interest **$544.73**, total **$10,544.73** | On a $10,000 balance, 90 days of accrual after the 30-day grace gives $544.73, not $556. The day-30 ("$178") figure on line 71 is correct. |

The good news: the late-interest examples in `late-interest-rules.tsx` and `faqs/shared.tsx` already use a realistic **$10,000 balance** and their arithmetic checks out, so leave those amounts alone. (They use $10,000 as an unpaid balance, which happens to match the new target already.)

### 1c. Outside the Help Center (FYI, not part of this scope)

The investor **pitch deck** (`marketing/decks/commission-advance-pitch/`) uses **$15,000** in a live slide and **$20,000** in a README note (both already flagged "CONFIRM WITH BUD"). If Bud wants one consistent "average advance" story everywhere, those should align to $10,000 too. This is a separate surface and a separate decision.

---

## Part 2: How heavy the Help Center is right now

- `components/help/`: 12 files, **1,143 lines**
- `content/help/` (types, index, 22 articles, 3 FAQ files): 28 files, **3,482 lines**
- **Combined: 40 files, ~4,625 lines**

Verdict from the structure review: the content itself is reasonable (roughly 80 to 120 lines per article). The bloat lives in the **framework wrapped around the content** and in **how many times the same thing is said**.

---

## Part 3: Where the fat is

### 3a. Structural / machinery bloat (the easiest, safest wins)

| Item | Lines | Problem | Recommendation |
|------|-------|---------|----------------|
| `HelpScreenshot.tsx` | 41 | **Dead code.** Zero usages anywhere. The `public/help/` image folder it points at does not even exist. | **Delete.** Zero risk. |
| `HelpStatusFlowDiagram.tsx` | 157 | A hand-built SVG of the deal-status flow, with manual pixel coordinates per box. Used in **exactly one** article. Any status change means editing SVG geometry. | Replace with a short numbered list or one static image. |
| `HelpSearchPalette.tsx` | 133 | A full command-palette (Ctrl+K, pulls in the `cmdk` dependency) to search ~80 items. | Drop it. Keep one simple search. |
| `HelpFaqFilter.tsx` | 83 | A **second, separate** search box that filters FAQs by walking the page and hiding elements. Two search systems for one small library. | Drop it once search is unified. |
| Role split (agent / brokerage / shared) | spread across 3 files | The signed-in role is re-queried and re-filtered in the layout, the landing page, and the FAQ page. The big "shared" bucket exists because most content is not role-specific, which is a sign the split costs more than it earns. | Collapse to one topic list, optionally with a light "Agent / Brokerage" tag. |
| 8 categories for 22 articles | `index.ts` | Several categories hold 2 to 3 articles. Over-organized. | Cut to 3 or 4 categories. |
| `HelpStepList.tsx` "expected outcome + fallback" convention | 59 | Every step must carry an "Expected:" line and an optional collapsible "what if this fails." That is an authoring burden for routine clicks. | Simplify to plain numbered steps; push genuine warnings into the existing `HelpCallout`. |
| Manual registry | `index.ts` | Every new article must be created, imported, AND appended to a list by hand. | Auto-register by globbing the articles folder (nice-to-have). |

**Keepers (these earn their place):** `HelpCallout` (used in all 22 articles), `HelpArticleBody` (cheap prose styling), and `HelpFeeWorksheet` (the live calculator is a genuine differentiator for a commission-advance product, worth its 184 lines even at one placement).

Removing just the dead screenshot code, the one-use SVG diagram, the command palette, and the duplicate FAQ filter is about **414 lines gone** with no user-visible change. The role/category simplification removes ongoing authoring friction on top of that.

### 3b. Article bloat (22 articles, target 12 to 14)

The single biggest content problem: **the same three concepts are explained 3 to 4 times** across the agent / brokerage / shared folders.

- **Remediation IDP: explained in 4 places.** `shared/what-a-remediation-idp-is`, `agent/pay-remediation-idp`, `brokerage/pay-remediation-remittance`, and again inside `agent/what-happens-if-deal-falls-through`. All four repeat "Irrevocable Direction to Pay," "Article 5.5(b)," "both parties sign in DocuSign." Collapse to one explainer plus at most a short how-to.
- **Settlement window / late strikes / 14-day bump: explained 3 times.** `shared/settlement-window`, `brokerage/settle-a-funded-deal`, and `brokerage/late-strikes-and-the-14-day-bump` all re-explain the "snapshot at funding." Merge late-strikes into settlement-window.
- **24% late interest: explained 3 times.** `shared/late-interest-rules`, `agent/what-happens-if-deal-falls-through`, and `brokerage/pay-remediation-remittance` each re-derive the formula. Pick one canonical home; everyone else links to it.
- **Firm-deal offer flow: explained 3 times.** Two dashboard "tours" re-explain the offer banner that `accept-or-decline-firm-offer` already covers in full.

**Five heaviest individual articles:**

1. `shared/security-and-data` (153 lines): reads like a SOC 2 control list (row-level security, CSP, CSRF, same-origin headers, Postgres internals). A real-estate agent does not need this. Cut to ~5 plain bullets.
2. `shared/late-interest-rules` (141 lines): spells out the compounding exponent, a worked example, a simple-vs-compound digression, AND a "where this lives in the code" section. Cut the digression and the code section.
3. `shared/settlement-window` (140 lines): includes an internal 3-step resolver and a database column name. Cut the internal detail; absorb late-strikes.
4. `agent/account-balance-and-ledger` (131 lines): defines **8 transaction types**, most of which a user will never see. Cut to the 3 that matter.
5. `agent/what-happens-if-deal-falls-through` (124 lines): keep this as the failed-deal hub, but trim the duplicated interest formula and IDP re-explanation down to one-line links.

**A recurring offender worth a global sweep:** almost every "shared" article ends with a **"Where this lives in the code"** section naming `.ts` files and functions (`calculateCompoundDailyInterest`, `effectiveSettlementDays`, `generateRemediationIdpDocx`, `lib/constants.ts`). That belongs in developer docs, not a customer Help Center. Strip it everywhere.

**Jargon that leaks into user copy and should go:** raw database names (`amount_due_from_brokerage`, `settlement_days_at_funding`, `failed_to_close`, `record_brokerage_late_strike` RPC), security terms (CSRF, CSP, row-level security), contract citations ("Article 5.5(b)"), and unexpanded "KYC" (say "ID verification").

**Proposed target article set (12 to 14, down from 22):**

- **Agent (5):** first-time-signing-in, submit-a-deal, upload-ID (rename from "KYC"), update-banking-info, what-happens-if-deal-falls-through (as the single failed-deal hub). Optionally one short dashboard orientation. Fold `account-balance-and-ledger` down to a lean version; fold `pay-remediation-idp` into the hub.
- **Brokerage (4 to 5):** dashboard-tour (short), submit-on-behalf (absorbing accept/decline-offer), settle-a-funded-deal (trimmed), record-a-payment, manage-team-admins. Drop standalone late-strikes and remediation-remittance.
- **Shared (3 to 4):** how-the-advance-is-calculated (with the $10k fix), one settlement-window article (absorbing late-strikes), one Remediation-IDP explainer, one short trust/security + contact page (merge `security-and-data` down, possibly combine with `contacting-firm-funds`).

### 3c. FAQ bloat (28 FAQs, target ~12)

Breakdown today: `agent.tsx` 8, `brokerage.tsx` 8, `shared.tsx` 12. The wordiest entries are concentrated in `shared.tsx`.

**Five FAQs that are near-duplicates of a same-named article (clearest cuts):**

1. "How is my advance calculated?" duplicates the `how-the-advance-is-calculated` article (the FAQ even ends by linking to it).
2. "Which days are charged?" is a subsection of that same article.
3. "What happens if my deal falls through?" duplicates the identically-named article.
4. "What is a Remediation IDP?" duplicates `what-a-remediation-idp-is`.
5. "Is my information secure?" duplicates `security-and-data`.

**Merge into their article instead of standing alone:** the 3 team-admin how-tos ("add a team admin," "difference between the 3 admin roles," "can't find the invite email") all belong inside `manage-team-admins`. The agent "transaction types on the ledger" FAQ is a 55-line glossary of raw database enum values that belongs in the ledger article as a small table, not as an FAQ anyone would actually type.

**Keepers (the good kind of FAQ: short, high-intent, "something surprised me" questions with no same-named article):** why is my approval taking so long, why did my window jump from 7 to 14 days, do we ever pay before closing, my closing date moved, I missed the cure deadline, how do I dispute a late strike, what is the "1 agent is waiting on you" banner, who is Firm Funds, gross vs net commission, what email do you send from.

**Recommendation on the FAQ section as a whole:** for a product this small, the FAQ layer is currently competing with same-named articles, which is the bloat. Either fold the ~12 keepers into the relevant articles, or keep one single FAQ page of about 12 tight entries where **every answer is 2 short plain-English sentences with zero database or code identifiers**. Do not keep both a deep article and a near-identical FAQ for the same topic.

---

## Part 4: The trim plan, ranked by impact vs effort

**Tier 1 (do first: high value, low risk, no judgment calls):**

1. Fix the $50,000 pricing in the 3 user-facing spots and recompute the cascading figures. (Part 1a)
2. Fix the 2 math bugs. (Part 1b)
3. Delete the dead `HelpScreenshot.tsx`. (41 lines, zero usages)
4. Strip every "Where this lives in the code" section and all database/function/column names out of user-facing articles. (Pure developer detail, sweeps across many files.)

**Tier 2 (the real simplification: medium effort, big payoff):**

5. Pick one canonical home each for the 3 repeated concepts (late interest, settlement window, Remediation IDP) and replace the duplicate explanations with one-line links. This is what shrinks the article count from 22 toward ~14.
6. Cut or merge ~14 FAQs down to ~12 keepers. (Part 3c)
7. Rewrite `security-and-data` from a technical control list into ~5 plain-English trust bullets.
8. Unify search: drop the cmdk command palette and the duplicate FAQ filter; keep one simple search input (or just rely on browser Ctrl-F for the article set).

**Tier 3 (structural cleanup: optional, nice-to-have):**

9. Collapse the agent / brokerage / shared role split into one lightly-tagged topic list.
10. Cut categories from 8 to 3 or 4.
11. Replace the one-use `HelpStatusFlowDiagram` SVG with a short list or static image.
12. Simplify `HelpStepList` (drop the mandatory "expected + fallback" convention).
13. Auto-register articles instead of the hand-maintained import list.

**Rough outcome if all three tiers are done:** ~22 articles to ~13, ~28 FAQs to ~12, ~500 to 600 lines of component machinery removed, and the only worked examples a user sees are realistic ($10,000) and arithmetically correct.

---

## Part 5: Exact change list for the edit session

Quick-reference file and line map so the future editing session can move fast. **No edits were made here.**

Pricing ($50k to $10k):
- `content/help/articles/shared/how-the-advance-is-calculated.tsx:26,28` (+ derived figures at 47, 48, 49, 61, 63, 70, 73)
- `content/help/articles/brokerage/settle-a-funded-deal.tsx:51,52` (+ derived 53, 56-57)
- `components/help/HelpFeeWorksheet.tsx:37` (`defaultGross`)
- `content/help/articles/agent/account-balance-and-ledger.tsx:37-38` ($20k to $10k)

Math bugs:
- `content/help/articles/brokerage/settle-a-funded-deal.tsx:53,56-57` (referral fee $273.60 to $281.20; amount due to $47,218.80 at current $50k, or recompute at $10k)
- `content/help/articles/agent/what-happens-if-deal-falls-through.tsx:74-75` (day-120 $556/$10,556 to $544.73/$10,544.73)

Dead / over-built components:
- `components/help/HelpScreenshot.tsx` (delete, 41 lines, 0 usages)
- `components/help/HelpStatusFlowDiagram.tsx` (157 lines, 1 usage)
- `components/help/HelpSearchPalette.tsx` (133 lines) + `components/help/HelpFaqFilter.tsx` (83 lines)

Redundancy hubs (merge work):
- Remediation IDP: `content/help/articles/shared/what-a-remediation-idp-is.tsx`, `content/help/articles/agent/pay-remediation-idp.tsx`, `content/help/articles/brokerage/pay-remediation-remittance.tsx`, `content/help/articles/agent/what-happens-if-deal-falls-through.tsx`
- Settlement: `content/help/articles/shared/settlement-window.tsx`, `content/help/articles/brokerage/late-strikes-and-the-14-day-bump.tsx`, `content/help/articles/brokerage/settle-a-funded-deal.tsx`
- Interest: `content/help/articles/shared/late-interest-rules.tsx` + the failed-deal hub

Heaviest standalone trims:
- `content/help/articles/shared/security-and-data.tsx` (153 lines)
- `content/help/articles/agent/account-balance-and-ledger.tsx` (131 lines)

Metadata to update when articles are merged/cut (sidebar order + categories):
- `content/help/index.ts` and `content/help/types.ts`

FAQ cuts/merges:
- `content/help/faqs/shared.tsx` (the 5 article-duplicates live here)
- `content/help/faqs/agent.tsx` (the transaction-types glossary)
- `content/help/faqs/brokerage.tsx` (the 3 team-admin how-tos)

---

## Appendix: coverage and confidence

What was searched, so the gaps are visible:

- **Structure/IA:** all route files, all 12 `components/help/` files, `content/help/index.ts` and `types.ts`. Component usage counts verified by grepping `content/help/`. Confirmed `public/help/` is absent via shell.
- **Articles:** all 22 article files read in full. Line counts from `wc -l`; word counts are prose estimates (raw `wc -w` is inflated by JSX markup).
- **FAQs:** all 3 FAQ files read in full (28 entries). Each FAQ's `related` array was used to confirm article overlap precisely.
- **Pricing:** all 22 articles, 3 FAQ files, `index.ts`, `types.ts`, all of `components/help/`, plus `lib/calculations.ts`, `lib/constants.ts`, and a repo-wide sweep of `app/**`, `marketing/**`, and the pitch deck.

Confidence notes (per the honesty rule, calibrated):

- The **$50,000 locations** and the **fee worksheet default** are verified by direct file reads.
- The **two math bugs** were re-computed independently in this session (not just taken from the sub-agent): referral fee $281.20 vs $273.60, and day-120 interest $544.73 vs $556. Stated as fact.
- The **"referral fee = 20% of total fees"** relationship is inferred from the article's own numbers ($273.60 = 20% of $1,368). Confirm the intended definition during the edit before locking the corrected figure.
- The **article and FAQ "keep / cut / merge" recommendations** are judgment calls from the content review, not hard rules. They are a strong starting point, but Bud should sign off on the final keep-list before anything is deleted. Targets (~13 articles, ~12 FAQs) are recommendations, not requirements.
- This audit covered the Help Center surface. It did **not** evaluate whether `cmdk` / `components/ui/command` are used elsewhere in the app; if they are help-only, removing the palette also drops that dependency, but that needs a quick check before deletion.
