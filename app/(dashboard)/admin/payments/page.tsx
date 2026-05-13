'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, DollarSign, Building2, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, Clock, Search, FileText, XCircle,
} from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { confirmBrokeragePaymentClaim, rejectBrokeragePaymentClaim } from '@/lib/actions/admin-actions'

interface PaymentEntry {
  amount: number
  date: string
  reference?: string
  method?: string
  notes?: string
  status?: 'pending' | 'confirmed' | 'rejected'
  submitted_by_role?: string
  submitted_at?: string
  rejection_reason?: string
}

interface Deal {
  id: string
  property_address: string
  status: string
  advance_amount: number
  amount_due_from_brokerage: number
  brokerage_referral_fee: number
  brokerage_payments: PaymentEntry[] | null
  funding_date: string | null
  closing_date: string
  agent: any
}

// Backward-compat: legacy entries (no status field) are treated as confirmed.
const isCounted = (p: PaymentEntry) => p.status === 'confirmed' || p.status === undefined
const isPending = (p: PaymentEntry) => p.status === 'pending'

interface Brokerage {
  id: string
  name: string
}

interface BrokeragePaymentSummary {
  brokerage: Brokerage
  deals: Deal[]
  totalOwed: number
  totalPaid: number
  outstanding: number
  fullyPaidDeals: number
  partiallyPaidDeals: number
  unpaidDeals: number
}

