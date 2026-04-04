import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/server'

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
    console.warn('[SESSION HEARTBEAT] Error:', err instanceof Error ? err.message : 'Unknown')
    return NextResponse.json({ ok: true }) // Fail open
  }
}

// DELETE: Log session timeout to audit trail
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Even if user session is already expired, try to log
    const body = await request.json().catch(() => ({}))
    const reason = body?.reason || 'timeout'

    const serviceClient = createServiceRoleClient()

    // Get actor info for audit log
    let actorEmail: string | null = null
    let actorRole: string | null = null
    if (user) {
      actorEmail = user.email || null
      const { data: profile } = await serviceClient
        .from('user_profiles')
        .select('role, email')
        .eq('id', user.id)
        .single()
      if (profile) {
        actorRole = profile.role
        if (profile.email) actorEmail = profile.email
      }
    }

    // Log session timeout event
    await serviceClient.from('audit_log').insert({
      user_id: user?.id || null,
      action: 'auth.session_timeout',
      entity_type: 'session',
      entity_id: user?.id || null,
      metadata: { reason, timestamp: new Date().toISOString() },
      severity: 'warning',
      actor_email: actorEmail,
      actor_role: actorRole,
    })

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    console.warn('[SESSION HEARTBEAT] Audit log error:', err instanceof Error ? err.message : 'Unknown')
    return NextResponse.json({ ok: true }) // Fail open
  }
}
