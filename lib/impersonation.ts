import 'server-only'

// ============================================================================
// Impersonation — server side (DB + cookies + audit + view resolution)
// ============================================================================
// The pure decision logic lives in lib/impersonation-core.ts. THIS module does
// I/O and therefore must never be imported by proxy.ts (it would pull
// next/headers into the proxy bundle). The proxy uses its own anon client for
// the active-session read and lib/impersonation-proxy.ts for the blocked-action
// audit.
//
// Source of truth for "am I viewing as someone?": an active (ended_at IS NULL),
// unexpired row in impersonation_sessions keyed by the real (JWT-verified)
// user id. The real auth cookie is never touched, so the staffer stays the
// actor everywhere; this module only resolves which TARGET profile the read
// paths should render.
// ============================================================================

import { cookies } from 'next/headers'
import type { User } from '@supabase/supabase-js'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { logAuditEventServiceRole, type AuditContext } from '@/lib/audit'
import { hasCapability } from '@/lib/access'
import { IMPERSONATION_HINT_COOKIE, IMPERSONATION_MAX_DURATION_MS } from '@/lib/constants'
import {
  dashboardPathForRole,
  encodeImpersonationHint,
  isSessionActive,
} from '@/lib/impersonation-core'
import type { ImpersonationSession, UserProfile } from '@/types/database'

type EndReason = NonNullable<ImpersonationSession['ended_reason']>

// ----------------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------------

/**
 * The current active view-as session for a staffer, or null. Treats an expired
 * session as inactive and lazily ends it (ended_reason='expired') so the hard
 * time limit is enforced even if no Exit ever happened.
 */
export async function getActiveImpersonation(
  realUserId: string,
): Promise<ImpersonationSession | null> {
  const svc = createServiceRoleClient()
  const { data } = await svc
    .from('impersonation_sessions')
    .select('*')
    .eq('real_user_id', realUserId)
    .is('ended_at', null)
    .maybeSingle()

  const session = (data as ImpersonationSession | null) ?? null
  if (!session) return null

  if (!isSessionActive(session, Date.now())) {
    await svc
      .from('impersonation_sessions')
      .update({ ended_at: new Date().toISOString(), ended_reason: 'expired' })
      .eq('id', session.id)
      .is('ended_at', null)
    return null
  }

  return session
}

export interface ResolvedImpersonation {
  session: ImpersonationSession
  targetProfile: UserProfile
}

/**
 * Given an ALREADY-resolved real staffer profile, return the active view-as
 * session and the target's profile, or null. Enforces the Owner-only
 * `impersonate` capability defensively (the session could only have been
 * created by an Owner, but we re-check on every read).
 */
export async function resolveActiveImpersonation(
  realProfile: Pick<UserProfile, 'id' | 'role' | 'staff_role'>,
): Promise<ResolvedImpersonation | null> {
  if (!hasCapability(realProfile, 'impersonate')) return null

  const session = await getActiveImpersonation(realProfile.id)
  if (!session) return null

  const svc = createServiceRoleClient()
  const { data } = await svc
    .from('user_profiles')
    .select('*')
    .eq('id', session.target_user_id)
    .single()

  const targetProfile = (data as UserProfile | null) ?? null
  if (!targetProfile) return null

  return { session, targetProfile }
}

export interface ViewContext {
  realUser: User
  realProfile: UserProfile
  isImpersonating: boolean
  session: ImpersonationSession | null
  targetProfile: UserProfile | null
}

/**
 * Resolve the full view context for the current request (RSC-safe — reads
 * cookies, never writes them). Used by the dashboard layout to render the
 * banner and decide the effective viewer.
 */
export async function getViewContext(): Promise<ViewContext | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profileData } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()
  const realProfile = (profileData as UserProfile | null) ?? null
  if (!realProfile) return null

  const resolved = await resolveActiveImpersonation(realProfile)
  return {
    realUser: user,
    realProfile,
    isImpersonating: !!resolved,
    session: resolved?.session ?? null,
    targetProfile: resolved?.targetProfile ?? null,
  }
}

// ----------------------------------------------------------------------------
// Writes (start / stop) — service role; audited; never touch target creds.
// ----------------------------------------------------------------------------

export interface StartResult {
  session: ImpersonationSession
  hintValue: string
  expiresAt: Date
  dashboardPath: string
}

