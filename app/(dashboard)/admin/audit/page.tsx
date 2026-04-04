'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  Shield, Search, X, ChevronLeft, ChevronRight, Download, Filter,
  Clock, User, ArrowLeft, ChevronDown, ChevronUp, ArrowRight,
  AlertTriangle, Info, FileText, Eye, ExternalLink
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { getActionLabel } from '@/lib/audit-labels'
import {
  queryAuditLogs,
  getDistinctAuditActions,
  getDistinctEntityTypes,
  type AuditLogRow,
  type AuditQueryFilters,
} from '@/lib/actions/audit-actions'
import { formatDateTime } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'

// ============================================================================
// Constants
// ============================================================================

const PAGE_SIZE = 50

const SEVERITY_OPTIONS = [
  { value: '', label: 'All Severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
]

// ============================================================================
// Severity Badge
// ============================================================================

function SeverityBadge({ severity, colors }: { severity: string; colors: any }) {
  const config: Record<string, { bg: string; text: string; border: string }> = {
    critical: { bg: colors.errorBg, text: colors.errorText, border: colors.errorBorder },
    warning: { bg: colors.warningBg, text: colors.warningText, border: colors.warningBorder },
    info: { bg: colors.infoBg, text: colors.infoText, border: colors.infoBorder },
  }
  const c = config[severity] || config.info
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 600,
        backgroundColor: c.bg,
        color: c.text,
        border: `1px solid ${c.border}`,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}
    >
      {severity}
    </span>
  )
}

// ============================================================================
// Value Diff (inline)
// ============================================================================

function InlineValueDiff({
  oldValue,
  newValue,
  colors,
}: {
  oldValue: Record<string, any> | null
  newValue: Record<string, any> | null
  colors: any
}) {
  if (!oldValue && !newValue) return null
  const allKeys = new Set([
    ...Object.keys(oldValue || {}),
    ...Object.keys(newValue || {}),
  ])
  if (allKeys.size === 0) return null

  return (
    <div style={{ fontSize: 12, marginTop: 4 }}>
      {Array.from(allKeys).map(key => {
        const oldVal = oldValue?.[key]
        const newVal = newValue?.[key]
        if (String(oldVal ?? '') === String(newVal ?? '')) return null
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        return (
          <div key={key} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: colors.textMuted }}>{label}:</span>
            {oldVal != null && <span style={{ color: colors.errorText, textDecoration: 'line-through' }}>{String(oldVal)}</span>}
            {oldVal != null && newVal != null && <ArrowRight size={10} style={{ color: colors.textMuted }} />}
            {newVal != null && <span style={{ color: colors.successText, fontWeight: 500 }}>{String(newVal)}</span>}
          </div>
        )
      })}
    </div>
  )
}

// ============================================================================
// Main Page Component
// ============================================================================

