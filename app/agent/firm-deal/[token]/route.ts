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
import { createServiceRoleClient } from '@/lib/supabase/server'
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
  const supabase = createServiceRoleClient()

  const consumed = await consumeFirmDealMagicLink(supabase, token)
  if (!consumed.ok) {
    return loginRedirect(consumed.reason === 'expired' ? 'expired' : 'invalid')
  }

  // We need the agent's Supabase auth email to mint a magic link. The
  // auth-side email lives on user_profiles (the row joined to auth.users
  // by id). agents.email is the broker-supplied address and may be NULL
  // for agents we know about but who never signed up themselves; we treat
  // that as "no usable Firm Funds account" and bounce to login.
  const { data: profile, error: profileErr } = await supabase
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

  const redirectTo = `${APP_URL.replace(/\/$/, '')}/agent/dashboard?firm_deal=${encodeURIComponent(consumed.firm_deal_event_id)}`

  // Ask Supabase to issue a one-time sign-in URL for this email. Supabase
  // returns an action_link we redirect the browser to; Supabase's /verify
  // endpoint then sets the session cookies and redirects to redirectTo.
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: profile.email,
    options: { redirectTo },
  })
  if (linkErr || !linkData?.properties?.action_link) {
    console.error('[firm-deal-magic-link] generateLink failed', linkErr?.message)
    return loginRedirect('invalid')
  }

  return NextResponse.redirect(linkData.properties.action_link)
}
