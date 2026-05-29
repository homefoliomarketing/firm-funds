import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import {
  LATE_INTEREST_RATE_PER_ANNUM,
  LATE_INTEREST_GRACE_DAYS_FROM_CLOSING,
} from '@/lib/constants'

// Daily compounding rate that grows to LATE_INTEREST_RATE_PER_ANNUM over 365
// days. Mirrors the formula used inside calculateCompoundDailyInterest:
//   dailyRate = (1 + annualRate)^(1 / 365) - 1
const DAILY_RATE = Math.pow(1 + LATE_INTEREST_RATE_PER_ANNUM, 1 / 365) - 1
const DAILY_RATE_PERCENT = (DAILY_RATE * 100).toFixed(4)

// Worked example: $10,000 unpaid balance, 30 days past day 31 anchor.
//   total = 10,000 x ((1 + dailyRate)^30 - 1)
const WORKED_PRINCIPAL = 10_000
const WORKED_DAYS = 30
const WORKED_TOTAL = (
  WORKED_PRINCIPAL * (Math.pow(1 + DAILY_RATE, WORKED_DAYS) - 1)
).toFixed(2)

function Body() {
  const annualPercent = (LATE_INTEREST_RATE_PER_ANNUM * 100).toFixed(0)

  return (
    <div className="space-y-4 text-sm leading-relaxed text-foreground/90">
      <p>
        Late interest only kicks in when a deal stays unpaid well past
        closing. The rules below are the same rules the contract enforces and
        the same rules the system uses to compute interest in real time. They
        apply the same way for an overdue funded deal and for the unpaid
        principal on a failed deal during the cure period.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        The rate
      </h2>
      <p>
        The annual rate is{' '}
        <strong className="text-primary">{annualPercent} percent</strong>, true
        APR. The contract says compounded daily, which means we charge a small
        amount each day, and the next day&apos;s interest is on the slightly
        larger balance. The daily rate is calculated so that 365 days of
        compounding gets us back to exactly {annualPercent} percent annual
        growth, no more and no less.
      </p>
      <p>
        The formula is (1 plus {LATE_INTEREST_RATE_PER_ANNUM.toFixed(2)}) to
        the power of (1 divided by 365), then minus 1. That works out to a
        daily rate of about{' '}
        <strong className="text-primary">{DAILY_RATE_PERCENT} percent</strong>.
      </p>
      <p>
        On a $10,000 balance that first day, the interest charge is roughly
        $10,000 times {DAILY_RATE_PERCENT} percent, or about $5.90. The
        second day charges {DAILY_RATE_PERCENT} percent on $10,005.90, so a
        few fractions of a cent more, and so on.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        The {LATE_INTEREST_GRACE_DAYS_FROM_CLOSING}-day grace
      </h2>
      <p>
        Interest does not start on the closing date. The first{' '}
        {LATE_INTEREST_GRACE_DAYS_FROM_CLOSING} days after closing are a
        grace period. The settlement window covers the first 7 days; days 8
        through {LATE_INTEREST_GRACE_DAYS_FROM_CLOSING} are a follow-up window
        where Firm Funds is in contact with the brokerage but no interest is
        being charged yet.
      </p>
      <p>
        Accrual starts on{' '}
        <strong className="text-primary">
          day {LATE_INTEREST_GRACE_DAYS_FROM_CLOSING + 1} after closing
        </strong>
        . If a deal closed on May 26, the last grace day is June 25, and the
        first day that carries interest is June 26.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Worked example: $10,000 balance, 30 days overdue
      </h2>
      <p>
        Imagine a deal with $10,000 of unpaid balance that has gone 30 days
        past the grace period (so 60 days past closing total). With daily
        compounding at the rate above, the total accrued interest is $10,000
        times ((1 plus {DAILY_RATE_PERCENT} percent) to the power of {WORKED_DAYS},
        minus 1), which is{' '}
        <strong className="text-primary">about ${WORKED_TOTAL}</strong>.
      </p>
      <p>
        Said another way: simple interest at {annualPercent} percent on
        $10,000 for 30 days would be about $197.26. The compound number above
        is slightly higher because each day&apos;s interest also earns interest
        for the remaining days in the window. The longer the balance stays
        open, the wider that gap gets.
      </p>

      <HelpCallout
        variant="warning"
        title="This is real money. Talk to us before it gets big."
      >
        <p>
          The compounding curve is gentle in the first week and steep over
          months. If a deal is heading toward overdue, the cheapest thing you
          can do is open a message thread on the deal as soon as you know.
          Most balances we end up writing off would have been easy fixes if
          we had heard about them on day 5 instead of day 50.
        </p>
      </HelpCallout>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Where this lives in the code
      </h2>
      <p>
        The math is in <code>lib/calculations.ts</code>, function{' '}
        <code>calculateCompoundDailyInterest</code>. The annual rate and grace
        period come from <code>LATE_INTEREST_RATE_PER_ANNUM</code> and{' '}
        <code>LATE_INTEREST_GRACE_DAYS_FROM_CLOSING</code> in{' '}
        <code>lib/constants.ts</code>. If those numbers ever change in the
        contract, they change in those files first, and this article picks
        them up automatically because it imports the same constants.
      </p>
    </div>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'late-interest-rules',
    title: 'Late payment interest rules',
    summary: '24 percent APR, 30-day grace, compounding example.',
    role: 'shared',
    category: 'money-and-policy',
    order: 20,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
