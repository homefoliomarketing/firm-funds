import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { validateOrigin } from '@/lib/csrf'
import { checkApiRateLimit } from '@/lib/rate-limit'
import { logAuditEventServiceRole, extractRequestContext } from '@/lib/audit'
import { endActiveImpersonation, clearImpersonationHintCookie } from '@/lib/impersonation'

/**
 * Session Heartbeat API Route
 *
 * POST — Update last_active_at timestamp (called periodically by SessionTimeout component)
 * DELETE — Log session timeout event to audit trail (called right before logout)
 *
 * Defense-in-depth: Even though the client enforces timeouts,
 * the server tracks last_active_at so middleware can optionally
 * reject stale sessions.
 */

// Accepted reasons for DELETE (session-end audit events).
const ALLOWED_REASONS = ['timeout', 'inactivity', 'manual', 'forced'] as const
type SessionEndReason = (typeof ALLOWED_REASONS)[number]

function isAllowedReason(value: unknown): value is SessionEndReason {
  return typeof value === 'string' && (ALLOWED_REASONS as readonly string[]).includes(value)
}

// POST: Update last_active_at
export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const serviceClient = createServiceRoleClient()
    const now = new Date().toISOString()

    // Update last_active_at in user_profiles
    const { error } = await serviceClient
      .from('user_profiles')
      .update({ last_active_at: now })
      .eq('id', user.id)

    if (error) {
      console.warn(`[SESSION HEARTBEAT] Failed to update last_active_at for ${user.id}: ${error.message}`)
      // Don't fail the request — this is best-effort
    }

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    console.error('[SESSION HEARTBEAT] POST error:', err instanceof Error ? err.message : 'Unknown')
    return NextResponse.json({ ok: true }) // Fail open
  }
}

// DELETE: Log session timeout to audit trail
export async function DELETE(request: Request) {
  // CSRF: only accept requests coming from our own origin. Defense in depth —
  // middleware.ts also enforces this for every state-changing /api/* request.
  // Kept so the route is safe if it's ever called outside the middleware
  // matcher.
  const originError = validateOrigin(request)
  if (originError) return originError

  // Rate limit: a logged-in user could otherwise spam the audit log.
  const ip =
    request.headers.get('x-nf-client-connection-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '127.0.0.1'
  const rl = await checkApiRateLimit(ip)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Parse + validate body. Even if user session is already expired, try to log.
    const body = await request.json().catch(() => ({}))
    const rawReason = body?.reason ?? 'timeout'
    if (!isAllowedReason(rawReason)) {
      return NextResponse.json(
        { error: 'Invalid reason', allowed: ALLOWED_REASONS },
        { status: 400 }
      )
    }
    const reason: SessionEndReason = rawReason

    // Fetch actor profile (email + role) for the audit row.
    let actorEmail: string | undefined
    let actorRole: string | undefined
    if (user) {
      actorEmail = user.email || undefined
      const serviceClient = createServiceRoleClient()
      const { data: profile } = await serviceClient
        .from('user_profiles')
        .select('role, email')
        .eq('id', user.id)
        .single()
      if (profile) {
        actorRole = profile.role || undefined
        if (profile.email) actorEmail = profile.email
      }
    }

    const ctx = await extractRequestContext(request)

    // Canonical audit path — handles severity, denormalized actor fields,
    // and visible warnings on insert failure.
    await logAuditEventServiceRole(
      {
        userId: user?.id,
        action: 'auth.session_timeout',
        entityType: 'session',
        entityId: user?.id,
        metadata: { reason, timestamp: new Date().toISOString() },
        actorEmail,
        actorRole,
      },
      ctx
    )

    // Logging out must end any active "view as" session, otherwise it would
    // silently resume on the staffer's next login (the session is keyed to the
    // real user id). Best-effort; never blocks logout.
    if (user) {
      try {
        await endActiveImpersonation({
          realUserId: user.id,
          realEmail: actorEmail ?? null,
          realRole: actorRole ?? null,
          reason: 'logout',
          context: ctx,
        })
        await clearImpersonationHintCookie()
      } catch (impErr: unknown) {
        console.warn('[SESSION HEARTBEAT] failed to end impersonation on logout:', impErr instanceof Error ? impErr.message : impErr)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    // Log loud — silently swallowing this is what caused the original audit
    // blind spot. Still respond 200 so the client-side logout flow proceeds.
    console.error(
      '[SESSION HEARTBEAT] DELETE audit log error:',
      err instanceof Error ? err.stack || err.message : err
    )
    return NextResponse.json({ ok: true })
  }
}
