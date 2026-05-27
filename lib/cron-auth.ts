import { NextRequest, NextResponse } from 'next/server'

/**
 * Validates the Authorization header on a cron route.
 *
 * Every /api/cron/* handler should call this as the FIRST line of work so a
 * forged caller never reaches the rest of the handler. Returns `null` when
 * the request is authorized; returns a ready-to-return NextResponse when it
 * is not.
 *
 * Usage:
 *
 *     export async function POST(req: NextRequest) {
 *       const unauth = validateCronAuth(req)
 *       if (unauth) return unauth
 *       // ...do the cron work...
 *     }
 *
 * Auth scheme: callers must send `Authorization: Bearer <CRON_SECRET>`. The
 * secret is configured in the Netlify environment as CRON_SECRET. Cron jobs
 * scheduled on cron-job.org (the production scheduler) inject the header
 * via their per-job "Custom HTTP headers" section.
 *
 * If CRON_SECRET is missing from the environment, the route responds 500 so
 * the misconfiguration surfaces immediately rather than silently allowing
 * every caller through (or silently rejecting every caller).
 */
export function validateCronAuth(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron-auth] CRON_SECRET env var not configured')
    return NextResponse.json(
      { error: 'Cron auth not configured' },
      { status: 500 }
    )
  }
  const header = req.headers.get('authorization')
  if (header !== `Bearer ${secret}`) {
    console.warn('[cron-auth] Invalid or missing Authorization header')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
