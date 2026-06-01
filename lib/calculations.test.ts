import { describe, it, expect } from 'vitest'
import {
  calculateDeal,
  getChargeDays,
  calculateCompoundDailyInterest,
  calculateLateInterest,
  lateInterestAccrualStartDate,
  failedDealAccrualStartDate,
  effectiveSettlementDays,
  liveLateInterestOwed,
  liveFailedDealInterestOwed,
  type DealCalculation,
  type DealResult,
} from './calculations'
import {
  MIN_GROSS_COMMISSION,
  MAX_GROSS_COMMISSION,
  MIN_DAYS_UNTIL_CLOSING,
  MAX_DAYS_UNTIL_CLOSING,
  SETTLEMENT_PERIOD_DAYS,
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
  RETURN_PROCESSING_DAYS,
  LATE_INTEREST_RATE_PER_ANNUM,
} from './constants'

// The daily compounding rate the code uses: (1 + 0.24)^(1/365) - 1.
const DAILY_RATE = Math.pow(1 + LATE_INTEREST_RATE_PER_ANNUM, 1 / 365) - 1

describe('calculateDeal — documented worked examples', () => {
  it('Worked example A: $50,000 gross, split 5%, 30 days', () => {
    const result = calculateDeal({
      grossCommission: 50_000,
      brokerageSplitPct: 5,
      daysUntilClosing: 30,
      // explicit defaults so the example is fully pinned
      discountRate: 0.8,
      brokerageReferralPct: 0.2,
      settlementPeriodDays: 7,
    })

    expect(result.netCommission).toBe(47_500.0)
    expect(result.effectiveDays).toBe(29)
    expect(result.discountFee).toBe(1_102.0)
    expect(result.settlementPeriodFee).toBe(266.0)
    expect(result.totalFees).toBe(1_368.0)
    expect(result.advanceAmount).toBe(46_132.0)
    expect(result.brokerageReferralFee).toBe(273.6)
    expect(result.firmFundsProfit).toBe(1_094.4)
    expect(result.amountDueFromBrokerage).toBe(47_226.4)
  })

  it('Worked example B: same gross, 2-day timeline', () => {
    const result = calculateDeal({
      grossCommission: 50_000,
      brokerageSplitPct: 5,
      daysUntilClosing: 2,
      discountRate: 0.8,
      brokerageReferralPct: 0.2,
      settlementPeriodDays: 7,
    })

    expect(result.effectiveDays).toBe(1)
    expect(result.discountFee).toBe(38.0)
    expect(result.settlementPeriodFee).toBe(266.0)
    expect(result.totalFees).toBe(304.0)
    expect(result.advanceAmount).toBe(47_196.0)
  })
})

describe('calculateDeal — accounting identities hold exactly', () => {
  const cases: DealCalculation[] = [
    { grossCommission: 50_000, brokerageSplitPct: 5, daysUntilClosing: 30 },
    { grossCommission: 12_345, brokerageSplitPct: 15, daysUntilClosing: 7 },
    { grossCommission: 1, brokerageSplitPct: 0, daysUntilClosing: 2 },
    { grossCommission: 1_000_000, brokerageSplitPct: 100, daysUntilClosing: 120 },
    { grossCommission: 73_210.55, brokerageSplitPct: 22, daysUntilClosing: 45, brokerageReferralPct: 0.33 },
    { grossCommission: 250_000, brokerageSplitPct: 50, daysUntilClosing: 60, settlementPeriodDays: 14 },
    { grossCommission: 9_999.99, brokerageSplitPct: 7, daysUntilClosing: 3, discountRate: 1.25 },
  ]

  cases.forEach((input, i) => {
    it(`identities hold for case #${i + 1}`, () => {
      const r: DealResult = calculateDeal(input)
      // discountFee + settlementPeriodFee === totalFees
      expect(r.discountFee + r.settlementPeriodFee).toBeCloseTo(r.totalFees, 10)
      // netCommission - totalFees === advanceAmount
      expect(r.netCommission - r.totalFees).toBeCloseTo(r.advanceAmount, 10)
      // brokerageReferralFee + firmFundsProfit === totalFees
      expect(r.brokerageReferralFee + r.firmFundsProfit).toBeCloseTo(r.totalFees, 10)
      // netCommission - brokerageReferralFee === amountDueFromBrokerage
      expect(r.netCommission - r.brokerageReferralFee).toBeCloseTo(r.amountDueFromBrokerage, 10)
    })
  })
})

