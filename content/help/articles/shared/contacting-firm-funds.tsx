import type { HelpArticle } from '../../types'
import HelpCallout from '@/components/help/HelpCallout'

function Body() {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-foreground/90">
      <p>
        We are reachable a few different ways. For anything tied to a
        specific deal, the in-portal message thread is the fastest path
        because it threads against the deal record and pulls in the relevant
        context automatically. For everything else, email gets a same-day
        reply on business days.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Email
      </h2>
      <p>
        Write to{' '}
        <a
          href="mailto:bud@firmfunds.ca"
          className="text-primary underline underline-offset-2 hover:text-foreground"
        >
          bud@firmfunds.ca
        </a>
        . This goes to Bud, the owner. Use this for anything that is not
        deal-specific, including onboarding questions, brokerage agreements,
        billing disputes, and security reports.
      </p>
      <p>
        Outbound notifications from the portal come from{' '}
        <a
          href="mailto:notifications@firmfunds.ca"
          className="text-primary underline underline-offset-2 hover:text-foreground"
        >
          notifications@firmfunds.ca
        </a>
        . That mailbox is automated, so do not reply directly; replies to a
        notification do not route to a person. If a notification asks you to
        respond, the email contains a link back into the portal or a
        reply-to that points to a human.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        In-portal messaging
      </h2>
      <p>
        On every deal page, the messaging panel posts a thread directly to
        the Firm Funds team. Use this for anything tied to that specific
        deal: a closing date amendment, a missing document, a question about
        an underwriting note, a payment confirmation. Because the thread
        lives on the deal record, both sides have the full context, and a
        future review of the deal can read back the conversation that
        happened around it.
      </p>
      <p>
        Brokerage admins can also open a thread from the brokerage portal
        itself for questions that span multiple deals or are about your
        brokerage&apos;s settings, settlement window, or strike count.
      </p>

      <h2 className="text-lg font-semibold text-foreground mt-6">
        Spotting a real message from us
      </h2>
      <p>
        Every email we send originates from a{' '}
        <code>firmfunds.ca</code> address. If you receive a message claiming
        to be from Firm Funds that uses a different domain, do not click any
        links and do not download any attachments. Forward the message to{' '}
        <a
          href="mailto:bud@firmfunds.ca"
          className="text-primary underline underline-offset-2 hover:text-foreground"
        >
          bud@firmfunds.ca
        </a>{' '}
        so we can warn other users.
      </p>

      <HelpCallout
        variant="note"
        title="Phone and business hours"
      >
        <p>
          We do not currently publish a support phone number. If you need a
          live voice for an urgent matter, email{' '}
          <a
            href="mailto:bud@firmfunds.ca"
            className="text-primary underline underline-offset-2 hover:text-foreground"
          >
            bud@firmfunds.ca
          </a>{' '}
          and ask for a call back; we will respond with a number and a time.
          Posted hours and a public phone line are on the roadmap; this
          article will be updated when they are confirmed.
        </p>
      </HelpCallout>
    </div>
  )
}

const article: HelpArticle = {
  meta: {
    slug: 'contacting-firm-funds',
    title: 'Contacting Firm Funds',
    summary: 'Email, phone, in-portal messaging, response windows.',
    role: 'shared',
    category: 'support',
    order: 60,
    updatedAt: '2026-05-29',
  },
  Body,
}

export default article
