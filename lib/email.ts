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
      console.error('[email] RESEND_API_KEY missing in production — refusing to silently drop email')
      throw new Error('RESEND_API_KEY is not configured')
    }
    console.error('[email] RESEND_API_KEY not set — emails disabled (dev only)')
    return null
  }
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY)
  }
  return resendClient
}

// ============================================================================
// CASL / RFC 8058 — Unsubscribe infrastructure
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
// entity_id, token). We mint tokens lazily — one per entity, reused across
// every send to that entity — so a recipient who unsubscribes from any
// previous email gets unsubscribed for all future ones via the same token.

type UnsubscribeEntityType = 'agent' | 'brokerage'

/**
 * Fetch or mint a stable unsubscribe token for an entity. Idempotent: the
 * same agent/brokerage always gets the same token across email sends, so a
 * recipient who saves an unsubscribe link from any past email can still use
 * it. Uses a 32-byte hex token (64 chars) — long enough to be unguessable
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
      // Surface the error but don't block the send — better to ship the
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
 * On lookup error returns true (fail-open) — a transient DB blip should NOT
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
function buildUnsubscribeFooter(unsubscribeUrl: string, isTransactional: boolean): string {
  if (isTransactional) {
    // For mandatory account/security emails (password reset, email change
    // confirmation, etc.) the footer points at the unsubscribe page which
    // explains they cannot opt out of this class of email. The link is kept
    // for CASL — recipients need an obvious "manage notifications" target.
    return `
      <hr style="border:none; border-top:1px solid #2a2a2a; margin:24px 0;" />
      <p style="font-size:12px; color:#888; line-height:1.5;">
        This is an account / security email from Firm Funds. <a href="${unsubscribeUrl}" style="color:#5FA873;">Manage notification preferences</a>.
      </p>`
  }
  return `
    <hr style="border:none; border-top:1px solid #2a2a2a; margin:24px 0;" />
    <p style="font-size:12px; color:#888; line-height:1.5;">
      You're receiving this email from Firm Funds. <a href="${unsubscribeUrl}" style="color:#5FA873;">Unsubscribe</a> or manage notifications. Firm Funds Inc., Ontario, Canada.
    </p>`
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
}

/**
 * Resend wrapper that adds CASL footer + List-Unsubscribe headers and
 * respects the recipient's notification preference. Returns the Resend
 * response when sent, or null when the send was skipped or failed (errors
 * are logged, never thrown — the original sendXxx helpers had identical
 * fail-soft semantics so callers don't need to change).
 */
async function sendEmailWithUnsubscribe(opts: SendEmailOpts): Promise<unknown> {
  const resend = getResend()
  if (!resend) return null

  // Build the unsubscribe URL. If we have an entity, mint/fetch a per-entity
  // token; otherwise use the generic landing page (which renders "this is a
  // transactional email — you can't unsubscribe").
  let unsubscribeUrl = `${APP_URL}/unsubscribe`
  let serviceClient: SupabaseClient | null = null
  if (opts.entityType && opts.entityId) {
    try {
      serviceClient = createServiceRoleClient()
    } catch (err) {
      console.error('[email] service-role client unavailable:', err)
    }
    if (serviceClient) {
      // Preference check — skip non-transactional sends when the recipient
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
        // RFC 8058 — Gmail / iCloud render a one-click button. Without the
        // -Post header they fall back to the mailto/URL but won't show the
        // big "Unsubscribe" affordance.
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }
    if (opts.replyTo) {
      ;(payload as { replyTo?: string }).replyTo = opts.replyTo
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

// ============================================================================
// Branded HTML wrapper
// ============================================================================

interface BrokerageBranding {
  logoUrl: string | null
  name: string
}

function brandHeader(branding?: BrokerageBranding | null): string {
  if (branding?.logoUrl) {
    // White-label header: brokerage logo + "Powered by Firm Funds"
    return `
      <td style="padding:0 0 32px; text-align:center;">
        <img src="${branding.logoUrl}" alt="${escapeHtml(branding.name)}" height="44" style="height:44px; width:auto; max-width:240px;" />
        <div style="margin-top:10px;">
          <span style="color:#737373; font-size:10px; letter-spacing:0.05em; text-transform:uppercase;">Powered by</span>
          <img src="${APP_URL}/brand/white.png" alt="Firm Funds" height="12" style="height:12px; width:auto; vertical-align:middle; margin-left:6px;" />
        </div>
      </td>`
  }
  // Default: Firm Funds-only header
  return `
      <td style="padding:0 0 32px; text-align:center;">
        <img src="${APP_URL}/brand/white.png" alt="Firm Funds" height="36" style="height:36px; width:auto;" />
      </td>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function wrap(body: string, branding?: BrokerageBranding | null): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0; padding:0; background:#0C0C0C; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0C0C0C; padding:48px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px; width:100%;">
          <!-- Logo -->
          <tr>
            ${brandHeader(branding)}
          </tr>
          <!-- Main Card -->
          <tr>
            <td style="background:#171717; border:1px solid #262626; border-radius:16px; overflow:hidden;">
              <!-- Green accent bar -->
              <div style="height:3px; background:linear-gradient(90deg, #5FA873, #4A8E5F);"></div>
              <!-- Body -->
              <div style="padding:40px 36px; color:#D4D4D4; font-size:15px; line-height:1.65;">
                ${body}
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:28px 36px 0; text-align:center;">
              <p style="margin:0 0 6px; color:#525252; font-size:11px; letter-spacing:0.03em;">
                ${branding?.name ? escapeHtml(branding.name) + ' &bull; powered by Firm Funds Inc.' : 'Firm Funds Incorporated &bull; Ontario, Canada'}
              </p>
              <a href="${APP_URL}" style="color:#5FA873; text-decoration:none; font-size:11px; letter-spacing:0.03em;">firmfunds.ca</a>
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

export async function sendNewDealNotification(params: {
  dealId: string
  propertyAddress: string
  advanceAmount: number
  agentName: string
  brokerageName: string
}): Promise<void> {
  // Admin-targeted internal notification — no entity preference check, but
  // we still include a List-Unsubscribe header pointing at the generic
  // unsubscribe surface (mailbox providers expect one on notification-class
  // mail) and an "account email" footer in the body.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`New Deal Submitted — ${params.propertyAddress}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">New Deal Submitted</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          A new commission advance request has been submitted and is awaiting your review.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Property</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px; font-weight:600;">${escapeHtml(params.propertyAddress ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Agent</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.agentName ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Brokerage</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.brokerageName ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Advance Amount</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:16px; font-weight:700;">${formatCurrency(params.advanceAmount)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <a href="${APP_URL}/admin/deals/${params.dealId}" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
          Review Deal
        </a>
      `),
  })
}

// ============================================================================
// Email: New Deal Submitted → Brokerage Admin
// ============================================================================

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
}): Promise<void> {
  await sendEmailWithUnsubscribe({
    to: params.brokerageAdminEmail,
    subject: sanitizeSubject(`New Advance Request — ${params.agentName} — ${params.propertyAddress}`),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">New Advance Request</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${escapeHtml(params.brokerageAdminFirstName ?? '')}, one of your agents has submitted a commission advance request through Firm Funds.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Agent</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px; font-weight:600;">${escapeHtml(params.agentName ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Property</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.propertyAddress ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Advance Amount</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:16px; font-weight:700;">${formatCurrency(params.advanceAmount)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 20px; color:#737373; font-size:13px;">
          This deal is now under review by Firm Funds. You&rsquo;ll be able to track its status from your brokerage dashboard.
        </p>
        <a href="${APP_URL}/brokerage" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
          View Brokerage Dashboard
        </a>
      `),
  })
}

// ============================================================================
// Email: Deal Status Changed → Agent
// ============================================================================

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
}): Promise<void> {
  const color = statusColor(params.newStatus)
  const label = statusLabel(params.newStatus)

  let extraMessage = ''
  if (params.newStatus === 'approved') {
    extraMessage = `
      <div style="margin:16px 0 0; padding:16px; background:#0D2818; border:1px solid #1A4D2E; border-radius:12px; text-align:center;">
        <p style="margin:0 0 4px; color:#5FA873; font-size:22px; font-weight:700;">You're Approved!</p>
        <p style="margin:0; color:#E5E5E5; font-size:14px;">Your advance has been approved and will be funded shortly. We'll send another notification once the funds are on the way.</p>
      </div>`
  } else if (params.newStatus === 'funded') {
    extraMessage = `
      <div style="margin:16px 0 0; padding:16px; background:#1A0D40; border:1px solid #2D1A6E; border-radius:12px; text-align:center;">
        <p style="margin:0 0 4px; color:#8B5CF6; font-size:22px; font-weight:700;">Funds on the Way!</p>
        <p style="margin:0; color:#E5E5E5; font-size:14px;">Your EFT transfer is being processed and our goal is to have the funds in your account within 24 business hours. We'll keep you posted if anything changes.</p>
      </div>`
  } else if (params.newStatus === 'denied' && params.denialReason) {
    extraMessage = `
      <div style="margin:16px 0 0; padding:12px 16px; background:#241010; border:1px solid #422020; border-radius:8px;">
        <p style="margin:0 0 4px; color:#F87171; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Reason</p>
        <p style="margin:0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.denialReason)}</p>
      </div>`
  }

  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(
      params.newStatus === 'approved'
        ? `Good News — Your Advance for ${params.propertyAddress} is Approved!`
        : params.newStatus === 'funded'
        ? `Funds on the Way — ${params.propertyAddress}`
        : params.newStatus === 'denied'
        ? `Advance Update — ${params.propertyAddress}`
        : `Deal Update: ${params.propertyAddress} — ${label}`
    ),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:20px;">Deal Status Updated</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${escapeHtml(params.agentFirstName ?? '')}, the status of your deal has been updated.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px; background:#222; border-radius:8px;">
              <p style="margin:0 0 12px; color:#E5E5E5; font-size:15px; font-weight:600;">${escapeHtml(params.propertyAddress ?? '')}</p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:4px 12px; background:rgba(136,136,136,0.15); border-radius:6px; color:#888; font-size:13px; font-weight:600;">
                    ${escapeHtml(statusLabel(params.oldStatus))}
                  </td>
                  <td style="padding:0 12px; color:#666; font-size:16px;">&rarr;</td>
                  <td style="padding:4px 12px; background:${color}22; border-radius:6px; color:${color}; font-size:13px; font-weight:600;">
                    ${escapeHtml(label)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        ${extraMessage}
        <div style="margin-top:24px;">
          <a href="${APP_URL}/agent/deals/${params.dealId}" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
            View Deal
          </a>
        </div>
      `),
  })
}

// ============================================================================
// Email: Document Requested → Agent
// ============================================================================

export async function sendDocumentRequestNotification(params: {
  dealId: string
  propertyAddress: string
  documentType: string
  agentEmail: string
  agentFirstName: string
  message?: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}): Promise<void> {
  const messageBlock = params.message
    ? `<div style="margin:16px 0 0; padding:12px 16px; background:#1E1E1E; border-left:3px solid #5FA873; border-radius:0 10px 10px 0; border:1px solid #2A2A2A; border-left:3px solid #5FA873;">
        <p style="margin:0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.message)}</p>
       </div>`
    : ''

  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Document Requested — ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Document Requested</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${escapeHtml(params.agentFirstName ?? '')}, Firm Funds has requested a document for your deal.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Property</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.propertyAddress ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Document Type</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:14px; font-weight:600;">${escapeHtml(params.documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        ${messageBlock}
        <div style="margin-top:24px;">
          <a href="${APP_URL}/agent/deals/${params.dealId}" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
            Upload Document
          </a>
        </div>
      `),
  })
}

