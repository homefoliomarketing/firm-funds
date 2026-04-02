'use server'

import { createClient } from '@/lib/supabase/server'

export interface AuditEntry {
  action: string        // e.g. 'deal.submit', 'deal.status_change', 'document.upload'
  entityType: string    // e.g. 'deal', 'document'
  entityId?: string     // UUID of affected entity
  metadata?: Record<string, any>  // Additional context
}

/**
 * Log an audit event. Does NOT block business operations on failure,
 * but logs a warning so failures are visible in monitoring.
 */
export async function logAuditEvent(entry: AuditEntry): Promise<void> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    const { error } = await supabase.from('audit_log').insert({
      user_id: user?.id || null,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId || null,
      metadata: entry.metadata || {},
    })

    if (error) {
      console.warn(`[AUDIT LOG FAILURE] action=${entry.action} entity=${entry.entityType}/${entry.entityId} error=${error.message}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.warn(`[AUDIT LOG FAILURE] action=${entry.action} error=${message}`)
  }
}