describe('calculateDeal — input boundaries', () => {
  const base = { grossCommission: 50_000, brokerageSplitPct: 5 }

  it('MIN and MAX days-until-closing succeed', () => {
    expect(() => calculateDeal({ ...base, daysUntilClosing: MIN_DAYS_UNTIL_CLOSING })).not.toThrow()
    expect(() => calculateDeal({ ...base, daysUntilClosing: MAX_DAYS_UNTIL_CLOSING })).not.toThrow()
  })

  it('below MIN and above MAX days throw', () => {
    expect(() => calculateDeal({ ...base, daysUntilClosing: MIN_DAYS_UNTIL_CLOSING - 1 })).toThrow()
    expect(() => calculateDeal({ ...base, daysUntilClosing: MAX_DAYS_UNTIL_CLOSING + 1 })).toThrow()
  })

  it('MIN and MAX gross commission succeed', () => {
    expect(() => calculateDeal({ grossCommission: MIN_GROSS_COMMISSION, brokerageSplitPct: 5, daysUntilClosing: 30 })).not.toThrow()
    expect(() => calculateDeal({ grossCommission: MAX_GROSS_COMMISSION, brokerageSplitPct: 5, daysUntilClosing: 30 })).not.toThrow()
  })

  it('below MIN and above MAX gross commission throw', () => {
    expect(() => calculateDeal({ grossCommission: MIN_GROSS_COMMISSION - 1, brokerageSplitPct: 5, daysUntilClosing: 30 })).toThrow()
    expect(() => calculateDeal({ grossCommission: MAX_GROSS_COMMISSION + 1, brokerageSplitPct: 5, daysUntilClosing: 30 })).toThrow()
  })

  it('split 0 and 100 behave as documented', () => {
    const zero = calculateDeal({ grossCommission: 50_000, brokerageSplitPct: 0, daysUntilClosing: 30 })
    expect(zero.netCommission).toBe(50_000) // keep 100% of gross
    const hundred = calculateDeal({ grossCommission: 50_000, brokerageSplitPct: 100, daysUntilClosing: 30 })
    expect(hundred.netCommission).toBe(0) // brokerage keeps everything
  })

  it('split out of range throws', () => {
    expect(() => calculateDeal({ grossCommission: 50_000, brokerageSplitPct: -1, daysUntilClosing: 30 })).toThrow()
    expect(() => calculateDeal({ grossCommission: 50_000, brokerageSplitPct: 101, daysUntilClosing: 30 })).toThrow()
  })

  it('referral pct out of range (decimal) throws', () => {
    expect(() => calculateDeal({ grossCommission: 50_000, brokerageSplitPct: 5, daysUntilClosing: 30, brokerageReferralPct: -0.1 })).toThrow()
    expect(() => calculateDeal({ grossCommission: 50_000, brokerageSplitPct: 5, daysUntilClosing: 30, brokerageReferralPct: 1.1 })).toThrow()
  })
})

describe('getChargeDays', () => {
  // Rule: Math.max(1, daysUntilClosing - 1 + RETURN_PROCESSING_DAYS)
  it('matches documented examples (RETURN_PROCESSING_DAYS=0)', () => {
    expect(RETURN_PROCESSING_DAYS).toBe(0) // pin the assumption the examples rely on
    expect(getChargeDays(30)).toBe(29)
    expect(getChargeDays(2)).toBe(1)
  })

  it('clamps to a minimum of 1', () => {
    expect(getChargeDays(1)).toBe(1)
    expect(getChargeDays(0)).toBe(1)
    expect(getChargeDays(-5)).toBe(1)
  })

  it('large value yields n-1 (+ processing days)', () => {
    expect(getChargeDays(120)).toBe(120 - 1 + RETURN_PROCESSING_DAYS)
  })
})

describe('calculateCompoundDailyInterest', () => {
  it('equal start and current date yields 0', () => {
    expect(calculateCompoundDailyInterest(10_000, '2026-06-25', '2026-06-25')).toBe(0)
  })

  it('documented one-day example: $10,000 over 1 day = $5.90', () => {
    expect(calculateCompoundDailyInterest(10_000, '2026-06-25', '2026-06-26')).toBe(5.9)
  })

  it('uses COMPOUND growth, not naive rate*days', () => {
    const principal = 10_000
    const days = 100
    const compound = calculateCompoundDailyInterest(principal, '2026-01-01', '2026-04-11') // 100 days
    const naive = Math.round(principal * DAILY_RATE * days * 100) / 100
    const expectedCompound = Math.round(principal * (Math.pow(1 + DAILY_RATE, days) - 1) * 100) / 100
    expect(compound).toBe(expectedCompound)
    expect(compound).toBeGreaterThan(naive) // compound exceeds naive over multiple days
  })

  it('returns 0 when current date precedes start (no negative interest)', () => {
    expect(calculateCompoundDailyInterest(10_000, '2026-06-25', '2026-06-01')).toBe(0)
  })
})

