/**
 * lib/firm-deal-detection/render-agent-decline-email.ts
 *
 * Email to the agent when a brokerage admin declines their accepted firm-deal
 * offer. Keeps the tone friendly and explanatory — the agent did the right
 * thing by accepting, and we want them to know the loop closed even if the
 * brokerage said no on this one.
 *
 * Voice rules carry over from the other firm-deal templates:
 *   - No em dashes
 *   - No DocuSign references
 *   - "Hi <FirstName>"
 *   - White-label brand prefix
 */

export interface AgentDeclineEmailInput {
  agent_first_name: string
  brokerage_name: string
  property_address: string
  decline_reason: string
  brand_name: string
  brand_tagline: string
  agent_dashboard_url: string
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

export function renderAgentDeclineEmail(input: AgentDeclineEmailInput): RenderedEmail {
  const firstName = escapeHtml(input.agent_first_name || 'there')
  const brokerage = escapeHtml(input.brokerage_name)
  const address = escapeHtml(input.property_address)
  const reason = escapeHtml(input.decline_reason)
  const brand = escapeHtml(input.brand_name)
  const tagline = escapeHtml(input.brand_tagline)
  const cta = input.agent_dashboard_url

  const subject = `Update on your advance request for ${input.property_address}`

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
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
            <p style="font-size:16px; margin:0 0 14px 0; color:#1a2e1d;">Hi ${firstName},</p>
            <p style="font-size:15px; margin:0 0 18px 0; color:#333;">
              Quick update on your advance request for <span style="font-weight:600; color:#1a2e1d;">${address}</span>.
            </p>
            <p style="font-size:15px; margin:0 0 18px 0; color:#333;">
              ${brokerage} reviewed it and decided not to send it to us this time. Here's the note they left:
            </p>
            <div style="background:#f7faf8; border-left:3px solid #5FA873; padding:14px 18px; margin:0 0 22px 0; border-radius:0 8px 8px 0;">
              <p style="font-size:14px; color:#1a2e1d; margin:0; font-style:italic;">${reason}</p>
            </div>
            <p style="font-size:14px; margin:0 0 12px 0; color:#444;">
              If you think this was a misunderstanding, give your brokerage a quick call. They can re-open the request from their portal any time.
            </p>
            <p style="font-size:14px; margin:0 0 24px 0; color:#444;">
              And don't worry, you'll still see all your future firm deals here when they come up.
            </p>
            <div style="text-align:center; margin:20px 0 8px 0;">
              <a href="${cta}" style="display:inline-block; background:#5FA873; color:#ffffff; padding:13px 32px; border-radius:999px; text-decoration:none; font-weight:600; font-size:15px;">Open your dashboard &rarr;</a>
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
    `Quick update on your advance request for ${input.property_address}.`,
    '',
    `${input.brokerage_name} reviewed it and decided not to send it to us this time. Here's the note they left:`,
    '',
    `  "${input.decline_reason}"`,
    '',
    'If you think this was a misunderstanding, give your brokerage a quick call. They can re-open the request from their portal any time.',
    '',
    `And don't worry, you'll still see all your future firm deals here when they come up.`,
    '',
    `Open your dashboard: ${cta}`,
    '',
    `${input.brand_name} - ${input.brand_tagline}`,
  ].join('\n')

  return { subject, html, text }
}
