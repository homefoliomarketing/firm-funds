'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpDown,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  DollarSign,
  Filter,
  Hourglass,
  Mail,
  RefreshCw,
  ScrollText,
  Sparkles,
} from 'lucide-react'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate } from '@/lib/formatting'
import {
  getPendingCureElections,
  type PendingCureElectionRow,
  type PendingCureElectionsResult,
  type RemediationSummary,
} from '@/lib/actions/cure-actions'

type ElectionFilter = 'all' | 'cash_repayment' | 'commission_assignment' | 'awaiting'

const REMEDIATION_STATUS_LABEL: Record<RemediationSummary['status'], string> = {
  pending: 'Draft — IDP not yet sent',
  idp_sent: 'IDP sent — awaiting signature',
  idp_signed: 'IDP signed — awaiting remittance',
  remitted: 'Remitted',
  cancelled: 'Cancelled',
}

const REMEDIATION_STATUS_STYLE: Record<RemediationSummary['status'], string> = {
  pending: 'bg-muted text-muted-foreground border-border/40',
  idp_sent: 'bg-amber-950/40 text-amber-300 border-amber-800/50',
  idp_signed: 'bg-blue-950/40 text-blue-300 border-blue-800/50',
  remitted: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50',
  cancelled: 'bg-muted text-muted-foreground/60 border-border/30',
}

function agentDisplayName(agent: PendingCureElectionRow['agent']): string {
  const name = `${agent.first_name || ''} ${agent.last_name || ''}`.trim()
  return name || agent.email || 'Unknown agent'
}

function daysBetween(fromIsoYmd: string, toIsoYmd: string): number {
  const fromMs = new Date(fromIsoYmd + 'T00:00:00').getTime()
  const toMs = new Date(toIsoYmd + 'T00:00:00').getTime()
  return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24))
}

function electionLabel(row: PendingCureElectionRow): string {
  if (row.cure_election === 'cash_repayment') return 'Cash repayment'
  if (row.cure_election === 'commission_assignment') return 'Commission assignment'
  return 'Awaiting election'
}

function electionTone(row: PendingCureElectionRow): string {
  if (row.cure_election === 'cash_repayment') return 'bg-blue-950/40 text-blue-300 border-blue-800/50'
  if (row.cure_election === 'commission_assignment') return 'bg-amber-950/40 text-amber-300 border-amber-800/50'
  return 'bg-red-950/40 text-red-300 border-red-800/50'
}