// ============================================================================
// Email: Agent Invite → New Agent
// ============================================================================

// The legacy `tempPassword` parameter was removed for security.
// All callers now pass an invite token instead of sending credentials in email.
export async function sendAgentInviteNotification(params: {
  agentFirstName: string
  agentEmail: string
  brokerageName: string
  brokerageLogoUrl?: string | null
  inviteToken: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}): Promise<void> {
  const branding: BrokerageBranding | null = params.brokerageLogoUrl
    ? { logoUrl: params.brokerageLogoUrl, name: params.brokerageName }
    : null

  const inviteUrl = `${APP_URL}/invite/${params.inviteToken}`
  // Account-setup email — recipient cannot unsubscribe from being invited.
  // Marked transactional so we include the List-Unsubscribe header (mailbox
  // providers expect one) but bypass the preference check.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Welcome to ${params.brokerageName} — Set Up Your Account`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Welcome to ${escapeHtml(params.brokerageName)}!</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${escapeHtml(params.agentFirstName)}, your account is ready. Activate it now so ${escapeHtml(params.brokerageName)} can submit commission advance requests on your behalf — powered by Firm Funds.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Brokerage</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.brokerageName)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Email</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.agentEmail)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 20px; color:#737373; font-size:13px;">
          Click the button below to set your password and finish setup (ID verification + banking). This link expires in 72 hours.
        </p>
        <div style="text-align:center; margin:28px 0;">
          <a href="${inviteUrl}" style="display:inline-block; padding:16px 44px; background:#5FA873; color:#fff; text-decoration:none; border-radius:12px; font-weight:700; font-size:16px; letter-spacing:0.02em;">
            Activate My Account
          </a>
        </div>
        <p style="color:#666; font-size:12px;">If the button doesn't work, copy and paste this link into your browser:<br/>
          <a href="${inviteUrl}" style="color:#5FA873; word-break:break-all;">${inviteUrl}</a>
        </p>
      `, branding),
  })
}

// ============================================================================
// Email: Document Uploaded → Admin
// ============================================================================

export async function sendDocumentUploadedNotification(params: {
  dealId: string
  propertyAddress: string
  documentType: string
  fileName: string
  agentName: string
  uploaderRole: string
  uploaderName: string
}): Promise<void> {
  // Build escaped uploader name once; role labels are server-controlled so safe.
  const safeUploaderName = escapeHtml(params.uploaderName ?? '')

  let uploadedByText: string
  if (params.uploaderRole === 'brokerage_admin') {
    uploadedByText = `A brokerage admin (${safeUploaderName}) has uploaded a new document for review.`
  } else if (params.uploaderRole === 'agent') {
    uploadedByText = `${safeUploaderName} (Agent) has uploaded a new document for review.`
  } else {
    uploadedByText = `${safeUploaderName} has uploaded a new document for review.`
  }

  let uploadedByLabel = safeUploaderName
  if (params.uploaderRole === 'agent') {
    uploadedByLabel += ' (Agent)'
  } else if (params.uploaderRole === 'brokerage_admin') {
    uploadedByLabel += ' (Brokerage Admin)'
  }

  // Internal admin notification — transactional (admin cannot unsubscribe).
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`Document Uploaded — ${params.propertyAddress}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Document Uploaded</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          ${uploadedByText}
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Property</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.propertyAddress ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Uploaded By</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${uploadedByLabel}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Document Type</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">File</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.fileName ?? '')}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <a href="${APP_URL}/admin/deals/${params.dealId}" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
          Review Deal
        </a>
      `),
  })
}

// ============================================================================
// Email: Closing Date Alert → Admin (daily digest)
// ============================================================================

export async function sendClosingDateAlertDigest(params: {
  approachingDeals: { id: string; property_address: string; closing_date: string; days_until_closing: number; advance_amount: number; agent_name: string; status: string }[]
  overdueDeals: { id: string; property_address: string; closing_date: string; days_overdue: number; advance_amount: number; agent_name: string; status: string }[]
}): Promise<void> {
  if (params.approachingDeals.length === 0 && params.overdueDeals.length === 0) return

  const overdueRows = params.overdueDeals.map(d => `
    <tr>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#F87171; font-size:13px;">
        <a href="${APP_URL}/admin/deals/${d.id}" style="color:#F87171; text-decoration:none; font-weight:600;">${escapeHtml(d.property_address ?? '')}</a>
      </td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#F87171; font-size:13px;">${d.days_overdue} days overdue</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">${escapeHtml(d.agent_name ?? '')}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">${formatCurrency(d.advance_amount)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px; text-transform:capitalize;">${escapeHtml((d.status ?? '').replace(/_/g, ' '))}</td>
    </tr>
  `).join('')

  const approachingRows = params.approachingDeals.map(d => `
    <tr>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">
        <a href="${APP_URL}/admin/deals/${d.id}" style="color:#5FA873; text-decoration:none; font-weight:600;">${escapeHtml(d.property_address ?? '')}</a>
      </td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#FCD34D; font-size:13px;">${d.days_until_closing} days</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">${escapeHtml(d.agent_name ?? '')}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">${formatCurrency(d.advance_amount)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px; text-transform:capitalize;">${escapeHtml((d.status ?? '').replace(/_/g, ' '))}</td>
    </tr>
  `).join('')

  const tableHeader = `
    <tr>
      <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Property</td>
      <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Timeline</td>
      <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Agent</td>
      <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Advance</td>
      <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Status</td>
    </tr>`

  let body = `<h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Closing Date Alert</h2>`

  if (params.overdueDeals.length > 0) {
    body += `
      <p style="margin:0 0 12px; color:#F87171; font-weight:600; font-size:15px;">⚠ ${params.overdueDeals.length} Overdue Deal${params.overdueDeals.length !== 1 ? 's' : ''}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px; overflow:hidden;">
        ${tableHeader}${overdueRows}
      </table>`
  }

  if (params.approachingDeals.length > 0) {
    body += `
      <p style="margin:0 0 12px; color:#FCD34D; font-weight:600; font-size:15px;">${params.approachingDeals.length} Approaching Closing${params.approachingDeals.length !== 1 ? 's' : ''} (within 7 days)</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px; overflow:hidden;">
        ${tableHeader}${approachingRows}
      </table>`
  }

  body += `
    <a href="${APP_URL}/admin" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
      Open Dashboard
    </a>`

  // Internal admin digest — transactional (admin cannot unsubscribe).
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`Closing Date Alert — ${params.overdueDeals.length} overdue, ${params.approachingDeals.length} approaching`),
    transactional: true,
    html: wrap(body),
  })
}

// ============================================================================
// 8. KYC Mobile Upload Link
// ============================================================================

export async function sendKycMobileUploadLink(params: {
  agentEmail: string
  agentFirstName: string
  uploadUrl: string
  expiresInMinutes: number
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}) {
  const body = `
    <h2 style="margin:0 0 16px; color:#fff; font-size:20px;">Upload Your ID</h2>
    <p>Hi ${escapeHtml(params.agentFirstName ?? '')},</p>
    <p>You requested to upload your government-issued photo ID from your mobile device. Tap the button below to open the secure upload page.</p>
    <div style="text-align:center; margin:28px 0;">
      <a href="${params.uploadUrl}" style="display:inline-block; padding:16px 44px; background:#5FA873; color:#fff; text-decoration:none; border-radius:12px; font-weight:700; font-size:16px; letter-spacing:0.02em;">
        Upload My ID
      </a>
    </div>
    <p style="color:#737373; font-size:13px;">This link expires in ${params.expiresInMinutes} minutes and can only be used once.</p>
    <p style="color:#737373; font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`

  // KYC/identity verification is a regulatory/legal email — transactional so
  // it bypasses the recipient's preference flag.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject('Firm Funds — Upload Your ID From Your Phone'),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: wrap(body),
  })
}

