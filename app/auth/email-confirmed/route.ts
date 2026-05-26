import { NextResponse, type NextRequest } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { reconcileUserEmail } from '@/lib/email-reconcile'

// ============================================================================
// Email confirmation callback
// ============================================================================
//
// Finding #42 follow-up. Supabase Auth sends a confirmation link to the new
// address when a user invokes auth.updateUser({ email }). The link goes to
// Supabase, which verifies the token, flips auth.users.email to the new
// value, and then 302s here with either:
//   - ?code=<pkce-code>     (default for @supabase/ssr v0.10+)
//   - #access_token=...     (implicit / legacy)
//
// Responsibilities of this route:
//   1. If a PKCE code is present, exchange it so the user lands logged in.
//   2. Read the current authenticated user, compare auth.users.email to
//      user_profiles.email, and mirror if they differ.
//   3. Redirect to the user's dashboard (or /login if no session).
//
// IMPORTANT: this URL must be registered in Supabase Auth -> Redirect URLs:
//   https://firmfunds.ca/auth/email-confirmed
//   https://www.firmfunds.ca/auth/email-confirmed
// Add localhost variants for development if needed.
// ============================================================================

export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  const errorDescription = url.searchParams.get('error_description')

  if (error) {
    console.warn(`[email-confirmed] supabase error=${error} desc=${errorDescription}`)
    const redirect = new URL('/login', url.origin)
    redirect.searchParams.set('email_change', 'failed')
    return NextResponse.redirect(redirect)
  }

  const supabase = await createClient()

  if (code) {
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
    if (exchangeError) {
      console.warn(`[email-confirmed] exchangeCodeForSession failed: ${exchangeError.message}`)
      // Fall through: even without a usable code (e.g., cross-device confirm
      // where the verifier cookie is missing), the user may still have a
      // pre-existing session below.
    }
  }

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    // Cross-device case: the click confirmed the email change in Supabase
    // (auth.users.email is already updated), but this browser has no session.
    // Send them to log in; getAuthenticatedUser will reconcile on the next
    // server-action call.
    const redirect = new URL('/login', url.origin)
    redirect.searchParams.set('email_change', 'confirmed_login_required')
    return NextResponse.redirect(redirect)
  }

  const service = createServiceRoleClient()
  const { data: profile } = await service
    .from('user_profiles')
    .select('id, email, role')
    .eq('id', user.id)
    .maybeSingle()

  if (profile) {
    await reconcileUserEmail({
      userId: profile.id,
      authEmail: user.email,
      profileEmail: profile.email,
    })
  }

  const dashboardPath =
    profile?.role === 'super_admin' || profile?.role === 'firm_funds_admin'
      ? '/admin'
      : profile?.role === 'brokerage_admin'
        ? '/brokerage'
        : '/agent'

  const redirect = new URL(dashboardPath, url.origin)
  redirect.searchParams.set('email_change', 'confirmed')
  return NextResponse.redirect(redirect)
}
