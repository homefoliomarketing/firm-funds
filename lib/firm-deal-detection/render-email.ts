/**
 * lib/firm-deal-detection/render-email.ts
 *
 * White-label HTML email for the firm-deal trigger. Matches the
 * `email-mockup.html` design Bud signed off on. Two variants supported:
 *
 *   A1 (sparse)  - default for the spreadsheet pipe; no sale price, no
 *                  commission percentages
 *   A3 (dual)    - same agent held both sides of the deal
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
  cta_url: string                // deep link to the agent dashboard
  variant: 'sparse' | 'dual_agency'
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

export function renderTriggerEmail(input: EmailRenderInput): RenderedEmail {
  const firstName = escapeHtml(input.agent_first_name || 'there')
  const address = escapeHtml(input.property_address || 'your recent deal')
  const brand = escapeHtml(input.brand_name)
  const tagline = escapeHtml(input.brand_tagline)
  const cta = input.cta_url
  const closingHuman = formatClosingDate(input.closing_date_iso)

  // Intro line varies by variant; the rest of the layout is shared.
  let intro: string
  if (input.variant === 'dual_agency') {
    intro = `We see that your recent deal at <span style="font-weight:600; color:#1a2e1d;">${address}</span> went firm. Looks like you held both sides too. Nice work.`
  } else {
    intro = `We see that your recent deal at <span style="font-weight:600; color:#1a2e1d;">${address}</span> went firm. Congrats!`
  }

  const altOption = closingHuman
    ? `Would you like to wait until <span style="font-weight:600; color:#222;">${escapeHtml(closingHuman)}</span> to receive your commission&hellip;`
    : `Would you like to wait weeks for your commission&hellip;`

  const todayLabel = input.variant === 'dual_agency'
    ? 'Both sides, both commissions'
    : 'Instead of waiting weeks'

  const subject = input.variant === 'dual_agency'
    ? `Your deal at ${input.property_address} went firm`
    : `Your deal at ${input.property_address} went firm`

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
          <td style="background:#5FA873; padding:22px 32px; color:#ffffff;">
            <div style="font-size:21px; font-weight:700; letter-spacing:-0.01em;">${brand}</div>
            <div style="font-size:12px; opacity:0.85; margin-top:3px; font-weight:400;">${tagline}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px 28px 36px; line-height:1.55;">
            <p style="font-size:16px; margin:0 0 16px 0; color:#1a2e1d;">Hi ${firstName},</p>
            <p style="font-size:16px; margin:0 0 28px 0; color:#222;">${intro}</p>
            <p style="font-size:15px; color:#4a4a4a; margin:0 0 12px 0; text-align:center;">${altOption}</p>
            <div style="text-align:center; color:#aaa; font-size:11px; margin:14px 0 12px 0; text-transform:uppercase; letter-spacing:0.18em;">or</div>
            <div style="background:linear-gradient(180deg,#f0f8f2 0%,#e6f3ea 100%); border:2px solid #5FA873; border-radius:10px; padding:26px 20px; text-align:center; margin:4px 0 28px 0;">
              <p style="font-size:34px; font-weight:800; color:#3d8055; margin:0; line-height:1.1; letter-spacing:-0.01em;">Get paid <span style="color:#5FA873;">TODAY</span></p>
              <p style="font-size:13px; color:#5a7a64; margin-top:8px; font-weight:500;">${escapeHtml(todayLabel)}</p>
            </div>
            <p style="font-size:14px; color:#555; margin:0 0 26px 0; text-align:center;">You're already onboarded, so it's only a few steps from getting paid.</p>
            <div style="text-align:center; margin:20px 0 8px 0;">
              <a href="${cta}" style="display:inline-block; background:#5FA873; color:#ffffff; padding:15px 40px; border-radius:999px; text-decoration:none; font-weight:600; font-size:16px;">Get Paid Today &rarr;</a>
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

  const text = [
    `Hi ${input.agent_first_name || 'there'},`,
    '',
    input.variant === 'dual_agency'
      ? `We see that your recent deal at ${input.property_address} went firm. Looks like you held both sides too. Nice work.`
      : `We see that your recent deal at ${input.property_address} went firm. Congrats!`,
    '',
    closingHuman
      ? `Would you like to wait until ${closingHuman} to receive your commission, or get paid TODAY?`
      : `Would you like to wait weeks for your commission, or get paid TODAY?`,
    '',
    `You're already onboarded, so it's only a few steps from getting paid.`,
    '',
    `Get paid today: ${cta}`,
    '',
    `${input.brand_name} - ${input.brand_tagline}`,
  ].join('\n')

  return { subject, html, text }
}
