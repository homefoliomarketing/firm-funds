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
        We hold financial records and FINTRAC-required identification for
        every agent who signs up. We take that seriously. This article
        explains the controls that keep your data separated from other
        brokerages and outside the reach of anyone who is not signed in to
        your account.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        How your data is isolated
      </h2>
      <p>
        Firm Funds runs on Postgres with row-level security turned on for
        every table that holds account data. In plain terms, every database
        query is filtered server-side by your account before any rows leave
        the database. An agent at one brokerage cannot run a request that
        returns data belonging to an agent at another brokerage, because the
        database will refuse to hand those rows back.
      </p>
      <p>
        On top of the database rules, every request that touches the portal
        first re-validates your session against the auth provider. There is
        no path where a stale cookie or a copied URL lets someone read data
        without a live, valid session.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Browser-side protections
      </h2>
      <ul className="list-disc pl-6 space-y-1.5">
        <li>
          <strong>Strict Content Security Policy.</strong> The portal only
          loads scripts and styles from a small allowlist of origins. Any
          attempt to inject an outside script into a page is blocked by the
          browser before it runs.
        </li>
        <li>
          <strong>CSRF protection.</strong> Every state-changing request to
          our API is rejected unless it comes from a same-origin browser
          context with an Origin or Referer header we recognize.
        </li>
        <li>
          <strong>Same-origin checks.</strong> Requests for sensitive endpoints
          are validated against the portal&apos;s own origin, so a page
          opened on another domain cannot trigger an action in your account
          even if you happen to be signed in.
        </li>
      </ul>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        KYC documents and bank details
      </h2>
      <p>
        Government ID, void cheques, and any other KYC documents are stored
        in an ownership-scoped storage bucket. Files are tagged at upload
        with the agent or brokerage that owns them, and the storage policy
        only releases a file to a signed-in session that matches that owner.
        Other brokerages on the platform cannot see, list, or download your
        documents. Firm Funds admins can read what is needed to verify
        identity under FINTRAC; we do not share those files outside the
        company.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Session timeouts
      </h2>
      <p>
        Sessions time out after a period of inactivity so a left-open laptop
        does not become a vulnerability. The cut-offs are:
      </p>
      <ul className="list-disc pl-6 space-y-1.5">
        <li>
          <strong>Firm Funds admins:</strong> {ADMIN_TIMEOUT_MINUTES} minutes.
        </li>
        <li>
          <strong>Agents and brokerage admins:</strong>{' '}
          {AGENT_TIMEOUT_MINUTES} minutes.
        </li>
      </ul>
      <p>
        When a session times out, you are sent back to the sign-in screen
        and any unsent form input is dropped. Signing back in starts a fresh
        session; we never extend an idle one in the background.
      </p>

      <HelpCallout variant="success" title="What we never do">
        <ul className="list-disc pl-6 space-y-1">
          <li>
            We do not sell your data, your deal history, or your contact
            details to anyone.
          </li>
          <li>
            We do not share your information with marketing partners,
            advertising networks, or data brokers.
          </li>
          <li>
            We do not embed third-party tracking pixels or behavioural
            advertising trackers inside the portal.
          </li>
          <li>
            We do not let other brokerages on the platform see your agents,
            your deals, or your financials.
          </li>
        </ul>
      </HelpCallout>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Where to report a concern
      </h2>
      <p>
        If you notice something that looks like a security issue, including a
        suspicious email claiming to be from Firm Funds or a portal page that
        seems to show data that does not belong to you, write to{' '}
        <a
          href="mailto:bud@firmfunds.ca"
          className="text-primary underline underline-offset-2 hover:text-foreground"
        >
          bud@firmfunds.ca
        </a>{' '}
        right away. Include screenshots if you can. We treat these reports
        as priority work.
      </p>
    </div>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'security-and-data',
    title: 'How we keep your data safe',
    summary: 'Row-level security, KYC storage, sessions, no third-party sharing.',
    role: 'shared',
    category: 'support',
    order: 50,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
