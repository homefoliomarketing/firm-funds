import { describe, it, expect } from 'vitest'
import {
  isImpersonationWriteBlocked,
  isSessionActive,
  effectiveRouteRole,
  dashboardPathForRole,
  encodeImpersonationHint,
  decodeImpersonationHint,
  type ImpersonationHint,
} from './impersonation-core'

describe('isImpersonationWriteBlocked', () => {
  it('allows all read methods regardless of path', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isImpersonationWriteBlocked(m, '/agent')).toBe(false)
      expect(isImpersonationWriteBlocked(m, '/api/anything')).toBe(false)
    }
  })

  it('blocks state-changing requests to /api/* mutation routes', () => {
    expect(isImpersonationWriteBlocked('PUT', '/api/deals/123')).toBe(true)
    expect(isImpersonationWriteBlocked('DELETE', '/api/documents/9')).toBe(true)
    expect(isImpersonationWriteBlocked('POST', '/api/preauth-upload')).toBe(true)
  })

  it('does NOT block Server Action POSTs to page paths (those are how dashboards read; writes are blocked at the action layer)', () => {
    expect(isImpersonationWriteBlocked('POST', '/agent')).toBe(false)
    expect(isImpersonationWriteBlocked('POST', '/agent/deals/abc')).toBe(false)
    expect(isImpersonationWriteBlocked('PATCH', '/brokerage')).toBe(false)
  })

  it('allows the Exit and heartbeat endpoints so look-only can be left and kept alive', () => {
    expect(isImpersonationWriteBlocked('POST', '/api/impersonation/stop')).toBe(false)
    expect(isImpersonationWriteBlocked('POST', '/api/session-heartbeat')).toBe(false)
    expect(isImpersonationWriteBlocked('DELETE', '/api/session-heartbeat')).toBe(false)
  })

  it('does NOT allow starting another view-as while one is active (must Exit first)', () => {
    expect(isImpersonationWriteBlocked('POST', '/api/impersonation/start')).toBe(true)
  })

  it('only treats exact path or a sub-path of the allowlist as exempt (no prefix smuggling)', () => {
    // a different sibling path that merely starts with the same string is NOT exempt
    expect(isImpersonationWriteBlocked('POST', '/api/impersonation/stop-all')).toBe(true)
    expect(isImpersonationWriteBlocked('POST', '/api/session-heartbeat-evil')).toBe(true)
    // a genuine sub-path IS exempt
    expect(isImpersonationWriteBlocked('POST', '/api/session-heartbeat/sub')).toBe(false)
  })
})

describe('isSessionActive', () => {
  const now = 1_000_000
  it('active when not ended and not past expiry', () => {
    expect(isSessionActive({ ended_at: null, expires_at: new Date(now + 60_000).toISOString() }, now)).toBe(true)
  })
  it('inactive when ended, even if not expired', () => {
    expect(isSessionActive({ ended_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString() }, now)).toBe(false)
  })
  it('inactive when expired', () => {
    expect(isSessionActive({ ended_at: null, expires_at: new Date(now - 1).toISOString() }, now)).toBe(false)
  })
  it('inactive exactly at expiry (strictly future required)', () => {
    expect(isSessionActive({ ended_at: null, expires_at: new Date(now).toISOString() }, now)).toBe(false)
  })
  it('inactive for null/undefined', () => {
    expect(isSessionActive(null, now)).toBe(false)
    expect(isSessionActive(undefined, now)).toBe(false)
  })
})

describe('effectiveRouteRole', () => {
  it('uses the target role when impersonating', () => {
    expect(effectiveRouteRole('super_admin', 'agent')).toBe('agent')
    expect(effectiveRouteRole('super_admin', 'brokerage_admin')).toBe('brokerage_admin')
  })
  it('falls back to the real role when not impersonating', () => {
    expect(effectiveRouteRole('super_admin', null)).toBe('super_admin')
    expect(effectiveRouteRole('firm_funds_admin', undefined)).toBe('firm_funds_admin')
  })
})

describe('dashboardPathForRole', () => {
  it('maps each role to its dashboard', () => {
    expect(dashboardPathForRole('agent')).toBe('/agent')
    expect(dashboardPathForRole('brokerage_admin')).toBe('/brokerage')
    expect(dashboardPathForRole('firm_funds_admin')).toBe('/admin')
    expect(dashboardPathForRole('super_admin')).toBe('/admin')
  })
  it('defaults to /agent for unknown/null', () => {
    expect(dashboardPathForRole(null)).toBe('/agent')
    expect(dashboardPathForRole(undefined)).toBe('/agent')
  })
})

describe('impersonation hint cookie encode/decode', () => {
  const now = 1_000_000
  const hint: ImpersonationHint = {
    t: 'target-uuid',
    e: 'jane@example.com',
    r: 'agent',
    x: now + 60_000,
    n: 'Jane Smith',
  }

  it('round-trips a valid hint', () => {
    const decoded = decodeImpersonationHint(encodeImpersonationHint(hint), now)
    expect(decoded).toEqual(hint)
  })

  it('survives names/emails with special characters', () => {
    const tricky: ImpersonationHint = { ...hint, n: "O'Brien & Co; ção", e: 'a+b@x.io' }
    expect(decodeImpersonationHint(encodeImpersonationHint(tricky), now)).toEqual(tricky)
  })

  it('returns null for an expired hint', () => {
    const expired = encodeImpersonationHint({ ...hint, x: now - 1 })
    expect(decodeImpersonationHint(expired, now)).toBeNull()
  })

  it('returns null for missing/garbage values', () => {
    expect(decodeImpersonationHint(null, now)).toBeNull()
    expect(decodeImpersonationHint(undefined, now)).toBeNull()
    expect(decodeImpersonationHint('not json', now)).toBeNull()
    expect(decodeImpersonationHint(JSON.stringify({ t: 'x' }), now)).toBeNull() // valid JSON, missing expiry/role
  })

  it('encode produces plain JSON (URL-encoding is the cookie layer’s job, not double-applied here)', () => {
    const raw = encodeImpersonationHint(hint)
    expect(raw.startsWith('{')).toBe(true) // not percent-encoded
    expect(JSON.parse(raw)).toEqual(hint)
  })

  it('tolerates a missing name (optional display field)', () => {
    const noName = { t: 'u', e: null, r: 'brokerage_admin', x: now + 5_000, n: null } as ImpersonationHint
    expect(decodeImpersonationHint(encodeImpersonationHint(noName), now)).toEqual(noName)
  })
})
