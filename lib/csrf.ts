import { NextResponse } from 'next/server'

/**
 * Validate the Origin or Referer header on state-changing requests
 * to prevent CSRF attacks. Returns a 403 response if the origin
 * doesn't match, or null if the request is valid.
 */
const ALLOWED_ORIGINS = [
  'https://firmfunds.ca',
  'https://www.firmfunds.ca',
]

// Allow localhost in development
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:3001')
}

export function validateOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')

  // Check origin header first (most reliable)
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) return null
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Fall back to referer header
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin
      if (ALLOWED_ORIGINS.includes(refererOrigin)) return null
    } catch {
      // Invalid referer URL
    }
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // No origin or referer — reject state-changing requests. Previously this
  // allowed the request through under the theory that "browser-based CSRF
  // always has Origin" but: (1) some older browsers / proxies strip both,
  // (2) attackers can submit form POSTs from non-browser clients to bypass
  // the check. Require at least one of Origin/Referer matching ALLOWED.
  return NextResponse.json({ error: 'Forbidden: missing Origin/Referer' }, { status: 403 })
}
