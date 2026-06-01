// Firm Funds Financial Calculations
// All monetary values are in CAD
// Uses integer-cents arithmetic to avoid floating-point errors
//
// ============================================================================
// DATE & TIMEZONE CONVENTIONS
// ============================================================================
// All date INPUTS and OUTPUTS in this module are Toronto-local calendar dates
// in YYYY-MM-DD format unless explicitly noted otherwise (e.g. `failedToCloseAt`
// is an ISO timestamp because it comes straight from a Postgres `timestamptz`).
//
// When a function needs to do calendar-date arithmetic (e.g. "30 days after
// closing"), it anchors the calculation at NOON UTC of the input date — never
// midnight. Reason: midnight UTC is 19:00–20:00 Toronto the previous day,
// which lands within an hour of the date boundary. If the +N-day window
// crosses a DST transition (March spring-forward or November fall-back), the
// ±1 hour shift caused by working in raw UTC milliseconds can tip the
// resulting calendar date by one day. Anchoring at noon UTC (07:00–08:00
// Toronto) leaves a multi-hour buffer on both sides of any DST shift, so the
// result lands on the right calendar day in every case.
//
// See CLAUDE.md "Financial Rules" section for the canonical spec these
// calculations implement. Discrepancies between this file and that section
// should be treated as bugs in this file, not in the spec.
// ============================================================================

import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  DEFAULT_BROKERAGE_REFERRAL_PCT,
  MAX_DAILY_EFT,
  MIN_GROSS_COMMISSION,
  MAX_GROSS_COMMISSION,
  MIN_DAYS_UNTIL_CLOSING,
  MAX_DAYS_UNTIL_CLOSING,
  SETTLEMENT_PERIOD_DAYS,
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
  LATE_INTEREST_RATE_PER_ANNUM,
  LATE_INTEREST_GRACE_DAYS_FROM_CLOSING,
  RETURN_PROCESSING_DAYS,
} from './constants'

/**
 * The brokerage settlement-window inputs that influence `effectiveSettlementDays`.
 * Matches the shape of the `brokerages` row columns added in migration 047.
 */
export interface BrokerageSettlementInputs {
  settlement_days_override?: number | null
  auto_bumped_to_14_days_at?: string | null
}

/**
 * Resolve the brokerage's effective settlement window (in days), in priority order:
 *   1. Admin manual override (`settlement_days_override`)
 *   2. Auto-bump after BROKERAGE_LATE_STRIKE_THRESHOLD strikes (`auto_bumped_to_14_days_at` non-null)
 *   3. Standard SETTLEMENT_PERIOD_DAYS (currently 7)
 */
export function effectiveSettlementDays(brokerage: BrokerageSettlementInputs | null | undefined): number {
  if (!brokerage) return SETTLEMENT_PERIOD_DAYS
  const override = brokerage.settlement_days_override
  if (override != null && override > 0) return override
  if (brokerage.auto_bumped_to_14_days_at) return BROKERAGE_BUMPED_SETTLEMENT_DAYS
  return SETTLEMENT_PERIOD_DAYS
}

export interface DealCalculation {
  grossCommission: number
  /**
   * Brokerage split as a WHOLE NUMBER, NOT a decimal.
   * e.g. 20 means the brokerage keeps 20% of the gross, the agent keeps 80%.
   * NEVER pass 0.20 here — that would compute against 0.2% and blow up
   * netCommission by 99x. The database column `brokerage_split_pct` stores
   * whole numbers under the same convention (see CLAUDE.md Financial Rules).
   */
  brokerageSplitPct: number
  daysUntilClosing: number
  discountRate?: number
  /**
   * Brokerage referral fee share, as a 0-1 DECIMAL (NOT a whole number).
   * e.g. 0.20 means the brokerage keeps 20% of (discountFee + settlementPeriodFee).
   * NEVER pass 20 here — that would compute a 2000% referral and produce
   * a negative firmFundsProfit. Per-deal override, otherwise defaults to
   * DEFAULT_BROKERAGE_REFERRAL_PCT (0.20).
   */
  brokerageReferralPct?: number
  /**
   * Override the settlement-period days used for the settlement-period fee.
   * Defaults to SETTLEMENT_PERIOD_DAYS (7). Set to BROKERAGE_BUMPED_SETTLEMENT_DAYS (14)
   * when the brokerage has been auto-bumped after the 5-strike threshold.
   */
  settlementPeriodDays?: number
}

