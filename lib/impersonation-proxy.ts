// ============================================================================
// Impersonation — proxy-safe audit writer
// ============================================================================
// proxy.ts must not import lib/impersonation.ts or lib/audit.ts: both pull in
// next/headers (via lib/supabase/server), which does not belong in the proxy
// import graph. This module builds its OWN service-role client directly from
// @supabase/supabase-js (no next/headers) so the proxy can record a blocked
// action without that coupling.
//
// "Blocked action" rows are written when a staffer who is currently viewing-as
// another user attempts a state-changing request (a form submit / server
// action / API write). They are part of the audit trail required for
// impersonation. The actor stays the REAL staffer; impersonated_target_id
// records who they were viewing.
// ============================================================================

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export interface BlockedActionInput {
  realUserId: string
  realEmail?: string | null
  realRole?: string | null
  targetUserId: string
  method: string
  pathname: string
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Record a blocked write attempted while viewing-as. Best-effort and
 * non-throwing: a logging failure must never change the proxy's decision to
 * block. Call via event.waitUntil() so it does not add latency to the response.
 */
export async function logBlockedImpersonationAction(input: BlockedActionInput): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return

    const svc = createSupabaseClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { error } = await svc.from('audit_log').insert({
      user_id: input.realUserId,
      action: 'impersonation.blocked',
      entity_type: 'user',
      entity_id: input.targetUserId,
      severity: 'warning',
      actor_email: input.realEmail ?? null,
      actor_role: input.realRole ?? null,
      impersonated_target_id: input.targetUserId,
      metadata: { method: input.method, path: input.pathname },
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
    })

    if (error) {
      console.warn(`[AUDIT LOG FAILURE] action=impersonation.blocked error=${error.message}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.warn(`[AUDIT LOG FAILURE] action=impersonation.blocked error=${message}`)
  }
}
