import { NextResponse } from 'next/server'

/**
 * Validate the Origin or Referer header on state-changing requests
 * to prevent CSRF attacks. Returns a 403 response if the origin
 * doesn't match, or null if the request is valid.
 *
 * NOTE: middleware.ts also enforces this for every state-changing /api/*
 * request (POST/PUT/PATCH/DELETE) so a new route that forgets to call
 * validateOrigin is not wide open. Per-handler calls are kept as defense
 * in depth and to allow custom error shapes.
 */
export const ALLOWED_ORIGINS = [
  'https://firmfunds.ca',
  'https://www.firmfunds.ca',
]

// Allow localhost in development
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:3001')
}

/**
 * Pure check used by both validateOrigin and the middleware-level CSRF
 * enforcement. Returns true if the request's Origin or Referer matches an
 * allowed origin. Returns false otherwise — including the "no header at all"
 * case, which we reject for state-changing requests.
 */
export function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin) return ALLOWED_ORIGINS.includes(origin)

  const referer = request.headers.get('referer')
  if (referer) {
    try {
      return ALLOWED_ORIGINS.includes(new URL(referer).origin)
    } catch {
      return false
    }
  }

  // Neither header present — reject. Previously this allowed the request
  // through under the theory that "browser-based CSRF always has Origin"
  // but: (1) some older browsers / proxies strip both, (2) attackers can
  // submit form POSTs from non-browser clients to bypass the check.
  return false
}

export function validateOrigin(request: Request): NextResponse | null {
  if (isAllowedOrigin(request)) return null

  const hasHeader =
    !!request.headers.get('origin') || !!request.headers.get('referer')

  return NextResponse.json(
    { error: hasHeader ? 'Forbidden' : 'Forbidden: missing Origin/Referer' },
    { status: 403 }
  )
}
