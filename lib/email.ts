import { Resend } from 'resend'

// ============================================================================
// Resend client (lazy singleton)
// ============================================================================

let resendClient: Resend | null = null

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — emails disabled')
    return null
  }
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY)
  }
  return resendClient
}

// ============================================================================
// Constants
// ============================================================================

const FROM_ADDRESS = 'Firm Funds <notifications@firmfunds.ca>'
const ADMIN_EMAIL = 'bud@firmfunds.ca'
const APP_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'

// ============================================================================
// Branded HTML wrapper
// ============================================================================

function wrap(body: string): string {
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
            <td style="padding:0 0 32px; text-align:center;">
              <img src="${APP_URL}/brand/white.png" alt="Firm Funds" height="36" style="height:36px; width:auto;" />
            </td>
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
                Firm Funds Incorporated &bull; Ontario, Canada
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
  const resend = getResend()
  if (!resend) return

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: ADMIN_EMAIL,
      subject: `New Deal Submitted — ${params.propertyAddress}`,
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
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px; font-weight:600;">${params.propertyAddress}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Agent</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.agentName}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Brokerage</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.brokerageName}</td>
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
  } catch (err) {
    console.error('[email] Failed to send new deal notification:', err)
  }
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
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.brokerageAdminEmail,
      subject: `New Advance Request — ${params.agentName} — ${params.propertyAddress}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">New Advance Request</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${params.brokerageAdminFirstName}, one of your agents has submitted a commission advance request through Firm Funds.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Agent</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px; font-weight:600;">${params.agentName}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Property</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.propertyAddress}</td>
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
  } catch (err) {
    console.error('[email] Failed to send brokerage admin new deal notification:', err)
  }
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
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

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
        <p style="margin:0; color:#E5E5E5; font-size:14px;">${params.denialReason}</p>
      </div>`
  }

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: params.newStatus === 'approved'
        ? `Good News — Your Advance for ${params.propertyAddress} is Approved!`
        : params.newStatus === 'funded'
        ? `Funds on the Way — ${params.propertyAddress}`
        : params.newStatus === 'denied'
        ? `Advance Update — ${params.propertyAddress}`
        : `Deal Update: ${params.propertyAddress} — ${label}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:20px;">Deal Status Updated</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${params.agentFirstName}, the status of your deal has been updated.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px; background:#222; border-radius:8px;">
              <p style="margin:0 0 12px; color:#E5E5E5; font-size:15px; font-weight:600;">${params.propertyAddress}</p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:4px 12px; background:rgba(136,136,136,0.15); border-radius:6px; color:#888; font-size:13px; font-weight:600;">
                    ${statusLabel(params.oldStatus)}
                  </td>
                  <td style="padding:0 12px; color:#666; font-size:16px;">&rarr;</td>
                  <td style="padding:4px 12px; background:${color}22; border-radius:6px; color:${color}; font-size:13px; font-weight:600;">
                    ${label}
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
  } catch (err) {
    console.error('[email] Failed to send status change notification:', err)
  }
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
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  const messageBlock = params.message
    ? `<div style="margin:16px 0 0; padding:12px 16px; background:#1E1E1E; border-left:3px solid #5FA873; border-radius:0 10px 10px 0; border:1px solid #2A2A2A; border-left:3px solid #5FA873;">
        <p style="margin:0; color:#E5E5E5; font-size:14px;">${params.message}</p>
       </div>`
    : ''

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: `Document Requested — ${params.propertyAddress}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Document Requested</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${params.agentFirstName}, Firm Funds has requested a document for your deal.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Property</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.propertyAddress}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Document Type</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:14px; font-weight:600;">${params.documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</td>
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
  } catch (err) {
    console.error('[email] Failed to send document request notification:', err)
  }
}

// ============================================================================
// Email: Agent Invite → New Agent
// ============================================================================

