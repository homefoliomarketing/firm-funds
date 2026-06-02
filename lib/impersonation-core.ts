// ============================================================================
// Impersonation — pure helpers (no I/O, no server-only imports)
// ============================================================================
// Safe to import from anywhere: client components, the request proxy, server
// actions, and unit tests. The DB / cookie / audit side lives in
// lib/impersonation.ts ('server-only'). Keeping the decision logic here means
// the proxy never pulls next/headers or the service-role client into its
// bundle, and the rules are testable without a database.
// ============================================================================

import type { UserRole } from '@/types/database'

/** HTTP methods that mutate state. Server Actions are ALWAYS POST. */
export const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The ONLY paths allowed to take a state-changing request while a view-as
 * session is active. Everything else (every form submit, every server action,
 * every API write) is blocked — that is the "look-only" guarantee.
 *   - /api/impersonation/stop  : the Exit button must always work.
 *   - /api/session-heartbeat   : keep-alive (POST) + logout audit (DELETE).
 * Starting a NEW view-as is intentionally NOT here: you must Exit first.
 */
export const IMPERSONATION_WRITE_ALLOWLIST = [
  '/api/impersonation/stop',
  '/api/session-heartbeat',
] as const

function pathMatches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/**
 * Should the PROXY block this request because the caller is viewing-as another
 * user? This is a coarse safety net for raw `/api/*` mutation routes only.
 *
 * It deliberately does NOT block Server Action POSTs (which target page paths,
 * not `/api/*`): those are how the dashboards READ their data (balance,
 * notifications, offers), and blocking them at the transport would break the
 * faithful view that impersonation exists to provide. Server Actions cannot be
 * distinguished read-from-write at the proxy, so the WRITE block lives at the
 * action layer instead — admin/money/destructive actions deny automatically
 * because the viewed target holds no capabilities, and agent/brokerage
 * self-service writes carry an explicit isImpersonating guard. Reads
 * (GET/HEAD/OPTIONS) are always allowed.
 */
export function isImpersonationWriteBlocked(method: string, pathname: string): boolean {
  if (!STATE_CHANGING_METHODS.has(method.toUpperCase())) return false
  if (!pathname.startsWith('/api/')) return false
  for (const allowed of IMPERSONATION_WRITE_ALLOWLIST) {
    if (pathMatches(pathname, allowed)) return false
  }
  return true
}

/** Minimal active-session shape the pure helpers need. */
export interface ActiveSessionLike {
  ended_at: string | null
  expires_at: string
}

/**
 * Is a session row currently active? Active = not ended AND not past its hard
 * expiry. `nowMs` is injected so this is deterministic and testable.
 */
export function isSessionActive(
  session: ActiveSessionLike | null | undefined,
  nowMs: number,
): boolean {
  if (!session) return false
  if (session.ended_at) return false
  return new Date(session.expires_at).getTime() > nowMs
}

/**
 * The role the proxy's route gate should enforce for this request. While
 * viewing-as, the Owner is confined to the TARGET's role routes; otherwise
 * their own role applies.
 */
export function effectiveRouteRole(
  realRole: UserRole,
  targetRole: UserRole | null | undefined,
): UserRole {
  return targetRole ?? realRole
}

/** Landing path for a role's dashboard. */
export function dashboardPathForRole(role: UserRole | null | undefined): string {
  switch (role) {
    case 'agent':
      return '/agent'
    case 'brokerage_admin':
      return '/brokerage'
    case 'firm_funds_admin':
    case 'super_admin':
      return '/admin'
    default:
      return '/agent'
  }
}

// ----------------------------------------------------------------------------
// Browser hint cookie (UI-only). Tells client dashboards to render the target
// instead of the signed-in Owner. NOT a security token — see
// IMPERSONATION_HINT_COOKIE in lib/constants.ts.
// ----------------------------------------------------------------------------

export interface ImpersonationHint {
  /** target user id */
  t: string
  /** target email (for display) */
  e: string | null
  /** target role */
  r: UserRole
  /** hard expiry, epoch ms */
  x: number
  /** target full name (for the banner / display) */
  n: string | null
}

// encode/decode are plain JSON and are exact inverses. URL-encoding is the
// cookie transport layer's job: the server cookie store (cookies().set) encodes
// the value on write, and the browser read path (readImpersonationHintCookie)
// decodes it once before calling decodeImpersonationHint. Adding our own
// encodeURIComponent here would double-encode and break the round-trip.
export function encodeImpersonationHint(hint: ImpersonationHint): string {
  return JSON.stringify(hint)
}

/** Decode + validate the hint (already URL-decoded). Null if malformed/expired. */
export function decodeImpersonationHint(
  raw: string | null | undefined,
  nowMs: number,
): ImpersonationHint | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ImpersonationHint>
    if (
      !parsed ||
      typeof parsed.t !== 'string' ||
      typeof parsed.r !== 'string' ||
      typeof parsed.x !== 'number'
    ) {
      return null
    }
    if (parsed.x <= nowMs) return null
    return {
      t: parsed.t,
      e: typeof parsed.e === 'string' ? parsed.e : null,
      r: parsed.r as UserRole,
      x: parsed.x,
      n: typeof parsed.n === 'string' ? parsed.n : null,
    }
  } catch {
    return null
  }
}
