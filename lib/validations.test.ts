import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DealSubmissionSchema } from './validations'
import { MAX_DAYS_UNTIL_CLOSING } from './constants'

// Add `days` calendar days to a YYYY-MM-DD string (UTC-anchored, matching the
// way closing dates are represented).
function addDays(isoDate: string, days: number): string {
  const ms = new Date(isoDate + 'T00:00:00Z').getTime() + days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

function baseInput(closingDate: string) {
  return {
    propertyAddress: '123 Main Street',
    closingDate,
    grossCommission: 50_000,
    brokerageSplitPct: 5,
    notes: null,
  }
}

describe('DealSubmissionSchema closing-date validation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('with Toronto "today" = 2026-06-01 (noon UTC)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    })

    it('rejects a closing date equal to today (not strictly future)', () => {
      const r = DealSubmissionSchema.safeParse(baseInput('2026-06-01'))
      expect(r.success).toBe(false)
    })

    it('accepts a closing date one day out', () => {
      const r = DealSubmissionSchema.safeParse(baseInput('2026-06-02'))
      expect(r.success).toBe(true)
    })

    it('accepts a closing date exactly MAX_DAYS_UNTIL_CLOSING out', () => {
      const r = DealSubmissionSchema.safeParse(
        baseInput(addDays('2026-06-01', MAX_DAYS_UNTIL_CLOSING)),
      )
      expect(r.success).toBe(true)
    })

    it('rejects a closing date beyond MAX_DAYS_UNTIL_CLOSING', () => {
      const r = DealSubmissionSchema.safeParse(
        baseInput(addDays('2026-06-01', MAX_DAYS_UNTIL_CLOSING + 1)),
      )
      expect(r.success).toBe(false)
    })
  })

  // Regression guard for the timezone divergence: at 03:00 UTC it is still the
  // previous day in Toronto. The validator must use the Toronto clock (same as
  // the fee engine) so a next-UTC-day closing is correctly seen as in the
  // future rather than rejected as "today".
  it('uses the Toronto clock across the UTC midnight boundary', () => {
    vi.useFakeTimers()
    // 03:00 UTC on 2026-06-01 == 23:00 EDT on 2026-05-31 (Toronto).
    vi.setSystemTime(new Date('2026-06-01T03:00:00Z'))
    const r = DealSubmissionSchema.safeParse(baseInput('2026-06-01'))
    expect(r.success).toBe(true)
  })
})
