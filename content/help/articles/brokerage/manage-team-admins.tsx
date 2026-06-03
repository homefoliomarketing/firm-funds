import type { HelpArticle } from '../../types'
import HelpStepList from '@/components/help/HelpStepList'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <>
      <p>
        Most brokerages want more than one person able to sign in to the
        portal. The Team Admins page lets you invite colleagues, pick the
        right role for each one, and remove people who have left the
        brokerage. Only the Broker of Record and Brokerage Managers can
        manage the team; plain Brokerage Admins do not see the page.
      </p>

      <h2>The three roles</h2>
      <dl className="mt-3 mb-5 grid gap-3 sm:grid-cols-1">
        <div className="rounded-lg border border-border bg-card/40 px-4 py-3">
          <dt className="text-sm font-semibold text-foreground">Broker of Record</dt>
          <dd className="mt-1 text-sm text-muted-foreground">
            Regulatory signatory for the brokerage. Receives Firm Funds
            contracts and is named on the Brokerage Cooperation Agreement.
            Only Firm Funds can change who fills this slot; email
            bud@firmfunds.ca to swap it.
          </dd>
        </div>
        <div className="rounded-lg border border-border bg-card/40 px-4 py-3">
          <dt className="text-sm font-semibold text-foreground">Brokerage Manager</dt>
          <dd className="mt-1 text-sm text-muted-foreground">
            Day-to-day owner of the portal. Can invite and remove other
            admins (except the Broker of Record), submit deals, settle, and
            manage agents. Most brokerages give this role to their office
            manager or trust accountant.
          </dd>
        </div>
        <div className="rounded-lg border border-border bg-card/40 px-4 py-3">
          <dt className="text-sm font-semibold text-foreground">Brokerage Admin</dt>
          <dd className="mt-1 text-sm text-muted-foreground">
            Submits deals and manages the agent roster, but cannot manage
            other admins. Good fit for staff who file advance requests on
            behalf of agents without needing team-management rights.
          </dd>
        </div>
      </dl>

      <HelpCallout variant="note" title="Who can invite whom">
        <p>
          The Broker of Record and Brokerage Managers can invite new admins.
          Only the Broker of Record can promote someone to Brokerage Manager;
          a Brokerage Manager can only invite plain Brokerage Admins.
          Removing the Broker of Record is locked, with a tooltip pointing at
          Firm Funds; everyone else can be removed by anyone with team
          management rights (except yourself).
        </p>
      </HelpCallout>

      <h2>Walkthrough</h2>
      <HelpStepList
        steps={[
          {
            title: 'Open the Team Admins page',
            expected: 'From the brokerage dashboard, click Settings in the header, then click Team Admins. You see the current list of admins with their roles, dates added, and last sign-in.',
            fallback: 'If you do not see the Team Admins link, you are signed in as a plain Brokerage Admin and do not have team-management rights. Ask your Broker of Record or Brokerage Manager to add or remove people.',
          },
          {
            title: 'Click Invite admin',
            expected: 'A dialog opens asking for first name, last name, email, and role.',
          },
          {
            title: 'Fill in the details',
            expected: 'Type the colleague\'s name and email. Pick the role from the dropdown. If you are a Brokerage Manager, only the Brokerage Admin option appears; if you are the Broker of Record, you can also pick Brokerage Manager.',
            fallback: 'If the email is already attached to another active brokerage account, you get a clear error. Use a different email or contact Firm Funds to migrate the existing account.',
          },
          {
            title: 'Send the invite',
            expected: 'Click Invite. A success banner confirms the email was sent. The new row appears with an Invite pending badge until they click the link and set their password.',
            fallback: 'If they cannot find the email, ask them to check spam for notifications@firmfunds.ca. If it still has not arrived, click the Resend invite button next to their row on the Team Admins page. That issues a fresh 72-hour magic link to the same address.',
          },
        ]}
      />

      <h2>Resending an invite</h2>
      <p>
        Invite emails expire 72 hours after they go out. If a new admin
        misses that window, or the email never arrived, click{' '}
        <strong>Resend invite</strong> on their row. We issue a fresh
        72-hour magic link to the same email address and your colleague
        starts over from the &ldquo;set your password&rdquo; screen. The
        button only appears next to admins who have not yet accepted; once
        someone has signed in for the first time, they use{' '}
        <strong>Forgot password</strong> on the login page instead.
      </p>

      <h2>Removing someone</h2>
      <p>
        Click <strong>Remove</strong> on the row you want to take off. The
        button is greyed out for the Broker of Record and for yourself; the
        tooltip explains why. Confirm the removal in the dialog. The person
        loses access to the portal the moment they next refresh; any deals
        they submitted stay attached to your brokerage.
      </p>
    </>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'manage-team-admins',
    title: 'Manage team admins',
    summary: 'Three role types, invite flow, who can remove whom.',
    role: 'brokerage',
    category: 'support',
    order: 80,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
