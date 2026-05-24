// Firm Funds Financial Calculations
// All monetary values are in CAD
// Uses integer-cents arithmetic to avoid floating-point errors

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
  brokerageSplitPct: number // e.g., 20 means brokerage keeps 20%, agent keeps 80%
  daysUntilClosing: number
  discountRate?: number
  brokerageReferralPct?: number // per-deal negotiable (0-1 decimal)
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
 * days-until-closing. Funds arrive the day AFTER funding and closing day
 * itself isn't charged, so effective days = daysUntilClosing - 1 + RETURN_PROCESSING_DAYS.
 * Minimum of 1 to prevent zero/negative charges.
 */
export function getChargeDays(daysUntilClosing: number): number {
  return Math.max(1, daysUntilClosing - 1 + RETURN_PROCESSING_DAYS)
}

/** Validate deal calculation inputs. Throws if invalid. */
function validateDealInputs(input: DealCalculation): void {
  if (input.grossCommission < MIN_GROSS_COMMISSION || input.grossCommission > MAX_GROSS_COMMISSION) {
    throw new Error(`Gross commission must be between $${MIN_GROSS_COMMISSION} and $${MAX_GROSS_COMMISSION.toLocaleString()}`)
  }
  if (input.brokerageSplitPct < 0 || input.brokerageSplitPct > 100) {
    throw new Error('Brokerage split percentage must be between 0 and 100')
  }
  if (input.daysUntilClosing < MIN_DAYS_UNTIL_CLOSING || input.daysUntilClosing > MAX_DAYS_UNTIL_CLOSING) {
    throw new Error(`Days until closing must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING}`)
  }
  if (input.discountRate !== undefined && (input.discountRate <= 0 || input.discountRate > 10)) {
    throw new Error('Discount rate must be between 0 and 10')
  }
  if (input.brokerageReferralPct !== undefined && (input.brokerageReferralPct < 0 || input.brokerageReferralPct > 1)) {
    throw new Error('Brokerage referral percentage must be between 0 and 1')
  }
}

export function calculateDeal(input: DealCalculation): DealResult {
  // Validate inputs
  validateDealInputs(input)

  const rate = input.discountRate ?? DISCOUNT_RATE_PER_1000_PER_DAY
  const referralPct = input.brokerageReferralPct ?? DEFAULT_BROKERAGE_REFERRAL_PCT
  const settlementDays = input.settlementPeriodDays ?? SETTLEMENT_PERIOD_DAYS

  // Agent's net commission after brokerage split
  const netCommission = input.grossCommission * (1 - input.brokerageSplitPct / 100)

  // Discount fee: net commission × ($0.80 / $1,000) × days
  // -1 because: agent receives funds day AFTER funding, and closing day is repayment (not charged)
  // So: days charged = daysUntilClosing - 1 + RETURN_PROCESSING_DAYS (see getChargeDays)
  const effectiveDays = getChargeDays(input.daysUntilClosing)
  const discountFee = netCommission * (rate / 1000) * effectiveDays

  // Settlement Period Fee: same rate × settlement-window days (7 standard, 14 for
  // brokerages auto-bumped after 5 strikes). Flat, non-refundable fee covering
  // the brokerage payment window after closing.
  const settlementPeriodFee = netCommission * (rate / 1000) * settlementDays

  // Total fees charged to the agent
  const totalFees = discountFee + settlementPeriodFee

  // What the agent receives
  const advanceAmount = netCommission - totalFees

  // Brokerage (white-label partner) gets a cut of the TOTAL fees — both the
  // discount fee AND the settlement-period fee.
  const brokerageReferralFee = totalFees * referralPct

  // Firm Funds keeps whatever's left of the total fees after the brokerage share.
  const firmFundsProfit = totalFees - brokerageReferralFee

  // What brokerage sends to Firm Funds at closing (net commission minus their referral fee)
  const amountDueFromBrokerage = netCommission - brokerageReferralFee

  // How many days of EFT transfers needed
  const eftTransferDays = Math.ceil(advanceAmount / MAX_DAILY_EFT)

  return {
    netCommission: roundToCents(netCommission),
    discountFee: roundToCents(discountFee),
    settlementPeriodFee: roundToCents(settlementPeriodFee),
    totalFees: roundToCents(totalFees),
    advanceAmount: roundToCents(advanceAmount),
    brokerageReferralFee: roundToCents(brokerageReferralFee),
    firmFundsProfit: roundToCents(firmFundsProfit),
    amountDueFromBrokerage: roundToCents(amountDueFromBrokerage),
    eftTransferDays,
    effectiveDays,
  }
}

/**
 * Late-payment interest grace start: interest does not accrue until the deal is
 * 30 days past the closing date. The 7-day settlement window and the 8-30 day
 * follow-up window are penalty-free.
 *
 * @param closingDate - YYYY-MM-DD, the deal's closing date
 * @returns YYYY-MM-DD, the day interest first begins accruing (closing + 30)
 */
export function lateInterestAccrualStartDate(closingDate: string): string {
  const closingMs = new Date(closingDate + 'T00:00:00Z').getTime()
  const accrualStartMs = closingMs + LATE_INTEREST_GRACE_DAYS_FROM_CLOSING * 24 * 60 * 60 * 1000
  return new Date(accrualStartMs).toISOString().slice(0, 10)
}

/**
 * Calculate total compound late-payment interest accrued from day 31 after
 * closing through `currentDate`. Returns 0 while still in the 30-day grace.
 *
 * Math: 24% per annum compounded daily on the advance amount, identical to
 * `calculateCompoundDailyInterest` but anchored to the closing date + 30 days.
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
 * Used for CPA 5.3 failed-to-close balances, which compound daily on the
 * unpaid balance (principal + prior accrued interest). Returns 0 if the
 * accrual start date hasn't yet been reached (e.g. still in the 30-day
 * grace period after the demand notice).
 *
 * @param principal - The unpaid principal at the moment accrual begins
 * @param accrualStartDate - YYYY-MM-DD, the day interest begins accruing
 * @param currentDate - YYYY-MM-DD, the day to compute total accrued through
 */
export function calculateCompoundDailyInterest(
  principal: number,
  accrualStartDate: string,
  currentDate: string,
): number {
  const startMs = new Date(accrualStartDate + 'T00:00:00Z').getTime()
  const currentMs = new Date(currentDate + 'T00:00:00Z').getTime()
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

/** Day-31 accrual-start date (YYYY-MM-DD, Toronto) for a failed deal. */
export function failedDealAccrualStartDate(failedToCloseAt: string): string {
  const failedAt = new Date(failedToCloseAt)
  const accrualStartMs = failedAt.getTime() + FAILED_DEAL_GRACE_DAYS * 24 * 60 * 60 * 1000
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
