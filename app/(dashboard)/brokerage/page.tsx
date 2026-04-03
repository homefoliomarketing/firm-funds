'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, Users, DollarSign, ChevronDown, ChevronUp, AlertTriangle,
  CheckCircle, Upload, ChevronLeft, ChevronRight, Download, Calendar,
  TrendingUp, BarChart3,
} from 'lucide-react'
import { uploadDocument } from '@/lib/actions/deal-actions'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import { useTheme } from '@/lib/theme'
import SignOutModal from '@/components/SignOutModal'

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
  const [dealTradeRecords, setDealTradeRecords] = useState<Set<string>>(new Set())
  const [dealsPage, setDealsPage] = useState(1)
  const [referralMonth, setReferralMonth] = useState<string>('all')
  const [referralFilter, setReferralFilter] = useState<'all' | 'earned' | 'pending'>('all')
  const [downloadingPdf, setDownloadingPdf] = useState(false)
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

  const handleDownloadPdf = async () => {
    setDownloadingPdf(true)
    try {
      const params = new URLSearchParams()
      if (referralMonth === 'all') {
        params.set('all', 'true')
      } else {
        params.set('month', referralMonth)
      }
      const res = await fetch(`/api/reports/referral-fees?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to generate report')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.headers.get('Content-Disposition')?.split('filename=')[1]?.replace(/"/g, '') || 'referral_fees.pdf'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      alert('Failed to download report. Please try again.')
    }
    setDownloadingPdf(false)
  }

  // =========================================================================
  // Computed values
  // =========================================================================

  // Sort deals by workflow priority
  const sortedDeals = useMemo(() => {
    const sorted = [...deals]
    sorted.sort((a, b) => {
      // Priority 1: Needing trade records (under_review/approved WITHOUT trade record)
      const aNeedsRecord = ['under_review', 'approved'].includes(a.status) && !dealTradeRecords.has(a.id)
      const bNeedsRecord = ['under_review', 'approved'].includes(b.status) && !dealTradeRecords.has(b.id)
      if (aNeedsRecord && !bNeedsRecord) return -1
      if (!aNeedsRecord && bNeedsRecord) return 1

      // Priority 2: under_review/approved WITH trade records
      const aInProgress = ['under_review', 'approved'].includes(a.status)
      const bInProgress = ['under_review', 'approved'].includes(b.status)
      if (aInProgress && !bInProgress) return -1
      if (!aInProgress && bInProgress) return 1

      // Priority 3: Funded deals
      const aFunded = a.status === 'funded'
      const bFunded = b.status === 'funded'
      if (aFunded && !bFunded) return -1
      if (!aFunded && bFunded) return 1

      // Priority 4: Repaid/closed/denied/cancelled (bottom)
      // Both are in same priority, sort by created_at descending
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
    return sorted
  }, [deals, dealTradeRecords])

  const earnedDeals = useMemo(() =>
    deals.filter(d => ['funded', 'repaid', 'closed'].includes(d.status)), [deals])
  const pendingDeals = useMemo(() =>
    deals.filter(d => ['under_review', 'approved'].includes(d.status)), [deals])
  const totalReferralFees = useMemo(() =>
    earnedDeals.reduce((sum, d) => sum + d.brokerage_referral_fee, 0), [earnedDeals])
  const pendingReferralFees = useMemo(() =>
    pendingDeals.reduce((sum, d) => sum + d.brokerage_referral_fee, 0), [pendingDeals])

  // Available months for filter (from deal closing dates)
  const availableMonths = useMemo(() => {
    const months = new Set<string>()
    deals.forEach(d => {
      if (['funded', 'repaid', 'closed', 'under_review', 'approved'].includes(d.status) && d.closing_date) {
        months.add(d.closing_date.slice(0, 7)) // YYYY-MM
      }
    })
    return Array.from(months).sort().reverse()
  }, [deals])

  // Filtered referral deals by month and earned/pending status
  const filteredReferralDeals = useMemo(() => {
    let allReferral = [...earnedDeals, ...pendingDeals]

    // Apply earned/pending filter
    if (referralFilter === 'earned') {
      allReferral = allReferral.filter(d => ['funded', 'repaid', 'closed'].includes(d.status))
    } else if (referralFilter === 'pending') {
      allReferral = allReferral.filter(d => ['under_review', 'approved'].includes(d.status))
    }

    // Apply month filter
    if (referralMonth === 'all') return allReferral
    return allReferral.filter(d => d.closing_date?.startsWith(referralMonth))
  }, [earnedDeals, pendingDeals, referralMonth, referralFilter])

  // Monthly summary for accounting breakdown
  const monthlySummary = useMemo(() => {
    const map = new Map<string, { earned: number; pending: number; dealCount: number; pendingCount: number }>()
    earnedDeals.forEach(d => {
      const month = d.closing_date?.slice(0, 7) || 'Unknown'
      const entry = map.get(month) || { earned: 0, pending: 0, dealCount: 0, pendingCount: 0 }
      entry.earned += d.brokerage_referral_fee
      entry.dealCount += 1
      map.set(month, entry)
    })
    pendingDeals.forEach(d => {
      const month = d.closing_date?.slice(0, 7) || 'Unknown'
      const entry = map.get(month) || { earned: 0, pending: 0, dealCount: 0, pendingCount: 0 }
      entry.pending += d.brokerage_referral_fee
      entry.pendingCount += 1
      map.set(month, entry)
    })
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, data]) => ({ month, ...data }))
  }, [earnedDeals, pendingDeals])

  // Average referral fee per deal
  const avgFeePerDeal = earnedDeals.length > 0 ? totalReferralFees / earnedDeals.length : 0

  // =========================================================================
  // Format helpers
  // =========================================================================

  const formatCurrency = (amount: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  const formatDate = (date: string) => new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  const formatMonthLabel = (ym: string) => {
    const [year, month] = ym.split('-').map(Number)
    return new Date(year, month - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
  }

  // =========================================================================
  // Loading state
  // =========================================================================

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <header style={{ background: colors.headerBgGradient }}>
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <div className="h-6 w-36 rounded-md animate-pulse" style={{ background: 'rgba(255,255,255,0.1)' }} />
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="h-6 w-48 rounded-lg mb-2 animate-pulse" style={{ background: colors.skeletonBase }} />
          <div className="h-3 w-36 rounded mb-4 animate-pulse" style={{ background: colors.skeletonHighlight }} />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            {[1,2,3,4].map(i => (
              <div key={i} className="rounded-lg px-4 py-3" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                <div className="h-3 w-20 rounded animate-pulse mb-2" style={{ background: colors.skeletonHighlight }} />
                <div className="h-7 w-16 rounded animate-pulse" style={{ background: colors.skeletonBase }} />
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
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-3">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-10 sm:h-12 w-auto" />
              <div className="w-px h-8 hidden sm:block" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <p className="text-xs sm:text-sm font-medium tracking-wide text-white hidden sm:block">
                Brokerage Portal{brokerage ? ` — ${brokerage.name}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs hidden sm:inline" style={{ color: '#5FA873' }}>{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        {/* Welcome */}
        <div className="mb-4">
          <h2 className="text-lg font-bold" style={{ color: colors.textPrimary }}>
            Welcome back, {profile?.full_name?.split(' ')[0]}
          </h2>
          <p className="text-xs mt-0.5" style={{ color: colors.textMuted }}>Manage your brokerage&apos;s commission advance activity.</p>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          {[
            {
              label: 'Deals Submitted',
              value: deals.length.toString(),
              subtitle: `${pendingDeals.length} in progress`,
              icon: FileText,
              accent: '#5FA873',
              onClick: () => setActiveTab('deals'),
            },
            {
              label: 'Referral Fees Earned',
              value: formatCurrency(totalReferralFees),
              subtitle: `${earnedDeals.length} funded deal${earnedDeals.length !== 1 ? 's' : ''}`,
              icon: DollarSign,
              accent: '#1A7A2E',
              onClick: () => { setActiveTab('referrals'); setReferralFilter('earned') },
            },
            {
              label: 'Pending Fees',
              value: formatCurrency(pendingReferralFees),
              subtitle: `${pendingDeals.length} deal${pendingDeals.length !== 1 ? 's' : ''} awaiting funding`,
              icon: TrendingUp,
              accent: '#92700C',
              onClick: () => { setActiveTab('referrals'); setReferralFilter('pending') },
            },
            {
              label: 'Avg. Fee per Deal',
              value: earnedDeals.length > 0 ? formatCurrency(avgFeePerDeal) : '—',
              subtitle: `${agents.filter(a => a.status === 'active').length} active agent${agents.filter(a => a.status === 'active').length !== 1 ? 's' : ''}`,
              icon: BarChart3,
              accent: '#5FA873',
              onClick: () => { setActiveTab('referrals'); setReferralFilter('all') },
            },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-lg px-4 py-3 transition-shadow hover:shadow-lg cursor-pointer"
              style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}
              onClick={card.onClick}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted }}>{card.label}</p>
                  <p className="text-xl font-black mt-1" style={{ color: colors.textPrimary }}>{card.value}</p>
                  <p className="text-xs" style={{ color: colors.textFaint }}>{card.subtitle}</p>
                </div>
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${card.accent}12` }}>
                  <card.icon size={18} style={{ color: card.accent }} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Tabbed Content */}
        <div className="rounded-lg overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div className="flex overflow-x-auto" style={{ borderBottom: `1px solid ${colors.border}` }}>
            {(['deals', 'agents', 'referrals'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="px-4 sm:px-6 py-3.5 text-sm font-semibold transition-colors whitespace-nowrap"
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
              className="mx-4 sm:mx-6 mt-4 p-3 rounded-lg text-sm font-medium"
              style={uploadMessage.type === 'success'
                ? { background: colors.successBg, border: `1px solid ${colors.successBorder}`, color: colors.successText }
                : { background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }
              }
            >
              {uploadMessage.text}
            </div>
          )}

          {/* ================================================================ */}
          {/* DEALS TAB                                                        */}
          {/* ================================================================ */}
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
                    const totalPages = Math.max(1, Math.ceil(sortedDeals.length / DEALS_PER_PAGE))
                    const page = Math.min(dealsPage, totalPages)
                    const pagedDeals = sortedDeals.slice((page - 1) * DEALS_PER_PAGE, page * DEALS_PER_PAGE)
                    return pagedDeals
                  })().map((deal, i) => (
                    <div key={deal.id}>
                      <div
                        className="px-4 sm:px-6 py-4 flex items-center justify-between cursor-pointer transition-colors"
                        style={{ borderBottom: i < sortedDeals.length - 1 && expandedDeal !== deal.id ? `1px solid ${colors.divider}` : 'none' }}
                        onClick={() => setExpandedDeal(expandedDeal === deal.id ? null : deal.id)}
                        onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{deal.property_address}</p>
                          <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                            Agent: {deal.agent?.first_name} {deal.agent?.last_name} | Submitted {formatDate(deal.created_at)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 ml-3">
                          {!dealTradeRecords.has(deal.id) && ['under_review', 'approved'].includes(deal.status) && (
                            <span
                              className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-md"
                              style={{ background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }}
                            >
                              <AlertTriangle size={11} />
                              Trade Record Needed
                            </span>
                          )}
                          <span
                            className="inline-flex px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md"
                            style={getStatusBadgeStyle(deal.status)}
                          >
                            {formatStatusLabel(deal.status)}
                          </span>
                          <p className="text-sm font-bold w-24 sm:w-28 text-right" style={{ color: colors.successText }}>{formatCurrency(deal.advance_amount)}</p>
                          {expandedDeal === deal.id
                            ? <ChevronUp size={16} style={{ color: colors.textFaint }} />
                            : <ChevronDown size={16} style={{ color: colors.textFaint }} />
                          }
                        </div>
                      </div>

                      {expandedDeal === deal.id && (
                        <div className="px-4 pb-4" style={{ background: colors.tableHeaderBg, borderBottom: `1px solid ${colors.divider}` }}>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3">
                            <div>
                              <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Deal Details</h4>
                              <div className="space-y-2.5 text-sm">
                                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Property</span><span className="font-medium text-right" style={{ color: colors.textPrimary }}>{deal.property_address}</span></div>
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
                  {sortedDeals.length > DEALS_PER_PAGE && (() => {
                    const totalPages = Math.ceil(sortedDeals.length / DEALS_PER_PAGE)
                    const page = Math.min(dealsPage, totalPages)
                    return (
                      <div className="px-4 sm:px-6 py-4 flex items-center justify-between" style={{ borderTop: `1px solid ${colors.border}` }}>
                        <p className="text-xs" style={{ color: colors.textMuted }}>
                          Showing {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, sortedDeals.length)} of {sortedDeals.length}
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

          {/* ================================================================ */}
          {/* AGENTS TAB                                                       */}
          {/* ================================================================ */}
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
                      className="px-4 sm:px-6 py-4 flex items-center justify-between transition-colors"
                      style={{ borderBottom: i < agents.length - 1 ? `1px solid ${colors.divider}` : 'none' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{agent.first_name} {agent.last_name}</p>
                        <p className="text-xs mt-1 truncate" style={{ color: colors.textMuted }}>{agent.email}{agent.phone ? ` | ${agent.phone}` : ''}</p>
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 ml-3">
                        {agent.flagged_by_brokerage ? (
                          <span
                            className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md"
                            style={{ background: colors.errorBg, color: colors.errorText, border: `1px solid ${colors.errorBorder}` }}
                          >
                            <AlertTriangle size={12} />
                            <span className="hidden sm:inline">Flagged</span>
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md"
                            style={{ background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }}
                          >
                            <CheckCircle size={12} />
                            <span className="hidden sm:inline">Good Standing</span>
                          </span>
                        )}
                        <button
                          onClick={() => handleToggleFlag(agent.id, agent.flagged_by_brokerage)}
                          className="text-xs px-2 sm:px-3 py-1.5 rounded-lg font-medium transition-colors"
                          style={agent.flagged_by_brokerage
                            ? { color: colors.successText, border: `1px solid ${colors.successBorder}` }
                            : { color: colors.errorText, border: `1px solid ${colors.errorBorder}` }
                          }
                          onMouseEnter={(e) => e.currentTarget.style.background = agent.flagged_by_brokerage ? colors.successBg : colors.errorBg}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          {agent.flagged_by_brokerage ? 'Remove Flag' : 'Flag'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ================================================================ */}
          {/* REFERRAL FEES TAB                                                */}
          {/* ================================================================ */}
          {activeTab === 'referrals' && (
            <div className="p-4">
              {/* Summary Cards - Clickable */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div
                  className="rounded-lg px-4 py-3 cursor-pointer transition-opacity hover:opacity-80"
                  style={{ background: colors.successBg, border: `1px solid ${colors.successBorder}` }}
                  onClick={() => setReferralFilter(referralFilter === 'earned' ? 'all' : 'earned')}
                >
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.successText, opacity: 0.7 }}>Total Earned</p>
                  <p className="text-xl font-black mt-1" style={{ color: colors.successText }}>{formatCurrency(totalReferralFees)}</p>
                  <p className="text-xs" style={{ color: colors.successText, opacity: 0.6 }}>{earnedDeals.length} funded deal{earnedDeals.length !== 1 ? 's' : ''}</p>
                  {referralFilter === 'earned' && <p className="text-xs mt-1 font-semibold" style={{ color: colors.successText }}>Show All</p>}
                </div>
                <div
                  className="rounded-lg px-4 py-3 cursor-pointer transition-opacity hover:opacity-80"
                  style={{ background: colors.warningBg, border: `1px solid ${colors.warningBorder}` }}
                  onClick={() => setReferralFilter(referralFilter === 'pending' ? 'all' : 'pending')}
                >
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.warningText, opacity: 0.7 }}>Pending</p>
                  <p className="text-xl font-black mt-1" style={{ color: colors.warningText }}>{formatCurrency(pendingReferralFees)}</p>
                  <p className="text-xs" style={{ color: colors.warningText, opacity: 0.6 }}>{pendingDeals.length} deal{pendingDeals.length !== 1 ? 's' : ''} in progress</p>
                  {referralFilter === 'pending' && <p className="text-xs mt-1 font-semibold" style={{ color: colors.warningText }}>Show All</p>}
                </div>
              </div>

              {/* Fee Breakdown with Filter + PDF Download */}
              {earnedDeals.length === 0 && pendingDeals.length === 0 ? (
                <div className="text-center py-8">
                  <DollarSign className="mx-auto mb-3" size={32} style={{ color: colors.textFaint }} />
                  <p className="text-sm" style={{ color: colors.textMuted }}>No referral fees yet. Fees are earned when deals are funded.</p>
                </div>
              ) : (
                <div>
                  {/* Filter bar + Download */}
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Fee Breakdown by Deal</h4>
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Month filter */}
                      <div className="flex items-center gap-2">
                        <Calendar size={14} style={{ color: colors.textMuted }} />
                        <select
                          value={referralMonth}
                          onChange={(e) => setReferralMonth(e.target.value)}
                          className="text-xs rounded-lg px-3 py-1.5 font-medium"
                          style={{
                            background: colors.inputBg,
                            border: `1px solid ${colors.inputBorder}`,
                            color: colors.inputText,
                          }}
                        >
                          <option value="all">All Time</option>
                          {availableMonths.map(m => (
                            <option key={m} value={m}>{formatMonthLabel(m)}</option>
                          ))}
                        </select>
                      </div>
                      {/* PDF Download */}
                      <button
                        onClick={handleDownloadPdf}
                        disabled={downloadingPdf}
                        className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                        style={{
                          background: colors.gold,
                          color: '#fff',
                          opacity: downloadingPdf ? 0.6 : 1,
                        }}
                        onMouseEnter={(e) => { if (!downloadingPdf) e.currentTarget.style.background = colors.goldDark }}
                        onMouseLeave={(e) => e.currentTarget.style.background = colors.gold}
                      >
                        <Download size={13} />
                        {downloadingPdf ? 'Generating...' : 'Download PDF Report'}
                      </button>
                    </div>
                  </div>

                  {/* Table */}
                  <div className="rounded-lg overflow-x-auto" style={{ border: `1px solid ${colors.border}` }}>
                    <table className="w-full min-w-[600px]">
                      <thead>
                        <tr style={{ background: colors.tableHeaderBg }}>
                          <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Property</th>
                          <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Agent</th>
                          <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Closing Date</th>
                          <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Status</th>
                          <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Referral Fee</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredReferralDeals.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-sm" style={{ color: colors.textMuted }}>
                              No deals found for the selected period.
                            </td>
                          </tr>
                        ) : (
                          <>
                            {filteredReferralDeals.map((deal) => {
                              const isEarned = ['funded', 'repaid', 'closed'].includes(deal.status)
                              return (
                                <tr key={deal.id} style={{ borderBottom: `1px solid ${colors.divider}` }}>
                                  <td className="px-4 py-3 text-sm font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</td>
                                  <td className="px-4 py-3 text-sm" style={{ color: colors.textSecondary }}>{deal.agent?.first_name} {deal.agent?.last_name}</td>
                                  <td className="px-4 py-3 text-sm" style={{ color: colors.textSecondary }}>{formatDate(deal.closing_date)}</td>
                                  <td className="px-4 py-3">
                                    <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-md" style={getStatusBadgeStyle(deal.status)}>
                                      {formatStatusLabel(deal.status)}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-sm text-right font-bold" style={{ color: isEarned ? colors.successText : colors.warningText }}>
                                    {formatCurrency(deal.brokerage_referral_fee)}
                                    {!isEarned && <span className="text-xs font-normal ml-1" style={{ color: colors.textMuted }}>(pending)</span>}
                                  </td>
                                </tr>
                              )
                            })}
                            {/* Totals row */}
                            <tr style={{ background: colors.tableHeaderBg, borderTop: `2px solid ${colors.border}` }}>
                              <td colSpan={4} className="px-4 py-3 text-sm font-bold" style={{ color: colors.textPrimary }}>
                                Total ({filteredReferralDeals.length} deal{filteredReferralDeals.length !== 1 ? 's' : ''})
                              </td>
                              <td className="px-4 py-3 text-sm text-right font-bold" style={{ color: colors.successText }}>
                                {formatCurrency(filteredReferralDeals.reduce((s, d) => s + d.brokerage_referral_fee, 0))}
                              </td>
                            </tr>
                          </>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Accounting note */}
                  <p className="text-xs mt-3" style={{ color: colors.textFaint }}>
                    Referral fees are earned when deals reach &quot;Funded&quot; status. Download the PDF report for your accounting records.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
