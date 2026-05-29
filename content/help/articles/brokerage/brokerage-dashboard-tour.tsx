import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        Your brokerage dashboard is the home base for submitting advance
        requests, settling funded deals, and keeping in touch with Firm Funds.
        This is a tour of every section you will see when you sign in.
      </p>

      <h2>Header bar</h2>
      <p>
        The top of every page carries the same controls.
      </p>
      <ul>
        <li><strong>Your brokerage logo</strong> on the left links back to this dashboard from any sub-page.</li>
        <li><strong>Messages bell</strong> shows a count of unread threads. Click it to jump to the Messages tab.</li>
        <li><strong>Settings</strong> opens your brokerage profile, banking details, notification preferences, and the link into Team Admins.</li>
        <li><strong>Sign out</strong> ends your session. You will land back on the login screen.</li>
      </ul>

      <h2>Welcome row</h2>
      <p>
        Just under the header you will see a greeting with your first name and
        three quick-action buttons:
      </p>
      <ul>
        <li><strong>Manage agents</strong> opens your full roster. Add new agents, verify their KYC, flag or unflag them.</li>
        <li><strong>Request a deal change</strong> files an amendment for a closing date that has moved. Firm Funds reviews and applies it.</li>
        <li><strong>Failed deals</strong> only shows up when one of your agents has a deal in failed-to-close status. The button carries a count when something needs attention.</li>
      </ul>

      <h2>The action strip</h2>
      <p>
        Below the welcome row sits the action strip. It only shows what is
        actually outstanding, so an empty dashboard says &quot;You are all caught
        up.&quot; The three things that surface here:
      </p>
      <ul>
        <li><strong>Trade records to upload</strong>: deals you submitted that still need the trade record sheet attached.</li>
        <li><strong>Agent IDs to review</strong>: agents who uploaded KYC and are waiting for you to approve or reject.</li>
        <li><strong>Unread messages</strong>: open threads from Firm Funds or one of your agents.</li>
      </ul>
      <p>
        Each tile is a button. Click it and the dashboard jumps to the right
        tab with the relevant rows in view.
      </p>

      <h2>Offered Deals banner</h2>
      <p>
        When Firm Funds detects one of your agents just had a deal go firm, an
        advance offer can be kicked off on their behalf. If the agent accepts,
        a green banner appears at the top of the Deals tab listing each offer
        with the property, agent name, and closing date. From here you either
        click <strong>Submit advance</strong> (lands on a pre-filled new-deal
        form) or <strong>Decline</strong> with a short reason.
      </p>

      <h2>Deals, Settlements, Messages tabs</h2>
      <p>
        The main panel has tabs for the day-to-day work.
      </p>
      <ul>
        <li><strong>Deals</strong>: every active deal, grouped by status. Expand a row to see the fee breakdown, upload documents, or open the message thread.</li>
        <li><strong>Settlements</strong>: deals that have funded and what your brokerage owes Firm Funds. This is where you open the Record Payment modal.</li>
        <li><strong>Messages</strong>: every open thread, with a list on the left and the conversation on the right.</li>
      </ul>

      <HelpCallout variant="note" title="Tabs remember your last spot">
        <p>
          If you click out to another page and back, the dashboard reopens on
          the tab you were on. Use the URL to deep-link straight into a tab,
          for example by clicking a Firm Funds email link.
        </p>
      </HelpCallout>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'brokerage-dashboard-tour',
    title: 'Your brokerage dashboard tour',
    summary: 'Tabs, action strip, offered deals banner, inbox, settings.',
    role: 'brokerage',
    category: 'getting-started',
    order: 10,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
