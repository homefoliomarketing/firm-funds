import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isAllowedOrigin } from '@/lib/csrf'

// Role-to-route mapping for authorization
const ROUTE_ROLES: Record<string, string[]> = {
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

export async function middleware(request: NextRequest) {
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
    return NextResponse.json(
      { error: 'Forbidden: invalid or missing Origin' },
      { status: 403 }
    )
  }

  let supabaseResponse = NextResponse.next({ request })

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
          supabaseResponse = NextResponse.next({ request })
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
    return NextResponse.redirect(url)
  }

  // For authenticated users: enforce role-based route access
  if (user) {
    // Single profile read per request — used for is_active, must_reset_password,
    // and role checks below. user_profiles.is_active=false means the user was
    // deactivated; we sign them out immediately rather than letting their
    // existing session ride to expiry.
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role, is_active, must_reset_password')
      .eq('id', user.id)
      .single()

    if (profile && profile.is_active === false) {
      await supabase.auth.signOut()
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      return NextResponse.redirect(url)
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
          return NextResponse.json(
            { error: 'Password reset required' },
            { status: 403 }
          )
        }
        const url = request.nextUrl.clone()
        url.pathname = '/change-password'
        return NextResponse.redirect(url)
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
          return NextResponse.redirect(
            new URL(
              parsedRedirect.pathname + parsedRedirect.search,
              request.url
            )
          )
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
      return NextResponse.redirect(url)
    }

    // Check role-based access for protected routes. Public paths are
    // exempt: PUBLIC_PATHS bypasses the unauthenticated redirect above and
    // it must bypass the role gate here too, otherwise an admin clicking a
    // firm-deal magic link (under /agent/firm-deal) gets signed out before
    // the route handler ever runs.
    if (!isPublic) {
      for (const [routePrefix, allowedRoles] of Object.entries(ROUTE_ROLES)) {
        if (pathname.startsWith(routePrefix)) {
          if (!profile || !allowedRoles.includes(profile.role)) {
            // User doesn't have the right role or no profile — sign out and redirect to login
            await supabase.auth.signOut()
            const url = request.nextUrl.clone()
            url.pathname = '/login'
            return NextResponse.redirect(url)
          }
          break
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
