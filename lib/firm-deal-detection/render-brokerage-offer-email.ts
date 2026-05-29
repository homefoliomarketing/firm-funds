/**
 * lib/firm-deal-detection/render-brokerage-offer-email.ts
 *
 * Notification email sent to the brokerage admin team when an agent accepts
 * a firm-deal offer. Different audience and goal than the agent-facing
 * trigger email (render-email.ts):
 *
 *   - Audience: brokerage admin / office staff who will actually fill in
 *     the gross commission, splits, supporting docs and submit.
 *   - Goal: get them into the brokerage portal on the pre-populated form
 *     as fast as possible. The agent is waiting on funding.
 *   - Three voice + visual rules carry over:
 *       * No em dashes.
 *       * No DocuSign references, no timing promises about funding.
 *       * White-label brand prefix per brokerage (matches the agent email).
 *
 * Two variants:
 *   - 'initial'  — first notification, sent the moment the agent accepts
 *   - 'nudge_2h' — second pass at 2 hours if the brokerage hasn't acted
 *
 * The aggressive 4-hour internal escalation has its own renderer below
 * (renderInternalEscalationEmail), since it targets Firm Funds, not the
 * brokerage, and uses a different visual treatment.
 */

export type BrokerageOfferVariant = 'initial' | 'nudge_2h'

/**
 * Tier of info we have about the deal at notification time. Mirrors the
 * agent-side tiers in dispatch-notification.ts so the brokerage and the
 * agent see consistent framing:
 *   A: property only (no closing date, no commission)
 *   B: property + closing date, no commission
 *   C: property + closing date + commission amount
 * Default is 'B' when omitted because most accepted offers carry a closing
 * date by the time the brokerage gets pinged.
 */
export type BrokerageOfferTier = 'A' | 'B' | 'C'