export default function PendingCureElectionsPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [authChecked, setAuthChecked] = useState(false)
  const [data, setData] = useState<PendingCureElectionsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [electionFilter, setElectionFilter] = useState<ElectionFilter>('all')
  const [brokerageFilter, setBrokerageFilter] = useState<string>('all')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [sortBy, setSortBy] = useState<'deadline' | 'balance' | 'failed_at'>('deadline')

  const loadData = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    const res = await getPendingCureElections()
    if (res.success) {
      setData(res.data as PendingCureElectionsResult)
    } else {
      setError(res.error || 'Failed to load pending cure elections')
    }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    async function check() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user.id).single()
      if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
        router.push('/login')
        return
      }
      setAuthChecked(true)
    }
    check()
  }, [router, supabase])

  useEffect(() => {
    if (!authChecked) return
    // loadData calls setState; standard fetch pattern. Effect re-runs only
    // when authChecked flips true.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData(false)
  }, [authChecked, loadData])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const brokerageOptions = useMemo(() => {
    if (!data) return [] as string[]
    const set = new Set<string>()
    for (const row of data.pending) {
      if (row.agent.brokerage_name) set.add(row.agent.brokerage_name)
    }
    return Array.from(set).sort()
  }, [data])

  const filteredPending = useMemo(() => {
    if (!data) return [] as PendingCureElectionRow[]
    const today = data.as_of
    let rows = data.pending

    if (electionFilter !== 'all') {
      rows = rows.filter(r => {
        if (electionFilter === 'awaiting') return r.cure_election == null
        return r.cure_election === electionFilter
      })
    }

    if (brokerageFilter !== 'all') {
      rows = rows.filter(r => (r.agent.brokerage_name || '') === brokerageFilter)
    }

    if (overdueOnly) {
      rows = rows.filter(r => {
        if (!r.cure_election_deadline) return false
        const dl = r.cure_election_deadline.slice(0, 10)
        return today > dl
      })
    }

    const sorted = [...rows]
    if (sortBy === 'deadline') {
      sorted.sort((a, b) => {
        const aD = a.cure_election_deadline || '9999-12-31'
        const bD = b.cure_election_deadline || '9999-12-31'
        return aD.localeCompare(bD)
      })
    } else if (sortBy === 'balance') {
      sorted.sort((a, b) => b.live_balance_owed - a.live_balance_owed)
    } else {
      sorted.sort((a, b) => (a.failed_to_close_at || '').localeCompare(b.failed_to_close_at || ''))
    }
    return sorted
  }, [data, electionFilter, brokerageFilter, overdueOnly, sortBy])

  if (!authChecked || loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" role="status" aria-label="Loading pending cure elections">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  const today = data?.as_of || new Date().toISOString().slice(0, 10)
  const totalPending = data?.pending.length ?? 0
  const totalOwedLive = (data?.pending || []).reduce((sum, r) => sum + r.live_balance_owed, 0)
  const overdueCount = (data?.pending || []).filter(r => {
    if (!r.cure_election_deadline) return false
    return today > r.cure_election_deadline.slice(0, 10)
  }).length
  const awaitingCount = (data?.pending || []).filter(r => r.cure_election == null).length

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/admin')}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
              >
                <ArrowLeft size={14} /> Back
              </button>
              <div className="w-px h-6 bg-border/30" />
              <div className="flex items-center gap-2">
                <ClipboardList size={16} className="text-primary" />
                <h1 className="text-sm font-semibold text-foreground">Pending Cure Elections</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => loadData(true)}
                disabled={refreshing}
                className="gap-1.5"
              >
                <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                Refresh
              </Button>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Intro */}
        <section aria-label="Page intro">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Failed-deal collections</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Every agent currently owing money on a failed deal. Balances grow daily at 24%&nbsp;p.a. compounded.
            Sorted by election deadline by default — most urgent first.
          </p>
        </section>

        {error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center gap-2">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        {/* KPI cards */}
        <section aria-label="Cure election summary" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Open failed deals', value: totalPending.toString(), icon: AlertTriangle, accent: 'text-status-red' },
            { label: 'Awaiting election', value: awaitingCount.toString(), icon: Hourglass, accent: 'text-status-amber' },
            { label: 'Past 15-day deadline', value: overdueCount.toString(), icon: Clock, accent: 'text-status-red' },
            { label: 'Live balance owing', value: formatCurrency(totalOwedLive), icon: DollarSign, accent: 'text-primary' },
          ].map(stat => (
            <div key={stat.label} className="rounded-xl border border-border/40 bg-card/60 p-4 sm:p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{stat.label}</span>
                <stat.icon size={15} className={`${stat.accent} opacity-60`} />
              </div>
              <p className="text-2xl font-bold tracking-tight tabular-nums text-foreground">{stat.value}</p>
            </div>
          ))}
        </section>

        {/* Filters */}
        <section aria-label="Filters" className="rounded-xl border border-border/40 bg-card/60 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Filter size={14} className="text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Filter & sort</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label htmlFor="election-filter" className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Election</label>
              <select
                id="election-filter"
                value={electionFilter}
                onChange={(e) => setElectionFilter(e.target.value as ElectionFilter)}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-input text-foreground focus:outline-none focus:border-primary"
              >
                <option value="all">All</option>
                <option value="cash_repayment">Cash repayment</option>
                <option value="commission_assignment">Commission assignment</option>
                <option value="awaiting">Awaiting election</option>
              </select>
            </div>

            <div>
              <label htmlFor="brokerage-filter" className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Brokerage</label>
              <select
                id="brokerage-filter"
                value={brokerageFilter}
                onChange={(e) => setBrokerageFilter(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-input text-foreground focus:outline-none focus:border-primary"
              >
                <option value="all">All brokerages</option>
                {brokerageOptions.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="sort-by" className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Sort by</label>
              <select
                id="sort-by"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-input text-foreground focus:outline-none focus:border-primary"
              >
                <option value="deadline">Deadline (most urgent first)</option>
                <option value="balance">Balance owing (largest first)</option>
                <option value="failed_at">Failed-at date (oldest first)</option>
              </select>
            </div>

            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-foreground select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={overdueOnly}
                  onChange={(e) => setOverdueOnly(e.target.checked)}
                  className="h-4 w-4 rounded border-border/60 bg-input text-primary focus:ring-primary"
                />
                Overdue only
              </label>
            </div>
          </div>
        </section>

        {/* Pending table */}
        <section aria-label="Pending cure elections list">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {filteredPending.length} agent{filteredPending.length === 1 ? '' : 's'} in cure status
            </h3>
            {filteredPending.length > 0 && (
              <span className="text-[11px] text-muted-foreground/70 flex items-center gap-1">
                <ArrowUpDown size={11} />
                As of {formatDate(today)}
              </span>
            )}
          </div>

          {filteredPending.length === 0 ? (
            <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-8 text-center">
              <CheckCircle2 className="mx-auto mb-2 text-emerald-400" size={28} />
              <p className="text-sm font-semibold text-emerald-200">
                {totalPending === 0
                  ? "No agents currently in cure status — everything's clean."
                  : 'No deals match the current filters.'}
              </p>
              {totalPending > 0 && (
                <p className="text-xs text-emerald-300/70 mt-1">
                  Adjust filters above to see {totalPending} open failed-deal record{totalPending === 1 ? '' : 's'}.
                </p>
              )}
            </div>
          ) : (
            <ul className="space-y-3">
              {filteredPending.map(row => (
                <PendingRow key={row.deal_id} row={row} today={today} onOpen={() => router.push(`/admin/deals/${row.deal_id}`)} />
              ))}
            </ul>
          )}
        </section>

        {/* Recently cured */}
        {data && data.recently_cured.length > 0 && (
          <section aria-label="Recently cured deals" className="pt-2">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={14} className="text-emerald-400" />
              <h3 className="text-sm font-semibold uppercase tracking-wider text-emerald-300/90">
                Recently cured (last 90 days)
              </h3>
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {data.recently_cured.map(r => (
                <li
                  key={r.deal_id}
                  className="rounded-xl border border-emerald-800/30 bg-emerald-950/15 p-4 hover:border-emerald-700/50 transition cursor-pointer"
                  onClick={() => router.push(`/admin/deals/${r.deal_id}`)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{r.property_address}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {r.agent.first_name} {r.agent.last_name}
                        {r.agent.email && <span className="ml-1 text-muted-foreground/60">· {r.agent.email}</span>}
                      </p>
                      <p className="text-[11px] text-emerald-300/80 mt-1">
                        Cured {formatDate(r.cured_at)}
                        <span className="text-muted-foreground/60"> · failed {formatDate(r.failed_to_close_at)}</span>
                      </p>
                    </div>
                    <ChevronRight size={14} className="text-emerald-400/70 mt-1" />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  )
}

function PendingRow({
  row,
  today,
  onOpen,
}: {
  row: PendingCureElectionRow
  today: string
  onOpen: () => void
}) {
  const deadlineYmd = row.cure_election_deadline ? row.cure_election_deadline.slice(0, 10) : null
  const daysToDeadline = deadlineYmd ? daysBetween(today, deadlineYmd) : null
  const overdue = daysToDeadline != null && daysToDeadline < 0
  const failedAtYmd = row.failed_to_close_at ? row.failed_to_close_at.slice(0, 10) : ''
  const daysSinceFailure = failedAtYmd ? daysBetween(failedAtYmd, today) : 0

  return (
    <li className="rounded-xl border border-border/40 bg-card/60 hover:border-primary/40 transition">
      <div className="p-4 sm:p-5">
        {/* Top line: agent + property + election badge + open button */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold text-foreground">{agentDisplayName(row.agent)}</p>
              <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border ${electionTone(row)}`}>
                {electionLabel(row)}
              </span>
              {overdue && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border bg-red-950/40 text-red-300 border-red-800/50">
                  <AlertTriangle size={10} />
                  Deadline passed
                </span>
              )}
              {row.in_grace_period && (
                <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border bg-blue-950/40 text-blue-300 border-blue-800/50">
                  In 30-day grace
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              <span className="text-foreground/80">{row.property_address}</span>
              {row.agent.brokerage_name && (
                <>
                  <span className="mx-1.5 text-muted-foreground/40">·</span>
                  {row.agent.brokerage_name}
                </>
              )}
              {row.agent.email && (
                <>
                  <span className="mx-1.5 text-muted-foreground/40">·</span>
                  <span className="inline-flex items-center gap-1">
                    <Mail size={10} />
                    {row.agent.email}
                  </span>
                </>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground/70 mt-1">
              Failed {formatDate(row.failed_to_close_at)}
              <span className="text-muted-foreground/40"> · {daysSinceFailure} day{daysSinceFailure === 1 ? '' : 's'} ago</span>
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={onOpen}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition"
            >
              Open deal
              <ChevronRight size={12} />
            </button>
          </div>
        </div>

        {/* Numbers row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
          <Metric label="Live balance" value={formatCurrency(row.live_balance_owed)} tone="primary" />
          <Metric label="Principal" value={formatCurrency(row.outstanding_principal)} />
          <Metric
            label="Interest (live)"
            value={formatCurrency(row.live_interest_total)}
            sublabel={row.unposted_interest > 0.005 ? `${formatCurrency(row.unposted_interest)} unposted` : 'Fully posted'}
            tone={row.unposted_interest > 0.005 ? 'amber' : 'muted'}
          />
          <Metric
            label="Election deadline"
            value={deadlineYmd ? formatDate(deadlineYmd) : '—'}
            sublabel={
              daysToDeadline == null
                ? row.cure_election ? 'Election made' : 'No deadline set'
                : daysToDeadline > 0
                  ? `${daysToDeadline} day${daysToDeadline === 1 ? '' : 's'} remaining`
                  : daysToDeadline === 0
                    ? 'Due today'
                    : `${Math.abs(daysToDeadline)} day${Math.abs(daysToDeadline) === 1 ? '' : 's'} overdue`
            }
            tone={overdue ? 'red' : daysToDeadline != null && daysToDeadline <= 3 ? 'amber' : 'muted'}
          />
        </div>

        {/* Remediation tail */}
        <div className="mt-4 pt-3 border-t border-border/30">
          {row.latest_remediation ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <ScrollText size={11} />
                Latest remediation:
              </span>
              <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border ${REMEDIATION_STATUS_STYLE[row.latest_remediation.status]}`}>
                {REMEDIATION_STATUS_LABEL[row.latest_remediation.status]}
              </span>
              <span className="text-foreground/80">{row.latest_remediation.property_address}</span>
              <span className="text-muted-foreground/70">·</span>
              <span className="text-muted-foreground/70">{row.latest_remediation.brokerage_legal_name}</span>
              <span className="text-muted-foreground/70">·</span>
              <span className="text-amber-300 font-semibold tabular-nums">{formatCurrency(row.latest_remediation.directed_amount)} directed</span>
              {row.latest_remediation.expected_payment_date && (
                <>
                  <span className="text-muted-foreground/70">·</span>
                  <span className="text-muted-foreground/70">
                    expected {formatDate(row.latest_remediation.expected_payment_date)}
                  </span>
                </>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground/70 italic">
              {row.cure_election === 'commission_assignment'
                ? 'No Remediation Deals yet. Open the deal to add one.'
                : row.cure_election === 'cash_repayment'
                  ? 'Awaiting cash repayment from agent.'
                  : 'Awaiting agent election.'}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

function Metric({
  label,
  value,
  sublabel,
  tone = 'muted',
}: {
  label: string
  value: string
  sublabel?: string
  tone?: 'primary' | 'amber' | 'red' | 'muted'
}) {
  const valueClass =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'amber'
        ? 'text-amber-300'
        : tone === 'red'
          ? 'text-red-300'
          : 'text-foreground'
  const subClass =
    tone === 'red'
      ? 'text-red-300/80'
      : tone === 'amber'
        ? 'text-amber-300/80'
        : 'text-muted-foreground/70'
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">{label}</p>
      <p className={`text-sm font-bold tabular-nums mt-0.5 ${valueClass}`}>{value}</p>
      {sublabel && <p className={`text-[10px] mt-0.5 ${subClass}`}>{sublabel}</p>}
    </div>
  )
}