export async function sendAgentInviteNotification(params: {
  agentFirstName: string
  agentEmail: string
  brokerageName: string
  tempPassword?: string  // DEPRECATED — kept for backward compat, prefer inviteToken
  inviteToken?: string
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  // Magic link invite (new flow) — no temp password in email
  if (params.inviteToken) {
    const inviteUrl = `${APP_URL}/invite/${params.inviteToken}`
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: params.agentEmail,
        subject: `Welcome to Firm Funds — Set Up Your Account`,
        html: wrap(`
          <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Welcome to Firm Funds!</h2>
          <p style="margin:0 0 20px; color:#E5E5E5;">
            Hi ${params.agentFirstName}, your Firm Funds portal account has been created. You can now submit commission advance requests online.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
            <tr>
              <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Brokerage</td>
                    <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.brokerageName}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0; color:#737373; font-size:13px;">Email</td>
                    <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.agentEmail}</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 20px; color:#737373; font-size:13px;">
            Click the button below to set your password and get started. This link expires in 72 hours.
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
    } catch (err) {
      console.error('[email] Failed to send agent invite notification:', err)
    }
    return
  }

  // Legacy temp password flow (fallback, should not be used for new invites)
  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: `Welcome to Firm Funds — Your Account is Ready`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Welcome to Firm Funds!</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${params.agentFirstName}, your Firm Funds portal account has been created. You can now submit commission advance requests online.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Brokerage</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.brokerageName}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Email</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.agentEmail}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Temporary Password</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:14px; font-weight:600;">${params.tempPassword}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 20px; color:#737373; font-size:13px;">
          Please change your password after your first login.
        </p>
        <a href="${APP_URL}/login" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
          Log In to Firm Funds
        </a>
      `),
    })
  } catch (err) {
    console.error('[email] Failed to send agent invite notification:', err)
  }
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
  const resend = getResend()
  if (!resend) return

  // Generate role-aware message
  let uploadedByText: string
  if (params.uploaderRole === 'brokerage_admin') {
    uploadedByText = `A brokerage admin (${params.uploaderName}) has uploaded a new document for review.`
  } else if (params.uploaderRole === 'agent') {
    uploadedByText = `${params.uploaderName} (Agent) has uploaded a new document for review.`
  } else {
    uploadedByText = `${params.uploaderName} has uploaded a new document for review.`
  }

  // Generate uploaded by label
  let uploadedByLabel = `${params.uploaderName}`
  if (params.uploaderRole === 'agent') {
    uploadedByLabel += ' (Agent)'
  } else if (params.uploaderRole === 'brokerage_admin') {
    uploadedByLabel += ' (Brokerage Admin)'
  }

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: ADMIN_EMAIL,
      subject: `Document Uploaded — ${params.propertyAddress}`,
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
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.propertyAddress}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Uploaded By</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${uploadedByLabel}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Document Type</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">File</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.fileName}</td>
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
  } catch (err) {
    console.error('[email] Failed to send document uploaded notification:', err)
  }
}

// ============================================================================
// Email: Closing Date Alert → Admin (daily digest)
// ============================================================================

export async function sendClosingDateAlertDigest(params: {
  approachingDeals: { id: string; property_address: string; closing_date: string; days_until_closing: number; advance_amount: number; agent_name: string; status: string }[]
  overdueDeals: { id: string; property_address: string; closing_date: string; days_overdue: number; advance_amount: number; agent_name: string; status: string }[]
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  if (params.approachingDeals.length === 0 && params.overdueDeals.length === 0) return

  const overdueRows = params.overdueDeals.map(d => `
    <tr>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#F87171; font-size:13px;">
        <a href="${APP_URL}/admin/deals/${d.id}" style="color:#F87171; text-decoration:none; font-weight:600;">${d.property_address}</a>
      </td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#F87171; font-size:13px;">${d.days_overdue} days overdue</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">${d.agent_name}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">${formatCurrency(d.advance_amount)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px; text-transform:capitalize;">${d.status.replace(/_/g, ' ')}</td>
    </tr>
  `).join('')

  const approachingRows = params.approachingDeals.map(d => `
    <tr>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">
        <a href="${APP_URL}/admin/deals/${d.id}" style="color:#5FA873; text-decoration:none; font-weight:600;">${d.property_address}</a>
      </td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#FCD34D; font-size:13px;">${d.days_until_closing} days</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">${d.agent_name}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px;">${formatCurrency(d.advance_amount)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #333; color:#E5E5E5; font-size:13px; text-transform:capitalize;">${d.status.replace(/_/g, ' ')}</td>
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

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: ADMIN_EMAIL,
      subject: `Closing Date Alert — ${params.overdueDeals.length} overdue, ${params.approachingDeals.length} approaching`,
      html: wrap(body),
    })
  } catch (err) {
    console.error('[email] Failed to send closing date alert digest:', err)
  }
}

// ============================================================================
// 8. KYC Mobile Upload Link
// ============================================================================

export async function sendKycMobileUploadLink(params: {
  agentEmail: string
  agentFirstName: string
  uploadUrl: string
  expiresInMinutes: number
}) {
  const resend = getResend()
  if (!resend) return

  const body = `
    <h2 style="margin:0 0 16px; color:#fff; font-size:20px;">Upload Your ID</h2>
    <p>Hi ${params.agentFirstName},</p>
    <p>You requested to upload your government-issued photo ID from your mobile device. Tap the button below to open the secure upload page.</p>
    <div style="text-align:center; margin:28px 0;">
      <a href="${params.uploadUrl}" style="display:inline-block; padding:16px 44px; background:#5FA873; color:#fff; text-decoration:none; border-radius:12px; font-weight:700; font-size:16px; letter-spacing:0.02em;">
        Upload My ID
      </a>
    </div>
    <p style="color:#737373; font-size:13px;">This link expires in ${params.expiresInMinutes} minutes and can only be used once.</p>
    <p style="color:#737373; font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: 'Firm Funds — Upload Your ID From Your Phone',
      html: wrap(body),
    })
  } catch (err) {
    console.error('[email] Failed to send KYC mobile upload link:', err)
  }
}

