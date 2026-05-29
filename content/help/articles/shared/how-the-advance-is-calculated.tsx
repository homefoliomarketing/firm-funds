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
        We advance against the net, not the gross. If the deal is a $50,000
        gross commission and your brokerage takes a 5 percent split, your net
        commission is $50,000 times (1 minus 0.05), or $47,500.
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
        , charged against the net commission. Closing day itself is not
        charged because that is the day we get repaid, not a day we are still
        carrying the money. So a deal scheduled to close in 30 days has 29
        chargeable days, not 30.
      </p>
      <p>
        On a $47,500 net commission for 29 chargeable days, the discount fee
        is $47,500 times 0.0008 times 29, which is{' '}
        <strong className="text-primary">$1,102.00</strong>.
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
        $47,500 net commission, that is $47,500 times 0.0008 times{' '}
        {SETTLEMENT_PERIOD_DAYS}, or{' '}
        <strong className="text-primary">$266.00</strong>.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Step 4: Subtract fees from the net to get the advance
      </h2>
      <p>
        Add the two fees together: $1,102.00 plus $266.00 is $1,368.00 in
        total fees. Take that off the net commission and the advance you
        receive is{' '}
        <strong className="text-primary">$46,132.00</strong>. That is the
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
        Why the closing day is not charged
      </h2>
      <p>
        Funds arrive in your account the day after we fund the deal, and
        closing day is the day the brokerage remits to us. So the charge
        period runs from the day you receive funds up to and including the
        day before closing. The math always uses days until closing minus 1,
        with a minimum of 1 day so very short deals still pay at least one
        day of carry.
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
