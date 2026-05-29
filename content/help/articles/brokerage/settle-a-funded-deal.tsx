import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import { SETTLEMENT_PERIOD_DAYS, BROKERAGE_BUMPED_SETTLEMENT_DAYS } from '@/lib/constants'

function Body() {
  return (
    <>
      <p>
        When a deal closes, your brokerage owes Firm Funds the
        <strong> amount due from brokerage</strong> on that deal. The settlement
        window is how long you have to send it. This article explains what
        that amount is, when it is due, and why your window stays fixed once a
        deal funds.
      </p>

      <h2>What you owe</h2>
      <p>
        On every funded deal we calculate <strong>amount_due_from_brokerage</strong>,
        which is the agent&apos;s net commission minus your share of the
        brokerage referral fee. You can see it on the row in the Settlements
        tab, on the deal detail expansion, and in the Record Payment modal.
        Pay this amount, not the gross commission.
      </p>

      <h2>The settlement window</h2>
      <p>
        Standard settlement is <strong>{SETTLEMENT_PERIOD_DAYS} calendar days</strong> after
        the closing date. Closing day itself does not count toward the window.
        So if a deal closes on Monday, the standard 7-day window means payment
        must reach Firm Funds by the following Monday.
      </p>
      <p>
        If your brokerage has been bumped after repeated late payments, your
        window stretches to <strong>{BROKERAGE_BUMPED_SETTLEMENT_DAYS} calendar days</strong>.
        See the article on late strikes for how the bump works and how to clear it.
      </p>

      <h2>Why your window is frozen on each deal</h2>
      <p>
        At the moment a deal funds we snapshot your effective settlement
        window into the deal record (the
        <code className="px-1 mx-0.5 rounded bg-muted text-foreground text-xs">deals.settlement_days_at_funding</code> column).
        That snapshot is what controls when this particular deal goes late.
        If Firm Funds bumps your window later or restores it later, those
        changes only apply to deals funded after the change. The deals you
        already have keep whatever window was in place the day they funded.
      </p>

      <HelpCallout variant="money" title="Worked example">
        <p>
          Gross commission $50,000. Brokerage split 5 percent. Net commission
          to the agent: $47,500. Brokerage referral fee at the default 20
          percent of total fees: $273.60.
        </p>
        <p>
          Amount due from brokerage at closing: $47,500 minus $273.60 equals
          <strong> $47,226.40</strong>.
        </p>
        <p>
          Closing date Monday, May 4. Standard 7-day window means full payment
          must reach Firm Funds by Monday, May 11.
        </p>
      </HelpCallout>

      <h2>What counts as paid on time</h2>
      <p>
        We reconcile against when the deposit lands in our bank account, not
        when you mark it sent in the portal. EFTs and wires sent on the last
        day of your window are fine as long as they post the next business
        day. Cheques are slower; allow a few extra days for clearing if you
        are choosing that method.
      </p>

      <h2>What to do next</h2>
      <p>
        Send the payment by EFT, wire, cheque, or whichever method works best
        for your trust account, then open the Record Payment modal in the
        Settlements tab to log it. We confirm against the bank deposit,
        typically within one business day.
      </p>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'settle-a-funded-deal',
    title: 'Settle a funded deal',
    summary: 'What you owe Firm Funds at closing and the 7-day standard window.',
    role: 'brokerage',
    category: 'settlements',
    order: 40,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