// ============================================================================
// 9. KYC Approved → Agent
// ============================================================================

export async function sendKycApprovedNotification(params: {
  agentEmail: string
  agentFirstName: string
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: `You're Verified — Start Submitting Advances on Firm Funds!`,
      html: wrap(`
        <div style="text-align:center; padding:12px 0 24px;">
          <div style="display:inline-block; width:56px; height:56px; border-radius:50%; background:#0D2818; border:2px solid #1A4D2E; line-height:56px; font-size:28px;">✓</div>
        </div>
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; text-align:center;">Identity Verified!</h2>
        <p style="margin:0 0 20px; color:#E5E5E5; text-align:center;">
          Hi ${params.agentFirstName}, your government-issued ID has been verified successfully. Your account is now fully active.
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
  } catch (err) {
    console.error('[email] Failed to send KYC approved notification:', err)
  }
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
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: `Action Required — Document Returned for ${params.propertyAddress}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#F87171; font-size:20px;">Document Returned</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${params.agentFirstName}, a document for your deal has been returned and needs attention. This may cause delays in processing your advance.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Property</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.propertyAddress}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Document</td>
                  <td style="padding:6px 0; color:#F87171; font-size:14px; font-weight:600;">${params.documentName}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <div style="margin:16px 0; padding:12px 16px; background:#2A1212; border-left:3px solid #F87171; border-radius:0 8px 8px 0;">
          <p style="margin:0 0 4px; color:#F87171; font-size:12px; font-weight:600;">REASON FOR RETURN</p>
          <p style="margin:0; color:#E5E5E5; font-size:14px;">${params.reason}</p>
        </div>
        <div style="margin-top:24px;">
          <a href="${APP_URL}/agent/deals/${params.dealId}#returned-docs" style="display:inline-block; padding:12px 28px; background:#F87171; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
            View & Fix Document
          </a>
        </div>
      `),
    })
  } catch (err) {
    console.error('[email] Failed to send document return notification:', err)
  }
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
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      replyTo: 'support@firmfunds.ca',
      to: params.agentEmail,
      subject: `Message from Firm Funds — ${params.propertyAddress}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">New Message</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${params.agentFirstName}, you have a new message regarding your deal.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          <tr>
            <td style="padding:8px 0; color:#737373; font-size:13px; width:100px;">Property</td>
            <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.propertyAddress}</td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#737373; font-size:13px;">From</td>
            <td style="padding:6px 0; color:#5FA873; font-size:14px; font-weight:600;">${params.senderName}</td>
          </tr>
        </table>
        <div style="margin:16px 0; padding:12px 16px; background:#1E1E1E; border-left:3px solid #5FA873; border-radius:0 10px 10px 0; border:1px solid #2A2A2A; border-left:3px solid #5FA873;">
          <p style="margin:0; color:#E5E5E5; font-size:14px; line-height:1.6;">${params.message.replace(/\n/g, '<br>')}</p>
        </div>
        <div style="margin-top:24px;">
          <a href="${APP_URL}/agent/deals/${params.dealId}#messages" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
            Reply
          </a>
        </div>
      `),
    })
  } catch (err) {
    console.error('[email] Failed to send deal message notification:', err)
  }
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
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  const formatMoney = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
  const formatDateStr = (d: string) => new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })

  const lineItemsHtml = params.lineItems.map(item => `
    <tr>
      <td style="padding:8px 12px; color:#E5E5E5; font-size:13px; border-bottom:1px solid #333;">${item.description}</td>
      <td style="padding:8px 12px; color:#E5E5E5; font-size:13px; text-align:right; border-bottom:1px solid #333;">${formatMoney(item.amount)}</td>
    </tr>
  `).join('')

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: `Invoice ${params.invoiceNumber} — ${formatMoney(params.amount)} Due`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#D4A04A; font-size:20px;">Invoice ${params.invoiceNumber}</h2>
        <p style="margin:0 0 20px; color:#999;">
          Hi ${params.agentName}, please find your invoice below for outstanding charges on your Firm Funds account.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Invoice #</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px; font-weight:600;">${params.invoiceNumber}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Amount Due</td>
                  <td style="padding:6px 0; color:#D4A04A; font-size:16px; font-weight:700;">${formatMoney(params.amount)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Due Date</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${formatDateStr(params.dueDate)}</td>
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
  } catch (err) {
    console.error('[email] Failed to send invoice notification:', err)
  }
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
  try {
    const resend = getResend()
    if (!resend) return

    await resend.emails.send({
      from: FROM_ADDRESS,
      to: ADMIN_EMAIL,
      subject: `Brokerage message: ${params.propertyAddress}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; font-size:20px; color:#fff;">New Message from Brokerage</h2>
        <p style="margin:0 0 8px; color:#E5E5E5;">${params.senderName} sent a message about <strong>${params.propertyAddress}</strong>:</p>
        <div style="margin:16px 0; padding:16px; background:#1A1A1A; border-left:3px solid #5FA873; border-radius:0 8px 8px 0;">
          <p style="margin:0; color:#E5E5E5; font-size:14px; white-space:pre-wrap;">${params.message}</p>
        </div>
        <div style="margin-top:24px;">
          <a href="${APP_URL}/admin/deals/${params.dealId}#messages" style="display:inline-block; padding:14px 32px; background:#5FA873; color:#fff; text-decoration:none; border-radius:10px; font-weight:700; font-size:14px; letter-spacing:0.02em;">
            View Deal & Reply
          </a>
        </div>
      `),
    })
  } catch (err) {
    console.error('[email] Failed to send brokerage message notification:', err)
  }
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
}) {
  try {
    const resend = getResend()
    if (!resend) return

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

    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.brokerageEmail,
      subject: `Deal ${label}: ${params.propertyAddress}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; font-size:20px; color:#fff;">Deal Status Update</h2>
        <p style="margin:0 0 16px; color:#E5E5E5;">A deal submitted by one of your agents has been updated.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:12px 16px; background:#1A1A1A; border-radius:8px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:4px 0; color:#737373; font-size:13px;">Property</td>
                  <td style="padding:4px 0; color:#fff; font-size:13px; text-align:right; font-weight:600;">${params.propertyAddress}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0; color:#737373; font-size:13px;">Agent</td>
                  <td style="padding:4px 0; color:#fff; font-size:13px; text-align:right;">${params.agentName}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0; color:#737373; font-size:13px;">New Status</td>
                  <td style="padding:4px 0; font-size:13px; text-align:right;">
                    <span style="display:inline-block; padding:4px 12px; background:${color}20; color:${color}; border-radius:4px; font-weight:600; font-size:12px;">${label}</span>
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
  } catch (err) {
    console.error('[email] Failed to send brokerage status notification:', err)
  }
}

