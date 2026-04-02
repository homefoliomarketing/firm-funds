'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { LogOut, FileText, Users, DollarSign, ChevronDown, ChevronUp, AlertTriangle, CheckCircle, Upload, Paperclip, ChevronLeft, ChevronRight } from 'lucide-react'
import { uploadDocument } from '@/lib/actions/deal-actions'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import { useTheme } from '@/lib/theme'
import ThemeToggle from '@/components/ThemeToggle'

interface Deal {
  id: string
  agent_id: string
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
  created_at: string
  agent?: {
    first_name: string
    last_name: string
    email: string
    flagged_by_brokerage: boolean
  }
}

interface Agent {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  status: string
  flagged_by_brokerage: boolean
}

export default function BrokerageDashboard() {
  const [profile, setProfile] = useState<any>(null)
  const [brokerage, setBrokerage] = useState<any>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [expandedDeal, setExpandedDeal] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'deals' | 'agents' | 'referrals'>('deals')
  const [loading, setLoading] = useState(true)
  const [uploadingDeal, setUploadingDeal] = useState<string | null>(null)
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [dealTradeRecords, setDealTradeRecords] = useState<Set<string>>(new Set()) // deal IDs that have trade records
  const [dealsPage, setDealsPage] = useState(1)
  const DEALS_PER_PAGE = 15
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  useEffect(() => {
    async function loadBrokerage() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: profileData } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
      setProfile(profileData)
      if (profileData?.role !== 'brokerage_admin') { router.push('/login'); return }
      if (profileData?.brokerage_id) {
        const { data: brokerageData } = await supabase.from('brokerages').select('*').eq('id', profileData.brokerage_id).single()
        setBrokerage(brokerageData)
        const { data: dealData } = await supabase.from('deals').select('*, agent:agents(first_name, last_name, email, flagged_by_brokerage)').eq('brokerage_id', profileData.brokerage_id).order('created_at', { ascending: false })
        setDeals(dealData || [])
        // Check which deals have trade records uploaded
        if (dealData && dealData.length > 0) {
          const dealIds = dealData.map((d: any) => d.id)
          const { data: tradeRecDocs } = await supabase
            .from('deal_documents')
            .select('deal_id')
            .in('deal_id', dealIds)
            .eq('document_type', 'trade_record')
          if (tradeRecDocs) {
            setDealTradeRecords(new Set(tradeRecDocs.map((d: any) => d.deal_id)))
          }
        }
        const { data: agentData } = await supabase.from('agents').select('*').eq('brokerage_id', profileData.brokerage_id).order('last_name', { ascending: true })
        setAgents(agentData || [])
      }
      setLoading(false)
    }
    loadBrokerage()
  }, [])

  const handleToggleFlag = async (agentId: string, currentFlag: boolean) => {
    const agentName = agents.find(a => a.id === agentId)
    const name = agentName ? `${agentName.first_name} ${agentName.last_name}` : 'this agent'
    const confirmMsg = currentFlag
      ? `Remove the flag from ${name}? They will be eligible for commission advances again.`
      : `Flag ${name}? This will alert Firm Funds during underwriting and may delay or prevent their advances.`
    if (!confirm(confirmMsg)) return
    const { error } = await supabase.from('agents').update({ flagged_by_brokerage: !currentFlag }).eq('id', agentId)
    if (!error) {
      setAgents(agents.map(a => a.id === agentId ? { ...a, flagged_by_brokerage: !currentFlag } : a))
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleTradeRecordUpload = async (dealId: string, file: File) => {
    setUploadingDeal(dealId)
    setUploadMessage(null)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('dealId', dealId)
    formData.append('documentType', 'trade_record')
    const result = await uploadDocument(formData)
    if (result.success) {
      setUploadMessage({ type: 'success', text: `Trade record "${file.name}" uploaded successfully.` })
      setDealTradeRecords(prev => new Set([...prev, dealId]))
    } else {
      setUploadMessage({ type: 'error', text: result.error || 'Upload failed' })
    }
    setUploadingDeal(null)
  }

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <header style={{ background: colors.headerBgGradient }}>
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <div className="h-6 w-36 rounded-md animate-pulse" style={{ background: 'rgba(255,255,255,0.1)' }} />
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="h-8 w-56 rounded-lg mb-2 animate-pulse" style={{ background: colors.skeletonBase }} />
          <div className="h-4 w-40 rounded mb-8 animate-pulse" style={{ background: colors.skeletonHighlight }} />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
            {[1,2,3,4].map(i => (
              <div key={i} className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                <div className="h-3 w-24 rounded animate-pulse mb-3" style={{ background: colors.skeletonHighlight }} />
                <div className="h-9 w-20 rounded-lg animate-pulse" style={{ background: colors.skeletonBase }} />
              </div>
            ))}
          </div>
        </main>
      </div>
    )
  }

  const formatCurrency = (amount: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  const formatDate = (date: string) => new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })

  // Status badge styles imported from shared constants (getStatusBadgeStyle, formatStatusLabel)

  const totalReferralFees = deals.filter(d => ['funded', 'repaid', 'closed'].includes(d.status)).reduce((sum, d) => sum + d.brokerage_referral_fee, 0)
  const activeDeals = deals.filter(d => ['under_review', 'approved', 'funded'].includes(d.status)).length

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-3">
              <img src="/brand/logo-white.png" alt="Firm Funds" className="h-20 w-auto" />
              <div>
                <p className="text-sm font-medium tracking-wide text-white" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>
                  Brokerage Portal{brokerage ? ` — ${brokerage.name}` : ''}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm" style={{ color: '#C4B098' }}>{profile?.full_name}</span>
              <ThemeToggle />
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg transition-colors"
                style={{ color: '#888', border: '1px solid rgba(255,255,255,0.1)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#C4B098' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#888' }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold" style={{ color: colors.textPrimary }}>
            Welcome back, {profile?.full_name?.split(' ')[0]}
          </h2>
          <p className="text-sm mt-1" style={{ color: colors.textMuted }}>Manage your brokerage&apos;s commission advance activity.</p>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {[
            { label: 'Total Deals', value: deals.length.toString(), icon: FileText, accent: '#C4B098' },
            { label: 'Active Deals', value: activeDeals.toString(), icon: FileText, accent: '#3D5A99' },
            { label: 'Referral Fees Earned', value: formatCurrency(totalReferralFees), icon: DollarSign, accent: '#1A7A2E' },
            { label: 'Registered Agents', value: agents.length.toString(), icon: Users, accent: '#5B3D99' },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-xl p-6 transition-shadow hover:shadow-lg"
              style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>{card.label}</p>
                  <p className="text-3xl font-black mt-2" style={{ color: colors.textPrimary }}>{card.value}</p>
                </div>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${card.accent}12` }}>
                  <card.icon size={22} style={{ color: card.accent }} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Tabbed Content */}
        <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div className="flex" style={{ borderBottom: `1px solid ${colors.border}` }}>
            {(['deals', 'agents', 'referrals'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="px-6 py-3.5 text-sm font-semibold transition-colors"
                style={activeTab === tab
                  ? { color: colors.gold, borderBottom: `2px solid ${colors.gold}`, marginBottom: '-1px' }
                  : { color: colors.textMuted }
                }
                onMouseEnter={(e) => { if (activeTab !== tab) e.currentTarget.style.color = colors.textSecondary }}
                onMouseLeave={(e) => { if (activeTab !== tab) e.currentTarget.style.color = colors.textMuted }}
              >
                {tab === 'deals' ? `Deals (${deals.length})` : tab === 'agents' ? `Agents (${agents.length})` : 'Referral Fees'}
              </button>
            ))}
          </div>

          {/* Upload Status Message */}
          {uploadMessage && (
            <div
              className="mx-6 mt-4 p-3 rounded-lg text-sm font-medium"
              style={uploadMessage.type === 'success'
                ? { background: colors.successBg, border: `1px solid ${colors.successBorder}`, color: colors.successText }
                : { background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }
              }
            >
              {uploadMessage.text}
            </div>
          )}

          {/* Deals Tab */}
          {activeTab === 'deals' && (
            <>
              {deals.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <FileText className="mx-auto mb-4" size={40} style={{ color: colors.textFaint }} />
                  <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>No deals yet</p>
                  <p className="text-sm mt-1" style={{ color: colors.textMuted }}>Deals will appear here when your agents request commission advances.</p>
                </div>
              ) : (
                <div>
                  {(() => {
                    const totalPages = Math.max(1, Math.ceil(deals.length / DEALS_PER_PAGE))
                    const page = Math.min(dealsPage, totalPages)
                    const pagedDeals = deals.slice((page - 1) * DEALS_PER_PAGE, page * DEALS_PER_PAGE)
                    return pagedDeals
                  })().map((deal, i) => (
                    <div key={deal.id}>
                      <div
                        className="px-6 py-4 flex items-center justify-between cursor-pointer transition-colors"
                        style={{ borderBottom: i < deals.length - 1 && expandedDeal !== deal.id ? `1px solid ${colors.divider}` : 'none' }}
                        onClick={() => setExpandedDeal(expandedDeal === deal.id ? null : deal.id)}
                        onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div className="flex-1">
                          <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</p>
                          <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                            Agent: {deal.agent?.first_name} {deal.agent?.last_name} | Submitted {formatDate(deal.created_at)}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {!dealTradeRecords.has(deal.id) && ['under_review', 'approved'].includes(deal.status) && (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-md"
                              style={{ background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }}
                            >
                              <AlertTriangle size={11} />
                              Trade Record Needed
                            </span>
                          )}
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
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-5">
                            <div>
                              <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Deal Details</h4>
                              <div className="space-y-2.5 text-sm">
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Property</span><span className="font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</span></div>
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Closing Date</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.closing_date)}</span></div>
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Days Until Closing</span><span className="font-medium" style={{ color: colors.textPrimary }}>{deal.days_until_closing}</span></div>
                              </div>
                            </div>
                            <div>
                              <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Financial Summary</h4>
                              <div className="space-y-2.5 text-sm">
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Gross Commission</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.gross_commission)}</span></div>
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Brokerage Split</span><span className="font-medium" style={{ color: colors.textPrimary }}>{deal.brokerage_split_pct}%</span></div>
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Agent Advance</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.advance_amount)}</span></div>
                              </div>
                            </div>
                            <div>
                              <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Brokerage Info</h4>
                              <div className="space-y-2.5 text-sm">
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Referral Fee</span><span className="font-bold" style={{ color: colors.successText }}>{formatCurrency(deal.brokerage_referral_fee)}</span></div>
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Due to Firm Funds</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.amount_due_from_brokerage)}</span></div>
                              </div>
                              {/* Trade Record Upload */}
                              <div className="mt-4 pt-3" style={{ borderTop: `1px solid ${colors.border}` }}>
                                <label
                                  className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg cursor-pointer transition-colors"
                                  style={{ background: colors.infoBg, color: colors.infoText, border: `1px solid ${colors.infoBorder}` }}
                                  onMouseEnter={(e) => e.currentTarget.style.background = isDark ? '#0F1A3D' : '#E0EAFF'}
                                  onMouseLeave={(e) => e.currentTarget.style.background = colors.infoBg}
                                >
                                  {uploadingDeal === deal.id ? (
                                    <span>Uploading...</span>
                                  ) : (
                                    <>
                                      <Upload size={13} />
                                      Upload Trade Record
                                    </>
                                  )}
                                  <input
                                    type="file"
                                    className="hidden"
                                    accept=".pdf,.jpg,.jpeg,.png"
                                    disabled={uploadingDeal === deal.id}
                                    onChange={(e) => {
                                      const file = e.target.files?.[0]
                                      if (file) handleTradeRecordUpload(deal.id, file)
                                      e.target.value = ''
                                    }}
                                  />
                                </label>
                                <p className="text-xs mt-1.5" style={{ color: colors.textFaint }}>Upload a trade record / deal sheet for this deal</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {/* Pagination */}
                  {deals.length > DEALS_PER_PAGE && (() => {
                    const totalPages = Math.ceil(deals.length / DEALS_PER_PAGE)
                    const page = Math.min(dealsPage, totalPages)
                    return (
                      <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: `1px solid ${colors.border}` }}>
                        <p className="text-xs" style={{ color: colors.textMuted }}>
                          Showing {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, deals.length)} of {deals.length}
                        </p>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setDealsPage(p => Math.max(1, p - 1))}
                            disabled={page === 1}
                            className="p-2 rounded-lg transition-colors disabled:opacity-30"
                            style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                          >
                            <ChevronLeft size={14} />
                          </button>
                          <span className="text-xs font-semibold px-3" style={{ color: colors.textSecondary }}>{page} / {totalPages}</span>
                          <button
                            onClick={() => setDealsPage(p => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                            className="p-2 rounded-lg transition-colors disabled:opacity-30"
                            style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                          >
                            <ChevronRight size={14} />
                          </button>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}
            </>
          )}

          {/* Agents Tab */}
          {activeTab === 'agents' && (
            <>
              {agents.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <Users className="mx-auto mb-4" size={40} style={{ color: colors.textFaint }} />
                  <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>No agents registered</p>
                  <p className="text-sm mt-1" style={{ color: colors.textMuted }}>Agents will appear here once they are added to the system.</p>
                </div>
              ) : (
                <div>
                  {agents.map((agent, i) => (
                    <div
                      key={agent.id}
                      className="px-6 py-4 flex items-center justify-between transition-colors"
                      style={{ borderBottom: i < agents.length - 1 ? `1px solid ${colors.divider}` : 'none' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <div>
                        <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{agent.first_name} {agent.last_name}</p>
                        <p className="text-xs mt-1" style={{ color: colors.textMuted }}>{agent.email}{agent.phone ? ` | ${agent.phone}` : ''}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        {agent.flagged_by_brokerage ? (
                          <span
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md"
                            style={{ background: colors.errorBg, color: colors.errorText, border: `1px solid ${colors.errorBorder}` }}
                          >
                            <AlertTriangle size={12} />
                            Flagged
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md"
                            style={{ background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }}
                          >
                            <CheckCircle size={12} />
                            Good Standing
                          </span>
                        )}
                        <button
                          onClick={() => handleToggleFlag(agent.id, agent.flagged_by_brokerage)}
                          className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                          style={agent.flagged_by_brokerage
                            ? { color: colors.successText, border: `1px solid ${colors.successBorder}` }
                            : { color: colors.errorText, border: `1px solid ${colors.errorBorder}` }
                          }
                          onMouseEnter={(e) => e.currentTarget.style.background = agent.flagged_by_brokerage ? colors.successBg : colors.errorBg}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          {agent.flagged_by_brokerage ? 'Remove Flag' : 'Flag Agent'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Referral Fees Tab */}
          {activeTab === 'referrals' && (
            <>
              {(() => {
                const earnedDeals = deals.filter(d => ['funded', 'repaid', 'closed'].includes(d.status))
                const pendingDeals = deals.filter(d => ['under_review', 'approved'].includes(d.status))
                const pendingFees = pendingDeals.reduce((sum, d) => sum + d.brokerage_referral_fee, 0)
                return (
                  <div className="p-6">
                    {/* Summary Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                      <div className="rounded-xl p-5" style={{ background: colors.successBg, border: `1px solid ${colors.successBorder}` }}>
                        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.successText, opacity: 0.7 }}>Total Earned</p>
                        <p className="text-2xl font-black mt-1" style={{ color: colors.successText }}>{formatCurrency(totalReferralFees)}</p>
                        <p className="text-xs mt-1" style={{ color: colors.successText, opacity: 0.6 }}>{earnedDeals.length} funded deal{earnedDeals.length !== 1 ? 's' : ''}</p>
                      </div>
                      <div className="rounded-xl p-5" style={{ background: colors.warningBg, border: `1px solid ${colors.warningBorder}` }}>
                        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.warningText, opacity: 0.7 }}>Pending (Not Yet Funded)</p>
                        <p className="text-2xl font-black mt-1" style={{ color: colors.warningText }}>{formatCurrency(pendingFees)}</p>
                        <p className="text-xs mt-1" style={{ color: colors.warningText, opacity: 0.6 }}>{pendingDeals.length} deal{pendingDeals.length !== 1 ? 's' : ''} in progress</p>
                      </div>
                    </div>

                    {/* Fee Breakdown Table */}
                    {earnedDeals.length === 0 && pendingDeals.length === 0 ? (
                      <div className="text-center py-8">
                        <DollarSign className="mx-auto mb-3" size={32} style={{ color: colors.textFaint }} />
                        <p className="text-sm" style={{ color: colors.textMuted }}>No referral fees yet. Fees are earned when deals are funded.</p>
                      </div>
                    ) : (
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Fee Breakdown by Deal</h4>
                        <div className="rounded-lg overflow-x-auto" style={{ border: `1px solid ${colors.border}` }}>
                          <table className="w-full min-w-[600px]">
                            <thead>
                              <tr style={{ background: colors.tableHeaderBg }}>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Property</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Agent</th>
                                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Status</th>
                                <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Discount Fee</th>
                                <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Your Referral Fee</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...earnedDeals, ...pendingDeals].map((deal, i) => {
                                const isEarned = ['funded', 'repaid', 'closed'].includes(deal.status)
                                return (
                                  <tr key={deal.id} style={{ borderBottom: `1px solid ${colors.divider}` }}>
                                    <td className="px-4 py-3 text-sm font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</td>
                                    <td className="px-4 py-3 text-sm" style={{ color: colors.textSecondary }}>{deal.agent?.first_name} {deal.agent?.last_name}</td>
                                    <td className="px-4 py-3">
                                      <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-md" style={getStatusBadgeStyle(deal.status)}>
                                        {formatStatusLabel(deal.status)}
                                      </span>
                                    </td>
                                    <td className="px-4 py-3 text-sm text-right" style={{ color: colors.textSecondary }}>{formatCurrency(deal.discount_fee)}</td>
                                    <td className="px-4 py-3 text-sm text-right font-bold" style={{ color: isEarned ? colors.successText : colors.warningText }}>
                                      {formatCurrency(deal.brokerage_referral_fee)}
                                      {!isEarned && <span className="text-xs font-normal ml-1" style={{ color: colors.textMuted }}>(pending)</span>}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
