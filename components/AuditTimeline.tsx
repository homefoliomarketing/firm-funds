'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Clock, Shield, AlertTriangle, Info, ChevronDown, ChevronUp,
  ArrowRight, User, FileText, CheckCircle2, XCircle, DollarSign,
  Upload, Trash2, Eye, LogIn, LogOut, Edit2, Send, Undo2
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
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
// Severity Badge
// ============================================================================

function SeverityDot({ severity, colors }: { severity: string; colors: any }) {
  const dotColors: Record<string, string> = {
    critical: colors.errorText,
    warning: colors.warningText,
    info: colors.gold,
  }
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: dotColors[severity] || colors.textMuted,
        flexShrink: 0,
      }}
    />
  )
}

// ============================================================================
// Value Diff Display
// ============================================================================

function ValueDiff({
  oldValue,
  newValue,
  colors,
}: {
  oldValue: Record<string, any> | null
  newValue: Record<string, any> | null
  colors: any
}) {
  if (!oldValue && !newValue) return null

  // Combine all keys from both objects
  const allKeys = new Set([
    ...Object.keys(oldValue || {}),
    ...Object.keys(newValue || {}),
  ])

  if (allKeys.size === 0) return null

  return (
    <div
      style={{
        marginTop: 8,
        padding: '8px 12px',
        borderRadius: 6,
        backgroundColor: colors.inputBg,
        border: `1px solid ${colors.borderLight}`,
        fontSize: 12,
      }}
    >
      {Array.from(allKeys).map(key => {
        const oldVal = oldValue?.[key]
        const newVal = newValue?.[key]
        // Only show fields that changed
        if (String(oldVal ?? '') === String(newVal ?? '')) return null
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        return (
          <div key={key} style={{ marginBottom: 4, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            <span style={{ color: colors.textMuted, minWidth: 80 }}>{label}:</span>
            {oldVal !== undefined && oldVal !== null && (
              <span style={{ color: colors.errorText, textDecoration: 'line-through' }}>
                {String(oldVal)}
              </span>
            )}
            {oldVal !== undefined && newVal !== undefined && (
              <ArrowRight size={12} style={{ color: colors.textMuted }} />
            )}
            {newVal !== undefined && newVal !== null && (
              <span style={{ color: colors.successText, fontWeight: 500 }}>
                {String(newVal)}
              </span>
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

function MetadataSummary({ metadata, colors }: { metadata: Record<string, any>; colors: any }) {
  if (!metadata || Object.keys(metadata).length === 0) return null

  // Filter out internal fields that are already shown elsewhere
  const skipKeys = ['deal_id', 'agent_id', 'brokerage_id']
  const displayEntries = Object.entries(metadata).filter(([k]) => !skipKeys.includes(k))

  if (displayEntries.length === 0) return null

  return (
    <div style={{ marginTop: 4, fontSize: 12, color: colors.textMuted }}>
      {displayEntries.map(([key, value]) => (
        <span key={key} style={{ marginRight: 12 }}>
          {key.replace(/_/g, ' ')}: <span style={{ color: colors.textSecondary }}>
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
  const { colors } = useTheme()
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
      <div style={{ padding: 16, textAlign: 'center', color: colors.textMuted }}>
        Loading audit trail...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: colors.errorText, fontSize: 13 }}>
        Failed to load audit trail: {error}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: colors.textMuted, fontSize: 13 }}>
        No audit events recorded yet.
      </div>
    )
  }

  return (
    <div>
      {/* Timeline */}
      <div style={{ position: 'relative', paddingLeft: 24 }}>
        {/* Vertical line */}
        <div
          style={{
            position: 'absolute',
            left: 11,
            top: 0,
            bottom: 0,
            width: 2,
            backgroundColor: colors.border,
          }}
        />

        {visibleEvents.map((event) => {
          const IconComponent = getActionIcon(event.action)
          const isExpanded = expandedIds.has(event.id)
          const hasDetails = event.old_value || event.new_value ||
            (event.metadata && Object.keys(event.metadata).length > 0)

          return (
            <div
              key={event.id}
              style={{
                position: 'relative',
                paddingBottom: 16,
                paddingLeft: 20,
              }}
            >
              {/* Timeline dot */}
              <div
                style={{
                  position: 'absolute',
                  left: -18,
                  top: 2,
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  backgroundColor: colors.cardBg,
                  border: `2px solid ${
                    event.severity === 'critical' ? colors.errorText :
                    event.severity === 'warning' ? colors.warningText :
                    colors.gold
                  }`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 1,
                }}
              />

              {/* Event content */}
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  backgroundColor: colors.cardBg,
                  border: `1px solid ${colors.borderLight}`,
                  cursor: hasDetails ? 'pointer' : 'default',
                }}
                onClick={() => hasDetails && toggleExpanded(event.id)}
              >
                {/* Header row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <IconComponent size={14} style={{ color: colors.textSecondary, flexShrink: 0 }} />
                  <SeverityDot severity={event.severity || 'info'} colors={colors} />
                  <span style={{ fontSize: 13, fontWeight: 500, color: colors.textPrimary }}>
                    {getActionLabel(event.action)}
                  </span>
                  {hasDetails && (
                    isExpanded
                      ? <ChevronUp size={12} style={{ color: colors.textMuted, marginLeft: 'auto' }} />
                      : <ChevronDown size={12} style={{ color: colors.textMuted, marginLeft: 'auto' }} />
                  )}
                </div>

                {/* Subtext: who + when */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 12 }}>
                  <User size={11} style={{ color: colors.textMuted }} />
                  <span style={{ color: colors.textMuted }}>
                    {event.actor_email || 'System'}
                    {event.actor_role && (
                      <span style={{ color: colors.textFaint }}> ({event.actor_role.replace(/_/g, ' ')})</span>
                    )}
                  </span>
                  <Clock size={11} style={{ color: colors.textMuted, marginLeft: 'auto' }} />
                  <span style={{ color: colors.textMuted }}>
                    {formatDateTime(event.created_at)}
                  </span>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div style={{ marginTop: 8, borderTop: `1px solid ${colors.divider}`, paddingTop: 8 }}>
                    <ValueDiff oldValue={event.old_value} newValue={event.new_value} colors={colors} />
                    <MetadataSummary metadata={event.metadata} colors={colors} />
                    {event.ip_address && (
                      <div style={{ marginTop: 4, fontSize: 11, color: colors.textFaint }}>
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
          style={{
            display: 'block',
            margin: '8px auto',
            padding: '6px 16px',
            backgroundColor: 'transparent',
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            color: colors.gold,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {showAll ? `Show Less` : `Show All ${events.length} Events`}
        </button>
      )}
    </div>
  )
}
