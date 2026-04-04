import { NextResponse } from 'next/server'
import { checkLoginRateLimit, checkPasswordRateLimit, checkResetRateLimit } from '@/lib/rate-limit'

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

    // Extract IP from request headers (Netlify sets x-nf-client-connection-ip)
    const ip =
      request.headers.get('x-nf-client-connection-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '127.0.0.1'

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
  } catch (err: any) {
    console.error('[rate-limit] API error:', err?.message)
    // Fail open — don't block users if rate limiting is misconfigured
    return NextResponse.json({ allowed: true, remaining: -1 })
  }
}
