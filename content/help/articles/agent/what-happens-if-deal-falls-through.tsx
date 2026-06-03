import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import HelpStepList from '@/components/help/HelpStepList'
import {
  LATE_INTEREST_RATE_PER_ANNUM,
  LATE_INTEREST_GRACE_DAYS_FROM_CLOSING,
} from '@/lib/constants'

function Body() {
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
        before the rest comes to you. No money out of pocket today. For exactly
        what the document contains and why it cannot be cancelled, see the article
        What a Remediation IDP is.
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
        For exactly how the daily rate is calculated, see the article Late
        payment interest rules.
      </p>

      <HelpCallout variant="money" title="Worked example on a $10,000 balance">
        Day 30 after closing: nothing accrued yet, still in grace.
        <br />
        Day 31: about $5.90 of interest.
        <br />
        Day 60 (one month of accrual): about $178 of interest, for a total
        outstanding of $10,178.
        <br />
        Day 120 (90 days past grace): about $544.73 of interest, for a total
        outstanding of $10,544.73.
        <br />
        Clear the balance and the meter stops the same day.
      </HelpCallout>

      <h2>How to sign and track your Remediation IDP</h2>
      <p>
        If you pick commission assignment, here is the path from naming the
        future deal to seeing the credit land on your ledger.
      </p>
      <HelpStepList steps={[
        {
          title: 'Add the future deal in your Failed Deals workspace',
          expected: 'From your dashboard, click into Failed Deals, find the failed deal, and add the upcoming commission you want to assign. You enter the property address, expected closing, and the amount being directed.',
          fallback: 'If you do not have an upcoming deal yet, that is fine. Come back and add it once you have one. The cure-election deadline only requires you to pick a path, not to have the next deal lined up immediately.',
        },
        {
          title: 'Wait for Firm Funds to send the envelope',
          expected: 'A Firm Funds admin reviews the upcoming deal and sends a DocuSign envelope to you and your brokerage. You get an email titled "Please sign your Remediation IDP".',
        },
        {
          title: 'Open the email and sign in DocuSign',
          expected: 'Click the link, follow the DocuSign prompts, and sign. This usually takes under a minute. DocuSign emails you a copy of the signed document for your records.',
          fallback: 'If you do not see the email, check spam. If it is still missing after 24 hours, message Firm Funds and we will resend.',
        },
        {
          title: 'Watch the status flip',
          expected: 'On your failed-deals page, the row for the remediation deal shows the envelope status. It goes from "sent" to "agent signed" to "fully signed" as signatures come in.',
        },
        {
          title: 'Watch for the ledger credit',
          expected: 'When that future deal closes and your brokerage remits the directed amount to Firm Funds, we apply the payment to your ledger as a Credit line item. Your outstanding balance drops by that amount, and if the credit covers the whole balance, the failed deal status moves to Cured.',
        },
      ]} />

      <h3>If the assigned deal also falls through</h3>
      <p>
        Real estate is real estate. If the deal you assigned does not close, the
        Remediation IDP for that deal just expires unfulfilled. Add a new upcoming
        deal in the Failed Deals workspace and we will issue a fresh Remediation IDP
        for the next one. The original balance and any accrued interest stay on
        your ledger until something pays them off.
      </p>

      <h3>If something does not work</h3>
      <ul>
        <li>DocuSign envelope expired? Message us and we will resend. Envelopes
          have a finite validity window.</li>
        <li>Signed but the status did not update? Refresh the Failed Deals page.
          The webhook usually catches the signature within a minute, but a refresh
          forces a re-read.</li>
        <li>Brokerage tells you they remitted but no credit on your ledger? Send
          us the date and the bank reference and we will reconcile.</li>
      </ul>

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
