import { NextResponse, type NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { logAuditEventServiceRole } from '@/lib/audit'
import { checkSensitiveRateLimit } from '@/lib/rate-limit'
import { extractTrustedClientIpOrLocalhost } from '@/lib/request-helpers'

// ============================================================================
// Brokerage Contact Email Confirmation Endpoint
// ============================================================================
//
// Finding #40 follow-up. Receives the click from the confirmation email that
// updateBrokerageContactEmail sends to the NEW address. Validates the token
// (compared by sha256 hash, never raw) and flips contact_email atomically.
//
// Rate-limit hits per-IP to slow token enumeration. Even a perfect attacker
// with the hash space (2^256) is not going to brute-force this in practice,
// but the rate limit caps the noise to per-IP and surfaces obvious abuse.
//
// All branches return the user to /login with a status query string. We do
// NOT auto-sign-in the new address. It has never authenticated to Firm
// Funds; treating the confirmation click as login would create a new
// account-takeover vector.
// ============================================================================

const APP_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'

function redirectWithStatus(status: string): NextResponse {
  const url = new URL('/login', APP_URL)
  url.searchParams.set('brokerage_email', status)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  const ip = extractTrustedClientIpOrLocalhost(request as unknown as Request)
  const rl = await checkSensitiveRateLimit(ip)
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })
  }

  const token = request.nextUrl.searchParams.get('token')
  if (!token || token.length < 32) {
    return redirectWithStatus('invalid')
  }

  const tokenHash = createHash('sha256').update(token).digest('hex')
  const service = createServiceRoleClient()

  // Single-row lookup by hashed token. Partial index on the hash makes this O(1).
  const { data: row, error: lookupError } = await service
    .from('brokerages')
    .select(`
      id,
      name,
      email,
      pending_contact_email,
      pending_contact_email_token_hash,
      pending_contact_email_expires_at
    `)
    .eq('pending_contact_email_token_hash', tokenHash)
    .maybeSingle()

  if (lookupError) {
    console.error('[confirm-contact-email] lookup error:', lookupError.message)
    return redirectWithStatus('error')
  }
  if (!row || !row.pending_contact_email) {
    return redirectWithStatus('invalid')
  }
  if (!row.pending_contact_email_expires_at || new Date(row.pending_contact_email_expires_at) < new Date()) {
    // Clear the stale pending state so it doesn't sit forever.
    await service
      .from('brokerages')
      .update({
        pending_contact_email: null,
        pending_contact_email_token_hash: null,
        pending_contact_email_requested_at: null,
        pending_contact_email_expires_at: null,
      })
      .eq('id', row.id)
    return redirectWithStatus('expired')
  }

  const newEmail = row.pending_contact_email
  const oldEmail = row.email

  // CAS: flip email + clear pending fields in a single UPDATE that
  // only matches if the hash is still the one we read. Prevents double-confirm
  // and races with a concurrent "request new change" that overwrote pending_*.
  const { data: claimed, error: updateError } = await service
    .from('brokerages')
    .update({
      email: newEmail,
      pending_contact_email: null,
      pending_contact_email_token_hash: null,
      pending_contact_email_requested_at: null,
      pending_contact_email_expires_at: null,
    })
    .eq('id', row.id)
    .eq('pending_contact_email_token_hash', tokenHash)
    .select('id')
    .maybeSingle()

  if (updateError || !claimed) {
    console.error('[confirm-contact-email] CAS update failed:', updateError?.message ?? 'no row claimed')
    return redirectWithStatus('error')
  }

  await logAuditEventServiceRole({
    action: 'brokerage.contact_email_change_confirmed',
    entityType: 'brokerage',
    entityId: row.id,
    severity: 'warning',
    actorEmail: newEmail,
    metadata: {
      old_email: oldEmail,
      new_email: newEmail,
      brokerage_name: row.name,
    },
  })

  return redirectWithStatus('confirmed')
}
