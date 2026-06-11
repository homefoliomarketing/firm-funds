# Financial Model

_Last updated: 2026-06-09_

This document explains exactly how Firm Funds turns a pending real estate commission into an advance amount, what fees are charged, how the brokerage gets paid, and how late interest accrues, with worked numeric examples tied to the real code.

## 1. What a commission advance is, in plain English

A real estate agent earns a commission when a sale closes, but closing can be weeks away. Firm Funds pays the agent most of that commission now and gets repaid when the deal closes. For providing the money early, Firm Funds keeps a fee. The fee is small for short waits and larger for long waits, because Firm Funds is fronting the money for longer.

All of the math below lives in two files:

- `lib/calculations.ts` (the formulas)
- `lib/constants.ts` (the numbers the formulas use)

All money is in Canadian dollars. The code uses cent-level rounding (`roundToCents`) so the stored numbers always add up exactly with no penny drift.

## 2. The constants (the dials)

Every business number is defined once in `lib/constants.ts`. The code never hardcodes these anywhere else.

| Constant | Value | Meaning |
| --- | --- | --- |
| `DISCOUNT_RATE_PER_1000_PER_DAY` | `0.80` | The core fee rate: 80 cents per $1,000 advanced, per day |
| `DEFAULT_BROKERAGE_REFERRAL_PCT` | `0.20` | Brokerage keeps 20% of the total fees (a 0 to 1 decimal) |
| `SETTLEMENT_PERIOD_DAYS` | `7` | Standard window for the brokerage to remit after closing |
| `BROKERAGE_BUMPED_SETTLEMENT_DAYS` | `14` | Bumped window after a brokerage racks up too many late strikes |
| `BROKERAGE_LATE_STRIKE_THRESHOLD` | `5` | Number of missed settlements that triggers the 14-day bump |
| `LATE_INTEREST_RATE_PER_ANNUM` | `0.24` | 24% per year, true APR, compounded daily |
| `LATE_INTEREST_GRACE_DAYS_FROM_CLOSING` | `30` | No late interest until 30 days past closing; day 31 starts accruing |
| `RETURN_PROCESSING_DAYS` | `0` | Extra chargeable days for return processing (currently 0) |
| `MAX_DAILY_EFT` | `25000` | Largest single-day electronic transfer |
| `MIN_DAYS_UNTIL_CLOSING` | `2` | A deal must be at least 2 days from closing |
| `MAX_DAYS_UNTIL_CLOSING` | `120` | A deal cannot be more than 120 days from closing |
| `MIN_GROSS_COMMISSION` / `MAX_GROSS_COMMISSION` | `1` / `1,000,000` | Sanity bounds on the gross commission |

### A note on percentage formats (this trips people up)

There are two different percentage conventions in this codebase, and mixing them up produces wildly wrong numbers:

- `brokerageSplitPct` (and the DB column `brokerage_split_pct`) is a **whole number**. `5` means 5%. The code divides by 100 exactly once. Passing `0.05` here would treat it as 0.05% and overpay the agent by roughly 99x.
- `brokerageReferralPct` is a **0 to 1 decimal**. `0.20` means 20%. The code multiplies directly. Passing `20` here would compute a 2000% referral and produce a negative profit.

Both conventions are enforced by validation in `validateDealInputs()`.

## 3. Chargeable days: `getChargeDays()`

```
getChargeDays(daysUntilClosing) = max(1, daysUntilClosing + RETURN_PROCESSING_DAYS)
```

The discount fee is charged for each day the advance is outstanding, which runs from the day after funding through and including the closing day:

- The **funding day** is not charged, because the agent receives the funds the day **after** funding.
- The **closing day** is charged, because repayment is not received on the closing day (the brokerage remits afterward).

The chargeable period from the day after funding through the closing day inclusive equals `daysUntilClosing`. With `RETURN_PROCESSING_DAYS = 0`, the effective chargeable days equal `daysUntilClosing`. The `max(1, ...)` floor guarantees at least one chargeable day so a same-week deal never produces a zero or negative fee.

| `daysUntilClosing` | Effective chargeable days |
| --- | --- |
| 30 | 30 |
| 7 | 7 |
| 2 (minimum) | 2 |

## 4. The full deal calculation: `calculateDeal()`

`calculateDeal(input)` takes a `DealCalculation` and returns a `DealResult`. The fields are computed in dependency order so the cent values satisfy these identities exactly:

- `discountFee + settlementPeriodFee === totalFees`
- `netCommission - totalFees === advanceAmount`
- `brokerageReferralFee + firmFundsProfit === totalFees`
- `netCommission - brokerageReferralFee === amountDueFromBrokerage`

### Inputs (`DealCalculation`)

| Field | Format | Notes |
| --- | --- | --- |
| `grossCommission` | dollars | The full commission before the brokerage takes its split |
| `brokerageSplitPct` | whole number | e.g. `5` for 5% |
| `daysUntilClosing` | days | Between 2 and 120 |
| `discountRate` | optional | Defaults to `0.80` |
| `brokerageReferralPct` | optional 0 to 1 | Defaults to `0.20` |
| `settlementPeriodDays` | optional | Defaults to `7`, set to `14` for bumped brokerages |

