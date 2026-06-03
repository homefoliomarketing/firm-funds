import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'
import {
  ADMIN_INACTIVITY_TIMEOUT_MS,
  AGENT_INACTIVITY_TIMEOUT_MS,
} from '@/lib/constants'

const ADMIN_TIMEOUT_MINUTES = Math.round(ADMIN_INACTIVITY_TIMEOUT_MS / 60_000)
const AGENT_TIMEOUT_MINUTES = Math.round(AGENT_INACTIVITY_TIMEOUT_MS / 60_000)

function Body() {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-foreground/90">
      <p>
        We hold your financial records and the photo ID we are required to
        collect. We take that seriously. Here is what keeps your information
        private, in plain terms.
      </p>

      <ul className="list-disc pl-6 space-y-3">
        <li>
          <strong>You only see your own deals and money.</strong> Your
          account shows you your information and nobody else&apos;s. Agents
          and staff at other brokerages cannot see your deals, your agents,
          or your financials.
        </li>
        <li>
          <strong>Only you can get into your account.</strong> The portal
          checks that you are properly signed in on every page. An old saved
          link or a leftover browser session will not let anyone open your
          account and read your information.
        </li>
        <li>
          <strong>Your ID and banking documents stay locked to you.</strong>{' '}
          Things like your government ID and void cheque are only released to
          you. Other brokerages cannot see, list, or download them. Our own
          team looks only at what we need to confirm your identity, and we do
          not share those files outside the company.
        </li>
        <li>
          <strong>A left-open laptop logs itself out.</strong> If you step
          away and your account sits unused, it signs you out on its own so
          nobody can walk up and use it. Firm Funds staff are logged out after{' '}
          {ADMIN_TIMEOUT_MINUTES} minutes of sitting idle, and agents and
          brokerage staff after {AGENT_TIMEOUT_MINUTES} minutes. You just sign
          back in to pick up where you left off.
        </li>
        <li>
          <strong>Other websites cannot reach into your account.</strong>{' '}
          Even if you are signed in to the portal, another website you have
          open in your browser cannot read your information or do anything in
          your account.
        </li>
        <li>
          <strong>We never sell or rent out your information.</strong> We do
          not sell your data, your deal history, or your contact details, and
          we do not hand them to advertisers, marketing companies, or anyone
          who trades in personal data. We also do not plant hidden advertising
          trackers in the portal.
        </li>
      </ul>

      <HelpCallout variant="success" title="If something looks wrong, tell us">
        <p>
          If you spot anything that seems off, like an email claiming to be
          from Firm Funds that you do not trust, or a page that shows
          information that is not yours, write to{' '}
          <a href="mailto:bud@firmfunds.ca">bud@firmfunds.ca</a> right away.
          Add screenshots if you can. We treat these as priority and will look
          into it.
        </p>
      </HelpCallout>
    </div>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'security-and-data',
    title: 'How we keep your data safe',
    summary: 'How your deals, ID, and money stay private, in plain terms.',
    role: 'shared',
    category: 'support',
    order: 50,
    updatedAt: '2026-06-02',
  },
  Body,
}

export default article
