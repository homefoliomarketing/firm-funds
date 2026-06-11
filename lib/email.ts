import { Resend } from 'resend'
import { randomBytes } from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================================
// Resend client (lazy singleton)
// ============================================================================

let resendClient: Resend | null = null

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    // In production, missing key means transactional emails would silently
    // disappear. Throw so the call site logs an error (and Netlify alerting
    // picks it up). In dev we stay tolerant so local builds keep working.
    if (process.env.NODE_ENV === 'production') {
      console.error('[email] RESEND_API_KEY missing in production: refusing to silently drop email')
      throw new Error('RESEND_API_KEY is not configured')
    }
    console.error('[email] RESEND_API_KEY not set: emails disabled (dev only)')
    return null
  }
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY)
  }
  return resendClient
}

// ============================================================================
// CASL / RFC 8058 - Unsubscribe infrastructure
// ============================================================================
// Every promotional / notification-class email needs:
//   1. List-Unsubscribe header pointing to a URL the recipient can hit.
//   2. List-Unsubscribe-Post: List-Unsubscribe=One-Click (RFC 8058) so
//      Gmail / iCloud / Yahoo render a one-click "Unsubscribe" button.
//   3. A visible unsubscribe link in the body (Canadian CASL requirement).
//
// We also respect the recipient's preference flag (agents.email_notifications_enabled
// / brokerages.email_notifications_enabled, migration 092) BEFORE actually
// sending. If false, the wrapper logs a skip and returns without calling
// Resend.
//
// Migration 092 also adds the email_unsubscribe_tokens table (entity_type,
// entity_id, token). We mint tokens lazily, one per entity, reused across
// every send to that entity, so a recipient who unsubscribes from any
// previous email gets unsubscribed for all future ones via the same token.

type UnsubscribeEntityType = 'agent' | 'brokerage'

/**
 * Fetch or mint a stable unsubscribe token for an entity. Idempotent: the
 * same agent/brokerage always gets the same token across email sends, so a
 * recipient who saves an unsubscribe link from any past email can still use
 * it. Uses a 32-byte hex token (64 chars): long enough to be unguessable
 * but short enough to fit in a URL without wrapping in clients.
 */
async function getUnsubscribeToken(
  serviceClient: SupabaseClient,
  entityType: UnsubscribeEntityType,
  entityId: string
): Promise<string | null> {
  try {
    const { data: existing, error: selErr } = await serviceClient
      .from('email_unsubscribe_tokens')
      .select('token')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .maybeSingle()
    if (selErr) {
      // Surface the error but don't block the send: better to ship the
      // email with the generic /unsubscribe footer than to drop it.
      console.error('[email] unsubscribe token lookup failed:', selErr.message)
    }
    if (existing?.token) return existing.token

    const newToken = randomBytes(32).toString('hex')
    const { error: insErr } = await serviceClient
      .from('email_unsubscribe_tokens')
      .insert({
        token: newToken,
        entity_type: entityType,
        entity_id: entityId,
      })
    if (insErr) {
      // Probable race: another concurrent send minted a token a millisecond
      // earlier. Re-select and return that one. If THAT also fails, give up
      // and let the caller fall back to the generic unsubscribe URL.
      const { data: reSelected } = await serviceClient
        .from('email_unsubscribe_tokens')
        .select('token')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .maybeSingle()
      return reSelected?.token ?? null
    }
    return newToken
  } catch (err) {
    console.error('[email] unsubscribe token mint threw:', err)
    return null
  }
}

/**
 * Check whether emails to this entity are currently enabled (migration 092).
 * Returns true if the recipient has not unsubscribed; false if they have.
 * On lookup error returns true (fail-open): a transient DB blip should NOT
 * mute production transactional notifications.
 */
async function isEmailEnabledForEntity(
  serviceClient: SupabaseClient,
  entityType: UnsubscribeEntityType,
  entityId: string
): Promise<boolean> {
  try {
    const table = entityType === 'agent' ? 'agents' : 'brokerages'
    const { data, error } = await serviceClient
      .from(table)
      .select('email_notifications_enabled')
      .eq('id', entityId)
      .maybeSingle()
    if (error) {
      console.error(
        `[email] preference lookup failed for ${entityType}/${entityId}:`,
        error.message
      )
      return true
    }
    // If the row doesn't exist OR the column is somehow null (pre-migration),
    // default to enabled. The migration is NOT NULL DEFAULT true so this is
    // only a defensive guard.
    if (!data) return true
    const enabled = (data as { email_notifications_enabled?: boolean | null })
      .email_notifications_enabled
    if (enabled === null || enabled === undefined) return true
    return enabled !== false
  } catch (err) {
    console.error('[email] preference lookup threw:', err)
    return true
  }
}

/**
 * Build the CASL footer block + List-Unsubscribe headers. Splits the URL
 * construction so we can reuse the same URL in both the header and the body
 * (must match exactly for one-click clients).
 */
export function buildUnsubscribeFooter(unsubscribeUrl: string, isTransactional: boolean): string {
  // This block is appended AFTER the wrap() document, so it renders directly on
  // the #0A0A0A page background below the card. It is wrapped in a centered
  // presentation table constrained to the same 560px column as the card, with
  // quiet muted text and a green link. The visible unsubscribe / manage link is
  // preserved for CASL. `unsubscribeUrl` is a server-built URL, emitted as-is.
  const innerHtml = isTransactional
    // For mandatory account/security emails (password reset, email change
    // confirmation, etc.) the copy explains they cannot opt out of this class
    // of email, but still offers a "manage notifications" target for CASL.
    ? `This is an account and security email from Firm Funds that you cannot opt out of. <a href="${unsubscribeUrl}" style="color:#6FB783; text-decoration:none;">Manage notification preferences</a>.`
    : `You're receiving this email from Firm Funds. <a href="${unsubscribeUrl}" style="color:#6FB783; text-decoration:none;">Unsubscribe</a>. Firm Funds Inc., Ontario, Canada.`
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0A0A0A;">
      <tr>
        <td align="center" style="padding:20px 20px 28px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:560px;">
            <tr>
              <td align="center" style="text-align:center; color:#7E7E7B; font-size:11px; line-height:1.5; letter-spacing:0.04em; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                ${innerHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`
}

interface SendEmailOpts {
  to: string
  subject: string
  html: string
  /** Optional Resend reply-to override (defaults to FROM_ADDRESS). */
  replyTo?: string
  /**
   * If provided, the wrapper will:
   *   1. Skip the send entirely when this entity has unsubscribed.
   *   2. Mint/fetch an unsubscribe token bound to this entity so the
   *      List-Unsubscribe URL and the body footer link route to it.
   * Omit for emails to addresses that are not tied to an entity row in our
   * DB (admin/ops/Firm Funds internal escalation emails). Those still get a
   * generic /unsubscribe footer but no preference check.
   */
  entityType?: UnsubscribeEntityType
  entityId?: string
  /**
   * Account/security/legal emails that the recipient cannot opt out of:
   * password resets, email-change confirmations, BoR documents, KYC
   * approvals, contact-email change warnings. These STILL include a
   * List-Unsubscribe header (mailbox providers expect one on any
   * notification-class email) but the preference flag is bypassed and the
   * body footer wording reflects the email's mandatory nature.
   */
  transactional?: boolean
  /**
   * Optional file attachments. Resend takes `{ filename, content }` where
   * content is a Buffer (or base64 string); the SDK base64-encodes a Buffer
   * for us. Used to deliver executed signed PDFs (for example the brokerage's
   * copy of an Irrevocable Direction to Pay) directly on the email.
   */
  attachments?: { filename: string; content: Buffer }[]
}

/**
 * Resend wrapper that adds CASL footer + List-Unsubscribe headers and
 * respects the recipient's notification preference. Returns the Resend
 * response when sent, or null when the send was skipped or failed (errors
 * are logged, never thrown: the original sendXxx helpers had identical
 * fail-soft semantics so callers don't need to change).
 */
async function sendEmailWithUnsubscribe(opts: SendEmailOpts): Promise<unknown> {
  const resend = getResend()
  if (!resend) return null

  // Build the unsubscribe URL. If we have an entity, mint/fetch a per-entity
  // token; otherwise use the generic landing page (which renders "this is a
  // transactional email, you can't unsubscribe").
  let unsubscribeUrl = `${APP_URL}/unsubscribe`
  let serviceClient: SupabaseClient | null = null
  if (opts.entityType && opts.entityId) {
    try {
      serviceClient = createServiceRoleClient()
    } catch (err) {
      console.error('[email] service-role client unavailable:', err)
    }
    if (serviceClient) {
      // Preference check: skip non-transactional sends when the recipient
      // has unsubscribed. Transactional sends (account/security) bypass.
      if (!opts.transactional) {
        const enabled = await isEmailEnabledForEntity(
          serviceClient,
          opts.entityType,
          opts.entityId
        )
        if (!enabled) {
          console.log(
            `[email] skipped per recipient preference (${opts.entityType}/${opts.entityId}, subject="${opts.subject}")`
          )
          return null
        }
      }
      const token = await getUnsubscribeToken(
        serviceClient,
        opts.entityType,
        opts.entityId
      )
      if (token) {
        unsubscribeUrl = `${APP_URL}/unsubscribe?token=${token}`
      }
    }
  }

  const footer = buildUnsubscribeFooter(unsubscribeUrl, !!opts.transactional)

  try {
    const payload: Parameters<typeof resend.emails.send>[0] = {
      from: FROM_ADDRESS,
      to: opts.to,
      subject: opts.subject,
      html: opts.html + footer,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        // RFC 8058: Gmail / iCloud render a one-click button. Without the
        // -Post header they fall back to the mailto/URL but won't show the
        // big "Unsubscribe" affordance.
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }
    if (opts.replyTo) {
      ;(payload as { replyTo?: string }).replyTo = opts.replyTo
    }
    if (opts.attachments && opts.attachments.length > 0) {
      // Resend's attachment shape is { filename, content } with content as a
      // Buffer (the SDK base64-encodes it). Cast through the SDK option type so
      // we don't widen the shared payload typing.
      ;(payload as { attachments?: { filename: string; content: Buffer }[] }).attachments =
        opts.attachments
    }
    return await resend.emails.send(payload)
  } catch (err) {
    console.error(`[email] send failed (subject="${opts.subject}"):`, err)
    return null
  }
}

// ============================================================================
// Constants
// ============================================================================

const FROM_ADDRESS = 'Firm Funds <notifications@firmfunds.ca>'
const ADMIN_EMAIL = 'bud@firmfunds.ca'
const APP_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'

// sanitizeSubject strips CR/LF from email subject lines to prevent header
// injection (a CRLF inside a user-controlled subject could split the header
// and craft a fake one). escapeHtml lives further down the file and handles
// HTML entity encoding for body interpolations.

function sanitizeSubject(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, 200)
}

// dealTag renders the deal number as a bracketed subject-line prefix, e.g.
// "[0001-0609-26] ". Returns an empty string when the deal number is absent
// (unsubmitted firm-deal "offered" leads) so the subject reads exactly as it
// did before. Used to prefix the subjects of deal-scoped transactional emails
// so staff/agents/brokerages can reference a deal by its number.
const dealTag = (n?: string | null): string => (n ? `[${n}] ` : '')

// Each deal-scoped body renders its own "Deal Number" line inline (the tables
// differ in label widths / alignment per template), gated on the deal number
// being present. The number is server-generated (format "0001-0609-26") but is
// still passed through escapeHtml for defense in depth.

// ============================================================================
// Branded HTML wrapper
// ============================================================================

/**
 * Fetch brokerage branding (logo + tagline flag) for a given agent. Used by
 * agent-facing email functions to render the agent's brokerage logo in the
 * email header. Returns null on miss or any error: emails fall back to the
 * default Firm Funds wordmark in that case (never throws, never blocks the
 * email).
 */
