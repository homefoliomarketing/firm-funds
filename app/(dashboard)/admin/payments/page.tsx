'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, DollarSign, Building2, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, Clock, Search, FileText,
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { formatCurrency, formatDate } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'

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
  const { colors } = useTheme()

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

    // Fetch all funded/completed deals with brokerage info
    const { data: deals } = await supabase
      .from('deals')
      .select('id, property_address, status, advance_amount, amount_due_from_brokerage, brokerage_referral_fee, brokerage_payments, funding_date, closing_date, brokerage_id, agent:agents(first_name, last_name)')
      .in('status', ['funded', 'completed'])
      .order('funding_date', { ascending: false })

    // Fetch all brokerages
    const { data: brokerages } = await supabase
      .from('brokerages')
      .select('id, name')
      .order('name')

    if (!deals || !brokerages) {
      setLoading(false)
      return
    }

    // Group deals by brokerage and calculate summaries
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

      // Normalize agent from array to object (Supabase FK join can return array)
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

    // Calculate outstanding
    for (const summary of brokerageMap.values()) {
      summary.outstanding = summary.totalOwed - summary.totalPaid
    }

    // Only include brokerages with relevant deals
    const results = Array.from(brokerageMap.values()).filter(s => s.deals.length > 0)
    // Sort by outstanding balance (highest first)
    results.sort((a, b) => b.outstanding - a.outstanding)

    setSummaries(results)
    setLoading(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // Filter and search
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

  // KPI totals
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
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <header style={{ background: colors.headerBgGradient }}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <div className="h-5 w-48 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.1)' }} />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
            {[1, 2, 3].map(i => (
              <div key={i} className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="h-3 w-20 rounded animate-pulse mb-3" style={{ background: colors.skeletonBase }} />
                <div className="h-8 w-32 rounded animate-pulse" style={{ background: colors.skeletonHighlight }} />
              </div>
            ))}
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-4">
              <img src="/brand/white.png" alt="Firm Funds" className="h-16 sm:h-20 md:h-28 w-auto" />
              <div className="w-px h-10" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <button
                onClick={() => router.push('/admin')}
                className="transition-colors"
                style={{ color: colors.textSecondary }}
                onMouseEnter={(e) => e.currentTarget.style.color = colors.gold}
                onMouseLeave={(e) => e.currentTarget.style.color = colors.textSecondary}
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h1 className="text-lg font-bold text-white">Brokerage Payments</h1>
                <p className="text-xs" style={{ color: colors.textMuted }}>Track payments from partner brokerages</p>
              </div>
            </div>
            <SignOutModal onConfirm={handleLogout} />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>Total Owed</p>
                <p className="text-3xl font-black mt-2" style={{ color: colors.textPrimary }}>{formatCurrency(totals.totalOwed)}</p>
              </div>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${colors.infoText}12` }}>
                <DollarSign size={22} style={{ color: colors.infoText }} />
              </div>
            </div>
          </div>
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>Total Collected</p>
                <p className="text-3xl font-black mt-2" style={{ color: colors.successText }}>{formatCurrency(totals.totalPaid)}</p>
              </div>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${colors.successText}12` }}>
                <CheckCircle2 size={22} style={{ color: colors.successText }} />
              </div>
            </div>
          </div>
          <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>Outstanding</p>
                <p className="text-3xl font-black mt-2" style={{ color: totals.outstanding > 0 ? colors.warningText : colors.successText }}>
                  {formatCurrency(totals.outstanding)}
                </p>
              </div>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: totals.outstanding > 0 ? `${colors.warningText}12` : `${colors.successText}12` }}>
                {totals.outstanding > 0
                  ? <AlertTriangle size={22} style={{ color: colors.warningText }} />
                  : <CheckCircle2 size={22} style={{ color: colors.successText }} />
                }
              </div>
            </div>
          </div>
        </div>

        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search size={16} style={{ color: colors.textMuted, position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
            <input
              type="text"
              placeholder="Search brokerages or properties..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg pl-9 pr-4 py-2.5 text-sm outline-none"
              style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
              onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
              onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
            />
          </div>
          <div className="flex gap-2">
            {(['all', 'outstanding', 'fully_paid'] as const).map(status => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                className="px-4 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
                style={{
                  background: filterStatus === status ? colors.gold : 'transparent',
                  color: filterStatus === status ? '#FFF' : colors.textSecondary,
                  border: `1px solid ${filterStatus === status ? colors.gold : colors.border}`,
                }}
              >
                {status === 'all' ? 'All' : status === 'outstanding' ? 'Outstanding' : 'Fully Paid'}
              </button>
            ))}
          </div>
        </div>

        {/* Brokerage Payment Cards */}
        {filteredSummaries.length === 0 ? (
          <div className="rounded-xl p-12 text-center" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <Building2 size={40} className="mx-auto mb-4" style={{ color: colors.textFaint }} />
            <p className="font-semibold" style={{ color: colors.textSecondary }}>
              {summaries.length === 0 ? 'No funded deals yet' : 'No matching brokerages'}
            </p>
            <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
              {summaries.length === 0 ? 'Brokerage payment tracking will appear here once deals are funded.' : 'Try adjusting your search or filter.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredSummaries.map(summary => {
              const isExpanded = expandedBrokerage === summary.brokerage.id
              const paidPct = summary.totalOwed > 0 ? Math.min((summary.totalPaid / summary.totalOwed) * 100, 100) : 0
              const isFullyPaid = summary.outstanding < 0.01 && summary.totalOwed > 0

              return (
                <div key={summary.brokerage.id} className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                  {/* Brokerage Summary Row */}
                  <div
                    className="px-6 py-5 cursor-pointer transition-colors"
                    style={{ borderBottom: isExpanded ? `1px solid ${colors.border}` : 'none' }}
                    onClick={() => setExpandedBrokerage(isExpanded ? null : summary.brokerage.id)}
                    onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: `${colors.gold}15` }}>
                          <Building2 size={18} style={{ color: colors.gold }} />
                        </div>
                        <div>
                          <h3 className="font-bold" style={{ color: colors.textPrimary }}>{summary.brokerage.name}</h3>
                          <p className="text-xs" style={{ color: colors.textMuted }}>
                            {summary.deals.length} deal{summary.deals.length !== 1 ? 's' : ''} &middot;
                            {summary.fullyPaidDeals > 0 && ` ${summary.fullyPaidDeals} paid`}
                            {summary.partiallyPaidDeals > 0 && ` ${summary.partiallyPaidDeals} partial`}
                            {summary.unpaidDeals > 0 && ` ${summary.unpaidDeals} unpaid`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-right">
                          <p className="text-xs font-semibold uppercase" style={{ color: colors.textMuted }}>Outstanding</p>
                          <p className="text-lg font-black" style={{ color: isFullyPaid ? colors.successText : colors.warningText }}>
                            {isFullyPaid ? 'Paid' : formatCurrency(summary.outstanding)}
                          </p>
                        </div>
                        {isExpanded ? <ChevronUp size={18} style={{ color: colors.textFaint }} /> : <ChevronDown size={18} style={{ color: colors.textFaint }} />}
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: colors.inputBg }}>
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${paidPct}%`,
                            background: isFullyPaid ? colors.successText : paidPct > 0 ? colors.warningText : colors.textFaint,
                          }}
                        />
                      </div>
                      <span className="text-xs font-semibold w-16 text-right" style={{ color: colors.textMuted }}>
                        {paidPct.toFixed(0)}% paid
                      </span>
                    </div>
                  </div>

                  {/* Expanded: Deal-Level Details */}
                  {isExpanded && (
                    <div className="px-6 pb-5">
                      {/* Brokerage Totals */}
                      <div className="grid grid-cols-3 gap-4 py-4 mb-4" style={{ borderBottom: `1px solid ${colors.divider}` }}>
                        <div>
                          <p className="text-xs font-semibold uppercase" style={{ color: colors.textMuted }}>Total Owed</p>
                          <p className="text-lg font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(summary.totalOwed)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase" style={{ color: colors.textMuted }}>Total Paid</p>
                          <p className="text-lg font-bold" style={{ color: colors.successText }}>{formatCurrency(summary.totalPaid)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase" style={{ color: colors.textMuted }}>Remaining</p>
                          <p className="text-lg font-bold" style={{ color: summary.outstanding > 0.01 ? colors.warningText : colors.successText }}>
                            {formatCurrency(Math.max(summary.outstanding, 0))}
                          </p>
                        </div>
                      </div>

                      {/* Deal Table */}
                      <div className="space-y-3">
                        {summary.deals.map(deal => {
                          const paymentStatus = getDealPaymentStatus(deal)
                          const owed = deal.amount_due_from_brokerage || 0
                          const paid = (deal.brokerage_payments || []).reduce((sum, p) => sum + p.amount, 0)
                          const remaining = owed - paid

                          return (
                            <div key={deal.id} className="rounded-lg p-4" style={{ background: colors.tableHeaderBg, border: `1px solid ${colors.divider}` }}>
                              <div className="flex items-start justify-between mb-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <p className="font-medium text-sm truncate" style={{ color: colors.textPrimary }}>{deal.property_address}</p>
                                    <span
                                      className="flex-shrink-0 inline-flex px-2 py-0.5 text-xs font-semibold rounded-md"
                                      style={{
                                        background: paymentStatus === 'paid' ? colors.successBg : paymentStatus === 'partial' ? colors.warningBg : colors.inputBg,
                                        color: paymentStatus === 'paid' ? colors.successText : paymentStatus === 'partial' ? colors.warningText : colors.textMuted,
                                        border: `1px solid ${paymentStatus === 'paid' ? colors.successBorder : paymentStatus === 'partial' ? colors.warningBorder : colors.border}`,
                                      }}
                                    >
                                      {paymentStatus === 'paid' ? 'Paid' : paymentStatus === 'partial' ? 'Partial' : 'Unpaid'}
                                    </span>
                                  </div>
                                  <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                                    {deal.agent ? `${deal.agent.first_name || ''} ${deal.agent.last_name || ''}`.trim() : 'Unknown agent'}
                                    {deal.funding_date && ` · Funded ${formatDate(deal.funding_date)}`}
                                  </p>
                                </div>
                                <button
                                  onClick={(e) => { e.stopPropagation(); router.push(`/admin/deals/${deal.id}`) }}
                                  className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                                  style={{ color: colors.gold, border: `1px solid ${colors.border}` }}
                                  onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
                                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border }}
                                >
                                  View Deal
                                </button>
                              </div>
                              <div className="grid grid-cols-3 gap-4 text-sm mt-2">
                                <div>
                                  <span style={{ color: colors.textMuted }}>Owed: </span>
                                  <span className="font-semibold" style={{ color: colors.textPrimary }}>{formatCurrency(owed)}</span>
                                </div>
                                <div>
                                  <span style={{ color: colors.textMuted }}>Paid: </span>
                                  <span className="font-semibold" style={{ color: paid > 0 ? colors.successText : colors.textMuted }}>{formatCurrency(paid)}</span>
                                </div>
                                <div>
                                  <span style={{ color: colors.textMuted }}>Remaining: </span>
                                  <span className="font-semibold" style={{ color: remaining > 0.01 ? colors.warningText : colors.successText }}>
                                    {formatCurrency(Math.max(remaining, 0))}
                                  </span>
                                </div>
                              </div>

                              {/* Individual payment history for this deal */}
                              {deal.brokerage_payments && deal.brokerage_payments.length > 0 && (
                                <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${colors.divider}` }}>
                                  <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: colors.textMuted }}>
                                    Payment History
                                  </p>
                                  <div className="space-y-1.5">
                                    {deal.brokerage_payments.map((payment, idx) => (
                                      <div key={idx} className="flex items-center justify-between text-xs">
                                        <div className="flex items-center gap-2">
                                          <div className="w-1.5 h-1.5 rounded-full" style={{ background: colors.successText }} />
                                          <span style={{ color: colors.textSecondary }}>{formatDate(payment.date)}</span>
                                          {payment.reference && (
                                            <span style={{ color: colors.textMuted }}>Ref: {payment.reference}</span>
                                          )}
                                          {payment.method && (
                                            <span className="px-1.5 py-0.5 rounded" style={{ background: colors.inputBg, color: colors.textMuted }}>
                                              {payment.method}
                                            </span>
                                          )}
                                        </div>
                                        <span className="font-semibold" style={{ color: colors.successText }}>
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
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
