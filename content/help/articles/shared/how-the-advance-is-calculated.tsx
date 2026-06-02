import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import HelpFeeWorksheet from '@/components/help/HelpFeeWorksheet'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  SETTLEMENT_PERIOD_DAYS,
} from '@/lib/constants'

function Body() {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-foreground/90">
      <p>
        Every advance is built from three numbers: your net commission, the
        discount fee, and the settlement period fee. Once those are set, the
        advance you receive is just what is left after the fees come off the
        net commission. This article walks through one complete example using
        the same code that runs on real deals.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Step 1: Start with the net commission
      </h2>
      <p>
        Gross commission is the full commission the brokerage receives on the
        sale. Net commission is what is left after the brokerage&apos;s split.
        We advance against the net, not the gross. If the deal is a $10,000
        gross commission and your brokerage takes a 30 percent split, your net
        commission is $10,000 times (1 minus 0.30), or $7,000.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Step 2: Calculate the discount fee
      </h2>
      <p>
        The discount fee covers the cost of carrying your money from funding
        through to closing. The rate is{' '}
        <strong className="text-primary">
          ${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day
        </strong>
        , charged against the net commission. The funding day itself is not
        charged, because your funds arrive the day after we fund the deal.
        Closing day is charged, because that is not the day we are repaid: your
        brokerage remits to us within the settlement window after closing. So a
        deal scheduled to close in 30 days has 30 chargeable days.
      </p>
      <p>
        On a $7,000 net commission for 30 chargeable days, the discount fee
        is $7,000 times 0.0008 times 30, which is{' '}
        <strong className="text-primary">$168.00</strong>.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Step 3: Add the settlement period fee
      </h2>
      <p>
        After closing, your brokerage needs a short window to clear the funds
        in their trust account and remit our portion. The standard settlement
        window is{' '}
        <strong className="text-primary">{SETTLEMENT_PERIOD_DAYS} days</strong>
        , and we charge the same daily rate during that window. On the same
        $7,000 net commission, that is $7,000 times 0.0008 times{' '}
        {SETTLEMENT_PERIOD_DAYS}, or{' '}
        <strong className="text-primary">$39.20</strong>.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Step 4: Subtract fees from the net to get the advance
      </h2>
      <p>
        Add the two fees together: $168.00 plus $39.20 is $207.20 in
        total fees. Take that off the net commission and the advance you
        receive is{' '}
        <strong className="text-primary">$6,792.80</strong>. That is the
        amount that lands in your account; the brokerage settles the full net
        commission with us within the settlement window after closing.
      </p>

      <HelpCallout variant="money" title="The whole calculation in one line">
        <p>
          Advance = (gross x (1 minus split percent / 100)) minus discount fee
          minus settlement period fee, where both fees are net commission x{' '}
          ${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day, times
          the relevant day count.
        </p>
      </HelpCallout>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Which days are charged
      </h2>
      <p>
        Funds arrive in your account the day after we fund the deal, so the
        funding day itself is not charged. Closing day is charged, because that
        is not the day we are repaid: your brokerage remits to us within the
        settlement window after closing. So the charge period runs from the day
        you receive funds up to and including the closing day. The math uses
        days until closing, with a minimum of 1 day so very short deals still
        pay at least one day of carry.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Run your own numbers
      </h2>
      <p>
        Use the worksheet below to plug in any combination of gross, split,
        and days until closing. It runs the same calculation the new-deal form
        uses, so what you see here matches what you will see when you submit
        a real request.
      </p>

      <HelpFeeWorksheet />
    </div>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'how-the-advance-is-calculated',
    title: 'How the advance is calculated',
    summary: 'Worked example from gross commission to the advance you receive.',
    role: 'shared',
    category: 'money-and-policy',
    order: 10,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
