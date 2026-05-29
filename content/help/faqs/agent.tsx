import type { HelpFaq } from '../types'
import { LATE_INTEREST_RATE_PER_ANNUM } from '@/lib/constants'

const LATE_RATE_PCT = Math.round(LATE_INTEREST_RATE_PER_ANNUM * 100)

function HowDoIUpdateBankingInfo() {
  return (
    <>
      <p className="text-foreground">
        Open the Profile page from the header, scroll to Banking Information,
        edit the fields, and click Save.
      </p>
      <p className="text-muted-foreground">
        Firm Funds verifies new banking details before they are used for
        funding, so allow one business day. If you have a closing inside 48
        hours, message us as soon as you change anything so we can prioritize.
      </p>
    </>
  )
}

function HowDoISeeWhatIOwe() {
  return (
    <>
      <p className="text-foreground">
        The Account Balance page (header link with a wallet icon) shows your
        current balance and every transaction line item.
      </p>
      <p className="text-muted-foreground">
        Late interest, failed-deal interest, credits from Remediation
        remittances, and adjustments are all there. A positive balance means
        you owe us.
      </p>
    </>
  )
}

function TransactionTypesOnLedger() {
  return (
    <>
      <p className="text-foreground">Here is what each row type means:</p>
      <dl className="space-y-3 text-foreground">
        <div>
          <dt className="text-primary">
            <code>late_closing_interest</code> and{' '}
            <code>late_payment_interest</code>
          </dt>
          <dd className="text-muted-foreground">
            Interest while a funded deal is overdue.
          </dd>
        </div>
        <div>
          <dt className="text-primary">
            <code>failed_deal_balance</code>
          </dt>
          <dd className="text-muted-foreground">
            Original unpaid principal when a deal fails to close.
          </dd>
        </div>
        <div>
          <dt className="text-primary">
            <code>failed_deal_interest</code>
          </dt>
          <dd className="text-muted-foreground">
            Monthly compounded interest posted to your ledger.
          </dd>
        </div>
        <div>
          <dt className="text-primary">
            <code>balance_deduction</code> and <code>invoice_payment</code>
          </dt>
          <dd className="text-muted-foreground">
            Money we pulled to settle a charge.
          </dd>
        </div>
        <div>
          <dt className="text-primary">
            <code>credit</code>
          </dt>
          <dd className="text-muted-foreground">
            Money we applied (typically from a Remediation remittance).
          </dd>
        </div>
        <div>
          <dt className="text-primary">
            <code>adjustment</code>
          </dt>
          <dd className="text-muted-foreground">
            A manual one-off, always with a note from Firm Funds.
          </dd>
        </div>
      </dl>
    </>
  )
}

function MyClosingDateMoved() {
  return (
    <>
      <p className="text-foreground">
        Ask your brokerage to file the amendment from their dashboard.
      </p>
      <p className="text-muted-foreground">
        Once they file it we update the deal and recompute downstream dates.
      </p>
    </>
  )
}

function Missed15DayCureDeadline() {
  return (
    <>
      <p className="text-foreground">
        The deal stays in <code>failed_to_close</code> and Firm Funds reaches
        out directly.
      </p>
      <p className="text-muted-foreground">
        Interest continues to accrue at {LATE_RATE_PCT} percent APR regardless.
        Get in touch right away if you missed the window.
      </p>
    </>
  )
}

function SignupWithoutEmail() {
  return (
    <>
      <p className="text-foreground">
        Most agents have an email, but a small number of brokerages keep their
        roster phone-only. The <code>agents.email</code> column is
        intentionally nullable.
      </p>
      <p className="text-muted-foreground">
        We will route notifications through your brokerage admin until an
        email is added.
      </p>
    </>
  )
}

function NotificationIconStuck() {
  return (
    <>
      <p className="text-foreground">
        The agent header polls every 30 seconds for unread messages and
        pending KYC returns.
      </p>
      <p className="text-muted-foreground">
        Click into each open thread once and the counter clears. If it
        persists, refresh.
      </p>
    </>
  )
}

function EmailAddressFirmFundsUses() {
  return (
    <>
      <p className="text-foreground">
        All notifications come from{' '}
        <code>notifications@firmfunds.ca</code>.
      </p>
      <p className="text-muted-foreground">
        If you ever get a message claiming to be Firm Funds from a different
        domain, do not click links; forward it to{' '}
        <a
          href="mailto:bud@firmfunds.ca"
          className="text-primary hover:underline"
        >
          bud@firmfunds.ca
        </a>
        .
      </p>
    </>
  )
}

export const agentFaqs: HelpFaq[] = [
  {
    id: 'how-do-i-update-banking-info',
    role: 'agent',
    category: 'kyc-and-banking',
    question: 'How do I update my banking info?',
    Answer: HowDoIUpdateBankingInfo,
    related: ['update-banking-info'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'how-do-i-see-what-i-owe',
    role: 'agent',
    category: 'money-and-policy',
    question: 'How do I see what I owe Firm Funds right now?',
    Answer: HowDoISeeWhatIOwe,
    related: ['account-balance-and-ledger'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'transaction-types-on-ledger',
    role: 'agent',
    category: 'money-and-policy',
    question: 'What does each transaction type on the ledger mean?',
    Answer: TransactionTypesOnLedger,
    related: ['account-balance-and-ledger'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'my-closing-date-moved',
    role: 'agent',
    category: 'deals',
    question: 'My closing date moved. What do I do?',
    Answer: MyClosingDateMoved,
    related: ['reading-your-dashboard'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'missed-15-day-cure-deadline',
    role: 'agent',
    category: 'failed-deals',
    question: 'I missed the 15-day cure election deadline. What happens?',
    Answer: Missed15DayCureDeadline,
    related: [
      'what-happens-if-deal-falls-through',
      'late-interest-rules',
    ],
    updatedAt: '2026-05-29',
  },
  {
    id: 'signup-without-email',
    role: 'agent',
    category: 'getting-started',
    question: 'Can I sign up without an email address on file?',
    Answer: SignupWithoutEmail,
    related: ['first-time-signing-in'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'notification-icon-stuck',
    role: 'agent',
    category: 'support',
    question: "The notification icon shows a count but I can't find the message.",
    Answer: NotificationIconStuck,
    related: ['reading-your-dashboard'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'email-address-firm-funds-uses',
    role: 'agent',
    category: 'support',
    question: 'What email address does Firm Funds send from?',
    Answer: EmailAddressFirmFundsUses,
    related: ['contacting-firm-funds'],
    updatedAt: '2026-05-29',
  },
]
