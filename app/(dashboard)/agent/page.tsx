'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, Clock,
  PlusCircle, Search, Calendar, ChevronRight, ChevronLeft, CreditCard,
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import AgentKycGate from '@/components/AgentKycGate'
import AgentHeader from '@/components/AgentHeader'

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
  const [loading, setLoading] = useState(true)
  const [showKycVerifiedModal, setShowKycVerifiedModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const DEALS_PER_PAGE = 10
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

  // handleLogout moved to AgentHeader

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

  // Show KYC verified modal once
  useEffect(() => {
    if (agent?.kyc_status === 'verified' && agent?.id) {
      const key = `kyc_verified_seen_${agent.id}`
      if (!localStorage.getItem(key)) {
        setShowKycVerifiedModal(true)
        localStorage.setItem(key, 'true')
      }
    }
  }, [agent?.kyc_status, agent?.id])

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
      {/* KYC Verified Congratulations Modal */}
      {showKycVerifiedModal && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
          onClick={() => setShowKycVerifiedModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: colors.cardBg, border: `2px solid #5FA873`,
              borderRadius: 16, padding: '40px 32px', maxWidth: 420, width: '100%',
              textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{
              width: 64, height: 64, borderRadius: '50%', margin: '0 auto 20px',
              background: 'rgba(95,168,115,0.15)', border: '2px solid #5FA873',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5FA873" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 style={{ color: colors.textPrimary, fontSize: 22, fontWeight: 700, margin: '0 0 8px' }}>
              Identity Verified!
            </h2>
            <p style={{ color: colors.textSecondary, fontSize: 15, lineHeight: 1.5, margin: '0 0 24px' }}>
              Congratulations{agent?.first_name ? `, ${agent.first_name}` : ''}! Your identity has been verified.
              You can now submit advance requests on your deals.
            </p>
            <button
              onClick={() => setShowKycVerifiedModal(false)}
              style={{
                background: '#5FA873', color: '#FFFFFF', border: 'none',
                padding: '12px 32px', borderRadius: 8, fontSize: 15,
                fontWeight: 600, cursor: 'pointer', width: '100%',
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#4E9462'}
              onMouseLeave={(e) => e.currentTarget.style.background = '#5FA873'}
            >
              Get Started
            </button>
          </div>
        </div>
      )}

      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageName={agent?.brokerages?.name}
        brokerageBrandColor={agent?.brokerages?.brand_color}
      />

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

        {/* Banking nudge — show after KYC verified but no banking on file */}
        {agent?.kyc_status === 'verified' && !agent?.banking_verified && !agent?.preauth_form_path && (
          <div className="mb-6 rounded-xl p-4 flex items-center justify-between gap-3"
            style={{ background: '#2A2210', border: '1px solid #4A3A1C' }}
          >
            <div className="flex items-center gap-3">
              <CreditCard size={18} style={{ color: '#D4A04A', flexShrink: 0 }} />
              <div>
                <p className="text-sm font-medium" style={{ color: '#D4A04A' }}>Set up your banking info</p>
                <p className="text-xs mt-0.5" style={{ color: '#B8923E' }}>Upload your pre-authorized debit form now so your first deal isn&apos;t delayed. Banking must be verified before advances can be funded.</p>
              </div>
            </div>
            <button
              onClick={() => router.push('/agent/profile')}
              className="flex-shrink-0 text-xs font-semibold px-3.5 py-2 rounded-lg transition-colors whitespace-nowrap"
              style={{ background: '#4A3A1C', color: '#D4A04A' }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#5A4A2C'}
              onMouseLeave={(e) => e.currentTarget.style.background = '#4A3A1C'}
            >
              Go to Profile →
            </button>
          </div>
        )}

        {/* Banking submitted but not yet verified */}
        {agent?.kyc_status === 'verified' && !agent?.banking_verified && agent?.preauth_form_path && (
          <div className="mb-6 rounded-xl p-4 flex items-center gap-3"
            style={{ background: '#1A2240', border: '1px solid #2D3A5C' }}
          >
            <Clock size={18} style={{ color: '#7B9FE0', flexShrink: 0 }} />
            <div>
              <p className="text-sm font-medium" style={{ color: '#7B9FE0' }}>Banking info under review</p>
              <p className="text-xs mt-0.5" style={{ color: '#6B8AC0' }}>Your pre-authorized debit form has been uploaded and is being reviewed. You can submit deals in the meantime.</p>
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
                    onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
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
                  onClick={() => { setStatusFilter(null); setCurrentPage(1) }}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
                  style={{
                    background: statusFilter === null ? colors.gold : 'transparent',
                    color: statusFilter === null ? '#FFF' : colors.textMuted,
                    border: `1px solid ${statusFilter === null ? colors.gold : colors.border}`,
                  }}
                >
                  All ({deals.length})
                </button>
                {['under_review', 'approved', 'funded', 'completed', 'denied', 'cancelled'].map(status => {
                  const count = statusCounts[status] || 0
                  if (count === 0) return null
                  return (
                    <button
                      key={status}
                      onClick={() => { setStatusFilter(statusFilter === status ? null : status); setCurrentPage(1) }}
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
            <>
              {(() => {
                const totalPages = Math.max(1, Math.ceil(filteredDeals.length / DEALS_PER_PAGE))
                const page = Math.min(currentPage, totalPages)
                const paged = filteredDeals.slice((page - 1) * DEALS_PER_PAGE, page * DEALS_PER_PAGE)
                return (
                  <>
                    <div>
                      {paged.map((deal, i) => (
                        <div
                          key={deal.id}
                          className="px-6 py-4 flex items-center justify-between cursor-pointer transition-colors"
                          style={{ borderBottom: i < paged.length - 1 ? `1px solid ${colors.divider}` : 'none' }}
                          onClick={() => router.push(`/agent/deals/${deal.id}`)}
                          onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          <div className="flex-1 min-w-0 mr-3">
                            <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{deal.property_address}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              <span className="text-xs" style={{ color: colors.textMuted }}>
                                {formatDate(deal.created_at)}
                              </span>
                              {deal.closing_date && (
                                <>
                                  <span className="text-xs hidden sm:inline" style={{ color: colors.textFaint }}>·</span>
                                  <span className="text-xs flex items-center gap-1" style={{ color: deal.days_until_closing <= 7 ? colors.warningText : colors.textMuted }}>
                                    <Calendar size={10} />
                                    Closing {formatDate(deal.closing_date)}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
                            <span
                              className="inline-flex px-2 py-0.5 sm:px-2.5 sm:py-1 text-[10px] sm:text-xs font-semibold rounded-md whitespace-nowrap"
                              style={getStatusBadgeStyle(deal.status)}
                            >
                              {formatStatusLabel(deal.status)}
                            </span>
                            <p className="text-sm font-bold text-right hidden sm:block" style={{ color: colors.successText }}>{formatCurrency(deal.advance_amount)}</p>
                            <ChevronRight size={16} style={{ color: colors.textFaint }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    {totalPages > 1 && (
                      <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: `1px solid ${colors.border}` }}>
                        <p className="text-xs" style={{ color: colors.textMuted }}>
                          Showing {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, filteredDeals.length)} of {filteredDeals.length}
                        </p>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={page === 1}
                            className="p-2 rounded-lg transition-colors disabled:opacity-30"
                            style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                          >
                            <ChevronLeft size={14} />
                          </button>
                          <span className="px-3 text-xs font-semibold" style={{ color: colors.textPrimary }}>
                            {page} / {totalPages}
                          </span>
                          <button
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                            className="p-2 rounded-lg transition-colors disabled:opacity-30"
                            style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                          >
                            <ChevronRight size={14} />
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