async function getBrandingForAgent(agentId?: string | null): Promise<BrokerageBranding | null> {
  if (!agentId) return null
  try {
    const svc = createServiceRoleClient()
    const { data } = await svc
      .from('agents')
      .select('brokerages(name, logo_url, logo_includes_tagline)')
      .eq('id', agentId)
      .maybeSingle()
    const b = (data as { brokerages?: { name: string | null; logo_url: string | null; logo_includes_tagline: boolean | null } | null } | null)?.brokerages
    if (!b?.logo_url) return null
    return { logoUrl: b.logo_url, name: b.name || '', logoIncludesTagline: !!b.logo_includes_tagline }
  } catch (e) {
    console.error('[email] getBrandingForAgent failed:', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Fetch brokerage branding for a given brokerage. Used by brokerage-facing
 * email functions. Same fail-safe behavior as getBrandingForAgent.
 */
async function getBrandingForBrokerage(brokerageId?: string | null): Promise<BrokerageBranding | null> {
  if (!brokerageId) return null
  try {
    const svc = createServiceRoleClient()
    const { data } = await svc
      .from('brokerages')
      .select('name, logo_url, logo_includes_tagline')
      .eq('id', brokerageId)
      .maybeSingle()
    if (!data?.logo_url) return null
    return { logoUrl: data.logo_url, name: data.name || '', logoIncludesTagline: !!data.logo_includes_tagline }
  } catch (e) {
    console.error('[email] getBrandingForBrokerage failed:', e instanceof Error ? e.message : e)
    return null
  }
}

interface BrokerageBranding {
  logoUrl: string | null
  name: string
  /** TRUE when logoUrl was produced by lib/brokerage-logo-generator.ts and
   *  already contains the "Powered by Firm Funds" tagline. In that case we
   *  render the logo alone and skip the separate FF wordmark below it to
   *  avoid duplication. Defaults to FALSE (existing custom-upload behavior).
   *  See migration 096. */
  logoIncludesTagline?: boolean
}

function brandHeader(branding?: BrokerageBranding | null): string {
  // Logo header sizing + padding ported from public/email-mockup-welcome.html:
  // an 88px-tall generated logo, 36px bottom padding, centered, max-width capped
  // so a wide wordmark does not overflow the 560px column on narrow clients.
  if (branding?.logoUrl) {
    if (branding.logoIncludesTagline) {
      // Generated logo already includes "Powered by Firm Funds". Render alone.
      // The generated SVG packs mark + name + tagline, so it gets the full 88px.
      return `
      <td align="center" style="padding:0 0 36px;">
        <img src="${branding.logoUrl}" alt="${escapeHtml(branding.name)}, powered by Firm Funds" height="88" style="display:block; height:88px; width:auto; max-width:340px; border:0; outline:none; text-decoration:none;" />
      </td>`
    }
    // Custom-uploaded logo, so add a separate "Powered by Firm Funds" line below.
    return `
      <td align="center" style="padding:0 0 36px;">
        <img src="${branding.logoUrl}" alt="${escapeHtml(branding.name)}" height="44" style="display:block; height:44px; width:auto; max-width:240px; border:0; outline:none; text-decoration:none; margin:0 auto;" />
        <div style="margin-top:12px;">
          <span style="color:#8A8A87; font-size:10px; letter-spacing:0.06em; text-transform:uppercase;">Powered by</span>
          <img src="${APP_URL}/brand/white.png" alt="Firm Funds" height="12" style="height:12px; width:auto; vertical-align:middle; margin-left:6px;" />
        </div>
      </td>`
  }
  // Default: Firm Funds-only header.
  return `
      <td align="center" style="padding:0 0 36px;">
        <img src="${APP_URL}/brand/white.png" alt="Firm Funds" height="40" style="display:block; height:40px; width:auto; border:0; outline:none; text-decoration:none;" />
      </td>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Hidden preheader (preview text). Renders the first line a recipient sees in
// the inbox list before opening. The trailing zero-width / non-breaking run pads
// out the preview so the client does not pull body copy in after the sentence.
// Ported from public/email-mockup-welcome.html.
function preheaderBlock(text: string): string {
  return `  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#0A0A0A;">
    ${escapeHtml(text)}
    &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </div>
`
}

/**
 * Shared email shell. Ported from public/email-mockup-welcome.html: near-black
 * page background, an elevated 560px card with a thin green top accent key-line
 * (solid-color fallback declared BEFORE the gradient for Outlook), the brand
 * logo header, the body region, and a three-line quiet footer.
 *
 * The optional `preheader` renders the hidden preview-text div at the top of
 * <body>. It is the third positional parameter so the other ~37 callers, which
 * pass only (body, branding), are unaffected.
 *
 * The optional `fullWidthTrailer` is emitted edge-to-edge inside the card, after
 * the 44px-padded body region. The Welcome redesign uses it for the recessed
 * fallback-link shelf, which the mockup renders flush to the card edges with its
 * own darker background. Omit it and the card ends at the body, exactly as the
 * 37 existing callers expect.
 *
 * NOTE: this returns the COMPLETE document but deliberately does NOT include the
 * CASL unsubscribe footer. sendEmailWithUnsubscribe appends that as
 * `opts.html + footer`, so wrap() must stay footer-free.
 */
function wrap(
  body: string,
  branding?: BrokerageBranding | null,
  preheader?: string,
  fullWidthTrailer?: string
): string {
  const footerLeadLine = branding?.name
    ? `${escapeHtml(branding.name)} &bull; powered by Firm Funds Inc.`
    : 'Firm Funds Incorporated &bull; Ontario, Canada'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
</head>
<body style="margin:0; padding:0; background:#0A0A0A; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${preheader ? preheaderBlock(preheader) : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0A0A0A;">
    <tr>
      <td align="center" style="padding:56px 20px;">

        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:560px;">

          <!-- Logo header -->
          <tr>
            ${brandHeader(branding)}
          </tr>

          <!-- Main card -->
          <tr>
            <td style="background:#161616; border:1px solid #2A2A2A; border-radius:18px; overflow:hidden;">

              <!-- Top accent key-line: solid green fallback first, gradient where supported -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="height:2px; line-height:2px; font-size:0; background:#5FA873; background:linear-gradient(90deg,#4A8E5F 0%,#5FA873 50%,#4A8E5F 100%);">&nbsp;</td>
                </tr>
              </table>

              <!-- Card body -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:44px 44px 40px; color:#D6D6D4; font-size:15px; line-height:1.65;">
                    ${body}
                  </td>
                </tr>
              </table>
${fullWidthTrailer ? `
              ${fullWidthTrailer}
` : ''}
            </td>
          </tr>

          <!-- Footer (three quiet lines) -->
          <tr>
            <td align="center" style="padding:30px 36px 0;">
              <p style="margin:0 0 6px; color:#7E7E7B; font-size:11px; font-weight:400; line-height:1.5; letter-spacing:0.04em;">
                ${footerLeadLine}
              </p>
              <a href="${APP_URL}" style="color:#5FA873; text-decoration:none; font-size:11px; font-weight:600; letter-spacing:0.04em;">firmfunds.ca</a>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`
}

// ============================================================================
// Reusable email body components (ported from public/email-mockup-welcome.html)
// ============================================================================
// Pure string-returning helpers shared across templates. These will be reused
// as the redesign propagates to the other email functions. Pass already-trusted
// or already-escaped values: emailButton / emailFallbackLink take a URL we build
// server-side, while emailDetailCard escapes every cell via escapeHtml.

/** Green uppercase eyebrow label above a headline. Uppercasing is done with CSS
 *  (text-transform + letter-spacing), not by hardcoding uppercase text. */
function emailKicker(text: string): string {
  return `<p style="margin:0 0 18px; color:#6FB783; font-size:11px; font-weight:700; line-height:1; letter-spacing:0.16em; text-transform:uppercase;">${escapeHtml(text)}</p>`
}

/** Standard headline (h1) that sits under the kicker. Near-white, tight tracking.
 *  Text is escaped, so pass a plain string. Kept at 26px (a touch smaller than the
 *  Welcome email's 28px) so longer headlines like "Closing date amendment
 *  requested" still sit on one or two clean lines. */
function emailHeadline(text: string): string {
  return `<h1 style="margin:0 0 16px; color:#F5F5F4; font-size:26px; font-weight:700; line-height:1.25; letter-spacing:-0.02em;">${escapeHtml(text)}</h1>`
}

/** Hero CTA button. Bulletproof: a VML v:roundrect for Outlook plus a padded,
 *  gradient-backed anchor (solid-color fallback first) everywhere else. `href`
 *  is a server-built URL; it is emitted as-is into both the VML and the anchor. */
function emailButton(label: string, href: string): string {
  const safeLabel = escapeHtml(label)
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" style="padding:4px 0 8px;">
                          <!--[if mso]>
                          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                            href="${href}"
                            style="height:54px;v-text-anchor:middle;width:340px;" arcsize="24%" stroke="f" fillcolor="#5FA873">
                            <w:anchorlock/>
                            <center style="color:#0A140C;font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:700;letter-spacing:0.01em;">
                              ${safeLabel}
                            </center>
                          </v:roundrect>
                          <![endif]-->
                          <!--[if !mso]><!-- -->
                          <a href="${href}"
                             style="display:block; width:100%; background:#5FA873; background:linear-gradient(180deg,#65AE79 0%,#5FA873 50%,#549C6A 100%); color:#0A140C; text-decoration:none; text-align:center; font-size:16px; font-weight:700; line-height:54px; letter-spacing:0.01em; border-radius:13px; box-shadow:0 1px 0 rgba(255,255,255,0.10) inset, 0 6px 18px rgba(74,142,95,0.28);">
                            ${safeLabel}
                          </a>
                          <!--<![endif]-->
                        </td>
                      </tr>
                    </table>`
}

/** Statement-style details card: left labels (uppercase, muted), right-aligned
 *  values, hairline divider between rows. Every label and value is escaped.
 *  Optional per-row `valueColor` (semantic emphasis, e.g. a green amount or a
 *  red old-email) and `strong` (bold the value) default to the muted body grey
 *  and normal weight, so existing callers that pass only { label, value } are
 *  unchanged. */
function emailDetailCard(rows: { label: string; value: string; valueColor?: string; strong?: boolean }[]): string {
  const divider = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr><td style="height:1px; line-height:1px; font-size:0; background:#232323;">&nbsp;</td></tr>
                          </table>`
  const rowHtml = rows
    .map(
      (r) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="padding:14px 0; color:#8A8A87; font-size:12px; font-weight:600; line-height:1.4; letter-spacing:0.04em; text-transform:uppercase; width:120px; vertical-align:middle;">
                                ${escapeHtml(r.label)}
                              </td>
                              <td style="padding:14px 0; color:${r.valueColor || '#D6D6D4'}; font-size:14px; font-weight:${r.strong ? '600' : '400'}; line-height:1.4; text-align:right; vertical-align:middle; word-break:break-all;">
                                ${escapeHtml(r.value)}
                              </td>
                            </tr>
                          </table>`
    )
    .join(`\n                          ${divider}\n                          `)
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 30px;">
                      <tr>
                        <td style="background:#1C1C1C; border:1px solid #2A2A2A; border-radius:12px; padding:6px 22px;">
                          ${rowHtml}
                        </td>
                      </tr>
                    </table>`
}

/** Recessed monospaced "Button not working?" shelf with the raw fallback URL.
 *  Sits in its own key-line zone below the card body. `url` is server-built. */
function emailFallbackLink(url: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="height:1px; line-height:1px; font-size:0; background:#232323;">&nbsp;</td></tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:22px 44px 26px; background:#131313;">
                    <p style="margin:0 0 8px; color:#8A8A87; font-size:12px; font-weight:600; line-height:1.4; letter-spacing:0.04em; text-transform:uppercase;">
                      Button not working?
                    </p>
                    <p style="margin:0; color:#858582; font-size:13px; line-height:1.5;">
                      Copy and paste this link into your browser:
                    </p>
                    <p style="margin:6px 0 0; font-family:'SF Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.5; word-break:break-all;">
                      <a href="${url}" style="color:#6FB783; text-decoration:none;">${url}</a>
                    </p>
                  </td>
                </tr>
              </table>`
}

/**
 * Tinted, rounded callout box used for every semantic highlight in the emails:
 * an approval banner, a "funds on the way" banner, a denial/return reason, a
 * settlement-date highlight, a security warning, and so on. Standardizing this
 * one helper keeps all the colored boxes visually consistent across every
 * template (instead of each email inventing its own hex values).
 *
 * Each tone is tuned for WCAG AA on the dark card: a deep tinted background, a
 * matching 1px border, an accent title color (used at >=12px bold so it clears
 * AA), and a near-white body text color. `title` is escaped; `body` is RAW HTML
 * so callers can include their own escaped interpolations and inline emphasis.
 */
function emailCallout(opts: {
  tone?: 'success' | 'funded' | 'info' | 'warning' | 'danger' | 'neutral'
  title?: string
  body: string
  align?: 'left' | 'center'
}): string {
  const tones = {
    success: { bg: '#10271A', border: '#235638', title: '#6FB783', text: '#DCE9E0' },
    funded: { bg: '#18123A', border: '#332066', title: '#A78BFA', text: '#E2DBF4' },
    info: { bg: '#121D33', border: '#284063', title: '#88A9E6', text: '#D7E1F1' },
    warning: { bg: '#2A2410', border: '#564618', title: '#E0B15A', text: '#ECE1C8' },
    danger: { bg: '#271414', border: '#582A2A', title: '#F08C8C', text: '#EFDBDB' },
    neutral: { bg: '#1C1C1C', border: '#2A2A2A', title: '#8A8A87', text: '#D6D6D4' },
  }
  const t = tones[opts.tone ?? 'neutral']
  const align = opts.align ?? 'left'
  const titleHtml = opts.title
    ? `<p style="margin:0 0 8px; color:${t.title}; font-size:12px; font-weight:700; line-height:1.3; letter-spacing:0.08em; text-transform:uppercase;">${escapeHtml(opts.title)}</p>`
    : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 30px;">
                      <tr>
                        <td style="background:${t.bg}; border:1px solid ${t.border}; border-radius:12px; padding:18px 20px; text-align:${align};">
                          ${titleHtml}<div style="color:${t.text}; font-size:14px; font-weight:400; line-height:1.6;">${opts.body}</div>
                        </td>
                      </tr>
                    </table>`
}

// ============================================================================
// Helpers
// ============================================================================

function formatCurrency(dollars: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(dollars)
}

function statusLabel(status: string): string {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    under_review: '#3D8BF2',
    approved: '#5FA873',
    funded: '#8B5CF6',
    denied: '#EF4444',
    cancelled: '#888888',
    completed: '#06B6D4',
  }
  return map[status] || '#5FA873'
}

// ============================================================================
// Email: New Deal Submitted → Admin
// ============================================================================

/**
 * PURE renderer for the admin "New Deal Submitted" notification. Synchronous,
 * no I/O. Mirrors renderAgentInviteEmail: builds the premium-dark body (kicker,
 * headline, lead, details card, hero CTA) and returns the wrapped document with
 * a preheader and the recessed fallback-link shelf for the Review Deal CTA.
 * Admin-only, so no branding. sendNewDealNotification owns the send.
 */
export function renderNewDealEmail(params: {
  dealId: string
  propertyAddress: string
  advanceAmount: number
  agentName: string
  brokerageName: string
  dealNumber?: string | null
}): string {
  const reviewUrl = `${APP_URL}/admin/deals/${params.dealId}`

  const body = `${emailKicker('New deal')}

                    ${emailHeadline('New deal submitted.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      A new commission advance request has been submitted and is awaiting your review.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'Agent', value: params.agentName ?? '' },
                      { label: 'Brokerage', value: params.brokerageName ?? '' },
                      { label: 'Advance Amount', value: formatCurrency(params.advanceAmount), valueColor: '#6FB783', strong: true },
                    ])}

                    ${emailButton('Review Deal', reviewUrl)}`

  const preheader = `New advance request from ${params.agentName ?? ''} is awaiting your review.`

  return wrap(body, null, preheader, emailFallbackLink(reviewUrl))
}

export async function sendNewDealNotification(params: {
  dealId: string
  propertyAddress: string
  advanceAmount: number
  agentName: string
  brokerageName: string
  dealNumber?: string | null
}): Promise<void> {
  // Admin-targeted internal notification, no entity preference check, but
  // we still include a List-Unsubscribe header pointing at the generic
  // unsubscribe surface (mailbox providers expect one on notification-class
  // mail) and an "account email" footer in the body.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}New Deal Submitted: ${params.propertyAddress}`),
    transactional: true,
    html: renderNewDealEmail(params),
  })
}

// ============================================================================
// Email: New Deal Submitted → Brokerage Admin
// ============================================================================

/**
 * PURE renderer for the brokerage-admin "New Advance Request" notification.
 * Synchronous, no I/O. Mirrors renderAgentInviteEmail: kicker, headline, greeting
 * lead, details card, the "now under review / track from your dashboard" muted
 * note, then the hero CTA. Carries the brokerage branding through to wrap(), plus
 * a preheader and the fallback shelf for the dashboard CTA.
 */
export function renderBrokerageAdminNewDealEmail(params: {
  dealId: string
  propertyAddress: string
  advanceAmount: number
  agentName: string
  brokerageAdminFirstName: string
  brokerageName: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const firstName = escapeHtml(params.brokerageAdminFirstName ?? '')
  const dashboardUrl = `${APP_URL}/brokerage`

  const body = `${emailKicker('Advance request')}

                    ${emailHeadline('New advance request.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${firstName}, one of your agents has submitted a commission advance request through Firm Funds.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Agent', value: params.agentName ?? '' },
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'Advance Amount', value: formatCurrency(params.advanceAmount), valueColor: '#6FB783', strong: true },
                    ])}

                    ${emailButton('View Brokerage Dashboard', dashboardUrl)}

                    <p style="margin:16px 0 0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55; text-align:center;">
                      This deal is now under review by Firm Funds. You&rsquo;ll be able to track its status from your brokerage dashboard.
                    </p>`

  const preheader = `${params.agentName ?? ''} submitted a new advance request. Now under review.`

  return wrap(body, params.branding, preheader, emailFallbackLink(dashboardUrl))
}

export async function sendBrokerageAdminNewDealNotification(params: {
  dealId: string
  propertyAddress: string
  advanceAmount: number
  agentName: string
  brokerageAdminEmail: string
  brokerageAdminFirstName: string
  brokerageName: string
  /** Pass-through to enable per-brokerage unsubscribe handling (migration 092). */
  brokerageId?: string | null
  dealNumber?: string | null
}): Promise<void> {
  const branding = await getBrandingForBrokerage(params.brokerageId)
  await sendEmailWithUnsubscribe({
    to: params.brokerageAdminEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}New Advance Request: ${params.agentName}, ${params.propertyAddress}`),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    html: renderBrokerageAdminNewDealEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      advanceAmount: params.advanceAmount,
      agentName: params.agentName,
      brokerageAdminFirstName: params.brokerageAdminFirstName,
      brokerageName: params.brokerageName,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Email: Deal Status Changed → Agent
// ============================================================================

/**
 * PURE renderer for the agent "Deal Status Updated" notification. Synchronous,
 * no I/O. Mirrors renderAgentInviteEmail: kicker, headline, greeting lead, a
 * details card (Property, Deal Number when present), a centered old -> new status
 * transition built from two pills joined by an arrow (colors from statusColor),
 * then the status-dependent callout (approved / funded / denied-with-reason) and
 * the hero CTA. Carries branding through to wrap(), plus a preheader and the
 * fallback shelf for the View Deal CTA.
 */
export function renderStatusChangeEmail(params: {
  dealId: string
  propertyAddress: string
  oldStatus: string
  newStatus: string
  agentFirstName: string
  denialReason?: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const oldColor = statusColor(params.oldStatus)
  const newColor = statusColor(params.newStatus)
  // Pill TEXT uses a lighter variant of each status hue so it clears WCAG AA on
  // the low-opacity tinted chip (the full-strength statusColor used for the chip
  // background fails at 13px). The chip background keeps the brand status hue.
  const pillTextColor = (status: string): string => {
    const map: Record<string, string> = {
      under_review: '#6FA8F5',
      approved: '#6FB783',
      funded: '#A78BFA',
      denied: '#F08C8C',
      cancelled: '#9CA3AF',
      completed: '#3FC9DD',
    }
    return map[status] || '#A1A1A1'
  }
  const oldText = pillTextColor(params.oldStatus)
  const newText = pillTextColor(params.newStatus)
  const oldLabel = statusLabel(params.oldStatus)
  const newLabel = statusLabel(params.newStatus)
  const dealUrl = `${APP_URL}/agent/deals/${params.dealId}`

  // Centered transition: old-status pill, an arrow, new-status pill. Each pill is
  // a tinted chip whose color comes from statusColor (background at low opacity
  // via an 8-digit hex alpha suffix), matching the original two-pill treatment.
  const transition = `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 30px;">
                      <tr>
                        <td style="padding:6px 14px; background:${oldColor}1F; border-radius:8px; color:${oldText}; font-size:13px; font-weight:600; letter-spacing:0.02em;">
                          ${escapeHtml(oldLabel)}
                        </td>
                        <td style="padding:0 14px; color:#8A8A87; font-size:16px;">&rarr;</td>
                        <td style="padding:6px 14px; background:${newColor}1F; border-radius:8px; color:${newText}; font-size:13px; font-weight:600; letter-spacing:0.02em;">
                          ${escapeHtml(newLabel)}
                        </td>
                      </tr>
                    </table>`

  let callout = ''
  if (params.newStatus === 'approved') {
    callout = emailCallout({
      tone: 'success',
      title: 'Approved',
      body: `You're Approved! Your advance has been approved and will be funded shortly. We'll send another notification once the funds are on the way.`,
    })
  } else if (params.newStatus === 'funded') {
    callout = emailCallout({
      tone: 'funded',
      body: `Funds on the Way! Your EFT transfer is being processed and our goal is to have the funds in your account within 24 business hours. We'll keep you posted if anything changes.`,
    })
  } else if (params.newStatus === 'denied' && params.denialReason) {
    callout = emailCallout({
      tone: 'danger',
      title: 'Reason',
      body: escapeHtml(params.denialReason),
    })
  }

  const body = `${emailKicker('Deal update')}

                    ${emailHeadline('Deal status updated.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(params.agentFirstName ?? '')}, the status of your deal has been updated.
                    </p>

                    ${emailDetailCard([
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                    ])}

                    ${transition}

                    ${callout}${emailButton('View Deal', dealUrl)}`

  const preheader = `Your deal for ${params.propertyAddress ?? ''} is now ${newLabel}.`

  return wrap(body, params.branding, preheader, emailFallbackLink(dealUrl))
}

