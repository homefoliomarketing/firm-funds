'use client'

// Agent's own view of their failed deals. Same shape as the brokerage admin
// page, scoped to deals where deal.agent_id matches the caller's agent_id.
// Lets the agent add remediation deals (commission assignments) on their own
// account to clear the failed-deal balance.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FileSignature, Plus, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { BROKERAGE_PUBLIC_COLUMNS } from '@/lib/constants'
import AgentHeader from '@/components/AgentHeader'
import AddRemediationDealModal, { type AgentBrokerageDefaults } from '@/components/remediation/AddRemediationDealModal'
import { StatusToast } from '@/components/StatusToast'
import { DealNumber } from '@/components/DealNumber'
import {
  getFailedDealsForCaller,
  getRemediationDealsForFailedDeal,
  type FailedDealForCaller,
} from '@/lib/actions/remediation-actions'
import type { UserProfile } from '@/types/database'

interface AgentForHeader {
  id: string
  brokerages?: { name: string | null; logo_url: string | null; logo_includes_tagline?: boolean | null; address?: string | null; broker_of_record_name?: string | null; broker_of_record_email?: string | null } | null
}

interface RemediationRow {
  id: string
  property_address: string
  brokerage_legal_name: string
  directed_amount: number
  status: 'pending' | 'idp_sent' | 'idp_signed' | 'remitted' | 'cancelled'
  expected_payment_date: string | null
  created_at: string
}

const STATUS_LABEL: Record<RemediationRow['status'], string> = {
  pending: 'Draft, IDP not yet sent',
  idp_sent: 'IDP sent, awaiting signature',
  idp_signed: 'IDP signed, awaiting payment',
  remitted: 'Paid',
  cancelled: 'Cancelled',
}

const STATUS_STYLE: Record<RemediationRow['status'], string> = {
  pending: 'bg-muted text-muted-foreground border-border/40',
  idp_sent: 'bg-amber-950/40 text-amber-300 border-amber-800/50',
  idp_signed: 'bg-blue-950/40 text-blue-300 border-blue-800/50',
  remitted: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50',
  cancelled: 'bg-muted text-muted-foreground/60 border-border/30',
}

function electionLabel(c: string | null): string {
  if (c === 'cash_repayment') return 'Cash repayment'
  if (c === 'commission_assignment') return 'Commission assignment'
  return 'Choose your repayment method'
}

function electionTone(c: string | null): string {
  if (c === 'cash_repayment') return 'bg-blue-950/40 text-blue-300 border-blue-800/50'
  if (c === 'commission_assignment') return 'bg-amber-950/40 text-amber-300 border-amber-800/50'
  return 'bg-red-950/40 text-red-300 border-red-800/50'
}

// useSearchParams() requires a Suspense boundary in Next.js 16 so static
// pre-render doesn't suspend the entire page tree.
export default function AgentFailedDealsPage() {
  return (
    <Suspense>
      <AgentFailedDealsPageInner />
    </Suspense>
  )
}

function AgentFailedDealsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const expandDealIdParam = searchParams.get('dealId')
  const supabase = useMemo(() => createClient(), [])

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [agent, setAgent] = useState<AgentForHeader | null>(null)
  const [rows, setRows] = useState<FailedDealForCaller[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedDealId, setExpandedDealId] = useState<string | null>(null)
  const [addModalDealId, setAddModalDealId] = useState<string | null>(null)
  const [remediationsByDeal, setRemediationsByDeal] = useState<Record<string, RemediationRow[]>>({})

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    const result = await getFailedDealsForCaller()
    if (result.success) {
      setRows((result.data || []) as FailedDealForCaller[])
    } else {
      setError(result.error || 'Failed to load failed deals')
    }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: prof } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
      if (cancelled) return
      if (!prof || prof.role !== 'agent' || !prof.agent_id) {
        router.push('/login')
        return
      }
      setProfile(prof)
      const { data: agentData } = await supabase
        .from('agents')
        .select(`id, brokerages(${BROKERAGE_PUBLIC_COLUMNS}, address, broker_of_record_name, broker_of_record_email)`)
        .eq('id', prof.agent_id)
        .single()
      if (!cancelled) setAgent(agentData as AgentForHeader | null)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      await load(false)
    }
    init()
    return () => { cancelled = true }
  }, [supabase, router, load])

  const loadRemediationsFor = useCallback(async (dealId: string) => {
    const result = await getRemediationDealsForFailedDeal(dealId)
    if (result.success) {
      setRemediationsByDeal(prev => ({ ...prev, [dealId]: (result.data || []) as RemediationRow[] }))
    }
  }, [])

  // When we arrive from the cure-election redirect (?dealId=<id>), pre-expand
  // that row and lazily load its remediation rows so the agent lands on the
  // "Add remediation deal" button. The effect runs once per (param, rows)
  // change because rows starts empty.
  useEffect(() => {
    if (!expandDealIdParam) return
    if (rows.length === 0) return
    const match = rows.find(r => r.id === expandDealIdParam)
    if (!match) return
    setExpandedDealId(expandDealIdParam)
    if (!remediationsByDeal[expandDealIdParam]) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fire-and-forget side effect, state lives inside loadRemediationsFor
      void loadRemediationsFor(expandDealIdParam)
    }
    // remediationsByDeal omitted on purpose: we only want to react to the
    // arrival of rows + the URL param, not every cache mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandDealIdParam, rows, loadRemediationsFor])

  const handleToggleExpand = async (dealId: string) => {
    if (expandedDealId === dealId) {
      setExpandedDealId(null)
      return
    }
    setExpandedDealId(dealId)
    if (!remediationsByDeal[dealId]) {
      await loadRemediationsFor(dealId)
    }
  }

  const handleAddCreated = async () => {
    if (addModalDealId) {
      await loadRemediationsFor(addModalDealId)
      await load(true)
    }
    setAddModalDealId(null)
  }

  const activeRow = addModalDealId ? rows.find(r => r.id === addModalDealId) || null : null
  const activeDefaults: AgentBrokerageDefaults | null = activeRow
    ? {
      brokerageId: activeRow.agent.brokerage_id,
      brokerageName: activeRow.agent.brokerage_name || agent?.brokerages?.name || '',
      brokerageAddress: activeRow.agent.brokerage_address || agent?.brokerages?.address || '',
      brokerOfRecordName: activeRow.agent.broker_of_record_name || agent?.brokerages?.broker_of_record_name || '',
      brokerOfRecordEmail: activeRow.agent.broker_of_record_email || agent?.brokerages?.broker_of_record_email || '',
    }
    : null

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" role="status">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        backHref="/agent/account"
        title="My failed deals"
        subtitle="Deals that did not close. Add a commission assignment to clear the balance."
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageLogoIncludesTagline={agent?.brokerages?.logo_includes_tagline}
        brokerageName={agent?.brokerages?.name}
      />

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <section aria-label="Intro" className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">Failed deals on your account</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Deals that were funded but did not close. You owe the funded amount plus interest at 24% per year, compounded daily.
              If you have chosen to repay by assigning a future commission, add the upcoming deal here. Firm Funds will send the assignment to your brokerage for signature.
            </p>
          </div>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </section>

        <StatusToast message={error ? { type: 'error', text: error } : null} onDismiss={() => setError(null)} />

        {rows.length === 0 ? (
          <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-8 text-center">
            <p className="text-sm font-semibold text-emerald-200">You have no failed deals.</p>
            <p className="text-xs text-emerald-300/70 mt-1">All your advances are on track.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map(row => {
              const expanded = expandedDealId === row.id
              const remediations = remediationsByDeal[row.id] || []
              return (
                <li key={row.id} className="rounded-xl border border-border/40 bg-card/60 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => handleToggleExpand(row.id)}
                    className="w-full text-left px-4 sm:px-5 py-4 hover:bg-muted/30 transition"
                    aria-expanded={expanded}
                    aria-controls={`failed-deal-${row.id}-detail`}
                  >
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-base font-semibold text-foreground">{row.property_address}</p>
                          <DealNumber value={row.deal_number} />
                          <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border ${electionTone(row.cure_election)}`}>
                            {electionLabel(row.cure_election)}
                          </span>
                          {row.remediation_active_count > 0 && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border bg-amber-950/40 text-amber-300 border-amber-800/50">
                              <FileSignature size={10} />
                              {row.remediation_active_count} remediation{row.remediation_active_count === 1 ? '' : 's'} in progress
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground/70 mt-1">
                          Failed {row.failed_to_close_at ? formatDate(row.failed_to_close_at) : 'unknown date'}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Live balance owing</p>
                        <p className="text-lg font-bold tabular-nums text-amber-300">{formatCurrency(row.live_balance_owed)}</p>
                        <p className="text-[10px] text-muted-foreground/60 mt-0.5">includes accrued interest</p>
                      </div>
                      <div className="flex items-center justify-end w-full sm:w-auto pt-1">
                        {expanded ? <ChevronDown size={16} className="text-muted-foreground" /> : <ChevronRight size={16} className="text-muted-foreground" />}
                      </div>
                    </div>
                  </button>
                  {expanded && (
                    <div id={`failed-deal-${row.id}-detail`} className="border-t border-border/30 bg-muted/10 px-4 sm:px-5 py-4">
                      {!row.cure_election && (
                        <div className="rounded-lg border border-status-red-border/40 bg-status-red-muted/20 p-3 mb-3 text-xs">
                          <p className="font-semibold text-status-red mb-1">Choose your repayment method first</p>
                          <p className="text-foreground/80">
                            Open the cure election page to pick cash repayment or commission assignment before adding a remediation deal.
                          </p>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); router.push(`/agent/account/cure-election/${row.id}`) }}
                            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-status-red text-white hover:bg-status-red/90 transition"
                          >
                            Go to election
                          </button>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your remediation deals</h3>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setAddModalDealId(row.id) }}
                          disabled={row.cure_election !== 'commission_assignment'}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-600/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
                          title={row.cure_election !== 'commission_assignment' ? 'Choose commission assignment as your repayment method first' : undefined}
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Add remediation deal
                        </button>
                      </div>
                      {remediations.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic">
                          No remediation deals yet. Add one for an upcoming commission you will direct to clear this balance.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {remediations.map(r => (
                            <li key={r.id} className="rounded-lg border border-border/40 bg-card/60 p-3">
                              <div className="flex items-start justify-between gap-3 flex-wrap">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-foreground truncate">{r.property_address}</p>
                                  <p className="text-[11px] text-muted-foreground mt-1">
                                    {r.brokerage_legal_name}
                                    {r.expected_payment_date && (
                                      <span className="ml-1 text-muted-foreground/70">
                                        · expected payment {formatDate(r.expected_payment_date)}
                                      </span>
                                    )}
                                  </p>
                                </div>
                                <div className="flex flex-col items-end gap-1">
                                  <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border ${STATUS_STYLE[r.status]}`}>
                                    {STATUS_LABEL[r.status]}
                                  </span>
                                  <p className="text-sm font-bold tabular-nums text-amber-300">{formatCurrency(Number(r.directed_amount))}</p>
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </main>

      <AddRemediationDealModal
        open={!!addModalDealId}
        onOpenChange={(v) => { if (!v) setAddModalDealId(null) }}
        failedDealId={addModalDealId || ''}
        liveBalanceOwed={activeRow?.live_balance_owed || 0}
        brokerageDefaults={activeDefaults}
        onCreated={handleAddCreated}
      />
    </div>
  )
}
