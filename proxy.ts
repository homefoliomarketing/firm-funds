import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isAllowedOrigin } from '@/lib/csrf'
import { getAgentStatusError, getProfileStatusError, isActiveBrokerageStatus, hasCapability, isOwner, isInternalAdminRole, ADMIN_ROUTE_CAPABILITIES } from '@/lib/access'
import { isImpersonationWriteBlocked, isSessionActive, dashboardPathForRole } from '@/lib/impersonation-core'
import { logBlockedImpersonationAction } from '@/lib/impersonation-proxy'
import type { AgentStatus, BrokerageStatus, UserProfile, UserRole } from '@/types/database'

// Role-to-route mapping for authorization
const ROUTE_ROLES: Record<string, readonly UserRole[]> = {
  '/admin': ['super_admin', 'firm_funds_admin'],
  '/brokerage': ['brokerage_admin'],
  '/agent': ['agent'],
}

// State-changing HTTP verbs that require an Origin/Referer match for /api/*
// routes. GET/HEAD/OPTIONS are exempt (idempotent + preflight semantics).
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// API routes that legitimately receive state-changing requests from non-browser
// callers and therefore have no browser Origin to compare against. Each MUST
// have its own out-of-band auth (HMAC, bearer secret, etc.).
//
// To add a new exemption: document the alternate auth mechanism inline
// (e.g. "HMAC-verified", "Bearer CRON_SECRET") and prefer an exact path
// match over a wildcard.
const API_CSRF_EXEMPT_EXACT = new Set<string>([
  // DocuSign Connect — HMAC-SHA256 verified in the route handler
  '/api/docusign/webhook',
  // RFC 8058 one-click unsubscribe — Gmail / iCloud / Yahoo POST here
  // without an Origin header on behalf of the recipient. The token in the
  // request body IS the authentication; the worst an attacker who replays
  // a recorded URL can do is unsubscribe the recipient (then they can
  // resubscribe via the same link). See app/api/unsubscribe/route.ts.
  '/api/unsubscribe',
])
const API_CSRF_EXEMPT_PREFIX = [
  // Netlify-scheduled cron jobs — Bearer CRON_SECRET in handler
  '/api/cron/',
]

function isApiCsrfExempt(pathname: string): boolean {
  if (API_CSRF_EXEMPT_EXACT.has(pathname)) return true
  return API_CSRF_EXEMPT_PREFIX.some(p => pathname.startsWith(p))
}

interface AgentAccessRecord {
  id: string
  brokerage_id: string | null
  status: AgentStatus
  flagged_by_brokerage: boolean
}

interface BrokerageAccessRecord {
  id: string
  status: BrokerageStatus
}

function buildContentSecurityPolicy(nonce: string) {
  const isDev = process.env.NODE_ENV === 'development'
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''} https://cdnjs.cloudflare.com https://maps.googleapis.com https://maps.gstatic.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://*.supabase.co https://maps.gstatic.com https://maps.googleapis.com https://*.googleusercontent.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.upstash.io https://maps.googleapis.com https://places.googleapis.com",
    "worker-src 'self' blob: https://cdnjs.cloudflare.com",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ')
}

function withCsp(response: NextResponse, csp: string) {
  response.headers.set('Content-Security-Policy', csp)
  return response
}

function redirectWithCsp(request: NextRequest, csp: string, pathname = '/login') {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  return withCsp(NextResponse.redirect(url), csp)
}

async function getBrokerageStatus(
  supabase: ReturnType<typeof createServerClient>,
  brokerageId: string | null
) {
  if (!brokerageId) return null

  const { data: brokerage } = await supabase
    .from('brokerages')
    .select('id, status')
    .eq('id', brokerageId)
    .single()

  return (brokerage as BrokerageAccessRecord | null)?.status ?? null
}

