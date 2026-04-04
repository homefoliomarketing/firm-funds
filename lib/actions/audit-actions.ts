'use server'

import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import type { AuditSeverity } from '@/lib/audit'

// ============================================================================
// Types
// ============================================================================

export interface AuditLogRow {
  id: string
  user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  metadata: Record<string, any>
  severity: AuditSeverity
  actor_email: string | null
  actor_role: string | null
  old_value: Record<string, any> | null
  new_value: Record<string, any> | null
  ip_address: string | null
  user_agent: string | null
  session_id: string | null
  created_at: string
}

export interface AuditQueryFilters {
  entityType?: string
  entityId?: string
  action?: string
  severity?: AuditSeverity
  actorEmail?: string
  search?: string
  dateFrom?: string
  dateTo?: string
}

export interface AuditQueryResult {
  data: AuditLogRow[]
  total: number
  error: string | null
}

// ============================================================================
// Query: Entity Timeline (for deal detail, agent detail, etc.)
// ============================================================================

/**
 * Fetch the audit timeline for a specific entity.
 * Used by the deal detail page to show all events for a deal.
 * Also fetches events for related entities (documents under this deal, etc.)
 */
export async function getEntityAuditTimeline(
  entityType: string,
  entityId: string,
  limit = 100
): Promise<AuditQueryResult> {
  const { error: authError, supabase } = await getAuthenticatedAdmin()
  if (authError) return { data: [], total: 0, error: authError }

  try {
    // For deals, we also want to see document events that reference this deal in metadata
    // Strategy: query by entity_id directly + query by metadata.deal_id for document events
    const { data: directEvents, error: err1 } = await supabase
      .from('audit_log')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (err1) throw err1

    let relatedEvents: AuditLogRow[] = []
    if (entityType === 'deal') {
      // Get document events that have this deal_id in metadata
      const { data: docEvents, error: err2 } = await supabase
        .from('audit_log')
        .select('*')
        .eq('entity_type', 'document')
        .filter('metadata->>deal_id', 'eq', entityId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (!err2 && docEvents) relatedEvents = docEvents as AuditLogRow[]
    }

    // Merge and deduplicate by id, sort by created_at desc
    const allEvents = [...(directEvents || []), ...relatedEvents] as AuditLogRow[]
    const uniqueMap = new Map<string, AuditLogRow>()
    for (const event of allEvents) {
      uniqueMap.set(event.id, event)
    }
    const merged = Array.from(uniqueMap.values())
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit)

    return { data: merged, total: merged.length, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch audit timeline'
    return { data: [], total: 0, error: message }
  }
}

// ============================================================================
// Query: Global Audit Explorer (paginated, filterable)
// ============================================================================

/**
 * Fetch audit logs with filters, pagination, and search.
 * Powers the global audit explorer admin page.
 * Uses cursor-based pagination (created_at + id) for performance.
 */
export async function queryAuditLogs(
  filters: AuditQueryFilters,
  page = 1,
  pageSize = 50
): Promise<AuditQueryResult> {
  const { error: authError, supabase } = await getAuthenticatedAdmin()
  if (authError) return { data: [], total: 0, error: authError }

  try {
    // Build count query
    let countQuery = supabase
      .from('audit_log')
      .select('*', { count: 'exact', head: true })

    // Build data query
    let dataQuery = supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)

    // Apply filters to both queries
    if (filters.entityType) {
      countQuery = countQuery.eq('entity_type', filters.entityType)
      dataQuery = dataQuery.eq('entity_type', filters.entityType)
    }
    if (filters.entityId) {
      countQuery = countQuery.eq('entity_id', filters.entityId)
      dataQuery = dataQuery.eq('entity_id', filters.entityId)
    }
    if (filters.action) {
      countQuery = countQuery.eq('action', filters.action)
      dataQuery = dataQuery.eq('action', filters.action)
    }
    if (filters.severity) {
      countQuery = countQuery.eq('severity', filters.severity)
      dataQuery = dataQuery.eq('severity', filters.severity)
    }
    if (filters.actorEmail) {
      countQuery = countQuery.ilike('actor_email', `%${filters.actorEmail}%`)
      dataQuery = dataQuery.ilike('actor_email', `%${filters.actorEmail}%`)
    }
    if (filters.dateFrom) {
      countQuery = countQuery.gte('created_at', filters.dateFrom)
      dataQuery = dataQuery.gte('created_at', filters.dateFrom)
    }
    if (filters.dateTo) {
      // Add a day to include the full end date
      const endDate = new Date(filters.dateTo)
      endDate.setDate(endDate.getDate() + 1)
      countQuery = countQuery.lt('created_at', endDate.toISOString())
      dataQuery = dataQuery.lt('created_at', endDate.toISOString())
    }
    if (filters.search) {
      // Search across action, entity_type, actor_email, and metadata
      const searchTerm = `%${filters.search}%`
      const orFilter = `action.ilike.${searchTerm},entity_type.ilike.${searchTerm},actor_email.ilike.${searchTerm}`
      countQuery = countQuery.or(orFilter)
      dataQuery = dataQuery.or(orFilter)
    }

    // Execute both queries in parallel
    const [countResult, dataResult] = await Promise.all([countQuery, dataQuery])

    if (countResult.error) throw countResult.error
    if (dataResult.error) throw dataResult.error

    return {
      data: (dataResult.data || []) as AuditLogRow[],
      total: countResult.count || 0,
      error: null,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to query audit logs'
    return { data: [], total: 0, error: message }
  }
}

// ============================================================================
// Query: Export Audit Logs (all matching records, no pagination limit)
// ============================================================================

/**
 * Fetch all audit logs matching filters for export.
 * Caps at 10,000 records for safety. Returns flat data ready for CSV.
 */
export async function exportAuditLogs(
  filters: AuditQueryFilters
): Promise<{ data: AuditLogRow[]; error: string | null }> {
  const { error: authError, supabase } = await getAuthenticatedAdmin()
  if (authError) return { data: [], error: authError }

  try {
    let query = supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10000)

    // Apply same filters as queryAuditLogs
    if (filters.entityType) query = query.eq('entity_type', filters.entityType)
    if (filters.entityId) query = query.eq('entity_id', filters.entityId)
    if (filters.action) query = query.eq('action', filters.action)
    if (filters.severity) query = query.eq('severity', filters.severity)
    if (filters.actorEmail) query = query.ilike('actor_email', `%${filters.actorEmail}%`)
    if (filters.dateFrom) query = query.gte('created_at', filters.dateFrom)
    if (filters.dateTo) {
      const endDate = new Date(filters.dateTo)
      endDate.setDate(endDate.getDate() + 1)
      query = query.lt('created_at', endDate.toISOString())
    }
    if (filters.search) {
      const searchTerm = `%${filters.search}%`
      query = query.or(`action.ilike.${searchTerm},entity_type.ilike.${searchTerm},actor_email.ilike.${searchTerm}`)
    }

    const { data, error } = await query
    if (error) throw error

    return { data: (data || []) as AuditLogRow[], error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to export audit logs'
    return { data: [], error: message }
  }
}

// ============================================================================
// Helpers: Distinct Values for Filter Dropdowns
// ============================================================================

/**
 * Fetch distinct action types for the filter dropdown.
 */
export async function getDistinctAuditActions(): Promise<string[]> {
  const { error: authError, supabase } = await getAuthenticatedAdmin()
  if (authError) return []

  const { data } = await supabase
    .from('audit_log')
    .select('action')
    .limit(1000)

  if (!data) return []

  // Deduplicate in JS since Supabase doesn't have native DISTINCT via the client
  const actions = [...new Set(data.map(r => r.action))].sort()
  return actions
}

/**
 * Fetch distinct entity types for the filter dropdown.
 */
export async function getDistinctEntityTypes(): Promise<string[]> {
  const { error: authError, supabase } = await getAuthenticatedAdmin()
  if (authError) return []

  const { data } = await supabase
    .from('audit_log')
    .select('entity_type')
    .limit(1000)

  if (!data) return []

  const types = [...new Set(data.map(r => r.entity_type))].sort()
  return types
}
