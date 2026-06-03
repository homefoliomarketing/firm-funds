import type { HelpArticle } from '../../types'
import HelpStepList from '@/components/help/HelpStepList'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        Once your brokerage has sent payment for a settled deal, log it in the
        portal so Firm Funds can match it to a bank deposit. This walkthrough
        covers the Record Payment modal end to end and explains the difference
        between pending and confirmed status.
      </p>

      <h2>Walkthrough</h2>
      <HelpStepList
        steps={[
          {
            title: 'Open the Settlements tab',
            expected: 'On your brokerage dashboard, click the Settlements tab. The list shows every funded or completed deal with an amount due.',
            fallback: 'If the tab looks empty, you may not have any settlements outstanding. Check the Deals tab to confirm none are sitting in Funded status with money owed.',
          },
          {
            title: 'Click Record payment',
            expected: 'The Record Payment modal opens. It loads the list of payable deals for your brokerage.',
            fallback: 'If the modal does not open, refresh the page and try again. If it still does not appear, message Firm Funds from the dashboard.',
          },
          {
            title: 'Pick the deal',
            expected: 'Select the deal from the dropdown. A summary panel appears showing the amount owed, what is remaining after confirmed payments, and any pending amount.',
          },
          {
            title: 'Enter the amount and date',
            expected: 'Type the payment amount in CAD and pick the date you actually sent the funds. The date cannot be in the future. Use the Fill remaining shortcut if you are paying the full outstanding amount.',
            fallback: 'If you are recording a partial payment, just put in the partial amount. You can record another payment later for the rest.',
          },
          {
            title: 'Choose the method',
            expected: 'Pick from EFT / e-Transfer, Wire transfer, Cheque, Cash / in-person, or Other. This helps Firm Funds match the right deposit to the right deal.',
          },
          {
            title: 'Add a reference (optional)',
            expected: 'Cheque number, wire reference, or EFT confirmation. Up to 200 characters. Optional, but recommended so reconciliation is faster.',
          },
          {
            title: 'Save',
            expected: 'Click Record payment. The modal closes and a banner confirms the claim was logged. The deal row now shows the pending amount.',
            fallback: 'If save fails with a validation error, check that the amount is a positive number, the date is not blank, and a deal is selected.',
          },
        ]}
      />

      <h2>Pending vs confirmed</h2>
      <p>
        Every payment you log starts as <strong>pending</strong>. That means
        we have your claim but have not yet matched it to a deposit in our
        bank account. Pending amounts do not reduce the balance owed on the
        deal.
      </p>
      <p>
        Firm Funds reconciles against the bank deposit, typically within one
        business day of the funds arriving. When the match lands, your
        payment flips to <strong>confirmed</strong>, the balance comes down,
        and the deal moves toward Completed once it is fully paid.
      </p>

      <HelpCallout variant="note" title="If a payment is stuck on pending">
        <p>
          If a payment has been pending for more than two business days,
          message Firm Funds from the deal thread with the bank reference
          number and the date you sent it. Most stuck payments are a
          reference-matching issue, not a missing deposit.
        </p>
      </HelpCallout>

      <HelpCallout variant="warning" title="Rejected payments">
        <p>
          On rare occasions Firm Funds flips a payment to <strong>rejected</strong>:
          for example, the deposit was reversed, or the amount was logged
          against the wrong deal. The reason appears on the row. Once you have
          read it, re-record the payment against the correct deal or with the
          corrected amount.
        </p>
      </HelpCallout>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'record-a-payment',
    title: 'Record a payment',
    summary: 'Modal walkthrough, methods, references, and what pending vs confirmed means.',
    role: 'brokerage',
    category: 'deals',
    order: 50,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
