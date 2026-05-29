import type { HelpArticle } from '../../types'
import HelpStepList from '@/components/help/HelpStepList'
import HelpCallout from '@/components/help/HelpCallout'
import { DISCOUNT_RATE_PER_1000_PER_DAY } from '@/lib/constants'

function Body() {
  return (
    <>
      <p>
        When a deal goes firm and you want an advance on your commission, you fill out
        the New Advance Request form. The form runs a live preview as you type so you
        see your advance amount before you submit. This article walks through the whole
        flow, what to upload, and what happens next.
      </p>

      <HelpCallout variant="note" title="Two things have to be done first">
        Identity verification has to read &quot;verified&quot; on your dashboard, and your
        banking info has to be on file. If either is missing, the New Advance Request
        button is disabled. Open Account Setup from your dashboard to finish them.
      </HelpCallout>

      <h2>The steps</h2>
      <HelpStepList steps={[
        {
          title: 'Open the form',
          expected: 'From your dashboard, click "New Advance Request" in the top-right. You land on a form titled "New Advance Request".',
          fallback: 'If the button is greyed out, hover over it. The tooltip tells you which prerequisite is missing.',
        },
        {
          title: 'Fill the property details',
          expected: 'Street, city, province (defaults to Ontario), postal code, closing date, and which side of the deal you represent. Closing date has to be at least one day from today.',
        },
        {
          title: 'Enter commission and split',
          expected: 'Gross commission is your full commission from the deal before your brokerage takes its cut. Brokerage split is a whole number (type 5 for 5%, not 0.05).',
          fallback: 'If you enter 5%, the form treats it as 5 percent. Decimal values like 0.05 will give you wildly inflated fees.',
        },
        {
          title: 'Watch the live preview',
          expected: `An Advance Preview card appears showing your net commission, the discount fee at $${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day, the settlement period fee, and your final advance amount. The preview updates in real time as you change inputs.`,
        },
        {
          title: 'Upload your supporting documents',
          expected: 'Agreement of Purchase and Sale is required. Notice of Fulfillment, amendments, and (if this is your first advance) banking info each have their own upload slot. PDF, JPG, PNG, or Word.',
          fallback: 'You can submit without optional documents and upload them later from the deal page, but the APS has to come in with the submission.',
        },
        {
          title: 'Tick the firm-deal box and submit',
          expected: 'Check the box confirming the APS is firm and unconditional, click Review & Submit, double-check the numbers in the confirmation modal, then click Confirm & Submit. You land back on the dashboard and the deal shows up at the top under "Under Review".',
        },
      ]} />

      <h2>What happens after you submit</h2>
      <p>
        Firm Funds underwriting picks up the deal and reviews your documents. Most
        deals move from Under Review to Approved within one business day. Once
        approved, the contract goes out for signature, and after both you and the
        brokerage sign, the funds land in your account.
      </p>

      <h2>If something does not work</h2>
      <ul>
        <li>Preview not appearing? You probably have a blank or invalid field. The
          yellow box above the preview lists what is missing.</li>
        <li>Document upload failed? It still let you submit the deal. Open the deal
          from your dashboard and use the document upload section there to retry.</li>
        <li>Closing date rejected? Pick a date at least one day from today. Same-day
          and past-day closings cannot be advanced.</li>
        <li>Got a denial? Open the deal from your dashboard and click Resubmit. The
          form pre-fills with your original details so you only have to fix what
          underwriting flagged.</li>
      </ul>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'submit-a-deal',
    title: 'Submit an advance request',
    summary: 'Fill the new-deal form, upload supporting documents, watch the fee preview update.',
    role: 'agent',
    category: 'deals',
    order: 20,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