export default function AdminPaymentsPage() {
  const [summaries, setSummaries] = useState<BrokeragePaymentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedBrokerage, setExpandedBrokerage] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'outstanding' | 'fully_paid'>('all')
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    loadPaymentData()
  }, [])

  async function loadPaymentData() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user.id).single()
    if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
      router.push('/login'); return
    }

    const { data: deals } = await supabase
      .from('deals')
      .select('id, property_address, status, advance_amount, amount_due_from_brokerage, brokerage_referral_fee, brokerage_payments, funding_date, closing_date, brokerage_id, agent:agents(first_name, last_name)')
      .in('status', ['funded', 'completed'])
      .order('funding_date', { ascending: false })

    const { data: brokerages } = await supabase
      .from('brokerages')
      .select('id, name')
      .order('name')

    if (!deals || !brokerages) {
      setLoading(false)
      return
    }

    const brokerageMap = new Map<string, BrokeragePaymentSummary>()
    for (const brokerage of brokerages) {
      brokerageMap.set(brokerage.id, {
        brokerage,
        deals: [],
        totalOwed: 0,
        totalPaid: 0,
        outstanding: 0,
        fullyPaidDeals: 0,
        partiallyPaidDeals: 0,
        unpaidDeals: 0,
      })
    }

    for (const deal of deals) {
      const summary = brokerageMap.get(deal.brokerage_id)
      if (!summary) continue

      const owed = deal.amount_due_from_brokerage || 0
      const payments = (deal.brokerage_payments || []) as PaymentEntry[]
      const paid = payments.filter(isCounted).reduce((sum: number, p: PaymentEntry) => sum + (p.amount || 0), 0)

      const agentData = Array.isArray(deal.agent) ? deal.agent[0] || null : deal.agent
      summary.deals.push({ ...deal, agent: agentData } as unknown as Deal)
      summary.totalOwed += owed
      summary.totalPaid += paid

      if (owed <= 0) {
        // no amount due
      } else if (Math.abs(paid - owed) < 0.01) {
        summary.fullyPaidDeals++
      } else if (paid > 0) {
        summary.partiallyPaidDeals++
      } else {
        summary.unpaidDeals++
      }
    }

    for (const summary of brokerageMap.values()) {
      summary.outstanding = summary.totalOwed - summary.totalPaid
    }

    const results = Array.from(brokerageMap.values()).filter(s => s.deals.length > 0)
    results.sort((a, b) => b.outstanding - a.outstanding)

    setSummaries(results)
    setLoading(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const filteredSummaries = useMemo(() => {
    let result = summaries

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(s =>
        s.brokerage.name.toLowerCase().includes(q) ||
        s.deals.some(d => d.property_address.toLowerCase().includes(q))
      )
    }

    if (filterStatus === 'outstanding') {
      result = result.filter(s => s.outstanding > 0.01)
    } else if (filterStatus === 'fully_paid') {
      result = result.filter(s => s.outstanding < 0.01 && s.totalOwed > 0)
    }

    return result
  }, [summaries, searchQuery, filterStatus])

  const totals = useMemo(() => {
    return summaries.reduce((acc, s) => ({
      totalOwed: acc.totalOwed + s.totalOwed,
      totalPaid: acc.totalPaid + s.totalPaid,
      outstanding: acc.outstanding + s.outstanding,
    }), { totalOwed: 0, totalPaid: 0, outstanding: 0 })
  }, [summaries])

  const getDealPaymentStatus = (deal: Deal) => {
    const owed = deal.amount_due_from_brokerage || 0
    const payments = (deal.brokerage_payments || []) as PaymentEntry[]
    const paid = payments.filter(isCounted).reduce((sum, p) => sum + (p.amount || 0), 0)
    if (owed <= 0) return 'none'
    if (Math.abs(paid - owed) < 0.01) return 'paid'
    if (paid > 0) return 'partial'
    return 'unpaid'
  }

  // Pending claim review state
  const [reviewBusy, setReviewBusy] = useState<string | null>(null) // key: `${dealId}:${idx}`
  const [reviewMsg, setReviewMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [rejectingKey, setRejectingKey] = useState<string | null>(null)
  const [rejectionReason, setRejectionReason] = useState('')

  // Optimistic update of a single payment entry in local state.
  const updateLocalPaymentEntry = (dealId: string, idx: number, patch: Partial<PaymentEntry>) => {
    setSummaries(prev => prev.map(s => ({
      ...s,
      deals: s.deals.map(d => {
        if (d.id !== dealId) return d
        const updated = [...(d.brokerage_payments || [])] as PaymentEntry[]
        updated[idx] = { ...updated[idx], ...patch }
        // Recompute summary totals for this deal
        const counted = updated.filter(isCounted).reduce((sum, p) => sum + (p.amount || 0), 0)
        return { ...d, brokerage_payments: updated, repayment_amount: counted } as Deal
      }),
    })))
  }

  const handleConfirmClaim = async (dealId: string, idx: number) => {
    const key = `${dealId}:${idx}`
    setReviewBusy(key)
    setReviewMsg(null)
    const r = await confirmBrokeragePaymentClaim({ dealId, paymentIndex: idx })
    setReviewBusy(null)
    if (r.success) {
      updateLocalPaymentEntry(dealId, idx, { status: 'confirmed' })
      setReviewMsg({ type: 'success', text: 'Payment claim confirmed.' })
      // Recompute brokerage summary totals
      await loadPaymentData()
    } else {
      setReviewMsg({ type: 'error', text: r.error || 'Failed to confirm claim' })
    }
  }

  const handleRejectClaim = async (dealId: string, idx: number) => {
    const reason = rejectionReason.trim()
    if (!reason) {
      setReviewMsg({ type: 'error', text: 'Please provide a reason for rejection.' })
      return
    }
    const key = `${dealId}:${idx}`
    setReviewBusy(key)
    setReviewMsg(null)
    const r = await rejectBrokeragePaymentClaim({ dealId, paymentIndex: idx, reason })
    setReviewBusy(null)
    if (r.success) {
      updateLocalPaymentEntry(dealId, idx, { status: 'rejected', rejection_reason: reason })
      setReviewMsg({ type: 'success', text: 'Payment claim rejected.' })
      setRejectingKey(null)
      setRejectionReason('')
      await loadPaymentData()
    } else {
      setReviewMsg({ type: 'error', text: r.error || 'Failed to reject claim' })
    }
  }

  // Collect all pending claims across all summaries for the top banner.
  const pendingClaims = useMemo(() => {
    const out: Array<{ summary: BrokeragePaymentSummary; deal: Deal; entry: PaymentEntry; idx: number }> = []
    for (const summary of summaries) {
      for (const deal of summary.deals) {
        const payments = (deal.brokerage_payments || []) as PaymentEntry[]
        payments.forEach((entry, idx) => {
          if (isPending(entry)) out.push({ summary, deal, entry, idx })
        })
      }
    }
    out.sort((a, b) => {
      const ad = a.entry.submitted_at || a.entry.date
      const bd = b.entry.submitted_at || b.entry.date
      return ad < bd ? 1 : ad > bd ? -1 : 0
    })
    return out
  }, [summaries])

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-5 w-48 bg-white/10" />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
            {[1, 2, 3].map(i => (
              <Card key={i}>
                <CardContent className="p-6">
                  <Skeleton className="h-3 w-20 mb-3" />
                  <Skeleton className="h-8 w-32" />
                </CardContent>
              </Card>
            ))}
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-8 sm:h-10 w-auto" />
              <div className="w-px h-6 bg-border/30" />
              <button
                onClick={() => router.push('/admin')}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
              >
                <ArrowLeft size={14} /> Back
              </button>
              <div className="w-px h-6 bg-border/30" />
              <div>
                <h1 className="text-sm font-semibold tracking-wide text-foreground">Brokerage Payments</h1>
                <p className="text-xs text-muted-foreground">Track payments from partner brokerages</p>
              </div>
            </div>
            <SignOutModal onConfirm={handleLogout} />
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="sr-only">Payments</h1>

        {/* Review flash message */}
        {reviewMsg && (
          <div
            role="status"
            className={`mb-4 rounded-lg px-4 py-3 text-sm border ${
              reviewMsg.type === 'success'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-destructive/10 border-destructive/30 text-destructive'
            }`}
          >
            {reviewMsg.text}
          </div>
        )}

        {/* Pending claims banner (brokerage-submitted, awaiting confirmation) */}
        {pendingClaims.length > 0 && (
          <section aria-label="Pending payment claims" className="mb-6">
            <Card className="border-amber-500/40 bg-amber-500/[0.04]">
              <CardContent className="p-5">
                <div className="flex items-start gap-3">
                  <Clock size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-bold text-foreground mb-1">
                      {pendingClaims.length} payment claim{pendingClaims.length === 1 ? '' : 's'} awaiting your confirmation
                    </h2>
                    <p className="text-xs text-muted-foreground mb-3">
                      Brokerages have logged payments they sent. Match each to a bank deposit, then confirm or reject.
                    </p>
                    <ul className="space-y-2">
                      {pendingClaims.map(({ summary, deal, entry, idx }) => {
                        const key = `${deal.id}:${idx}`
                        const isRejectingThis = rejectingKey === key
                        const isBusyThis = reviewBusy === key
                        return (
                          <li key={key} className="rounded-lg border border-amber-500/20 bg-card/60 px-3 py-3 text-xs">
                            <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold text-foreground truncate">
                                  {summary.brokerage.name}
                                </p>
                                <p className="text-muted-foreground truncate mt-0.5">
                                  {deal.property_address}
                                </p>
                                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                                  <span><strong className="text-foreground tabular-nums">{formatCurrency(entry.amount)}</strong></span>
                                  <span>· sent {formatDate(entry.date)}</span>
                                  {entry.method && <span>· {entry.method.toUpperCase()}</span>}
                                  {entry.reference && <span>· Ref: {entry.reference}</span>}
                                </div>
                                {entry.notes && (
                                  <p className="mt-1.5 text-muted-foreground italic">&ldquo;{entry.notes}&rdquo;</p>
                                )}
                              </div>
                              {!isRejectingThis && (
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <Button
                                    size="sm"
                                    onClick={() => handleConfirmClaim(deal.id, idx)}
                                    disabled={isBusyThis}
                                    className="h-7 text-xs"
                                  >
                                    <CheckCircle2 size={12} className="mr-1" />
                                    {isBusyThis ? '...' : 'Confirm'}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => { setRejectingKey(key); setRejectionReason('') }}
                                    disabled={isBusyThis}
                                    className="h-7 text-xs text-destructive border-destructive/40 hover:bg-destructive/10"
                                  >
                                    <XCircle size={12} className="mr-1" /> Reject
                                  </Button>
                                </div>
                              )}
                            </div>
                            {isRejectingThis && (
                              <div className="mt-2 rounded-lg bg-background/60 border border-border p-3 space-y-2">
                                <Input
                                  type="text"
                                  placeholder="Reason for rejection (visible to brokerage)"
                                  value={rejectionReason}
                                  onChange={(e) => setRejectionReason(e.target.value)}
                                  maxLength={500}
                                  autoFocus
                                />
                                <div className="flex gap-1.5 justify-end">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => { setRejectingKey(null); setRejectionReason('') }}
                                    disabled={isBusyThis}
                                    className="h-7 text-xs"
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    size="sm"
                                    onClick={() => handleRejectClaim(deal.id, idx)}
                                    disabled={isBusyThis || !rejectionReason.trim()}
                                    className="h-7 text-xs"
                                  >
                                    {isBusyThis ? '...' : 'Reject claim'}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {/* KPI Cards */}
        <section aria-label="Payment summary" className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Owed</p>
                  <p className="text-3xl font-black mt-2 tabular-nums text-foreground">{formatCurrency(totals.totalOwed)}</p>
                </div>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-blue-500/10">
                  <DollarSign size={22} className="text-blue-400" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Collected</p>
                  <p className="text-3xl font-black mt-2 tabular-nums text-green-400">{formatCurrency(totals.totalPaid)}</p>
                </div>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-green-500/10">
                  <CheckCircle2 size={22} className="text-green-400" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outstanding</p>
                  <p className={`text-3xl font-black mt-2 tabular-nums ${totals.outstanding > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                    {formatCurrency(totals.outstanding)}
                  </p>
                </div>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${totals.outstanding > 0 ? 'bg-yellow-500/10' : 'bg-green-500/10'}`}>
                  {totals.outstanding > 0
                    ? <AlertTriangle size={22} className="text-yellow-400" />
                    : <CheckCircle2 size={22} className="text-green-400" />
                  }
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search size={16} className="text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              type="text"
              placeholder="Search brokerages or properties..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex gap-2">
            {(['all', 'outstanding', 'fully_paid'] as const).map(status => (
              <Button
                key={status}
                onClick={() => setFilterStatus(status)}
                variant={filterStatus === status ? 'default' : 'outline'}
                size="sm"
                className="whitespace-nowrap"
              >
                {status === 'all' ? 'All' : status === 'outstanding' ? 'Outstanding' : 'Fully Paid'}
              </Button>
            ))}
          </div>
        </div>

        {/* Brokerage Cards */}
        {filteredSummaries.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Building2 size={40} className="mx-auto mb-4 text-muted-foreground/30" />
              <p className="font-semibold text-muted-foreground">
                {summaries.length === 0 ? 'No funded deals yet' : 'No matching brokerages'}
              </p>
              <p className="text-sm mt-1 text-muted-foreground/70">
                {summaries.length === 0 ? 'Brokerage payment tracking will appear here once deals are funded.' : 'Try adjusting your search or filter.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredSummaries.map(summary => {
              const isExpanded = expandedBrokerage === summary.brokerage.id
              const paidPct = summary.totalOwed > 0 ? Math.min((summary.totalPaid / summary.totalOwed) * 100, 100) : 0
              const isFullyPaid = summary.outstanding < 0.01 && summary.totalOwed > 0

              return (
                <Card key={summary.brokerage.id} className="overflow-hidden shadow-lg shadow-black/20">
                  {/* Summary Row */}
                  <div
                    className="px-6 py-5 cursor-pointer hover:bg-muted/20 transition-colors"
                    style={{ borderBottom: isExpanded ? undefined : 'none' }}
                    onClick={() => setExpandedBrokerage(isExpanded ? null : summary.brokerage.id)}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-primary/10">
                          <Building2 size={18} className="text-primary" />
                        </div>
                        <div>
                          <h3 className="font-bold text-foreground">{summary.brokerage.name}</h3>
                          <p className="text-xs text-muted-foreground">
                            {summary.deals.length} deal{summary.deals.length !== 1 ? 's' : ''} &middot;
                            {summary.fullyPaidDeals > 0 && ` ${summary.fullyPaidDeals} paid`}
                            {summary.partiallyPaidDeals > 0 && ` ${summary.partiallyPaidDeals} partial`}
                            {summary.unpaidDeals > 0 && ` ${summary.unpaidDeals} unpaid`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-right">
                          <p className="text-xs font-semibold uppercase text-muted-foreground">Outstanding</p>
                          <p className={`text-lg font-black ${isFullyPaid ? 'text-green-400' : 'text-yellow-400'}`}>
                            {isFullyPaid ? 'Paid' : formatCurrency(summary.outstanding)}
                          </p>
                        </div>
                        {isExpanded ? <ChevronUp size={18} className="text-muted-foreground/40" /> : <ChevronDown size={18} className="text-muted-foreground/40" />}
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2 rounded-full overflow-hidden bg-muted">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${paidPct}%`,
                            background: isFullyPaid ? 'var(--success)' : paidPct > 0 ? 'var(--warning)' : 'var(--muted-foreground)',
                          }}
                        />
                      </div>
                      <span className="text-xs font-semibold w-16 text-right text-muted-foreground">
                        {paidPct.toFixed(0)}% paid
                      </span>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="px-6 pb-5 border-t border-border/40">
                      {/* Totals */}
                      <div className="grid grid-cols-3 gap-4 py-4 mb-4 border-b border-border/30">
                        <div>
                          <p className="text-xs font-semibold uppercase text-muted-foreground">Total Owed</p>
                          <p className="text-lg font-bold text-foreground">{formatCurrency(summary.totalOwed)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-muted-foreground">Total Paid</p>
                          <p className="text-lg font-bold text-green-400">{formatCurrency(summary.totalPaid)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-muted-foreground">Remaining</p>
                          <p className={`text-lg font-bold ${summary.outstanding > 0.01 ? 'text-yellow-400' : 'text-green-400'}`}>
                            {formatCurrency(Math.max(summary.outstanding, 0))}
                          </p>
                        </div>
                      </div>

                      {/* Deal List */}
                      <div className="space-y-3">
                        {summary.deals.map(deal => {
                          const paymentStatus = getDealPaymentStatus(deal)
                          const owed = deal.amount_due_from_brokerage || 0
                          const paid = (deal.brokerage_payments || []).reduce((sum, p) => sum + p.amount, 0)
                          const remaining = owed - paid

                          return (
                            <div key={deal.id} className="rounded-lg p-4 bg-muted/20 border border-border/30 transition-all duration-200 hover:border-primary/30 hover:bg-primary/[0.03] group/deal">
                              <div className="flex items-start justify-between mb-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <p className="font-medium text-sm truncate text-foreground transition-colors group-hover/deal:text-primary">{deal.property_address}</p>
                                    <span className={`flex-shrink-0 inline-flex px-2 py-0.5 text-xs font-semibold rounded-md border ${
                                      paymentStatus === 'paid'
                                        ? 'bg-green-950/50 text-green-400 border-green-800'
                                        : paymentStatus === 'partial'
                                        ? 'bg-yellow-950/50 text-yellow-400 border-yellow-800'
                                        : 'bg-muted text-muted-foreground border-border'
                                    }`}>
                                      {paymentStatus === 'paid' ? 'Paid' : paymentStatus === 'partial' ? 'Partial' : 'Unpaid'}
                                    </span>
                                  </div>
                                  <p className="text-xs mt-1 text-muted-foreground">
                                    {deal.agent ? `${deal.agent.first_name || ''} ${deal.agent.last_name || ''}`.trim() : 'Unknown agent'}
                                    {deal.funding_date && ` · Funded ${formatDate(deal.funding_date)}`}
                                  </p>
                                </div>
                                <Button
                                  onClick={(e) => { e.stopPropagation(); router.push(`/admin/deals/${deal.id}`) }}
                                  variant="outline"
                                  size="sm"
                                  className="flex-shrink-0 text-xs text-primary border-border/50 hover:border-primary"
                                >
                                  View Deal
                                </Button>
                              </div>
                              <div className="grid grid-cols-3 gap-4 text-sm mt-2">
                                <div>
                                  <span className="text-muted-foreground">Owed: </span>
                                  <span className="font-semibold text-foreground">{formatCurrency(owed)}</span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Paid: </span>
                                  <span className={`font-semibold ${paid > 0 ? 'text-green-400' : 'text-muted-foreground'}`}>{formatCurrency(paid)}</span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Remaining: </span>
                                  <span className={`font-semibold ${remaining > 0.01 ? 'text-yellow-400' : 'text-green-400'}`}>
                                    {formatCurrency(Math.max(remaining, 0))}
                                  </span>
                                </div>
                              </div>

                              {deal.brokerage_payments && deal.brokerage_payments.length > 0 && (
                                <div className="mt-3 pt-3 border-t border-border/30">
                                  <p className="text-xs font-semibold uppercase tracking-wider mb-2 text-muted-foreground">Payment History</p>
                                  <div className="space-y-1.5">
                                    {deal.brokerage_payments.map((payment, idx) => {
                                      const pending = isPending(payment)
                                      const rejected = payment.status === 'rejected'
                                      const dotColor = pending ? 'bg-amber-400' : rejected ? 'bg-destructive' : 'bg-green-400'
                                      const amountColor = pending ? 'text-amber-400' : rejected ? 'text-destructive line-through opacity-60' : 'text-green-400'
                                      return (
                                        <div key={idx} className="flex items-center justify-between text-xs gap-2">
                                          <div className="flex items-center gap-2 min-w-0 flex-1">
                                            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
                                            <span className="text-foreground/80 flex-shrink-0">{formatDate(payment.date)}</span>
                                            {payment.reference && (
                                              <span className="text-muted-foreground truncate">Ref: {payment.reference}</span>
                                            )}
                                            {payment.method && (
                                              <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0 text-[10px] uppercase tracking-wider">
                                                {payment.method}
                                              </span>
                                            )}
                                            {pending && (
                                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-950/60 text-amber-400 border border-amber-800 flex-shrink-0">
                                                Pending
                                              </span>
                                            )}
                                            {rejected && (
                                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-destructive/20 text-destructive border border-destructive/40 flex-shrink-0">
                                                Rejected
                                              </span>
                                            )}
                                            {payment.submitted_by_role === 'brokerage_admin' && (
                                              <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">brokerage-submitted</span>
                                            )}
                                          </div>
                                          <span className={`font-semibold flex-shrink-0 ${amountColor}`}>
                                            {formatCurrency(payment.amount)}
                                          </span>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
