import type { HelpArticle } from '../../types'
import HelpStepList from '@/components/help/HelpStepList'
import HelpCallout from '@/components/help/HelpCallout'
import { KYC_DOCUMENT_TYPES } from '@/lib/constants'

function Body() {
  return (
    <>
      <p>
        Before Firm Funds can fund any advance, FINTRAC rules require us to verify
        your identity. You upload a photo of a government-issued ID once, we review
        it, and you are set for every future advance. The whole thing usually takes
        about a minute on your phone.
      </p>

      <h2>What we accept</h2>
      <p>You need a clear photo or PDF of one of these:</p>
      <ul>
        {KYC_DOCUMENT_TYPES.map(t => (
          <li key={t.value}>{t.label}</li>
        ))}
      </ul>
      <p>
        The ID has to be valid (not expired) and the name on it has to match the name
        your brokerage has on file. If your ID is two-sided, upload both sides.
      </p>

      <HelpCallout variant="note" title="JPEG, PNG, or PDF only. Up to 10MB per file.">
        A photo from your phone is usually under 5MB. If the file is larger, retake
        the photo in a lower-quality mode or save the PDF as compressed.
      </HelpCallout>

      <h2>Two ways to upload</h2>
      <p>
        From your dashboard or the Account Setup wizard, you have two choices. Pick
        whichever is easier for the device you are on.
      </p>

      <h3>Option A: Upload directly</h3>
      <HelpStepList steps={[
        {
          title: 'Open the ID upload card',
          expected: 'You see a "Type of ID" dropdown and a dashed box that says "Drop your ID here or tap to browse files."',
        },
        {
          title: 'Pick your ID type from the dropdown',
          expected: 'The list matches the accepted IDs above.',
        },
        {
          title: 'Take a photo or select a file',
          expected: 'On a phone, tap "Take Photo" to use the camera. On a desktop, drag the file into the box or click to browse. Each file shows up in the list with a remove button.',
          fallback: 'If you get "Invalid file type", make sure you saved as JPEG, PNG, or PDF (no HEIC).',
        },
        {
          title: 'Click Submit for Verification',
          expected: 'The card flips to "Identity Verification In Progress" with a "Submitted, Awaiting Review" badge.',
        },
      ]} />

      <h3>Option B: Send the link to your phone</h3>
      <p>
        If you are at your computer but your ID is in your wallet, click
        &quot;Need to use your phone? Send a link to your email&quot; at the bottom of the
        upload card. We email you a one-time link, you open it on your phone, snap a
        photo, and the desktop page picks up the status change automatically within
        about 30 seconds.
      </p>

      <h2>What &quot;verified&quot; means</h2>
      <p>
        Once a Firm Funds reviewer confirms your ID, your status flips from
        &quot;submitted&quot; to &quot;verified&quot;. You get a confirmation popup on your dashboard
        the first time you log in after that, and the New Advance Request button
        unlocks. If something is wrong, the status flips to &quot;rejected&quot; with a note
        explaining what to fix, and the upload card reopens so you can resubmit.
      </p>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'upload-kyc-documents',
    title: 'Upload KYC documents',
    summary: 'What we need, how to send it from your phone, what verified means.',
    role: 'agent',
    category: 'kyc-and-banking',
    order: 30,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