// ============================================================================
// 9. KYC Approved → Agent
// ============================================================================

export async function sendKycApprovedNotification(params: {
  agentEmail: string
  agentFirstName: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}): Promise<void> {
  // KYC approval is a regulatory/legal notice — transactional.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`You're Verified — Start Submitting Advances on Firm Funds!`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: wrap(`
        <div style="text-align:center; padding:12px 0 24px;">
          <div style="display:inline-block; width:56px; height:56px; border-radius:50%; background:#0D2818; border:2px solid #1A4D2E; line-height:56px; font-size:28px;">✓</div>
        </div>
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; text-align:center;">Identity Verified!</h2>
        <p style="margin:0 0 20px; color:#E5E5E5; text-align:center;">
          Hi ${escapeHtml(params.agentFirstName ?? '')}, your government-issued ID has been verified successfully. Your account is now fully active.
        </p>
        <div style="padding:20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px; margin-bottom:24px;">
          <p style="margin:0 0 8px; color:#5FA873; font-weight:600; font-size:15px;">What you can do now:</p>
          <p style="margin:0 0 6px; color:#E5E5E5; font-size:14px;">• Submit commission advance requests</p>
          <p style="margin:0 0 6px; color:#E5E5E5; font-size:14px;">• Track your deal status in real time</p>
          <p style="margin:0; color:#E5E5E5; font-size:14px;">• Get funded before your deals close</p>
        </div>
        <div style="text-align:center;">
          <a href="${APP_URL}/agent" style="display:inline-block; padding:14px 36px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:15px;">
            Go to My Dashboard
          </a>
        </div>
      `),
  })
}

// ============================================================================
// Email: Document Returned → Agent
// ============================================================================

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
}): Promise<void> {
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Action Required — Document Returned for ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#F87171; font-size:20px;">Document Returned</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${escapeHtml(params.agentFirstName ?? '')}, a document for your deal has been returned and needs attention. This may cause delays in processing your advance.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Property</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.propertyAddress ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Document</td>
                  <td style="padding:6px 0; color:#F87171; font-size:14px; font-weight:600;">${escapeHtml(params.documentName ?? '')}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <div style="margin:16px 0; padding:12px 16px; background:#2A1212; border-left:3px solid #F87171; border-radius:0 8px 8px 0;">
          <p style="margin:0 0 4px; color:#F87171; font-size:12px; font-weight:600;">REASON FOR RETURN</p>
          <p style="margin:0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.reason ?? '')}</p>
        </div>
        <div style="margin-top:24px;">
          <a href="${APP_URL}/agent/deals/${params.dealId}#returned-docs" style="display:inline-block; padding:12px 28px; background:#F87171; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
            View & Fix Document
          </a>
        </div>
      `),
  })
}

// ============================================================================
// Email: Deal Message → Agent
// ============================================================================