/**
 * Start (or switch) a view-as session. Ends any existing active session for
 * this staffer first (ended_reason='switched'), inserts the new one, writes the
 * impersonation.start audit row, and sets the browser hint cookie. The caller
 * must already have verified the `impersonate` capability.
 */
export async function startImpersonation(args: {
  realUser: User
  realProfile: UserProfile
  target: UserProfile
  reason?: string | null
  context?: AuditContext
}): Promise<StartResult> {
  const { realUser, realProfile, target, reason, context } = args
  const svc = createServiceRoleClient()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + IMPERSONATION_MAX_DURATION_MS)

  // End any prior active session for this staffer (one-at-a-time invariant).
  await svc
    .from('impersonation_sessions')
    .update({ ended_at: now.toISOString(), ended_reason: 'switched' satisfies EndReason })
    .eq('real_user_id', realUser.id)
    .is('ended_at', null)

  const { data, error } = await svc
    .from('impersonation_sessions')
    .insert({
      real_user_id: realUser.id,
      real_email: realProfile.email,
      real_role: realProfile.role,
      target_user_id: target.id,
      target_email: target.email,
      target_role: target.role,
      target_agent_id: target.agent_id,
      target_brokerage_id: target.brokerage_id,
      reason: reason ?? null,
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      ip_address: context?.ipAddress ?? null,
      user_agent: context?.userAgent ?? null,
    })
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(error?.message || 'Failed to start view-as session')
  }
  const session = data as ImpersonationSession

  await logAuditEventServiceRole(
    {
      userId: realUser.id,
      action: 'impersonation.start',
      entityType: 'user',
      entityId: target.id,
      actorEmail: realProfile.email,
      actorRole: realProfile.role,
      impersonatedTargetId: target.id,
      metadata: {
        session_id: session.id,
        target_email: target.email,
        target_name: target.full_name,
        target_role: target.role,
        expires_at: expiresAt.toISOString(),
      },
    },
    context,
  )

  const hintValue = encodeImpersonationHint({
    t: target.id,
    e: target.email,
    r: target.role,
    x: expiresAt.getTime(),
    n: target.full_name ?? null,
  })

  return { session, hintValue, expiresAt, dashboardPath: dashboardPathForRole(target.role) }
}

/**
 * End the active view-as session for a staffer (if any) and audit it. Used by
 * the explicit Exit endpoint and by logout. Returns the ended session so the
 * caller can decide what to do (e.g. redirect).
 */
export async function endActiveImpersonation(args: {
  realUserId: string
  realEmail?: string | null
  realRole?: string | null
  reason: EndReason
  context?: AuditContext
}): Promise<ImpersonationSession | null> {
  const { realUserId, realEmail, realRole, reason, context } = args
  const svc = createServiceRoleClient()

  const { data } = await svc
    .from('impersonation_sessions')
    .update({ ended_at: new Date().toISOString(), ended_reason: reason })
    .eq('real_user_id', realUserId)
    .is('ended_at', null)
    .select('*')
    .maybeSingle()

  const ended = (data as ImpersonationSession | null) ?? null
  if (!ended) return null

  await logAuditEventServiceRole(
    {
      userId: realUserId,
      action: 'impersonation.stop',
      entityType: 'user',
      entityId: ended.target_user_id,
      actorEmail: realEmail ?? ended.real_email ?? undefined,
      actorRole: realRole ?? ended.real_role ?? undefined,
      impersonatedTargetId: ended.target_user_id,
      metadata: {
        session_id: ended.id,
        reason,
        started_at: ended.started_at,
        target_email: ended.target_email,
        target_role: ended.target_role,
      },
    },
    context,
  )

  return ended
}

// ----------------------------------------------------------------------------
// Browser hint cookie (mutable cookie store — route handlers / server actions).
// ----------------------------------------------------------------------------

export async function setImpersonationHintCookie(value: string, expiresAt: Date): Promise<void> {
  const store = await cookies()
  store.set(IMPERSONATION_HINT_COOKIE, value, {
    httpOnly: false, // the browser data layer must read this UI hint
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

export async function clearImpersonationHintCookie(): Promise<void> {
  const store = await cookies()
  store.delete(IMPERSONATION_HINT_COOKIE)
}
