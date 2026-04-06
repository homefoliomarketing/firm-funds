'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, DollarSign, Building2, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, Clock, Search, FileText,
} from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

interface Deal {
  id: string
  property_address: string
  status: string
  advance_amount: number
  amount_due_from_brokerage: number
  brokerage_referral_fee: number
  brokerage_payments: { amount: number; date: string; reference?: string; method?: string }[] | null
  funding_date: string | null
  closing_date: string
  agent: any
}

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
      const paid = (deal.brokerage_payments || []).reduce((sum: number, p: any) => sum + p.amount, 0)

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
    const paid = (deal.brokerage_payments || []).reduce((sum, p) => sum + p.amount, 0)
    if (owed <= 0) return 'none'
    if (Math.abs(paid - owed) < 0.01) return 'paid'
    if (paid > 0) return 'partial'
    return 'unpaid'
  }

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
            <div className="flex items-center gap-4">
              <img src="/brand/white.png" alt="Firm Funds" className="h-16 sm:h-20 md:h-28 w-auto" />
              <div className="w-px h-10 bg-white/15" />
              <button
                onClick={() => router.push('/admin')}
                className="text-white/70 hover:text-primary transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h1 className="text-lg font-bold text-white">Brokerage Payments</h1>
                <p className="text-xs text-muted-foreground">Track payments from partner brokerages</p>
              </div>
            </div>
            <SignOutModal onConfirm={handleLogout} />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Owed</p>
                  <p className="text-3xl font-black mt-2 text-foreground">{formatCurrency(totals.totalOwed)}</p>
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
                  <p className="text-3xl font-black mt-2 text-green-400">{formatCurrency(totals.totalPaid)}</p>
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
                  <p className={`text-3xl font-black mt-2 ${totals.outstanding > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
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
        </div>

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
                <Card key={summary.brokerage.id} className="overflow-hidden">
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
                            background: isFullyPaid ? '#4ade80' : paidPct > 0 ? '#facc15' : '#4b5563',
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
                    <div className="px-6 pb-5 border-t border-border/50">
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
                            <div key={deal.id} className="rounded-lg p-4 bg-muted/30 border border-border/30">
                              <div className="flex items-start justify-between mb-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <p className="font-medium text-sm truncate text-foreground">{deal.property_address}</p>
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
                                    {deal.brokerage_payments.map((payment, idx) => (
                                      <div key={idx} className="flex items-center justify-between text-xs">
                                        <div className="flex items-center gap-2">
                                          <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                          <span className="text-foreground/80">{formatDate(payment.date)}</span>
                                          {payment.reference && (
                                            <span className="text-muted-foreground">Ref: {payment.reference}</span>
                                          )}
                                          {payment.method && (
                                            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                              {payment.method}
                                            </span>
                                          )}
                                        </div>
                                        <span className="font-semibold text-green-400">
                                          {formatCurrency(payment.amount)}
                                        </span>
                                      </div>
                                    ))}
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
