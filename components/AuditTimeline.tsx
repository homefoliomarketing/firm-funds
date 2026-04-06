'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Clock, AlertTriangle, Info, ChevronDown, ChevronUp,
  ArrowRight, User, FileText, CheckCircle2, XCircle, DollarSign,
  Upload, Trash2, Eye, LogIn, LogOut, Edit2, Send, Undo2
} from 'lucide-react'
import { getActionLabel } from '@/lib/audit-labels'
import { getEntityAuditTimeline, type AuditLogRow } from '@/lib/actions/audit-actions'
import { formatDateTime } from '@/lib/formatting'

// ============================================================================
// Types
// ============================================================================

interface AuditTimelineProps {
  entityType: string
  entityId: string
  maxItems?: number
}

// ============================================================================
// Action → Icon mapping
// ============================================================================

function getActionIcon(action: string) {
  if (action.startsWith('auth.login')) return LogIn
  if (action === 'auth.logout') return LogOut
  if (action.includes('status_change')) return ArrowRight
  if (action.includes('upload')) return Upload
  if (action.includes('delete') || action.includes('remove')) return Trash2
  if (action.includes('view')) return Eye
  if (action.includes('verify') || action.includes('confirm')) return CheckCircle2
  if (action.includes('reject') || action.includes('revoke') || action.includes('cancel')) return XCircle
  if (action.includes('edit') || action.includes('update') || action.includes('closing_date')) return Edit2
  if (action.includes('eft') || action.includes('payment') || action.includes('fund')) return DollarSign
  if (action.includes('document') || action.includes('request')) return FileText
  if (action.includes('invite') || action.includes('welcome') || action.includes('create')) return Send
  if (action.includes('archive') || action.includes('withdrawn')) return Undo2
  if (action.includes('note')) return Edit2
  if (action.includes('checklist')) return CheckCircle2
  return Info
}

// ============================================================================
// Severity Dot
// ============================================================================

function SeverityDot({ severity }: { severity: string }) {
  const colorClass =
    severity === 'critical' ? 'bg-destructive' :
    severity === 'warning' ? 'bg-yellow-500' :
    'bg-primary'

  return (
    <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${colorClass}`} />
  )
}

// ============================================================================
// Value Diff Display
// ============================================================================

function ValueDiff({
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
    <div className="mt-2 p-2 rounded-md bg-muted/30 border border-border/30 text-xs">
      {Array.from(allKeys).map(key => {
        const oldVal = oldValue?.[key]
        const newVal = newValue?.[key]
        if (String(oldVal ?? '') === String(newVal ?? '')) return null
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        return (
          <div key={key} className="mb-1 flex flex-wrap gap-1 items-center">
            <span className="text-muted-foreground min-w-[80px]">{label}:</span>
            {oldVal !== undefined && oldVal !== null && (
              <span className="text-destructive line-through">{String(oldVal)}</span>
            )}
            {oldVal !== undefined && newVal !== undefined && (
              <ArrowRight size={12} className="text-muted-foreground" />
            )}
            {newVal !== undefined && newVal !== null && (
              <span className="text-primary font-medium">{String(newVal)}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ============================================================================
// Metadata Summary
// ============================================================================

function MetadataSummary({ metadata }: { metadata: Record<string, any> }) {
  if (!metadata || Object.keys(metadata).length === 0) return null

  const skipKeys = ['deal_id', 'agent_id', 'brokerage_id']
  const displayEntries = Object.entries(metadata).filter(([k]) => !skipKeys.includes(k))

  if (displayEntries.length === 0) return null

  return (
    <div className="mt-1 text-xs text-muted-foreground">
      {displayEntries.map(([key, value]) => (
        <span key={key} className="mr-3">
          {key.replace(/_/g, ' ')}: <span className="text-foreground/70">
            {typeof value === 'object' ? JSON.stringify(value) : String(value)}
          </span>
        </span>
      ))}
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export default function AuditTimeline({ entityType, entityId, maxItems = 50 }: AuditTimelineProps) {
  const [events, setEvents] = useState<AuditLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)

  const INITIAL_SHOW = 10

  const loadTimeline = useCallback(async () => {
    setLoading(true)
    const result = await getEntityAuditTimeline(entityType, entityId, maxItems)
    if (result.error) {
      setError(result.error)
    } else {
      setEvents(result.data)
    }
    setLoading(false)
  }, [entityType, entityId, maxItems])

  useEffect(() => {
    loadTimeline()
  }, [loadTimeline])

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const visibleEvents = showAll ? events : events.slice(0, INITIAL_SHOW)

  if (loading) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Loading audit trail...
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load audit trail: {error}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        No audit events recorded yet.
      </div>
    )
  }

  return (
    <div>
      {/* Timeline */}
      <div className="relative pl-6">
        {/* Vertical line */}
        <div className="absolute left-[11px] top-0 bottom-0 w-0.5 bg-border/50" />

        {visibleEvents.map((event) => {
          const IconComponent = getActionIcon(event.action)
          const isExpanded = expandedIds.has(event.id)
          const hasDetails = event.old_value || event.new_value ||
            (event.metadata && Object.keys(event.metadata).length > 0)

          const dotBorderColor =
            event.severity === 'critical' ? 'border-destructive' :
            event.severity === 'warning' ? 'border-yellow-500' :
            'border-primary'

          return (
            <div key={event.id} className="relative pb-4 pl-5">
              {/* Timeline dot */}
              <div className={`absolute left-[-18px] top-0.5 w-4 h-4 rounded-full bg-card border-2 ${dotBorderColor} flex items-center justify-center z-10`} />

              {/* Event content */}
              <div
                className={`p-2 px-3 rounded-lg bg-card border border-border/30 ${hasDetails ? 'cursor-pointer' : ''}`}
                onClick={() => hasDetails && toggleExpanded(event.id)}
              >
                {/* Header row */}
                <div className="flex items-center gap-2">
                  <IconComponent size={14} className="text-muted-foreground flex-shrink-0" />
                  <SeverityDot severity={event.severity || 'info'} />
                  <span className="text-[13px] font-medium text-foreground">
                    {getActionLabel(event.action)}
                  </span>
                  {hasDetails && (
                    isExpanded
                      ? <ChevronUp size={12} className="text-muted-foreground ml-auto" />
                      : <ChevronDown size={12} className="text-muted-foreground ml-auto" />
                  )}
                </div>

                {/* Subtext: who + when */}
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  <User size={11} />
                  <span>
                    {event.actor_email || 'System'}
                    {event.actor_role && (
                      <span className="text-muted-foreground/60"> ({event.actor_role.replace(/_/g, ' ')})</span>
                    )}
                  </span>
                  <Clock size={11} className="ml-auto" />
                  <span>{formatDateTime(event.created_at)}</span>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="mt-2 pt-2 border-t border-border/30">
                    <ValueDiff oldValue={event.old_value} newValue={event.new_value} />
                    <MetadataSummary metadata={event.metadata} />
                    {event.ip_address && (
                      <div className="mt-1 text-[11px] text-muted-foreground/60">
                        IP: {event.ip_address}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Show more/less toggle */}
      {events.length > INITIAL_SHOW && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="block mx-auto mt-2 px-4 py-1.5 rounded-md border border-border/50 text-xs text-primary bg-transparent hover:bg-primary/10 transition-colors"
        >
          {showAll ? 'Show Less' : `Show All ${events.length} Events`}
        </button>
      )}
    </div>
  )
}
