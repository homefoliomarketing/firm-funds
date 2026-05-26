/**
 * Shared helpers for parsing trust-sensitive metadata off an incoming Request.
 *
 * Consolidates the "what is the real client IP" logic that previously lived
 * inline in audit.ts, the api route files, session-heartbeat, rate-limit, etc.
 * Each callsite implemented the same header-precedence chain slightly
 * differently: at minimum a CSRF-rejection that logged the wrong IP, at worst
 * a header-spoofable IP allowlist.
 *
 * Findings #49 and #74 both call for centralizing on a single helper.
 */
export function extractTrustedClientIp(request: Request): string | undefined {
  // Netlify-specific header. This is set by the Netlify edge from the actual
  // TCP peer and CANNOT be spoofed by the client — prefer it when present.
  const netlify = request.headers.get('x-nf-client-connection-ip')
  if (netlify && netlify.trim().length > 0) return netlify.trim()

  // x-forwarded-for is a comma-separated list with the original client first,
  // appended by each proxy hop. The leftmost entry is most likely the real
  // client but is client-spoofable on platforms that don't strip incoming
  // headers. Use only as a fallback.
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }

  const real = request.headers.get('x-real-ip')
  if (real && real.trim().length > 0) return real.trim()

  return undefined
}

/**
 * Same as extractTrustedClientIp but returns a localhost sentinel when no
 * header is present. Use this for rate limiters and other code paths that
 * want a non-empty bucket key in dev / unit tests rather than treating
 * "no IP" as a separate state.
 */
export function extractTrustedClientIpOrLocalhost(request: Request): string {
  return extractTrustedClientIp(request) ?? '127.0.0.1'
}
