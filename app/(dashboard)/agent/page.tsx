'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, DollarSign, Clock, CheckCircle, ChevronDown, ChevronUp,
  PlusCircle, Eye, X, Search, TrendingUp, Wallet, Calendar,
} from 'lucide-react'
import { cancelDeal } from '@/lib/actions/deal-actions'
import { useTheme } from '@/lib/theme'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import SignOutModal from '@/components/SignOutModal'
import AgentKycGate from '@/components/AgentKycGate'

interface Deal {
  id: string
  status: string
  property_address: string
  closing_date: string
  gross_commission: number
  brokerage_split_pct: number
  net_commission: number
  days_until_closing: number
  discount_fee: number
  advance_amount: number
  brokerage_referral_fee: number
  amount_due_from_brokerage: number
  funding_date: string | null
  repayment_date: string | null
  source: string
  created_at: string
}

export default function AgentDashboard() {
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [expandedDeal, setExpandedDeal] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  useEffect(() => {
    async function loadAgent() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()
      setProfile(profile)

      if (profile?.role !== 'agent') { router.push('/login'); return }

      if (profile?.agent_id) {
        const { data: agentData } = await supabase
          .from('agents')
          .select('*, brokerages(*)')
          .eq('id', profile.agent_id)
          .single()
        setAgent(agentData)

        const { data: dealData } = await supabase
          .from('deals')
          .select('*')
          .eq('agent_id', profile.agent_id)
          .order('created_at', { ascending: false })
        setDeals(dealData || [])
      }

      setLoading(false)
    }
    loadAgent()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // KPI calculations
  const totalAdvanced = useMemo(() =>
    deals.filter(d => ['funded', 'repaid', 'closed'].includes(d.status))
      .reduce((sum, d) => sum + d.advance_amount, 0), [deals])

  const totalNetCommission = useMemo(() =>
    deals.filter(d => ['funded', 'repaid', 'closed'].includes(d.status))
      .reduce((sum, d) => sum + d.net_commission, 0), [deals])

  const totalDiscountFees = useMemo(() =>
    deals.filter(d => ['funded', 'repaid', 'closed'].includes(d.status))
      .reduce((sum, d) => sum + d.discount_fee, 0), [deals])

  const activeDeals = useMemo(() =>
    deals.filter(d => ['under_review', 'approved', 'funded'].includes(d.status)).length, [deals])

  const completedDeals = useMemo(() =>
    deals.filter(d => ['repaid', 'closed'].includes(d.status)).length, [deals])

  // Filtered deals
  const filteredDeals = useMemo(() => {
    let result = deals

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(d =>
        d.property_address.toLowerCase().includes(q) ||
        d.status.toLowerCase().includes(q) ||
        formatCurrency(d.advance_amount).toLowerCase().includes(q)
      )
    }

    if (statusFilter) {
      result = result.filter(d => d.status === statusFilter)
    }

    return result
  }, [deals, searchQuery, statusFilter])

  // Status counts for filter tabs
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const deal of deals) {
      counts[deal.status] = (counts[deal.status] || 0) + 1
    }
    return counts
  }, [deals])

  // KYC status
  const kycPending = agent && agent.kyc_status === 'pending'
  const kycSubmitted = agent && agent.kyc_status === 'submitted'
  const kycRejected = agent && agent.kyc_status === 'rejected'
  const kycNotVerified = agent && agent.kyc_status !== 'verified'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}>
        <div style={{ color: colors.textMuted }} className="text-lg">Loading your dashboard...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-4">
              <img src="/brand/white.png" alt="Firm Funds" className="h-16 sm:h-20 md:h-28 w-auto" />
              <div className="w-px h-10" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <p className="text-lg font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Agent Portal</p>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm" style={{ color: colors.gold }}>{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* KYC Banner */}
        {(kycPending || kycRejected) && (
          <AgentKycGate agent={agent} onKycSubmitted={() => window.location.reload()} />
        )}
        {kycSubmitted && (
          <div className="mb-6 rounded-xl p-4 flex items-center gap-3"
            style={{ background: '#1A2240', border: '1px solid #2D3A5C' }}
          >
            <Clock size={18} style={{ color: '#7B9FE0', flexShrink: 0 }} />
            <div>
              <p className="text-sm font-medium" style={{ color: '#7B9FE0' }}>Identity verification submitted</p>
              <p className="text-xs mt-0.5" style={{ color: '#6B8AC0' }}>Your ID is under review. You can browse your dashboard but deal submission is locked until verified.</p>
            </div>
          </div>
        )}

        {/* Welcome + New Deal Button */}
        <div className="mb-8 flex justify-between items-start">
          <div>
            <h2 className="text-2xl font-bold" style={{ color: colors.textPrimary }}>
              Welcome back, {profile?.full_name?.split(' ')[0]}
            </h2>
            {agent?.brokerages && (
              <p className="text-sm mt-1" style={{ color: colors.textMuted }}>{agent.brokerages.name}</p>
            )}
          </div>
          <button
            onClick={() => kycNotVerified ? null : router.push('/agent/new-deal')}
            disabled={!!kycNotVerified}
            className="flex items-center gap-2 text-white px-5 py-2.5 rounded-lg font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: kycNotVerified ? '#333' : colors.headerBgGradient }}
            onMouseEnter={(e) => { if (!kycNotVerified) e.currentTarget.style.background = 'linear-gradient(135deg, #2D2D2D, #3D3D3D)' }}
            onMouseLeave={(e) => { if (!kycNotVerified) e.currentTarget.style.background = colors.headerBgGradient }}
            title={kycNotVerified ? 'Complete identity verification to submit deals' : 'Submit a new advance request'}
          >
            <PlusCircle size={16} />
            New Advance Request
          </button>
        </div>

        {/* KPI Cards — 4 columns */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Total Advanced', value: formatCurrency(totalAdvanced), icon: DollarSign, accent: colors.successText },
            { label: 'Net Commission', value: formatCurrency(totalNetCommission), icon: TrendingUp, accent: colors.gold },
            { label: 'Active Deals', value: activeDeals.toString(), icon: Clock, accent: colors.infoText },
            { label: 'Completed', value: completedDeals.toString(), icon: CheckCircle, accent: '#0D7A5F' },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-xl p-5 transition-shadow hover:shadow-lg"
              style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>{card.label}</p>
                  <p className="text-2xl font-black mt-1.5" style={{ color: colors.textPrimary }}>{card.value}</p>
                </div>
                <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: `${card.accent}12` }}>
                  <card.icon size={18} style={{ color: card.accent }} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Discount Fees Summary — subtle info bar */}
        {totalDiscountFees > 0 && (
          <div className="mb-6 rounded-lg p-3 flex items-center justify-between text-sm"
            style={{ background: colors.tableHeaderBg, border: `1px solid ${colors.divider}` }}
          >
            <div className="flex items-center gap-2">
              <Wallet size={16} style={{ color: colors.textMuted }} />
              <span style={{ color: colors.textSecondary }}>Total Discount Fees Paid</span>
            </div>
            <span className="font-bold" style={{ color: colors.errorText }}>{formatCurrency(totalDiscountFees)}</span>
          </div>
        )}

        {/* Deals List */}
        <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          {/* Header with search */}
          <div className="px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <h3 className="text-lg font-bold flex-shrink-0" style={{ color: colors.textPrimary }}>Your Deals</h3>
              {deals.length > 0 && (
                <div className="relative flex-1 max-w-sm ml-auto">
                  <Search size={14} style={{ color: colors.textMuted, position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    type="text"
                    placeholder="Search by address..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-lg pl-8 pr-3 py-2 text-sm outline-none"
                    style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
                  />
                </div>
              )}
            </div>

            {/* Status filter tabs */}
            {deals.length > 3 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                <button
                  onClick={() => setStatusFilter(null)}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
                  style={{
                    background: statusFilter === null ? colors.gold : 'transparent',
                    color: statusFilter === null ? '#FFF' : colors.textMuted,
                    border: `1px solid ${statusFilter === null ? colors.gold : colors.border}`,
                  }}
                >
                  All ({deals.length})
                </button>
                {['under_review', 'approved', 'funded', 'repaid', 'closed', 'denied', 'cancelled'].map(status => {
                  const count = statusCounts[status] || 0
                  if (count === 0) return null
                  return (
                    <button
                      key={status}
                      onClick={() => setStatusFilter(statusFilter === status ? null : status)}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
                      style={{
                        background: statusFilter === status ? colors.gold : 'transparent',
                        color: statusFilter === status ? '#FFF' : colors.textMuted,
                        border: `1px solid ${statusFilter === status ? colors.gold : colors.border}`,
                      }}
                    >
                      {formatStatusLabel(status)} ({count})
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {deals.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <FileText className="mx-auto mb-4" size={40} style={{ color: colors.textFaint }} />
              <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>No deals yet</p>
              <p className="text-sm mt-1 mb-5" style={{ color: colors.textMuted }}>Your commission advance requests will appear here.</p>
              {!kycNotVerified && (
                <button
                  onClick={() => router.push('/agent/new-deal')}
                  className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-lg font-medium text-sm"
                  style={{ background: colors.headerBgGradient }}
                >
                  <PlusCircle size={16} />
                  Submit Your First Advance Request
                </button>
              )}
            </div>
          ) : filteredDeals.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Search className="mx-auto mb-3" size={32} style={{ color: colors.textFaint }} />
              <p className="text-sm font-semibold" style={{ color: colors.textSecondary }}>No matching deals</p>
              <p className="text-xs mt-1" style={{ color: colors.textMuted }}>Try adjusting your search or filter.</p>
            </div>
          ) : (
            <div>
              {filteredDeals.map((deal, i) => (
                <div key={deal.id}>
                  <div
                    className="px-6 py-4 flex items-center justify-between cursor-pointer transition-colors"
                    style={{ borderBottom: i < filteredDeals.length - 1 && expandedDeal !== deal.id ? `1px solid ${colors.divider}` : 'none' }}
                    onClick={() => setExpandedDeal(expandedDeal === deal.id ? null : deal.id)}
                    onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{deal.property_address}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs" style={{ color: colors.textMuted }}>
                          {formatDate(deal.created_at)}
                        </span>
                        {deal.closing_date && (
                          <>
                            <span className="text-xs" style={{ color: colors.textFaint }}>·</span>
                            <span className="text-xs flex items-center gap-1" style={{ color: deal.days_until_closing <= 7 ? colors.warningText : colors.textMuted }}>
                              <Calendar size={10} />
                              Closing {formatDate(deal.closing_date)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <span
                        className="inline-flex px-2.5 py-1 text-xs font-semibold rounded-md"
                        style={getStatusBadgeStyle(deal.status)}
                      >
                        {formatStatusLabel(deal.status)}
                      </span>
                      <p className="text-sm font-bold w-28 text-right" style={{ color: colors.successText }}>{formatCurrency(deal.advance_amount)}</p>
                      {expandedDeal === deal.id
                        ? <ChevronUp size={16} style={{ color: colors.textFaint }} />
                        : <ChevronDown size={16} style={{ color: colors.textFaint }} />
                      }
                    </div>
                  </div>

                  {expandedDeal === deal.id && (
                    <div className="px-6 pb-6" style={{ background: colors.tableHeaderBg, borderBottom: `1px solid ${colors.divider}` }}>
                      {/* Mini Pipeline */}
                      <div className="pt-5 mb-5">
                        <div className="flex items-center gap-1">
                          {['under_review', 'approved', 'funded', 'repaid', 'closed'].map((status, index) => {
                            const isActive = status === deal.status
                            const isPast = ['under_review', 'approved', 'funded', 'repaid', 'closed'].indexOf(deal.status) > index
                            const isDenied = deal.status === 'denied' || deal.status === 'cancelled'
                            const barColor = isDenied ? colors.errorBorder : isActive ? colors.gold : isPast ? colors.successText : colors.inputBg
                            return (
                              <div key={status} className="flex-1">
                                <div className="h-1.5 rounded-full" style={{ background: barColor }} />
                                <p className={`text-[10px] mt-1 text-center ${isActive ? 'font-bold' : ''}`}
                                  style={{ color: isActive ? colors.gold : isPast ? colors.successText : colors.textFaint }}>
                                  {formatStatusLabel(status)}
                                </p>
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Deal Details</h4>
                          <div className="space-y-2.5 text-sm">
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Property</span>
                              <span className="font-medium text-right" style={{ color: colors.textPrimary }}>{deal.property_address}</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Closing Date</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.closing_date)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Days Until Closing</span>
                              <span className="font-medium" style={{ color: deal.days_until_closing <= 7 ? colors.warningText : colors.textPrimary }}>
                                {deal.days_until_closing} days
                              </span>
                            </div>
                            {deal.funding_date && (
                              <div className="flex justify-between">
                                <span style={{ color: colors.textMuted }}>Funded On</span>
                                <span className="font-medium" style={{ color: colors.successText }}>{formatDate(deal.funding_date)}</span>
                              </div>
                            )}
                            {deal.repayment_date && (
                              <div className="flex justify-between">
                                <span style={{ color: colors.textMuted }}>Repaid On</span>
                                <span className="font-medium" style={{ color: colors.successText }}>{formatDate(deal.repayment_date)}</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div>
                          <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Financial Summary</h4>
                          <div className="space-y-2.5 text-sm">
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Gross Commission</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.gross_commission)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Brokerage Split</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{deal.brokerage_split_pct}%</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Your Net Commission</span>
                              <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.net_commission)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span style={{ color: colors.textMuted }}>Discount Fee</span>
                              <span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(deal.discount_fee)}</span>
                            </div>
                            <div className="flex justify-between pt-2.5 mt-2.5" style={{ borderTop: `1px solid ${colors.border}` }}>
                              <span className="font-bold" style={{ color: colors.textPrimary }}>Advance Amount</span>
                              <span className="font-bold" style={{ color: colors.successText }}>{formatCurrency(deal.advance_amount)}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 pt-4 flex items-center gap-3" style={{ borderTop: `1px solid ${colors.border}` }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); router.push(`/agent/deals/${deal.id}`) }}
                          className="flex items-center gap-2 text-white px-4 py-2.5 rounded-lg font-medium text-sm transition-colors"
                          style={{ background: colors.headerBgGradient }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'linear-gradient(135deg, #2D2D2D, #3D3D3D)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = colors.headerBgGradient}
                        >
                          <Eye size={16} />
                          View Deal & Upload Documents
                        </button>
                        {['under_review', 'approved'].includes(deal.status) && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation()
                              const msg = deal.status === 'under_review'
                                ? 'Withdraw this advance request? It will be permanently removed.'
                                : 'Are you sure you want to cancel this advance request? This cannot be undone.'
                              if (!confirm(msg)) return
                              const result = await cancelDeal({ dealId: deal.id })
                              if (result.success) {
                                if (result.data?.deleted) {
                                  setDeals(prev => prev.filter(d => d.id !== deal.id))
                                  setExpandedDeal(null)
                                } else {
                                  setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, status: 'cancelled' } : d))
                                }
                              } else {
                                alert(result.error || 'Failed to cancel deal')
                              }
                            }}
                            className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg font-medium text-sm transition-colors"
                            style={{ color: colors.errorText, border: `1px solid ${colors.errorBorder}`, background: colors.errorBg }}
                            onMouseEnter={(e) => e.currentTarget.style.background = colors.errorBorder}
                            onMouseLeave={(e) => e.currentTarget.style.background = colors.errorBg}
                          >
                            <X size={14} />
                            {deal.status === 'under_review' ? 'Withdraw' : 'Cancel'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
