'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency } from '@/lib/formatting'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Inbox,
  RefreshCw,
  Send,
  X,
  Loader2,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getFirmDealReviewQueue,
  approveAndSendFirmDealOffer,
  rejectFirmDealOffer,
  resolveUnmatchedFirmDealEvent,
  rerunFirmDealMatch,
  type ReviewQueueRow,
  type ReviewQueueResult,
  type ResolveUnmatchedInput,
} from '@/lib/actions/firm-deal-review-actions'

type SideAction = 'leave' | 'assign' | 'assign_team' | 'outside'

interface UnmatchedDraft {
  listing_action: SideAction
  listing_agent_id: string
  // Second-agent slot used when listing_action === 'assign_team' (co-agent
  // split on the listing side). Ignored otherwise.
  listing_agent_id_2: string
  listing_remember: boolean
  selling_action: SideAction
  selling_agent_id: string
  selling_agent_id_2: string
  selling_remember: boolean
}

const defaultDraft: UnmatchedDraft = {
  listing_action: 'leave',
  listing_agent_id: '',
  listing_agent_id_2: '',
  listing_remember: false,
  selling_action: 'leave',
  selling_agent_id: '',
  selling_agent_id_2: '',
  selling_remember: false,
}

function formatShortDate(iso: string | null): string {
  if (!iso) return '-'
  try {
    // Bare YYYY-MM-DD values get parsed by Date as UTC midnight, which
    // displays as the previous day in negative-offset timezones (ET).
    // Construct via local-time fields to avoid the shift.
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    const d = dateMatch
      ? new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))
      : new Date(iso)
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function agentName(a: { first_name: string | null; last_name: string | null } | null): string {
  if (!a) return ''
  return `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim()
}

// One small inline pill describing status. Uses dot prefix instead of large
// badge for compactness across many rows.
function StatusDot({ status }: { status: ReviewQueueRow['status'] }) {
  const map: Record<ReviewQueueRow['status'], { color: string; label: string }> = {
    unmatched: { color: 'bg-amber-400', label: 'needs review' },
    awaiting_approval: { color: 'bg-blue-400', label: 'ready to send' },
    errored: { color: 'bg-red-400', label: 'error' },
    offer_sent: { color: 'bg-emerald-400', label: 'sent' },
    rejected: { color: 'bg-muted-foreground', label: 'rejected' },
    duplicate: { color: 'bg-muted-foreground', label: 'duplicate' },
  }
  const { color, label } = map[status]
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

// Side chip: "Listing: \"Exit\" → outside" with appropriate color coding.
// When `coAgent` is provided, renders both agents on this side as
// "Kyle Scali + Tricia Kent" with a small "(co-agents)" tag so the admin
// can see at a glance the side has a split.
function SideChip({
  label,
  raw,
  matched,
  coAgent,
  outsideMark,
}: {
  label: string
  raw: string | null | undefined
  matched: { first_name: string | null; last_name: string | null } | null
  /** Second co-agent on the SAME side as matched. Only set when
   *  co_agent_split is true and the second_matched_agent belongs to this
   *  side (caller decides which side gets it). */
  coAgent?: { first_name: string | null; last_name: string | null } | null
  // True when the side was matched to "outside brokerage" (no enrolled agent, but resolved).
  outsideMark: boolean
}) {
  const matchedName = agentName(matched)
  const coAgentName = agentName(coAgent ?? null)
  let resolutionEl: React.ReactNode
  if (matchedName) {
    resolutionEl = (
      <span className="text-emerald-400">
        {matchedName}
        {coAgentName && (
          <>
            {' + '}
            {coAgentName}
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider ml-1">
              (co-agents)
            </span>
          </>
        )}
      </span>
    )
  } else if (outsideMark) {
    resolutionEl = <span className="text-muted-foreground">outside</span>
  } else if (raw) {
    resolutionEl = <span className="text-amber-400">unresolved</span>
  } else {
    resolutionEl = <span className="text-muted-foreground">(blank)</span>
  }
  return (
    <span className="inline-flex items-baseline gap-1 text-sm">
      <span className="text-muted-foreground text-xs uppercase tracking-wider">{label}</span>
      {raw ? (
        <>
          <span className="font-medium">&ldquo;{raw}&rdquo;</span>
          <span className="text-muted-foreground" aria-hidden="true">→</span>
          {resolutionEl}
        </>
      ) : (
        resolutionEl
      )}
    </span>
  )
}

export default function FirmDealReviewPage() {
  // Suspense boundary is required when reading URL search params from a
  // client page in Next.js 16 (per node_modules/next/dist/docs/.../
  // dynamic-rendering.mdx). The inner component owns all state + URL reads.
  return (
    <Suspense>
      <FirmDealReviewPageInner />
    </Suspense>
  )
}

function FirmDealReviewPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  // Brokerage filter — persisted to URL so reloading + sharing a link keep
  // the same filter. 'all' (or null) means show everything; otherwise it's
  // a brokerage UUID matched against row.brokerage_id.
  const brokerageFilter = searchParams.get('brokerage') ?? 'all'
  const [authChecked, setAuthChecked] = useState(false)
  const [data, setData] = useState<ReviewQueueResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyEventId, setBusyEventId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, UnmatchedDraft>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

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

  function toggleExpanded(eventId: string) {
    setExpanded(prev => ({ ...prev, [eventId]: !prev[eventId] }))
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

  async function handleRerunMatch(eventId: string) {
    setBusyEventId(eventId)
    const res = await rerunFirmDealMatch(eventId)
    if (!res.success) {
      alert(`Re-run match failed: ${res.error}`)
    } else if (res.data) {
      // The outcome decides whether the row moved out of unmatched. If it
      // didn't (still unmatched), let the admin know nothing changed so
      // they don't think the button was a no-op silently.
      if (res.data.outcome === 'unmatched') {
        alert('Re-run match: still unmatched. Add the agent(s) to the brokerage or assign manually below.')
      }
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
      const agentId2 = side === 'listing' ? draft.listing_agent_id_2 : draft.selling_agent_id_2
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
      if (action === 'assign_team') {
        // Build a deduped list. Require at least two distinct agents to
        // qualify as a team; if the admin only picked one, treat it as a
        // single-agent assignment so we don't accidentally flip
        // co_agent_split on.
        const ids = [agentId, agentId2].filter(Boolean) as string[]
        const unique = Array.from(new Set(ids))
        if (unique.length === 0) return { kind: 'leave_as_parsed' }
        if (unique.length === 1) {
          return {
            kind: 'assign_agent',
            agent_id: unique[0],
            remember_shorthand: remember ? shorthand : undefined,
          }
        }
        return {
          kind: 'assign_team',
          agent_ids: unique,
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
    setExpanded(prev => {
      const next = { ...prev }
      delete next[row.id]
      return next
    })
    await loadQueue()
  }

  // Wrap in useMemo so identity is stable across renders when `data` hasn't
  // changed — keeps downstream useMemo deps from invalidating every render.
  const allPending = useMemo(() => data?.pending ?? [], [data])
  const allResolved = useMemo(() => data?.recently_resolved ?? [], [data])

  // Distinct brokerages across the combined queue — drives the selector
  // dropdown. Only show the selector when >1 brokerage is represented,
  // otherwise it's just noise.
  const brokerageOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of [...allPending, ...allResolved]) {
      if (!seen.has(r.brokerage_id)) seen.set(r.brokerage_id, r.brokerage_name)
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  }, [allPending, allResolved])

  // Client-side filter — the queue payload already has brokerage_id on
  // every row so a fetch round-trip is unnecessary.
  const pending = useMemo(
    () => (brokerageFilter === 'all' ? allPending : allPending.filter(r => r.brokerage_id === brokerageFilter)),
    [allPending, brokerageFilter]
  )
  const resolved = useMemo(
    () => (brokerageFilter === 'all' ? allResolved : allResolved.filter(r => r.brokerage_id === brokerageFilter)),
    [allResolved, brokerageFilter]
  )

  function setBrokerageFilter(next: string) {
    // Build a new URLSearchParams off the existing one so we don't clobber
    // any other params someone might add later.
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'all') params.delete('brokerage')
    else params.set('brokerage', next)
    const qs = params.toString()
    router.replace(qs ? `/admin/firm-deal-review?${qs}` : '/admin/firm-deal-review', { scroll: false })
  }

  const unmatchedCount = useMemo(() => pending.filter(r => r.status === 'unmatched').length, [pending])
  const awaitingCount = useMemo(() => pending.filter(r => r.status === 'awaiting_approval').length, [pending])
  const erroredCount = useMemo(() => pending.filter(r => r.status === 'errored').length, [pending])

  if (!authChecked || loading) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-5xl">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-16 w-full mb-2" />
        <Skeleton className="h-16 w-full mb-2" />
        <Skeleton className="h-16 w-full mb-2" />
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl">
      <div className="mb-3">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to admin
        </Link>
      </div>
      <header className="flex items-center justify-between mb-4 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Inbox className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />
          <h1 className="text-xl font-bold">Firm Deal Review</h1>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            · {pending.length} pending · {resolved.length} recently resolved
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Only show the selector when more than one brokerage is in the
              queue. Single-brokerage view stays clean. */}
          {brokerageOptions.length > 1 && (
            <>
              <label htmlFor="brokerage-filter" className="sr-only">
                Filter by brokerage
              </label>
              <select
                id="brokerage-filter"
                value={brokerageFilter}
                onChange={(e) => setBrokerageFilter(e.target.value)}
                className="text-xs bg-background border border-border rounded px-2 py-1 max-w-[200px]"
              >
                <option value="all">All brokerages ({brokerageOptions.length})</option>
                {brokerageOptions.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={loadQueue}
            disabled={refreshing}
            aria-label="Refresh queue"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-2 mb-4 text-center">
        <div className="rounded-md border bg-card px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Needs review</p>
          <p className="text-xl font-bold leading-tight">{unmatchedCount}</p>
        </div>
        <div className="rounded-md border bg-card px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Ready to send</p>
          <p className="text-xl font-bold leading-tight">{awaitingCount}</p>
        </div>
        <div className="rounded-md border bg-card px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Errors</p>
          <p className="text-xl font-bold leading-tight">{erroredCount}</p>
        </div>
      </div>

      {error && (
        <Card className="mb-3 border-destructive">
          <CardContent className="py-3">
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              {error}
            </p>
          </CardContent>
        </Card>
      )}

      {pending.length === 0 && !error && (
        <div className="rounded-lg border bg-card py-10 text-center text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-500" aria-hidden="true" />
          <p className="text-sm">
            {brokerageFilter !== 'all'
              ? 'Nothing to review for this brokerage.'
              : 'Nothing to review.'}
          </p>
        </div>
      )}

      <ul className="space-y-1.5">
        {pending.map(row => (
          <EventRow
            key={row.id}
            row={row}
            busy={busyEventId === row.id}
            draft={drafts[row.id]}
            expanded={!!expanded[row.id] || row.status === 'unmatched'}
            onToggleExpanded={() => toggleExpanded(row.id)}
            onUpdateDraft={(patch) => updateDraft(row.id, patch)}
            onSend={() => handleSend(row.id)}
            onReject={() => handleReject(row.id)}
            onResolve={() => handleResolve(row)}
            onRerunMatch={() => handleRerunMatch(row.id)}
          />
        ))}
      </ul>

      {resolved.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Recently resolved (last 7 days)
          </h2>
          <ul className="space-y-1">
            {resolved.map(row => (
              <li
                key={row.id}
                className="flex items-center gap-3 rounded-md border bg-card/40 px-3 py-2 text-sm"
              >
                <StatusDot status={row.status} />
                <span className="font-medium truncate">{row.parsed?.address ?? '-'}</span>
                <span className="text-muted-foreground text-xs truncate">{row.brokerage_name}</span>
                <span className="text-muted-foreground text-xs ml-auto whitespace-nowrap">
                  {formatShortDate(row.processed_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single event row — compact card with optional inline resolver panel.
// ---------------------------------------------------------------------------
interface EventRowProps {
  row: ReviewQueueRow
  busy: boolean
  draft: UnmatchedDraft | undefined
  expanded: boolean
  onToggleExpanded: () => void
  onUpdateDraft: (patch: Partial<UnmatchedDraft>) => void
  onSend: () => void
  onReject: () => void
  onResolve: () => void
  onRerunMatch: () => void
}

function EventRow({
  row,
  busy,
  draft,
  expanded,
  onToggleExpanded,
  onUpdateDraft,
  onSend,
  onReject,
  onResolve,
  onRerunMatch,
}: EventRowProps) {
  const d = draft ?? defaultDraft
  const parsed = row.parsed
  // A side is "outside" iff there's a raw value but no agent match AND
  // the event already left the unmatched bucket (i.e. the admin resolved
  // it to outside, or matchEvent recognised it via the mapping table).
  // For unmatched events we never show "outside" until resolution.
  const resolvedToOutside = row.status !== 'unmatched'
  const listingOutside =
    resolvedToOutside && !row.listing_matched_agent && !!parsed?.listing_agent_raw
  const sellingOutside =
    resolvedToOutside && !row.selling_matched_agent && !!parsed?.selling_agent_raw

  // When co_agent_split is true, both matched_agent and second_matched_agent
  // are on the SAME side. Figure out which side based on which side column
  // is populated — the admin-resolve and matcher-auto paths both put the
  // first co-agent in the side column once resolved. If neither side column
  // is set (matcher-auto pre-resolve case), fall back to the side whose raw
  // value is non-empty; the matcher only routes co-agent splits when one
  // side's cell contained the delimiter-separated names.
  const sideListing = row.co_agent_split &&
    (row.listing_matched_agent || (!row.selling_matched_agent && parsed?.listing_agent_raw))
  const sideSelling = row.co_agent_split && !sideListing
  const listingCoAgent = sideListing ? row.second_matched_agent : null
  const sellingCoAgent = sideSelling ? row.second_matched_agent : null

  return (
    <li className="rounded-lg border bg-card text-sm">
      {/* Main row — collapsed summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <StatusDot status={row.status} />
        <span className="font-semibold">{parsed?.address ?? '(no address)'}</span>
        {parsed?.mls_number && (
          <span className="text-xs text-muted-foreground">{parsed.mls_number}</span>
        )}
        <span className="text-xs text-muted-foreground truncate">{row.brokerage_name}</span>
        {parsed?.closing_date_iso && (
          <span className="text-xs text-muted-foreground hidden sm:inline">
            closes {formatShortDate(parsed.closing_date_iso)}
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-auto hidden md:inline">
          rec&apos;d {formatShortDate(row.received_at)}
        </span>
        <div className="flex items-center gap-1 ml-auto md:ml-0">
          {row.status === 'awaiting_approval' && (
            <Button
              onClick={onSend}
              disabled={busy}
              size="sm"
              className="h-7 px-2 text-xs"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Send
            </Button>
          )}
          {(row.status === 'unmatched' || row.status === 'errored') && (
            <Button
              onClick={onRerunMatch}
              disabled={busy}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              aria-label="Re-run match"
              title="Re-run the auto-matcher. Picks up newly added agents and the latest split-detection logic."
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Re-run
            </Button>
          )}
          {(row.status === 'unmatched' || row.status === 'awaiting_approval' || row.status === 'errored') && (
            <Button
              onClick={onReject}
              disabled={busy}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              aria-label="Reject"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
          {row.status === 'awaiting_approval' && (
            <Button
              onClick={onToggleExpanded}
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              aria-label={expanded ? 'Collapse details' : 'Expand details'}
              aria-expanded={expanded}
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </Button>
          )}
        </div>
      </div>

      {/* Side summary — always visible. Compact line under the title row. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-2">
        <SideChip
          label="Listing"
          raw={parsed?.listing_agent_raw}
          matched={
            row.listing_matched_agent ?? (sideListing ? row.matched_agent : null)
          }
          coAgent={listingCoAgent}
          outsideMark={listingOutside}
        />
        <SideChip
          label="Selling"
          raw={parsed?.selling_agent_raw}
          matched={
            row.selling_matched_agent ?? (sideSelling ? row.matched_agent : null)
          }
          coAgent={sellingCoAgent}
          outsideMark={sellingOutside}
        />
      </div>

      {/* Commission collected from the spreadsheet row, so the admin can verify
          what was pulled (and roughly what the offer would be) before anything
          is sent. Falls back to a clear "none" when the row carried no figures. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pb-2 text-xs text-muted-foreground">
        <span className="uppercase tracking-wider">Commission (from sheet)</span>
        {parsed?.listing_agent_commission_amount != null && (
          <span>
            Listing{' '}
            <span className="font-medium text-foreground tabular-nums">
              {formatCurrency(parsed.listing_agent_commission_amount)}
            </span>
          </span>
        )}
        {parsed?.selling_agent_commission_amount != null && (
          <span>
            Selling{' '}
            <span className="font-medium text-foreground tabular-nums">
              {formatCurrency(parsed.selling_agent_commission_amount)}
            </span>
          </span>
        )}
        {parsed?.sale_price != null && (
          <span>
            Sale price{' '}
            <span className="font-medium text-foreground tabular-nums">
              {formatCurrency(parsed.sale_price)}
            </span>
          </span>
        )}
        {parsed?.listing_agent_commission_amount == null &&
          parsed?.selling_agent_commission_amount == null &&
          parsed?.sale_price == null && (
            <span className="italic">none pulled from this row</span>
          )}
      </div>

      {/* Resolver panel — shown when row needs review, or when expanded */}
      {expanded && row.status === 'unmatched' && (
        <div className="border-t bg-muted/20 px-3 py-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <SideResolver
            label="Listing"
            raw={parsed?.listing_agent_raw ?? null}
            draftAction={d.listing_action}
            draftAgentId={d.listing_agent_id}
            draftAgentId2={d.listing_agent_id_2}
            draftRemember={d.listing_remember}
            enrolledAgents={row.enrolled_agents}
            onActionChange={(a) => onUpdateDraft({ listing_action: a })}
            onAgentChange={(id) => onUpdateDraft({ listing_agent_id: id })}
            onAgentChange2={(id) => onUpdateDraft({ listing_agent_id_2: id })}
            onRememberChange={(r) => onUpdateDraft({ listing_remember: r })}
          />
          <SideResolver
            label="Selling"
            raw={parsed?.selling_agent_raw ?? null}
            draftAction={d.selling_action}
            draftAgentId={d.selling_agent_id}
            draftAgentId2={d.selling_agent_id_2}
            draftRemember={d.selling_remember}
            enrolledAgents={row.enrolled_agents}
            onActionChange={(a) => onUpdateDraft({ selling_action: a })}
            onAgentChange={(id) => onUpdateDraft({ selling_agent_id: id })}
            onAgentChange2={(id) => onUpdateDraft({ selling_agent_id_2: id })}
            onRememberChange={(r) => onUpdateDraft({ selling_remember: r })}
          />
          <div className="md:col-span-2 flex justify-end">
            <Button onClick={onResolve} disabled={busy} size="sm" className="h-7 px-3 text-xs">
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Save resolution
            </Button>
          </div>
        </div>
      )}

      {/* Parser / error notes — only when present */}
      {(parsed?.parser_notes || row.error_message) && (
        <div className="border-t px-3 py-1.5 text-[11px]">
          {parsed?.parser_notes && (
            <p className="text-muted-foreground italic">Parser: {parsed.parser_notes}</p>
          )}
          {row.error_message && (
            <p className="text-destructive">Error: {row.error_message}</p>
          )}
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Inline side resolver — compact controls (action dropdown + agent picker +
// "remember" toggle on a single line where possible).
// ---------------------------------------------------------------------------
interface SideResolverProps {
  label: string
  raw: string | null
  draftAction: SideAction
  draftAgentId: string
  // Second-agent slot, only used when draftAction === 'assign_team'.
  draftAgentId2: string
  draftRemember: boolean
  enrolledAgents: { id: string; first_name: string | null; last_name: string | null }[]
  onActionChange: (a: SideAction) => void
  onAgentChange: (id: string) => void
  onAgentChange2: (id: string) => void
  onRememberChange: (r: boolean) => void
}

function SideResolver({
  label,
  raw,
  draftAction,
  draftAgentId,
  draftAgentId2,
  draftRemember,
  enrolledAgents,
  onActionChange,
  onAgentChange,
  onAgentChange2,
  onRememberChange,
}: SideResolverProps) {
  if (!raw) {
    return (
      <div className="text-xs text-muted-foreground">
        <span className="uppercase tracking-wider">{label}</span>: (blank, nothing to resolve)
      </div>
    )
  }
  // Show a warning if the admin picked the same agent in both team slots —
  // the server action will collapse this to a single-agent assignment, but
  // it's worth flagging so they realise the split won't take effect.
  const teamDuplicate =
    draftAction === 'assign_team' &&
    draftAgentId !== '' &&
    draftAgentId === draftAgentId2
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="font-medium">&ldquo;{raw}&rdquo;</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <select
          value={draftAction}
          onChange={(e) => onActionChange(e.target.value as SideAction)}
          className="text-xs bg-background border border-border rounded px-2 py-1 flex-1 min-w-[140px]"
          aria-label={`${label} resolution`}
        >
          <option value="leave">(no change)</option>
          <option value="assign">Assign to agent…</option>
          <option value="assign_team">Assign to two agents (co-agent split)</option>
          <option value="outside">Outside brokerage</option>
        </select>
        {draftAction === 'assign' && (
          <select
            value={draftAgentId}
            onChange={(e) => onAgentChange(e.target.value)}
            className="text-xs bg-background border border-border rounded px-2 py-1 flex-1 min-w-[140px]"
            aria-label={`${label} agent`}
          >
            <option value="">Pick agent</option>
            {enrolledAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {agentName(a) || a.id}
              </option>
            ))}
          </select>
        )}
        {draftAction === 'assign_team' && (
          <>
            <select
              value={draftAgentId}
              onChange={(e) => onAgentChange(e.target.value)}
              className="text-xs bg-background border border-border rounded px-2 py-1 flex-1 min-w-[140px]"
              aria-label={`${label} first agent`}
            >
              <option value="">First agent</option>
              {enrolledAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentName(a) || a.id}
                </option>
              ))}
            </select>
            <select
              value={draftAgentId2}
              onChange={(e) => onAgentChange2(e.target.value)}
              className="text-xs bg-background border border-border rounded px-2 py-1 flex-1 min-w-[140px]"
              aria-label={`${label} second agent`}
            >
              <option value="">Second agent</option>
              {enrolledAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentName(a) || a.id}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {teamDuplicate && (
        <p className="text-[11px] text-amber-400">
          Both slots are the same agent. Pick a different second agent for a co-agent split, or use &ldquo;Assign to agent&rdquo; instead.
        </p>
      )}
      {/* "Remember" only applies to single-agent / outside resolutions, where
          the shorthand is a stable identifier (a nickname like "Bud" for a
          single agent, or an outside-brokerage label like "Exit"). Co-agent
          splits are deliberately one-off: two agents happened to share this
          deal's commission, and we don't infer they'll keep doing so. The
          matcher's auto-split-detection handles any future delimited cell
          like "Kyle/Tricia" without a persisted mapping. */}
      {(draftAction === 'assign' || draftAction === 'outside') && (
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={draftRemember}
            onChange={(e) => onRememberChange(e.target.checked)}
            className="h-3 w-3"
          />
          Remember &ldquo;{raw}&rdquo; next time
        </label>
      )}
      {draftAction === 'assign_team' && (
        <p className="text-[11px] text-muted-foreground">
          One-off split for this deal only. Future cells with two enrolled agents
          auto-detect; no mapping is saved.
        </p>
      )}
    </div>
  )
}
