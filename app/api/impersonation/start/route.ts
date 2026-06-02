import { NextResponse } from 'next/server'
import { validateOrigin } from '@/lib/csrf'
import { getAuthenticatedCapable } from '@/lib/auth-helpers'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { extractRequestContext } from '@/lib/audit'
import { startImpersonation, setImpersonationHintCookie } from '@/lib/impersonation'
import type { UserProfile } from '@/types/database'

/**
 * POST /api/impersonation/start
 *
 * Begin a look-only "view as user" session. Owner-only (the `impersonate`
 * capability, migration 102). Accepts a body with either:
 *   { targetUserId }  — a user_profiles.id, or
 *   { agentId }       — an agents.id (resolved to that agent's login).
 * Optional { reason } free-text note.
 *
 * The staffer's real auth cookie is never touched; impersonation lives entirely
 * in the impersonation_sessions row plus a UI hint cookie. Writes remain blocked
 * by the proxy while the session is active.
 */
export async function POST(request: Request) {
  const originError = validateOrigin(request)
  if (originError) return originError

  // Owner-only. getAuthenticatedCapable returns the REAL staffer here because a
  // start request is only reachable when NOT already impersonating (the proxy
  // blocks it otherwise).
  const { error, user, profile } = await getAuthenticatedCapable('impersonate')
  if (error || !user || !profile) {
    return NextResponse.json({ error: error || 'Not authorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>))
  const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId : null
  const agentId = typeof body.agentId === 'string' ? body.agentId : null
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null

  if (!targetUserId && !agentId) {
    return NextResponse.json({ error: 'A targetUserId or agentId is required.' }, { status: 400 })
  }

  const svc = createServiceRoleClient()
  let target: UserProfile | null = null

  if (targetUserId) {
    const { data } = await svc.from('user_profiles').select('*').eq('id', targetUserId).maybeSingle()
    target = (data as UserProfile | null) ?? null
  } else if (agentId) {
    const { data } = await svc
      .from('user_profiles')
      .select('*')
      .eq('agent_id', agentId)
      .eq('role', 'agent')
      .limit(1)
    target = ((data as UserProfile[] | null) ?? [])[0] ?? null
  }

  if (!target) {
    return NextResponse.json(
      { error: 'No login was found for this user, so there is nothing to view as.' },
      { status: 404 },
    )
  }
  if (target.id === user.id) {
    return NextResponse.json({ error: 'You cannot view as yourself.' }, { status: 400 })
  }
  if (target.role !== 'agent' && target.role !== 'brokerage_admin') {
    return NextResponse.json(
      { error: 'You can only view as an agent or a brokerage user.' },
      { status: 403 },
    )
  }

  const context = await extractRequestContext(request)

  try {
    const { hintValue, expiresAt, dashboardPath } = await startImpersonation({
      realUser: user,
      realProfile: profile,
      target,
      reason,
      context,
    })
    await setImpersonationHintCookie(hintValue, expiresAt)
    return NextResponse.json({
      success: true,
      redirectTo: dashboardPath,
      target: { id: target.id, name: target.full_name, role: target.role },
      expiresAt: expiresAt.toISOString(),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to start view-as session'
    console.error('[impersonation.start]', message)
    return NextResponse.json({ error: 'Failed to start view-as session.' }, { status: 500 })
  }
}