export interface BrokerageOfferEmailInput {
  brokerage_name: string
  agent_full_name: string
  agent_email: string | null
  agent_phone: string | null
  property_address: string
  closing_date_iso: string | null
  brand_name: string             // e.g. "Choice Advances"
  brand_tagline: string          // e.g. "Powered by Firm Funds"
  brokerage_portal_url: string   // deep link straight into the pre-filled form
  variant: BrokerageOfferVariant
  /** Info tier the agent was offered on. Drives subject + intro copy so
   *  the brokerage sees the same framing the agent saw. */
  tier?: BrokerageOfferTier
  /** Gross commission for the agent's side, pre-split. Only quoted when
   *  tier === 'C'. */
  commission_amount?: number | null
  /** Estimated pre-split advance against that commission. Quoted alongside
   *  the gross when tier === 'C'. */
  advance_estimate?: number | null
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatClosingDate(iso: string | null): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December']
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`
}

function formatMoney(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return ''
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 0,
  }).format(Math.round(amount))
}

export function renderBrokerageOfferEmail(input: BrokerageOfferEmailInput): RenderedEmail {
  const brokerage = escapeHtml(input.brokerage_name)
  const agent = escapeHtml(input.agent_full_name || 'an agent')
  const address = escapeHtml(input.property_address || 'their recent deal')
  const brand = escapeHtml(input.brand_name)
  const tagline = escapeHtml(input.brand_tagline)
  const cta = input.brokerage_portal_url
  const closingHuman = formatClosingDate(input.closing_date_iso)

  const isNudge = input.variant === 'nudge_2h'
  const tier: BrokerageOfferTier = input.tier ?? 'B'
  const commissionAmount = tier === 'C' ? input.commission_amount ?? null : null
  const advanceEstimate = tier === 'C' ? input.advance_estimate ?? null : null
  const commissionStr = commissionAmount && commissionAmount > 0 ? formatMoney(commissionAmount) : null
  const advanceStr = advanceEstimate && advanceEstimate > 0 ? formatMoney(advanceEstimate) : null

  // Subject lines differ by tier so the brokerage admin sees the most
  // useful info up front. Nudge always wins because it's a follow-up
  // marker the admin needs to see in their inbox.
  let subject: string
  if (isNudge) {
    subject = `Reminder: ${input.agent_full_name} is waiting on an advance for ${input.property_address}`
  } else if (tier === 'C' && advanceStr && closingHuman) {
    subject = `${advanceStr} ready for ${input.property_address}, closing ${closingHuman} (${input.agent_full_name})`
  } else if (tier === 'B' && closingHuman) {
    subject = `${input.agent_full_name}'s deal at ${input.property_address} closes ${closingHuman}. Ready to advance`
  } else if (tier === 'A') {
    subject = `Possible upcoming deal at ${input.property_address} for ${input.agent_full_name}`
  } else {
    subject = `${input.agent_full_name} requested a commission advance on ${input.property_address}`
  }

  const headerBg = isNudge ? '#c75c3a' : '#5FA873'
  const headerLabel = isNudge ? 'Reminder' : brand

  // Intro copy tracks the tier. Tier A frames this as a lead the brokerage
  // can still walk away from. Tier B confirms the timing and asks the
  // brokerage to fill in commission. Tier C confirms everything is in and
  // we just need the package.
  let intro: string
  if (isNudge) {
    intro = `It's been 2 hours since ${agent} accepted a commission advance offer and we still need the deal package from ${brokerage} to fund.`
  } else if (tier === 'A') {
    intro = `We spotted a firm-deal lead for ${agent}. If this is theirs and the brokerage is ready to advance, submit the package below. If not, check in with the agent first.`
  } else if (tier === 'B') {
    intro = `${agent} accepted a commission advance offer on a recently firmed deal. We'll fund as soon as the commission is in: ${brokerage} can submit the package below or wait for the agent to send the trade record.`
  } else if (tier === 'C' && commissionStr) {
    intro = `${agent} accepted a commission advance offer and we already have a gross commission of <span style="font-weight:600; color:#1a2e1d;">${escapeHtml(commissionStr)}</span> on file. Submit the package below and we'll wire as soon as it's approved.`
  } else {
    intro = `${agent} accepted a commission advance offer on a recently firmed deal. To get them funded, ${brokerage} needs to submit the deal package through the portal.`
  }

  const contactBits: string[] = []
  if (input.agent_email) contactBits.push(`<a href="mailto:${escapeHtml(input.agent_email)}" style="color:#3d8055; text-decoration:none;">${escapeHtml(input.agent_email)}</a>`)
  if (input.agent_phone) contactBits.push(`<a href="tel:${escapeHtml(input.agent_phone)}" style="color:#3d8055; text-decoration:none;">${escapeHtml(input.agent_phone)}</a>`)
  const contactRow = contactBits.length > 0
    ? `<tr><td style="padding:6px 0; color:#6a7a6e; font-size:13px; width:130px;">Agent contact:</td><td style="padding:6px 0; color:#1a2e1d; font-size:13px;">${contactBits.join(' &middot; ')}</td></tr>`
    : ''

  const closingRow = closingHuman
    ? `<tr><td style="padding:6px 0; color:#6a7a6e; font-size:13px; width:130px;">Closing date:</td><td style="padding:6px 0; color:#1a2e1d; font-size:13px; font-weight:600;">${escapeHtml(closingHuman)}</td></tr>`
    : ''

  // Optional commission row, only when tier === 'C'. Surfaces the same
  // number the agent saw in their offer so the brokerage knows what we'll
  // try to advance against.
  const commissionRow = commissionStr
    ? `<tr><td style="padding:6px 0; color:#6a7a6e; font-size:13px; width:130px;">Gross commission:</td><td style="padding:6px 0; color:#1a2e1d; font-size:13px; font-weight:600;">${escapeHtml(commissionStr)}${advanceStr ? ` <span style="color:#6a7a6e; font-weight:400;">(est. advance ${escapeHtml(advanceStr)}, less brokerage splits)</span>` : ''}</td></tr>`
    : ''

  // CTA copy tracks the tier. Tier A and B both prompt "Submit on behalf"
  // because the agent's already given the green light but the brokerage
  // controls the actual submission. Tier C drops "on behalf" since the
  // commission is locked in.
  const ctaLabel = tier === 'C' ? 'Submit advance' : 'Submit advance on behalf'

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0; padding:0; background:#eef1ef; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; color:#1a2e1d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1ef; padding:40px 20px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 6px 24px rgba(0,0,0,0.07);">
        <tr>
          <td style="background:${headerBg}; padding:22px 32px; color:#ffffff;">
            <div style="font-size:21px; font-weight:700; letter-spacing:-0.01em;">${headerLabel}</div>
            <div style="font-size:12px; opacity:0.85; margin-top:3px; font-weight:400;">${tagline}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px 24px 36px; line-height:1.55;">
            <p style="font-size:16px; margin:0 0 16px 0; color:#1a2e1d;">Hello ${brokerage} team,</p>
            <p style="font-size:15px; margin:0 0 24px 0; color:#333;">${intro}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7faf8; border:1px solid #dce6df; border-radius:10px; padding:18px 20px; margin:0 0 24px 0;">
              <tr><td style="padding:6px 0; color:#6a7a6e; font-size:13px; width:130px;">Agent:</td><td style="padding:6px 0; color:#1a2e1d; font-size:14px; font-weight:600;">${agent}</td></tr>
              ${contactRow}
              <tr><td style="padding:6px 0; color:#6a7a6e; font-size:13px; width:130px;">Property:</td><td style="padding:6px 0; color:#1a2e1d; font-size:14px; font-weight:600;">${address}</td></tr>
              ${closingRow}
              ${commissionRow}
            </table>
            <p style="font-size:14px; color:#444; margin:0 0 20px 0;">Open the request in the portal to fill in the commission split and upload the trade record. The pre-filled form already has the property and agent info.</p>
            <div style="text-align:center; margin:20px 0 8px 0;">
              <a href="${cta}" style="display:inline-block; background:#5FA873; color:#ffffff; padding:15px 38px; border-radius:999px; text-decoration:none; font-weight:600; font-size:16px;">${escapeHtml(ctaLabel)} &rarr;</a>
            </div>
            <p style="font-size:12px; color:#888; margin:24px 0 0 0; text-align:center;">If this deal does not qualify (agent owes you money, unusual structure, etc.), you can decline the offer from the same screen.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px; background:#fafbfa; font-size:12px; color:#999; text-align:center; border-top:1px solid #eef0ee;">
            ${brand} &middot; ${tagline}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const textLines = [
    `Hello ${input.brokerage_name} team,`,
    '',
    isNudge
      ? `Reminder: it's been 2 hours since ${input.agent_full_name} accepted a commission advance offer on ${input.property_address}.`
      : `${input.agent_full_name} accepted a commission advance offer on ${input.property_address}.`,
    '',
    'Deal details:',
    `  Agent: ${input.agent_full_name}`,
    input.agent_email ? `  Email: ${input.agent_email}` : '',
    input.agent_phone ? `  Phone: ${input.agent_phone}` : '',
    `  Property: ${input.property_address}`,
    closingHuman ? `  Closing: ${closingHuman}` : '',
    '',
    'Open the pre-filled request to submit:',
    cta,
    '',
    'If the deal does not qualify, you can decline the offer from the same screen.',
    '',
    `${input.brand_name} - ${input.brand_tagline}`,
  ].filter(Boolean)
  const text = textLines.join('\n')

  return { subject, html, text }
}

