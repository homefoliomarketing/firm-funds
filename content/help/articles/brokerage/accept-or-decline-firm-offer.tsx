import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        When Firm Funds detects one of your agents had a deal go firm and the
        agent accepts our advance offer, the request lands on your dashboard
        for you to finish. This article covers how that handoff appears, what
        each row tells you, and how to accept or decline.
      </p>

      <h2>Where the offers show up</h2>
      <p>
        Open the Deals tab on your brokerage dashboard. If any offers are
        waiting, a green-bordered banner sits at the very top above your
        regular deals list, headlined &quot;1 agent is waiting on you to submit
        an advance&quot; or &quot;N agents are waiting on you to submit an
        advance.&quot; The banner only appears when there is at least one
        pending offer.
      </p>

      <h2>What each row tells you</h2>
      <p>
        Every row in the banner is one offered deal. You will see:
      </p>
      <ul>
        <li><strong>Property address</strong>: the address parsed from the firm-deal notice we received.</li>
        <li><strong>Agent name</strong>: which of your agents accepted the offer.</li>
        <li><strong>Closing date</strong>: from the same parsed notice, used to estimate timing.</li>
        <li><strong>Accepted date</strong>: when the agent clicked the offer email and asked you to submit on their behalf.</li>
      </ul>

      <h2>Submitting the advance</h2>
      <p>
        Click <strong>Submit advance</strong> on the row. You land on a
        pre-filled new-deal form with the property address and closing date
        already in place. You still need to add:
      </p>
      <ul>
        <li>The gross commission and your brokerage split percentage (whole number, so 5 means 5 percent).</li>
        <li>The trade record sheet.</li>
        <li>The Agreement of Purchase and Sale, plus any amendments or waivers.</li>
      </ul>
      <p>
        Submitting flips the deal from Offered to Under Review and Firm Funds
        starts underwriting from there.
      </p>

      <h2>Declining the offer</h2>
      <p>
        If the deal does not qualify for an advance, click <strong>Decline</strong>.
        A modal asks for a short reason (at least 3 characters, up to 500).
        Examples: the agent has an outstanding balance from a previous deal,
        the deal structure does not fit an advance, or the commission has
        already been spent on something else.
      </p>
      <p>
        The reason is shown to the agent so they understand what happened.
        The deal flips to Cancelled and disappears from your banner.
      </p>

      <HelpCallout variant="warning" title="Offers expire after 60 days">
        <p>
          If neither of you takes action, the offer automatically expires 60
          days after acceptance and the row disappears. Firm Funds also sends
          you reminders at 2 hours and 4 hours after acceptance to nudge the
          submission along, so most offers move within the same business day.
        </p>
      </HelpCallout>

      <HelpCallout variant="note" title="Dual-agency deals">
        <p>
          If two of your agents represent each side of the same transaction,
          each side comes through as a separate row in the banner. They are
          two separate advance requests with their own commissions, contracts,
          and settlements. Submit or decline each independently.
        </p>
      </HelpCallout>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'accept-or-decline-firm-offer',
    title: 'Reviewing a firm-deal offer',
    summary: 'Open the offer banner, accept and submit, or decline with a reason.',
    role: 'brokerage',
    category: 'deals',
    order: 30,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
