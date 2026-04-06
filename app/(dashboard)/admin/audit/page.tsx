'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  Shield, Search, X, ChevronLeft, ChevronRight, Download, Filter,
  Clock, User, ArrowLeft, ChevronDown, ChevronUp, ArrowRight,
  AlertTriangle, Info, FileText, Eye, ExternalLink
} from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

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

function SeverityBadge({ severity }: { severity: string }) {
  const classes: Record<string, string> = {
    critical: 'bg-red-950/50 text-red-400 border-red-800',
    warning: 'bg-yellow-950/50 text-yellow-400 border-yellow-800',
    info: 'bg-blue-950/50 text-blue-400 border-blue-800',
  }
  const cls = classes[severity] || classes.info
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide border ${cls}`}>
      {severity}
    </span>
  )
}

// ============================================================================
// Value Diff
// ============================================================================

function InlineValueDiff({
  oldValue,
  newValue,
}: {
  oldValue: Record<string, any> | null
  newValue: Record<string, any> | null
}) {
  if (!oldValue && !newValue) return null
  const allKeys = new Set([
    ...Object.keys(oldValue || {}),
    ...Object.keys(newValue || {}),
  ])
  if (allKeys.size === 0) return null

  return (
    <div className="text-xs mt-1 space-y-0.5">
      {Array.from(allKeys).map(key => {
        const oldVal = oldValue?.[key]
        const newVal = newValue?.[key]
        if (String(oldVal ?? '') === String(newVal ?? '')) return null
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        return (
          <div key={key} className="flex gap-1 items-center flex-wrap">
            <span className="text-muted-foreground">{label}:</span>
            {oldVal != null && <span className="text-red-400 line-through">{String(oldVal)}</span>}
            {oldVal != null && newVal != null && <ArrowRight size={10} className="text-muted-foreground" />}
            {newVal != null && <span className="text-green-400 font-medium">{String(newVal)}</span>}
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

  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const [logs, setLogs] = useState<AuditLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [severity, setSeverity] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [entityTypeFilter, setEntityTypeFilter] = useState('')
  const [actorEmailFilter, setActorEmailFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)

  const [availableActions, setAvailableActions] = useState<string[]>([])
  const [availableEntityTypes, setAvailableEntityTypes] = useState<string[]>([])

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showFilters, setShowFilters] = useState(false)
  const [exporting, setExporting] = useState(false)

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

  useEffect(() => {
    setPage(1)
  }, [searchQuery, severity, actionFilter, entityTypeFilter, actorEmailFilter, dateFrom, dateTo])

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

  const navigateToEntity = (entityType: string, entityId: string | null) => {
    if (!entityId) return
    if (entityType === 'deal') router.push(`/admin/deals/${entityId}`)
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/admin')}
                className="p-1.5 rounded-lg text-white hover:opacity-70 transition-opacity"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="flex items-center gap-2">
                <Shield size={18} className="text-primary" />
                <h1 className="text-base font-bold text-white">Audit Explorer</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-1 rounded bg-primary/10 text-primary">
                {total.toLocaleString()} events
              </span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-4">
        {/* Search + Filter Bar */}
        <div className="rounded-lg p-4 mb-4 bg-card border border-border/50">
          <div className="flex gap-2 mb-3">
            {/* Search */}
            <div className="flex-1 relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search actions, entities, actors..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-8"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Filter toggle */}
            <Button
              onClick={() => setShowFilters(!showFilters)}
              variant="outline"
              size="sm"
              className={`gap-1.5 ${hasActiveFilters ? 'border-primary text-primary bg-primary/5' : ''}`}
            >
              <Filter size={14} />
              Filters
              {hasActiveFilters && <span className="text-[10px] font-bold">●</span>}
            </Button>

            {/* Export CSV */}
            <Button
              onClick={() => handleExport('csv')}
              disabled={exporting || total === 0}
              size="sm"
              className="gap-1.5"
            >
              <Download size={14} />
              {exporting ? 'Exporting...' : 'Export CSV'}
            </Button>

            {/* Export JSON */}
            <Button
              onClick={() => handleExport('json')}
              disabled={exporting || total === 0}
              variant="outline"
              size="sm"
              className="gap-1.5"
            >
              <Download size={14} />
              JSON
            </Button>
          </div>

          {/* Filter panel */}
          {showFilters && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 pt-3 border-t border-border/50">
              <div>
                <label className="block text-xs font-medium mb-1 text-muted-foreground">Severity</label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none bg-input border border-border text-foreground"
                >
                  {SEVERITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1 text-muted-foreground">Action</label>
                <select
                  value={actionFilter}
                  onChange={(e) => setActionFilter(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none bg-input border border-border text-foreground"
                >
                  <option value="">All Actions</option>
                  {availableActions.map(a => (
                    <option key={a} value={a}>{getActionLabel(a)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1 text-muted-foreground">Entity Type</label>
                <select
                  value={entityTypeFilter}
                  onChange={(e) => setEntityTypeFilter(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none bg-input border border-border text-foreground"
                >
                  <option value="">All Types</option>
                  {availableEntityTypes.map(t => (
                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1 text-muted-foreground">Actor Email</label>
                <Input
                  type="text"
                  placeholder="Filter by email..."
                  value={actorEmailFilter}
                  onChange={(e) => setActorEmailFilter(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1 text-muted-foreground">From Date</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none bg-input border border-border text-foreground [color-scheme:dark]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1 text-muted-foreground">To Date</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-sm focus:outline-none bg-input border border-border text-foreground [color-scheme:dark]"
                />
              </div>

              {hasActiveFilters && (
                <div className="col-span-full flex justify-end">
                  <Button
                    onClick={clearFilters}
                    variant="outline"
                    size="sm"
                    className="text-red-400 border-red-800 hover:bg-red-950/30"
                  >
                    Clear All Filters
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg p-3 mb-4 bg-red-950/50 border border-red-800">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Results Table */}
        <div className="rounded-lg overflow-hidden bg-card border border-border/50">
          {/* Table Header */}
          <div
            className="grid gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider bg-muted/50 border-b border-border/50 text-muted-foreground"
            style={{ gridTemplateColumns: '150px 80px 1fr 180px 120px 40px' }}
          >
            <span>Timestamp</span>
            <span>Severity</span>
            <span>Action</span>
            <span>Actor</span>
            <span>Entity</span>
            <span></span>
          </div>

          {loading && (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">Loading audit events...</p>
            </div>
          )}

          {!loading && logs.length === 0 && (
            <div className="py-12 text-center">
              <Shield size={32} className="text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {hasActiveFilters ? 'No events match your filters.' : 'No audit events recorded yet.'}
              </p>
            </div>
          )}

          {!loading && logs.map((log) => {
            const isExpanded = expandedIds.has(log.id)
            const hasDetails = log.old_value || log.new_value ||
              (log.metadata && Object.keys(log.metadata).length > 0) ||
              log.ip_address || log.user_agent

            return (
              <div key={log.id}>
                <div
                  className={`grid gap-2 px-4 py-2.5 items-center transition-colors border-b border-border/30 ${
                    hasDetails ? 'cursor-pointer' : ''
                  } ${isExpanded ? 'bg-muted/40' : 'hover:bg-muted/20'}`}
                  style={{ gridTemplateColumns: '150px 80px 1fr 180px 120px 40px' }}
                  onClick={() => hasDetails && toggleExpanded(log.id)}
                >
                  <span className="text-xs text-muted-foreground">{formatDateTime(log.created_at)}</span>

                  <SeverityBadge severity={log.severity || 'info'} />

                  <div>
                    <span className="text-sm font-medium text-foreground">{getActionLabel(log.action)}</span>
                    <span className="text-xs ml-2 text-muted-foreground/50">{log.action}</span>
                  </div>

                  <div className="truncate">
                    <span className="text-xs text-muted-foreground">{log.actor_email || 'System'}</span>
                    {log.actor_role && (
                      <span className="block text-xs text-muted-foreground/50">{log.actor_role.replace(/_/g, ' ')}</span>
                    )}
                  </div>

                  <div>
                    <span className="text-xs text-muted-foreground">{log.entity_type}</span>
                    {log.entity_id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          navigateToEntity(log.entity_type, log.entity_id)
                        }}
                        className="block text-xs truncate max-w-[110px] hover:underline text-primary"
                        title={log.entity_id}
                      >
                        {log.entity_id.slice(0, 8)}...
                      </button>
                    )}
                  </div>

                  <div className="text-center">
                    {hasDetails && (
                      isExpanded
                        ? <ChevronUp size={14} className="text-muted-foreground" />
                        : <ChevronDown size={14} className="text-muted-foreground" />
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-6 py-3 bg-muted/40 border-b border-border/30">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {(log.old_value || log.new_value) && (
                        <div>
                          <p className="text-xs font-semibold mb-1 text-muted-foreground">Changes</p>
                          <InlineValueDiff oldValue={log.old_value} newValue={log.new_value} />
                        </div>
                      )}

                      {log.metadata && Object.keys(log.metadata).length > 0 && (
                        <div>
                          <p className="text-xs font-semibold mb-1 text-muted-foreground">Details</p>
                          <div className="text-xs space-y-0.5">
                            {Object.entries(log.metadata).map(([key, value]) => (
                              <div key={key}>
                                <span className="text-muted-foreground">{key.replace(/_/g, ' ')}: </span>
                                <span className="text-foreground/80">
                                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {(log.ip_address || log.user_agent) && (
                        <div>
                          <p className="text-xs font-semibold mb-1 text-muted-foreground">Request Info</p>
                          {log.ip_address && (
                            <p className="text-xs text-foreground/80">IP: {log.ip_address}</p>
                          )}
                          {log.user_agent && (
                            <p className="text-xs truncate text-muted-foreground/60" title={log.user_agent}>
                              UA: {log.user_agent}
                            </p>
                          )}
                        </div>
                      )}

                      <div>
                        <p className="text-xs font-semibold mb-1 text-muted-foreground">IDs</p>
                        <p className="text-xs font-mono text-muted-foreground/50">Event: {log.id}</p>
                        {log.entity_id && (
                          <p className="text-xs font-mono text-muted-foreground/50">Entity: {log.entity_id}</p>
                        )}
                        {log.user_id && (
                          <p className="text-xs font-mono text-muted-foreground/50">User: {log.user_id}</p>
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
            <p className="text-xs text-muted-foreground">
              Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()} events
            </p>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                variant="outline"
                size="sm"
                className="gap-1"
              >
                <ChevronLeft size={14} /> Prev
              </Button>
              <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
              <Button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                variant="outline"
                size="sm"
                className="gap-1"
              >
                Next <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