### The formulas, in order

1. **Net commission** (the agent's share after the brokerage split and any flat fee):
   `netCommission = grossCommission * (1 - brokerageSplitPct / 100) - brokerageFlatFee`
   `brokerageFlatFee` (DB column `brokerage_flat_fee`, default `0`, added in migration 110) is an optional flat dollar fee some brokerages charge on top of the percentage split (e.g. a transaction/admin fee). It is `0` for the vast majority of deals, leaving this identical to the original split-only formula. Set `brokerageSplitPct` to 0 for a flat-fee-only brokerage. The engine rejects a flat fee that meets or exceeds the post-split commission (it would zero out the advance).
2. **Discount fee** (the time-based carrying cost):
   `discountFee = netCommission * (rate / 1000) * effectiveDays`
   where `effectiveDays = getChargeDays(daysUntilClosing)`.
3. **Settlement period fee** (a flat fee covering the post-closing remittance window):
   `settlementPeriodFee = netCommission * (rate / 1000) * settlementPeriodDays`
4. **Total fees:** `discountFee + settlementPeriodFee` (shown in the admin deal Financial Breakdown as **Total Cost to Agent**)
5. **Advance amount** (what the agent actually receives):
   `advanceAmount = netCommission - totalFees`
6. **Brokerage referral fee** (the white-label partner's cut of the fees):
   `brokerageReferralFee = totalFees * referralPct`
7. **Firm Funds profit:** `firmFundsProfit = totalFees - brokerageReferralFee` (shown in the admin deal Financial Breakdown as **Deal Profit**)
8. **Amount due from brokerage** (what the brokerage wires to Firm Funds at closing):
   `amountDueFromBrokerage = netCommission - brokerageReferralFee`
9. **EFT transfer days** (how many days of transfers are needed given the daily cap):
   `eftTransferDays = ceil(advanceAmount / MAX_DAILY_EFT)`

Note that both fees are computed against the **unrounded** net commission for accuracy, then rounded to cents.

### Worked example A: a standard 30-day deal

Inputs: gross commission $10,000, split 30%, 30 days until closing, default rate and referral, 7-day settlement window.

| Step | Calculation | Result |
| --- | --- | --- |
| Net commission | 10,000 x (1 - 0.30) | $7,000.00 |
| Effective days | max(1, 30) | 30 |
| Discount fee | 7,000 x 0.0008 x 30 | $168.00 |
| Settlement period fee | 7,000 x 0.0008 x 7 | $39.20 |
| Total fees | 168.00 + 39.20 | $207.20 |
| Advance amount | 7,000 - 207.20 | $6,792.80 |
| Brokerage referral fee | 207.20 x 0.20 | $41.44 |
| Firm Funds profit | 207.20 - 41.44 | $165.76 |
| Amount due from brokerage | 7,000 - 41.44 | $6,958.56 |

### Worked example B: same gross, but only 2 days until closing

The discount fee shrinks dramatically because the money is only out the door for a moment. The settlement fee is unchanged because it covers the fixed post-closing window.

| Step | Calculation | Result |
| --- | --- | --- |
| Net commission | 10,000 x 0.70 | $7,000.00 |
| Effective days | max(1, 2) | 2 |
| Discount fee | 7,000 x 0.0008 x 2 | $11.20 |
| Settlement period fee | 7,000 x 0.0008 x 7 | $39.20 |
| Total fees | 11.20 + 39.20 | $50.40 |
| Advance amount | 7,000 - 50.40 | $6,949.60 |

### Worked example C: a bigger deal

Inputs: gross commission $20,000, split 20%, 45 days until closing.

| Step | Calculation | Result |
| --- | --- | --- |
| Net commission | 20,000 x (1 - 0.20) | $16,000.00 |
| Effective days | max(1, 45) | 45 |
| Discount fee | 16,000 x 0.0008 x 45 | $576.00 |
| Settlement period fee | 16,000 x 0.0008 x 7 | $89.60 |
| Total fees | 576.00 + 89.60 | $665.60 |
| Advance amount | 16,000 - 665.60 | $15,334.40 |
| Brokerage referral fee | 665.60 x 0.20 | $133.12 |
| Firm Funds profit | 665.60 - 133.12 | $532.48 |

## 5. Brokerage split mechanics (whole-number percentages)

The brokerage split is the slice of the gross commission the brokerage keeps before the agent sees a dollar. It is stored as a whole number in `brokerage_split_pct` and divided by 100 exactly once inside `calculateDeal()`:

`netCommission = grossCommission * (1 - brokerageSplitPct / 100) - brokerageFlatFee`

So a gross commission of $10,000 with a 30% split leaves a $7,000 net commission. If that brokerage also charged a $395 flat transaction fee, the net commission would be $6,605. Everything downstream (fees, advance, referral) is computed off the net commission, never the gross. The flat fee (`brokerage_flat_fee`, migration 110) defaults to 0 and is captured per-deal at submission — it is **not** a brokerage default. This is all separate from the **brokerage referral fee**, which is the partner brokerage's cut of Firm Funds' fees and uses the 0 to 1 decimal convention.

### Referral fee vs. profit share — one number, two columns

The partner brokerage's cut of the fees lives in two columns that mean the same thing: `referral_fee_percentage` (0 to 1 decimal, the canonical value used by `calculateDeal()`, the contract, and the Referral Fees report) and `profit_share_pct` (whole number, used by the funding/snapshot and monthly-statement paths, and the white-label welcome-email trigger). At funding, a non-zero `profit_share_pct` is divided by 100 and overrides `referral_fee_percentage` (see `lib/actions/deal-actions.ts`).

The admin brokerage form (`app/(dashboard)/admin/brokerages/page.tsx`) collects this as a **single "Profit Share %" field** (entered as a whole number, e.g. `20`). On save it writes both columns in lockstep — `referral_fee_percentage = value / 100` and `profit_share_pct = value` — so the two can never diverge and the funding payout always matches the submission estimate. Do not reintroduce a separate referral-fee input; that previously let the two columns drift apart.

## 6. Late payment interest

If a deal closes but the brokerage does not remit on time, the unpaid balance starts accruing interest, but only after a grace period.

### The rate

24% per year, expressed as a true APR compounded daily. The daily rate is **not** `0.24 / 365`. That naive split would compound to roughly 27.1% effective over a year. Instead the code uses:

`dailyRate = (1 + 0.24)^(1/365) - 1`, which is approximately `0.0005895`.

This compounds to exactly 24% over 365 days, matching the contract's plain reading of "24% per annum compounded daily." The closed-form total is:

`interest = principal * ((1 + dailyRate)^daysOverdue - 1)`

This is implemented in `calculateCompoundDailyInterest(principal, accrualStartDate, currentDate)`.

### The 30-day grace and the anchor date

Interest does not accrue during the first 30 days after closing. `lateInterestAccrualStartDate(closingDate)` returns `closing + 30 days`. That returned date is the **anchor**: the function computes 0 interest on the anchor itself and one day's worth on `anchor + 1` (which is `closing + 31`). So the first non-zero accrual lands on day 31, matching the rule "accrual starts day 31 after closing."

`calculateLateInterest()` wires the closing date and anchor into the compound formula, and `liveLateInterestOwed()` computes the live figure as of today for display in the UI.

All of the date arithmetic anchors at noon UTC rather than midnight so a daylight-saving transition inside the window cannot tip the calendar date by a day.

### Worked example: late interest on a $46,132 advance

Advance $46,132, closing date 2026-05-26, valued as of 2026-07-25.

| Step | Calculation | Result |
| --- | --- | --- |
| Anchor (closing + 30) | 2026-05-26 + 30 days | 2026-06-25 |
| Days overdue | 2026-06-25 to 2026-07-25 | 30 |
| Daily rate | (1.24)^(1/365) - 1 | ~0.0005895 |
| Total interest | 46,132 x ((1.0005895)^30 - 1) | ~$822.05 |

One day of interest on the same principal (day 31 only) would be approximately `46,132 x 0.0005895`, about $27.20.

## 7. Failed-deal interest (the cure path)

A deal that closes late is different from a deal that **fails to close**. When a funded deal fails, the agent owes back the advanced principal, and that balance compounds at the same 24% rate, with its own 30-day grace measured from the failure timestamp.

- `FAILED_DEAL_GRACE_DAYS = 30`
- `failedDealAccrualStartDate(failedToCloseAt)` resolves the failure timestamp to a Toronto calendar date, then returns that date + 30 days as the anchor (last grace day, 0 interest), so day 31 is the first accruing day.
- `liveFailedDealInterestOwed(principal, failedToCloseAt, asOfDate?)` returns the live interest owed right now, including accrual not yet posted to the ledger by the monthly cron.

This live figure is what the admin sees in the Remediation IDP modal, and it becomes the directed amount on a Remediation IDP at signing time. See `deal-lifecycle.md` for the full failed-deal and cure flow.

## 8. Agent ledger statement entries (advance issued / repayment received)

The agent ledger (`agent_transactions` + `agents.account_balance`) is the running record of money between the agent and Firm Funds. `account_balance` itself only tracks what the agent **owes** (interest, failed-deal debt, manual adjustments, credits) — a clean advance the brokerage repays is not agent debt.

To make the ledger read like a statement anyway, two **informational** entries are posted (migration 106): **Advance Issued** (`deal_advance`) when a deal is funded, for `amount_due_from_brokerage`, and **Repayment Received** (`deal_repayment`) when a brokerage payment is confirmed received. They are written via the balance-neutral `record_agent_statement_entry` RPC, so they do **not** move `account_balance` and never affect any of the interest or netting math above. On a clean deal they net to zero. Full mechanics in `deal-lifecycle.md` §6.

## 9. Currency formatting

`formatCurrency(amount)` renders any number as CAD using `Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })`. A duplicate helper with the same behavior also exists inside `lib/email.ts` for email bodies.
