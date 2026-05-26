/**
 * app/agent/firm-deal/[token]/route.ts
 *
 * Auto-sign-in entry point for firm-deal offer emails and SMS.
 *
 * Flow:
 *   1. Agent gets an offer via email or SMS containing
 *      https://firmfunds.ca/agent/firm-deal/<token>
 *   2. Agent taps the link from their phone, where they probably have no
 *      Firm Funds session. Without this route they would hit /login and
 *      almost certainly bounce.
 *   3. We validate the token (one-shot, 7-day TTL), look up the linked
 *      agent's email, and ask Supabase to mint a magic link for that
 *      email with a redirectTo that lands on the dashboard with
 *      firm_deal=<event_id> in the query string.
 *   4. We HTTP-redirect the browser to Supabase's magic link URL. Supabase
 *      verifies and sets cookies, then redirects to the dashboard.
 *
 * All token validation goes through the service-role client so RLS on
 * firm_deal_magic_links never lets a plain agent peek at someone else's
 * token. The middleware allowlist exempts /agent/firm-deal so this route
 * runs without the usual /agent role gate.
 *
 * Failure modes redirect to /login with a tiny ?reason= param so the
 * login page can show a contextual message ("Your link expired, please
 * sign in"). We never expose which failure mode occurred to a caller who
 * is guessing tokens.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { consumeFirmDealMagicLink } from '@/lib/firm-deal-detection/magic-link'

const APP_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'

function loginRedirect(reason: 'expired' | 'invalid'): NextResponse {
  const url = new URL('/login', APP_URL)
  url.searchParams.set('reason', `firm_deal_${reason}`)
  return NextResponse.redirect(url)
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  // Next.js 16: route params are async.
  const { token } = await params
  const service = createServiceRoleClient()

  const consumed = await consumeFirmDealMagicLink(service, token)
  if (!consumed.ok) {
    return loginRedirect(consumed.reason === 'expired' ? 'expired' : 'invalid')
  }

  // We need the agent's Supabase auth email to mint a magic link. The
  // auth-side email lives on user_profiles (the row joined to auth.users
  // by id). agents.email is the broker-supplied address and may be NULL
  // for agents we know about but who never signed up themselves; we treat
  // that as "no usable Firm Funds account" and bounce to login.
  const { data: profile, error: profileErr } = await service
    .from('user_profiles')
    .select('id, email')
    .eq('agent_id', consumed.agent_id)
    .maybeSingle()
  if (profileErr || !profile || !profile.email) {
    console.error(
      '[firm-deal-magic-link] no user_profile for agent',
      consumed.agent_id,
      profileErr?.message
    )
    return loginRedirect('invalid')
  }

  // Ask Supabase to mint a one-time OTP for this email. We do not send the
  // user to the action_link (that would put the JWT in the URL hash, which
  // the server can never read, breaking SSR auth). Instead we keep the
  // hashed_token server-side and call verifyOtp ourselves, which sets the
  // session cookies on the SSR client. Same trick the @supabase/ssr docs
  // recommend for server-driven magic-link flows.
  const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email: profile.email,
  })
  if (linkErr || !linkData?.properties?.hashed_token) {
    console.error('[firm-deal-magic-link] generateLink failed', linkErr?.message)
    return loginRedirect('invalid')
  }

  // The SSR client reads/writes the auth cookies on the response. verifyOtp
  // sets the session cookies here; the redirect below sends them to the
  // browser so the dashboard load sees an authenticated user.
  const supabase = await createClient()
  const { error: verifyErr } = await supabase.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) {
    console.error('[firm-deal-magic-link] verifyOtp failed', verifyErr.message)
    return loginRedirect('invalid')
  }

  const dashboard = new URL('/agent/dashboard', APP_URL)
  dashboard.searchParams.set('firm_deal', consumed.firm_deal_event_id)
  return NextResponse.redirect(dashboard)
}
