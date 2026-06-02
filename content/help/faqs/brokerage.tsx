import type { HelpFaq } from '../types'

function HowDoIAddTeamAdmin() {
  return (
    <>
      <p className="text-foreground">
        Open the Team page. Click Invite admin, enter their name and email,
        and pick a role:
      </p>
      <ul className="ml-6 list-disc space-y-1 text-foreground">
        <li>
          Admin: submit deals and manage agents.
        </li>
        <li>
          Manager: everything except changing the
          Broker of Record.
        </li>
      </ul>
      <p className="text-muted-foreground">
        The invitee gets a magic-link email.
      </p>
    </>
  )
}

function DifferenceBetweenBrokerageAdminRoles() {
  return (
    <>
      <dl className="space-y-3 text-foreground">
        <div>
          <dt className="text-primary">
            Broker of Record
          </dt>
          <dd className="text-muted-foreground">
            The regulatory signatory. Only Firm Funds can change who fills
            that slot.
          </dd>
        </div>
        <div>
          <dt className="text-primary">
            Manager
          </dt>
          <dd className="text-muted-foreground">
            Day-to-day owner of the portal. Can invite or remove other
            admins.
          </dd>
        </div>
        <div>
          <dt className="text-primary">
            Admin
          </dt>
          <dd className="text-muted-foreground">
            Can submit deals and manage agents but cannot manage other
            admins.
          </dd>
        </div>
      </dl>
    </>
  )
}

function HowToDisputeLateStrike() {
  return (
    <>
      <p className="text-foreground">
        Reply in the message thread for the specific deal and tell us which
        date you actually sent payment, plus the bank reference.
      </p>
      <p className="text-muted-foreground">
        We reconcile against the bank deposit, not against the date the
        amount lands on our books.
      </p>
    </>
  )
}

function RoleInAgentCure() {
  return (
    <>
      <p className="text-foreground">
        If the agent elects commission assignment, we set up a Remediation
        Deal that names an upcoming commission of theirs at your brokerage.
      </p>
      <p className="text-muted-foreground">
        Once both parties sign the Remediation IDP, you receive a copy. When
        that underlying commission is paid to your trust account, remit the
        directed amount to Firm Funds.
      </p>
    </>
  )
}

function CantFindTeamInviteEmail() {
  return (
    <>
      <p className="text-foreground">
        The Team page has a Resend action on the pending invite row.
      </p>
      <p className="text-muted-foreground">
        If resends do not arrive, check the email address for typos and that
        the recipient&apos;s inbox is not blocking{' '}
        <code>notifications@firmfunds.ca</code>.
      </p>
    </>
  )
}

function WhatIs1AgentWaitingOnYouBanner() {
  return (
    <>
      <p className="text-foreground">
        That is a firm-deal offer surfaced by the Offered Deals banner. Firm
        Funds detected that one of your agents just had a deal go firm, and
        an advance request was kicked off on their behalf.
      </p>
      <p className="text-muted-foreground">
        The agent&apos;s name and the property are on the row. Open it to
        accept, decline, or submit the advance request on the agent&apos;s
        behalf.
      </p>
    </>
  )
}

function CanWeOptOutOfEmail() {
  return (
    <>
      <p className="text-foreground">
        Yes. Every Firm Funds email has a one-click unsubscribe link (RFC
        8058). We honor unsubscribes by turning off email notifications for
        your brokerage.
      </p>
      <p className="text-muted-foreground">
        Transactional messages (account and security) still go out.
      </p>
    </>
  )
}

function DoWePayBeforeClosing() {
  return (
    <>
      <p className="text-foreground">
        No. Brokerages pay only after closing, within your settlement window.
      </p>
      <p className="text-muted-foreground">
        The fees on the deal are paid by the agent out of the advance, not
        by the brokerage.
      </p>
    </>
  )
}

export const brokerageFaqs: HelpFaq[] = [
  {
    id: 'how-do-i-add-team-admin',
    role: 'brokerage',
    category: 'team',
    question: 'How do I add a team admin?',
    Answer: HowDoIAddTeamAdmin,
    related: ['manage-team-admins'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'difference-between-brokerage-admin-roles',
    role: 'brokerage',
    category: 'team',
    question: 'What is the difference between the three brokerage admin roles?',
    Answer: DifferenceBetweenBrokerageAdminRoles,
    related: ['manage-team-admins'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'how-to-dispute-late-strike',
    role: 'brokerage',
    category: 'settlements',
    question: 'How do I dispute a late strike?',
    Answer: HowToDisputeLateStrike,
    related: ['late-strikes-and-the-14-day-bump'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'role-in-agent-cure',
    role: 'brokerage',
    category: 'failed-deals',
    question: 'One of our agents had a deal fail. What is our role in the cure?',
    Answer: RoleInAgentCure,
    related: ['pay-remediation-remittance', 'what-a-remediation-idp-is'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'cant-find-team-invite-email',
    role: 'brokerage',
    category: 'team',
    question: "We can't find the invite email for a new admin we just sent. What now?",
    Answer: CantFindTeamInviteEmail,
    related: ['manage-team-admins'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'what-is-1-agent-waiting-on-you-banner',
    role: 'brokerage',
    category: 'deals',
    question: 'Why does the dashboard sometimes show "1 agent is waiting on you"?',
    Answer: WhatIs1AgentWaitingOnYouBanner,
    related: ['accept-or-decline-firm-offer'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'can-we-opt-out-of-email',
    role: 'brokerage',
    category: 'support',
    question: 'Can our brokerage opt out of email notifications?',
    Answer: CanWeOptOutOfEmail,
    related: ['contacting-firm-funds'],
    updatedAt: '2026-05-29',
  },
  {
    id: 'do-we-pay-before-closing',
    role: 'brokerage',
    category: 'settlements',
    question: 'Do we ever pay Firm Funds before closing?',
    Answer: DoWePayBeforeClosing,
    related: ['settle-a-funded-deal'],
    updatedAt: '2026-05-29',
  },
]
