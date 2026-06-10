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
 * Auto-provisioning (added 2026-06-10):
 *   The token is cryptographically bound to a single agents row, but that
 *   agent may not yet have a Firm Funds login (the spreadsheet matched an
 *   agents row no human ever signed up against). Rather than dead-end such
 *   an agent at /login, we provision a login on the fly when the agent has a
 *   usable email — create the Supabase auth user (or adopt an orphaned one
 *   left behind by a test-data wipe), insert the user_profiles row in
 *   must_reset_password state, and then fall through to the SAME
 *   generateLink/verifyOtp path so the agent is auto-logged-in. Because the
 *   profile is flagged must_reset_password=true, proxy.ts immediately routes
 *   the freshly-logged-in agent to /change-password to set their own
 *   password before the account is usable for anything else. This does not
 *   widen the trust model: auto-login already happens today for existing
 *   agents, the link is an unguessable 128-bit token bound to one agent_id
 *   and delivered over the agent's own verified email/SMS, and the account
 *   is unusable until the agent picks a password. If the agent has NO email
 *   anywhere (a test-data edge — every real onboarded agent has one), we
 *   keep the old "no_account" dead-end.
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
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { consumeFirmDealMagicLink } from '@/lib/firm-deal-detection/magic-link'
import { resolveFirmDealOfferBranding, renderOfferLaunchHtml } from '@/lib/firm-deal-detection/offer-launch'
import { logAuditEventServiceRole } from '@/lib/audit'

const APP_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'

type FailureReason = 'expired' | 'invalid' | 'no_account'

/**
 * Generate a throwaway initial password for an auto-provisioned login. It is
 * never shown to the agent and never used to sign in (we mint a magic-link OTP
 * instead) — it exists only so createUser has a value, and the agent is forced
 * to set their own via the must_reset_password gate before the account works.
 * Replicated from the (module-private) generateTempPassword in
 * lib/actions/admin-actions.ts / brokerage-actions.ts.
 */
function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let password = ''
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

/**
 * Find an existing Supabase auth user id by email (case-insensitive) by
 * paginating the admin user list. Used to adopt an "orphaned" auth user — one
 * left behind in auth.users after its user_profiles row was deleted (this
 * happens in this codebase after test-data wipes). When that orphan exists,
 * createUser fails with "already registered" and we need its id to attach the
 * missing profile row. Returns null if no match is found.
 */
async function findAuthUserIdByEmail(
  service: SupabaseClient,
  email: string
): Promise<string | null> {
  const target = email.trim().toLowerCase()
  // Page through the admin list. perPage is capped server-side; we bound the
  // loop generously so a malformed/huge directory can never spin forever.
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 })
    if (error || !data) return null
    const match = data.users.find(u => (u.email ?? '').trim().toLowerCase() === target)
    if (match) return match.id
    if (data.users.length < 200) break // last page reached
  }
  return null
}

type ProvisionResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'no_email' | 'provision_failed'; error?: string }

/**
 * Ensure the agent behind `agentId` has a usable Firm Funds login, creating it
 * on the fly if needed, then return the email to sign in with. Idempotent and
 * safe to call when the account already half-exists. The caller falls through
 * to the existing generateLink/verifyOtp block on success.
 *
 * Cases handled:
 *   - Profile already has an email -> nothing to do, return it.
 *   - Profile exists but email is null -> backfill from agents.email.
 *   - No profile, no auth user (common new-agent case) -> createUser +
 *     insert profile (must_reset_password=true).
 *   - No profile, orphaned auth user exists (post test-data wipe) -> adopt
 *     the existing auth id and insert the missing profile.
 *   - No email anywhere -> caller keeps the old no_account dead-end.
 *
 * All writes go through the service-role client. New accounts are created in
 * must_reset_password state so proxy.ts forces /change-password before use.
 */