export interface DealResult {
  netCommission: number
  discountFee: number
  settlementPeriodFee: number
  totalFees: number // discountFee + settlementPeriodFee
  advanceAmount: number // netCommission - totalFees
  brokerageReferralFee: number // referralPct × (discountFee + settlementPeriodFee)
  firmFundsProfit: number
  amountDueFromBrokerage: number
  eftTransferDays: number
  effectiveDays: number // the actual chargeable days used for the discount fee
}

/** Round to cents using integer math to avoid floating-point errors */
function roundToCents(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Returns the number of chargeable days used for the discount fee, given
 * days-until-closing. The agent receives the funds the day AFTER the Funding
 * Date, so the Funding Date itself is not charged. The Closing Date IS charged,
 * because repayment is not received until after closing. The chargeable period
 * therefore runs from the day after funding through and including the closing
 * day, which equals daysUntilClosing (+ RETURN_PROCESSING_DAYS).
 * Minimum of 1 to prevent zero/negative charges.
 *
 * Worked example: daysUntilClosing = 30, RETURN_PROCESSING_DAYS = 0
 *   → chargeDays = max(1, 30 + 0) = 30 days.
 * Worked example: daysUntilClosing = 2 (minimum), RETURN_PROCESSING_DAYS = 0
 *   → chargeDays = max(1, 2 + 0) = 2 days.
 */
export function getChargeDays(daysUntilClosing: number): number {
  return Math.max(1, daysUntilClosing + RETURN_PROCESSING_DAYS)
}

/** Validate deal calculation inputs. Throws if invalid. */
function validateDealInputs(input: DealCalculation): void {
  if (input.grossCommission < MIN_GROSS_COMMISSION || input.grossCommission > MAX_GROSS_COMMISSION) {
    throw new Error(`Gross commission must be between $${MIN_GROSS_COMMISSION} and $${MAX_GROSS_COMMISSION.toLocaleString()}`)
  }
  // brokerageSplitPct is a WHOLE NUMBER (5 = 5%), NOT a decimal. See DealCalculation jsdoc.
  if (input.brokerageSplitPct < 0 || input.brokerageSplitPct > 100) {
    throw new Error('Brokerage split percentage must be between 0 and 100')
  }
  if (input.daysUntilClosing < MIN_DAYS_UNTIL_CLOSING || input.daysUntilClosing > MAX_DAYS_UNTIL_CLOSING) {
    throw new Error(`Days until closing must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING}`)
  }
  if (input.discountRate !== undefined && (input.discountRate <= 0 || input.discountRate > 10)) {
    throw new Error('Discount rate must be between 0 and 10')
  }
  // brokerageReferralPct is a 0-1 DECIMAL (0.20 = 20%), NOT a whole number. See DealCalculation jsdoc.
  if (input.brokerageReferralPct !== undefined && (input.brokerageReferralPct < 0 || input.brokerageReferralPct > 1)) {
    throw new Error('Brokerage referral percentage must be between 0 and 1')
  }
}

/**
 * Compute the full deal result (fees, advance, brokerage payout, etc.) for a
 * given commission/split/timeline.
 *
 * Worked example A — standard deal:
 *   grossCommission $50,000, brokerageSplitPct = 5 (5%), daysUntilClosing = 30,
 *   rate = $0.80/$1,000/day, referralPct = 0.20, settlementPeriodDays = 7.
 *   netCommission = 50,000 × (1 - 0.05) = $47,500.00
 *   effectiveDays = max(1, 30) = 30
 *   discountFee = 47,500 × 0.0008 × 30 = $1,140.00
 *   settlementPeriodFee = 47,500 × 0.0008 × 7 = $266.00
 *   totalFees = $1,406.00; advanceAmount = 47,500 - 1,406 = $46,094.00
 *   brokerageReferralFee = 1,406 × 0.20 = $281.20
 *   firmFundsProfit = 1,406 - 281.20 = $1,124.80
 *   amountDueFromBrokerage = 47,500 - 281.20 = $47,218.80
 *
 * Worked example B — same gross, MUCH shorter timeline:
 *   grossCommission $50,000, brokerageSplitPct = 5, daysUntilClosing = 2.
 *   effectiveDays = max(1, 2) = 2
 *   discountFee = 47,500 × 0.0008 × 2 = $76.00
 *   settlementPeriodFee unchanged = $266.00; totalFees = $342.00.
 *   advanceAmount = $47,158.00 (much higher payout — small carrying cost).
 */
export function calculateDeal(input: DealCalculation): DealResult {
  // Validate inputs
  validateDealInputs(input)

  const rate = input.discountRate ?? DISCOUNT_RATE_PER_1000_PER_DAY
  const referralPct = input.brokerageReferralPct ?? DEFAULT_BROKERAGE_REFERRAL_PCT
  const settlementDays = input.settlementPeriodDays ?? SETTLEMENT_PERIOD_DAYS

  // Funding day is not charged (agent receives funds the next day); the closing
  // day IS charged (repayment is not received until after closing). So days
  // charged = daysUntilClosing + RETURN_PROCESSING_DAYS (see getChargeDays).
  const effectiveDays = getChargeDays(input.daysUntilClosing)

  // Round in dependency order so the returned cent values satisfy the
  // accounting identities exactly (no ¢ drift from independent rounding):
  //   discountFee + settlementPeriodFee === totalFees
  //   netCommission - totalFees === advanceAmount
  //   brokerageReferralFee + firmFundsProfit === totalFees
  //   netCommission - brokerageReferralFee === amountDueFromBrokerage

  // 1. Net commission after brokerage split (anchor for everything downstream).
  //    brokerageSplitPct is a WHOLE NUMBER — divide by 100 once here.
  //    e.g. 5 → 0.05 → keep 95% of gross.
  const netCommission = roundToCents(input.grossCommission * (1 - input.brokerageSplitPct / 100))

  // 2. Discount fee: net commission × ($0.80 / $1,000) × effective days.
  //    Settlement Period Fee: same rate × settlement-window days (7 standard,
  //    14 for brokerages auto-bumped after 5 strikes). Flat, non-refundable
  //    fee covering the brokerage payment window after closing.
  //    Both rounded against unrounded netCommission for accuracy.
  const unroundedNet = input.grossCommission * (1 - input.brokerageSplitPct / 100)
  const discountFee = roundToCents(unroundedNet * (rate / 1000) * effectiveDays)
  const settlementPeriodFee = roundToCents(unroundedNet * (rate / 1000) * settlementDays)

  // 3. Sum of two 2-decimal numbers is exact, no re-round.
  const totalFees = discountFee + settlementPeriodFee

  // 4. Derived from rounded values, no re-round.
  const advanceAmount = netCommission - totalFees

  // 5. Brokerage (white-label partner) gets a cut of the TOTAL fees.
  //    referralPct is a 0-1 DECIMAL — multiply directly, do NOT /100.
  //    e.g. 0.20 → brokerage keeps 20% of fees, Firm Funds keeps 80%.
  //    Round once; firmFundsProfit derives from the rounded value.
  const brokerageReferralFee = roundToCents(totalFees * referralPct)

  // 6. Firm Funds keeps whatever's left of total fees after the brokerage share.
  const firmFundsProfit = totalFees - brokerageReferralFee

  // 7. What brokerage sends to Firm Funds at closing.
  const amountDueFromBrokerage = netCommission - brokerageReferralFee

  // How many days of EFT transfers needed
  const eftTransferDays = Math.ceil(advanceAmount / MAX_DAILY_EFT)

  return {
    netCommission,
    discountFee,
    settlementPeriodFee,
    totalFees,
    advanceAmount,
    brokerageReferralFee,
    firmFundsProfit,
    amountDueFromBrokerage,
    eftTransferDays,
    effectiveDays,
  }
}

/**
 * Late-payment interest grace start: interest does not accrue until the deal is
 * 30 days past the closing date. The 7-day settlement window and the 8-30 day
 * follow-up window are penalty-free.
 *
 * Returns the date used as the accrual ANCHOR for compound interest math:
 * `calculateCompoundDailyInterest` computes 0 interest on this exact date and
 * 1 day's worth on (anchor + 1 day). So with LATE_INTEREST_GRACE_DAYS_FROM_CLOSING
 * = 30, the function returns `closing + 30 days`; the first NON-ZERO accrual
 * shows up on `closing + 31 days`, matching the spec's "accrual starts day 31
 * after closing (30-day grace)".
 *
 * Worked example: closingDate = "2026-05-26"
 *   anchor (returned) = "2026-06-25" (May 26 + 30 days; last grace day, 0 interest)
 *   first accruing day = "2026-06-26" (May 26 + 31 days; 1 day of interest)
 *
 * @param closingDate - YYYY-MM-DD (Toronto), the deal's closing date
 * @returns YYYY-MM-DD (Toronto), the compound-interest anchor (closing + 30)
 */
export function lateInterestAccrualStartDate(closingDate: string): string {
  // Anchor at noon UTC so a DST shift inside the +30-day window can't tip the
  // calendar date (see DATE & TIMEZONE CONVENTIONS header at top of file).
  const closingMs = new Date(closingDate + 'T12:00:00Z').getTime()
  const accrualStartMs = closingMs + LATE_INTEREST_GRACE_DAYS_FROM_CLOSING * 24 * 60 * 60 * 1000
  return new Date(accrualStartMs).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
}

/**
 * Calculate total compound late-payment interest accrued from day 31 after
 * closing through `currentDate`. Returns 0 while still in the 30-day grace.
 *
 * Math: 24% per annum compounded daily on the advance amount, identical to
 * `calculateCompoundDailyInterest` but anchored to the closing date + 30 days.
 *
 * Worked example: advance $46,132, closing "2026-05-26", currentDate "2026-07-25"
 *   anchor = "2026-06-25" (closing + 30); daysOverdue from "2026-06-25" to
 *   "2026-07-25" = 30 days.
 *   dailyRate = (1.24)^(1/365) - 1 ≈ 0.0005895
 *   total = 46,132 × ((1.0005895)^30 - 1) ≈ 46,132 × 0.01782 ≈ $822.05
 *
 * @param advanceAmount - The amount advanced to the agent
 * @param closingDate - YYYY-MM-DD, the deal's closing date
 * @param currentDate - YYYY-MM-DD, the day to compute total accrued through
 */
export function calculateLateInterest(
  advanceAmount: number,
  closingDate: string,
  currentDate: string,
): number {
  const accrualStart = lateInterestAccrualStartDate(closingDate)
  return calculateCompoundDailyInterest(advanceAmount, accrualStart, currentDate)
}

/**
 * Total compound late-payment interest owed RIGHT NOW on a still-unpaid deal.
 * Computed live (includes accrual not yet posted to the ledger by the monthly
 * cron). Use for the live liability shown in admin/agent UI.
 */
export function liveLateInterestOwed(
  advanceAmount: number,
  closingDate: string,
  asOfDate?: string,
): number {
  const today = asOfDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  return calculateLateInterest(advanceAmount, closingDate, today)
}

/**
 * Compound daily interest at 24% p.a. on an unpaid balance.
 *
 * Returns the TOTAL interest accrued from accrualStartDate to currentDate
 * using the closed-form: principal × ((1 + dailyRate)^daysOverdue - 1).
 * Equivalent to charging dailyRate on (principal + prior accrued interest)
 * every day, but computed as a single expression for idempotency.
 *
 * Note on the anchor: `daysOverdue = floor((current - start) / day)`, so
 * passing `start === current` returns 0. The interpretation is "interest
 * begins accruing FROM the anchor, with the first day's accrual visible on
 * (anchor + 1 day)". Callers (lateInterestAccrualStartDate,
 * failedDealAccrualStartDate) deliberately return the LAST grace day as the
 * anchor so this 0-on-anchor / non-zero-on-anchor+1 behaviour lines up with
 * the spec's "day 31 starts accruing".
 *
 * Used for CPA 5.3 failed-to-close balances, which compound daily on the
 * unpaid balance (principal + prior accrued interest). Returns 0 if the
 * accrual start date hasn't yet been reached (e.g. still in the 30-day
 * grace period after the demand notice).
 *
 * Worked example: principal $10,000, accrualStart "2026-06-25",
 *   currentDate "2026-06-26" → daysOverdue = 1
 *   dailyRate = (1.24)^(1/365) - 1 ≈ 0.0005895
 *   interest = 10,000 × ((1.0005895)^1 - 1) ≈ $5.90 (one day's worth).
 *
 * @param principal - The unpaid principal at the moment accrual begins
 * @param accrualStartDate - YYYY-MM-DD, the compound-interest anchor (last grace day)
 * @param currentDate - YYYY-MM-DD, the day to compute total accrued through
 */
export function calculateCompoundDailyInterest(
  principal: number,
  accrualStartDate: string,
  currentDate: string,
): number {
  // Use noon UTC for both endpoints so a DST cross inside the interval can't
  // shift daysOverdue by ±1 (see DATE & TIMEZONE CONVENTIONS header).
  const startMs = new Date(accrualStartDate + 'T12:00:00Z').getTime()
  const currentMs = new Date(currentDate + 'T12:00:00Z').getTime()
  const daysOverdue = Math.floor((currentMs - startMs) / (1000 * 60 * 60 * 24))

  if (daysOverdue <= 0) return 0

  // Daily rate that compounds to exactly LATE_INTEREST_RATE_PER_ANNUM (24%)
  // over 365 days. The naive `rate / 365` decomposition compounds to ~27.1%
  // effective APR over the year — matching the contract's plain reading of
  // "24% per annum compounded daily" requires (1 + r_annual)^(1/365) - 1.
  const dailyRate = Math.pow(1 + LATE_INTEREST_RATE_PER_ANNUM, 1 / 365) - 1
  const totalBalance = principal * Math.pow(1 + dailyRate, daysOverdue)
  return roundToCents(totalBalance - principal)
}

/**
 * Failed-deal interest accrual: days 1-30 after `failed_to_close_at` are
 * grace (CPA 5.3); accrual begins on day 31 ("the thirty-first (31st) day").
 */
export const FAILED_DEAL_GRACE_DAYS = 30

/**
 * Compound-interest anchor for a failed deal (YYYY-MM-DD, Toronto).
 *
 * Returns `failed_to_close_at` + 30 days, evaluated in Toronto local time.
 * This is the LAST GRACE DAY — passed to `calculateCompoundDailyInterest`
 * it produces 0 interest on the anchor itself and 1 day's worth on
 * (anchor + 1 day = day 31), matching CPA 5.3's "from the thirty-first
 * (31st) day".
 *
 * Implementation note (BUG FIX): the previous version called
 * `failedAt.getTime() + 30 * 86400 * 1000` on the raw ISO timestamp, then
 * formatted in Toronto. If `failedToCloseAt` was near midnight Toronto AND
 * the +30-day window crossed a DST transition, the ±1-hour wall-clock shift
 * from working in raw UTC milliseconds could tip the resulting Toronto
 * calendar date by one day. Example:
 *   failed_to_close_at = "2026-03-08T04:00:00Z" (Mar 7 23:00 EST in Toronto)
 *   buggy: +30 UTC days → "2026-04-07T04:00:00Z" → Apr 7 00:00 EDT → "2026-04-07"
 *   correct: Mar 7 (Toronto) + 30 days = "2026-04-06"
 * The fix is to (a) resolve the failed timestamp to a Toronto calendar date
 * first, then (b) re-anchor at noon UTC of that date for the +30-day math,
 * which keeps the wall clock multiple hours from midnight regardless of DST.
 *
 * Worked example (no DST involved):
 *   failed_to_close_at = "2026-05-27T01:00:00Z" (May 26 21:00 EDT in Toronto)
 *   → failedDateInToronto = "2026-05-26"
 *   → anchor (returned) = "2026-06-25" (May 26 + 30; last grace day, 0 interest)
 *   → day 31 = "2026-06-26" (first day interest accrues)
 *
 * @param failedToCloseAt - ISO timestamp (typically from a Postgres timestamptz)
 * @returns YYYY-MM-DD (Toronto), the compound-interest anchor (failed date + 30)
 */
export function failedDealAccrualStartDate(failedToCloseAt: string): string {
  // 1. Resolve the timestamp to a Toronto calendar date first. This collapses
  //    the timestamp's UTC time-of-day, which is where the DST-cross bug
  //    originated.
  const failedDateInToronto = new Date(failedToCloseAt).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  // 2. Re-anchor at noon UTC of that Toronto date so the +30-day math stays
  //    multiple hours from any date boundary (see DATE & TIMEZONE CONVENTIONS).
  const failedDate = new Date(failedDateInToronto + 'T12:00:00Z')
  const accrualStartMs = failedDate.getTime() + FAILED_DEAL_GRACE_DAYS * 24 * 60 * 60 * 1000
  return new Date(accrualStartMs).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
}

/**
 * Total compound interest owed RIGHT NOW on a failed deal — principal × growth
 * from day 31 to `asOfDate`. Use this for the live liability shown in the
 * admin Remediation IDP modal and as the directed amount on a Remediation IDP
 * at signing time. Includes accrual that hasn't yet been posted to the ledger
 * (interest posts monthly via the daily cron's month-boundary check).
 */
export function liveFailedDealInterestOwed(
  principal: number,
  failedToCloseAt: string,
  asOfDate?: string,
): number {
  const today = asOfDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const accrualStart = failedDealAccrualStartDate(failedToCloseAt)
  return calculateCompoundDailyInterest(principal, accrualStart, today)
}

// Format currency for display
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(amount)
}
