import { NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { validateOrigin } from '@/lib/csrf'
import { checkApiRateLimit } from '@/lib/rate-limit'
import { logAuditEventServiceRole, extractRequestContext } from '@/lib/audit'

// Allow a 60s skew between auth.users.created_at and updated_at so that
// invite-time provisioning writes don't count as a real password change.
const PASSWORD_CHANGE_GRACE_MS = 60_000

export async function POST(request: Request) {
  // CSRF protection: validate request origin. Defense in depth — middleware.ts
  // also enforces an Origin/Referer match for every state-changing /api/*
  // request, so this call is redundant in normal operation. Kept so that any
  // future refactor of middleware (or a route mounted outside the matcher)
  // still gets the check.
  const originError = validateOrigin(request)
  if (originError) return originError

  // Rate limit check
  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
  const rl = await checkApiRateLimit(ip)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false }, { status: 401 })

    const serviceClient = createServiceRoleClient()

    // Verify the password actually changed before clearing the must_reset flag.
    // Without this, any logged-in user with a temp password can POST here and
    // permanently bypass the forced reset.
    const { data: adminUserData, error: adminFetchErr } =
      await serviceClient.auth.admin.getUserById(user.id)
    if (adminFetchErr || !adminUserData?.user) {
      console.error('[CLEAR RESET FLAG] Failed to load auth user:', adminFetchErr?.message)
      return NextResponse.json({ success: false }, { status: 500 })
    }
    const authUser = adminUserData.user
    const createdAtMs = authUser.created_at ? Date.parse(authUser.created_at) : NaN
    const updatedAtMs = authUser.updated_at ? Date.parse(authUser.updated_at) : NaN

    if (
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(updatedAtMs) ||
      updatedAtMs <= createdAtMs + PASSWORD_CHANGE_GRACE_MS
    ) {
      const ctx = await extractRequestContext(request)
      await logAuditEventServiceRole(
        {
          userId: user.id,
          action: 'user.password_changed',
          entityType: 'user',
          entityId: user.id,
          metadata: {
            email: user.email,
            outcome: 'rejected',
            reason: 'password_unchanged_since_invite',
            created_at: authUser.created_at,
            updated_at: authUser.updated_at,
          },
          actorEmail: user.email || undefined,
        },
        ctx
      )
      return NextResponse.json(
        { success: false, error: 'Password must be changed before clearing reset flag' },
        { status: 403 }
      )
    }

    // Clear the DB flag (service role bypasses RLS)
    await serviceClient
      .from('user_profiles')
      .update({ must_reset_password: false })
      .eq('id', user.id)

    // Also set the metadata flag via admin API as a belt-and-suspenders measure
    await serviceClient.auth.admin.updateUserById(user.id, {
      user_metadata: { password_changed: true },
    })

    // Audit log: record password change event (M1 security fix)
    const ctx = await extractRequestContext(request)
    await logAuditEventServiceRole(
      {
        userId: user.id,
        action: 'user.password_changed',
        entityType: 'user',
        entityId: user.id,
        metadata: {
          email: user.email,
          outcome: 'cleared',
          updated_at: authUser.updated_at,
        },
        actorEmail: user.email || undefined,
      },
      ctx
    )

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    console.error('[CLEAR RESET FLAG] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ success: false }, { status: 500 })
  }
}
