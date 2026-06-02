import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { validateOrigin } from '@/lib/csrf'
import { extractRequestContext } from '@/lib/audit'
import { endActiveImpersonation, clearImpersonationHintCookie } from '@/lib/impersonation'

/**
 * POST /api/impersonation/stop
 *
 * End the caller's active "view as" session (the Exit button). Allowlisted in
 * the proxy so it works WHILE viewing-as. Uses the real auth cookie directly
 * (never the impersonation swap) so it ends the session keyed to the actual
 * signed-in staffer. Idempotent: a no-op if there is no active session.
 */
export async function POST(request: Request) {
  const originError = validateOrigin(request)
  if (originError) return originError

  // The auth cookie is always the REAL staffer (impersonation never touches it),
  // so getUser() here is the Owner whose session we end.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const context = await extractRequestContext(request)

  try {
    await endActiveImpersonation({
      realUserId: user.id,
      realEmail: user.email ?? null,
      reason: 'manual',
      context,
    })
  } catch (err: unknown) {
    // Even if ending the row fails, clear the hint cookie so the UI exits.
    console.error('[impersonation.stop]', err instanceof Error ? err.message : 'unknown')
  }

  await clearImpersonationHintCookie()
  return NextResponse.json({ success: true, redirectTo: '/admin' })
}
