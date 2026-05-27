import { NextResponse, type NextRequest } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { checkSensitiveRateLimit } from '@/lib/rate-limit'
import { extractTrustedClientIpOrLocalhost } from '@/lib/request-helpers'

// ============================================================================
// /api/unsubscribe — CASL one-click unsubscribe endpoint
// ============================================================================
//
// Token table: email_unsubscribe_tokens (migration 092). One token row per
// (entity_type, entity_id) pair; minted lazily by lib/email.ts and reused
// across sends so a single saved unsubscribe link permanently opts the
// recipient out of every future email to that entity.
//
// Two methods:
//   GET  ?token=...  — returns 200 JSON. The human-facing landing page lives
//                      at /unsubscribe (server component) and renders the
//                      result; this JSON endpoint is mostly a sanity probe
//                      and a fallback for clients that don't follow the
//                      List-Unsubscribe header to a browser.
//   POST ?token=...  — RFC 8058 one-click unsubscribe. Gmail / iCloud /
//                      Yahoo POST to this endpoint when the user clicks the
//                      mailbox "Unsubscribe" button. Sets the entity's
//                      email_notifications_enabled to false. MUST be CSRF-
//                      exempt — those clients don't send any Origin header.
//
// Both methods are rate-limited per IP to slow token enumeration. Token
// hashes are not used here because the token IS the secret; an attacker who
// knows it can already unsubscribe the recipient (the worst they can do).
// We deliberately accept that small risk in exchange for keeping the URL
// short enough for email clients to render on one line.
// ============================================================================

type EntityType = 'agent' | 'brokerage'

interface LookupResult {
  entityType: EntityType
  entityId: string
}

async function lookupToken(token: string): Promise<LookupResult | null> {
  const service = createServiceRoleClient()
  const { data, error } = await service
    .from('email_unsubscribe_tokens')
    .select('entity_type, entity_id')
    .eq('token', token)
    .maybeSingle()
  if (error || !data) return null
  const row = data as { entity_type: EntityType; entity_id: string }
  if (row.entity_type !== 'agent' && row.entity_type !== 'brokerage') return null
  return { entityType: row.entity_type, entityId: row.entity_id }
}

async function flipPreference(
  entityType: EntityType,
  entityId: string,
  enabled: boolean
): Promise<boolean> {
  const service = createServiceRoleClient()
  const table = entityType === 'agent' ? 'agents' : 'brokerages'
  const { error } = await service
    .from(table)
    .update({ email_notifications_enabled: enabled })
    .eq('id', entityId)
  if (error) {
    console.error(
      `[unsubscribe] failed to flip ${entityType}/${entityId} → ${enabled}:`,
      error.message
    )
    return false
  }
  // Audit (fire-and-forget). user_id is null because this endpoint is
  // unauthenticated by design — the token IS the actor. We capture the
  // entity and a token prefix so forensics can trace the action.
  void service.from('audit_log').insert({
    user_id: null,
    action: enabled
      ? 'email.notifications_resubscribed'
      : 'email.notifications_unsubscribed',
    entity_type: entityType,
    entity_id: entityId,
    metadata: {
      actor_kind: 'email_unsubscribe_token',
      method: enabled ? 'resubscribe' : 'one_click',
    },
  })
  return true
}

export async function GET(request: NextRequest) {
  const ip = extractTrustedClientIpOrLocalhost(request as unknown as Request)
  const rl = await checkSensitiveRateLimit(ip)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429 }
    )
  }

  const token = request.nextUrl.searchParams.get('token')
  if (!token || token.length < 16) {
    return NextResponse.json(
      { ok: false, error: 'Missing or invalid token' },
      { status: 400 }
    )
  }
  const lookup = await lookupToken(token)
  if (!lookup) {
    return NextResponse.json(
      { ok: false, error: 'Invalid token' },
      { status: 404 }
    )
  }
  return NextResponse.json({
    ok: true,
    entityType: lookup.entityType,
  })
}

export async function POST(request: NextRequest) {
  const ip = extractTrustedClientIpOrLocalhost(request as unknown as Request)
  const rl = await checkSensitiveRateLimit(ip)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429 }
    )
  }

  // Token can be in query string OR form body. Gmail's one-click POST sends
  // an empty body but keeps the URL from the List-Unsubscribe header.
  let token = request.nextUrl.searchParams.get('token')
  if (!token) {
    try {
      const contentType = request.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const body = await request.json().catch(() => null)
        if (body && typeof body.token === 'string') token = body.token
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const form = await request.formData()
        const t = form.get('token')
        if (typeof t === 'string') token = t
      }
    } catch {
      // Body parsing failed — fall through and reject below.
    }
  }
  if (!token || token.length < 16) {
    return NextResponse.json(
      { ok: false, error: 'Missing or invalid token' },
      { status: 400 }
    )
  }
  const lookup = await lookupToken(token)
  if (!lookup) {
    return NextResponse.json(
      { ok: false, error: 'Invalid token' },
      { status: 404 }
    )
  }
  const ok = await flipPreference(lookup.entityType, lookup.entityId, false)
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: 'Failed to update preference' },
      { status: 500 }
    )
  }
  return NextResponse.json({ ok: true, action: 'unsubscribed' })
}

// PUT — used by the /unsubscribe landing page's "Resubscribe" button to
// flip the preference back on. Same token, opposite effect.
export async function PUT(request: NextRequest) {
  const ip = extractTrustedClientIpOrLocalhost(request as unknown as Request)
  const rl = await checkSensitiveRateLimit(ip)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429 }
    )
  }
  let token: string | null = null
  try {
    const body = await request.json().catch(() => null)
    if (body && typeof body.token === 'string') token = body.token
  } catch {
    // ignore
  }
  if (!token) token = request.nextUrl.searchParams.get('token')
  if (!token || token.length < 16) {
    return NextResponse.json(
      { ok: false, error: 'Missing or invalid token' },
      { status: 400 }
    )
  }
  const lookup = await lookupToken(token)
  if (!lookup) {
    return NextResponse.json(
      { ok: false, error: 'Invalid token' },
      { status: 404 }
    )
  }
  const ok = await flipPreference(lookup.entityType, lookup.entityId, true)
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: 'Failed to update preference' },
      { status: 500 }
    )
  }
  return NextResponse.json({ ok: true, action: 'resubscribed' })
}
