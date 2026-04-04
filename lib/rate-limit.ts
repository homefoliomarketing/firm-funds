import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// ============================================================================
// Rate Limiting — Upstash Redis
// ============================================================================
// Uses sliding window algorithm. Each limiter has a different threshold
// appropriate for the sensitivity of the endpoint.
// ============================================================================

let redis: Redis | null = null

function getRedis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[rate-limit] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set — rate limiting disabled')
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

/** Login: 5 attempts per 15 minutes per IP */
let loginLimiter: Ratelimit | null = null
function getLoginLimiter(): Ratelimit | null {
  const r = getRedis()
  if (!r) return null
  if (!loginLimiter) {
    loginLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(5, '15 m'),
      prefix: 'rl:login',
    })
  }
  return loginLimiter
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
    // Rate limiting not configured — allow (fail open, but log warning)
    return { allowed: true, remaining: -1, resetInSeconds: 0 }
  }

  const result = await limiter.limit(identifier)
  return {
    allowed: result.success,
    remaining: result.remaining,
    resetInSeconds: Math.ceil((result.reset - Date.now()) / 1000),
  }
}

/** Check login rate limit (5 per 15 min) */
export async function checkLoginRateLimit(ip: string): Promise<RateLimitResult> {
  return checkLimit(getLoginLimiter(), ip)
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
