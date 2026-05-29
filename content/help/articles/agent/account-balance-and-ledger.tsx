import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        Your Account & Ledger page is the single source of truth for any money moving
        between you and Firm Funds outside of a clean, completed advance. Every
        interest charge, every credit from a brokerage remittance, every manual
        adjustment shows up here as a line item with a running balance. Open it from
        the Wallet icon in the header.
      </p>

      <h2>How to read your balance</h2>
      <p>
        The number at the top of the page is your current balance. The rule is simple:
      </p>
      <ul>
        <li>
          <strong>A positive balance means you owe Firm Funds.</strong> The next time
          we fund an advance for you, we deduct this amount before the rest hits your
          bank.
        </li>
        <li>
          <strong>Zero means you are square with us.</strong> Most agents sit here
          most of the time.
        </li>
        <li>
          <strong>A negative balance means we owe you.</strong> That comes up rarely,
          usually after a credit from a Remediation IDP remittance exceeds what was
          outstanding.
        </li>
      </ul>

      <HelpCallout variant="money" title="Balances are deducted from future advances">
        If you have $500 owing and submit a new $20,000 advance request, your bank
        receives $19,500 and the $500 is cleared from your ledger. The deal page
        preview shows this deduction before you submit.
      </HelpCallout>

      <h2>What each transaction type means</h2>
      <p>
        Each row in the ledger has a type label. Here is what every one of them means
        in plain English:
      </p>
      <dl>
        <dt><strong>Late Closing Interest</strong></dt>
        <dd>
          Interest that accrued because your brokerage missed the settlement window
          after closing. You are not personally on the hook for these in normal
          cases; Firm Funds chases the brokerage. This line shows for visibility.
        </dd>

        <dt><strong>Late Payment Interest</strong></dt>
        <dd>
          Interest on an overdue balance you owe Firm Funds directly. Accrues at 24%
          per year, compounded daily.
        </dd>

        <dt><strong>Failed Deal Balance</strong></dt>
        <dd>
          The original advance amount on a deal that fell through, posted to your
          ledger as a debt. This appears the day your deal moves to failed-to-close.
        </dd>

        <dt><strong>Failed Deal Interest</strong></dt>
        <dd>
          Monthly compounded interest on a failed-deal balance. Posts on the
          month-end after the 30-day grace runs out (day 31 onwards). The math
          matches the live amount you see on the cure-election page.
        </dd>

        <dt><strong>Balance Deduction</strong></dt>
        <dd>
          Money we pulled from a new advance to clear an earlier balance. You see
          this on the same day your new advance is funded.
        </dd>

        <dt><strong>Invoice Payment</strong></dt>
        <dd>
          A direct payment from you (EFT, e-transfer, cheque) applied against your
          balance. Posted by Firm Funds when the payment clears.
        </dd>

        <dt><strong>Credit</strong></dt>
        <dd>
          Money applied in your favour. Almost always a Remediation IDP remittance
          your brokerage sent to Firm Funds against a failed deal.
        </dd>

        <dt><strong>Adjustment</strong></dt>
        <dd>
          A manual one-off entry by a Firm Funds admin. The description on the row
          tells you why it was made, and we always reach out to you before posting
          one.
        </dd>
      </dl>

      <h2>The running balance column</h2>
      <p>
        Every row shows the balance at that moment in time, after that transaction
        was applied. Read from the top down to follow your account history. The
        balance at the top row should match the headline number on the page.
      </p>

      <h2>Disputes and questions</h2>
      <p>
        If a row does not look right, message us from any deal page or email
        bud@firmfunds.ca with the date and amount of the line you are asking about.
        We never adjust a balance silently. There is always a description on every
        row explaining what happened and which deal it ties to.
      </p>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'account-balance-and-ledger',
    title: 'Your account balance and ledger',
    summary: 'Read every transaction type and figure out exactly what you owe or what we owe you.',
    role: 'agent',
    category: 'deals',
    order: 50,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
