import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import {
  BROKERAGE_LATE_STRIKE_THRESHOLD,
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
  SETTLEMENT_PERIOD_DAYS,
} from '@/lib/constants'

function Body() {
  return (
    <>
      <p>
        Brokerages that miss their settlement window repeatedly get bumped from
        the standard {SETTLEMENT_PERIOD_DAYS}-day window to a longer
        {' '}{BROKERAGE_BUMPED_SETTLEMENT_DAYS}-day window on new deals. This
        article explains how strikes accumulate, what happens at the threshold,
        and how to clear the bump.
      </p>

      <h2>How a strike is recorded</h2>
      <p>
        Each time a Firm Funds admin manually flags a missed settlement, a
        strike is added to your brokerage record. The write happens through
        a database routine (the <code className="px-1 mx-0.5 rounded bg-muted text-foreground text-xs">record_brokerage_late_strike</code> RPC),
        which increments the count, stamps the date, and (if you cross the
        threshold) flips the auto-bump flag in a single transaction. We never
        increment by reading the count and writing it back, so concurrent
        strikes cannot stomp on each other.
      </p>

      <h2>The 5-strike threshold</h2>
      <p>
        Once your brokerage hits <strong>{BROKERAGE_LATE_STRIKE_THRESHOLD} manual strikes</strong>,
        your effective settlement window auto-bumps to
        {' '}{BROKERAGE_BUMPED_SETTLEMENT_DAYS} days. The change applies only
        to deals funded after the bump. Deals already in the pipeline keep
        whatever window was snapshotted into them at funding (see the article
        on settling a funded deal for how the snapshot works).
      </p>
      <p>
        New deals from that point forward get
        <code className="px-1 mx-0.5 rounded bg-muted text-foreground text-xs">settlement_days_at_funding = {BROKERAGE_BUMPED_SETTLEMENT_DAYS}</code>
        stored on the deal at submission. The brokerage referral fee tied to
        the settlement period rises proportionally because the settlement
        period fee covers a longer window.
      </p>

      <HelpCallout variant="warning" title="Why the bump matters">
        <p>
          The {BROKERAGE_BUMPED_SETTLEMENT_DAYS}-day window gives your trust
          account more time to clear funds, but the settlement period fee on
          new deals is double the standard version. That fee is paid by the
          agent out of the advance, so a bumped brokerage means your agents
          receive a smaller payout per deal. Clearing the bump restores their
          payouts to the standard.
        </p>
      </HelpCallout>

      <h2>Clearing the bump</h2>
      <p>
        Ship every payment on time for a full quarter and Firm Funds manually
        resets the bump. There is no in-portal button for this; we monitor and
        clear it from our side. If you believe you have already met the bar
        and the bump is still active, message us from the deal thread and we
        will review.
      </p>

      <h2>If you think a strike was applied in error</h2>
      <p>
        Reply in the message thread for the specific deal and include the
        date you actually sent payment plus the bank reference. Strikes are
        reviewed against the deposit, not against the date the amount lands
        on Firm Funds books, so if your funds were sent on time the strike
        gets reversed.
      </p>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'late-strikes-and-the-14-day-bump',
    title: 'Late strikes and the 14-day bump',
    summary: 'How strikes accumulate, the 5-strike threshold, how to clear the bump.',
    role: 'brokerage',
    category: 'settlements',
    order: 60,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
