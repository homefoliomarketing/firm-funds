import type { HelpFaq } from '../types'
import {
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
  BROKERAGE_LATE_STRIKE_THRESHOLD,
  LATE_INTEREST_RATE_PER_ANNUM,
} from '@/lib/constants'

const LATE_RATE_PCT = Math.round(LATE_INTEREST_RATE_PER_ANNUM * 100)

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
        While the deal is under review you can withdraw it
        by messaging Firm Funds. Once it moves to approved the
        documents are out for signature; you can still walk away until the
        IDP is countersigned.
      </p>
      <p className="text-muted-foreground">
        After it is funded the money has moved. If the deal then
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
        under review more than 24 business hours, we are
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
    id: 'what-does-late-interest-cost-per-day',
    role: 'shared',
    category: 'failed-deals',
    question: 'What does the 24% late interest actually cost me per day?',
    Answer: WhatDoesLateInterestCostPerDay,
    related: ['late-interest-rules'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'why-did-settlement-window-jump-to-14',
    role: 'shared',
    category: 'deals',
    question: 'Why did our brokerage settlement window jump from 7 to 14 days?',
    Answer: WhyDidSettlementWindowJumpTo14,
    related: ['settlement-window'],
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
