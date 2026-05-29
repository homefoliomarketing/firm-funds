import type { HelpArticle } from '../../types'
import HelpStepList from '@/components/help/HelpStepList'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        Your brokerage just added you to Firm Funds. The invite email has a one-time link
        that activates your account, lets you pick a password, and walks you through
        identity verification. This article walks through that first sign-in so you know
        what to expect.
      </p>

      <HelpCallout variant="warning" title="The invite link expires in 72 hours">
        If you wait too long, the link stops working. Ask your brokerage admin or email
        bud@firmfunds.ca to send you a fresh one. The new link replaces the old one.
      </HelpCallout>

      <h2>What you need before you start</h2>
      <ul>
        <li>The invite email from notifications@firmfunds.ca</li>
        <li>A government-issued photo ID (driver&apos;s licence, passport, Ontario photo card,
          PR card, or citizenship card)</li>
        <li>Your bank transit, institution, and account number, or a void cheque, if you
          want to finish banking setup in one go</li>
      </ul>

      <h2>The steps</h2>
      <HelpStepList steps={[
        {
          title: 'Open the invite link',
          expected: 'The page shows your name and the email your brokerage put on file. You see a form to create a password.',
          fallback: 'If the page says "Invite Link Unavailable", the link probably expired or was used already. Email bud@firmfunds.ca and we will resend it.',
        },
        {
          title: 'Create your password',
          expected: 'Minimum 12 characters with at least one uppercase, one lowercase, one number, and one special character. Confirm it in the second box and click Set Password & Continue.',
          fallback: 'Use the eye icon to peek at what you typed. If the page rejects it, the rules above are the most common reason.',
        },
        {
          title: 'Land on the setup wizard',
          expected: 'Once your password is saved you are auto-signed-in and dropped on the Account Setup page. The progress bar at the top reads "1. ID Verification, 2. Banking, 3. Done."',
        },
        {
          title: 'Verify your identity',
          expected: 'Upload a clear photo of your government-issued photo ID. You can do this from your computer or send yourself a link to upload from your phone. The page shows "Submitted, Awaiting Review" once Firm Funds picks it up.',
          fallback: 'See the "Upload KYC documents" article in this Help Center for the full walkthrough.',
        },
        {
          title: 'Add your banking info',
          expected: 'Enter your 5-digit transit, 3-digit institution, and account number, and upload a pre-authorized debit form (a PDF or photo of a void cheque works). The status flips to "pending review".',
          fallback: 'You can skip this and add it later from your Profile, but your brokerage cannot fund a deal until banking is on file.',
        },
      ]} />

      <h2>After setup</h2>
      <p>
        Once your ID is verified and your banking is approved, your dashboard switches
        from the setup wizard to the full agent dashboard with your deals list. Your
        brokerage can submit advance requests on your behalf, and any new advance shows
        up under Your Deals.
      </p>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'first-time-signing-in',
    title: 'First time signing in',
    summary: 'Activate your account, set a password, and verify your identity.',
    role: 'agent',
    category: 'getting-started',
    order: 10,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