export default function AuditExplorerPage() {
  const router = useRouter()
  const supabase = createClient()
  const { colors } = useTheme()

  // Auth state
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  // Data
  const [logs, setLogs] = useState<AuditLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [severity, setSeverity] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [entityTypeFilter, setEntityTypeFilter] = useState('')
  const [actorEmailFilter, setActorEmailFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)

  // Filter dropdown options
  const [availableActions, setAvailableActions] = useState<string[]>([])
  const [availableEntityTypes, setAvailableEntityTypes] = useState<string[]>([])

  // Expanded rows
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // Filter panel visibility
  const [showFilters, setShowFilters] = useState(false)

  // Exporting
  const [exporting, setExporting] = useState(false)

  // ---- Auth check ----
  useEffect(() => {
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
        router.push('/login')
        return
      }

      setUser(user)
    }
    checkAuth()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // ---- Load filter options ----
  useEffect(() => {
    async function loadOptions() {
      const [actions, entityTypes] = await Promise.all([
        getDistinctAuditActions(),
        getDistinctEntityTypes(),
      ])
      setAvailableActions(actions)
      setAvailableEntityTypes(entityTypes)
    }
    if (user) loadOptions()
  }, [user])

  // ---- Load data ----
  const loadData = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)

    const filters: AuditQueryFilters = {}
    if (searchQuery.trim()) filters.search = searchQuery.trim()
    if (severity) filters.severity = severity as any
    if (actionFilter) filters.action = actionFilter
    if (entityTypeFilter) filters.entityType = entityTypeFilter
    if (actorEmailFilter.trim()) filters.actorEmail = actorEmailFilter.trim()
    if (dateFrom) filters.dateFrom = dateFrom
    if (dateTo) filters.dateTo = dateTo

    const result = await queryAuditLogs(filters, page, PAGE_SIZE)
    if (result.error) {
      setError(result.error)
    } else {
      setLogs(result.data)
      setTotal(result.total)
    }
    setLoading(false)
  }, [user, searchQuery, severity, actionFilter, entityTypeFilter, actorEmailFilter, dateFrom, dateTo, page])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Reset page when filters change
  useEffect(() => {
    setPage(1)
  }, [searchQuery, severity, actionFilter, entityTypeFilter, actorEmailFilter, dateFrom, dateTo])

  // ---- Export ----
  const handleExport = async (format: 'csv' | 'json') => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      params.set('format', format)
      if (searchQuery.trim()) params.set('search', searchQuery.trim())
      if (severity) params.set('severity', severity)
      if (actionFilter) params.set('action', actionFilter)
      if (entityTypeFilter) params.set('entityType', entityTypeFilter)
      if (actorEmailFilter.trim()) params.set('actorEmail', actorEmailFilter.trim())
      if (dateFrom) params.set('dateFrom', dateFrom)
      if (dateTo) params.set('dateTo', dateTo)

      const response = await fetch(`/api/audit/export?${params.toString()}`)
      if (!response.ok) throw new Error('Export failed')

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      alert('Export failed. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearFilters = () => {
    setSearchQuery('')
    setSeverity('')
    setActionFilter('')
    setEntityTypeFilter('')
    setActorEmailFilter('')
    setDateFrom('')
    setDateTo('')
    setPage(1)
  }

  const hasActiveFilters = searchQuery || severity || actionFilter || entityTypeFilter || actorEmailFilter || dateFrom || dateTo
  const totalPages = Math.ceil(total / PAGE_SIZE)

  // ---- Navigate to entity ----
  const navigateToEntity = (entityType: string, entityId: string | null) => {
    if (!entityId) return
    if (entityType === 'deal') router.push(`/admin/deals/${entityId}`)
    // Future: agent, brokerage links
  }

  // ---- Loading state ----
  if (!user) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: colors.pageBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: colors.textMuted }}>Loading...</p>
      </div>
    )
  }

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div style={{ minHeight: '100vh', backgroundColor: colors.pageBg }}>
      {/* Header */}
      <header
        className="sticky top-0 z-50"
        style={{
          background: colors.headerBgGradient,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/admin')}
                className="p-1.5 rounded-lg transition"
                style={{ color: '#FFFFFF' }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '0.7'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
              >
                <ArrowLeft size={18} />
              </button>
              <div className="flex items-center gap-2">
                <Shield size={18} style={{ color: colors.gold }} />
                <h1 className="text-base font-bold" style={{ color: '#FFFFFF' }}>
                  Audit Explorer
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-1 rounded" style={{ background: colors.gold + '22', color: colors.gold }}>
                {total.toLocaleString()} events
              </span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-4">
        {/* Search + Filter Bar */}
        <div className="rounded-lg p-4 mb-4" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          <div className="flex gap-2 mb-3">
            {/* Search */}
            <div className="flex-1 relative">
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: colors.textMuted }} />
              <input
                type="text"
                placeholder="Search actions, entities, actors..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-8 py-2 rounded-lg text-sm focus:outline-none"
                style={{
                  backgroundColor: colors.inputBg,
                  border: `1px solid ${colors.inputBorder}`,
                  color: colors.inputText,
                }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  style={{ color: colors.textMuted }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Filter toggle */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition"
              style={{
                background: hasActiveFilters ? colors.goldBg : colors.inputBg,
                border: `1px solid ${hasActiveFilters ? colors.gold : colors.inputBorder}`,
                color: hasActiveFilters ? colors.gold : colors.textSecondary,
              }}
            >
              <Filter size={14} />
              Filters
              {hasActiveFilters && <span style={{ fontSize: 10, fontWeight: 700 }}>●</span>}
            </button>

            {/* Export */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => handleExport('csv')}
                disabled={exporting || total === 0}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
                style={{
                  background: colors.gold,
                  color: '#FFFFFF',
                }}
                onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.opacity = '0.9' }}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
              >
                <Download size={14} />
                {exporting ? 'Exporting...' : 'Export CSV'}
              </button>
            </div>
            <button
              onClick={() => handleExport('json')}
              disabled={exporting || total === 0}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
              style={{
                background: colors.inputBg,
                border: `1px solid ${colors.inputBorder}`,
                color: colors.textSecondary,
              }}
              onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.opacity = '0.8' }}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
            >
              <Download size={14} />
              JSON
            </button>
          </div>

          {/* Filter panel (collapsible) */}
          {showFilters && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 pt-3" style={{ borderTop: `1px solid ${colors.divider}` }}>
              {/* Severity */}
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: colors.textMuted }}>Severity</label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none"
                  style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                >
                  {SEVERITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              {/* Action */}
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: colors.textMuted }}>Action</label>
                <select
                  value={actionFilter}
                  onChange={(e) => setActionFilter(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none"
                  style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                >
                  <option value="">All Actions</option>
                  {availableActions.map(a => (
                    <option key={a} value={a}>{getActionLabel(a)}</option>
                  ))}
                </select>
              </div>

              {/* Entity Type */}
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: colors.textMuted }}>Entity Type</label>
                <select
                  value={entityTypeFilter}
                  onChange={(e) => setEntityTypeFilter(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none"
                  style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                >
                  <option value="">All Types</option>
                  {availableEntityTypes.map(t => (
                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                  ))}
                </select>
              </div>

              {/* Actor Email */}
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: colors.textMuted }}>Actor Email</label>
                <input
                  type="text"
                  placeholder="Filter by email..."
                  value={actorEmailFilter}
                  onChange={(e) => setActorEmailFilter(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none"
                  style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                />
              </div>

              {/* Date From */}
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: colors.textMuted }}>From Date</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none"
                  style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText, colorScheme: 'dark' }}
                />
              </div>

              {/* Date To */}
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: colors.textMuted }}>To Date</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none"
                  style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText, colorScheme: 'dark' }}
                />
              </div>

              {/* Clear filters */}
              {hasActiveFilters && (
                <div className="col-span-full flex justify-end">
                  <button
                    onClick={clearFilters}
                    className="text-xs px-3 py-1 rounded transition"
                    style={{ color: colors.errorText, background: colors.errorBg }}
                  >
                    Clear All Filters
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg p-3 mb-4" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}` }}>
            <p className="text-sm" style={{ color: colors.errorText }}>{error}</p>
          </div>
        )}

        {/* Results Table */}
        <div className="rounded-lg overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          {/* Table Header */}
          <div
            className="grid gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider"
            style={{
              gridTemplateColumns: '150px 80px 1fr 180px 120px 40px',
              background: colors.tableHeaderBg,
              color: colors.textMuted,
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <span>Timestamp</span>
            <span>Severity</span>
            <span>Action</span>
            <span>Actor</span>
            <span>Entity</span>
            <span></span>
          </div>

          {/* Loading */}
          {loading && (
            <div className="py-12 text-center">
              <p style={{ color: colors.textMuted }}>Loading audit events...</p>
            </div>
          )}

          {/* Empty state */}
          {!loading && logs.length === 0 && (
            <div className="py-12 text-center">
              <Shield size={32} style={{ color: colors.textFaint, margin: '0 auto 8px' }} />
              <p className="text-sm" style={{ color: colors.textMuted }}>
                {hasActiveFilters ? 'No events match your filters.' : 'No audit events recorded yet.'}
              </p>
            </div>
          )}

          {/* Rows */}
          {!loading && logs.map((log) => {
            const isExpanded = expandedIds.has(log.id)
            const hasDetails = log.old_value || log.new_value ||
              (log.metadata && Object.keys(log.metadata).length > 0) ||
              log.ip_address || log.user_agent

            return (
              <div key={log.id}>
                <div
                  className="grid gap-2 px-4 py-2.5 items-center transition-colors"
                  style={{
                    gridTemplateColumns: '150px 80px 1fr 180px 120px 40px',
                    borderBottom: `1px solid ${colors.tableRowBorder}`,
                    cursor: hasDetails ? 'pointer' : 'default',
                    background: isExpanded ? colors.cardHoverBg : 'transparent',
                  }}
                  onClick={() => hasDetails && toggleExpanded(log.id)}
                  onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = colors.tableRowHoverBg }}
                  onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent' }}
                >
                  {/* Timestamp */}
                  <span className="text-xs" style={{ color: colors.textMuted }}>
                    {formatDateTime(log.created_at)}
                  </span>

                  {/* Severity */}
                  <SeverityBadge severity={log.severity || 'info'} colors={colors} />

                  {/* Action */}
                  <div>
                    <span className="text-sm font-medium" style={{ color: colors.textPrimary }}>
                      {getActionLabel(log.action)}
                    </span>
                    <span className="text-xs ml-2" style={{ color: colors.textFaint }}>
                      {log.action}
                    </span>
                  </div>

                  {/* Actor */}
                  <div className="truncate">
                    <span className="text-xs" style={{ color: colors.textSecondary }}>
                      {log.actor_email || 'System'}
                    </span>
                    {log.actor_role && (
                      <span className="block text-xs" style={{ color: colors.textFaint }}>
                        {log.actor_role.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>

                  {/* Entity */}
                  <div>
                    <span className="text-xs" style={{ color: colors.textMuted }}>
                      {log.entity_type}
                    </span>
                    {log.entity_id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          navigateToEntity(log.entity_type, log.entity_id)
                        }}
                        className="block text-xs truncate max-w-[110px] hover:underline"
                        style={{ color: colors.gold }}
                        title={log.entity_id}
                      >
                        {log.entity_id.slice(0, 8)}...
                      </button>
                    )}
                  </div>

                  {/* Expand indicator */}
                  <div style={{ textAlign: 'center' }}>
                    {hasDetails && (
                      isExpanded
                        ? <ChevronUp size={14} style={{ color: colors.textMuted }} />
                        : <ChevronDown size={14} style={{ color: colors.textMuted }} />
                    )}
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div
                    className="px-6 py-3"
                    style={{
                      background: colors.cardHoverBg,
                      borderBottom: `1px solid ${colors.tableRowBorder}`,
                    }}
                  >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Changes */}
                      {(log.old_value || log.new_value) && (
                        <div>
                          <p className="text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Changes</p>
                          <InlineValueDiff oldValue={log.old_value} newValue={log.new_value} colors={colors} />
                        </div>
                      )}

                      {/* Metadata */}
                      {log.metadata && Object.keys(log.metadata).length > 0 && (
                        <div>
                          <p className="text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Details</p>
                          <div style={{ fontSize: 12 }}>
                            {Object.entries(log.metadata).map(([key, value]) => (
                              <div key={key} style={{ marginBottom: 2 }}>
                                <span style={{ color: colors.textMuted }}>{key.replace(/_/g, ' ')}: </span>
                                <span style={{ color: colors.textSecondary }}>
                                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Request Info */}
                      {(log.ip_address || log.user_agent) && (
                        <div>
                          <p className="text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Request Info</p>
                          {log.ip_address && (
                            <p className="text-xs" style={{ color: colors.textSecondary }}>IP: {log.ip_address}</p>
                          )}
                          {log.user_agent && (
                            <p className="text-xs truncate" style={{ color: colors.textFaint }} title={log.user_agent}>
                              UA: {log.user_agent}
                            </p>
                          )}
                        </div>
                      )}

                      {/* IDs */}
                      <div>
                        <p className="text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>IDs</p>
                        <p className="text-xs font-mono" style={{ color: colors.textFaint }}>
                          Event: {log.id}
                        </p>
                        {log.entity_id && (
                          <p className="text-xs font-mono" style={{ color: colors.textFaint }}>
                            Entity: {log.entity_id}
                          </p>
                        )}
                        {log.user_id && (
                          <p className="text-xs font-mono" style={{ color: colors.textFaint }}>
                            User: {log.user_id}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 px-2">
            <p className="text-xs" style={{ color: colors.textMuted }}>
              Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()} events
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="flex items-center gap-1 px-3 py-1.5 rounded text-sm font-medium transition disabled:opacity-40"
                style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.textPrimary }}
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <span className="text-sm" style={{ color: colors.textSecondary }}>
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="flex items-center gap-1 px-3 py-1.5 rounded text-sm font-medium transition disabled:opacity-40"
                style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.textPrimary }}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