describe('lateInterestAccrualStartDate', () => {
  it('documented example: closing 2026-05-26 -> anchor 2026-06-25', () => {
    expect(lateInterestAccrualStartDate('2026-05-26')).toBe('2026-06-25')
  })

  it('first accruing day is anchor + 1 (day 31)', () => {
    // 0 interest on the anchor, non-zero on anchor+1
    expect(calculateLateInterest(46_132, '2026-05-26', '2026-06-25')).toBe(0)
    expect(calculateLateInterest(46_132, '2026-05-26', '2026-06-26')).toBeGreaterThan(0)
  })
})

describe('failedDealAccrualStartDate', () => {
  it('documented non-DST example: failed 2026-05-27T01:00:00Z -> anchor 2026-06-25', () => {
    // 2026-05-27T01:00:00Z is May 26 21:00 EDT in Toronto -> Toronto date 2026-05-26
    expect(failedDealAccrualStartDate('2026-05-27T01:00:00Z')).toBe('2026-06-25')
  })

  it('documented DST example: must NOT be off by one across spring-forward', () => {
    // failed_to_close_at = 2026-03-08T04:00:00Z is Mar 7 23:00 EST in Toronto.
    // Correct Toronto-date math: Mar 7 + 30 days = 2026-04-06 (NOT 2026-04-07).
    expect(failedDealAccrualStartDate('2026-03-08T04:00:00Z')).toBe('2026-04-06')
  })
})

describe('liveLateInterestOwed / liveFailedDealInterestOwed', () => {
  it('liveLateInterestOwed honors an explicit asOfDate', () => {
    // closing 2026-05-26 -> anchor 2026-06-25; asOf 2026-06-26 = 1 day of interest
    const owed = liveLateInterestOwed(10_000, '2026-05-26', '2026-06-26')
    expect(owed).toBe(5.9)
  })

  it('liveLateInterestOwed is 0 within the grace window', () => {
    expect(liveLateInterestOwed(10_000, '2026-05-26', '2026-06-10')).toBe(0)
  })

  it('liveFailedDealInterestOwed honors an explicit asOfDate', () => {
    // failed 2026-05-27T01:00:00Z -> anchor 2026-06-25; asOf 2026-06-26 = 1 day
    const owed = liveFailedDealInterestOwed(10_000, '2026-05-27T01:00:00Z', '2026-06-26')
    expect(owed).toBe(5.9)
  })

  it('documented 30-day late-interest example: $46,132 -> compound $822.88', () => {
    // jsdoc states "≈ $822.05" as a loose approximation; the EXACT compound
    // value the code computes is $822.88. See report note.
    const owed = liveLateInterestOwed(46_132, '2026-05-26', '2026-07-25')
    expect(owed).toBe(822.88)
  })
})

describe('effectiveSettlementDays', () => {
  it('null/undefined -> standard default', () => {
    expect(effectiveSettlementDays(null)).toBe(SETTLEMENT_PERIOD_DAYS)
    expect(effectiveSettlementDays(undefined)).toBe(SETTLEMENT_PERIOD_DAYS)
  })

  it('valid override wins', () => {
    expect(effectiveSettlementDays({ settlement_days_override: 10 })).toBe(10)
  })

  it('auto-bump-to-14 path when no override', () => {
    expect(effectiveSettlementDays({ auto_bumped_to_14_days_at: '2026-05-01T00:00:00Z' })).toBe(
      BROKERAGE_BUMPED_SETTLEMENT_DAYS,
    )
  })

  it('override takes priority over auto-bump', () => {
    expect(
      effectiveSettlementDays({
        settlement_days_override: 9,
        auto_bumped_to_14_days_at: '2026-05-01T00:00:00Z',
      }),
    ).toBe(9)
  })

  it('non-positive override is ignored, falls through', () => {
    expect(effectiveSettlementDays({ settlement_days_override: 0 })).toBe(SETTLEMENT_PERIOD_DAYS)
    expect(
      effectiveSettlementDays({ settlement_days_override: 0, auto_bumped_to_14_days_at: '2026-05-01T00:00:00Z' }),
    ).toBe(BROKERAGE_BUMPED_SETTLEMENT_DAYS)
  })
})
