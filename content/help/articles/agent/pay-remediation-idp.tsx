import type { HelpArticle } from '../../types'
import HelpStepList from '@/components/help/HelpStepList'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        When you elect commission assignment as the cure path on a failed deal, Firm
        Funds prepares a Remediation Irrevocable Direction to Pay (Remediation IDP).
        That is a one-page document you and your brokerage sign that redirects a
        specific upcoming commission of yours to Firm Funds. Once both signatures
        are in, your brokerage remits the directed amount straight to us when that
        next deal closes, and your balance clears. This article walks through what
        you sign and how the credit lands on your ledger.
      </p>

      <h2>What an Irrevocable Direction to Pay is</h2>
      <p>
        An IDP is a legal instruction from you to your brokerage&apos;s trust
        account. It says &quot;when commission X comes in on deal Y, send this
        specific dollar amount to Firm Funds instead of paying it to me.&quot; Once
        you sign it, you cannot unilaterally reverse it. That is the
        &quot;irrevocable&quot; part, and it is the reason the brokerage can rely
        on it as a legitimate redirection of funds.
      </p>
      <p>
        Under Article 5.5(b) of your Commission Purchase Agreement with Firm Funds,
        the Remediation IDP is the standard tool we use to satisfy the outstanding
        balance on a failed deal when you opt for commission assignment instead of
        cash repayment.
      </p>

      <HelpCallout variant="note" title="The brokerage signs too">
        The Remediation IDP is a three-way arrangement: you direct, your brokerage
        acknowledges and agrees to remit, and Firm Funds receives. All three
        signatures have to be on the document for it to be valid.
      </HelpCallout>

      <h2>The steps from your side</h2>
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
          expected: 'On /agent/failed-deals, the row for the remediation deal shows the envelope status. It goes from "sent" to "agent signed" to "fully signed" as signatures come in.',
        },
        {
          title: 'Watch for the ledger credit',
          expected: 'When that future deal closes and your brokerage remits the directed amount to Firm Funds, we apply the payment to your ledger as a Credit line item. Your outstanding balance drops by that amount, and if the credit covers the whole balance, the failed deal status moves to Cured.',
        },
      ]} />

      <h2>If the assigned deal also falls through</h2>
      <p>
        Real estate is real estate. If the deal you assigned does not close, the
        Remediation IDP for that deal just expires unfulfilled. Add a new upcoming
        deal in the Failed Deals workspace and we will issue a fresh Remediation IDP
        for the next one. The original balance and any accrued interest stay on
        your ledger until something pays them off.
      </p>

      <h2>If something does not work</h2>
      <ul>
        <li>DocuSign envelope expired? Message us and we will resend. Envelopes
          have a finite validity window.</li>
        <li>Signed but the status did not update? Refresh the Failed Deals page.
          The webhook usually catches the signature within a minute, but a refresh
          forces a re-read.</li>
        <li>Brokerage tells you they remitted but no credit on your ledger? Send
          us the date and the bank reference and we will reconcile.</li>
      </ul>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'pay-remediation-idp',
    title: 'Paying a Remediation IDP',
    summary: 'What you sign, what your brokerage remits, and how the credit lands on your ledger.',
    role: 'agent',
    category: 'failed-deals',
    order: 80,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