// ---------------------------------------------------------------------------
// Internal escalation email — sent at 4h to the Firm Funds inbox so we can
// pick up the phone and call the brokerage directly. Bud's framing: "tell
// us to get a hold of this brokerage ASAP to get docs."
// ---------------------------------------------------------------------------
export interface InternalEscalationInput {
  brokerage_name: string
  brokerage_email: string | null
  brokerage_phone: string | null
  agent_full_name: string
  agent_email: string | null
  agent_phone: string | null
  property_address: string
  closing_date_iso: string | null
  offered_at_iso: string
  brokerage_notified_at_iso: string
  brokerage_portal_url: string
  agent_dashboard_url: string
}

export function renderInternalEscalationEmail(input: InternalEscalationInput): RenderedEmail {
  const brokerage = escapeHtml(input.brokerage_name)
  const brokerageEmail = input.brokerage_email ? escapeHtml(input.brokerage_email) : null
  const brokeragePhone = input.brokerage_phone ? escapeHtml(input.brokerage_phone) : null
  const agent = escapeHtml(input.agent_full_name)
  const address = escapeHtml(input.property_address)
  const closingHuman = formatClosingDate(input.closing_date_iso)

  const subject = `ACTION: ${input.brokerage_name} hasn't picked up the offer for ${input.agent_full_name} (${input.property_address})`

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#fff8f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; color:#1a2e1d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:40px 20px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; background:#ffffff; border:2px solid #c75c3a; border-radius:12px; overflow:hidden;">
        <tr>
          <td style="background:#c75c3a; padding:18px 28px; color:#ffffff;">
            <div style="font-size:18px; font-weight:700; letter-spacing:-0.01em;">4-Hour Escalation</div>
            <div style="font-size:12px; opacity:0.9; margin-top:3px;">Brokerage hasn't acted on an accepted offer</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 24px 32px; line-height:1.55;">
            <p style="font-size:15px; margin:0 0 20px 0; color:#222;">
              <strong>${agent}</strong> accepted an offer on <strong>${address}</strong> 4 hours ago and ${brokerage} hasn't submitted the deal package. Time to pick up the phone.
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff5ef; border:1px solid #f3d9c8; border-radius:8px; padding:14px 18px; margin:0 0 22px 0;">
              <tr><td style="padding:5px 0; color:#7a5a4a; font-size:13px; width:160px;">Brokerage:</td><td style="padding:5px 0; color:#1a2e1d; font-size:14px; font-weight:600;">${brokerage}</td></tr>
              ${brokerageEmail ? `<tr><td style="padding:5px 0; color:#7a5a4a; font-size:13px; width:160px;">Brokerage email:</td><td style="padding:5px 0; font-size:14px;"><a href="mailto:${brokerageEmail}" style="color:#c75c3a;">${brokerageEmail}</a></td></tr>` : ''}
              ${brokeragePhone ? `<tr><td style="padding:5px 0; color:#7a5a4a; font-size:13px; width:160px;">Brokerage phone:</td><td style="padding:5px 0; font-size:14px;"><a href="tel:${brokeragePhone}" style="color:#c75c3a;">${brokeragePhone}</a></td></tr>` : ''}
              <tr><td style="padding:5px 0; color:#7a5a4a; font-size:13px; width:160px;">Agent:</td><td style="padding:5px 0; color:#1a2e1d; font-size:14px;">${agent}${input.agent_phone ? ` &middot; <a href="tel:${escapeHtml(input.agent_phone)}" style="color:#c75c3a;">${escapeHtml(input.agent_phone)}</a>` : ''}</td></tr>
              <tr><td style="padding:5px 0; color:#7a5a4a; font-size:13px; width:160px;">Property:</td><td style="padding:5px 0; color:#1a2e1d; font-size:14px; font-weight:600;">${address}</td></tr>
              ${closingHuman ? `<tr><td style="padding:5px 0; color:#7a5a4a; font-size:13px; width:160px;">Closing:</td><td style="padding:5px 0; color:#1a2e1d; font-size:14px;">${escapeHtml(closingHuman)}</td></tr>` : ''}
              <tr><td style="padding:5px 0; color:#7a5a4a; font-size:13px; width:160px;">Agent accepted at:</td><td style="padding:5px 0; color:#666; font-size:13px;">${escapeHtml(input.offered_at_iso)}</td></tr>
              <tr><td style="padding:5px 0; color:#7a5a4a; font-size:13px; width:160px;">Brokerage notified:</td><td style="padding:5px 0; color:#666; font-size:13px;">${escapeHtml(input.brokerage_notified_at_iso)}</td></tr>
            </table>
            <p style="font-size:14px; color:#444; margin:0 0 16px 0;">Quick links:</p>
            <ul style="font-size:14px; color:#1a2e1d; margin:0 0 16px 0; padding-left:22px;">
              <li><a href="${input.brokerage_portal_url}" style="color:#3d8055;">Brokerage portal (pre-filled form)</a></li>
              <li><a href="${input.agent_dashboard_url}" style="color:#3d8055;">Agent dashboard view</a></li>
            </ul>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const text = [
    `4-HOUR ESCALATION`,
    ``,
    `${input.agent_full_name} accepted an offer on ${input.property_address} 4 hours ago and ${input.brokerage_name} hasn't submitted.`,
    ``,
    `Brokerage: ${input.brokerage_name}`,
    input.brokerage_email ? `Brokerage email: ${input.brokerage_email}` : '',
    input.brokerage_phone ? `Brokerage phone: ${input.brokerage_phone}` : '',
    `Agent: ${input.agent_full_name}`,
    input.agent_phone ? `Agent phone: ${input.agent_phone}` : '',
    `Property: ${input.property_address}`,
    closingHuman ? `Closing: ${closingHuman}` : '',
    `Agent accepted at: ${input.offered_at_iso}`,
    `Brokerage notified: ${input.brokerage_notified_at_iso}`,
    ``,
    `Brokerage portal: ${input.brokerage_portal_url}`,
    `Agent dashboard: ${input.agent_dashboard_url}`,
  ].filter(Boolean).join('\n')

  return { subject, html, text }
}