export async function sendStatusChangeNotification(params: {
  dealId: string
  propertyAddress: string
  oldStatus: string
  newStatus: string
  agentEmail: string
  agentFirstName: string
  denialReason?: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
  dealNumber?: string | null
}): Promise<void> {
  const label = statusLabel(params.newStatus)

  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(
      dealTag(params.dealNumber) + (
        params.newStatus === 'approved'
          ? `Good News: Your Advance for ${params.propertyAddress} is Approved!`
          : params.newStatus === 'funded'
          ? `Funds on the Way: ${params.propertyAddress}`
          : params.newStatus === 'denied'
          ? `Advance Update: ${params.propertyAddress}`
          : `Deal Update: ${params.propertyAddress} (${label})`
      )
    ),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: renderStatusChangeEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      oldStatus: params.oldStatus,
      newStatus: params.newStatus,
      agentFirstName: params.agentFirstName,
      denialReason: params.denialReason,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Email: Document Requested → Agent
// ============================================================================

/**
 * PURE renderer for the agent "Document Requested" notification. Synchronous,
 * no I/O. Mirrors renderAgentInviteEmail: kicker, headline, greeting lead, a
 * details card (Deal Number when present, Property, the titleized Document Type),
 * an optional neutral callout carrying the staff note, then the hero CTA. Carries
 * branding through to wrap(), plus a preheader and the fallback shelf for the
 * Upload Document CTA.
 */
export function renderDocumentRequestEmail(params: {
  dealId: string
  propertyAddress: string
  documentType: string
  agentFirstName: string
  message?: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const docTypeLabel = params.documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const uploadUrl = `${APP_URL}/agent/deals/${params.dealId}`

  const messageCallout = params.message
    ? emailCallout({ tone: 'neutral', title: 'Note from Firm Funds', body: escapeHtml(params.message) })
    : ''

  const body = `${emailKicker('Document request')}

                    ${emailHeadline('Document requested.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(params.agentFirstName ?? '')}, Firm Funds has requested a document for your deal.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'Document Type', value: docTypeLabel },
                    ])}

                    ${messageCallout}${emailButton('Upload Document', uploadUrl)}`

  const preheader = `Firm Funds requested ${docTypeLabel} for ${params.propertyAddress ?? ''}.`

  return wrap(body, params.branding, preheader, emailFallbackLink(uploadUrl))
}

export async function sendDocumentRequestNotification(params: {
  dealId: string
  propertyAddress: string
  documentType: string
  agentEmail: string
  agentFirstName: string
  message?: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
  dealNumber?: string | null
}): Promise<void> {
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Document Requested: ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: renderDocumentRequestEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      documentType: params.documentType,
      agentFirstName: params.agentFirstName,
      message: params.message,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Email: Agent Invite → New Agent
// ============================================================================

/**
 * PURE renderer for the Welcome / agent-invite email. Synchronous, no I/O.
 * Builds the redesigned body (kicker, h1 headline, lead, details card, hero CTA,
 * expiry note) and the recessed fallback-link shelf, then returns the fully
 * wrapped document via wrap(...). The redesign is ported 1:1 from
 * public/email-mockup-welcome.html. Kept exported and side-effect-free so it can
 * be rendered in a preview script or a dev route without touching Resend or the
 * DB. sendAgentInviteNotification owns the send (branding lookup, URL, headers).
 */
export function renderAgentInviteEmail(params: {
  agentFirstName: string
  agentEmail: string
  brokerageName: string
  inviteUrl: string
  branding?: BrokerageBranding | null
}): string {
  const firstName = escapeHtml(params.agentFirstName ?? '')
  const brokerage = escapeHtml(params.brokerageName ?? '')

  const body = `${emailKicker('Account activation')}

                    <h1 style="margin:0 0 16px; color:#F5F5F4; font-size:28px; font-weight:700; line-height:1.2; letter-spacing:-0.02em;">
                      Welcome, ${firstName}.
                    </h1>

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${brokerage} has set up your account so they can request commission advances on your behalf, powered by Firm Funds. Set your password to activate it, then finish a quick ID check and add your banking.
                    </p>

                    ${emailDetailCard([
                      { label: 'Brokerage', value: params.brokerageName ?? '' },
                      { label: 'Your login', value: params.agentEmail ?? '' },
                    ])}

                    ${emailButton('Activate my account', params.inviteUrl)}

                    <p style="margin:16px 0 0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55; text-align:center;">
                      This activation link is unique to you and expires in 72 hours.
                    </p>`

  const preheader = `Your ${params.brokerageName ?? ''} account is ready. Set your password to get started.`

  return wrap(body, params.branding, preheader, emailFallbackLink(params.inviteUrl))
}

// The legacy `tempPassword` parameter was removed for security.
// All callers now pass an invite token instead of sending credentials in email.
export async function sendAgentInviteNotification(params: {
  agentFirstName: string
  agentEmail: string
  brokerageName: string
  brokerageLogoUrl?: string | null
  /** TRUE if the logo SVG already contains "Powered by Firm Funds". Migration 096. */
  brokerageLogoIncludesTagline?: boolean | null
  inviteToken: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}): Promise<void> {
  const branding: BrokerageBranding | null = params.brokerageLogoUrl
    ? { logoUrl: params.brokerageLogoUrl, name: params.brokerageName, logoIncludesTagline: params.brokerageLogoIncludesTagline ?? false }
    : null

  const inviteUrl = `${APP_URL}/invite/${params.inviteToken}`
  // Account-setup email: recipient cannot unsubscribe from being invited.
  // Marked transactional so we include the List-Unsubscribe header (mailbox
  // providers expect one) but bypass the preference check.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Welcome to ${params.brokerageName}: Set Up Your Account`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: renderAgentInviteEmail({
      agentFirstName: params.agentFirstName,
      agentEmail: params.agentEmail,
      brokerageName: params.brokerageName,
      inviteUrl,
      branding,
    }),
  })
}

// ============================================================================
// Email: Document Uploaded → Admin
// ============================================================================

/**
 * PURE renderer for the admin "Document Uploaded" notification. Synchronous,
 * no I/O. Mirrors renderAgentInviteEmail: kicker, headline, the role-aware
 * "uploaded by" lead sentence, a details card (Deal Number when present,
 * Property, Uploaded By, the titleized Document Type, File), then the hero CTA.
 * Admin-only, so no branding; carries a preheader and the fallback shelf for the
 * Review Deal CTA. The role-dependent lead text and the "Uploaded By" label are
 * derived here exactly as before; the label is passed raw so emailDetailCard
 * escapes it once (the lead sentence escapes the name inline).
 */
export function renderDocumentUploadedEmail(params: {
  dealId: string
  propertyAddress: string
  documentType: string
  fileName: string
  uploaderRole: string
  uploaderName: string
  dealNumber?: string | null
}): string {
  // Escaped uploader name for the raw-HTML lead sentence; role labels are
  // server-controlled so safe.
  const safeUploaderName = escapeHtml(params.uploaderName ?? '')

  let uploadedByText: string
  if (params.uploaderRole === 'brokerage_admin') {
    uploadedByText = `A brokerage admin (${safeUploaderName}) has uploaded a new document for review.`
  } else if (params.uploaderRole === 'agent') {
    uploadedByText = `${safeUploaderName} (Agent) has uploaded a new document for review.`
  } else {
    uploadedByText = `${safeUploaderName} has uploaded a new document for review.`
  }

  // Raw (unescaped) label for the details card, which escapes it once. The role
  // suffix is server-controlled, so only the name needs escaping (done by the card).
  let uploadedByLabel = params.uploaderName ?? ''
  if (params.uploaderRole === 'agent') {
    uploadedByLabel += ' (Agent)'
  } else if (params.uploaderRole === 'brokerage_admin') {
    uploadedByLabel += ' (Brokerage Admin)'
  }

  const docTypeLabel = params.documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const reviewUrl = `${APP_URL}/admin/deals/${params.dealId}`

  const body = `${emailKicker('Document uploaded')}

                    ${emailHeadline('Document uploaded.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${uploadedByText}
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'Uploaded By', value: uploadedByLabel },
                      { label: 'Document Type', value: docTypeLabel },
                      { label: 'File', value: params.fileName ?? '' },
                    ])}

                    ${emailButton('Review Deal', reviewUrl)}`

  const preheader = `${uploadedByLabel} uploaded ${docTypeLabel} for ${params.propertyAddress ?? ''}.`

  return wrap(body, null, preheader, emailFallbackLink(reviewUrl))
}

