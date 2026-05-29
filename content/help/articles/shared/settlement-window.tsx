import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import {
  SETTLEMENT_PERIOD_DAYS,
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
  BROKERAGE_LATE_STRIKE_THRESHOLD,
} from '@/lib/constants'

function Body() {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-foreground/90">
      <p>
        The settlement window is the number of calendar days after closing
        the brokerage has to remit the amount due to Firm Funds out of their
        trust account. It exists because the money lands in trust on closing
        day, and the brokerage needs a few business days to clear funds and
        cut the cheque or wire.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Standard: {SETTLEMENT_PERIOD_DAYS} calendar days
      </h2>
      <p>
        The default window is{' '}
        <strong className="text-primary">
          {SETTLEMENT_PERIOD_DAYS} calendar days after closing
        </strong>
        . The settlement period fee shown on every deal preview is the cost
        of that window: net commission times the daily discount rate times{' '}
        {SETTLEMENT_PERIOD_DAYS}. The fee is charged once at funding and is
        not refunded if the brokerage pays early.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        The auto-bump to {BROKERAGE_BUMPED_SETTLEMENT_DAYS} days
      </h2>
      <p>
        If a brokerage misses the {SETTLEMENT_PERIOD_DAYS}-day window on{' '}
        <strong className="text-primary">
          {BROKERAGE_LATE_STRIKE_THRESHOLD} manual late-payment strikes
        </strong>
        , the system auto-bumps that brokerage&apos;s default window to{' '}
        {BROKERAGE_BUMPED_SETTLEMENT_DAYS} days for new deals going forward.
        The settlement period fee on those new deals is then computed against
        {' '}
        {BROKERAGE_BUMPED_SETTLEMENT_DAYS} days, not {SETTLEMENT_PERIOD_DAYS}.
      </p>
      <p>
        Existing funded deals are not retroactively bumped. Each deal carries
        the window it had at funding, as a snapshot, so an amendment or a
        brokerage status change cannot move the goalposts on a deal that is
        already on the road.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        How the effective window is resolved
      </h2>
      <p>
        Three inputs decide the window that applies to a given deal at the
        moment it is being submitted. The resolver walks them in this order
        and stops at the first hit:
      </p>
      <ol className="list-decimal pl-6 space-y-2">
        <li>
          <strong>Admin override</strong>. If Firm Funds has set a manual
          override on the brokerage (for example, a negotiated longer window
          for a specific partner), that number wins.
        </li>
        <li>
          <strong>Auto-bump flag</strong>. If the brokerage has been bumped
          to {BROKERAGE_BUMPED_SETTLEMENT_DAYS} days after hitting the strike
          threshold, that number applies.
        </li>
        <li>
          <strong>Default</strong>. Otherwise, the standard{' '}
          {SETTLEMENT_PERIOD_DAYS} days applies.
        </li>
      </ol>
      <p>
        At submission, the resolved number is snapshotted into the
        deal&apos;s <code>settlement_days_at_funding</code> column. From that
        point on, every fee, due-date, and strike check for that specific
        deal uses the snapshotted value, not the current brokerage setting.
        That snapshot is the legal commitment.
      </p>

      <HelpCallout
        variant="note"
        title="Why the snapshot matters"
      >
        <p>
          Without the snapshot, a brokerage that gets bumped from 7 to{' '}
          {BROKERAGE_BUMPED_SETTLEMENT_DAYS} days mid-deal would pay more in
          fees than the agent agreed to at submission. Locking the number at
          funding keeps the deal&apos;s economics identical to what the
          preview showed.
        </p>
      </HelpCallout>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Getting the bump removed
      </h2>
      <p>
        The {BROKERAGE_BUMPED_SETTLEMENT_DAYS}-day bump is not permanent. If
        a bumped brokerage clears every settlement on time for a full quarter,
        Firm Funds will manually drop the flag and new deals go back to{' '}
        {SETTLEMENT_PERIOD_DAYS} days. Message us from the brokerage portal if
        you believe a strike was logged in error and we will reconcile against
        the actual bank receipt date.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Where this lives in the code
      </h2>
      <p>
        The resolver is <code>effectiveSettlementDays</code> in{' '}
        <code>lib/calculations.ts</code>. The two numbers come from{' '}
        <code>SETTLEMENT_PERIOD_DAYS</code> and{' '}
        <code>BROKERAGE_BUMPED_SETTLEMENT_DAYS</code> in{' '}
        <code>lib/constants.ts</code>, and the strike threshold comes from{' '}
        <code>BROKERAGE_LATE_STRIKE_THRESHOLD</code>.
      </p>
    </div>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'settlement-window',
    title: 'The settlement window',
    summary: `${SETTLEMENT_PERIOD_DAYS}-day standard, ${BROKERAGE_BUMPED_SETTLEMENT_DAYS} after ${BROKERAGE_LATE_STRIKE_THRESHOLD} strikes, snapshot at funding.`,
    role: 'shared',
    category: 'money-and-policy',
    order: 30,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
