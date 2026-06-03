import type { HelpArticle } from '../../types'
import HelpStepList from '@/components/help/HelpStepList'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        Your banking info on file is where Firm Funds sends every advance. Update it
        whenever you switch banks, change accounts, or notice the numbers on the file
        are wrong. New banking info needs to be verified by Firm Funds before it
        becomes active, so do not wait until the day of a closing.
      </p>

      <HelpCallout variant="warning" title="Closing inside 48 hours? Message us first">
        New banking info goes into a &quot;pending verification&quot; state before
        we will fund against it. If you have a deal closing in the next two days,
        send us a quick note from the deal page so we can prioritise the review.
      </HelpCallout>

      <h2>The steps</h2>
      <HelpStepList steps={[
        {
          title: 'Open your Profile',
          expected: 'Click Profile in the header. You land on the My Profile page with sections for Personal Information and Banking Information.',
        },
        {
          title: 'Scroll to the Banking Information card',
          expected: 'You see three fields: Transit Number (5 digits), Institution Number (3 digits), and Account Number (7 to 12 digits).',
          fallback: 'If you do not know these, your bank can give them to you in two minutes, or any void cheque has them printed across the bottom.',
        },
        {
          title: 'Enter the new numbers',
          expected: 'The fields strip out anything that is not a digit as you type. Double-check before you save.',
        },
        {
          title: 'Click Submit Banking',
          expected: 'A green confirmation flashes saying "Banking info submitted for review". The status next to the form switches to "pending".',
        },
        {
          title: 'Wait for Firm Funds to verify',
          expected: 'You get an email when banking is approved. Until then the new numbers do not replace your old active ones, so any in-flight advance still goes to the previous account.',
          fallback: 'If verification takes longer than one business day, message us. Most reviews happen the same day.',
        },
      ]} />

      <h2>The pre-authorized debit form</h2>
      <p>
        We also need a signed pre-authorized debit (PAD) form on file. This is what
        lets us pull funds back from your account if a deal fails to close and you
        opt for cash repayment. Most banks will email you one in under a minute, or
        you can upload a photo of a void cheque.
      </p>
      <p>
        On the same Profile page, scroll to the &quot;Pre-authorized Debit Form&quot;
        section, click Upload, pick the file (PDF, JPEG, or PNG, up to 10MB), and
        you are done.
      </p>

      <h2>If something does not work</h2>
      <ul>
        <li>Save button does nothing? Make sure all three fields are filled in with
          the right number of digits.</li>
        <li>Status stays on &quot;rejected&quot;? Open the rejection note on the page
          (red box at the top of the Banking card) for the specific reason. Most
          rejections are a typo in the account number.</li>
        <li>Need to use a joint account or a corporate account? Message us before
          you submit. We can usually accommodate it but we like to see the
          paperwork first.</li>
      </ul>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'update-banking-info',
    title: 'Update your banking information',
    summary: 'Edit your account on file, plus what happens between save and active.',
    role: 'agent',
    category: 'getting-started',
    order: 60,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
