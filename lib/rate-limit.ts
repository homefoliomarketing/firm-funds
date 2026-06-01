import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// ============================================================================
// Rate Limiting — Upstash Redis
// ============================================================================
// Uses sliding window algorithm. Each limiter has a different threshold
// appropriate for the sensitivity of the endpoint.
// ============================================================================

let redis: Redis | null = null

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getRedis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    if (isProduction()) {
      // Production: rate limiting MUST be configured. Don't silently disable.
      console.error('[rate-limit] CRITICAL: Upstash env vars missing in production. Rate limiting is OFF.')
    } else {
      console.warn('[rate-limit] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set — rate limiting disabled')
    }
    return null
  }
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return redis
}

// ============================================================================
// Limiters — sliding window
// ============================================================================

/** Login: 20 attempts per 15 minutes per IP (relaxed for multi-account testing) */
let loginLimiter: Ratelimit | null = null
function getLoginLimiter(): Ratelimit | null {
  const r = getRedis()
  if (!r) return null
  if (!loginLimiter) {
    loginLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(20, '15 m'),
      prefix: 'rl:login',
    })
  }
  return loginLimiter
}

/**
 * Login per-EMAIL: 10 attempts per 15 minutes per account.
 * Sits alongside the per-IP login limiter to throttle distributed
 * credential-stuffing (many IPs, one target email). Chosen tighter than the
 * relaxed per-IP limit (20) since a single human only ever drives one email,
 * but loose enough to survive a handful of legitimate typos plus the
 * multi-account testing the per-IP comment references. Keyed by normalized
 * email under a distinct prefix so it never collides with the IP buckets.
 */
let loginEmailLimiter: Ratelimit | null = null
function getLoginEmailLimiter(): Ratelimit | null {
  const r = getRedis()
  if (!r) return null
  if (!loginEmailLimiter) {
    loginEmailLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(10, '15 m'),
      prefix: 'rl:login:email',
    })
  }
  return loginEmailLimiter
}

/** Password change: 3 attempts per 15 minutes per IP */
let passwordLimiter: Ratelimit | null = null
function getPasswordLimiter(): Ratelimit | null {
  const r = getRedis()
  if (!r) return null
  if (!passwordLimiter) {
    passwordLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(3, '15 m'),
      prefix: 'rl:password',
    })
  }
  return passwordLimiter
}

/** Password reset: 3 attempts per 15 minutes per IP */
let resetLimiter: Ratelimit | null = null
function getResetLimiter(): Ratelimit | null {
  const r = getRedis()
  if (!r) return null
  if (!resetLimiter) {
    resetLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(3, '15 m'),
      prefix: 'rl:reset',
    })
  }
  return resetLimiter
}

/** API routes (general): 30 requests per minute per IP */
let apiLimiter: Ratelimit | null = null
function getApiLimiter(): Ratelimit | null {
  const r = getRedis()
  if (!r) return null
  if (!apiLimiter) {
    apiLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(30, '1 m'),
      prefix: 'rl:api',
    })
  }
  return apiLimiter
}

/**
 * Sensitive token / magic-link / unauthenticated-recovery endpoints.
 * 5 requests per minute is tight enough to defeat enumeration scans while
 * still permitting a legitimate user to retry a handful of times. Use this
 * for any endpoint where the response distinguishes "valid token / known
 * email" from "invalid / unknown" by content, status code, or timing.
 */
let sensitiveLimiter: Ratelimit | null = null
function getSensitiveLimiter(): Ratelimit | null {
  const r = getRedis()
  if (!r) return null
  if (!sensitiveLimiter) {
    sensitiveLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(5, '1 m'),
      prefix: 'rl:sensitive',
    })
  }
  return sensitiveLimiter
}

// ============================================================================
// Public API
// ============================================================================

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetInSeconds: number
}

async function checkLimit(
  limiter: Ratelimit | null,
  identifier: string
): Promise<RateLimitResult> {
  if (!limiter) {
    // Production: fail CLOSED. A misconfigured Upstash means no rate
    // limiting, which enables password spraying and token enumeration.
    // Dev: fail open so local development isn't blocked.
    if (isProduction()) {
      return { allowed: false, remaining: 0, resetInSeconds: 60 }
    }
    return { allowed: true, remaining: -1, resetInSeconds: 0 }
  }

  try {
    const result = await limiter.limit(identifier)
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetInSeconds: Math.ceil((result.reset - Date.now()) / 1000),
    }
  } catch (err) {
    console.error('[rate-limit] Upstash limiter call threw:', err)
    if (isProduction()) {
      return { allowed: false, remaining: 0, resetInSeconds: 60 }
    }
    return { allowed: true, remaining: -1, resetInSeconds: 0 }
  }
}

/** Check login rate limit (5 per 15 min) */
export async function checkLoginRateLimit(ip: string): Promise<RateLimitResult> {
  return checkLimit(getLoginLimiter(), ip)
}

/**
 * Check login rate limit per EMAIL (10 per 15 min). Normalizes the email
 * (trim + lowercase) before keying so 'A@B.com ' and 'a@b.com' share a
 * bucket. Always check this even for emails with no matching account, so it
 * cannot be used to probe account existence.
 */
export async function checkLoginEmailRateLimit(email: string): Promise<RateLimitResult> {
  const normalized = email.trim().toLowerCase()
  return checkLimit(getLoginEmailLimiter(), normalized)
}

/** Check password change rate limit (3 per 15 min) */
export async function checkPasswordRateLimit(ip: string): Promise<RateLimitResult> {
  return checkLimit(getPasswordLimiter(), ip)
}

/** Check password reset rate limit (3 per 15 min) */
export async function checkResetRateLimit(ip: string): Promise<RateLimitResult> {
  return checkLimit(getResetLimiter(), ip)
}

/** Check API rate limit (30 per minute) */
export async function checkApiRateLimit(ip: string): Promise<RateLimitResult> {
  return checkLimit(getApiLimiter(), ip)
}

/**
 * Check sensitive endpoint rate limit (5/min). Use on routes that handle
 * single-use tokens (kyc-validate-token, brokerage/confirm-contact-email)
 * or unauthenticated recovery (magic-link validate, password-reset trigger)
 * where the response leaks "token / email exists vs not" information.
 */
export async function checkSensitiveRateLimit(ip: string): Promise<RateLimitResult> {
  return checkLimit(getSensitiveLimiter(), ip)
}