async function validateProfileIsAllowed(
  supabase: ReturnType<typeof createServerClient>,
  profile: UserProfile
) {
  if (getProfileStatusError(profile)) return false

  if (profile.role === 'agent') {
    if (!profile.agent_id) return false

    const { data: agent } = await supabase
      .from('agents')
      .select('id, brokerage_id, status, flagged_by_brokerage')
      .eq('id', profile.agent_id)
      .single()

    const agentRecord = agent as AgentAccessRecord | null
    if (!agentRecord) return false
    if (getAgentStatusError(agentRecord)) return false

    const brokerageStatus = await getBrokerageStatus(supabase, agentRecord.brokerage_id)
    return isActiveBrokerageStatus(brokerageStatus)
  }

  if (profile.role === 'brokerage_admin') {
    const brokerageStatus = await getBrokerageStatus(supabase, profile.brokerage_id)
    return isActiveBrokerageStatus(brokerageStatus)
  }

  return true
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const csp = buildContentSecurityPolicy(nonce)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  // CSRF enforcement for state-changing /api/* requests. Runs BEFORE the
  // Supabase client is built and BEFORE auth checks so a forged POST never
  // touches the auth subsystem and is rejected with 403 (not 302'd to /login).
  // Per-handler validateOrigin() calls in routes are kept as defense in depth;
  // this closes the gap where a new route forgets to call it.
  const csrfPath = request.nextUrl.pathname
  if (
    csrfPath.startsWith('/api/') &&
    STATE_CHANGING_METHODS.has(request.method) &&
    !isApiCsrfExempt(csrfPath) &&
    !isAllowedOrigin(request)
  ) {
    return withCsp(NextResponse.json(
      { error: 'Forbidden: invalid or missing Origin' },
      { status: 403 }
    ), csp)
  }

  let supabaseResponse = withCsp(NextResponse.next({ request: { headers: requestHeaders } }), csp)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = withCsp(NextResponse.next({ request: { headers: requestHeaders } }), csp)
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Validate JWT server-side (not just check session)
  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname

  // Redirect unauthenticated users to login except for these public paths.
  // Use an explicit allowlist of EXACT prefixes (followed by '/' or end).
  // Previously `startsWith('/api/kyc-')` would accidentally match a future
  // `/api/kyc-admin-debug` route and bypass auth.
  const PUBLIC_PATHS = [
    '/login',
    '/auth',
    '/kyc-upload',
    '/invite',
    '/api/magic-link',
    '/api/rate-limit',
    '/api/docusign/webhook',
    '/api/kyc-mobile-upload',
    '/api/kyc-desktop-upload',
    '/api/kyc-validate-token',
    // Click-target for the brokerage contact-email confirmation flow. The
    // single-use token is the authentication; no session is required (the
    // recipient may not have a Firm Funds account at all). See
    // app/api/brokerage/confirm-contact-email/route.ts.
    '/api/brokerage/confirm-contact-email',
    // Firm-deal offer magic links: agent clicks the link in their email or
    // SMS without an existing session, route mints a Supabase magic link and
    // bounces them into the dashboard signed in. The token in the URL is the
    // authentication. See app/agent/firm-deal/[token]/route.ts.
    '/agent/firm-deal',
    // CASL unsubscribe surface. The token in ?token=… is the authentication;
    // recipients may not have a Firm Funds account at all. Both the human
    // landing page and the one-click RFC 8058 POST endpoint must be reachable
    // without a session.
    '/unsubscribe',
    '/api/unsubscribe',
  ]
  const isPublic =
    PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/')) ||
    pathname.startsWith('/api/cron/')
  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    // Pass the original destination so login can redirect back
    url.searchParams.set('redirect', pathname)
    return withCsp(NextResponse.redirect(url), csp)
  }

  // For authenticated users: enforce role-based route access
  if (user) {
    // Single profile read per request — used for is_active, must_reset_password,
    // and role checks below. user_profiles.is_active=false means the user was
    // deactivated; we sign them out immediately rather than letting their
    // existing session ride to expiry.
    const { data: profileData } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    const profile = profileData as UserProfile | null

    if (profile && !(await validateProfileIsAllowed(supabase, profile))) {
      await supabase.auth.signOut()
      return redirectWithCsp(request, csp)
    }

    // ------------------------------------------------------------------
    // Impersonation ("view as user") gate.
    //
    // Source of truth is the impersonation_sessions row keyed by the real
    // (JWT-verified) user id. Only the Owner tier can have one, so we only pay
    // the lookup for Owners. When active, this request is rendering the
    // TARGET's world: (1) every state-changing request is blocked (look-only),
    // and (2) the route gate below uses the target's role so the Owner can
    // reach the target's dashboard. The real auth cookie is untouched, so the
    // staffer stays the actor / audit subject everywhere.
    // ------------------------------------------------------------------
    let impersonationTargetRole: UserRole | null = null
    let impersonationTargetUserId: string | null = null
    if (profile && isOwner(profile)) {
      const { data: impRow } = await supabase
        .from('impersonation_sessions')
        .select('target_user_id, target_role, expires_at, ended_at')
        .eq('real_user_id', user.id)
        .is('ended_at', null)
        .maybeSingle()
      const row = impRow as { target_user_id: string; target_role: UserRole; expires_at: string; ended_at: string | null } | null
      if (row && isSessionActive(row, Date.now())) {
        impersonationTargetRole = row.target_role
        impersonationTargetUserId = row.target_user_id
      }
    }
    const isImpersonating = !!impersonationTargetRole

    // Look-only enforcement: block every state-changing request (POST/PUT/
    // PATCH/DELETE) while viewing-as, except the Exit + heartbeat allowlist.
    // Server Actions are always POST, so this covers all of them without
    // touching individual action files.
    if (isImpersonating && isImpersonationWriteBlocked(request.method, pathname)) {
      await logBlockedImpersonationAction({
        realUserId: user.id,
        realEmail: profile?.email,
        realRole: profile?.role,
        targetUserId: impersonationTargetUserId as string,
        method: request.method,
        pathname,
        ipAddress:
          request.headers.get('x-nf-client-connection-ip') ||
          request.headers.get('x-real-ip') ||
          undefined,
        userAgent: request.headers.get('user-agent') || undefined,
      })
      return withCsp(
        NextResponse.json(
          { error: 'You are viewing as another user (look-only). Exit view-as to make changes.' },
          { status: 403 },
        ),
        csp,
      )
    }

    // Check if user must reset their password (first login after invite).
    // Skip if user already changed password (metadata flag set client-side).
    //
    // SECURITY: previously this blanket-excluded all `/api/*`, meaning a user
    // with must_reset_password=true could call API routes (fund deals, upload
    // docs, etc.) using their temp password. The exclusion is now limited to
    // the few endpoints the /change-password flow itself needs.
    const RESET_ALLOWED_API_PATHS = [
      '/api/clear-reset-flag',   // the endpoint that actually clears the flag
      '/api/rate-limit',          // change-password page pre-checks rate limit
      '/api/session-heartbeat',   // keep session alive while user resets
    ]
    const isResetAllowedApi = RESET_ALLOWED_API_PATHS.some(
      p => pathname === p || pathname.startsWith(p + '/')
    )
    if (
      !pathname.startsWith('/change-password') &&
      !isResetAllowedApi &&
      !pathname.startsWith('/login') &&
      !pathname.startsWith('/auth')
    ) {
      const hasChangedPassword = user.user_metadata?.password_changed === true
      if (!hasChangedPassword && profile?.must_reset_password) {
        // For API requests, return 403 JSON instead of an HTML redirect so
        // clients (fetch callers) get a clear error rather than a redirect chain.
        if (pathname.startsWith('/api/')) {
          return withCsp(NextResponse.json(
            { error: 'Password reset required' },
            { status: 403 }
          ), csp)
        }
        return redirectWithCsp(request, csp, '/change-password')
      }
    }

    // If on login page, redirect to appropriate dashboard (or redirect param if present)
    if (pathname.startsWith('/login')) {
      // If no profile exists, sign them out and let them stay on login
      // (prevents redirect loop when profile row is missing)
      if (!profile) {
        await supabase.auth.signOut()
        return supabaseResponse
      }

      const url = request.nextUrl.clone()
      const redirectParam = request.nextUrl.searchParams.get('redirect')

      // If there's a redirect URL, validate it matches the user's role prefix.
      // Parse via URL so we can compare ORIGIN explicitly (protecting against
      // open-redirect via a full URL like `https://evil.example/admin/...`)
      // and check the PATHNAME only (so `/agent-evil` doesn't pass a startsWith
      // for `/agent`, and so a `?...=/admin` query string can't satisfy the
      // prefix check). Same-origin + trailing-slash boundary is required.
      if (redirectParam) {
        const roleRoutes: Record<string, string> = {
          agent: '/agent',
          brokerage_admin: '/brokerage',
          firm_funds_admin: '/admin',
          super_admin: '/admin',
        }
        const allowedPrefix = roleRoutes[profile.role] || '/agent'
        let parsedRedirect: URL | null = null
        try {
          parsedRedirect = new URL(redirectParam, request.url)
        } catch {
          parsedRedirect = null
        }
        const isSameOrigin =
          !!parsedRedirect && parsedRedirect.origin === request.nextUrl.origin
        const pathMatchesRole =
          !!parsedRedirect &&
          (parsedRedirect.pathname === allowedPrefix ||
            parsedRedirect.pathname.startsWith(allowedPrefix + '/'))
        if (parsedRedirect && isSameOrigin && pathMatchesRole) {
          return withCsp(NextResponse.redirect(
            new URL(
              parsedRedirect.pathname + parsedRedirect.search,
              request.url
            )
          ), csp)
        }
        // Otherwise fall through to the default role-based redirect below.
      }

      switch (profile.role) {
        case 'agent': url.pathname = '/agent'; break
        case 'brokerage_admin': url.pathname = '/brokerage'; break
        case 'firm_funds_admin':
        case 'super_admin': url.pathname = '/admin'; break
        default: url.pathname = '/agent'
      }
      return withCsp(NextResponse.redirect(url), csp)
    }

    // Check role-based access for protected routes. Public paths are
    // exempt: PUBLIC_PATHS bypasses the unauthenticated redirect above and
    // it must bypass the role gate here too, otherwise an admin clicking a
    // firm-deal magic link (under /agent/firm-deal) gets signed out before
    // the route handler ever runs.
    if (!isPublic) {
      // While viewing-as, the route gate enforces the TARGET's role so the
      // Owner can reach the target's dashboard; otherwise the user's own role.
      const effectiveRole: UserRole | null = impersonationTargetRole ?? profile?.role ?? null
      for (const [routePrefix, allowedRoles] of Object.entries(ROUTE_ROLES)) {
        if (pathname.startsWith(routePrefix)) {
          if (!profile || !effectiveRole || !allowedRoles.includes(effectiveRole)) {
            if (isImpersonating && impersonationTargetRole) {
              // Confine the staffer to the target's section instead of signing
              // the Owner out. To leave they use the banner's Exit (which ends
              // the session); then they're a normal admin again.
              return redirectWithCsp(request, csp, dashboardPathForRole(impersonationTargetRole))
            }
            if (profile && isInternalAdminRole(profile.role)) {
              // An internal admin on a non-admin role route (e.g. a view-as that
              // just expired). Bounce to their admin home, don't sign them out.
              return redirectWithCsp(request, csp, '/admin')
            }
            // User doesn't have the right role or no profile — sign out and redirect to login
            await supabase.auth.signOut()
            return redirectWithCsp(request, csp)
          }
          break
        }
      }

      // Capability sub-gating for sensitive /admin pages (least-privilege staff
      // roles). The role gate above lets ALL internal staff into /admin; these
      // specific pages need a capability (e.g. money.write, audit.read). A
      // staffer who lacks it is bounced to /admin — NOT signed out, since they
      // are legitimately inside the admin area, just not on this page. The
      // server actions behind each page enforce the same capability, so this is
      // a UX guard layered on top of the real boundary. Skipped while
      // viewing-as: the Owner is confined out of /admin above and holds no
      // target capabilities anyway.
      if (profile && !isImpersonating) {
        for (const [routePrefix, capability] of ADMIN_ROUTE_CAPABILITIES) {
          if (
            (pathname === routePrefix || pathname.startsWith(routePrefix + '/')) &&
            !hasCapability(profile, capability)
          ) {
            return redirectWithCsp(request, csp, '/admin')
          }
        }
      }
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|.well-known|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
