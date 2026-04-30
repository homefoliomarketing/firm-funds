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
  LATE_INTEREST_RATE_PER_ANNUM,
  RETURN_PROCESSING_DAYS,
} from './constants'

export interface DealCalculation {
  grossCommission: number
  brokerageSplitPct: number // e.g., 20 means brokerage keeps 20%, agent keeps 80%
  daysUntilClosing: number
  discountRate?: number
  brokerageReferralPct?: number // per-deal negotiable (0-1 decimal)
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

  // Agent's net commission after brokerage split
  const netCommission = input.grossCommission * (1 - input.brokerageSplitPct / 100)

  // Discount fee: net commission × ($0.75 / $1,000) × days
  // -1 because: agent receives funds day AFTER funding, and closing day is repayment (not charged)
  // So: days charged = daysUntilClosing - 1 + RETURN_PROCESSING_DAYS (see getChargeDays)
  const effectiveDays = getChargeDays(input.daysUntilClosing)
  const discountFee = netCommission * (rate / 1000) * effectiveDays

  // Settlement Period Fee: same rate × 14 days
  // This is a flat, non-refundable fee that covers the 14-day brokerage payment window
  const settlementPeriodFee = netCommission * (rate / 1000) * SETTLEMENT_PERIOD_DAYS

  // Total fees charged to the agent
  const totalFees = discountFee + settlementPeriodFee

  // What the agent receives
  const advanceAmount = netCommission - totalFees

  // Brokerage (white-label partner) gets a cut of the TOTAL fees — both the
  // discount fee AND the 14-day settlement period fee.
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
 * Calculate late payment interest.
 * 24% per annum, charged daily, starting the day after the 14-day settlement period expires.
 * @param advanceAmount - The amount advanced to the agent
 * @param dueDate - Payment due date (closing_date + 14 days) — YYYY-MM-DD
 * @param currentDate - The date to calculate interest through — YYYY-MM-DD
 * @returns Interest amount (0 if not yet past due date)
 */
export function calculateLateInterest(
  advanceAmount: number,
  dueDate: string,
  currentDate: string,
): number {
  const dueMs = new Date(dueDate + 'T00:00:00Z').getTime()
  const currentMs = new Date(currentDate + 'T00:00:00Z').getTime()
  const daysOverdue = Math.floor((currentMs - dueMs) / (1000 * 60 * 60 * 24))

  // No interest if on or before due date
  if (daysOverdue <= 0) return 0

  // 24% per annum, simple daily rate
  const dailyRate = LATE_INTEREST_RATE_PER_ANNUM / 365
  const interest = advanceAmount * dailyRate * daysOverdue

  return roundToCents(interest)
}

/**
 * Calculate 1 day of late payment interest (for daily cron charging).
 */
export function calculateDailyLateInterest(advanceAmount: number): number {
  const dailyRate = LATE_INTEREST_RATE_PER_ANNUM / 365
  return roundToCents(advanceAmount * dailyRate)
}

// Format currency for display
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(amount)
}
