/**
 * lib/firm-deal-detection/render-email.ts
 *
 * White-label HTML email for the firm-deal trigger. Tiered by what we know
 * about the deal at the moment we ping the agent (added 2026-05-29):
 *
 *   sparse            - Tier A. Property address only, no closing date,
 *                       no commission. Tone: "we spotted a possible deal,
 *                       confirm details and we'll have an advance ready".
 *   sparse_with_date  - Tier B. Property + closing date, no commission.
 *                       Tone: "your deal at X is closing Y, want an advance?"
 *   dual_agency       - Same agent held both sides of the deal. Generic
 *                       "both sides, both commissions" framing; quoting a
 *                       single-sided number would mislead.
 *   detailed          - Tier C. We have the gross commission for this
 *                       agent's side AND a closing date. Includes a
 *                       commission + estimated-advance callout. Forced
 *                       off for co-agent splits since we don't know each
 *                       agent's share.
 *
 * Voice constraints (from CLAUDE.md):
 *   - "went firm" never "closed firm"
 *   - "(less brokerage splits)" wherever dollars are mentioned
 *   - No em dashes anywhere
 *   - No DocuSign references, no timing promises
 *   - Greeting: "Hi <FirstName>"
 *   - White-label brand prefix per brokerage
 */

export interface EmailRenderInput {
  agent_first_name: string
  property_address: string
  closing_date_iso: string | null
  brand_name: string             // e.g. "Choice Advances"
  brand_tagline: string          // e.g. "Powered by Firm Funds"
  /** Brokerage white-label logo URL (brokerages.logo_url). When present the
   *  header renders this image instead of the text brand banner. Null/absent
   *  falls back to the green text banner. */
  brand_logo_url?: string | null
  /** TRUE when brand_logo_url already bakes in "Powered by Firm Funds"
   *  (brokerages.logo_includes_tagline, generated logos). Render the logo
   *  alone in that case; otherwise add a small "Powered by Firm Funds" line. */
  brand_logo_includes_tagline?: boolean | null
  cta_url: string                // deep link to the agent dashboard
  variant: 'sparse' | 'sparse_with_date' | 'dual_agency' | 'detailed'
  /** Gross commission for this agent's side, BEFORE the brokerage split.
   *  Only consumed by variant='detailed'. Other variants ignore. */
  commission_amount?: number | null
  /** Estimated advance against the gross commission (pre-split). Computed
   *  by the dispatcher with estimateAdvanceFromGross() so the email and
   *  SMS quote the same number. Only consumed by variant='detailed'. */
  advance_estimate?: number | null
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string                   // plain-text fallback (deliverability + a11y)
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
  const month = months[parseInt(m[2], 10) - 1]
  const day = parseInt(m[3], 10)
  const year = m[1]
  return `${month} ${day}, ${year}`
}

function formatMoney(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return ''
  // No-cents thousands-grouped CAD (we only ever quote whole-dollar estimates
  // in the email). en-CA gives us "$76,500" which reads cleanly across the
  // brokerages we serve.
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 0,
  }).format(Math.round(amount))
}