// ============================================================================
// Brokerage Admin Invite Email
// ============================================================================

export async function sendBrokerageInviteNotification(params: {
  adminName: string
  adminEmail: string
  brokerageName: string
  inviteToken: string
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  const inviteUrl = `${APP_URL}/invite/${params.inviteToken}`

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.adminEmail,
      subject: `Welcome to Firm Funds — Set Up Your Brokerage Portal`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Welcome to Firm Funds!</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${params.adminName}, your Firm Funds Brokerage Portal account has been created for <strong>${params.brokerageName}</strong>. You can now manage your agents' commission advance activity online.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Brokerage</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.brokerageName}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">Email</td>
                  <td style="padding:8px 0; color:#E5E5E5; font-size:14px;">${params.adminEmail}</td>
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
  } catch (err) {
    console.error('[email] Failed to send brokerage invite notification:', err)
  }
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
  const resend = getResend()
  if (!resend) return

  const resetUrl = `${APP_URL}/invite/${params.inviteToken}`

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.recipientEmail,
      subject: `Firm Funds — Password Reset`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Password Reset</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${params.recipientName}, a Firm Funds administrator has reset your password. Please click the button below to set a new password.
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
  } catch (err) {
    console.error('[email] Failed to send password reset notification:', err)
  }
}

// ============================================================================
// Email Change Notification
// ============================================================================

