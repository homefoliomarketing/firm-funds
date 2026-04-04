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

  // No origin or referer — likely server-side or API client call
  // For browser-based CSRF, the browser always sends Origin on cross-origin requests
  // So missing both headers means it's likely same-origin or non-browser — allow it
  return null
}
