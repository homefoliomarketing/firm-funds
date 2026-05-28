import { NextResponse } from 'next/server'
import { checkLoginRateLimit, checkPasswordRateLimit, checkResetRateLimit } from '@/lib/rate-limit'
import { extractTrustedClientIpOrLocalhost } from '@/lib/request-helpers'

/**
 * Rate limit check endpoint — called by client-side pages (login, password change)
 * before attempting the actual auth operation.
 *
 * POST body: { action: 'login' | 'password' | 'reset' }
 * Returns: { allowed: true, remaining } or { allowed: false, retryAfter }
 */
export async function POST(request: Request) {
  try {
    const { action } = await request.json()

    // Centralized header-precedence chain (see lib/request-helpers.ts). Avoids
    // the per-route drift this endpoint previously had — the inline chain here
    // checked x-real-ip, the docusign webhook gold-standard didn't, and the
    // KYC routes didn't either. One helper, one rule.
    const ip = extractTrustedClientIpOrLocalhost(request)

    let result

    switch (action) {
      case 'login':
        result = await checkLoginRateLimit(ip)
        break
      case 'password':
        result = await checkPasswordRateLimit(ip)
        break
      case 'reset':
        result = await checkResetRateLimit(ip)
        break
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    if (!result.allowed) {
      return NextResponse.json(
        {
          allowed: false,
          retryAfter: result.resetInSeconds,
          error: `Too many attempts. Please try again in ${Math.ceil(result.resetInSeconds / 60)} minute${result.resetInSeconds > 60 ? 's' : ''}.`,
        },
        { status: 429 }
      )
    }

    return NextResponse.json({
      allowed: true,
      remaining: result.remaining,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('[rate-limit] API error:', message)
    // Fail open — don't block users if rate limiting is misconfigured
    return NextResponse.json({ allowed: true, remaining: -1 })
  }
}