export async function sendDocumentUploadedNotification(params: {
  dealId: string
  propertyAddress: string
  documentType: string
  fileName: string
  agentName: string
  uploaderRole: string
  uploaderName: string
  dealNumber?: string | null
}): Promise<void> {
  // Internal admin notification, transactional (admin cannot unsubscribe).
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Document Uploaded: ${params.propertyAddress}`),
    transactional: true,
    html: renderDocumentUploadedEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      documentType: params.documentType,
      fileName: params.fileName,
      uploaderRole: params.uploaderRole,
      uploaderName: params.uploaderName,
      dealNumber: params.dealNumber,
    }),
  })
}

// ============================================================================
// Email: Closing Date Alert → Admin (daily digest)
// ============================================================================

/**
 * PURE renderer for the admin "Closing Date Alert" daily digest. Synchronous,
 * no I/O, admin-only (no branding). Two dynamic tables in renderInvoiceEmail's
 * statement language: an OVERDUE table under a danger section heading (the old
 * siren emoji is removed; urgency is carried by the red heading + red Timeline
 * cells) and an APPROACHING table under a warning section heading. Each section
 * renders only when it has rows, exactly as before. Property cells keep their
 * deep links (red for overdue, green for approaching). Internal ops, so no
 * preheader and no fallback shelf. CTA targets the admin dashboard.
 */
export function renderClosingDateAlertDigestEmail(params: {
  approachingDeals: { id: string; property_address: string; closing_date: string; days_until_closing: number; advance_amount: number; agent_name: string; status: string }[]
  overdueDeals: { id: string; property_address: string; closing_date: string; days_overdue: number; advance_amount: number; agent_name: string; status: string }[]
}): string {
  const dashboardUrl = `${APP_URL}/admin`

  const tableHeader = `<tr>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Property</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Timeline</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Agent</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:right;">Advance</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Status</th>
                          </tr>`

  const overdueRows = params.overdueDeals.map(d => `<tr>
                            <td style="padding:11px 16px; font-size:13px; line-height:1.4; border-top:1px solid #232323;">
                              <a href="${APP_URL}/admin/deals/${d.id}" style="color:#F08C8C; text-decoration:none; font-weight:600;">${escapeHtml(d.property_address ?? '')}</a>
                            </td>
                            <td style="padding:11px 16px; color:#F08C8C; font-size:13px; font-weight:600; line-height:1.4; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(String(d.days_overdue))} days overdue</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323;">${escapeHtml(d.agent_name ?? '')}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; text-align:right; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(formatCurrency(d.advance_amount))}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323; text-transform:capitalize;">${escapeHtml((d.status ?? '').replace(/_/g, ' '))}</td>
                          </tr>`).join('\n                          ')

  const approachingRows = params.approachingDeals.map(d => `<tr>
                            <td style="padding:11px 16px; font-size:13px; line-height:1.4; border-top:1px solid #232323;">
                              <a href="${APP_URL}/admin/deals/${d.id}" style="color:#6FB783; text-decoration:none; font-weight:600;">${escapeHtml(d.property_address ?? '')}</a>
                            </td>
                            <td style="padding:11px 16px; color:#E0B15A; font-size:13px; font-weight:600; line-height:1.4; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(String(d.days_until_closing))} days</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323;">${escapeHtml(d.agent_name ?? '')}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; text-align:right; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(formatCurrency(d.advance_amount))}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323; text-transform:capitalize;">${escapeHtml((d.status ?? '').replace(/_/g, ' '))}</td>
                          </tr>`).join('\n                          ')

  let sections = ''

  if (params.overdueDeals.length > 0) {
    sections += `<p style="margin:0 0 12px; color:#F08C8C; font-size:13px; font-weight:700; line-height:1.3; letter-spacing:0.08em; text-transform:uppercase;">${escapeHtml(String(params.overdueDeals.length))} overdue deal${params.overdueDeals.length !== 1 ? 's' : ''}</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px; background:#1C1C1C; border:1px solid #582A2A; border-radius:12px; overflow:hidden;">
                          ${tableHeader}
                          ${overdueRows}
                        </table>`
  }

  if (params.approachingDeals.length > 0) {
    sections += `<p style="margin:0 0 12px; color:#E0B15A; font-size:13px; font-weight:700; line-height:1.3; letter-spacing:0.08em; text-transform:uppercase;">${escapeHtml(String(params.approachingDeals.length))} approaching closing${params.approachingDeals.length !== 1 ? 's' : ''} (within 7 days)</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px; background:#1C1C1C; border:1px solid #2A2A2A; border-radius:12px; overflow:hidden;">
                          ${tableHeader}
                          ${approachingRows}
                        </table>`
  }

  const body = `${emailKicker('Closing alerts')}

                    ${emailHeadline('Closing date alert.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Here is your daily closing-date digest: deals that are overdue to close and deals approaching their closing date.
                    </p>

                    ${sections}${emailButton('Open Dashboard', dashboardUrl)}`

  return wrap(body)
}

export async function sendClosingDateAlertDigest(params: {
  approachingDeals: { id: string; property_address: string; closing_date: string; days_until_closing: number; advance_amount: number; agent_name: string; status: string }[]
  overdueDeals: { id: string; property_address: string; closing_date: string; days_overdue: number; advance_amount: number; agent_name: string; status: string }[]
}): Promise<void> {
  if (params.approachingDeals.length === 0 && params.overdueDeals.length === 0) return

  // Internal admin digest: transactional (admin cannot unsubscribe).
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`Closing Date Alert: ${params.overdueDeals.length} overdue, ${params.approachingDeals.length} approaching`),
    transactional: true,
    html: renderClosingDateAlertDigestEmail({
      approachingDeals: params.approachingDeals,
      overdueDeals: params.overdueDeals,
    }),
  })
}

// ============================================================================
// 8. KYC Mobile Upload Link
// ============================================================================

/**
 * PURE renderer for the agent "Upload Your ID from your phone" notification.
 * Synchronous, no I/O. This email previously built plain HTML; it is rebuilt onto
 * wrap() + helpers to mirror renderAgentInviteEmail: kicker, headline, a short
 * lead, the hero CTA to the secure upload page, and a trailing centered note that
 * keeps the "expires in N minutes / single use" line plus the safe-to-ignore
 * line. Carries branding through to wrap(), plus a preheader and the fallback
 * shelf for the upload link.
 */
export function renderKycMobileUploadEmail(params: {
  agentFirstName: string
  uploadUrl: string
  expiresInMinutes: number
  branding?: BrokerageBranding | null
}): string {
  const body = `${emailKicker('ID upload')}

                    ${emailHeadline('Upload your ID.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(params.agentFirstName ?? '')}, you requested to upload your government-issued photo ID from your mobile device. Tap the button below to open the secure upload page.
                    </p>

                    ${emailButton('Upload My ID', params.uploadUrl)}

                    <p style="margin:16px 0 0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55; text-align:center;">
                      This link expires in ${params.expiresInMinutes} minutes and can only be used once. If you didn&rsquo;t request this, you can safely ignore this email.
                    </p>`

  const preheader = `Open the secure page to upload your ID. Expires in ${params.expiresInMinutes} minutes.`

  return wrap(body, params.branding, preheader, emailFallbackLink(params.uploadUrl))
}

export async function sendKycMobileUploadLink(params: {
  agentEmail: string
  agentFirstName: string
  uploadUrl: string
  expiresInMinutes: number
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}) {
  // KYC/identity verification is a regulatory/legal email, transactional so
  // it bypasses the recipient's preference flag.
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject('Firm Funds: Upload Your ID From Your Phone'),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: renderKycMobileUploadEmail({
      agentFirstName: params.agentFirstName,
      uploadUrl: params.uploadUrl,
      expiresInMinutes: params.expiresInMinutes,
      branding,
    }),
  })
}

// ============================================================================
// 9. KYC Approved → Agent
// ============================================================================

/**
 * PURE renderer for the agent "Identity Verified" (KYC approved) notification.
 * Synchronous, no I/O. Mirrors renderAgentInviteEmail: kicker, headline, lead, a
 * success callout confirming the ID check (the old green-checkmark glyph is
 * dropped and conveyed by the success tone instead), the "what you can do now"
 * list as a clean styled <ul> preserving every bullet, then the hero CTA. Carries
 * branding through to wrap(), plus a preheader and the fallback shelf for the
 * dashboard CTA.
 */
export function renderKycApprovedEmail(params: {
  agentFirstName: string
  branding?: BrokerageBranding | null
}): string {
  const dashboardUrl = `${APP_URL}/agent`

  const body = `${emailKicker('Account active')}

                    ${emailHeadline('Identity verified.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(params.agentFirstName ?? '')}, your government-issued ID has been verified successfully. Your account is now fully active.
                    </p>

                    ${emailCallout({ tone: 'success', title: "You're all set", body: 'Your ID check is complete and your account is now fully active.' })}

                    <p style="margin:0 0 10px; color:#F5F5F4; font-size:15px; font-weight:600; line-height:1.4;">What you can do now</p>
                    <ul style="margin:0 0 30px; padding-left:20px; color:#D6D6D4; font-size:15px; line-height:1.7;">
                      <li style="margin:0 0 6px;">Submit commission advance requests</li>
                      <li style="margin:0 0 6px;">Track your deal status in real time</li>
                      <li style="margin:0 0 6px;">Get funded before your deals close</li>
                    </ul>

                    ${emailButton('Go to My Dashboard', dashboardUrl)}`

  const preheader = `Your ID is verified. Your Firm Funds account is now fully active.`

  return wrap(body, params.branding, preheader, emailFallbackLink(dashboardUrl))
}

export async function sendKycApprovedNotification(params: {
  agentEmail: string
  agentFirstName: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}): Promise<void> {
  // KYC approval is a regulatory/legal notice: transactional.
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`You're Verified: Start Submitting Advances on Firm Funds!`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: renderKycApprovedEmail({
      agentFirstName: params.agentFirstName,
      branding,
    }),
  })
}

// ============================================================================
// Email: Document Returned → Agent
// ============================================================================

/**
 * PURE renderer for the agent "Document Returned" notification. Synchronous,
 * no I/O. Mirrors renderAgentInviteEmail: kicker, headline, lead, a details card
 * (Deal Number when present, Property, Document), a danger callout carrying the
 * return reason, then the hero CTA. Urgency is conveyed by the danger callout,
 * not a red button (the CTA is the standard green emailButton). Carries branding
 * through to wrap(), plus a preheader and the fallback shelf for the deep link.
 */
export function renderDocumentReturnEmail(params: {
  dealId: string
  propertyAddress: string
  agentFirstName: string
  documentName: string
  reason: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const fixUrl = `${APP_URL}/agent/deals/${params.dealId}#returned-docs`

  const body = `${emailKicker('Action required')}

                    ${emailHeadline('Document returned.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(params.agentFirstName ?? '')}, a document for your deal has been returned and needs attention. This may cause delays in processing your advance.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'Document', value: params.documentName ?? '' },
                    ])}

                    ${emailCallout({ tone: 'danger', title: 'Reason for return', body: escapeHtml(params.reason ?? '') })}${emailButton('View & Fix Document', fixUrl)}`

  const preheader = `A document for ${params.propertyAddress ?? ''} was returned and needs attention.`

  return wrap(body, params.branding, preheader, emailFallbackLink(fixUrl))
}

export async function sendDocumentReturnNotification(params: {
  dealId: string
  propertyAddress: string
  agentEmail: string
  agentFirstName: string
  documentName: string
  documentType: string
  reason: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
  dealNumber?: string | null
}): Promise<void> {
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Action Required: Document Returned for ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: renderDocumentReturnEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      agentFirstName: params.agentFirstName,
      documentName: params.documentName,
      reason: params.reason,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Email: Deal Message → Agent
// ============================================================================

/**
 * PURE renderer for the agent "New Message" (deal thread) notification.
 * Synchronous, no I/O. Mirrors renderAgentInviteEmail: kicker, headline, lead, a
 * details card (Deal Number when present, Property, From), the quoted message in
 * a neutral callout (pre-wrap so line breaks survive), then the hero CTA. Carries
 * branding through to wrap(), plus a preheader and the fallback shelf for the
 * deep link.
 */
export function renderDealMessageEmail(params: {
  dealId: string
  propertyAddress: string
  agentFirstName: string
  message: string
  senderName: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const replyUrl = `${APP_URL}/agent/deals/${params.dealId}#messages`

  const body = `${emailKicker('New message')}

                    ${emailHeadline('New message.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(params.agentFirstName)}, you have a new message regarding your deal.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'From', value: params.senderName ?? '' },
                    ])}

                    ${emailCallout({ tone: 'neutral', title: 'Message', body: `<span style="white-space:pre-wrap;">${escapeHtml(params.message)}</span>` })}${emailButton('Reply', replyUrl)}`

  const preheader = `New message from ${params.senderName ?? ''} about ${params.propertyAddress ?? ''}.`

  return wrap(body, params.branding, preheader, emailFallbackLink(replyUrl))
}

export async function sendDealMessageNotification(params: {
  dealId: string
  propertyAddress: string
  agentEmail: string
  agentFirstName: string
  message: string
  senderName: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
  dealNumber?: string | null
}): Promise<void> {
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    replyTo: 'support@firmfunds.ca',
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Message from Firm Funds: ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: renderDealMessageEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      agentFirstName: params.agentFirstName,
      message: params.message,
      senderName: params.senderName,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Email: Invoice → Agent
// ============================================================================

/**
 * PURE renderer for the agent "Invoice" notification. Synchronous, no I/O.
 * Mirrors renderAgentInviteEmail: kicker, headline, lead, a summary details card
 * (Invoice #, Amount Due in green, Due Date), then, when line items exist, a
 * brand-green statement table that preserves every line (description + formatted
 * amount) plus a Total row, a trailing remittance note, and the hero CTA. The
 * old gold/amber invoice theme is retired in favor of brand green. The send fn
 * owns the date formatting and reshapes the line items (it passes the display
 * dueDate string and the { description, amount } rows in); the renderer builds
 * the row HTML. Carries branding through to wrap(), plus a preheader and the
 * fallback shelf for the account CTA.
 */
export function renderInvoiceEmail(params: {
  invoiceNumber: string
  agentName: string
  amountDue: number
  dueDate: string
  lineItems: { description: string; amount: number }[]
  branding?: BrokerageBranding | null
}): string {
  const accountUrl = `${APP_URL}/agent`
  const amountDueStr = formatCurrency(params.amountDue)

  const lineItemsHtml = params.lineItems
    .map(
      (item) => `<tr>
                              <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323;">${escapeHtml(item.description ?? '')}</td>
                              <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; text-align:right; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(formatCurrency(item.amount))}</td>
                            </tr>`
    )
    .join('\n                            ')

  const statementTable = params.lineItems.length > 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 30px; background:#1C1C1C; border:1px solid #2A2A2A; border-radius:12px; overflow:hidden;">
                          <tr>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Description</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:right;">Amount</th>
                          </tr>
                          ${lineItemsHtml}
                          <tr>
                            <td style="padding:13px 16px; color:#6FB783; font-size:14px; font-weight:700; border-top:1px solid #2A2A2A; background:#10271A;">Total</td>
                            <td style="padding:13px 16px; color:#6FB783; font-size:14px; font-weight:700; text-align:right; border-top:1px solid #2A2A2A; background:#10271A; white-space:nowrap;">${escapeHtml(amountDueStr)}</td>
                          </tr>
                        </table>`
    : ''

  const body = `${emailKicker('Invoice')}

                    ${emailHeadline(`Invoice ${params.invoiceNumber ?? ''}.`)}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(params.agentName ?? '')}, please find your invoice below for outstanding charges on your Firm Funds account.
                    </p>

                    ${emailDetailCard([
                      { label: 'Invoice #', value: params.invoiceNumber ?? '', strong: true },
                      { label: 'Amount Due', value: amountDueStr, valueColor: '#6FB783', strong: true },
                      { label: 'Due Date', value: params.dueDate ?? '' },
                    ])}

                    ${statementTable}

                    <p style="margin:0 0 30px; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55;">
                      Please remit payment at your earliest convenience. If you have questions about this invoice, reply to this email or contact us at support@firmfunds.ca.
                    </p>

                    ${emailButton('View My Account', accountUrl)}`

  const preheader = `Invoice ${params.invoiceNumber ?? ''}: ${amountDueStr} due ${params.dueDate ?? ''}.`

  return wrap(body, params.branding, preheader, emailFallbackLink(accountUrl))
}

export async function sendInvoiceNotification(params: {
  invoiceNumber: string
  agentName: string
  agentEmail: string
  amount: number
  dueDate: string
  lineItems: { description: string; amount: number; date: string }[]
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}): Promise<void> {
  const formatMoney = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
  const formatDateStr = (d: string) => new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })

  // Invoices are billing/legal documents: transactional, must bypass the
  // recipient's promotional opt-out.
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Invoice ${params.invoiceNumber}: ${formatMoney(params.amount)} Due`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: renderInvoiceEmail({
      invoiceNumber: params.invoiceNumber,
      agentName: params.agentName,
      amountDue: params.amount,
      dueDate: formatDateStr(params.dueDate),
      lineItems: params.lineItems.map((item) => ({ description: item.description, amount: item.amount })),
      branding,
    }),
  })
}

// ============================================================================
// Brokerage message notification: sent to admin when brokerage sends a message
// ============================================================================

/**
 * PURE renderer for the admin "New Message from Brokerage" notification.
 * Synchronous, no I/O. Mirrors renderAgentInviteEmail: kicker, headline, lead, a
 * details card (Deal Number when present, Property, From) carrying the context
 * the original lead sentence held, the quoted message in a neutral callout
 * (pre-wrap so line breaks survive), then the hero CTA. Admin-only, so no
 * branding; carries a preheader and the fallback shelf for the deep link.
 */
export function renderBrokerageMessageEmail(params: {
  dealId: string
  propertyAddress: string
  senderName: string
  message: string
  dealNumber?: string | null
}): string {
  const replyUrl = `${APP_URL}/admin/deals/${params.dealId}#messages`

  const body = `${emailKicker('New message')}

                    ${emailHeadline('New message from brokerage.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${escapeHtml(params.senderName)} sent a message about ${escapeHtml(params.propertyAddress)}.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'From', value: params.senderName ?? '' },
                    ])}

                    ${emailCallout({ tone: 'neutral', title: 'Message', body: `<span style="white-space:pre-wrap;">${escapeHtml(params.message)}</span>` })}${emailButton('View Deal & Reply', replyUrl)}`

  const preheader = `${params.senderName ?? ''} messaged about ${params.propertyAddress ?? ''}.`

  return wrap(body, null, preheader, emailFallbackLink(replyUrl))
}

export async function sendBrokerageMessageNotification(params: {
  dealId: string
  propertyAddress: string
  senderName: string
  message: string
  dealNumber?: string | null
}) {
  // Internal admin notification: transactional.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Brokerage message: ${params.propertyAddress}`),
    transactional: true,
    html: renderBrokerageMessageEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      senderName: params.senderName,
      message: params.message,
      dealNumber: params.dealNumber,
    }),
  })
}

// ============================================================================
// Brokerage deal status notification: sent to brokerage when deal status changes
// ============================================================================

/**
 * PURE renderer for the brokerage "Deal Status Update" notification. Synchronous,
 * no I/O. Mirrors renderAgentInviteEmail: kicker, headline, lead, then a details
 * card (Deal Number when present, Property, Agent, New Status) and the hero CTA.
 * Preserves this email's OWN status label/color maps: the New Status row is shown
 * strong in that map's color, the card-row equivalent of the original status pill.
 * Carries branding through to wrap(), plus a preheader and the fallback shelf for
 * the Brokerage Portal CTA.
 */
