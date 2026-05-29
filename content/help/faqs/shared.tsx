import Link from 'next/link'
import type { HelpFaq } from '../types'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  SETTLEMENT_PERIOD_DAYS,
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
  BROKERAGE_LATE_STRIKE_THRESHOLD,
  LATE_INTEREST_RATE_PER_ANNUM,
  LATE_INTEREST_GRACE_DAYS_FROM_CLOSING,
} from '@/lib/constants'

const LATE_RATE_PCT = Math.round(LATE_INTEREST_RATE_PER_ANNUM * 100)
const ACCRUAL_START_DAY = LATE_INTEREST_GRACE_DAYS_FROM_CLOSING + 1

function HowIsAdvanceCalculated() {
  return (
    <>
      <p className="text-foreground">
        We start with your net commission, which is the gross commission minus
        your brokerage&apos;s split. We charge a discount fee of{' '}
        <span className="text-primary">
          ${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day
        </span>{' '}
        for every day from funding through the day before closing. We also
        charge a settlement period fee at the same daily rate for the standard{' '}
        {SETTLEMENT_PERIOD_DAYS}-day window after closing. Your advance is the
        net commission minus those two fees.
      </p>
      <p className="text-muted-foreground">
        The math lives in <code>lib/calculations.ts</code>, and a worked
        example is in{' '}
        <Link
          href="/help/shared/how-the-advance-is-calculated"
          className="text-primary hover:underline"
        >
          How the advance is calculated
        </Link>
        .
      </p>
    </>
  )
}

function WhyIsClosingDayNotCharged() {
  return (
    <>
      <p className="text-foreground">
        Closing day is the day you repay us, not a day we are still carrying
        the money. The math charges from funding up to and including the day
        before closing.
      </p>
      <p className="text-muted-foreground">
        So a 30-day deal carries 29 charge days, not 30. The helper{' '}
        <code>getChargeDays()</code> in <code>lib/calculations.ts</code>{' '}
        subtracts one from the days until closing.
      </p>
    </>
  )
}

function WhatHappensIfDealFallsThrough() {
  return (
    <>
      <p className="text-foreground">
        We move the deal to <code>failed_to_close</code> and email you within
        minutes. You then have 15 days to elect a cure path:
      </p>
      <ul className="ml-6 list-disc space-y-1 text-foreground">
        <li>
          <span className="text-primary">Cash repayment</span> of the
          outstanding balance, or
        </li>
        <li>
          <span className="text-primary">Commission assignment</span>, where
          we redirect a future commission to Firm Funds via a Remediation
          Irrevocable Direction to Pay.
        </li>
      </ul>
      <p className="text-muted-foreground">
        Either way, late interest at {LATE_RATE_PCT}% per year compounded
        daily starts on day {ACCRUAL_START_DAY} after the closing date.
      </p>
    </>
  )
}

function WhatIsARemediationIdp() {
  return (
    <>
      <p className="text-foreground">
        An Irrevocable Direction to Pay (IDP) is a one-page document signed
        by you and your brokerage that redirects a specific upcoming
        commission to Firm Funds.
      </p>
      <p className="text-muted-foreground">
        We use it when a previously advanced deal fails to close and you
        elect commission assignment as your cure path.
      </p>
    </>
  )
}

function WhatDoesLateInterestCostPerDay() {
  // (1 + LATE_INTEREST_RATE_PER_ANNUM)^(1/365) - 1
  const dailyRate = Math.pow(1 + LATE_INTEREST_RATE_PER_ANNUM, 1 / 365) - 1
  const dailyRatePct = (dailyRate * 100).toFixed(4)
  // Approximate first-day interest on a $10,000 balance.
  const firstDay = (10000 * dailyRate).toFixed(2)
  return (
    <>
      <p className="text-foreground">
        The {LATE_RATE_PCT}% is a true APR, compounded daily. The daily rate
        is <code>(1 + {LATE_INTEREST_RATE_PER_ANNUM})^(1/365) - 1</code>,
        which is about {dailyRatePct} percent.
      </p>
      <p className="text-muted-foreground">
        On a $10,000 balance that is about ${firstDay} the first day, and a
        little more each day after because the next day&apos;s interest is on
        the slightly higher balance.
      </p>
    </>
  )
}

function WhyDoesBrokerageHaveSettlementWindow() {
  return (
    <>
      <p className="text-foreground">
        Closing day is when your commission lands in your brokerage&apos;s
        trust account. Your brokerage needs a few business days to clear
        funds and remit our portion.
      </p>
      <p className="text-muted-foreground">
        The standard window is {SETTLEMENT_PERIOD_DAYS} calendar days after
        closing. We snapshot that window into the deal at funding, so later
        amendments do not move the goalposts on that specific deal.
      </p>
    </>
  )
}

function WhyDidSettlementWindowJumpTo14() {
  return (
    <>
      <p className="text-foreground">
        Your brokerage hit {BROKERAGE_LATE_STRIKE_THRESHOLD} manual
        late-payment strikes. When that happens the system auto-bumps your
        window to {BROKERAGE_BUMPED_SETTLEMENT_DAYS} days for new deals
        going forward.
      </p>
      <p className="text-muted-foreground">
        Existing funded deals keep whatever window was snapshotted at
        funding. Ship every payment on time for a full quarter and Firm
        Funds will manually clear the bump.
      </p>
    </>
  )
}

function IsMyInformationSecure() {
  return (
    <>
      <p className="text-foreground">
        Yes. We use Postgres with row-level security, so every database
        query is filtered by your account ID before any data leaves the
        database.
      </p>
      <p className="text-muted-foreground">
        Sensitive endpoints use a strict Content Security Policy, CSRF
        protection, and same-origin checks. KYC documents live in an
        ownership-scoped storage bucket and are not visible to other
        brokerages.
      </p>
    </>
  )
}

function WhoIsFirmFunds() {
  return (
    <>
      <p className="text-foreground">
        Firm Funds Inc. is an Ontario-based commission advance company. We
        pay real estate agents the bulk of their commission as soon as the
        deal is firm, then collect from the brokerage at closing.
      </p>
      <p className="text-muted-foreground">
        We are not a bank or a lender to the public; this is a purchase of a
        future commission receivable.
      </p>
    </>
  )
}

function CanICancelAnAdvance() {
  return (
    <>
      <p className="text-foreground">
        While the deal is in <code>under_review</code> you can withdraw it
        by messaging Firm Funds. Once it moves to <code>approved</code> the
        documents are out for signature; you can still walk away until the
        IDP is countersigned.
      </p>
      <p className="text-muted-foreground">
        After <code>funded</code> the money has moved. If the deal then
        fails to close, the failed-to-close path applies.
      </p>
    </>
  )
}

function GrossVsNetCommission() {
  return (
    <>
      <p className="text-foreground">
        Gross commission is the full commission your brokerage receives.
        Net commission is what is left after your brokerage&apos;s split.
      </p>
      <p className="text-muted-foreground">
        We advance against the net, not the gross.
      </p>
    </>
  )
}

function WhyIsMyApprovalTakingSoLong() {
  return (
    <>
      <p className="text-foreground">
        Most advances are reviewed the same business day. If your deal sits
        in <code>under_review</code> more than 24 business hours, we are
        usually waiting on a document such as a trust receipt, a signed
        agreement of purchase and sale, or the MLS firm record. Your KYC
        may also have flagged for manual review.
      </p>
      <p className="text-muted-foreground">
        Message us from the deal page and we will tell you exactly what we
        are waiting on.
      </p>
    </>
  )
}

export const sharedFaqs: HelpFaq[] = [
  {
    id: 'how-is-advance-calculated',
    role: 'shared',
    category: 'money-and-policy',
    question: 'How is my advance calculated?',
    Answer: HowIsAdvanceCalculated,
    related: ['how-the-advance-is-calculated'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'why-is-closing-day-not-charged',
    role: 'shared',
    category: 'money-and-policy',
    question: 'Why is the closing day not charged?',
    Answer: WhyIsClosingDayNotCharged,
    related: ['how-the-advance-is-calculated'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'what-happens-if-deal-falls-through',
    role: 'shared',
    category: 'failed-deals',
    question: 'What happens if my deal falls through?',
    Answer: WhatHappensIfDealFallsThrough,
    related: [
      'what-happens-if-deal-falls-through',
      'what-a-remediation-idp-is',
      'late-interest-rules',
    ],
    updatedAt: '2026-05-29',
  },
  {
    id: 'what-is-a-remediation-idp',
    role: 'shared',
    category: 'failed-deals',
    question: 'What is a Remediation IDP?',
    Answer: WhatIsARemediationIdp,
    related: ['what-a-remediation-idp-is', 'pay-remediation-idp'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'what-does-late-interest-cost-per-day',
    role: 'shared',
    category: 'failed-deals',
    question: 'What does the 24% late interest actually cost me per day?',
    Answer: WhatDoesLateInterestCostPerDay,
    related: ['late-interest-rules'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'why-does-brokerage-have-settlement-window',
    role: 'shared',
    category: 'settlements',
    question: 'Why does my brokerage have a settlement window?',
    Answer: WhyDoesBrokerageHaveSettlementWindow,
    related: ['settlement-window'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'why-did-settlement-window-jump-to-14',
    role: 'shared',
    category: 'settlements',
    question: 'Why did our brokerage settlement window jump from 7 to 14 days?',
    Answer: WhyDidSettlementWindowJumpTo14,
    related: ['settlement-window', 'late-strikes-and-the-14-day-bump'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'is-my-information-secure',
    role: 'shared',
    category: 'support',
    question: 'Is my information secure?',
    Answer: IsMyInformationSecure,
    related: ['security-and-data'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'who-is-firm-funds',
    role: 'shared',
    category: 'support',
    question: 'Who is Firm Funds?',
    Answer: WhoIsFirmFunds,
    related: ['contacting-firm-funds'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'can-i-cancel-an-advance',
    role: 'shared',
    category: 'deals',
    question: 'Can I cancel an advance after I request it?',
    Answer: CanICancelAnAdvance,
    related: ['submit-a-deal'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'gross-vs-net-commission',
    role: 'shared',
    category: 'money-and-policy',
    question: 'What is the difference between gross and net commission?',
    Answer: GrossVsNetCommission,
    related: ['how-the-advance-is-calculated'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'why-is-my-approval-taking-so-long',
    role: 'shared',
    category: 'deals',
    question: 'Why is my approval taking so long?',
    Answer: WhyIsMyApprovalTakingSoLong,
    related: ['submit-a-deal', 'upload-kyc-documents'],
    updatedAt: '2026-05-29',
  },
]
