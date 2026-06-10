'use client'

// Brokerage admin view of failed deals for their own agents. Mirrors the FF
// admin Remediation Deals panel but scoped to the caller's brokerage. The
// brokerage admin can review the failed-deal balance, see what cure path the
// agent has elected, and add remediation deals on the agent's behalf.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ChevronRight, AlertTriangle, FileSignature, Plus, RefreshCw, ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { BROKERAGE_PUBLIC_COLUMNS } from '@/lib/constants'
import BrokerageBrandLogo from '@/components/BrokerageBrandLogo'
import SignOutModal from '@/components/SignOutModal'
import { DealNumber } from '@/components/DealNumber'
import AddRemediationDealModal, { type AgentBrokerageDefaults } from '@/components/remediation/AddRemediationDealModal'
import {
  getFailedDealsForCaller,
  getRemediationDealsForFailedDeal,
  type FailedDealForCaller,
} from '@/lib/actions/remediation-actions'
import type { Brokerage, UserProfile } from '@/types/database'

type BrokeragePublic = Pick<Brokerage, 'id' | 'name' | 'logo_url' | 'logo_includes_tagline' | 'email' | 'profit_share_pct' | 'is_white_label_partner'>

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
  return 'Awaiting election'
}

function electionTone(c: string | null): string {
  if (c === 'cash_repayment') return 'bg-blue-950/40 text-blue-300 border-blue-800/50'
  if (c === 'commission_assignment') return 'bg-amber-950/40 text-amber-300 border-amber-800/50'
  return 'bg-red-950/40 text-red-300 border-red-800/50'
}

export default function BrokerageFailedDealsPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [brokerage, setBrokerage] = useState<BrokeragePublic | null>(null)
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
      if (!prof || prof.role !== 'brokerage_admin' || !prof.brokerage_id) {
        router.push('/login')
        return
      }
      setProfile(prof)
      const { data: brok } = await supabase
        .from('brokerages')
        .select(BROKERAGE_PUBLIC_COLUMNS)
        .eq('id', prof.brokerage_id)
        .single()
      if (!cancelled) setBrokerage(brok as BrokeragePublic | null)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      await load(false)
    }
    init()
    return () => { cancelled = true }
  }, [supabase, router, load])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const loadRemediationsFor = useCallback(async (dealId: string) => {
    const result = await getRemediationDealsForFailedDeal(dealId)
    if (result.success) {
      setRemediationsByDeal(prev => ({ ...prev, [dealId]: (result.data || []) as RemediationRow[] }))
    }
  }, [])

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

  const openAddModal = (dealId: string) => {
    setAddModalDealId(dealId)
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
      brokerageName: activeRow.agent.brokerage_name || brokerage?.name || '',
      brokerageAddress: activeRow.agent.brokerage_address || '',
      brokerOfRecordName: activeRow.agent.broker_of_record_name || '',
      brokerOfRecordEmail: activeRow.agent.broker_of_record_email || '',
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
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-3">
            <div className="flex items-center gap-3">
              <button onClick={() => router.push('/brokerage')} className="p-1.5 rounded-lg text-white/50 hover:text-primary" aria-label="Back to dashboard">
                <ArrowLeft size={16} />
              </button>
              <BrokerageBrandLogo logoUrl={brokerage?.logo_url} brokerageName={brokerage?.name} logoIncludesTagline={brokerage?.logo_includes_tagline} size="md" />
              <div className="w-px h-8 hidden sm:block bg-white/15" />
              <p className="text-xs sm:text-sm font-medium tracking-wide text-white hidden sm:block">
                Failed deals{brokerage ? `: ${brokerage.name}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs hidden sm:inline text-primary">{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <section aria-label="Intro" className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Failed deals at your brokerage</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Deals that were funded but did not close. The agent owes the funded amount plus interest at 24% per year, compounded daily.
              If the agent has chosen to repay by assigning a future commission, you can add the assignment here on their behalf and Firm Funds will send the IDP for signature.
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

        {error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center gap-2">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        {rows.length === 0 ? (
          <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-8 text-center">
            <p className="text-sm font-semibold text-emerald-200">No failed deals at your brokerage right now.</p>
            <p className="text-xs text-emerald-300/70 mt-1">All advances are on track to close.</p>
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
                          <p className="text-base font-semibold text-foreground">
                            {row.agent.first_name} {row.agent.last_name}
                          </p>
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
                        <div className="flex items-center gap-2 mt-1">
                          <p className="text-[12px] text-muted-foreground">{row.property_address}</p>
                          <DealNumber value={row.deal_number} />
                        </div>
                        <p className="text-[11px] text-muted-foreground/70 mt-1">
                          Failed {row.failed_to_close_at ? formatDate(row.failed_to_close_at) : 'unknown date'}
                          {row.agent.email && <span className="ml-2 text-muted-foreground/60">{row.agent.email}</span>}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Live balance</p>
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
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Remediation deals</h3>
                        <button
                          type="button"
                          onClick={() => openAddModal(row.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-600/90 transition"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Add remediation deal
                        </button>
                      </div>
                      {remediations.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic">
                          No remediation deals yet. Add one for an upcoming commission the agent will direct to clear this balance.
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

      {/* Shared modal — owns its form state and calls createRemediationDeal */}
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