export function renderBrokerageStatusEmail(params: {
  propertyAddress: string
  agentName: string
  newStatus: string
  dealId: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const statusLabels: Record<string, string> = {
    under_review: 'Under Review',
    approved: 'Approved',
    funded: 'Funded',
    completed: 'Completed',
    denied: 'Denied',
    cancelled: 'Cancelled',
  }
  const statusColors: Record<string, string> = {
    under_review: '#D4A04A',
    approved: '#5FA873',
    funded: '#57BE73',
    completed: '#5FB8A0',
    denied: '#EF4444',
    cancelled: '#9CA3AF',
  }

  const label = statusLabels[params.newStatus] || params.newStatus
  const color = statusColors[params.newStatus] || '#D4A04A'
  const portalUrl = `${APP_URL}/brokerage`

  const body = `${emailKicker('Deal update')}

                    ${emailHeadline('Deal status update.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      A deal submitted by one of your agents has been updated.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'Agent', value: params.agentName ?? '' },
                      { label: 'New Status', value: label, valueColor: color, strong: true },
                    ])}

                    ${emailButton('View in Brokerage Portal', portalUrl)}`

  const preheader = `${params.propertyAddress ?? ''} is now ${label}.`

  return wrap(body, params.branding, preheader, emailFallbackLink(portalUrl))
}

export async function sendBrokerageStatusNotification(params: {
  brokerageEmail: string
  brokerageName: string
  propertyAddress: string
  agentName: string
  newStatus: string
  dealId: string
  /** Pass-through for per-brokerage unsubscribe handling (migration 092). */
  brokerageId?: string | null
  dealNumber?: string | null
}) {
  const statusLabels: Record<string, string> = {
    under_review: 'Under Review',
    approved: 'Approved',
    funded: 'Funded',
    completed: 'Completed',
    denied: 'Denied',
    cancelled: 'Cancelled',
  }

  const label = statusLabels[params.newStatus] || params.newStatus

  const branding = await getBrandingForBrokerage(params.brokerageId)
  await sendEmailWithUnsubscribe({
    to: params.brokerageEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Deal ${label}: ${params.propertyAddress}`),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    html: renderBrokerageStatusEmail({
      propertyAddress: params.propertyAddress,
      agentName: params.agentName,
      newStatus: params.newStatus,
      dealId: params.dealId,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Brokerage Admin Invite Email
// ============================================================================

/**
 * PURE renderer for the brokerage-admin onboarding invite. Synchronous, no I/O.
 * Mirrors renderAgentInviteEmail (the Welcome email): kicker, headline, lead, a
 * details card (Brokerage, Email), the hero CTA, and a trailing expiry note.
 * Carries a preheader and the fallback shelf for the unique invite link, and
 * takes the resolved brokerage branding the send fn passes through.
 */
export function renderBrokerageInviteEmail(params: {
  adminName: string
  brokerageName: string
  adminEmail: string
  inviteUrl: string
  branding?: BrokerageBranding | null
}): string {
  const adminName = escapeHtml(params.adminName ?? '')
  const brokerage = escapeHtml(params.brokerageName ?? '')

  const body = `${emailKicker('Account setup')}

                    ${emailHeadline('Welcome to Firm Funds.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${adminName}, your Firm Funds Brokerage Portal account has been created for ${brokerage}. You can now manage your agents&rsquo; commission advance activity online. Set your password to activate it.
                    </p>

                    ${emailDetailCard([
                      { label: 'Brokerage', value: params.brokerageName ?? '' },
                      { label: 'Email', value: params.adminEmail ?? '' },
                    ])}

                    ${emailButton('Set Up My Account', params.inviteUrl)}

                    <p style="margin:16px 0 0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55; text-align:center;">
                      This link expires in 72 hours.
                    </p>`

  const preheader = `Your ${params.brokerageName ?? ''} brokerage portal is ready. Set your password to get started.`

  return wrap(body, params.branding, preheader, emailFallbackLink(params.inviteUrl))
}

export async function sendBrokerageInviteNotification(params: {
  adminName: string
  adminEmail: string
  brokerageName: string
  inviteToken: string
  /** Pass-through for per-brokerage unsubscribe handling (migration 092). */
  brokerageId?: string | null
}): Promise<void> {
  const inviteUrl = `${APP_URL}/invite/${params.inviteToken}`

  // Account-setup email: transactional, recipient cannot opt out of getting
  // invited.
  const branding = await getBrandingForBrokerage(params.brokerageId)
  await sendEmailWithUnsubscribe({
    to: params.adminEmail,
    subject: sanitizeSubject(`Welcome to Firm Funds: Set Up Your Brokerage Portal`),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    transactional: true,
    html: renderBrokerageInviteEmail({
      adminName: params.adminName,
      brokerageName: params.brokerageName,
      adminEmail: params.adminEmail,
      inviteUrl,
      branding,
    }),
  })
}

// ============================================================================
// Password Reset Email (admin-triggered)
// ============================================================================

/**
 * PURE renderer for the admin-triggered password reset. Synchronous, no I/O.
 * Mirrors renderAgentInviteEmail: kicker, headline, lead, the hero CTA, and a
 * trailing note carrying the original "expires / if you didn't request this"
 * copy. Carries a preheader and the fallback shelf for the unique reset link,
 * and takes the resolved branding the send fn passes through.
 */
export function renderPasswordResetEmail(params: {
  recipientName: string
  resetUrl: string
  branding?: BrokerageBranding | null
}): string {
  const recipientName = escapeHtml(params.recipientName ?? '')

  const body = `${emailKicker('Password reset')}

                    ${emailHeadline('Reset your password.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${recipientName}, a Firm Funds administrator has reset your password. Use the button below to set a new one.
                    </p>

                    ${emailButton('Set New Password', params.resetUrl)}

                    <p style="margin:16px 0 0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55; text-align:center;">
                      This link expires in 72 hours. If you did not request this, please contact your administrator.
                    </p>`

  const preheader = 'A Firm Funds administrator reset your password. Set a new one to sign in.'

  return wrap(body, params.branding, preheader, emailFallbackLink(params.resetUrl))
}

export async function sendPasswordResetNotification(params: {
  recipientName: string
  recipientEmail: string
  inviteToken: string
  roleName: string // e.g. "Agent" or "Brokerage Admin"
  /** Optional: when known, used to render the brokerage's logo in the header. Migration 096. */
  brokerageId?: string | null
  /** Optional: when known, used to render the brokerage's logo in the header. Migration 096. */
  agentId?: string | null
}): Promise<void> {
  const resetUrl = `${APP_URL}/invite/${params.inviteToken}`

  // Password resets are security-critical: transactional. We do not attach
  // an entity here because the same reset flow services both agents and
  // brokerage admins and the caller doesn't necessarily know which.
  const branding = await getBrandingForBrokerage(params.brokerageId) || await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.recipientEmail,
    subject: sanitizeSubject(`Firm Funds: Password Reset`),
    transactional: true,
    html: renderPasswordResetEmail({
      recipientName: params.recipientName,
      resetUrl,
      branding,
    }),
  })
}

// ============================================================================
// Email Change Notification
// ============================================================================

/**
 * PURE renderer for the "login email changed" security notice (sent to the OLD
 * address). Synchronous, no I/O. Security-only, so NO button and NO fallback
 * shelf. Kicker, headline, lead, a details card (Old Email in red, New Email in
 * green), then a danger callout carrying the "if you did not request this"
 * line. Takes the resolved branding the send fn passes through.
 */
export function renderEmailChangeEmail(params: {
  recipientName: string
  oldEmail: string
  newEmail: string
  branding?: BrokerageBranding | null
}): string {
  const recipientName = escapeHtml(params.recipientName ?? '')

  const body = `${emailKicker('Security alert')}

                    ${emailHeadline('Your login email changed.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${recipientName}, your Firm Funds login email has been changed by an administrator. Please use your new email address to sign in going forward.
                    </p>

                    ${emailDetailCard([
                      { label: 'Old Email', value: params.oldEmail ?? '', valueColor: '#F08C8C' },
                      { label: 'New Email', value: params.newEmail ?? '', valueColor: '#6FB783' },
                    ])}

                    ${emailCallout({
                      tone: 'danger',
                      title: 'Did not expect this?',
                      body: `If you did not request this change, contact Firm Funds immediately at <a href="mailto:${escapeHtml(ADMIN_EMAIL)}" style="color:#F08C8C; text-decoration:underline;">${escapeHtml(ADMIN_EMAIL)}</a>.`,
                    })}`

  const preheader = 'Your Firm Funds login email was changed by an administrator.'

  return wrap(body, params.branding, preheader)
}

export async function sendEmailChangeNotification(params: {
  recipientName: string
  oldEmail: string
  newEmail: string
  /** Optional: when known, used to render the brokerage's logo in the header. Migration 096. */
  brokerageId?: string | null
  /** Optional: when known, used to render the brokerage's logo in the header. Migration 096. */
  agentId?: string | null
}): Promise<void> {
  // Security notification to the OLD email: transactional, no preference
  // check (we never want to suppress a "your account changed" warning).
  const branding = await getBrandingForBrokerage(params.brokerageId) || await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.oldEmail,
    subject: sanitizeSubject(`Firm Funds: Your Login Email Has Been Changed`),
    transactional: true,
    html: renderEmailChangeEmail({
      recipientName: params.recipientName,
      oldEmail: params.oldEmail,
      newEmail: params.newEmail,
      branding,
    }),
  })
}

// ============================================================================
// Agent Phone Number Changed (finding #43 follow-up)
// ============================================================================
//
// Sent to the agent's verified Firm Funds email whenever their on-file phone
// changes. The full numbers are masked to the last 4 digits so the email is
// useful for detecting tampering without re-leaking the PII back to whichever
// inbox the email lands in (forwarded mail, mailing lists, etc).

/**
 * PURE renderer for the "phone number updated" security notice. Synchronous, no
 * I/O. Security-only, so NO button and NO fallback shelf. Kicker, headline,
 * lead, a details card (Previous masked last-4 in red, Updated To masked last-4
 * in green, When), then a danger callout carrying the "if this wasn't you"
 * line. The masked displays and the When timestamp are computed by the send fn
 * exactly as before and passed in. Takes the resolved agent branding.
 */
export function renderAgentPhoneChangedEmail(params: {
  recipientName: string
  oldDisplay: string
  newDisplay: string
  whenDisplay: string
  branding?: BrokerageBranding | null
}): string {
  const recipientName = escapeHtml(params.recipientName ?? '')

  const body = `${emailKicker('Security alert')}

                    ${emailHeadline('Your phone number was updated.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${recipientName}, the phone number on your Firm Funds agent profile was just updated.
                    </p>

                    ${emailDetailCard([
                      { label: 'Previous', value: params.oldDisplay, valueColor: '#F08C8C' },
                      { label: 'Updated To', value: params.newDisplay, valueColor: '#6FB783' },
                      { label: 'When', value: params.whenDisplay },
                    ])}

                    ${emailCallout({
                      tone: 'danger',
                      title: 'Was this you?',
                      body: `If you didn&rsquo;t make this change, sign in, reset your password, and contact Firm Funds support at <a href="mailto:${escapeHtml(ADMIN_EMAIL)}" style="color:#F08C8C; text-decoration:underline;">${escapeHtml(ADMIN_EMAIL)}</a>. Your session may be compromised.`,
                    })}`

  const preheader = 'The phone number on your Firm Funds profile was just updated.'

  return wrap(body, params.branding, preheader)
}

export async function sendAgentPhoneChangedNotification(params: {
  recipientEmail: string
  recipientName: string
  oldPhoneLast4: string | null
  newPhoneLast4: string | null
  changedAtIso: string
  /** Optional: when known, used to render the brokerage's logo in the header. Migration 096. */
  agentId?: string | null
}): Promise<void> {
  const oldDisplay = params.oldPhoneLast4 ? `*** *** ${params.oldPhoneLast4}` : 'not on file'
  const newDisplay = params.newPhoneLast4 ? `*** *** ${params.newPhoneLast4}` : 'cleared'

  // Security warning: transactional. Recipient must NOT be able to silence
  // these by unsubscribing.
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.recipientEmail,
    subject: sanitizeSubject('Your Firm Funds phone number was updated'),
    transactional: true,
    html: renderAgentPhoneChangedEmail({
      recipientName: params.recipientName,
      oldDisplay,
      newDisplay,
      whenDisplay: new Date(params.changedAtIso).toUTCString(),
      branding,
    }),
  })
}

// ============================================================================
// Brokerage Contact Email Confirm-New-Address (finding #40 follow-up)
// ============================================================================
//
// Sent to the NEW address requested by a brokerage admin. The confirmation
// URL carries a single-use token; clicking it flips brokerages.email.
// Until the recipient acts, the brokerage continues to receive notifications
// at the previously-verified address.

/**
 * PURE renderer for the "confirm your new contact email" message (sent to the
 * NEW address). Synchronous, no I/O. Mirrors renderAgentInviteEmail: kicker,
 * headline, lead, the hero CTA, and a trailing note carrying the expiry plus
 * the "if you didn't request this, ignore" copy. Carries a preheader and the
 * fallback shelf for the unique confirm link, and takes the resolved brokerage
 * branding the send fn passes through.
 */
export function renderBrokerageContactEmailConfirmEmail(params: {
  brokerageName: string
  newEmail: string
  confirmUrl: string
  expiresLabel: string
  branding?: BrokerageBranding | null
}): string {
  const brokerage = escapeHtml(params.brokerageName ?? '')
  const newEmail = escapeHtml(params.newEmail ?? '')
  const expiresLabel = escapeHtml(params.expiresLabel ?? '')

  const body = `${emailKicker('Confirm email')}

                    ${emailHeadline('Confirm your email.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      A Firm Funds administrator at ${brokerage} requested that this address (${newEmail}) become the brokerage&rsquo;s primary contact email. Use the button below to confirm.
                    </p>

                    ${emailButton('Confirm Email Change', params.confirmUrl)}

                    <p style="margin:16px 0 0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55; text-align:center;">
                      This link expires on ${expiresLabel}. If you didn&rsquo;t request this change, simply ignore this email and the brokerage&rsquo;s contact address will remain unchanged.
                    </p>`

  const preheader = `Confirm this address as the primary contact email for ${params.brokerageName ?? ''}.`

  return wrap(body, params.branding, preheader, emailFallbackLink(params.confirmUrl))
}

export async function sendBrokerageContactEmailConfirm(params: {
  brokerageName: string
  newEmail: string
  confirmUrl: string
  expiresAtIso: string
  /** Optional: when known, used to render the brokerage's logo in the header. Migration 096. */
  brokerageId?: string | null
}): Promise<void> {
  const expiresLabel = new Date(params.expiresAtIso).toUTCString()

  // Email address change confirmation: transactional. Note we do NOT mint a
  // brokerage unsubscribe token here because the recipient may not yet be
  // the brokerage's confirmed contact.
  const branding = await getBrandingForBrokerage(params.brokerageId)
  await sendEmailWithUnsubscribe({
    to: params.newEmail,
    subject: sanitizeSubject(`Confirm new contact email for ${params.brokerageName}`),
    transactional: true,
    html: renderBrokerageContactEmailConfirmEmail({
      brokerageName: params.brokerageName,
      newEmail: params.newEmail,
      confirmUrl: params.confirmUrl,
      expiresLabel,
      branding,
    }),
  })
}

// ============================================================================
// Brokerage Contact Email Change-Requested Warning (to OLD address)
// ============================================================================
//
// Fires immediately when an admin requests the change, BEFORE the new address
// confirms. Gives the legitimate owner early warning of a possible stolen
// session even though the actual flip hasn't happened yet.

/**
 * PURE renderer for the "contact email change requested" security warning (sent
 * to the OLD address, before the new one confirms). Synchronous, no I/O.
 * Security-only, so NO button and NO fallback shelf. Kicker, headline, lead, a
 * details card (Current Email, Requested Email in green, Action Expires), the
 * "only takes effect once confirmed" reassurance line, then a danger callout
 * carrying the "if you didn't request this" copy. Takes the resolved brokerage
 * branding the send fn passes through.
 */
export function renderBrokerageContactEmailChangeRequestedEmail(params: {
  brokerageName: string
  oldEmail: string
  newEmail: string
  expiresLabel: string
  branding?: BrokerageBranding | null
}): string {
  const brokerage = escapeHtml(params.brokerageName ?? '')

  const body = `${emailKicker('Security alert')}

                    ${emailHeadline('Contact email change requested.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      A request was made to change the contact email for ${brokerage}. The change will only take effect once someone at the requested address clicks the confirmation link in their inbox. Your current address will keep receiving all brokerage notifications until then.
                    </p>

                    ${emailDetailCard([
                      { label: 'Current Email', value: params.oldEmail ?? '' },
                      { label: 'Requested Email', value: params.newEmail ?? '', valueColor: '#6FB783' },
                      { label: 'Action Expires', value: params.expiresLabel ?? '' },
                    ])}

                    ${emailCallout({
                      tone: 'danger',
                      title: 'Did not request this?',
                      body: `If you didn&rsquo;t request this change, sign in immediately, change your password, and contact Firm Funds support at <a href="mailto:${escapeHtml(ADMIN_EMAIL)}" style="color:#F08C8C; text-decoration:underline;">${escapeHtml(ADMIN_EMAIL)}</a>. Your administrator session may be compromised.`,
                    })}`

  const preheader = `A request was made to change the contact email for ${params.brokerageName ?? ''}.`

  return wrap(body, params.branding, preheader)
}

export async function sendBrokerageContactEmailChangeRequested(params: {
  brokerageName: string
  oldEmail: string
  newEmail: string
  expiresAtIso: string
  /** Optional: when known, used to render the brokerage's logo in the header. Migration 096. */
  brokerageId?: string | null
}): Promise<void> {
  const expiresLabel = new Date(params.expiresAtIso).toUTCString()

  // Security warning to the OLD email: transactional, no preference check.
  const branding = await getBrandingForBrokerage(params.brokerageId)
  await sendEmailWithUnsubscribe({
    to: params.oldEmail,
    subject: sanitizeSubject(`Contact email change requested for ${params.brokerageName}`),
    transactional: true,
    html: renderBrokerageContactEmailChangeRequestedEmail({
      brokerageName: params.brokerageName,
      oldEmail: params.oldEmail,
      newEmail: params.newEmail,
      expiresLabel,
      branding,
    }),
  })
}

// ============================================================================
// Banking Submission Notification (to Admin)
// ============================================================================

/**
 * PURE renderer for the admin "banking info submitted" notification.
 * Synchronous, no I/O. Mirrors renderAgentInviteEmail: kicker, headline, lead,
 * the hero CTA to the admin review page. Admin-only, so no branding and no
 * fallback shelf (the CTA is a stable internal page, not a unique action link);
 * carries a preheader. The agent name + email are interpolated into the lead
 * exactly as before.
 */
export function renderBankingSubmittedEmail(params: {
  agentName: string
  agentEmail: string
}): string {
  const agentName = escapeHtml(params.agentName ?? '')
  const agentEmail = escapeHtml(params.agentEmail ?? '')

  const body = `${emailKicker('Banking')}

                    ${emailHeadline('Banking info submitted.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${agentName} (${agentEmail}) has submitted their banking information for review and approval.
                    </p>

                    ${emailButton('Review Banking Info', `${APP_URL}/admin`)}`

  const preheader = `${params.agentName ?? ''} submitted banking information for review.`

  return wrap(body, null, preheader)
}

export async function sendBankingSubmittedNotification(params: {
  agentName: string
  agentEmail: string
}) {
  // Internal admin notification: transactional.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`Banking Info Submitted: ${params.agentName}`),
    transactional: true,
    html: renderBankingSubmittedEmail({
      agentName: params.agentName,
      agentEmail: params.agentEmail,
    }),
  })
}

// ============================================================================
// Banking Approval/Rejection Notification (to Agent)
// ============================================================================

/**
 * PURE renderer for the agent "banking approved / action required" notice.
 * Synchronous, no I/O. Conditional on `approved`: the APPROVED branch is a
 * success callout confirming verification, with NO button (mirrors the
 * original). The REJECTED branch is a danger callout (carrying the optional
 * reason only when present), a "please update and resubmit" line, and the
 * "Update Banking Info" CTA. No fallback shelf either way (the CTA targets a
 * stable internal page, not a unique action link). Takes the resolved agent
 * branding the send fn passes through.
 */
export function renderBankingApprovalEmail(params: {
  agentName: string
  approved: boolean
  reason?: string
  branding?: BrokerageBranding | null
}): string {
  const agentName = escapeHtml(params.agentName ?? '')

  const body = params.approved
    ? `${emailKicker('Banking')}

                    ${emailHeadline('Banking info approved.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${agentName}, your banking information has been verified and approved.
                    </p>

                    ${emailCallout({
                      tone: 'success',
                      title: 'You are all set',
                      body: `Your banking details are verified, so you&rsquo;re all set to receive commission advances.`,
                    })}`
    : `${emailKicker('Banking')}

                    ${emailHeadline('Action required.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${agentName}, your banking information could not be approved at this time. Please update your banking information and resubmit.
                    </p>

                    ${emailCallout({
                      tone: 'danger',
                      title: 'Banking info not approved',
                      body: params.reason
                        ? `<strong style="color:#F08C8C;">Reason:</strong> ${escapeHtml(params.reason)}`
                        : `Your banking information could not be approved at this time. Update your details and resubmit to continue.`,
                    })}

                    ${emailButton('Update Banking Info', `${APP_URL}/agent/profile`)}`

  const preheader = params.approved
    ? 'Your banking information has been verified and approved.'
    : 'Your banking information needs an update before it can be approved.'

  return wrap(body, params.branding, preheader)
}

export async function sendBankingApprovalNotification(params: {
  agentEmail: string
  agentName: string
  approved: boolean
  reason?: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}) {
  const subject = params.approved
    ? 'Banking Info Approved'
    : 'Banking Info: Action Required'

  // Banking approval/rejection is an account-status notice: transactional.
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(subject),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: renderBankingApprovalEmail({
      agentName: params.agentName,
      approved: params.approved,
      reason: params.reason,
      branding,
    }),
  })
}

// ============================================================================
// Agent Message Notification (to Admin: agent sent a message)
// ============================================================================

/**
 * PURE renderer for the admin "New Message from Agent" notification.
 * Synchronous, no I/O. Mirrors renderAgentInviteEmail: kicker, headline, lead, a
 * details card (Deal Number when present, Property, From) carrying the context
 * the original lead sentence held, the quoted message in a neutral callout
 * (pre-wrap so line breaks survive), then the hero CTA. The original was NOT
 * monospaced (it used the default sans body font and only pre-wrap to keep line
 * breaks), so normal text in the callout is faithful. Admin-only, so no branding;
 * carries a preheader and the fallback shelf for the messages CTA.
 */
export function renderAgentMessageEmail(params: {
  propertyAddress: string
  agentName: string
  message: string
  dealNumber?: string | null
}): string {
  const replyUrl = `${APP_URL}/admin/messages`

  const body = `${emailKicker('New message')}

                    ${emailHeadline('New message from agent.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${escapeHtml(params.agentName)} sent a message about ${escapeHtml(params.propertyAddress)}.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'From', value: params.agentName ?? '' },
                    ])}

                    ${emailCallout({ tone: 'neutral', title: 'Message', body: `<span style="white-space:pre-wrap;">${escapeHtml(params.message)}</span>` })}${emailButton('View & Reply', replyUrl)}`

  const preheader = `${params.agentName ?? ''} messaged about ${params.propertyAddress ?? ''}.`

  return wrap(body, null, preheader, emailFallbackLink(replyUrl))
}

export async function sendAgentMessageNotification(params: {
  dealId: string
  propertyAddress: string
  agentName: string
  message: string
  dealNumber?: string | null
}) {
  // Internal admin notification: transactional.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Message from ${params.agentName}: ${params.propertyAddress}`),
    transactional: true,
    html: renderAgentMessageEmail({
      propertyAddress: params.propertyAddress,
      agentName: params.agentName,
      message: params.message,
      dealNumber: params.dealNumber,
    }),
  })
}

// ============================================================================
// Settlement Period Reminders (sent to both agent and brokerage)
// ============================================================================

interface SettlementReminderParams {
  dealId: string
  propertyAddress: string
  agentEmail: string
  agentFirstName: string
  brokerageEmail?: string | null
  brokerageName?: string
  advanceAmount: number
  dueDate: string // YYYY-MM-DD
  amountDueFromBrokerage: number
  daysRemaining: number // 14, 7, or 0 (closing day)
  /**
   * Days elapsed since the settlement due date. Only used by the
   * payment check-in variant (always positive, by definition the check-in
   * fires after the due date has passed). Closing-day variant ignores it.
   */
  daysSinceDue?: number
  /** Pass-through for per-entity unsubscribe handling (migration 092). */
  agentId?: string | null
  brokerageId?: string | null
  dealNumber?: string | null
}

function formatReminderDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
}

function formatReminderCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
}

/**
 * PURE renderer for the closing-day settlement reminder. ONE renderer covers
 * both recipients via `audience`, reproducing each variant's exact copy + link:
 *
 * - agent: greeting by first name, the closing-date-arrived + days-to-remit
 *   lead, a detail card (Deal Number when present, Amount Due as a green strong
 *   value), the Payment Due Date as an info callout, a late-interest caution as
 *   a warning callout, and a View Deal CTA into the agent deal page (with the
 *   fallback shelf).
 * - brokerage: the shorter "closing date for {property} ({agent}'s deal) has
 *   arrived" + please-remit-by-{date} copy, a detail card (Deal Number when
 *   present, Amount Due green strong), and NO callouts and NO button, exactly as
 *   the original brokerage variant.
 *
 * Both recipients share the brokerage's branding (passed in by the send fn).
 */
export function renderSettlementReminderClosingDayEmail(params: {
  audience: 'agent' | 'brokerage'
  dealId: string
  propertyAddress: string
  agentFirstName: string
  amountDueFromBrokerage: number
  dueDate: string
  daysRemaining: number
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const firstName = escapeHtml(params.agentFirstName ?? '')
  const property = escapeHtml(params.propertyAddress ?? '')
  const amount = formatReminderCurrency(params.amountDueFromBrokerage)
  const dueDateLabel = formatReminderDate(params.dueDate)
  const dealNumberRow = params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []

  if (params.audience === 'brokerage') {
    const body = `${emailKicker('Payment due')}

                    ${emailHeadline('Closing day payment reminder.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      The expected closing date for ${property} (${firstName}&rsquo;s deal) has arrived. Please remit payment of ${amount} to Firm Funds by ${escapeHtml(dueDateLabel)}.
                    </p>

                    ${emailDetailCard([
                      ...dealNumberRow,
                      { label: 'Amount Due', value: amount, valueColor: '#6FB783', strong: true },
                    ])}`

    const preheader = `Closing day for ${params.propertyAddress ?? ''}: remit ${amount} by ${dueDateLabel}.`
    return wrap(body, params.branding, preheader)
  }

  // audience === 'agent'
  const viewUrl = `${APP_URL}/agent/deals/${params.dealId}`
  const body = `${emailKicker('Payment due')}

                    ${emailHeadline('Closing day payment reminder.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${firstName}, the expected closing date for ${property} has arrived. Your brokerage has ${params.daysRemaining} days to remit payment of ${amount} to Firm Funds.
                    </p>

                    ${emailDetailCard([
                      ...dealNumberRow,
                      { label: 'Amount Due', value: amount, valueColor: '#6FB783', strong: true },
                    ])}

                    ${emailCallout({
                      tone: 'info',
                      title: 'Payment Due Date',
                      body: escapeHtml(dueDateLabel),
                    })}

                    ${emailCallout({
                      tone: 'warning',
                      body: 'Late payment interest at 24% per annum (compounded daily) only begins accruing if the payment remains outstanding 30 days after closing. We will be in touch with your brokerage if payment is delayed.',
                    })}

                    ${emailButton('View Deal', viewUrl)}`

  const preheader = `Closing day for ${params.propertyAddress ?? ''}: ${amount} due by ${dueDateLabel}.`
  return wrap(body, params.branding, preheader, emailFallbackLink(viewUrl))
}

/** Closing day reminder: "Deal closed, brokerage has the settlement window to remit payment." */
export async function sendSettlementReminderClosingDay(params: SettlementReminderParams) {
  // Both the agent body and the brokerage body should show the brokerage's
  // logo (same brokerage for both, so one lookup covers it).
  const branding = await getBrandingForBrokerage(params.brokerageId) || await getBrandingForAgent(params.agentId)

  // Send to agent. Promotional-class reminder, entity preference is honoured.
  // If the agent has unsubscribed they won't get the nag.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Closing Day: Payment due by ${formatReminderDate(params.dueDate)} (${params.propertyAddress})`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: renderSettlementReminderClosingDayEmail({
      audience: 'agent',
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      agentFirstName: params.agentFirstName,
      amountDueFromBrokerage: params.amountDueFromBrokerage,
      dueDate: params.dueDate,
      daysRemaining: params.daysRemaining,
      dealNumber: params.dealNumber,
      branding,
    }),
  })

  // Send to brokerage (when a primary contact email is on file).
  if (params.brokerageEmail) {
    await sendEmailWithUnsubscribe({
      to: params.brokerageEmail,
      subject: sanitizeSubject(`${dealTag(params.dealNumber)}Closing Day: Payment due by ${formatReminderDate(params.dueDate)} (${params.propertyAddress})`),
      entityType: params.brokerageId ? 'brokerage' : undefined,
      entityId: params.brokerageId ?? undefined,
      html: renderSettlementReminderClosingDayEmail({
        audience: 'brokerage',
        dealId: params.dealId,
        propertyAddress: params.propertyAddress,
        agentFirstName: params.agentFirstName,
        amountDueFromBrokerage: params.amountDueFromBrokerage,
        dueDate: params.dueDate,
        daysRemaining: params.daysRemaining,
        dealNumber: params.dealNumber,
        branding,
      }),
    })
  }
}

/**
 * Payment check-in: fires after the brokerage's settlement window has
 * passed and the payment has not yet been received. Toned-down, informational
 * ("we're checking in") rather than accusatory or urgent. Sent both to the
 * agent and (when on file) the brokerage's primary contact.
 *
 * Triggered by the daily closing-date-alerts cron when
 *   daysSinceClosing === Math.max(12, settlement_days + 1)
 * so 7-day brokerages get it on day 12 (5 days past due) and 14-day
 * brokerages get it on day 15 (1 day past due). Caller computes
 * `daysSinceDue` and passes it through for the body copy.
 */
/**
 * PURE renderer for the post-window payment check-in. ONE renderer covers both
 * recipients via `audience`, reproducing each variant's exact copy + link:
 *
 * - agent: "Hi {firstName}, we wanted to follow up..." + the "we haven't yet
 *   received the {amount} remittance from {brokerage}..." line + the "already
 *   sent, please disregard / else follow up with your brokerage administrator"
 *   note, plus a View Deal CTA into the agent deal page (with the fallback shelf).
 * - brokerage: "Hi {brokerageName}, following up on the advance payment..." + the
 *   "we haven't yet received your remittance of {amount}..." line + the "already
 *   sent, disregard / else remit at your earliest convenience" note, and NO
 *   button, exactly as the original brokerage variant.
 *
 * Both variants share the same Deal Number row (when present) and the same
 * late-payment-interest explanation, rendered as an info callout. That legal /
 * financial wording is preserved verbatim. The day-count phrasing and the
 * "your brokerage" name fallback are derived here exactly as the send fn did.
 * Both recipients share the brokerage's branding (passed in by the send fn).
 */
export function renderSettlementReminderPaymentCheckInEmail(params: {
  audience: 'agent' | 'brokerage'
  dealId: string
  propertyAddress: string
  agentFirstName: string
  brokerageName?: string
  amountDueFromBrokerage: number
  dueDate: string
  daysSinceDue?: number
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const daysSinceDue = params.daysSinceDue ?? 0
  const daysAgoText = daysSinceDue === 1 ? '1 day ago' : `${daysSinceDue} days ago`
  const dueDateLabel = formatReminderDate(params.dueDate)
  const brokerageName = params.brokerageName ?? 'your brokerage'

  const firstName = escapeHtml(params.agentFirstName ?? '')
  const property = escapeHtml(params.propertyAddress ?? '')
  const amount = formatReminderCurrency(params.amountDueFromBrokerage)
  const dealNumberRow = params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []

  // Identical legal / financial copy for both recipients. Preserved verbatim.
  const lateInterestCallout = emailCallout({
    tone: 'info',
    body: 'Late payment interest at 24% per annum (compounded daily) begins accruing 30 days after closing. There&rsquo;s still time to remit before that kicks in.',
  })

  if (params.audience === 'brokerage') {
    const body = `${emailKicker('Payment check-in')}

                    ${emailHeadline('Payment check-in.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(brokerageName)}, following up on the advance payment for ${property} (agent: ${firstName}).
                    </p>

                    ${dealNumberRow.length ? emailDetailCard(dealNumberRow) : ''}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      We haven&rsquo;t yet received your remittance of ${amount}. The settlement deadline was ${escapeHtml(dueDateLabel)} (${escapeHtml(daysAgoText)}).
                    </p>

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      If you&rsquo;ve already sent it, please disregard. If not, please remit at your earliest convenience.
                    </p>

                    ${lateInterestCallout}`

    const preheader = `Following up: ${amount} for ${params.propertyAddress ?? ''} was due ${dueDateLabel}.`
    return wrap(body, params.branding, preheader)
  }

  // audience === 'agent'
  const viewUrl = `${APP_URL}/agent/deals/${params.dealId}`
  const body = `${emailKicker('Payment check-in')}

                    ${emailHeadline('Payment check-in.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${firstName}, we wanted to follow up on the payment for ${property}.
                    </p>

                    ${dealNumberRow.length ? emailDetailCard(dealNumberRow) : ''}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      We haven&rsquo;t yet received the ${amount} remittance from ${escapeHtml(brokerageName)} for this advance. The settlement deadline was ${escapeHtml(dueDateLabel)} (${escapeHtml(daysAgoText)}).
                    </p>

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      If the payment has already been sent, please disregard (there can be a 1-2 day delay in processing). If not, please follow up with your brokerage administrator.
                    </p>

                    ${lateInterestCallout}

                    ${emailButton('View Deal', viewUrl)}`

  const preheader = `Following up on the ${amount} payment for ${params.propertyAddress ?? ''}.`
  return wrap(body, params.branding, preheader, emailFallbackLink(viewUrl))
}

export async function sendSettlementReminderPaymentCheckIn(params: SettlementReminderParams) {
  const branding = await getBrandingForBrokerage(params.brokerageId) || await getBrandingForAgent(params.agentId)

  // Send to agent. Promotional-class reminder, entity preference is honoured.
  // If the agent has unsubscribed they won't get the nag.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Payment Check-In: ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: renderSettlementReminderPaymentCheckInEmail({
      audience: 'agent',
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      agentFirstName: params.agentFirstName,
      brokerageName: params.brokerageName,
      amountDueFromBrokerage: params.amountDueFromBrokerage,
      dueDate: params.dueDate,
      daysSinceDue: params.daysSinceDue,
      dealNumber: params.dealNumber,
      branding,
    }),
  })

  // Send to brokerage (when a primary contact email is on file). Same
  // toned-down wording, addressed to the brokerage.
  if (params.brokerageEmail) {
    await sendEmailWithUnsubscribe({
      to: params.brokerageEmail,
      subject: sanitizeSubject(`${dealTag(params.dealNumber)}Payment Check-In: ${params.propertyAddress}`),
      entityType: params.brokerageId ? 'brokerage' : undefined,
      entityId: params.brokerageId ?? undefined,
      html: renderSettlementReminderPaymentCheckInEmail({
        audience: 'brokerage',
        dealId: params.dealId,
        propertyAddress: params.propertyAddress,
        agentFirstName: params.agentFirstName,
        brokerageName: params.brokerageName,
        amountDueFromBrokerage: params.amountDueFromBrokerage,
        dueDate: params.dueDate,
        daysSinceDue: params.daysSinceDue,
        dealNumber: params.dealNumber,
        branding,
      }),
    })
  }
}

// ============================================================================
// Closing Date Amendment Notifications
// ============================================================================

/**
 * PURE renderer for the admin "closing date amendment requested" notification.
 * Synchronous, no I/O, admin-only (no branding). The original blue date box
 * becomes a two-row detail card (Original Closing Date / Proposed New Closing
 * Date), both dates in the default value color. Carries a preheader and the
 * fallback shelf for the Review Amendment CTA into the admin deal page.
 */
export function renderAmendmentRequestedEmail(params: {
  dealId: string
  propertyAddress: string
  agentName: string
  oldClosingDate: string
  newClosingDate: string
  dealNumber?: string | null
}): string {
  const agent = escapeHtml(params.agentName ?? '')
  const property = escapeHtml(params.propertyAddress ?? '')
  const dealNumberSuffix = params.dealNumber ? ` (Deal Number: ${escapeHtml(params.dealNumber)})` : ''
  const reviewUrl = `${APP_URL}/admin/deals/${params.dealId}`

  const body = `${emailKicker('Amendment request')}

                    ${emailHeadline('Closing date amendment requested.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${agent} has requested a closing date amendment for ${property}${dealNumberSuffix}.
                    </p>

                    ${emailDetailCard([
                      { label: 'Original Closing Date', value: formatReminderDate(params.oldClosingDate) },
                      { label: 'Proposed New Closing Date', value: formatReminderDate(params.newClosingDate) },
                    ])}

                    ${emailCallout({
                      tone: 'info',
                      body: 'The agent has uploaded the executed amendment document. Please review and approve or reject the request.',
                    })}

                    ${emailButton('Review Amendment', reviewUrl)}`

  const preheader = `${params.agentName ?? ''} requested a closing date change for ${params.propertyAddress ?? ''}.`

  return wrap(body, null, preheader, emailFallbackLink(reviewUrl))
}

/** Notify admin that an agent has requested a closing date amendment */
export async function sendAmendmentRequestedNotification(params: {
  dealId: string
  propertyAddress: string
  agentName: string
  oldClosingDate: string
  newClosingDate: string
  dealNumber?: string | null
}) {
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Closing Date Amendment Requested: ${params.propertyAddress}`),
    transactional: true, // internal admin notification, transactional class
    html: renderAmendmentRequestedEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      agentName: params.agentName,
      oldClosingDate: params.oldClosingDate,
      newClosingDate: params.newClosingDate,
      dealNumber: params.dealNumber,
    }),
  })
}

/**
 * PURE renderer for the agent "closing date amendment approved" notification.
 * Synchronous, no I/O. The original blue date box becomes a two-row detail card
 * (New Closing Date in the default value color, Updated Advance Amount as a
 * green strong money value). The sign-the-amendment instruction sits in an info
 * callout. Branded with the agent's brokerage logo; carries a preheader and the
 * fallback shelf for the View Deal CTA into the agent deal page.
 */
export function renderAmendmentApprovedEmail(params: {
  dealId: string
  propertyAddress: string
  agentFirstName: string
  newClosingDate: string
  newAdvanceAmount: number
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const firstName = escapeHtml(params.agentFirstName ?? '')
  const property = escapeHtml(params.propertyAddress ?? '')
  const dealNumberSuffix = params.dealNumber ? ` (Deal Number: ${escapeHtml(params.dealNumber)})` : ''
  const viewUrl = `${APP_URL}/agent/deals/${params.dealId}`

  const body = `${emailKicker('Amendment approved')}

                    ${emailHeadline('Closing date amendment approved.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${firstName}, your closing date amendment for ${property}${dealNumberSuffix} has been approved.
                    </p>

                    ${emailDetailCard([
                      { label: 'New Closing Date', value: formatReminderDate(params.newClosingDate) },
                      { label: 'Updated Advance Amount', value: formatReminderCurrency(params.newAdvanceAmount), valueColor: '#6FB783', strong: true },
                    ])}

                    ${emailCallout({
                      tone: 'info',
                      body: 'You will receive a separate email to review and sign an Amendment to the Commission Purchase Agreement. Signing it finalizes the change.',
                    })}

                    ${emailButton('View Deal', viewUrl)}`

  const preheader = `Your closing date change for ${params.propertyAddress ?? ''} was approved.`

  return wrap(body, params.branding, preheader, emailFallbackLink(viewUrl))
}

/** Notify agent that their closing date amendment was approved */
export async function sendAmendmentApprovedNotification(params: {
  dealId: string
  propertyAddress: string
  agentEmail: string
  agentFirstName: string
  newClosingDate: string
  newAdvanceAmount: number
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
  dealNumber?: string | null
}) {
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Amendment Approved: ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: renderAmendmentApprovedEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      agentFirstName: params.agentFirstName,
      newClosingDate: params.newClosingDate,
      newAdvanceAmount: params.newAdvanceAmount,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Monthly white-label profit-share statement → Brokerage (Session 34)
// ============================================================================

/**
 * PURE renderer for the brokerage "Monthly Profit-Share Statement". Synchronous,
 * no I/O. Mirrors renderInvoiceEmail's statement table: a header row of uppercase
 * muted labels, body rows split by 1px #232323 dividers (numerics right-aligned,
 * money in #D6D6D4, the kept-share column green #6FB783 when still unremitted),
 * wrapped in the #1C1C1C / #2A2A2A rounded card. The empty-state spans all four
 * columns exactly as before. The asterisk on each unremitted share and its
 * footnote are preserved verbatim, and the period summary (Total earned this
 * period, Pending remittance) renders as an info callout. Branded with the
 * brokerage logo; carries a preheader and the fallback shelf for the dashboard
 * CTA. The send fn still resolves branding + builds the rows array + totals.
 */
export function renderMonthlyBrokerStatementEmail(params: {
  brokerageName: string
  periodLabel: string
  rows: Array<{
    propertyAddress: string
    agentName: string
    fundingDate: string | null
    brokerShare: number
    remitted: boolean
  }>
  totalEarned: number
  totalUnremitted: number
  branding?: BrokerageBranding | null
}): string {
  const dashboardUrl = `${APP_URL}/brokerage`

  const rowsHtml = params.rows.length === 0
    ? `<tr>
                            <td colspan="4" style="padding:18px 16px; color:#8A8A87; font-size:13px; line-height:1.4; text-align:center; border-top:1px solid #232323;">No funded or completed deals this period.</td>
                          </tr>`
    : params.rows.map(r => `<tr>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323;">${escapeHtml(r.propertyAddress ?? '')}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323;">${escapeHtml(r.agentName ?? '')}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(r.fundingDate ?? '-')}</td>
                            <td style="padding:11px 16px; color:${r.remitted ? '#D6D6D4' : '#6FB783'}; font-size:13px; font-weight:600; line-height:1.4; text-align:right; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(formatCurrency(r.brokerShare))}${r.remitted ? '' : ' *'}</td>
                          </tr>`).join('\n                          ')

  const statementTable = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px; background:#1C1C1C; border:1px solid #2A2A2A; border-radius:12px; overflow:hidden;">
                          <tr>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Property</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Agent</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Funded</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:right;">Your&nbsp;Share</th>
                          </tr>
                          ${rowsHtml}
                        </table>`

  const summaryCallout = emailCallout({
    tone: 'info',
    title: 'Period summary',
    body: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="color:#D7E1F1; font-size:13px; line-height:1.4;">Total earned this period</td>
                              <td style="color:#F5F5F4; font-size:18px; font-weight:700; line-height:1.4; text-align:right; white-space:nowrap;">${escapeHtml(formatCurrency(params.totalEarned))}</td>
                            </tr>
                            <tr>
                              <td style="color:#D7E1F1; font-size:13px; line-height:1.4; padding-top:8px;">Pending remittance (kept from commission)</td>
                              <td style="color:#6FB783; font-size:14px; font-weight:700; line-height:1.4; text-align:right; padding-top:8px; white-space:nowrap;">${escapeHtml(formatCurrency(params.totalUnremitted))}</td>
                            </tr>
                          </table>`,
  })

  const body = `${emailKicker('Monthly statement')}

                    ${emailHeadline('Monthly profit-share statement.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${escapeHtml(params.brokerageName ?? '')}, here is your profit-share statement for ${escapeHtml(params.periodLabel ?? '')}.
                    </p>

                    ${statementTable}

                    ${summaryCallout}

                    <p style="margin:0 0 30px; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55;">
                      * Pending remittance: this share has not yet been formally reconciled with Firm Funds. Per your white-label agreement, you retain this share from the commission you control at closing. There is no separate payment.
                    </p>

                    ${emailButton('View dashboard', dashboardUrl)}`

  const preheader = `Your ${params.periodLabel ?? ''} profit-share statement: ${formatCurrency(params.totalEarned)} earned.`

  return wrap(body, params.branding, preheader, emailFallbackLink(dashboardUrl))
}

export async function sendMonthlyBrokerStatement(params: {
  toEmail: string
  brokerageName: string
  brokerageLogoUrl?: string | null
  /** TRUE if the logo SVG already contains "Powered by Firm Funds". Migration 096. */
  brokerageLogoIncludesTagline?: boolean | null
  periodLabel: string  // e.g. "April 2026"
  rows: Array<{
    propertyAddress: string
    agentName: string
    fundingDate: string | null
    brokerShare: number
    remitted: boolean
  }>
  totalEarned: number
  totalUnremitted: number
  /** Pass-through for per-brokerage unsubscribe handling (migration 092). */
  brokerageId?: string | null
}): Promise<void> {
  const branding: BrokerageBranding | null = params.brokerageLogoUrl
    ? { logoUrl: params.brokerageLogoUrl, name: params.brokerageName, logoIncludesTagline: params.brokerageLogoIncludesTagline ?? false }
    : null

  await sendEmailWithUnsubscribe({
    to: params.toEmail,
    subject: sanitizeSubject(`${params.brokerageName}: Profit-Share Statement (${params.periodLabel})`),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    html: renderMonthlyBrokerStatementEmail({
      brokerageName: params.brokerageName,
      periodLabel: params.periodLabel,
      rows: params.rows,
      totalEarned: params.totalEarned,
      totalUnremitted: params.totalUnremitted,
      branding,
    }),
  })
}

/** Notify agent that their closing date amendment was rejected */
/**
 * PURE renderer for the agent "closing date amendment rejected" notification.
 * Synchronous, no I/O. The original red reason box becomes a danger callout
 * titled "Reason" with the (escaped) rejection reason. Branded with the agent's
 * brokerage logo; carries a preheader and the fallback shelf for the View Deal
 * CTA into the agent deal page. The "questions, reply to this email" line is the
 * quiet trailing note under the button.
 */
export function renderAmendmentRejectedEmail(params: {
  dealId: string
  propertyAddress: string
  agentFirstName: string
  reason: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const firstName = escapeHtml(params.agentFirstName ?? '')
  const property = escapeHtml(params.propertyAddress ?? '')
  const dealNumberSuffix = params.dealNumber ? ` (Deal Number: ${escapeHtml(params.dealNumber)})` : ''
  const viewUrl = `${APP_URL}/agent/deals/${params.dealId}`

  const body = `${emailKicker('Amendment rejected')}

                    ${emailHeadline('Closing date amendment rejected.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${firstName}, your closing date amendment for ${property}${dealNumberSuffix} was not approved.
                    </p>

                    ${emailCallout({
                      tone: 'danger',
                      title: 'Reason',
                      body: escapeHtml(params.reason ?? ''),
                    })}

                    ${emailButton('View Deal', viewUrl)}

                    <p style="margin:16px 0 0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55; text-align:center;">
                      If you have any questions, please contact us or reply to this email.
                    </p>`

  const preheader = `Your closing date change for ${params.propertyAddress ?? ''} was not approved.`

  return wrap(body, params.branding, preheader, emailFallbackLink(viewUrl))
}

export async function sendAmendmentRejectedNotification(params: {
  dealId: string
  propertyAddress: string
  agentEmail: string
  agentFirstName: string
  reason: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
  dealNumber?: string | null
}) {
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Amendment Rejected: ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: renderAmendmentRejectedEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      agentFirstName: params.agentFirstName,
      reason: params.reason,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Brokerage submitted a payment claim → notify admin
// ============================================================================

/**
 * PURE renderer for the admin "new payment claim submitted" notification.
 * Synchronous, no I/O, admin-only (no branding). The original blue details box
 * becomes a detail card: Amount (green strong money value), Agent, Payment Date,
 * Method, and Reference only when present. The method label is derived here from
 * the raw method code exactly as the send fn did. The "pending status" note is an
 * info callout. CTA targets the admin payments queue (not a specific deal), so no
 * fallback shelf.
 */
export function renderPaymentClaimSubmittedEmail(params: {
  propertyAddress: string
  brokerageName: string
  agentName: string
  amount: number
  paymentDate: string
  method?: string
  reference?: string
  dealNumber?: string | null
}): string {
  const methodLabel = (() => {
    switch (params.method) {
      case 'eft': return 'EFT'
      case 'wire': return 'Wire transfer'
      case 'cheque': return 'Cheque'
      case 'cash': return 'Cash'
      case 'other': return 'Other'
      default: return 'Not specified'
    }
  })()

  const brokerage = escapeHtml(params.brokerageName ?? '')
  const property = escapeHtml(params.propertyAddress ?? '')
  const dealNumberSuffix = params.dealNumber ? ` (Deal Number: ${escapeHtml(params.dealNumber)})` : ''
  const reviewUrl = `${APP_URL}/admin/payments`

  const body = `${emailKicker('Payment claim')}

                    ${emailHeadline('New payment claim submitted.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${brokerage} has submitted a payment claim for ${property}${dealNumberSuffix}.
                    </p>

                    ${emailDetailCard([
                      { label: 'Amount', value: formatReminderCurrency(params.amount), valueColor: '#6FB783', strong: true },
                      { label: 'Agent', value: params.agentName ?? '' },
                      { label: 'Payment Date', value: formatReminderDate(params.paymentDate) },
                      { label: 'Method', value: methodLabel },
                      ...(params.reference ? [{ label: 'Reference', value: params.reference }] : []),
                    ])}

                    ${emailCallout({
                      tone: 'info',
                      body: 'The claim is sitting in pending status until you confirm a bank match or reject it.',
                    })}

                    ${emailButton('Review Payment Claim', reviewUrl)}`

  const preheader = `${params.brokerageName ?? ''} claims ${formatReminderCurrency(params.amount)} for ${params.propertyAddress ?? ''}.`

  return wrap(body, null, preheader)
}

export async function sendPaymentClaimSubmittedNotification(params: {
  dealId: string
  propertyAddress: string
  brokerageName: string
  agentName: string
  amount: number
  paymentDate: string
  method?: string
  reference?: string
  dealNumber?: string | null
}) {
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}New payment claim: ${params.brokerageName} (${formatReminderCurrency(params.amount)})`),
    transactional: true, // internal admin notification, transactional class
    html: renderPaymentClaimSubmittedEmail({
      propertyAddress: params.propertyAddress,
      brokerageName: params.brokerageName,
      agentName: params.agentName,
      amount: params.amount,
      paymentDate: params.paymentDate,
      method: params.method,
      reference: params.reference,
      dealNumber: params.dealNumber,
    }),
  })
}

// ============================================================================
// Email: Failed-to-close cure election notice → Agent
// CPA Article 5.5: agent must elect cash or commission assignment within 15 days
// ============================================================================

/**
 * PURE renderer for the agent failed-to-close cure-election notice (CPA Article
 * 5.5). Synchronous, no I/O. LEGAL email: the contractual copy is preserved
 * verbatim, including the branch-specific failureExplanation (Article 5.1 for
 * non_closing, Article 5.2 for commission_deficiency), the election deadline
 * line, both option bodies, and the deemed-cash-election paragraph. The old red
 * outstanding-balance box becomes a danger callout (centered) showing the amount
 * in red; the two option boxes become two callouts (neutral / info) carrying
 * their copy unchanged. The deadline keeps its green bold emphasis inside the
 * "you must choose" paragraph. Branded with the agent's brokerage logo; carries
 * a preheader and the fallback shelf for the cure-election deep link. The send fn
 * still resolves branding and computes the formatted amount/deadline + labels.
 */
export function renderFailedToCloseElectionEmail(params: {
  dealId: string
  propertyAddress: string
  agentFirstName: string
  failureType: 'non_closing' | 'commission_deficiency'
  amountFmt: string
  deadlineFmt: string
  failureLabel: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const electionUrl = `${APP_URL}/agent/account/cure-election/${params.dealId}`

  const failureExplanation = params.failureType === 'non_closing'
    ? `Because the transaction did not close, the full Purchase Price you received from Firm Funds is owed back, in accordance with Article 5.1 of your Commission Purchase Agreement.`
    : `Because the commission received was less than the Face Value, the shortfall is owed back, in accordance with Article 5.2 of your Commission Purchase Agreement.`

  const body = `${emailKicker('Action required')}

                    ${emailHeadline('Choose your repayment method.')}

                    <p style="margin:0 0 20px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      Hi ${escapeHtml(params.agentFirstName ?? '')}, we wanted to let you know that your funded deal at <strong style="color:#F5F5F4;">${escapeHtml(params.propertyAddress ?? '')}</strong>${params.dealNumber ? ` (Deal Number: ${escapeHtml(params.dealNumber)})` : ''} ${escapeHtml(params.failureLabel)}.
                    </p>

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${escapeHtml(failureExplanation)}
                    </p>

                    ${emailCallout({
                      tone: 'danger',
                      title: 'Outstanding balance',
                      align: 'center',
                      body: `<p style="margin:0 0 6px; color:#F08C8C; font-size:28px; font-weight:700; line-height:1.2; letter-spacing:-0.01em;">${escapeHtml(params.amountFmt)}</p>
                          <p style="margin:0; color:#EFDBDB; font-size:12px; line-height:1.4;">Charged to your Firm Funds account</p>`,
                    })}

                    <p style="margin:0 0 12px; color:#F5F5F4; font-size:16px; font-weight:600; line-height:1.4;">You must choose one of two repayment methods</p>
                    <p style="margin:0 0 20px; color:#D6D6D4; font-size:14px; font-weight:400; line-height:1.6;">
                      Per Article 5.5 of your Commission Purchase Agreement, you have <strong style="color:#6FB783;">until ${escapeHtml(params.deadlineFmt)}</strong> (15 calendar days) to make your election.
                    </p>

                    ${emailCallout({
                      tone: 'neutral',
                      title: 'Option A: Cash repayment',
                      body: 'Pay the full outstanding balance from your own funds by electronic funds transfer within 30 days.',
                    })}

                    ${emailCallout({
                      tone: 'info',
                      title: 'Option B: Assign next commission(s)',
                      body: 'Sign a Remediation Direction to Pay that directs your brokerage to remit your next eligible commission(s) to Firm Funds until the balance is satisfied. No discount fee or settlement fee applies. This is not a new advance.',
                    })}

                    <p style="margin:0 0 30px; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.6;">
                      If you do not make a written election by ${escapeHtml(params.deadlineFmt)}, you will be deemed to have elected cash repayment, and the full balance will become immediately due. Interest of 24% per annum, compounded daily, will accrue on any unpaid balance starting on the 31st day.
                    </p>

                    ${emailButton('Make Your Election', electionUrl)}

                    <p style="margin:16px 0 0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55; text-align:center;">
                      Questions? Reply to this email and we&rsquo;ll help you through it.
                    </p>`

  const preheader = `Action required: choose how to repay ${params.amountFmt} by ${params.deadlineFmt}.`

  return wrap(body, params.branding, preheader, emailFallbackLink(electionUrl))
}

export async function sendFailedToCloseElectionEmail(params: {
  dealId: string
  propertyAddress: string
  agentEmail: string
  agentFirstName: string
  failureType: 'non_closing' | 'commission_deficiency'
  outstandingAmount: number
  deadline: string // ISO timestamp
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
  dealNumber?: string | null
}): Promise<void> {
  const amountFmt = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 2,
  }).format(params.outstandingAmount)

  const deadlineFmt = new Date(params.deadline).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const failureLabel = params.failureType === 'non_closing'
    ? 'did not close'
    : 'closed with a commission shortfall'

  // Cure election is a contractual/legal notice: transactional, bypasses
  // the recipient's promotional opt-out.
  const branding = await getBrandingForAgent(params.agentId)
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Action required: Your funded deal at ${params.propertyAddress} ${failureLabel}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: renderFailedToCloseElectionEmail({
      dealId: params.dealId,
      propertyAddress: params.propertyAddress,
      agentFirstName: params.agentFirstName,
      failureType: params.failureType,
      amountFmt,
      deadlineFmt,
      failureLabel,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

// ============================================================================
// Email: Remediation IDP signed → Admin (Bud)
// Triggered by the e-signature provider's webhook when a remediation_idp envelope
// reports status "completed". Mirrors sendPaymentClaimSubmittedNotification:
// internal-ops mail, transactional, no recipient preference check.
// ============================================================================

/**
 * PURE renderer for the admin "Remediation IDP signed" notification. Synchronous,
 * no I/O, admin-only (no branding). The original details table becomes an
 * emailDetailCard: Deal Number (when present), Source Property, Curing Failed
 * Deal, Brokerage, Agent (name + email combined as before), Directed Amount
 * (green strong), Signed At, Envelope. The "mark the remediation deal remitted"
 * line is the quiet note above the CTA. Internal ops, so no preheader, but a
 * fallback shelf is included because the CTA deep-links a specific deal. The send
 * fn still formats the signed-at timestamp.
 */
export function renderRemediationIdpSignedEmail(params: {
  remediationDealId: string
  envelopeId: string
  agentName: string
  agentEmail: string
  brokerageName: string
  failedDealPropertyAddress: string
  sourcePropertyAddress: string
  directedAmount: number
  signedAtFmt: string
  dealNumber?: string | null
}): string {
  const dealUrl = `${APP_URL}/admin/deals/${params.remediationDealId}`

  const body = `${emailKicker('Remediation signed')}

                    ${emailHeadline('Remediation IDP signed.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      <strong style="color:#F5F5F4;">${escapeHtml(params.agentName ?? '')}</strong> has signed the Remediation Direction to Pay. The signed PDF is in storage and the remediation deal is now waiting on the brokerage to remit.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Source Property', value: params.sourcePropertyAddress ?? '' },
                      { label: 'Curing Failed Deal', value: params.failedDealPropertyAddress ?? '' },
                      { label: 'Brokerage', value: params.brokerageName ?? '' },
                      { label: 'Agent', value: `${params.agentName ?? ''} <${params.agentEmail ?? ''}>` },
                      { label: 'Directed Amount', value: formatCurrency(params.directedAmount), valueColor: '#6FB783', strong: true },
                      { label: 'Signed At', value: params.signedAtFmt },
                      { label: 'Envelope', value: params.envelopeId ?? '' },
                    ])}

                    <p style="margin:0 0 30px; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55;">
                      When the brokerage remits the directed amount, mark the remediation deal remitted from the admin dashboard to apply the credit to the agent&rsquo;s failed deal.
                    </p>

                    ${emailButton('Open Remediation Deal', dealUrl)}`

  return wrap(body, null, undefined, emailFallbackLink(dealUrl))
}

export async function sendRemediationIdpSignedNotification(params: {
  remediationDealId: string
  envelopeId: string
  agentName: string
  agentEmail: string
  brokerageName: string
  failedDealPropertyAddress: string
  sourcePropertyAddress: string
  directedAmount: number
  signedAt: string  // ISO timestamp
  /** Deal number of the remediation deal (the one opened by remediationDealId). */
  dealNumber?: string | null
}): Promise<void> {
  const signedAtFmt = new Date(params.signedAt).toLocaleString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`${dealTag(params.dealNumber)}Remediation IDP signed: ${params.agentName} (${params.sourcePropertyAddress})`),
    transactional: true,
    html: renderRemediationIdpSignedEmail({
      remediationDealId: params.remediationDealId,
      envelopeId: params.envelopeId,
      agentName: params.agentName,
      agentEmail: params.agentEmail,
      brokerageName: params.brokerageName,
      failedDealPropertyAddress: params.failedDealPropertyAddress,
      sourcePropertyAddress: params.sourcePropertyAddress,
      directedAmount: params.directedAmount,
      signedAtFmt,
      dealNumber: params.dealNumber,
    }),
  })
}

// ============================================================================
// Email: Executed Direction to Pay → Brokerage (with signed PDF attached)
// ============================================================================

/**
 * Deliver the executed (fully signed) Irrevocable Direction to Pay to the
 * brokerage. This is a legal requirement: the IDP is the brokerage's written
 * authorization to remit the agent's commission to Firm Funds, so the
 * brokerage must receive the executed copy for its records. The old e-signature
 * flow handled this by CC'ing the brokerage on the envelope; SignWell treats
 * every recipient as a signer, so we deliver the copy ourselves here.
 *
 * The attached PDF is the merged completed document. For a deal envelope that
 * currently bundles the signed CPA + IDP together (matching the prior e-signature
 * CC behaviour, which copied the whole envelope). If a brokerage should only
 * receive the IDP page later, narrow the attachment via
 * `completed_pdf?file_format=zip` upstream and pass just the IDP bytes here.
 *
 * Transactional: a brokerage cannot opt out of receiving its own legal
 * authorization document.
 */
export async function sendBrokerageExecutedIdpNotification(params: {
  /** Deduped, non-null recipient list (broker-of-record + brokerage admin). */
  to: string[]
  brokerageName: string
  agentName: string
  propertyAddress: string
  /** Optional deal number for the subject prefix + body line. */
  dealNumber?: string | null
  /** Per-brokerage unsubscribe handling (migration 092). Transactional anyway. */
  brokerageId?: string | null
  /** The executed signed PDF to attach. */
  pdf: Buffer
  /** File name shown on the attachment. */
  pdfFileName: string
}): Promise<void> {
  // White-label: show the brokerage's own logo in the header (falls back to the
  // Firm Funds default when the brokerage has no logo on file).
  const branding = await getBrandingForBrokerage(params.brokerageId)
  await sendEmailWithUnsubscribe({
    to: params.to.join(', '),
    subject: sanitizeSubject(
      `${dealTag(params.dealNumber)}Executed Direction to Pay: ${params.propertyAddress} (${params.agentName})`
    ),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    transactional: true,
    attachments: [{ filename: params.pdfFileName, content: params.pdf }],
    html: renderBrokerageExecutedIdpEmail({
      brokerageName: params.brokerageName,
      agentName: params.agentName,
      propertyAddress: params.propertyAddress,
      dealNumber: params.dealNumber,
      branding,
    }),
  })
}

/**
 * PURE renderer for the brokerage "Executed Direction to Pay" notification.
 * Synchronous, no I/O. The renderer does NOT touch the attachment: the send fn
 * keeps passing the executed PDF via `attachments`, and the body copy still tells
 * the recipient the executed agreement is attached (wording preserved). The
 * original details table becomes an emailDetailCard: Deal Number (when present),
 * Property, Agent, Brokerage. This email originally had NO button, so none is
 * added (and therefore no fallback shelf). White-labelled: the send fn resolves
 * the brokerage's branding and passes it here so the header shows the brokerage's
 * own logo (falling back to the Firm Funds default when none is on file). A short
 * preheader is included.
 */
export function renderBrokerageExecutedIdpEmail(params: {
  brokerageName: string
  agentName: string
  propertyAddress: string
  dealNumber?: string | null
  branding?: BrokerageBranding | null
}): string {
  const body = `${emailKicker('Executed direction')}

                    ${emailHeadline('Executed direction to pay.')}

                    <p style="margin:0 0 20px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      <strong style="color:#F5F5F4;">${escapeHtml(params.agentName ?? '')}</strong> has executed an Irrevocable Direction to Pay directing <strong style="color:#F5F5F4;">${escapeHtml(params.brokerageName ?? '')}</strong> to remit the commission for ${escapeHtml(params.propertyAddress ?? '')} to Firm Funds Inc.
                    </p>

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      The executed agreement is attached for your records. Please honour it and remit the directed commission to Firm Funds Inc. in accordance with the Brokerage Cooperation Agreement between your brokerage and Firm Funds.
                    </p>

                    ${emailDetailCard([
                      ...(params.dealNumber ? [{ label: 'Deal Number', value: params.dealNumber }] : []),
                      { label: 'Property', value: params.propertyAddress ?? '' },
                      { label: 'Agent', value: params.agentName ?? '' },
                      { label: 'Brokerage', value: params.brokerageName ?? '' },
                    ])}

                    <p style="margin:0; color:#8A8A87; font-size:13px; font-weight:400; line-height:1.55;">
                      If you have any questions about this direction to pay, reply to this email or contact us at bud@firmfunds.ca.
                    </p>`

  const preheader = `Executed Direction to Pay for ${params.propertyAddress ?? ''} is attached.`

  return wrap(body, params.branding ?? null, preheader)
}

// ============================================================================
// Operational / dead-letter alerts
// ============================================================================

/**
 * Loud internal alert when an email in the cron_email_failures dead-letter
 * queue permanently gives up (gave_up_at set after MAX_ATTEMPTS). Sent to the
 * Firm Funds ops inbox so a stuck notification surfaces somewhere a human
 * actually looks, not just in the Netlify function logs. Fail-soft: never
 * throws, so a failure to send the alert can't break the retry sweep.
 */
/**
 * PURE renderer for the internal "Email permanently failed" dead-letter alert.
 * Synchronous, no I/O, admin-only (no branding), internal ops. A danger kicker +
 * danger callout signal the failure; the original details table becomes an
 * emailDetailCard: Email type, Recipient, Original subject, Attempts, Last error,
 * Failure row id. No button (and therefore no fallback shelf) and no preheader,
 * exactly as an internal-ops alert. The send fn owns the fail-soft try/catch.
 */
export function renderDeadLetterGiveUpEmail(params: {
  failureId: string
  emailType: string
  recipient: string
  subject: string | null
  error: string
  attemptCount: number
}): string {
  const body = `${emailKicker('Delivery failure')}

                    ${emailHeadline('Email permanently failed.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      A queued email exhausted all retry attempts and has been marked given-up in the dead-letter queue. It will not be retried again automatically. Please investigate and re-send by hand if needed.
                    </p>

                    ${emailCallout({
                      tone: 'danger',
                      title: 'Permanently given up',
                      body: `Email type <strong style="color:#F5F5F4;">${escapeHtml(params.emailType ?? '')}</strong> to ${escapeHtml(params.recipient ?? '')} will no longer be retried automatically.`,
                    })}

                    ${emailDetailCard([
                      { label: 'Email type', value: params.emailType ?? '', strong: true },
                      { label: 'Recipient', value: params.recipient ?? '' },
                      { label: 'Original subject', value: params.subject ?? '(none)' },
                      { label: 'Attempts', value: String(params.attemptCount) },
                      { label: 'Last error', value: params.error ?? '' },
                      { label: 'Failure row id', value: params.failureId ?? '' },
                    ])}`

  return wrap(body)
}

export async function sendDeadLetterGiveUpAlert(params: {
  failureId: string
  emailType: string
  recipient: string
  subject: string | null
  error: string
  attemptCount: number
}): Promise<void> {
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    transactional: true,
    subject: sanitizeSubject(
      `[Firm Funds] Email permanently failed: ${params.emailType}`
    ),
    html: renderDeadLetterGiveUpEmail({
      failureId: params.failureId,
      emailType: params.emailType,
      recipient: params.recipient,
      subject: params.subject,
      error: params.error,
      attemptCount: params.attemptCount,
    }),
  })
}

/**
 * Resend the overdue-remediation digest from a stored dead-letter payload.
 * Shares the same look as the live digest in
 * /api/cron/remediation-overdue-escalation but is self-contained so the retry
 * sweep can rebuild the email from the rows captured at enqueue time. Throws
 * on a send failure so the retry sweep can record the attempt and back off.
 */
export interface RemediationOverdueDigestRow {
  property_address?: string | null
  brokerage_legal_name?: string | null
  directed_amount?: number | null
  created_at?: string | null
  escalation_level?: number | null
}

/**
 * PURE renderer for the internal "Overdue Remediation Digest (retry)" alert.
 * Synchronous, no I/O, admin-only (no branding), internal ops. The dynamic table
 * (Property, Brokerage, Directed, Days Overdue, Escalation) is rebuilt in
 * renderInvoiceEmail's statement language: uppercase muted header labels, body
 * rows split by 1px #232323 dividers, numerics right-aligned, money in #D6D6D4.
 * The danger callout conveys the overdue urgency. No button (and no fallback
 * shelf) and no preheader. The send fn keeps the Resend send + the throw-on-send-
 * failure behavior the retry sweep depends on, and pre-computes each row's
 * formatted directed amount, days-overdue value, and escalation number so this
 * renderer stays free of Date.now().
 */
export function renderRemediationOverdueDigestEmail(params: {
  count: number
  rows: { propertyAddress: string; brokerageName: string; directedFmt: string; daysOverdue: number; escalation: number }[]
}): string {
  const rowsHtml = params.rows
    .map((r) => `<tr>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323;">${escapeHtml(r.propertyAddress ?? '')}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; border-top:1px solid #232323;">${escapeHtml(r.brokerageName ?? '')}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; text-align:right; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(r.directedFmt)}</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; text-align:right; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(String(r.daysOverdue))}d</td>
                            <td style="padding:11px 16px; color:#D6D6D4; font-size:13px; line-height:1.4; text-align:right; border-top:1px solid #232323; white-space:nowrap;">${escapeHtml(String(r.escalation))}</td>
                          </tr>`)
    .join('\n                          ')

  const statementTable = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 30px; background:#1C1C1C; border:1px solid #582A2A; border-radius:12px; overflow:hidden;">
                          <tr>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Property</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:left;">Brokerage</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:right;">Directed</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:right;">Days&nbsp;Overdue</th>
                            <th style="padding:12px 16px; color:#8A8A87; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; text-align:right;">Escalation</th>
                          </tr>
                          ${rowsHtml}
                        </table>`

  const body = `${emailKicker('Overdue remediations')}

                    ${emailHeadline('Overdue remediation digest.')}

                    <p style="margin:0 0 30px; color:#D6D6D4; font-size:15px; font-weight:400; line-height:1.65;">
                      ${escapeHtml(String(params.count))} remediation${params.count === 1 ? '' : 's'} have been waiting more than 14 days since their IDP was signed without remittance. Action needed.
                    </p>

                    ${emailCallout({
                      tone: 'danger',
                      title: 'Action needed',
                      body: `${escapeHtml(String(params.count))} remediation${params.count === 1 ? '' : 's'} are more than 14 days overdue without remittance.`,
                    })}

                    ${statementTable}`

  return wrap(body)
}

export async function sendRemediationOverdueDigest(
  rows: RemediationOverdueDigestRow[]
): Promise<void> {
  const resend = getResend()
  if (!resend) {
    throw new Error('RESEND_API_KEY not configured')
  }

  const ffInbox = process.env.FIRM_FUNDS_OFFER_INBOX || ADMIN_EMAIL
  const fmtCurrency = (n: number | null | undefined): string =>
    n == null
      ? 'n/a'
      : `$${Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const displayRows = rows.map((r) => ({
    propertyAddress: String(r.property_address ?? ''),
    brokerageName: String(r.brokerage_legal_name ?? ''),
    directedFmt: fmtCurrency(r.directed_amount),
    daysOverdue: r.created_at
      ? Math.floor((Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0,
    escalation: (r.escalation_level ?? 0) + 1,
  }))

  const html = renderRemediationOverdueDigestEmail({ count: rows.length, rows: displayRows })

  const result = (await resend.emails.send({
    from: FROM_ADDRESS,
    to: ffInbox,
    subject: sanitizeSubject(
      `[Firm Funds] ${rows.length} overdue remediation${rows.length === 1 ? '' : 's'} (retry)`
    ),
    html,
  })) as { error: { message?: string } | string | null } | null
  if (result && result.error) {
    const errVal = result.error
    const msg = typeof errVal === 'string' ? errVal : errVal.message ?? 'Unknown resend error'
    throw new Error(msg)
  }
}
