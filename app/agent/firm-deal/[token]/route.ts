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
 *      agent's email, ask Supabase admin to mint a magic-link hashed_token
 *      for that email, and call verifyOtp server-side.
 *   4. verifyOtp writes the Supabase auth cookies onto the redirect
 *      response we are about to return; the browser persists them and the
 *      dashboard load sees an authenticated user.
 *
 * Why this route builds its own Supabase server client (instead of using
 * the shared `@/lib/supabase/server` createClient): the shared helper
 * writes cookies via `next/headers.cookies()`, whose `.set()` is read-only
 * inside Route Handlers. The writes silently swallow into a try/catch and
 * the session cookie never lands on the response. We have to bind the
 * Supabase client to *this route's* NextResponse cookie jar — same trick
 * middleware.ts uses — for the session to actually persist.
 *
 * All token validation goes through the service-role client so RLS on
 * firm_deal_magic_links never lets a plain agent peek at someone else's
 * token. The middleware allowlist exempts /agent/firm-deal so this route
 * runs without the usual /agent role gate.
 *
 * Failure modes redirect to /login with a tiny ?reason= param so the
 * login page can show a contextual message ("Your link expired, please
 * sign in"). We never expose which failure mode occurred to a caller who
 * is guessing tokens, but we DO distinguish:
 *
 *   firm_deal_invalid     — token missing / malformed / unknown
 *   firm_deal_expired     — token is past its 7-day TTL
 *   firm_deal_no_account  — token valid, but the matched agent has no
 *                           Firm Funds account yet. This is the most
 *                           common real-world failure: the spreadsheet
 *                           matched an agents row that no human has ever
 *                           signed up against. The login page tells the
 *                           recipient to contact their brokerage admin.
 *
 * Every failure also writes an audit_log row so production triage doesn't
 * depend on tailing Netlify function logs.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { consumeFirmDealMagicLink } from '@/lib/firm-deal-detection/magic-link'
import { resolveFirmDealOfferBranding, renderOfferLaunchHtml } from '@/lib/firm-deal-detection/offer-launch'
import { logAuditEventServiceRole } from '@/lib/audit'

const APP_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'

type FailureReason = 'expired' | 'invalid' | 'no_account'

function loginRedirect(reason: FailureReason): NextResponse {
  const url = new URL('/login', APP_URL)
  url.searchParams.set('reason', `firm_deal_${reason}`)
  return NextResponse.redirect(url)
}

/**
 * Best-effort audit log for every magic-link failure. Wrapped so an audit
 * insert error never causes the response to fail — the user-facing redirect
 * is what matters; the log is a forensic aid.
 */
async function logFailure(
  reason: FailureReason | 'verify_failed' | 'generate_link_failed',
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await logAuditEventServiceRole({
      action: 'firm_deal.magic_link_consume_failed',
      entityType: 'firm_deal_magic_link',
      severity: 'warning',
      metadata: { reason, ...metadata },
    })
  } catch {
    // Audit failure is non-fatal; the console.error below carries the same
    // context if Netlify logs are available.
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  // Next.js 16: route params are async.
  const { token } = await params
  const service = createServiceRoleClient()

  // --- Link-preview / launch step -----------------------------------------
  // A bare GET (no ?go=1) serves a branded HTML page: white-label Open Graph
  // tags so the SMS/email preview card shows the brokerage's own brand (name +
  // logo) and the deal's dollar figure, plus a nonce'd inline script that
  // forwards a real human on to ?go=1 (the sign-in + redirect below). Link
  // preview crawlers don't run JS — they only read the meta tags and never
  // consume the token (which is multi-use anyway). See offer-launch.ts.
  const reqUrl = new URL(req.url)
  if (reqUrl.searchParams.get('go') !== '1') {
    let branding: Awaited<ReturnType<typeof resolveFirmDealOfferBranding>> = null
    try {
      branding = await resolveFirmDealOfferBranding(service, token)
    } catch (err) {
      // Best-effort: a generic-but-valid card still renders, and ?go=1 stays
      // the authoritative validation path.
      console.warn(
        '[firm-deal-magic-link] branding resolve failed',
        err instanceof Error ? err.message : err
      )
    }
    const html = renderOfferLaunchHtml({
      branding,
      appUrl: APP_URL,
      goUrl: `${reqUrl.pathname}?go=1`,
      canonicalUrl: `${APP_URL.replace(/\/$/, '')}${reqUrl.pathname}`,
      nonce: req.headers.get('x-nonce') ?? '',
    })
    return new NextResponse(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
      },
    })
  }

  // --- Sign-in step (?go=1: a real human continuing through the splash) ----
  // Token prefix for audit/log — never the full token, which would be
  // replayable if logs leaked.
  const tokenPrefix = typeof token === 'string' ? token.slice(0, 8) : null

  const consumed = await consumeFirmDealMagicLink(service, token)
  if (!consumed.ok) {
    const reason: FailureReason = consumed.reason === 'expired' ? 'expired' : 'invalid'
    console.error('[firm-deal-magic-link] consume failed', {
      reason,
      token_prefix: tokenPrefix,
    })
    await logFailure(reason, { token_prefix: tokenPrefix })
    return loginRedirect(reason)
  }

  // We need the agent's Supabase auth email to mint a magic link. The
  // auth-side email lives on user_profiles (the row joined to auth.users
  // by id). agents.email is the broker-supplied address and may be NULL
  // for agents we know about but who never signed up themselves. Those
  // unregistered agents get a clearer "no_account" reason so the login
  // page can tell the recipient to ask their brokerage admin (vs the
  // generic "invalid" which used to leave them staring at a blank login
  // form with no idea what happened).
  const { data: profile, error: profileErr } = await service
    .from('user_profiles')
    .select('id, email')
    .eq('agent_id', consumed.agent_id)
    .maybeSingle()
  if (profileErr || !profile || !profile.email) {
    console.error('[firm-deal-magic-link] no user_profile for agent', {
      agent_id: consumed.agent_id,
      event_id: consumed.firm_deal_event_id,
      token_prefix: tokenPrefix,
      db_error: profileErr?.message ?? null,
    })
    await logFailure('no_account', {
      agent_id: consumed.agent_id,
      event_id: consumed.firm_deal_event_id,
      token_prefix: tokenPrefix,
      db_error: profileErr?.message ?? null,
    })
    return loginRedirect('no_account')
  }

  // Ask Supabase to mint a one-time OTP for this email. We do not send the
  // user to the action_link (that would put the JWT in the URL hash, which
  // the server can never read, breaking SSR auth). Instead we keep the
  // hashed_token server-side and call verifyOtp ourselves below.
  const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email: profile.email,
  })
  if (linkErr || !linkData?.properties?.hashed_token) {
    console.error('[firm-deal-magic-link] generateLink failed', linkErr?.message)
    await logFailure('generate_link_failed', {
      agent_id: consumed.agent_id,
      event_id: consumed.firm_deal_event_id,
      token_prefix: tokenPrefix,
      error: linkErr?.message ?? null,
    })
    return loginRedirect('invalid')
  }

  // Build the redirect response FIRST so we have a concrete response object
  // for the Supabase client to write cookies onto. We then bind a server
  // client whose setAll() writes directly to `response.cookies`, call
  // verifyOtp, and return that same response. This is the only pattern
  // that gets the session cookies onto the wire from inside a Route
  // Handler — the shared createClient() in lib/supabase/server.ts writes
  // to next/headers.cookies(), which is read-only here and swallows the
  // writes into a try/catch (which is why this route used to "succeed"
  // but leave the agent unauthenticated).
  const dashboard = new URL('/agent', APP_URL)
  dashboard.searchParams.set('firm_deal', consumed.firm_deal_event_id)
  const response = NextResponse.redirect(dashboard)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  const { error: verifyErr } = await supabase.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) {
    console.error('[firm-deal-magic-link] verifyOtp failed', verifyErr.message)
    await logFailure('verify_failed', {
      agent_id: consumed.agent_id,
      event_id: consumed.firm_deal_event_id,
      token_prefix: tokenPrefix,
      error: verifyErr.message,
    })
    return loginRedirect('invalid')
  }

  return response
}
