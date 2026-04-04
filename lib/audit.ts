'use server'

import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/server'
import type { AuditSeverity } from '@/lib/audit-labels'

// ============================================================================
// Types
// ============================================================================

export interface AuditEntry {
  action: string            // e.g. 'deal.submit', 'deal.status_change', 'document.upload'
  entityType: string        // e.g. 'deal', 'document', 'agent', 'brokerage'
  entityId?: string         // UUID of affected entity
  metadata?: Record<string, any>  // Additional context
  severity?: AuditSeverity  // Defaults to 'info'
  oldValue?: Record<string, any>  // Previous state (for changes)
  newValue?: Record<string, any>  // New state (for changes)
}

/**
 * Context passed alongside audit entries for richer logging.
 * Server actions can pass headers; API routes have direct access to Request.
 */
export interface AuditContext {
  ipAddress?: string
  userAgent?: string
  sessionId?: string
}

// ============================================================================
// Severity Classification Map
// ============================================================================

const ACTION_SEVERITY: Record<string, AuditSeverity> = {
  // Critical — funding decisions, financial records, access changes
  'deal.status_change':       'critical',
  'eft.record':               'critical',
  'eft.confirm':              'critical',
  'eft.remove':               'critical',
  'brokerage_payment.record': 'critical',
  'brokerage_payment.remove': 'critical',
  'agent.archive':            'critical',
  'user.role_change':         'critical',
  'agent.kyc_verify':         'critical',
  'agent.kyc_reject':         'critical',
  'brokerage.kyc_verify':     'critical',
  'brokerage.kyc_revoke':     'critical',
  'deal.delete':              'critical',

  // Warning — edits to financial data, password changes, document deletions
  'deal.edit':                'warning',
  'deal.closing_date_updated':'warning',
  'deal.cancel':              'warning',
  'deal.withdrawn':           'warning',
  'document.delete':          'warning',
  'user.password_changed':    'warning',
  'deal.admin_notes_updated': 'warning',
  'auth.login_failed':        'warning',

  // Info — routine operations
  'deal.submit':              'info',
  'document.upload':          'info',
  'document.view':            'info',
  'document.request':         'info',
  'document.request_fulfilled':'info',
  'document.request_cancelled':'info',
  'deal.admin_note_added':    'info',
  'checklist.toggle':         'info',
  'agent.create':             'info',
  'agent.update':             'info',
  'agent.invite':             'info',
  'agent.resend_welcome':     'info',
  'agent.bulk_import':        'info',
  'agent.kyc_submit':         'info',
  'agent.kyc_submit_mobile':  'info',
  'agent.kyc_mobile_link_sent':'info',
  'brokerage.create':         'info',
  'brokerage.update':         'info',
  'user.create':              'info',
  'auth.login':               'info',
  'auth.logout':              'info',
  'auth.session_timeout':     'warning',
}

/**
 * Get the severity for an action, with special handling for status changes.
 * Funding/denial status changes are critical; others are warning.
 */
function resolveSeverity(entry: AuditEntry): AuditSeverity {
  // Explicit override takes priority
  if (entry.severity) return entry.severity

  // Special case: deal status changes — funding/denial are critical, others are warning
  if (entry.action === 'deal.status_change') {
    const newStatus = entry.metadata?.new_status || entry.newValue?.status
    if (newStatus === 'funded' || newStatus === 'denied') return 'critical'
    return 'warning'
  }

  return ACTION_SEVERITY[entry.action] || 'info'
}

// ============================================================================
// Core Logging Function (Authenticated Context)
// ============================================================================

/**
 * Log an audit event. Does NOT block business operations on failure,
 * but logs a warning so failures are visible in monitoring.
 *
 * Uses the authenticated user's Supabase client to capture user context.
 * New columns (severity, old_value, new_value, actor_email, actor_role)
 * are populated automatically when available.
 */
export async function logAuditEvent(
  entry: AuditEntry,
  context?: AuditContext
): Promise<void> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Fetch actor profile for denormalized fields
    let actorEmail: string | null = null
    let actorRole: string | null = null
    if (user) {
      actorEmail = user.email || null
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role, email')
        .eq('id', user.id)
        .single()
      if (profile) {
        actorRole = profile.role
        // Prefer profile email if available
        if (profile.email) actorEmail = profile.email
      }
    }

    const { error } = await supabase.from('audit_log').insert({
      user_id: user?.id || null,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId || null,
      metadata: entry.metadata || {},
      severity: resolveSeverity(entry),
      actor_email: actorEmail,
      actor_role: actorRole,
      old_value: entry.oldValue || null,
      new_value: entry.newValue || null,
      ip_address: context?.ipAddress || null,
      user_agent: context?.userAgent || null,
      session_id: context?.sessionId || null,
    })

    if (error) {
      console.warn(`[AUDIT LOG FAILURE] action=${entry.action} entity=${entry.entityType}/${entry.entityId} error=${error.message}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.warn(`[AUDIT LOG FAILURE] action=${entry.action} error=${message}`)
  }
}

// ============================================================================
// Service Role Logging (for API routes without authenticated context)
// ============================================================================

/**
 * Log an audit event using the service role client.
 * Use this in API routes where there's no authenticated user session
 * (e.g., cron jobs, public token-based routes, webhook handlers).
 */
export async function logAuditEventServiceRole(
  entry: AuditEntry & {
    userId?: string
    actorEmail?: string
    actorRole?: string
  },
  context?: AuditContext
): Promise<void> {
  try {
    const serviceClient = createServiceRoleClient()

    const { error } = await serviceClient.from('audit_log').insert({
      user_id: entry.userId || null,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId || null,
      metadata: entry.metadata || {},
      severity: resolveSeverity(entry),
      actor_email: entry.actorEmail || null,
      actor_role: entry.actorRole || null,
      old_value: entry.oldValue || null,
      new_value: entry.newValue || null,
      ip_address: context?.ipAddress || null,
      user_agent: context?.userAgent || null,
      session_id: context?.sessionId || null,
    })

    if (error) {
      console.warn(`[AUDIT LOG FAILURE] action=${entry.action} entity=${entry.entityType}/${entry.entityId} error=${error.message}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.warn(`[AUDIT LOG FAILURE] action=${entry.action} error=${message}`)
  }
}

// ============================================================================
// Helpers (async to satisfy 'use server' requirement)
// ============================================================================

/**
 * Extract IP address and user-agent from a Request object.
 * Works in both Netlify serverless and Supabase Edge contexts.
 */
export async function extractRequestContext(request: Request): Promise<AuditContext> {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip') || undefined
  const userAgent = request.headers.get('user-agent') || undefined

  return {
    ipAddress: ip,
    userAgent,
  }
}

/**
 * Build old/new value objects from before/after snapshots of a record.
 * Only includes fields that actually changed.
 */
export async function diffValues(
  oldRecord: Record<string, any>,
  newRecord: Record<string, any>,
  fields: string[]
): Promise<{ oldValue: Record<string, any>; newValue: Record<string, any> } | null> {
  const oldValue: Record<string, any> = {}
  const newValue: Record<string, any> = {}
  let hasChanges = false

  for (const field of fields) {
    const oldVal = oldRecord[field]
    const newVal = newRecord[field]
    // Compare as strings to handle number/string type mismatches
    if (String(oldVal ?? '') !== String(newVal ?? '')) {
      oldValue[field] = oldVal ?? null
      newValue[field] = newVal ?? null
      hasChanges = true
    }
  }

  return hasChanges ? { oldValue, newValue } : null
}