export async function sendDealMessageNotification(params: {
  dealId: string
  propertyAddress: string
  agentEmail: string
  agentFirstName: string
  message: string
  senderName: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}): Promise<void> {
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    replyTo: 'support@firmfunds.ca',
    subject: sanitizeSubject(`Message from Firm Funds — ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">New Message</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${escapeHtml(params.agentFirstName)}, you have a new message regarding your deal.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          <tr>
            <td style="padding:8px 0; color:#737373; font-size:13px; width:100px;">Property</td>
            <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.propertyAddress)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#737373; font-size:13px;">From</td>
            <td style="padding:6px 0; color:#5FA873; font-size:14px; font-weight:600;">${escapeHtml(params.senderName)}</td>
          </tr>
        </table>
        <div style="margin:16px 0; padding:12px 16px; background:#1E1E1E; border-left:3px solid #5FA873; border-radius:0 10px 10px 0; border:1px solid #2A2A2A; border-left:3px solid #5FA873;">
          <p style="margin:0; color:#E5E5E5; font-size:14px; line-height:1.6;">${escapeHtml(params.message).replace(/\n/g, '<br>')}</p>
        </div>
        <div style="margin-top:24px;">
          <a href="${APP_URL}/agent/deals/${params.dealId}#messages" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
            Reply
          </a>
        </div>
      `),
  })
}