export async function sendEmailChangeNotification(params: {
  recipientName: string
  oldEmail: string
  newEmail: string
}): Promise<void> {
  const resend = getResend()
  if (!resend) return

  try {
    // Notify old email
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.oldEmail,
      subject: `Firm Funds — Your Login Email Has Been Changed`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em;">Email Address Changed</h2>
        <p style="margin:0 0 20px; color:#E5E5E5;">
          Hi ${params.recipientName}, your Firm Funds login email has been changed by an administrator.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:16px 20px; background:#1E1E1E; border:1px solid #2A2A2A; border-radius:12px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px; width:140px;">Old Email</td>
                  <td style="padding:6px 0; color:#EF4444; font-size:14px;">${params.oldEmail}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#737373; font-size:13px;">New Email</td>
                  <td style="padding:6px 0; color:#5FA873; font-size:14px;">${params.newEmail}</td>
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
  } catch (err) {
    console.error('[email] Failed to send email change notification:', err)
  }
}

// ============================================================================
// Banking Submission Notification (to Admin)
// ============================================================================

export async function sendBankingSubmittedNotification(params: {
  agentName: string
  agentEmail: string
}) {
  const resend = getResend()
  if (!resend) return

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: ADMIN_EMAIL,
      subject: `Banking Info Submitted — ${params.agentName}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:20px; font-weight:600;">
          Banking Info Submitted
        </h2>
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px;">
          <strong style="color:#E5E5E5;">${params.agentName}</strong> (${params.agentEmail}) has submitted their banking information for review and approval.
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
  } catch (err) {
    console.error('[email] Failed to send banking submitted notification:', err)
  }
}

// ============================================================================
// Banking Approval/Rejection Notification (to Agent)
// ============================================================================

export async function sendBankingApprovalNotification(params: {
  agentEmail: string
  agentName: string
  approved: boolean
  reason?: string
}) {
  const resend = getResend()
  if (!resend) return

  try {
    const subject = params.approved
      ? 'Banking Info Approved'
      : 'Banking Info — Action Required'

    const body = params.approved
      ? `
        <h2 style="margin:0 0 16px; color:#5FA873; font-size:22px; font-weight:700; letter-spacing:-0.01em; font-weight:600;">
          Banking Info Approved
        </h2>
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px;">
          Hi ${params.agentName}, your banking information has been verified and approved. You're all set to receive commission advances!
        </p>
      `
      : `
        <h2 style="margin:0 0 16px; color:#EF4444; font-size:20px; font-weight:600;">
          Banking Info Not Approved
        </h2>
        <p style="margin:0 0 20px; color:#BCBBB8; font-size:14px;">
          Hi ${params.agentName}, your banking information could not be approved at this time.
        </p>
        ${params.reason ? `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td style="padding:12px 16px; background:#2A1212; border:1px solid #4A2020; border-radius:8px;">
              <p style="margin:0; color:#E07B7B; font-size:13px; font-weight:600;">Reason:</p>
              <p style="margin:4px 0 0; color:#BCBBB8; font-size:14px;">${params.reason}</p>
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

    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject,
      html: wrap(body),
    })
  } catch (err) {
    console.error('[email] Failed to send banking approval notification:', err)
  }
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
  const resend = getResend()
  if (!resend) return

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: ADMIN_EMAIL,
      subject: `Message from ${params.agentName} — ${params.propertyAddress}`,
      html: wrap(`
        <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:20px; font-weight:600;">
          New Message from Agent
        </h2>
        <p style="margin:0 0 8px; color:#BCBBB8; font-size:14px;">
          <strong style="color:#7B9FE0;">${params.agentName}</strong> sent a message about <strong style="color:#E5E5E5;">${params.propertyAddress}</strong>:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
          <tr>
            <td style="padding:12px 16px; background:#1A2240; border-left:3px solid #7B9FE0; border-radius:0 8px 8px 0;">
              <p style="margin:0; color:#E5E5E5; font-size:14px; line-height:1.5; white-space:pre-wrap;">${params.message.replace(/\n/g, '<br/>')}</p>
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
  } catch (err) {
    console.error('[email] Failed to send agent message notification:', err)
  }
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
  daysRemaining: number // 14, 7, or 3
}

function formatReminderDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
}

function formatReminderCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
}

/** Closing day reminder — "Deal closed! Brokerage has 14 days to remit payment." */
export async function sendSettlementReminderClosingDay(params: SettlementReminderParams) {
  const resend = getResend()
  if (!resend) return

  const agentBody = wrap(`
    <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
      Closing Day — Payment Reminder
    </h2>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      Hi ${params.agentFirstName}, the expected closing date for <strong style="color:#E5E5E5;">${params.propertyAddress}</strong> has arrived.
    </p>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      Your brokerage has <strong style="color:#5FA873;">14 days</strong> to remit payment of <strong style="color:#E5E5E5;">${formatReminderCurrency(params.amountDueFromBrokerage)}</strong> to Firm Funds.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#1A2240; border-radius:8px;">
      <tr>
        <td style="padding:16px;">
          <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Payment Due Date</p>
          <p style="margin:0; color:#5FA873; font-size:18px; font-weight:600;">${formatReminderDate(params.dueDate)}</p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:13px; line-height:1.5;">
      If payment is not received by the due date, late payment interest at 24% per annum will begin accruing on your Firm Funds account.
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

  try {
    // Send to agent
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: `Closing Day — Payment due by ${formatReminderDate(params.dueDate)} — ${params.propertyAddress}`,
      html: agentBody,
    })
  } catch (err) {
    console.error('[email] Failed to send closing day reminder to agent:', err)
  }

  // Send to brokerage
  if (params.brokerageEmail) {
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: params.brokerageEmail,
        subject: `Closing Day — Payment due by ${formatReminderDate(params.dueDate)} — ${params.propertyAddress}`,
        html: wrap(`
          <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
            Closing Day — Payment Reminder
          </h2>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            The expected closing date for <strong style="color:#E5E5E5;">${params.propertyAddress}</strong> (${params.agentFirstName}'s deal) has arrived.
          </p>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            Please remit payment of <strong style="color:#E5E5E5;">${formatReminderCurrency(params.amountDueFromBrokerage)}</strong> to Firm Funds by <strong style="color:#5FA873;">${formatReminderDate(params.dueDate)}</strong>.
          </p>
        `),
      })
    } catch (err) {
      console.error('[email] Failed to send closing day reminder to brokerage:', err)
    }
  }
}

/** 7-day reminder — "7 days remaining for brokerage payment." */
export async function sendSettlementReminder7Day(params: SettlementReminderParams) {
  const resend = getResend()
  if (!resend) return

  const agentBody = wrap(`
    <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
      7 Days Remaining — Payment Reminder
    </h2>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      Hi ${params.agentFirstName}, there are <strong style="color:#E8B54A;">7 days remaining</strong> for your brokerage to remit payment for <strong style="color:#E5E5E5;">${params.propertyAddress}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#1A2240; border-radius:8px;">
      <tr>
        <td style="padding:16px;">
          <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Amount Due</p>
          <p style="margin:0 0 12px; color:#E5E5E5; font-size:18px; font-weight:600;">${formatReminderCurrency(params.amountDueFromBrokerage)}</p>
          <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Payment Due Date</p>
          <p style="margin:0; color:#E8B54A; font-size:18px; font-weight:600;">${formatReminderDate(params.dueDate)}</p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:13px; line-height:1.5;">
      If payment is not received by the due date, late payment interest at 24% per annum will begin accruing on your Firm Funds account.
    </p>
  `)

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: `7 Days Remaining — Payment due ${formatReminderDate(params.dueDate)} — ${params.propertyAddress}`,
      html: agentBody,
    })
  } catch (err) {
    console.error('[email] Failed to send 7-day reminder to agent:', err)
  }

  if (params.brokerageEmail) {
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: params.brokerageEmail,
        subject: `7 Days Remaining — Payment due ${formatReminderDate(params.dueDate)} — ${params.propertyAddress}`,
        html: wrap(`
          <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
            7 Days Remaining — Payment Reminder
          </h2>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            There are <strong style="color:#E8B54A;">7 days remaining</strong> to remit payment of <strong style="color:#E5E5E5;">${formatReminderCurrency(params.amountDueFromBrokerage)}</strong> for ${params.agentFirstName}'s deal at <strong>${params.propertyAddress}</strong>.
          </p>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            Due date: <strong style="color:#E8B54A;">${formatReminderDate(params.dueDate)}</strong>
          </p>
        `),
      })
    } catch (err) {
      console.error('[email] Failed to send 7-day reminder to brokerage:', err)
    }
  }
}

/** 3-day reminder — "3 days remaining! Late interest will apply after due date." */
export async function sendSettlementReminder3Day(params: SettlementReminderParams) {
  const resend = getResend()
  if (!resend) return

  const agentBody = wrap(`
    <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
      3 Days Remaining — Urgent Payment Reminder
    </h2>
    <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
      Hi ${params.agentFirstName}, there are only <strong style="color:#E54B4B;">3 days remaining</strong> for your brokerage to remit payment for <strong style="color:#E5E5E5;">${params.propertyAddress}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; background:#2A1A1A; border:1px solid #E54B4B33; border-radius:8px;">
      <tr>
        <td style="padding:16px;">
          <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Amount Due</p>
          <p style="margin:0 0 12px; color:#E5E5E5; font-size:18px; font-weight:600;">${formatReminderCurrency(params.amountDueFromBrokerage)}</p>
          <p style="margin:0 0 8px; color:#BCBBB8; font-size:13px;">Payment Due Date</p>
          <p style="margin:0; color:#E54B4B; font-size:18px; font-weight:600;">${formatReminderDate(params.dueDate)}</p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 12px; color:#E54B4B; font-size:14px; font-weight:600; line-height:1.5;">
      If payment is not received by ${formatReminderDate(params.dueDate)}, late payment interest at 24% per annum will begin accruing daily on your Firm Funds account.
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

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.agentEmail,
      subject: `URGENT: 3 Days Remaining — Payment due ${formatReminderDate(params.dueDate)} — ${params.propertyAddress}`,
      html: agentBody,
    })
  } catch (err) {
    console.error('[email] Failed to send 3-day reminder to agent:', err)
  }

  if (params.brokerageEmail) {
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: params.brokerageEmail,
        subject: `URGENT: 3 Days Remaining — Payment due ${formatReminderDate(params.dueDate)} — ${params.propertyAddress}`,
        html: wrap(`
          <h2 style="margin:0 0 16px; color:#E5E5E5; font-size:18px; font-weight:600;">
            3 Days Remaining — Urgent Payment Reminder
          </h2>
          <p style="margin:0 0 12px; color:#BCBBB8; font-size:14px; line-height:1.5;">
            There are only <strong style="color:#E54B4B;">3 days remaining</strong> to remit payment of <strong style="color:#E5E5E5;">${formatReminderCurrency(params.amountDueFromBrokerage)}</strong> for ${params.agentFirstName}'s deal at <strong>${params.propertyAddress}</strong>.
          </p>
          <p style="margin:0 0 12px; color:#E54B4B; font-size:14px; font-weight:600; line-height:1.5;">
            Due date: ${formatReminderDate(params.dueDate)}. Late payment interest will apply after this date.
          </p>
        `),
      })
    } catch (err) {
      console.error('[email] Failed to send 3-day reminder to brokerage:', err)
    }
  }
}
