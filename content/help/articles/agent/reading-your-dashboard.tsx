import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import HelpStatusFlowDiagram from '@/components/help/HelpStatusFlowDiagram'

function Body() {
  return (
    <>
      <p>
        Your dashboard is the home page for everything you do in Firm Funds. It pulls
        together your active deals, your account balance, anything that needs your
        attention, and any firm-deal offer your brokerage just got. This article walks
        you through what each section is telling you so nothing on that screen feels
        mysterious.
      </p>

      <h2>The status badges on each deal</h2>
      <p>
        Every deal you see on the dashboard wears a coloured status badge. The badge
        tells you exactly where the deal is in the pipeline. Most deals walk through
        the happy path from left to right:
      </p>

      <HelpStatusFlowDiagram />

      <p>
        <strong>Offered</strong> means Firm Funds detected your firm deal and your
        brokerage has been notified to send us the paperwork. You do not have to do
        anything; your brokerage admin submits on your behalf.
      </p>
      <p>
        <strong>Under Review</strong> means the deal is in front of underwriting.
        We are reading the APS, checking your KYC, and confirming the numbers. Most
        deals move on within one business day.
      </p>
      <p>
        <strong>Approved</strong> means the contract is out for signature. After you
        and your brokerage sign, we move to Funded.
      </p>
      <p>
        <strong>Funded</strong> means the money has left our account and is on its
        way to your bank. Your dashboard tile shows the advance amount.
      </p>
      <p>
        <strong>Completed</strong> means closing happened, the brokerage paid us back,
        and the deal is closed out. No further action needed.
      </p>
      <p>
        <strong>Failed to Close</strong> means the deal collapsed before closing. A
        red badge will appear and you will see a Cure Election prompt above your deals
        list. See &quot;What happens if my deal falls through&quot; for the full process.
      </p>

      <h2>The deal cards</h2>
      <p>
        Each row in &quot;Your Deals&quot; shows the property address, the date you
        submitted, the closing date (in amber if it is inside a week), the status
        badge, and the advance amount. Click any row to see the full deal page with
        documents, the message thread, and the fee breakdown.
      </p>

      <h2>The failed-deals strip</h2>
      <p>
        If any deal on your account has failed to close, an amber banner appears at
        the top of the dashboard with a count and a button labelled &quot;Manage your
        remediation deals&quot;. This is your one-click path into the failed-deals
        workspace. It stays visible until every failed deal is cured, so it is your
        long-lived reminder that there is unfinished business.
      </p>

      <h2>The firm-deal offer banner</h2>
      <p>
        Every once in a while Firm Funds spots a freshly firm deal of yours in the
        public record before your brokerage submits a request. When that happens, we
        send you an email and a text, and clicking through lands you on the dashboard
        with a green offer banner across the top.
      </p>

      <HelpCallout variant="note" title="What firm-deal means">
        A firm deal is one where all conditions have been waived or fulfilled. The
        agreement is binding, the parties are committed, and there is a real
        commission on the way. That is the moment Firm Funds can advance against
        your commission.
      </HelpCallout>

      <p>
        The banner has one button: &quot;Notify my brokerage I want an advance&quot;.
        Click it and we send your brokerage admin the deal details so they can submit
        the request on your behalf. You do not fill out a form, you do not chase
        anyone, you just tell us yes.
      </p>

      <h2>The Account Balance link</h2>
      <p>
        The Wallet icon in the header (top of every page) takes you to your account
        ledger. If you owe Firm Funds money (a failed-deal balance, late interest,
        an adjustment), a yellow strip appears on the dashboard with the outstanding
        amount and a &quot;View Ledger&quot; button. A positive balance means you owe us. Zero
        or negative means we owe you or you are square.
      </p>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'reading-your-dashboard',
    title: 'What your dashboard tells you',
    summary: 'Status badges, deal cards, account balance, and firm-deal offers explained.',
    role: 'agent',
    category: 'getting-started',
    order: 40,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