// ============================================================================
// Email: Invoice → Agent
// ============================================================================

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

  const lineItemsHtml = params.lineItems.map(item => `
    <tr>
      <td style="padding:8px 12px; color:#E5E5E5; font-size:13px; border-bottom:1px solid #333;">${escapeHtml(item.description ?? '')}</td>
      <td style="padding:8px 12px; color:#E5E5E5; font-size:13px; text-align:right; border-bottom:1px solid #333;">${formatMoney(item.amount)}</td>
    </tr>
  `).join('')

  // Invoices are billing/legal documents — transactional, must bypass the
  // recipient's promotional opt-out.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Invoice ${params.invoiceNumber} — ${formatMoney(params.amount)} Due`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#D4A04A; font-size:20px;">Invoice ${escapeHtml(params.invoiceNumber ?? '')}</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${escapeHtml(params.agentName ?? '')}, please find your invoice below for outstanding charges on your Firm Funds account.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Invoice #</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px; font-weight:600;">${escapeHtml(params.invoiceNumber ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Amount Due</td>
                  <td style="padding:6px 0; color:#D4A04A; font-size:16px; font-weight:700;">${formatMoney(params.amount)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Due Date</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(formatDateStr(params.dueDate))}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        ${params.lineItems.length > 0 ? `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px; overflow:hidden;">
          <tr style="background:#222;">
            <th style="padding:10px 12px; color:#999; font-size:12px; text-align:left; text-transform:uppercase;">Description</th>
            <th style="padding:10px 12px; color:#999; font-size:12px; text-align:right; text-transform:uppercase;">Amount</th>
          </tr>
          ${lineItemsHtml}
          <tr style="background:#222;">
            <td style="padding:10px 12px; color:#D4A04A; font-size:14px; font-weight:700;">Total</td>
            <td style="padding:10px 12px; color:#D4A04A; font-size:14px; font-weight:700; text-align:right;">${formatMoney(params.amount)}</td>
          </tr>
        </table>
        ` : ''}
        <p style="margin:16px 0; color:#737373; font-size:13px;">
          Please remit payment at your earliest convenience. If you have questions about this invoice, reply to this email or contact us at support@firmfunds.ca.
        </p>
        <div style="margin-top:24px;">
          <a href="${APP_URL}/agent" style="display:inline-block; padding:12px 28px; background:#D4A04A; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
            View My Account
          </a>
        </div>
      `),
  })
}

// ============================================================================
// Brokerage message notification — sent to admin when brokerage sends a message
// ============================================================================

export async function sendBrokerageMessageNotification(params: {
  dealId: string
  propertyAddress: string
  senderName: string
  message: string
}) {
  // Internal admin notification — transactional.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`Brokerage message: ${params.propertyAddress}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; font-size:20px; color:#fff;">New Message from Brokerage</h2>
        <p style="margin:0 0 8px; color:#E5E5E5;">${escapeHtml(params.senderName)} sent a message about <strong>${escapeHtml(params.propertyAddress)}</strong>:</p>
        <div style="margin:16px 0; padding:16px; background:#1A1A1A; border-left:3px solid #5FA873; border-radius:0 8px 8px 0;">
          <p style="margin:0; color:#E5E5E5; font-size:14px; white-space:pre-wrap;">${escapeHtml(params.message)}</p>
        </div>
        <div style="margin-top:24px;">
          <a href="${APP_URL}/admin/deals/${params.dealId}#messages" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
            View Deal & Reply
          </a>
        </div>
      `),
  })
}

// ============================================================================
// Brokerage deal status notification — sent to brokerage when deal status changes
// ============================================================================

export async function sendBrokerageStatusNotification(params: {
  brokerageEmail: string
  brokerageName: string
  propertyAddress: string
  agentName: string
  newStatus: string
  dealId: string
  /** Pass-through for per-brokerage unsubscribe handling (migration 092). */
  brokerageId?: string | null
}) {
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
    funded: '#1A7A2E',
    completed: '#5FB8A0',
    denied: '#EF4444',
    cancelled: '#9CA3AF',
  }

  const label = statusLabels[params.newStatus] || params.newStatus
  const color = statusColors[params.newStatus] || '#D4A04A'

  await sendEmailWithUnsubscribe({
    to: params.brokerageEmail,
    subject: sanitizeSubject(`Deal ${label}: ${params.propertyAddress}`),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    html: wrap(`
        <h2 style="margin:0 0 16px; font-size:20px; color:#fff;">Deal Status Update</h2>
        <p style="margin:0 0 16px; color:#E5E5E5;">A deal submitted by one of your agents has been updated.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:12px 16px; background:#1A1A1A; border-radius:8px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:4px 0; color:#737373; font-size:13px;">Property</td>
                  <td style="padding:4px 0; color:#fff; font-size:13px; text-align:right; font-weight:600;">${escapeHtml(params.propertyAddress ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0; color:#737373; font-size:13px;">Agent</td>
                  <td style="padding:4px 0; color:#fff; font-size:13px; text-align:right;">${escapeHtml(params.agentName ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0; color:#737373; font-size:13px;">New Status</td>
                  <td style="padding:4px 0; font-size:13px; text-align:right;">
                    <span style="display:inline-block; padding:4px 12px; background:${color}20; color:${color}; border-radius:4px; font-weight:600; font-size:12px;">${escapeHtml(label)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <div style="margin-top:24px;">
          <a href="${APP_URL}/brokerage" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
            View in Brokerage Portal
          </a>
        </div>
      `),
  })
}

// ============================================================================
// Brokerage Admin Invite Email
// ============================================================================

export async function sendBrokerageInviteNotification(params: {
  adminName: string
  adminEmail: string
  brokerageName: string
  inviteToken: string
  /** Pass-through for per-brokerage unsubscribe handling (migration 092). */
  brokerageId?: string | null
}): Promise<void> {
  const inviteUrl = `${APP_URL}/invite/${params.inviteToken}`

  // Account-setup email — transactional, recipient cannot opt out of getting
  // invited.
  await sendEmailWithUnsubscribe({
    to: params.adminEmail,
    subject: sanitizeSubject(`Welcome to Firm Funds — Set Up Your Brokerage Portal`),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Welcome to Firm Funds!</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${escapeHtml(params.adminName ?? '')}, your Firm Funds Brokerage Portal account has been created for <strong>${escapeHtml(params.brokerageName ?? '')}</strong>. You can now manage your agents' commission advance activity online.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Brokerage</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.brokerageName ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Email</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.adminEmail ?? '')}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 20px; color:#737373; font-size:13px;">
          Click the button below to set your password and access your brokerage portal. This link expires in 72 hours.
        </p>
        <div style="text-align:center; margin:28px 0;">
          <a href="${inviteUrl}" style="display:inline-block; padding:16px 44px; background:#5FA873; color:#fff; text-decoration:none; border-radius:12px; font-weight:700; font-size:16px; letter-spacing:0.02em;">
            Set Up My Account
          </a>
        </div>
        <p style="color:#666; font-size:12px;">If the button doesn't work, copy and paste this link into your browser:<br/>
          <a href="${inviteUrl}" style="color:#5FA873; word-break:break-all;">${inviteUrl}</a>
        </p>
      `),
  })
}

// ============================================================================
// Password Reset Email (admin-triggered)
// ============================================================================

export async function sendPasswordResetNotification(params: {
  recipientName: string
  recipientEmail: string
  inviteToken: string
  roleName: string // e.g. "Agent" or "Brokerage Admin"
}): Promise<void> {
  const resetUrl = `${APP_URL}/invite/${params.inviteToken}`

  // Password resets are security-critical — transactional. We do not attach
  // an entity here because the same reset flow services both agents and
  // brokerage admins and the caller doesn't necessarily know which.
  await sendEmailWithUnsubscribe({
    to: params.recipientEmail,
    subject: sanitizeSubject(`Firm Funds — Password Reset`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Password Reset</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${escapeHtml(params.recipientName ?? '')}, a Firm Funds administrator has reset your password. Please click the button below to set a new password.
        </p>
        <p style="margin:0 0 20px; color:#737373; font-size:13px;">
          This link expires in 72 hours. If you did not request this, please contact your administrator.
        </p>
        <div style="text-align:center; margin:28px 0;">
          <a href="${resetUrl}" style="display:inline-block; padding:16px 44px; background:#5FA873; color:#fff; text-decoration:none; border-radius:12px; font-weight:700; font-size:16px; letter-spacing:0.02em;">
            Set New Password
          </a>
        </div>
        <p style="color:#666; font-size:12px;">If the button doesn't work, copy and paste this link into your browser:<br/>
          <a href="${resetUrl}" style="color:#5FA873; word-break:break-all;">${resetUrl}</a>
        </p>
      `),
  })
}

// ============================================================================
// Email Change Notification
// ============================================================================

export async function sendEmailChangeNotification(params: {
  recipientName: string
  oldEmail: string
  newEmail: string
}): Promise<void> {
  // Security notification to the OLD email — transactional, no preference
  // check (we never want to suppress a "your account changed" warning).
  await sendEmailWithUnsubscribe({
    to: params.oldEmail,
    subject: sanitizeSubject(`Firm Funds — Your Login Email Has Been Changed`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Email Address Changed</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${escapeHtml(params.recipientName ?? '')}, your Firm Funds login email has been changed by an administrator.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Old Email</td>
                  <td style="padding:6px 0; color:#EF4444; font-size:14px;">${escapeHtml(params.oldEmail ?? '')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">New Email</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:14px;">${escapeHtml(params.newEmail ?? '')}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 20px; color:#737373; font-size:13px;">
          Please use your new email address to log in going forward. If you did not expect this change, contact Firm Funds immediately.
        </p>
      `),
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

export async function sendAgentPhoneChangedNotification(params: {
  recipientEmail: string
  recipientName: string
  oldPhoneLast4: string | null
  newPhoneLast4: string | null
  changedAtIso: string
}): Promise<void> {
  const oldDisplay = params.oldPhoneLast4 ? `*** *** ${params.oldPhoneLast4}` : 'not on file'
  const newDisplay = params.newPhoneLast4 ? `*** *** ${params.newPhoneLast4}` : 'cleared'

  // Security warning — transactional. Recipient must NOT be able to silence
  // these by unsubscribing.
  await sendEmailWithUnsubscribe({
    to: params.recipientEmail,
    subject: sanitizeSubject('Your Firm Funds phone number was updated'),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Phone Number Updated</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${escapeHtml(params.recipientName)}, the phone number on your Firm Funds agent profile was just updated.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Previous</td>
                  <td style="padding:6px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(oldDisplay)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Updated To</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:14px;">${escapeHtml(newDisplay)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">When</td>
                  <td style="padding:6px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(new Date(params.changedAtIso).toUTCString())}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 8px; color:#EF4444; font-size:13px;">
          If you didn't make this change, sign in, reset your password, and contact Firm Funds support at ${escapeHtml(ADMIN_EMAIL)}. Your session may be compromised.
        </p>
      `),
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

export async function sendBrokerageContactEmailConfirm(params: {
  brokerageName: string
  newEmail: string
  confirmUrl: string
  expiresAtIso: string
}): Promise<void> {
  const expiresLabel = new Date(params.expiresAtIso).toUTCString()

  // Email address change confirmation — transactional. Note we do NOT mint a
  // brokerage unsubscribe token here because the recipient may not yet be
  // the brokerage's confirmed contact.
  await sendEmailWithUnsubscribe({
    to: params.newEmail,
    subject: sanitizeSubject(`Confirm new contact email for ${params.brokerageName}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Confirm Your Email</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          A Firm Funds administrator at <strong>${escapeHtml(params.brokerageName)}</strong> requested that this address (${escapeHtml(params.newEmail)}) become the brokerage's primary contact email.
        </p>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Click the button below to confirm. The link expires on ${escapeHtml(expiresLabel)}.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
          <tr>
            <td style="background:#5FA873; border-radius:8px;">
              <a href="${escapeHtml(params.confirmUrl)}" style="display:inline-block; padding:12px 24px; color:#0A0A0A; font-weight:600; text-decoration:none;">Confirm Email Change</a>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 8px; color:#737373; font-size:13px;">
          If you didn't request this change, simply ignore this email. The brokerage's contact address will remain unchanged.
        </p>
      `),
  })
}

// ============================================================================
// Brokerage Contact Email Change-Requested Warning (to OLD address)
// ============================================================================
//
// Fires immediately when an admin requests the change, BEFORE the new address
// confirms. Gives the legitimate owner early warning of a possible stolen
// session even though the actual flip hasn't happened yet.

export async function sendBrokerageContactEmailChangeRequested(params: {
  brokerageName: string
  oldEmail: string
  newEmail: string
  expiresAtIso: string
}): Promise<void> {
  const expiresLabel = new Date(params.expiresAtIso).toUTCString()

  // Security warning to the OLD email — transactional, no preference check.
  await sendEmailWithUnsubscribe({
    to: params.oldEmail,
    subject: sanitizeSubject(`Contact email change requested for ${params.brokerageName}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Contact Email Change Requested</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi, a request was made to change the contact email for <strong>${escapeHtml(params.brokerageName)}</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Current Email</td>
                  <td style="padding:6px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(params.oldEmail)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Requested Email</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:14px;">${escapeHtml(params.newEmail)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Action Expires</td>
                  <td style="padding:6px 0; color:#E5E5E5; font-size:14px;">${escapeHtml(expiresLabel)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          The change will only take effect once someone at the requested address clicks the confirmation link in their inbox. Your current address will continue receiving all brokerage notifications until then.
        </p>
        <p style="margin:0 0 8px; color:#EF4444; font-size:13px;">
          If you didn't request this change, sign in immediately, change your password, and contact Firm Funds support at ${escapeHtml(ADMIN_EMAIL)}. Your administrator session may be compromised.
        </p>
      `),
  })
}

// ============================================================================
// Banking Submission Notification (to Admin)
// ============================================================================

export async function sendBankingSubmittedNotification(params: {
  agentName: string
  agentEmail: string
}) {
  // Internal admin notification — transactional.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`Banking Info Submitted — ${params.agentName}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:20px; font-weight:600;">
          Banking Info Submitted
        </h2>
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px;">
          <strong style="color:#E5E5E5;">${escapeHtml(params.agentName ?? '')}</strong> (${escapeHtml(params.agentEmail ?? '')}) has submitted their banking information for review and approval.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:12px 0;">
              <a href="${APP_URL}/admin" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
                Review Banking Info
              </a>
            </td>
          </tr>
        </table>
      `),
  })
}

// ============================================================================
// Banking Approval/Rejection Notification (to Agent)
// ============================================================================

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
    : 'Banking Info — Action Required'

  const body = params.approved
    ? `
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em; font-weight:600;">
          Banking Info Approved
        </h2>
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px;">
          Hi ${escapeHtml(params.agentName ?? '')}, your banking information has been verified and approved. You're all set to receive commission advances!
        </p>
      `
      : `
        <h2 style="margin:0 0 16px; color:#EF4444; font-size:20px; font-weight:600;">
          Banking Info Not Approved
        </h2>
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px;">
          Hi ${escapeHtml(params.agentName ?? '')}, your banking information could not be approved at this time.
        </p>
        ${params.reason ? `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:12px 16px; background:#2A1212; border:1px solid #4A2020; border-radius:8px;">
              <p style="margin:0; color:#E07B7B; font-size:13px; font-weight:600;">Reason:</p>
              <p style="margin:4px 0 0; color:#BCBBB8; font-size:14px;">${escapeHtml(params.reason)}</p>
            </td>
          </tr>
        </table>
        ` : ''}
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px;">
          Please update your banking information and resubmit.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:12px 0;">
              <a href="${APP_URL}/agent/profile" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
                Update Banking Info
              </a>
            </td>
          </tr>
        </table>
      `

  // Banking approval/rejection is an account-status notice — transactional.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(subject),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: wrap(body),
  })
}

// ============================================================================
// Agent Message Notification (to Admin — agent sent a message)
// ============================================================================

export async function sendAgentMessageNotification(params: {
  dealId: string
  propertyAddress: string
  agentName: string
  message: string
}) {
  // Internal admin notification — transactional.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`Message from ${params.agentName} — ${params.propertyAddress}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:20px; font-weight:600;">
          New Message from Agent
        </h2>
        <p style="margin:0 0 8px; color:#BCBBB8; font-size:14px;">
          <strong style="color:#7B9FE0;">${escapeHtml(params.agentName)}</strong> sent a message about <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress)}</strong>:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
          <tr>
            <td style="padding:12px 16px; background:#1A2240; border-left:3px solid #7B9FE0; border-radius:0 8px 8px 0;">
              <p style="margin:0; color:#E5E5E5; font-size:14px; line-height:1.5; white-space:pre-wrap;">${escapeHtml(params.message).replace(/\n/g, '<br/>')}</p>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:12px 0;">
              <a href="${APP_URL}/admin/messages" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
                View &amp; Reply
              </a>
            </td>
          </tr>
        </table>
      `),
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
   * payment check-in variant (always positive — by definition the check-in
   * fires after the due date has passed). Closing-day variant ignores it.
   */
  daysSinceDue?: number
  /** Pass-through for per-entity unsubscribe handling (migration 092). */
  agentId?: string | null
  brokerageId?: string | null
}

function formatReminderDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
}

function formatReminderCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
}

/** Closing day reminder — "Deal closed! Brokerage has the settlement window to remit payment." */
export async function sendSettlementReminderClosingDay(params: SettlementReminderParams) {
  const agentBody = wrap(`
    <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
      Closing Day — Payment Reminder
    </h2>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      Hi ${escapeHtml(params.agentFirstName ?? '')}, the expected closing date for <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong> has arrived.
    </p>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      Your brokerage has <strong style="color:#5FA873;">${params.daysRemaining} days</strong> to remit payment of <strong style="color:#E5E5E5;">${formatReminderCurrency(params.amountDueFromBrokerage)}</strong> to Firm Funds.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#1A2240; border-radius:8px;">
      <tr>
        <td style="padding:16px;">
          <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Payment Due Date</p>
          <p style="margin:0; color:#5FA873; font-size:18px; font-weight:600;">${escapeHtml(formatReminderDate(params.dueDate))}</p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:13px; line-height:1.5;">
      Late payment interest at 24% per annum (compounded daily) only begins accruing if the payment remains outstanding 30 days after closing. We will be in touch with your brokerage if payment is delayed.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:12px 0;">
          <a href="${APP_URL}/agent/deals/${params.dealId}" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
            View Deal
          </a>
        </td>
      </tr>
    </table>
  `)

  // Send to agent. Promotional-class reminder — entity preference is
  // honoured. If the agent has unsubscribed they won't get the nag.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Closing Day — Payment due by ${formatReminderDate(params.dueDate)} — ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: agentBody,
  })

  // Send to brokerage (when a primary contact email is on file).
  if (params.brokerageEmail) {
    await sendEmailWithUnsubscribe({
      to: params.brokerageEmail,
      subject: sanitizeSubject(`Closing Day — Payment due by ${formatReminderDate(params.dueDate)} — ${params.propertyAddress}`),
      entityType: params.brokerageId ? 'brokerage' : undefined,
      entityId: params.brokerageId ?? undefined,
      html: wrap(`
          <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
            Closing Day — Payment Reminder
          </h2>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            The expected closing date for <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong> (${escapeHtml(params.agentFirstName ?? '')}'s deal) has arrived.
          </p>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            Please remit payment of <strong style="color:#E5E5E5;">${formatReminderCurrency(params.amountDueFromBrokerage)}</strong> to Firm Funds by <strong style="color:#5FA873;">${escapeHtml(formatReminderDate(params.dueDate))}</strong>.
          </p>
        `),
    })
  }
}

/**
 * Payment check-in — fires after the brokerage's settlement window has
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
export async function sendSettlementReminderPaymentCheckIn(params: SettlementReminderParams) {
  const daysSinceDue = params.daysSinceDue ?? 0
  const daysAgoText = daysSinceDue === 1 ? '1 day ago' : `${daysSinceDue} days ago`
  const dueDateLabel = formatReminderDate(params.dueDate)
  const brokerageName = params.brokerageName ?? 'your brokerage'

  const agentBody = wrap(`
    <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
      Payment Check-In
    </h2>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      Hi ${escapeHtml(params.agentFirstName ?? '')}, we wanted to follow up on the payment for <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong>.
    </p>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      We haven't yet received the <strong style="color:#E5E5E5;">${formatReminderCurrency(params.amountDueFromBrokerage)}</strong> remittance from <strong style="color:#E5E5E5;">${escapeHtml(brokerageName)}</strong> for this advance. The settlement deadline was <strong style="color:#E5E5E5;">${escapeHtml(dueDateLabel)}</strong> (${daysAgoText}).
    </p>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      If the payment has already been sent, please disregard — there can be a 1-2 day delay in processing. If not, please follow up with your brokerage administrator.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#1A2240; border-radius:8px;">
      <tr>
        <td style="padding:16px;">
          <p style="margin:0; color:#BCBBB8; font-size:13px; line-height:1.5;">
            Late payment interest at 24% per annum (compounded daily) begins accruing 30 days after closing — there's still time to remit before that kicks in.
          </p>
        </td>
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:12px 0;">
          <a href="${APP_URL}/agent/deals/${params.dealId}" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
            View Deal
          </a>
        </td>
      </tr>
    </table>
  `)

  // Send to agent. Promotional-class reminder — entity preference is
  // honoured. If the agent has unsubscribed they won't get the nag.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Payment Check-In — ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: agentBody,
  })

  // Send to brokerage (when a primary contact email is on file). Same
  // toned-down wording, addressed to the brokerage.
  if (params.brokerageEmail) {
    await sendEmailWithUnsubscribe({
      to: params.brokerageEmail,
      subject: sanitizeSubject(`Payment Check-In — ${params.propertyAddress}`),
      entityType: params.brokerageId ? 'brokerage' : undefined,
      entityId: params.brokerageId ?? undefined,
      html: wrap(`
          <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
            Payment Check-In
          </h2>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            Hi ${escapeHtml(brokerageName)}, following up on the advance payment for <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong> (agent: ${escapeHtml(params.agentFirstName ?? '')}).
          </p>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            We haven't yet received your remittance of <strong style="color:#E5E5E5;">${formatReminderCurrency(params.amountDueFromBrokerage)}</strong>. The settlement deadline was <strong style="color:#E5E5E5;">${escapeHtml(dueDateLabel)}</strong> (${daysAgoText}).
          </p>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            If you've already sent it, please disregard. If not, please remit at your earliest convenience.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#1A2240; border-radius:8px;">
            <tr>
              <td style="padding:16px;">
                <p style="margin:0; color:#BCBBB8; font-size:13px; line-height:1.5;">
                  Late payment interest at 24% per annum (compounded daily) begins accruing 30 days after closing — there's still time to remit before that kicks in.
                </p>
              </td>
            </tr>
          </table>
        `),
    })
  }
}

// ============================================================================
// Closing Date Amendment Notifications
// ============================================================================

/** Notify admin that an agent has requested a closing date amendment */
export async function sendAmendmentRequestedNotification(params: {
  dealId: string
  propertyAddress: string
  agentName: string
  oldClosingDate: string
  newClosingDate: string
}) {
  // Internal admin notification — transactional.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`Closing Date Amendment Requested — ${params.propertyAddress}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
          Closing Date Amendment Requested
        </h2>
        <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
          <strong style="color:#7B9FE0;">${escapeHtml(params.agentName ?? '')}</strong> has requested a closing date amendment for <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#1A2240; border-radius:8px;">
          <tr>
            <td style="padding:16px;">
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Original Closing Date</p>
              <p style="margin:0 0 12px; color:#E5E5E5; font-size:16px; font-weight:600;">${escapeHtml(formatReminderDate(params.oldClosingDate))}</p>
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Proposed New Closing Date</p>
              <p style="margin:0; color:#5FA873; font-size:16px; font-weight:600;">${escapeHtml(formatReminderDate(params.newClosingDate))}</p>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 12px; color:#BCBBB8; font-size:13px; line-height:1.5;">
          The agent has uploaded the executed amendment document. Please review and approve or reject the request.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:12px 0;">
              <a href="${APP_URL}/admin/deals/${params.dealId}" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
                Review Amendment
              </a>
            </td>
          </tr>
        </table>
      `),
  })
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
}) {
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Amendment Approved — ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
          Closing Date Amendment Approved
        </h2>
        <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
          Hi ${escapeHtml(params.agentFirstName ?? '')}, your closing date amendment for <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong> has been approved.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#1A2240; border-radius:8px;">
          <tr>
            <td style="padding:16px;">
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">New Closing Date</p>
              <p style="margin:0 0 12px; color:#5FA873; font-size:16px; font-weight:600;">${escapeHtml(formatReminderDate(params.newClosingDate))}</p>
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Updated Advance Amount</p>
              <p style="margin:0; color:#E5E5E5; font-size:18px; font-weight:600;">${formatReminderCurrency(params.newAdvanceAmount)}</p>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 12px; color:#BCBBB8; font-size:13px; line-height:1.5;">
          You will receive a separate email from DocuSign with an Amendment to the Commission Purchase Agreement. Please review and sign it to finalize the amendment.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:12px 0;">
              <a href="${APP_URL}/agent/deals/${params.dealId}" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
                View Deal
              </a>
            </td>
          </tr>
        </table>
      `),
  })
}

// ============================================================================
// Monthly white-label profit-share statement → Brokerage (Session 34)
// ============================================================================

export async function sendMonthlyBrokerStatement(params: {
  toEmail: string
  brokerageName: string
  brokerageLogoUrl?: string | null
  periodLabel: string  // e.g. "April 2026"
  rows: Array<{
    propertyAddress: string
    agentName: string
    fundingDate: string | null
    discountFee: number
    pct: number
    brokerShare: number
    remitted: boolean
  }>
  totalEarned: number
  totalUnremitted: number
  /** Pass-through for per-brokerage unsubscribe handling (migration 092). */
  brokerageId?: string | null
}): Promise<void> {
  const branding: BrokerageBranding | null = params.brokerageLogoUrl
    ? { logoUrl: params.brokerageLogoUrl, name: params.brokerageName }
    : null

  const rowsHtml = params.rows.length === 0
    ? `<tr><td colspan="6" style="padding:18px; color:#737373; font-size:13px; text-align:center;">No funded or completed deals this period.</td></tr>`
    : params.rows.map(r => `
      <tr>
        <td style="padding:8px 12px; border-bottom:1px solid #2A2A2A; color:#E5E5E5; font-size:13px;">${escapeHtml(r.propertyAddress)}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #2A2A2A; color:#E5E5E5; font-size:13px;">${escapeHtml(r.agentName)}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #2A2A2A; color:#E5E5E5; font-size:13px;">${escapeHtml(r.fundingDate ?? '—')}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #2A2A2A; color:#E5E5E5; font-size:13px; text-align:right;">${formatCurrency(r.discountFee)}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #2A2A2A; color:#E5E5E5; font-size:13px; text-align:right;">${r.pct.toFixed(1)}%</td>
        <td style="padding:8px 12px; border-bottom:1px solid #2A2A2A; color:${r.remitted ? '#888' : '#5FA873'}; font-size:13px; text-align:right; font-weight:600;">
          ${formatCurrency(r.brokerShare)}${r.remitted ? '' : ' *'}
        </td>
      </tr>`).join('')

  const body = `
    <h2 style="margin:0 0 8px; color:#5FA873; font-size:22px; font-weight:700;">Monthly Profit-Share Statement</h2>
    <p style="margin:0 0 24px; color:#E5E5E5;">${escapeHtml(params.brokerageName)} — ${escapeHtml(params.periodLabel)}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px; overflow:hidden;">
      <tr>
        <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Property</td>
        <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Agent</td>
        <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Funded</td>
        <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; text-align:right;">Discount&nbsp;Fee</td>
        <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; text-align:right;">Share&nbsp;%</td>
        <td style="padding:8px 12px; border-bottom:2px solid #444; color:#999; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; text-align:right;">Your&nbsp;Share</td>
      </tr>
      ${rowsHtml}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:14px 18px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:#737373; font-size:12px;">Total earned this period</td>
              <td style="color:#E5E5E5; font-size:18px; font-weight:700; text-align:right;">${formatCurrency(params.totalEarned)}</td>
            </tr>
            <tr>
              <td style="color:#737373; font-size:12px; padding-top:6px;">Pending remittance (kept from commission)</td>
              <td style="color:#5FA873; font-size:14px; font-weight:600; text-align:right; padding-top:6px;">${formatCurrency(params.totalUnremitted)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 16px; color:#737373; font-size:12px; line-height:1.6;">
      * Pending remittance: this share has not yet been formally reconciled with Firm Funds. Per your white-label agreement, you retain this share from the commission you control at closing — there is no separate payment.
    </p>
    <a href="${APP_URL}/brokerage" style="display:inline-block; padding:12px 28px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px;">
      View dashboard
    </a>
  `

  await sendEmailWithUnsubscribe({
    to: params.toEmail,
    subject: sanitizeSubject(`${params.brokerageName} — Profit-Share Statement (${params.periodLabel})`),
    entityType: params.brokerageId ? 'brokerage' : undefined,
    entityId: params.brokerageId ?? undefined,
    html: wrap(body, branding),
  })
}

/** Notify agent that their closing date amendment was rejected */
export async function sendAmendmentRejectedNotification(params: {
  dealId: string
  propertyAddress: string
  agentEmail: string
  agentFirstName: string
  reason: string
  /** Pass-through for per-agent unsubscribe handling (migration 092). */
  agentId?: string | null
}) {
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Amendment Rejected — ${params.propertyAddress}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
          Closing Date Amendment Rejected
        </h2>
        <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
          Hi ${escapeHtml(params.agentFirstName ?? '')}, your closing date amendment for <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong> was not approved.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#2A1A1A; border:1px solid #E54B4B33; border-radius:8px;">
          <tr>
            <td style="padding:16px;">
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Reason</p>
              <p style="margin:0; color:#E5E5E5; font-size:14px; line-height:1.5;">${escapeHtml(params.reason ?? '')}</p>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 12px; color:#BCBBB8; font-size:13px; line-height:1.5;">
          If you have any questions, please contact us or reply to this email.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:12px 0;">
              <a href="${APP_URL}/agent/deals/${params.dealId}" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
                View Deal
              </a>
            </td>
          </tr>
        </table>
      `),
  })
}

// ============================================================================
// Brokerage submitted a payment claim → notify admin
// ============================================================================

export async function sendPaymentClaimSubmittedNotification(params: {
  dealId: string
  propertyAddress: string
  brokerageName: string
  agentName: string
  amount: number
  paymentDate: string
  method?: string
  reference?: string
}) {
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

  // Internal admin notification — transactional.
  await sendEmailWithUnsubscribe({
    to: ADMIN_EMAIL,
    subject: sanitizeSubject(`New payment claim — ${params.brokerageName} — ${formatReminderCurrency(params.amount)}`),
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
          New Payment Claim Submitted
        </h2>
        <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
          <strong style="color:#7B9FE0;">${escapeHtml(params.brokerageName ?? '')}</strong> has submitted a payment claim for <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#1A2240; border-radius:8px;">
          <tr>
            <td style="padding:16px;">
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Amount</p>
              <p style="margin:0 0 12px; color:#5FA873; font-size:18px; font-weight:600;">${formatReminderCurrency(params.amount)}</p>
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Agent</p>
              <p style="margin:0 0 12px; color:#E5E5E5; font-size:14px; font-weight:600;">${escapeHtml(params.agentName ?? '')}</p>
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Payment Date</p>
              <p style="margin:0 0 12px; color:#E5E5E5; font-size:14px; font-weight:600;">${escapeHtml(formatReminderDate(params.paymentDate))}</p>
              <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Method</p>
              <p style="margin:0 0 12px; color:#E5E5E5; font-size:14px; font-weight:600;">${methodLabel}</p>
              ${params.reference ? `
                <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Reference</p>
                <p style="margin:0; color:#E5E5E5; font-size:14px; font-weight:600;">${escapeHtml(params.reference)}</p>
              ` : ''}
            </td>
          </tr>
        </table>
        <p style="margin:0 0 12px; color:#BCBBB8; font-size:13px; line-height:1.5;">
          The claim is sitting in pending status until you confirm a bank match or reject it.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:12px 0;">
              <a href="${APP_URL}/admin/payments" style="display:inline-block; padding:12px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
                Review Payment Claim
              </a>
            </td>
          </tr>
        </table>
      `),
  })
}

// ============================================================================
// Email: Failed-to-close cure election notice → Agent
// CPA Article 5.5 — agent must elect cash or commission assignment within 15 days
// ============================================================================

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

  const failureExplanation = params.failureType === 'non_closing'
    ? `Because the transaction did not close, the full Purchase Price you received from Firm Funds is owed back, in accordance with Article 5.1 of your Commission Purchase Agreement.`
    : `Because the commission received was less than the Face Value, the shortfall is owed back, in accordance with Article 5.2 of your Commission Purchase Agreement.`

  // Cure election is a contractual/legal notice — transactional, bypasses
  // the recipient's promotional opt-out.
  await sendEmailWithUnsubscribe({
    to: params.agentEmail,
    subject: sanitizeSubject(`Action required: Your funded deal at ${params.propertyAddress} ${failureLabel}`),
    entityType: params.agentId ? 'agent' : undefined,
    entityId: params.agentId ?? undefined,
    transactional: true,
    html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:20px;">Action Required — Choose Your Repayment Method</h2>
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px; line-height:1.6;">
          Hi ${escapeHtml(params.agentFirstName ?? '')}, we wanted to let you know that your funded deal at <strong style="color:#E5E5E5;">${escapeHtml(params.propertyAddress ?? '')}</strong> ${failureLabel}.
        </p>
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px; line-height:1.6;">
          ${failureExplanation}
        </p>

        <!-- Outstanding balance highlight -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px; background:#2A1A1A; border:1px solid #E54B4B33; border-radius:10px;">
          <tr>
            <td style="padding:18px; text-align:center;">
              <p style="margin:0 0 4px; color:#BCBBB8; font-size:11px; text-transform:uppercase; letter-spacing:0.06em;">Outstanding Balance</p>
              <p style="margin:0 0 6px; color:#F87171; font-size:28px; font-weight:700; letter-spacing:-0.01em;">${amountFmt}</p>
              <p style="margin:0; color:#BCBBB8; font-size:12px;">Charged to your Firm Funds account</p>
            </td>
          </tr>
        </table>

        <h3 style="margin:24px 0 12px; color:#E5E5E5; font-size:16px;">You must choose one of two repayment methods</h3>
        <p style="margin:0 0 16px; color:#BCBBB8; font-size:13px; line-height:1.6;">
          Per Article 5.5 of your Commission Purchase Agreement, you have <strong style="color:#5FA873;">until ${deadlineFmt}</strong> (15 calendar days) to make your election.
        </p>

        <!-- Option A: Cash -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px; background:#1A1A1A; border:1px solid #333; border-radius:10px;">
          <tr>
            <td style="padding:18px;">
              <p style="margin:0 0 6px; color:#E5E5E5; font-size:14px; font-weight:700;">Option A — Cash Repayment</p>
              <p style="margin:0; color:#BCBBB8; font-size:13px; line-height:1.5;">
                Pay the full outstanding balance from your own funds by electronic funds transfer within 30 days.
              </p>
            </td>
          </tr>
        </table>

        <!-- Option B: Commission assignment -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px; background:#1A1A1A; border:1px solid #333; border-radius:10px;">
          <tr>
            <td style="padding:18px;">
              <p style="margin:0 0 6px; color:#E5E5E5; font-size:14px; font-weight:700;">Option B — Assign Next Commission(s)</p>
              <p style="margin:0; color:#BCBBB8; font-size:13px; line-height:1.5;">
                Sign a Remediation Direction to Pay that directs your brokerage to remit your next eligible commission(s) to Firm Funds until the balance is satisfied. No discount fee or settlement fee applies — this is not a new advance.
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 16px; color:#BCBBB8; font-size:12px; line-height:1.5;">
          If you do not make a written election by ${deadlineFmt}, you will be deemed to have elected cash repayment, and the full balance will become immediately due. Interest of 24% per annum, compounded daily, will accrue on any unpaid balance starting on the 31st day.
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
          <tr>
            <td align="center" style="padding:8px 0;">
              <a href="${APP_URL}/agent/account/cure-election/${params.dealId}" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
                Make Your Election
              </a>
            </td>
          </tr>
        </table>

        <p style="margin:24px 0 0; color:#737373; font-size:12px; line-height:1.5;">
          Questions? Reply to this email and we'll help you through it.
        </p>
      `),
  })
}
