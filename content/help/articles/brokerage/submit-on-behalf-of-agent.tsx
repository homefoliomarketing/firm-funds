import type { HelpArticle } from '../../types'
import HelpStepList from '@/components/help/HelpStepList'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        Most advance requests are filed by the brokerage on behalf of the
        agent. This walkthrough covers the new-deal form, what the fee preview
        is telling you, and what happens after you click submit.
      </p>

      <h2>Before you start</h2>
      <p>
        The agent has to be on your roster and KYC-verified. If they are not
        in the picker, open Manage agents from the Welcome row, add them, and
        come back. You also need the trade record, the Agreement of Purchase
        and Sale, and any waivers or amendments ready to upload.
      </p>

      <h2>Walkthrough</h2>
      <HelpStepList
        steps={[
          {
            title: 'Open the new-deal form',
            expected: 'Click Submit a new deal from the Deals tab. The new-deal page loads with an agent picker, a property address field, and a fee preview card on the right.',
            fallback: 'If you do not see the button, refresh the page. Admin and Manager accounts both have submit access; if you are signed in as a Broker of Record viewer with a different brokerage, the button stays hidden.',
          },
          {
            title: 'Pick the agent',
            expected: 'Choose the agent from the dropdown. Only active, KYC-verified agents appear in this list.',
            fallback: 'If the agent is missing, their KYC probably has not been approved yet. Open Manage agents to review their submission, or add them if they are new.',
          },
          {
            title: 'Fill the property and closing date',
            expected: 'Type the property address (autocomplete will help) and pick the closing date. Closing must be at least 2 days out and no more than 120 days out.',
          },
          {
            title: 'Enter gross commission and split',
            expected: 'Gross commission is the full amount before any split. Brokerage split percentage is a whole number, so 5 means 5 percent. 20 means 20 percent. Do not type 0.05.',
            fallback: 'If the fee preview suddenly looks too large or too small, double-check that you typed the split as a whole number. Typing 0.05 makes the system charge fees on a much larger net commission.',
          },
          {
            title: 'Read the fee preview',
            expected: 'The card on the right updates live with the net commission, the discount fee, the settlement period fee, the advance amount your agent will receive, and what your brokerage will owe at closing.',
          },
          {
            title: 'Upload supporting documents',
            expected: 'Drop the trade record and the Agreement of Purchase and Sale into the upload area. Amendments and waivers are optional but speed up underwriting.',
            fallback: 'Each file has to be under 25 MB. PDF, Word, Excel, and common image formats are accepted. If a file gets stuck uploading, refresh and try again.',
          },
          {
            title: 'Submit',
            expected: 'Click Submit advance request. The page redirects back to the Deals tab and the new row shows up at the top with status Under Review. The agent gets an email letting them know.',
            fallback: 'If submit is greyed out, check that every required field has a value and that the trade record and Agreement of Purchase and Sale are both attached.',
          },
        ]}
      />

      <HelpCallout variant="note" title="What happens after Under Review">
        <p>
          Firm Funds reviews most advances the same business day. You will see
          the status change to Approved (documents go out for signature),
          Funded (we send the money), and Completed (your brokerage settled
          on time). If we need anything, we reach out in the deal message
          thread.
        </p>
      </HelpCallout>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'submit-on-behalf-of-agent',
    title: 'Submit a deal on behalf of an agent',
    summary: 'Pick the agent, fill the property, check the fee preview, submit.',
    role: 'brokerage',
    category: 'deals',
    order: 20,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
