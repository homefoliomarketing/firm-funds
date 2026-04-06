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
  LATE_CLOSING_GRACE_DAYS,
  RETURN_PROCESSING_DAYS,
} from './constants'

export interface DealCalculation {
  grossCommission: number
  brokerageSplitPct: number // e.g., 20 means brokerage keeps 20%, agent keeps 80%
  daysUntilClosing: number
  discountRate?: number
  brokerageReferralPct?: number
}

export interface DealResult {
  netCommission: number
  discountFee: number
  advanceAmount: number
  brokerageReferralFee: number
  firmFundsProfit: number
  amountDueFromBrokerage: number
  eftTransferDays: number
}

/** Round to cents using integer math to avoid floating-point errors */
function roundToCents(value: number): number {
  return Math.round(value * 100) / 100
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

  // Discount fee: net commission x ($0.75 / $1,000) x days
  // -1 because: agent receives funds day AFTER funding, and closing day is repayment (not charged)
  // So: days charged = daysUntilClosing - 1 + RETURN_PROCESSING_DAYS
  // Example: Fund April 6, closing April 16 → 10 days until closing → 10-1 = 9 chargeable days
  const effectiveDays = Math.max(1, input.daysUntilClosing - 1 + RETURN_PROCESSING_DAYS)
  const discountFee = netCommission * (rate / 1000) * effectiveDays

  // What the agent receives
  const advanceAmount = netCommission - discountFee

  // Brokerage gets a cut of the discount fee
  const brokerageReferralFee = discountFee * referralPct

  // Firm Funds keeps the rest
  const firmFundsProfit = discountFee - brokerageReferralFee

  // What brokerage sends to Firm Funds at closing (net commission minus their referral fee)
  const amountDueFromBrokerage = netCommission - brokerageReferralFee

  // How many days of EFT transfers needed
  const eftTransferDays = Math.ceil(advanceAmount / MAX_DAILY_EFT)

  return {
    netCommission: roundToCents(netCommission),
    discountFee: roundToCents(discountFee),
    advanceAmount: roundToCents(advanceAmount),
    brokerageReferralFee: roundToCents(brokerageReferralFee),
    firmFundsProfit: roundToCents(firmFundsProfit),
    amountDueFromBrokerage: roundToCents(amountDueFromBrokerage),
    eftTransferDays,
  }
}

/**
 * Calculate late closing interest.
 * Same discount rate ($0.75 per $1,000 per day), starting 5 days after expected closing.
 * @param advanceAmount - The amount advanced to the agent
 * @param expectedClosingDate - Original closing date (YYYY-MM-DD)
 * @param actualClosingDate - Actual/current date for calculation (YYYY-MM-DD)
 * @returns Interest amount (0 if within grace period)
 */
export function calculateLateInterest(
  advanceAmount: number,
  expectedClosingDate: string,
  actualClosingDate: string,
): number {
  const expectedMs = new Date(expectedClosingDate + 'T00:00:00Z').getTime()
  const actualMs = new Date(actualClosingDate + 'T00:00:00Z').getTime()
  const daysLate = Math.floor((actualMs - expectedMs) / (1000 * 60 * 60 * 24))

  // No interest if closed on time or within grace period
  if (daysLate <= LATE_CLOSING_GRACE_DAYS) return 0

  // Interest days = total days late minus grace period
  const interestDays = daysLate - LATE_CLOSING_GRACE_DAYS
  const interest = advanceAmount * (DISCOUNT_RATE_PER_1000_PER_DAY / 1000) * interestDays

  return roundToCents(interest)
}

// Format currency for display
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(amount)
}
