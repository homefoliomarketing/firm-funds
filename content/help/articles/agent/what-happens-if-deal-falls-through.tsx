import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import {
  LATE_INTEREST_RATE_PER_ANNUM,
  LATE_INTEREST_GRACE_DAYS_FROM_CLOSING,
} from '@/lib/constants'

function Body() {
  // Live daily compounding rate from the same formula the app uses.
  const dailyRate = Math.pow(1 + LATE_INTEREST_RATE_PER_ANNUM, 1 / 365) - 1
  const dailyPct = (dailyRate * 100).toFixed(4)
  const annualPct = (LATE_INTEREST_RATE_PER_ANNUM * 100).toFixed(0)

  return (
    <>
      <p>
        Deals fall through sometimes. The buyer&apos;s financing collapses, an
        inspection turns up a major issue, the parties walk away. When a deal you
        already received an advance on does not close, the contract switches into
        what we call the cure path, and you have to pick how you want to make Firm
        Funds whole. This article explains what happens, what your options are, and
        what late interest actually costs.
      </p>

      <h2>The 15-day cure window</h2>
      <p>
        The moment a deal is marked failed-to-close, Firm Funds emails you and posts
        a Cure Election prompt on your dashboard. You then have 15 days to pick one
        of two paths. The countdown is shown on the cure election page and on the
        prompt at the top of your dashboard.
      </p>

      <h2>Your two options</h2>
      <h3>Option A: Cash repayment</h3>
      <p>
        You pay the outstanding balance back yourself, by EFT, e-transfer, or cheque,
        within 90 days. This is the cleanest path if you have the cash on hand or do
        not have another deal coming up soon. Missed payments accrue interest at the
        rate explained below.
      </p>

      <h3>Option B: Commission assignment</h3>
      <p>
        You redirect a future commission of yours to Firm Funds. We send you and
        your brokerage a Remediation Irrevocable Direction to Pay (Remediation IDP)
        for the next deal you have closing. When that deal closes, your brokerage
        pays the directed amount straight to Firm Funds out of your commission
        before the rest comes to you. No money out of pocket today.
      </p>

      <h2>How the {annualPct}% interest actually works</h2>
      <p>
        Whichever path you pick, interest on the outstanding balance starts accruing
        on day 31 after the original closing date. Days 1 through{' '}
        {LATE_INTEREST_GRACE_DAYS_FROM_CLOSING} are a grace period (no interest at
        all). The rate is {annualPct}% per year, compounded daily, which means each
        day&apos;s interest is calculated on the principal plus all the interest
        that has already accrued.
      </p>
      <p>
        The exact daily rate is calculated as (1 + 0.{annualPct})^(1/365) minus 1,
        which works out to about {dailyPct}% per day. Compounded over a full year,
        that is exactly {annualPct}% APR.
      </p>

      <HelpCallout variant="money" title="Worked example on a $10,000 balance">
        Day 30 after closing: nothing accrued yet, still in grace.
        <br />
        Day 31: about $5.90 of interest.
        <br />
        Day 60 (one month of accrual): about $178 of interest, for a total
        outstanding of $10,178.
        <br />
        Day 120 (90 days past grace): about $556 of interest, for a total
        outstanding of $10,556.
        <br />
        Clear the balance and the meter stops the same day.
      </HelpCallout>

      <h2>What you see on your dashboard</h2>
      <p>
        Your dashboard surfaces three things while a failed deal is on your file:
      </p>
      <ul>
        <li>
          A red Cure Election prompt with the days remaining to choose your path.
          Click Review options to open the election page.
        </li>
        <li>
          An amber Failed Deals strip with a count, linking into the workspace
          where you manage Remediation IDPs.
        </li>
        <li>
          Once you elect, the cure-election page shows you a live outstanding total
          including accrued interest. It updates every minute so the number you see
          is always current.
        </li>
      </ul>

      <h2>Missing the deadline</h2>
      <p>
        If 15 days passes without an election, the dashboard shows
        &quot;Election overdue. Contact Firm Funds&quot; and you should email
        bud@firmfunds.ca right away. Interest continues to accrue regardless of
        whether you elected, so the longer you wait, the larger the balance.
      </p>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'what-happens-if-deal-falls-through',
    title: 'What happens if my deal falls through',
    summary: 'Cure election in 15 days, two paths, when the 24% interest clock starts.',
    role: 'agent',
    category: 'failed-deals',
    order: 70,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
