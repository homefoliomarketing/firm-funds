'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  RefreshCw,
  Send,
  X,
  Loader2,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getFirmDealReviewQueue,
  approveAndSendFirmDealOffer,
  rejectFirmDealOffer,
  resolveUnmatchedFirmDealEvent,
  type ReviewQueueRow,
  type ReviewQueueResult,
  type ResolveUnmatchedInput,
} from '@/lib/actions/firm-deal-review-actions'

type SideAction = 'leave' | 'assign' | 'outside'

interface UnmatchedDraft {
  listing_action: SideAction
  listing_agent_id: string
  listing_remember: boolean
  selling_action: SideAction
  selling_agent_id: string
  selling_remember: boolean
}

const defaultDraft: UnmatchedDraft = {
  listing_action: 'leave',
  listing_agent_id: '',
  listing_remember: false,
  selling_action: 'leave',
  selling_agent_id: '',
  selling_remember: false,
}

function formatHumanDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function agentDisplay(a: { first_name: string | null; last_name: string | null } | null): string {
  if (!a) return '—'
  return `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || '—'
}

function confidenceBadge(c: ReviewQueueRow['parser_confidence']) {
  if (!c) return null
  if (c === 'high') return <Badge className="bg-emerald-950/40 text-emerald-300 border-emerald-800/50">high confidence</Badge>
  if (c === 'medium') return <Badge className="bg-amber-950/40 text-amber-300 border-amber-800/50">medium confidence</Badge>
  return <Badge className="bg-red-950/40 text-red-300 border-red-800/50">low confidence</Badge>
}

function statusBadge(s: ReviewQueueRow['status']) {
  if (s === 'unmatched') return <Badge className="bg-amber-950/40 text-amber-300 border-amber-800/50">needs review</Badge>
  if (s === 'awaiting_approval') return <Badge className="bg-blue-950/40 text-blue-300 border-blue-800/50">ready to send</Badge>
  if (s === 'errored') return <Badge className="bg-red-950/40 text-red-300 border-red-800/50">error</Badge>
  if (s === 'offer_sent') return <Badge className="bg-emerald-950/40 text-emerald-300 border-emerald-800/50">sent</Badge>
  if (s === 'rejected') return <Badge className="bg-muted text-muted-foreground border-border/40">rejected</Badge>
  if (s === 'duplicate') return <Badge className="bg-muted text-muted-foreground border-border/40">duplicate</Badge>
  return null
}

export default function FirmDealReviewPage() {
  const router = useRouter()
  const supabase = createClient()
  const [authChecked, setAuthChecked] = useState(false)
  const [data, setData] = useState<ReviewQueueResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyEventId, setBusyEventId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, UnmatchedDraft>>({})

  useEffect(() => {
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()
      if (profile?.role !== 'super_admin' && profile?.role !== 'firm_funds_admin') {
        router.push('/login')
        return
      }
      setAuthChecked(true)
    }
    checkAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadQueue() {
    setRefreshing(true)
    setError(null)
    const res = await getFirmDealReviewQueue()
    if (!res.success) {
      setError(res.error ?? 'Failed to load queue')
      setRefreshing(false)
      setLoading(false)
      return
    }
    setData(res.data ?? null)
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => {
    if (!authChecked) return
    loadQueue()
  }, [authChecked])

  function updateDraft(eventId: string, patch: Partial<UnmatchedDraft>) {
    setDrafts(prev => ({
      ...prev,
      [eventId]: { ...(prev[eventId] ?? defaultDraft), ...patch },
    }))
  }

  async function handleSend(eventId: string) {
    setBusyEventId(eventId)
    const res = await approveAndSendFirmDealOffer(eventId)
    if (!res.success) {
      alert(`Send failed: ${res.error}`)
    }
    setBusyEventId(null)
    await loadQueue()
  }

  async function handleReject(eventId: string) {
    if (!confirm('Reject this firm-deal event? The agent will not be notified.')) return
    setBusyEventId(eventId)
    const res = await rejectFirmDealOffer(eventId)
    if (!res.success) {
      alert(`Reject failed: ${res.error}`)
    }
    setBusyEventId(null)
    await loadQueue()
  }

  async function handleResolve(row: ReviewQueueRow) {
    const draft = drafts[row.id] ?? defaultDraft
    const listingRaw = row.parsed?.listing_agent_raw ?? ''
    const sellingRaw = row.parsed?.selling_agent_raw ?? ''

    function toAction(side: 'listing' | 'selling'): ResolveUnmatchedInput['listing_action'] {
      const action = side === 'listing' ? draft.listing_action : draft.selling_action
      const agentId = side === 'listing' ? draft.listing_agent_id : draft.selling_agent_id
      const remember = side === 'listing' ? draft.listing_remember : draft.selling_remember
      const shorthand = side === 'listing' ? listingRaw : sellingRaw
      if (action === 'leave') return { kind: 'leave_as_parsed' }
      if (action === 'assign') {
        if (!agentId) return { kind: 'leave_as_parsed' }
        return {
          kind: 'assign_agent',
          agent_id: agentId,
          remember_shorthand: remember ? shorthand : undefined,
        }
      }
      return {
        kind: 'mark_outside',
        remember_shorthand: remember ? shorthand : undefined,
      }
    }

    setBusyEventId(row.id)
    const res = await resolveUnmatchedFirmDealEvent({
      event_id: row.id,
      listing_action: toAction('listing'),
      selling_action: toAction('selling'),
      ready_to_approve: true,
    })
    if (!res.success) {
      alert(`Resolve failed: ${res.error}`)
    }
    setBusyEventId(null)
    setDrafts(prev => {
      const next = { ...prev }
      delete next[row.id]
      return next
    })
    await loadQueue()
  }

  if (!authChecked || loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        <Skeleton className="h-10 w-64 mb-6" />
        <Skeleton className="h-40 w-full mb-3" />
        <Skeleton className="h-40 w-full mb-3" />
      </div>
    )
  }

  const pending = data?.pending ?? []
  const resolved = data?.recently_resolved ?? []
  const unmatchedCount = pending.filter(r => r.status === 'unmatched').length
  const awaitingCount = pending.filter(r => r.status === 'awaiting_approval').length
  const erroredCount = pending.filter(r => r.status === 'errored').length

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Inbox className="h-6 w-6 text-primary" />
            Firm Deal Review Queue
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Detected firm deals awaiting your review before notifying the agent.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={loadQueue}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Needs review</p>
            <p className="text-3xl font-bold mt-1">{unmatchedCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Ready to send</p>
            <p className="text-3xl font-bold mt-1">{awaitingCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Errors</p>
            <p className="text-3xl font-bold mt-1">{erroredCount}</p>
          </CardContent>
        </Card>
      </div>

      {error && (
        <Card className="mb-4 border-destructive">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </p>
          </CardContent>
        </Card>
      )}

      {pending.length === 0 && !error && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-3 text-emerald-500" />
            <p>Nothing to review.</p>
          </CardContent>
        </Card>
      )}

      {pending.map(row => (
        <EventCard
          key={row.id}
          row={row}
          busy={busyEventId === row.id}
          draft={drafts[row.id]}
          onUpdateDraft={(patch) => updateDraft(row.id, patch)}
          onSend={() => handleSend(row.id)}
          onReject={() => handleReject(row.id)}
          onResolve={() => handleResolve(row)}
        />
      ))}

      {resolved.length > 0 && (
        <>
          <h2 className="text-lg font-semibold mt-10 mb-3 text-muted-foreground">Recently resolved (last 7 days)</h2>
          {resolved.map(row => (
            <Card key={row.id} className="mb-2">
              <CardContent className="py-3 flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                  {statusBadge(row.status)}
                  <span className="font-medium">{row.parsed?.address ?? '—'}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">{formatHumanDate(row.processed_at)}</span>
                </div>
                <div className="text-muted-foreground">{row.brokerage_name}</div>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  )
}

interface EventCardProps {
  row: ReviewQueueRow
  busy: boolean
  draft: UnmatchedDraft | undefined
  onUpdateDraft: (patch: Partial<UnmatchedDraft>) => void
  onSend: () => void
  onReject: () => void
  onResolve: () => void
}

function EventCard({ row, busy, draft, onUpdateDraft, onSend, onReject, onResolve }: EventCardProps) {
  const d = draft ?? defaultDraft
  const parsed = row.parsed

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              {parsed?.address ?? '(no address parsed)'}
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground text-sm font-normal">{row.brokerage_name}</span>
            </CardTitle>
            <div className="flex flex-wrap gap-2 mt-2 text-xs text-muted-foreground">
              {parsed?.mls_number && <span>MLS {parsed.mls_number}</span>}
              {parsed?.closing_date_iso && <span>closes {formatHumanDate(parsed.closing_date_iso)}</span>}
              {row.source_tab && <span>tab: {row.source_tab}</span>}
              <span>received {formatHumanDate(row.received_at)}</span>
            </div>
          </div>
          <div className="flex flex-col gap-2 items-end">
            {statusBadge(row.status)}
            {confidenceBadge(row.parser_confidence)}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <SideSummary
            label="Listing agent"
            raw={parsed?.listing_agent_raw ?? null}
            matched={row.matched_agent}
            showResolver={row.status === 'unmatched'}
            draftAction={d.listing_action}
            draftAgentId={d.listing_agent_id}
            draftRemember={d.listing_remember}
            enrolledAgents={row.enrolled_agents}
            onActionChange={a => onUpdateDraft({ listing_action: a })}
            onAgentChange={id => onUpdateDraft({ listing_agent_id: id })}
            onRememberChange={r => onUpdateDraft({ listing_remember: r })}
          />
          <SideSummary
            label="Selling agent"
            raw={parsed?.selling_agent_raw ?? null}
            matched={row.second_matched_agent}
            showResolver={row.status === 'unmatched'}
            draftAction={d.selling_action}
            draftAgentId={d.selling_agent_id}
            draftRemember={d.selling_remember}
            enrolledAgents={row.enrolled_agents}
            onActionChange={a => onUpdateDraft({ selling_action: a })}
            onAgentChange={id => onUpdateDraft({ selling_agent_id: id })}
            onRememberChange={r => onUpdateDraft({ selling_remember: r })}
          />
        </div>

        {parsed?.parser_notes && (
          <p className="text-xs text-muted-foreground mb-3 italic">Parser note: {parsed.parser_notes}</p>
        )}
        {row.error_message && (
          <p className="text-xs text-destructive mb-3">Error: {row.error_message}</p>
        )}

        <div className="flex items-center gap-2 justify-end">
          {row.status === 'unmatched' && (
            <Button onClick={onResolve} disabled={busy} size="sm">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Save resolution
            </Button>
          )}
          {row.status === 'awaiting_approval' && (
            <Button onClick={onSend} disabled={busy} size="sm">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send offer
            </Button>
          )}
          {(row.status === 'unmatched' || row.status === 'awaiting_approval' || row.status === 'errored') && (
            <Button onClick={onReject} disabled={busy} size="sm" variant="outline">
              <X className="h-4 w-4" />
              Reject
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

interface SideSummaryProps {
  label: string
  raw: string | null
  matched: { id: string; first_name: string | null; last_name: string | null } | null
  showResolver: boolean
  draftAction: SideAction
  draftAgentId: string
  draftRemember: boolean
  enrolledAgents: { id: string; first_name: string | null; last_name: string | null }[]
  onActionChange: (a: SideAction) => void
  onAgentChange: (id: string) => void
  onRememberChange: (r: boolean) => void
}

function SideSummary({
  label,
  raw,
  matched,
  showResolver,
  draftAction,
  draftAgentId,
  draftRemember,
  enrolledAgents,
  onActionChange,
  onAgentChange,
  onRememberChange,
}: SideSummaryProps) {
  return (
    <div className="border rounded-lg p-3 bg-muted/30">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-sm font-medium mt-1">
        {raw ? <span>&quot;{raw}&quot;</span> : <span className="text-muted-foreground">(blank)</span>}
      </p>
      {matched ? (
        <p className="text-xs text-emerald-400 mt-1">→ {agentDisplay(matched)}</p>
      ) : raw ? (
        <p className="text-xs text-amber-400 mt-1">→ unresolved</p>
      ) : null}

      {showResolver && raw && (
        <div className="mt-3 space-y-2">
          <select
            value={draftAction}
            onChange={e => onActionChange(e.target.value as SideAction)}
            className="w-full text-xs bg-background border border-border rounded px-2 py-1"
          >
            <option value="leave">(no change for this side)</option>
            <option value="assign">Assign to enrolled agent…</option>
            <option value="outside">Mark as outside brokerage</option>
          </select>

          {draftAction === 'assign' && (
            <select
              value={draftAgentId}
              onChange={e => onAgentChange(e.target.value)}
              className="w-full text-xs bg-background border border-border rounded px-2 py-1"
            >
              <option value="">— pick agent —</option>
              {enrolledAgents.map(a => (
                <option key={a.id} value={a.id}>{agentDisplay(a)}</option>
              ))}
            </select>
          )}

          {(draftAction === 'assign' || draftAction === 'outside') && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={draftRemember}
                onChange={e => onRememberChange(e.target.checked)}
              />
              Remember &quot;{raw}&quot; for next time
            </label>
          )}
        </div>
      )}
    </div>
  )
}

function agentDisplayInline(a: { first_name: string | null; last_name: string | null } | null): string {
  if (!a) return '—'
  return `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || '—'
}

// keep agentDisplayInline reachable for now; same purpose as agentDisplay above
void agentDisplayInline