async function ensureAgentLoginAccount(
  service: SupabaseClient,
  args: {
    agentId: string
    profile: { id: string; email: string | null } | null
  }
): Promise<ProvisionResult> {
  // Fast path: a profile with an email already exists — nothing to provision.
  if (args.profile?.email) {
    return { ok: true, email: args.profile.email }
  }

  // Load the broker-supplied agent record for the email + identity fields.
  const { data: agent, error: agentErr } = await service
    .from('agents')
    .select('id, email, brokerage_id, first_name, last_name')
    .eq('id', args.agentId)
    .maybeSingle()
  if (agentErr || !agent) {
    return { ok: false, reason: 'provision_failed', error: agentErr?.message ?? 'agent_not_found' }
  }

  const email = (agent.email ?? '').trim()
  if (!email) {
    // No email on the profile and none on the agent record. This is the
    // test-data edge; every real onboarded agent has an email. Caller falls
    // back to the existing no_account redirect.
    return { ok: false, reason: 'no_email' }
  }

  const fullName = `${agent.first_name} ${agent.last_name}`.trim()

  // Sub-case A: a profile row exists but its email is null. Backfill it and
  // sign in with the agent's email. No auth-user work needed (the profile id
  // IS the auth user id).
  if (args.profile) {
    const { error: backfillErr } = await service
      .from('user_profiles')
      .update({ email })
      .eq('id', args.profile.id)
    if (backfillErr) {
      return { ok: false, reason: 'provision_failed', error: backfillErr.message }
    }
    return { ok: true, email }
  }

  // Sub-cases B/C: no profile at all. Get-or-create the auth user, then insert
  // the missing profile. Try createUser first; if the email is already
  // registered (an orphaned auth user from a test-data wipe), adopt that id.
  let authUserId: string | null = null
  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    password: generateTempPassword(),
    email_confirm: true,
  })
  if (created?.user) {
    authUserId = created.user.id
  } else {
    const msg = (createErr?.message ?? '').toLowerCase()
    const alreadyExists =
      msg.includes('already registered') ||
      msg.includes('already exists') ||
      msg.includes('already been registered')
    if (alreadyExists) {
      // Adopt the orphaned auth user by looking up its id by email.
      authUserId = await findAuthUserIdByEmail(service, email)
    }
    if (!authUserId) {
      return {
        ok: false,
        reason: 'provision_failed',
        error: createErr?.message ?? 'createUser returned no user',
      }
    }
  }

  // Insert the missing profile in must_reset_password state. Use upsert on the
  // primary key so a racing second click (or a partial prior run) is a no-op
  // rather than a duplicate-key error.
  const { error: profileInsertErr } = await service
    .from('user_profiles')
    .upsert(
      {
        id: authUserId,
        email,
        role: 'agent',
        full_name: fullName,
        agent_id: agent.id,
        brokerage_id: agent.brokerage_id,
        is_active: true,
        must_reset_password: true,
      },
      { onConflict: 'id', ignoreDuplicates: true }
    )
  if (profileInsertErr) {
    return { ok: false, reason: 'provision_failed', error: profileInsertErr.message }
  }

  return { ok: true, email }
}

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
  // for agents we know about but who never signed up themselves.
  const { data: profile, error: profileErr } = await service
    .from('user_profiles')
    .select('id, email')
    .eq('agent_id', consumed.agent_id)
    .maybeSingle()
  if (profileErr) {
    // A genuine DB read error (not just "no row"). Don't try to provision on
    // top of an unknown state — fall back to the no_account dead-end.
    console.error('[firm-deal-magic-link] user_profile lookup failed', {
      agent_id: consumed.agent_id,
      event_id: consumed.firm_deal_event_id,
      token_prefix: tokenPrefix,
      db_error: profileErr.message,
    })
    await logFailure('no_account', {
      agent_id: consumed.agent_id,
      event_id: consumed.firm_deal_event_id,
      token_prefix: tokenPrefix,
      db_error: profileErr.message,
    })
    return loginRedirect('no_account')
  }

  // The token is bound to a real agents row, but that agent may not have a
  // usable login yet (no profile, or a profile with a null email). Provision
  // one on the fly when we have an email, then fall through to the SAME
  // generateLink/verifyOtp path below so the agent is auto-logged-in. The new
  // account is created in must_reset_password state, so proxy.ts immediately
  // routes the freshly-logged-in agent to /change-password to finish setup.
  // See the auto-provisioning note in the file header for the security model.
  const provisioned = await ensureAgentLoginAccount(service, {
    agentId: consumed.agent_id,
    profile,
  })
  if (!provisioned.ok) {
    // no_email: every real onboarded agent has an email; this is a test-data
    // edge. provision_failed: createUser/profile insert genuinely errored, or
    // an orphaned auth user couldn't be resolved. Either way we keep the
    // existing no_account dead-end rather than crashing.
    console.error('[firm-deal-magic-link] no usable account for agent', {
      agent_id: consumed.agent_id,
      event_id: consumed.firm_deal_event_id,
      token_prefix: tokenPrefix,
      reason: provisioned.reason,
      error: provisioned.error ?? null,
    })
    await logFailure('no_account', {
      agent_id: consumed.agent_id,
      event_id: consumed.firm_deal_event_id,
      token_prefix: tokenPrefix,
      provision_reason: provisioned.reason,
      provision_error: provisioned.error ?? null,
    })
    return loginRedirect('no_account')
  }

  const signInEmail = provisioned.email

  // If we just minted (or adopted/backfilled) the account because no usable
  // profile existed before, record the success side so production triage can
  // see auto-provisioning happened. A pre-existing profile-with-email skips
  // this (provisioned still ok, but nothing was created).
  if (!profile?.email) {
    try {
      await logAuditEventServiceRole({
        action: 'firm_deal.account_auto_provisioned',
        entityType: 'agent',
        entityId: consumed.agent_id,
        severity: 'info',
        metadata: {
          agent_id: consumed.agent_id,
          event_id: consumed.firm_deal_event_id,
          token_prefix: tokenPrefix,
        },
      })
    } catch {
      // Audit is a forensic aid; never fail the sign-in over it.
    }
  }

  // Ask Supabase to mint a one-time OTP for this email. We do not send the
  // user to the action_link (that would put the JWT in the URL hash, which
  // the server can never read, breaking SSR auth). Instead we keep the
  // hashed_token server-side and call verifyOtp ourselves below.
  const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email: signInEmail,
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
