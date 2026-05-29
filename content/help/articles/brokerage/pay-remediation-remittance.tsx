import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        When one of your agents has a failed-to-close deal and they elect
        commission assignment as their cure path, Firm Funds creates a
        Remediation Deal that names an upcoming commission of theirs at your
        brokerage. Once both parties sign the Irrevocable Direction to Pay
        (IDP), you take on the obligation to remit the directed amount to
        Firm Funds when that underlying commission lands at your trust
        account. This article covers your side of the workflow.
      </p>

      <h2>How it starts</h2>
      <p>
        From your dashboard, open <strong>Failed deals</strong> on the
        Welcome row. Each row is one of your agents with a deal in
        failed-to-close status. Expand the row to see the cure election the
        agent made:
      </p>
      <ul>
        <li><strong>Cash repayment</strong>: the agent pays Firm Funds directly. Your brokerage is not involved beyond seeing the row.</li>
        <li><strong>Commission assignment</strong>: Firm Funds will create one or more Remediation Deals naming an upcoming commission. This is where you come in.</li>
      </ul>

      <h2>The Remediation Deal lifecycle</h2>
      <p>
        Each Remediation Deal moves through a series of statuses you can see
        on the row when you expand a failed deal.
      </p>
      <ul>
        <li><strong>Draft, IDP not yet sent</strong>: Firm Funds is preparing the directive. No action from you.</li>
        <li><strong>IDP sent, awaiting signature</strong>: DocuSign envelope is out to your agent and your brokerage signatory. Sign when it arrives in your inbox.</li>
        <li><strong>IDP signed, awaiting payment</strong>: both parties signed. The directive is now legally binding. You wait for the named commission to land at your trust account.</li>
        <li><strong>Paid</strong>: Firm Funds confirmed receipt of the directed amount. The row is done.</li>
        <li><strong>Cancelled</strong>: the remediation was withdrawn (rare; usually means the underlying commission fell through).</li>
      </ul>

      <h2>Your obligation once the IDP is signed</h2>
      <p>
        Once a Remediation Deal reaches <strong>IDP signed, awaiting payment</strong>,
        your trust account is on the hook for the directed amount as soon as
        the named commission clears. The IDP names the specific deal address
        and the directed amount. When that deal closes and the commission
        lands:
      </p>
      <ol>
        <li>Pay the directed amount on the IDP to Firm Funds, the same way you would settle a regular funded deal. EFT, wire, or cheque.</li>
        <li>Use the Record Payment modal on the Settlements tab to log it, the same flow you use for normal settlements.</li>
        <li>The remaining commission stays with your agent and is paid out per your usual process.</li>
      </ol>

      <HelpCallout variant="warning" title="Irrevocable means irrevocable">
        <p>
          Once signed, the IDP cannot be unwound by the agent or by the
          brokerage. If the named commission lands at your trust account, the
          directed amount belongs to Firm Funds. If the named deal falls
          through, message Firm Funds so we can replace the IDP with one
          tied to a different upcoming commission.
        </p>
      </HelpCallout>

      <HelpCallout variant="note" title="Late interest on the underlying failed deal">
        <p>
          The original failed deal accrues compound interest at 24 percent
          per year from day 31 after closing until the remediation is fully
          paid. The directed amount on each new IDP reflects the live balance
          at signing time. If the named commission is months away, the next
          IDP we send may be larger than the previous one to cover accrued
          interest.
        </p>
      </HelpCallout>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'pay-remediation-remittance',
    title: 'Pay a Remediation remittance',
    summary: 'What you owe Firm Funds when a signed IDP covers an agent\'s failed deal.',
    role: 'brokerage',
    category: 'failed-deals',
    order: 70,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