export function renderTriggerEmail(input: EmailRenderInput): RenderedEmail {
  const firstName = escapeHtml(input.agent_first_name || 'there')
  const address = escapeHtml(input.property_address || 'your recent deal')
  const brand = escapeHtml(input.brand_name)
  const tagline = escapeHtml(input.brand_tagline)
  const cta = input.cta_url
  const closingHuman = formatClosingDate(input.closing_date_iso)

  // Intro line varies by variant; the rest of the layout is shared.
  // Tier A (sparse, no closing date) is the most cautious framing because
  // we may have only loosely matched the row to this agent: lead with
  // "looks like one of yours" and ask them to confirm rather than
  // congratulate them.
  let intro: string
  if (input.variant === 'dual_agency') {
    intro = `We see that your recent deal at <span style="font-weight:600; color:#1a2e1d;">${address}</span> went firm. Looks like you held both sides too. Nice work.`
  } else if (input.variant === 'sparse') {
    intro = `We spotted what looks like one of yours: <span style="font-weight:600; color:#1a2e1d;">${address}</span>. If that's right, confirm the details and we'll have an advance ready for you.`
  } else {
    intro = `Congratulations on your recent deal at <span style="font-weight:600; color:#1a2e1d;">${address}</span>!`
  }

  // 'detailed' variant inserts a callout above the "Get paid TODAY" hero
  // showing the gross commission and a pre-split advance estimate. We
  // always tag the estimate as "before brokerage split" — actual advance
  // depends on the agent's office split which we don't know at offer
  // time. Empty string when not applicable.
  const commissionCallout = (() => {
    if (input.variant !== 'detailed') return ''
    if (input.commission_amount == null || input.commission_amount <= 0) return ''
    const commissionStr = formatMoney(input.commission_amount)
    const advanceStr = input.advance_estimate != null && input.advance_estimate > 0
      ? formatMoney(input.advance_estimate)
      : null
    const advanceLine = advanceStr
      ? `<div style="margin:14px 0 0 0; padding-top:14px; border-top:1px solid #e6ede9;">
                <p style="font-size:13px; color:#666; margin:0 0 4px 0; text-transform:uppercase; letter-spacing:0.08em;">Estimated advance today</p>
                <p style="font-size:30px; font-weight:800; color:#3d8055; margin:0; line-height:1.1; letter-spacing:-0.01em;">${escapeHtml(advanceStr)}</p>
                <p style="font-size:11px; color:#999; margin:4px 0 0 0;">less brokerage splits</p>
              </div>`
      : ''
    return `
            <div style="background:#fafbfa; border:1px solid #d9e4dd; border-radius:8px; padding:14px 18px; margin:0 0 22px 0; text-align:center;">
              <p style="font-size:13px; color:#666; margin:0 0 4px 0; text-transform:uppercase; letter-spacing:0.08em;">Gross commission</p>
              <p style="font-size:26px; font-weight:700; color:#1a2e1d; margin:0; line-height:1.1;">${escapeHtml(commissionStr)}</p>
              ${advanceLine}
            </div>`
  })()

  const altOption = closingHuman
    ? `Would you like to wait until <span style="font-weight:600; color:#222;">${escapeHtml(closingHuman)}</span> to receive your commission&hellip;`
    : `Would you like to wait weeks for your commission&hellip;`

  // Only dual_agency keeps a hero subtitle ("Both sides, both commissions").
  // The 'detailed' and default variants drop the old "Instead of waiting
  // weeks" line; an empty label suppresses the <p> at render time.
  const todayLabel = input.variant === 'dual_agency'
    ? 'Both sides, both commissions'
    : ''

  // CTA copy tracks the tier. Tier A asks the agent to confirm (we may
  // have only loosely matched), Tier B and beyond push toward submitting
  // an actual advance request.
  let ctaLabel: string
  if (input.variant === 'sparse') ctaLabel = 'Confirm deal'
  else if (input.variant === 'sparse_with_date') ctaLabel = 'Request advance'
  else if (input.variant === 'detailed') ctaLabel = 'Accept advance'
  else ctaLabel = 'Get Paid Today'

  // Subjects are tier-aware. Tier A leads with "possible deal" because
  // the agent may not have closed it yet (or it may not even be theirs).
  // Tier B name-drops the closing date so the agent sees timing up front.
  // Tier C quotes the dollar amount.
  let subject: string
  if (input.variant === 'sparse') {
    subject = `We spotted a possible deal at ${input.property_address}`
  } else if (input.variant === 'sparse_with_date' && closingHuman) {
    subject = `Your deal at ${input.property_address} is closing ${closingHuman}. Want an advance?`
  } else if (input.variant === 'detailed' && input.commission_amount && input.advance_estimate && closingHuman) {
    subject = `${formatMoney(input.advance_estimate)} ready for ${input.property_address}, closing ${closingHuman}`
  } else {
    subject = `Your deal at ${input.property_address} went firm`
  }

  // Header cell. When the brokerage has a white-label logo on file we render
  // it as an image (mirrors brandHeader() in lib/email.ts); otherwise we fall
  // back to the original green text banner so nothing breaks when no logo is
  // set. The logo sits on the same green band for visual continuity. When the
  // logo already bakes in the tagline (generated logos) we render it alone;
  // for custom uploads we add a small "Powered by Firm Funds" line beneath it.
  const logoUrl = input.brand_logo_url
  const headerCell = logoUrl
    ? input.brand_logo_includes_tagline
      ? `<td style="background:#5FA873; padding:22px 32px; text-align:center;">
            <img src="${escapeHtml(logoUrl)}" alt="${brand}, Powered by Firm Funds" height="56" style="height:56px; width:auto; max-width:360px;" />
          </td>`
      : `<td style="background:#5FA873; padding:22px 32px; text-align:center;">
            <img src="${escapeHtml(logoUrl)}" alt="${brand}" height="40" style="height:40px; width:auto; max-width:260px;" />
            <div style="font-size:12px; opacity:0.85; margin-top:8px; font-weight:400; color:#ffffff;">${tagline}</div>
          </td>`
    : `<td style="background:#5FA873; padding:22px 32px; color:#ffffff;">
            <div style="font-size:21px; font-weight:700; letter-spacing:-0.01em;">${brand}</div>
            <div style="font-size:12px; opacity:0.85; margin-top:3px; font-weight:400;">${tagline}</div>
          </td>`

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
          ${headerCell}
        </tr>
        <tr>
          <td style="padding:32px 36px 28px 36px; line-height:1.55;">
            <p style="font-size:16px; margin:0 0 16px 0; color:#1a2e1d;">Hi ${firstName},</p>
            <p style="font-size:16px; margin:0 0 28px 0; color:#222;">${intro}</p>
${commissionCallout}
            <p style="font-size:15px; color:#4a4a4a; margin:0 0 12px 0; text-align:center;">${altOption}</p>
            <div style="text-align:center; color:#aaa; font-size:11px; margin:14px 0 12px 0; text-transform:uppercase; letter-spacing:0.18em;">or</div>
            <a href="${cta}" style="display:block; text-decoration:none; background:linear-gradient(180deg,#f0f8f2 0%,#e6f3ea 100%); border:2px solid #5FA873; border-radius:10px; padding:26px 20px; text-align:center; margin:4px 0 28px 0;">
              <span style="display:block; font-size:34px; font-weight:800; color:#3d8055; line-height:1.1; letter-spacing:-0.01em;">Get paid <span style="color:#5FA873;">TODAY</span></span>
              ${todayLabel ? `<span style="display:block; font-size:13px; color:#5a7a64; margin-top:8px; font-weight:500;">${escapeHtml(todayLabel)}</span>` : ''}
            </a>
            <p style="font-size:14px; color:#555; margin:0 0 26px 0; text-align:center;">You're already onboarded, so you're only a few steps away from getting paid.</p>
            <div style="text-align:center; margin:20px 0 8px 0;">
              <a href="${cta}" style="display:inline-block; background:#5FA873; color:#ffffff; padding:15px 40px; border-radius:999px; text-decoration:none; font-weight:600; font-size:16px;">${escapeHtml(ctaLabel)} &rarr;</a>
            </div>
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

  const textIntro = input.variant === 'dual_agency'
    ? `We see that your recent deal at ${input.property_address} went firm. Looks like you held both sides too. Nice work.`
    : input.variant === 'sparse'
      ? `We spotted what looks like one of yours: ${input.property_address}. If that's right, confirm the details and we'll have an advance ready for you.`
      : `Congratulations on your recent deal at ${input.property_address}!`

  const textLines = [
    `Hi ${input.agent_first_name || 'there'},`,
    '',
    textIntro,
  ]
  if (input.variant === 'detailed' && input.commission_amount && input.commission_amount > 0) {
    textLines.push('')
    textLines.push(`Gross commission: ${formatMoney(input.commission_amount)}`)
    if (input.advance_estimate && input.advance_estimate > 0) {
      textLines.push(`Estimated advance today: ${formatMoney(input.advance_estimate)} (less brokerage splits)`)
    }
  }
  textLines.push(
    '',
    closingHuman
      ? `Would you like to wait until ${closingHuman} to receive your commission, or get paid TODAY?`
      : `Would you like to wait weeks for your commission, or get paid TODAY?`,
    '',
    `You're already onboarded, so you're only a few steps away from getting paid.`,
    '',
    `${ctaLabel}: ${cta}`,
    '',
    `${input.brand_name} - ${input.brand_tagline}`,
  )
  const text = textLines.join('\n')

  return { subject, html, text }
}
