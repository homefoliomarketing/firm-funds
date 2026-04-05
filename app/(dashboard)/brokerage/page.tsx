'use client'

import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, Users, DollarSign, ChevronDown, ChevronUp, AlertTriangle,
  CheckCircle, Upload, ChevronLeft, ChevronRight, Download, Calendar,
  TrendingUp, BarChart3, Shield, CreditCard, XCircle, Clock, Send,
  MessageSquare, Inbox,
} from 'lucide-react'
import { uploadDocument } from '@/lib/actions/deal-actions'
import { getBrokerageInbox, getDealMessages, sendBrokerageMessage } from '@/lib/actions/notification-actions'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import { useTheme } from '@/lib/theme'
import { formatCurrency, formatDate } from '@/lib/formatting'
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
  denial_reason: string | null
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
  kyc_status: string | null
  banking_verified: boolean
}

export default function BrokerageDashboard() {
  const [profile, setProfile] = useState<any>(null)
  const [brokerage, setBrokerage] = useState<any>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [expandedDeal, setExpandedDeal] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'deals' | 'agents' | 'referrals' | 'payments' | 'messages'>('deals')
  const [loading, setLoading] = useState(true)
  const [uploadingDeal, setUploadingDeal] = useState<string | null>(null)
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [dealTradeRecords, setDealTradeRecords] = useState<Set<string>>(new Set())
  const [dealsPage, setDealsPage] = useState(1)
  const [referralMonth, setReferralMonth] = useState<string>('all')
  const [referralFilter, setReferralFilter] = useState<'all' | 'earned' | 'pending'>('all')
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [downloadingCsv, setDownloadingCsv] = useState(false)
  const [showMonthlyChart, setShowMonthlyChart] = useState(true)
  // Messaging state
  const [brokerageInbox, setBrokerageInbox] = useState<any[]>([])
  const [selectedMsgDealId, setSelectedMsgDealId] = useState<string | null>(null)
  const [dealMessages, setDealMessages] = useState<any[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [msgText, setMsgText] = useState('')
  const [msgSending, setMsgSending] = useState(false)
  const msgEndRef = useRef<HTMLDivElement>(null)
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

  const handleDownloadCsv = () => {
    setDownloadingCsv(true)
    try {
      const rows = filteredReferralDeals.map(d => ({
        Property: d.property_address,
        Agent: `${d.agent?.first_name || ''} ${d.agent?.last_name || ''}`.trim(),
        'Closing Date': d.closing_date || '',
        Status: d.status,
        'Referral Fee': d.brokerage_referral_fee.toFixed(2),
      }))
      const headers = Object.keys(rows[0] || { Property: '', Agent: '', 'Closing Date': '', Status: '', 'Referral Fee': '' })
      const csvContent = [
        headers.join(','),
        ...rows.map(r => headers.map(h => `"${(r as any)[h]}"`).join(',')),
      ].join('\n')
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const monthLabel = referralMonth === 'all' ? 'all_time' : referralMonth
      a.download = `referral_fees_${monthLabel}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      alert('Failed to generate CSV. Please try again.')
    }
    setDownloadingCsv(false)
  }

  // =========================================================================
  // Computed values
  // =========================================================================

  // Sort deals by workflow priority
  const sortedDeals = useMemo(() => {
    const getPriority = (deal: Deal) => {
      if (deal.status === 'under_review' && !dealTradeRecords.has(deal.id)) return 0 // Needs trade record — most urgent
      if (deal.status === 'under_review') return 1 // Under review, has trade record
      if (deal.status === 'approved') return 2
      if (deal.status === 'funded') return 3
      return 4 // completed, denied, cancelled
    }
    const sorted = [...deals]
    sorted.sort((a, b) => {
      const pa = getPriority(a)
      const pb = getPriority(b)
      if (pa !== pb) return pa - pb
      // Same priority — newest first
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
    return sorted
  }, [deals, dealTradeRecords])

  const earnedDeals = useMemo(() =>
    deals.filter(d => ['funded', 'completed'].includes(d.status)), [deals])
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
      if (['funded', 'completed', 'under_review', 'approved'].includes(d.status) && d.closing_date) {
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
      allReferral = allReferral.filter(d => ['funded', 'completed'].includes(d.status))
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

  // formatCurrency, formatDate imported from @/lib/formatting
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
            {(['deals', 'agents', 'referrals', 'payments', 'messages'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setActiveTab(tab)
                  if (tab === 'messages' && brokerageInbox.length === 0 && profile?.brokerage_id) {
                    getBrokerageInbox(profile.brokerage_id).then(r => {
                      if (r.success && r.data) setBrokerageInbox(r.data.inbox)
                    })
                  }
                }}
                className="px-4 sm:px-6 py-3.5 text-sm font-semibold transition-colors whitespace-nowrap"
                style={activeTab === tab
                  ? { color: colors.gold, borderBottom: `2px solid ${colors.gold}`, marginBottom: '-1px' }
                  : { color: colors.textMuted }
                }
                onMouseEnter={(e) => { if (activeTab !== tab) e.currentTarget.style.color = colors.textSecondary }}
                onMouseLeave={(e) => { if (activeTab !== tab) e.currentTarget.style.color = colors.textMuted }}
              >
                {tab === 'deals' ? `Deals (${deals.length})` : tab === 'agents' ? `Agents (${agents.length})` : tab === 'referrals' ? 'Referral Fees' : tab === 'payments' ? 'Payment Status' : 'Messages'}
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
                              {/* Denial Reason (if denied) */}
                              {deal.status === 'denied' && deal.denial_reason && (
                                <div className="mt-3 rounded-lg p-3" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}` }}>
                                  <p className="text-xs font-bold" style={{ color: colors.errorText }}>Denial Reason</p>
                                  <p className="text-xs mt-1" style={{ color: colors.errorText, opacity: 0.9 }}>{deal.denial_reason}</p>
                                </div>
                              )}
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
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className="text-xs truncate" style={{ color: colors.textMuted }}>{agent.email}{agent.phone ? ` | ${agent.phone}` : ''}</span>
                          {/* KYC Status Badge */}
                          {agent.kyc_status === 'verified' ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded"
                              style={{ background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }}>
                              <Shield size={9} /> KYC
                            </span>
                          ) : agent.kyc_status === 'submitted' ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded"
                              style={{ background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }}>
                              <Clock size={9} /> KYC Pending
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded"
                              style={{ background: colors.errorBg, color: colors.errorText, border: `1px solid ${colors.errorBorder}` }}>
                              <XCircle size={9} /> No KYC
                            </span>
                          )}
                          {/* Banking Status Badge */}
                          {agent.banking_verified ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded"
                              style={{ background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }}>
                              <CreditCard size={9} /> Banking
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded"
                              style={{ background: '#1A2240', color: '#6B8AC0', border: '1px solid #2D3A5C' }}>
                              <CreditCard size={9} /> No Banking
                            </span>
                          )}
                        </div>
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
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
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
                <div className="rounded-lg px-4 py-3" style={{ background: colors.infoBg, border: `1px solid ${colors.infoBorder}` }}>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.infoText, opacity: 0.7 }}>Avg Fee / Deal</p>
                  <p className="text-xl font-black mt-1" style={{ color: colors.infoText }}>{formatCurrency(avgFeePerDeal)}</p>
                  <p className="text-xs" style={{ color: colors.infoText, opacity: 0.6 }}>across funded deals</p>
                </div>
                <div className="rounded-lg px-4 py-3" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.textMuted, opacity: 0.7 }}>Combined Total</p>
                  <p className="text-xl font-black mt-1" style={{ color: colors.gold }}>{formatCurrency(totalReferralFees + pendingReferralFees)}</p>
                  <p className="text-xs" style={{ color: colors.textMuted, opacity: 0.6 }}>earned + pending</p>
                </div>
              </div>

              {/* Monthly Trend Chart */}
              {monthlySummary.length > 1 && (
                <div className="rounded-lg p-4 mb-4" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <BarChart3 size={16} style={{ color: colors.gold }} />
                      <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Monthly Trend</h4>
                    </div>
                    <button
                      className="text-xs px-2 py-1 rounded-md"
                      style={{ color: colors.textMuted, background: colors.inputBg }}
                      onClick={() => setShowMonthlyChart(!showMonthlyChart)}
                    >
                      {showMonthlyChart ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {showMonthlyChart && (() => {
                    const chartData = [...monthlySummary].reverse().slice(-12) // last 12 months, chronological
                    const maxVal = Math.max(...chartData.map(m => m.earned + m.pending), 1)
                    return (
                      <div>
                        {/* Legend */}
                        <div className="flex items-center gap-4 mb-3">
                          <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-sm" style={{ background: colors.successText }} />
                            <span className="text-xs" style={{ color: colors.textMuted }}>Earned</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-sm" style={{ background: colors.warningText }} />
                            <span className="text-xs" style={{ color: colors.textMuted }}>Pending</span>
                          </div>
                        </div>
                        {/* Bar chart */}
                        <div className="flex items-end gap-2" style={{ height: '160px' }}>
                          {chartData.map((m) => {
                            const earnedH = maxVal > 0 ? (m.earned / maxVal) * 140 : 0
                            const pendingH = maxVal > 0 ? (m.pending / maxVal) * 140 : 0
                            const [, monthNum] = m.month.split('-')
                            const monthLabel = new Date(2024, parseInt(monthNum) - 1, 1).toLocaleDateString('en-CA', { month: 'short' })
                            return (
                              <div key={m.month} className="flex-1 flex flex-col items-center gap-0.5" title={`${formatMonthLabel(m.month)}: Earned ${formatCurrency(m.earned)}, Pending ${formatCurrency(m.pending)}`}>
                                <div className="w-full flex flex-col items-center justify-end" style={{ height: '140px' }}>
                                  {pendingH > 0 && (
                                    <div className="w-full max-w-[32px] rounded-t-sm" style={{ height: `${pendingH}px`, background: colors.warningText, opacity: 0.7 }} />
                                  )}
                                  {earnedH > 0 && (
                                    <div className="w-full max-w-[32px]" style={{ height: `${earnedH}px`, background: colors.successText, borderRadius: pendingH > 0 ? '0' : '4px 4px 0 0' }} />
                                  )}
                                </div>
                                <span className="text-[10px] font-medium" style={{ color: colors.textMuted }}>{monthLabel}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}

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
                      {/* CSV Export */}
                      <button
                        onClick={handleDownloadCsv}
                        disabled={downloadingCsv || filteredReferralDeals.length === 0}
                        className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                        style={{
                          background: colors.cardBg,
                          color: colors.textSecondary,
                          border: `1px solid ${colors.border}`,
                          opacity: downloadingCsv || filteredReferralDeals.length === 0 ? 0.5 : 1,
                        }}
                      >
                        <Download size={13} />
                        {downloadingCsv ? 'Exporting...' : 'Export CSV'}
                      </button>
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
                        {downloadingPdf ? 'Generating...' : 'Download PDF'}
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
                              const isEarned = ['funded', 'completed'].includes(deal.status)
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

                  {/* Monthly Summary Table */}
                  {monthlySummary.length > 0 && (
                    <div className="mt-4">
                      <h4 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: colors.gold }}>
                        <TrendingUp size={13} className="inline mr-1" style={{ verticalAlign: 'text-bottom' }} />
                        Monthly Summary
                      </h4>
                      <div className="rounded-lg overflow-x-auto" style={{ border: `1px solid ${colors.border}` }}>
                        <table className="w-full">
                          <thead>
                            <tr style={{ background: colors.tableHeaderBg }}>
                              <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Month</th>
                              <th className="px-4 py-2 text-center text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Deals</th>
                              <th className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.successText }}>Earned</th>
                              <th className="px-4 py-2 text-center text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Pending</th>
                              <th className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.warningText }}>Pending $</th>
                              <th className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {monthlySummary.map((m) => (
                              <tr key={m.month} style={{ borderBottom: `1px solid ${colors.divider}` }}>
                                <td className="px-4 py-2 text-sm font-medium" style={{ color: colors.textPrimary }}>{formatMonthLabel(m.month)}</td>
                                <td className="px-4 py-2 text-sm text-center" style={{ color: colors.textSecondary }}>{m.dealCount}</td>
                                <td className="px-4 py-2 text-sm text-right font-semibold" style={{ color: colors.successText }}>{formatCurrency(m.earned)}</td>
                                <td className="px-4 py-2 text-sm text-center" style={{ color: colors.textSecondary }}>{m.pendingCount}</td>
                                <td className="px-4 py-2 text-sm text-right font-semibold" style={{ color: colors.warningText }}>{formatCurrency(m.pending)}</td>
                                <td className="px-4 py-2 text-sm text-right font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(m.earned + m.pending)}</td>
                              </tr>
                            ))}
                            {/* Summary totals */}
                            <tr style={{ background: colors.tableHeaderBg, borderTop: `2px solid ${colors.border}` }}>
                              <td className="px-4 py-2 text-sm font-bold" style={{ color: colors.textPrimary }}>Total</td>
                              <td className="px-4 py-2 text-sm text-center font-bold" style={{ color: colors.textPrimary }}>{monthlySummary.reduce((s, m) => s + m.dealCount, 0)}</td>
                              <td className="px-4 py-2 text-sm text-right font-bold" style={{ color: colors.successText }}>{formatCurrency(monthlySummary.reduce((s, m) => s + m.earned, 0))}</td>
                              <td className="px-4 py-2 text-sm text-center font-bold" style={{ color: colors.textPrimary }}>{monthlySummary.reduce((s, m) => s + m.pendingCount, 0)}</td>
                              <td className="px-4 py-2 text-sm text-right font-bold" style={{ color: colors.warningText }}>{formatCurrency(monthlySummary.reduce((s, m) => s + m.pending, 0))}</td>
                              <td className="px-4 py-2 text-sm text-right font-black" style={{ color: colors.gold }}>{formatCurrency(monthlySummary.reduce((s, m) => s + m.earned + m.pending, 0))}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Accounting note */}
                  <p className="text-xs mt-3" style={{ color: colors.textFaint }}>
                    Referral fees are earned when deals reach &quot;Funded&quot; status. Export CSV for spreadsheet use or download the PDF report for accounting records.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ================================================================ */}
          {/* PAYMENTS TAB                                                     */}
          {/* ================================================================ */}
          {activeTab === 'payments' && (
            <div className="p-4 sm:p-6">
              {(() => {
                const fundedDeals = deals.filter(d => ['funded', 'completed'].includes(d.status))
                if (fundedDeals.length === 0) {
                  return (
                    <div className="py-12 text-center">
                      <DollarSign className="mx-auto mb-4" size={40} style={{ color: colors.textFaint }} />
                      <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>No payments to track</p>
                      <p className="text-sm mt-1" style={{ color: colors.textMuted }}>Payment tracking appears when your agents have funded deals.</p>
                    </div>
                  )
                }

                const totalOwed = fundedDeals.reduce((sum, d) => sum + (d.amount_due_from_brokerage || 0), 0)
                const totalPaid = fundedDeals.reduce((sum, d) => {
                  const payments = (d as any).brokerage_payments || []
                  return sum + payments.reduce((s: number, p: any) => s + p.amount, 0)
                }, 0)
                const outstanding = totalOwed - totalPaid
                const paidPct = totalOwed > 0 ? Math.min((totalPaid / totalOwed) * 100, 100) : 0

                return (
                  <>
                    {/* Payment Summary Cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                      <div className="rounded-lg p-4" style={{ background: colors.infoBg, border: `1px solid ${colors.infoBorder}` }}>
                        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.infoText }}>Total Owed</p>
                        <p className="text-xl font-black mt-1" style={{ color: colors.infoText }}>{formatCurrency(totalOwed)}</p>
                      </div>
                      <div className="rounded-lg p-4" style={{ background: colors.successBg, border: `1px solid ${colors.successBorder}` }}>
                        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: colors.successText }}>Paid</p>
                        <p className="text-xl font-black mt-1" style={{ color: colors.successText }}>{formatCurrency(totalPaid)}</p>
                      </div>
                      <div className="rounded-lg p-4" style={{
                        background: outstanding > 0.01 ? colors.warningBg : colors.successBg,
                        border: `1px solid ${outstanding > 0.01 ? colors.warningBorder : colors.successBorder}`,
                      }}>
                        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: outstanding > 0.01 ? colors.warningText : colors.successText }}>Outstanding</p>
                        <p className="text-xl font-black mt-1" style={{ color: outstanding > 0.01 ? colors.warningText : colors.successText }}>{formatCurrency(Math.max(outstanding, 0))}</p>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="mb-6">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold" style={{ color: colors.textMuted }}>Payment Progress</span>
                        <span className="text-xs font-semibold" style={{ color: colors.textMuted }}>{paidPct.toFixed(0)}%</span>
                      </div>
                      <div className="h-3 rounded-full overflow-hidden" style={{ background: colors.inputBg }}>
                        <div className="h-full rounded-full transition-all duration-500" style={{
                          width: `${paidPct}%`,
                          background: paidPct >= 99.9 ? colors.successText : colors.gold,
                        }} />
                      </div>
                    </div>

                    {/* Per-Deal Payment Status */}
                    <div className="space-y-3">
                      {fundedDeals.map(deal => {
                        const owed = deal.amount_due_from_brokerage || 0
                        const payments = (deal as any).brokerage_payments || []
                        const paid = payments.reduce((s: number, p: any) => s + p.amount, 0)
                        const remaining = owed - paid
                        const isPaid = Math.abs(remaining) < 0.01 && paid > 0
                        const isPartial = paid > 0 && !isPaid

                        return (
                          <div key={deal.id} className="rounded-lg p-4" style={{ background: colors.tableHeaderBg, border: `1px solid ${colors.divider}` }}>
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <p className="font-medium text-sm" style={{ color: colors.textPrimary }}>{deal.property_address}</p>
                                <p className="text-xs mt-0.5" style={{ color: colors.textMuted }}>
                                  {deal.agent ? `${deal.agent.first_name} ${deal.agent.last_name}` : ''} &middot; {formatStatusLabel(deal.status)}
                                </p>
                              </div>
                              <span
                                className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-md"
                                style={{
                                  background: isPaid ? colors.successBg : isPartial ? colors.warningBg : colors.inputBg,
                                  color: isPaid ? colors.successText : isPartial ? colors.warningText : colors.textMuted,
                                  border: `1px solid ${isPaid ? colors.successBorder : isPartial ? colors.warningBorder : colors.border}`,
                                }}
                              >
                                {isPaid ? 'Paid' : isPartial ? 'Partial' : 'Pending'}
                              </span>
                            </div>
                            <div className="grid grid-cols-3 gap-3 text-sm">
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
                            {/* Payment history */}
                            {payments.length > 0 && (
                              <div className="mt-3 pt-2" style={{ borderTop: `1px solid ${colors.divider}` }}>
                                {payments.map((p: any, idx: number) => (
                                  <div key={idx} className="flex justify-between items-center text-xs py-1">
                                    <div className="flex items-center gap-2">
                                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: colors.successText }} />
                                      <span style={{ color: colors.textSecondary }}>{formatDate(p.date)}</span>
                                      {p.reference && <span style={{ color: colors.textMuted }}>Ref: {p.reference}</span>}
                                    </div>
                                    <span className="font-semibold" style={{ color: colors.successText }}>{formatCurrency(p.amount)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>

                    <p className="text-xs mt-4" style={{ color: colors.textFaint }}>
                      Payments shown are recorded by Firm Funds. Contact your account manager if you believe there is a discrepancy.
                    </p>
                  </>
                )
              })()}
            </div>
          )}

          {/* ================================================================ */}
          {/* MESSAGES TAB                                                     */}
          {/* ================================================================ */}
          {activeTab === 'messages' && (
            <div className="flex" style={{ height: '500px' }}>
              {/* Deal list */}
              <div className="flex flex-col" style={{ width: '300px', minWidth: '250px', borderRight: `1px solid ${colors.border}` }}>
                <div className="p-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <p className="text-xs font-bold" style={{ color: colors.textMuted }}>
                    Select a deal to message Firm Funds
                  </p>
                </div>
                <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                  {brokerageInbox.length === 0 ? (
                    <div className="p-6 text-center">
                      <Inbox size={32} style={{ color: colors.textFaint }} className="mx-auto mb-2" />
                      <p className="text-xs" style={{ color: colors.textMuted }}>No active deals</p>
                    </div>
                  ) : (
                    brokerageInbox.map((item: any) => {
                      const isSelected = item.deal_id === selectedMsgDealId
                      return (
                        <button
                          key={item.deal_id}
                          onClick={async () => {
                            setSelectedMsgDealId(item.deal_id)
                            setMessagesLoading(true)
                            setMsgText('')
                            const result = await getDealMessages(item.deal_id)
                            if (result.success && result.data) setDealMessages(result.data)
                            setMessagesLoading(false)
                          }}
                          className="w-full text-left px-3 py-3 transition-colors"
                          style={{
                            background: isSelected ? colors.tableHeaderBg : 'transparent',
                            borderBottom: `1px solid ${colors.divider}`,
                            borderLeft: isSelected ? `3px solid ${colors.gold}` : '3px solid transparent',
                          }}
                          onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = colors.cardHoverBg }}
                          onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                        >
                          <p className="text-xs font-semibold truncate" style={{ color: colors.textPrimary }}>{item.property_address}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px]" style={{ color: colors.textMuted }}>{item.agent_name}</span>
                            <span className="inline-flex px-1.5 py-0.5 text-[9px] font-semibold rounded" style={getStatusBadgeStyle(item.deal_status)}>
                              {formatStatusLabel(item.deal_status)}
                            </span>
                          </div>
                          {item.total_message_count > 0 && (
                            <p className="text-[10px] mt-1 truncate" style={{ color: colors.textFaint }}>
                              {item.total_message_count} message{item.total_message_count !== 1 ? 's' : ''}
                            </p>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              </div>

              {/* Message thread */}
              <div className="flex-1 flex flex-col min-w-0">
                {!selectedMsgDealId ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <MessageSquare size={36} style={{ color: colors.textFaint }} className="mx-auto mb-2" />
                      <p className="text-sm font-medium" style={{ color: colors.textSecondary }}>Select a deal to view messages</p>
                      <p className="text-xs mt-1" style={{ color: colors.textMuted }}>You can message the Firm Funds team about any active deal</p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Thread header */}
                    <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <p className="text-xs font-bold truncate" style={{ color: colors.textPrimary }}>
                        {brokerageInbox.find((d: any) => d.deal_id === selectedMsgDealId)?.property_address}
                      </p>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto px-4 py-3" style={{ scrollbarWidth: 'thin' }}>
                      {messagesLoading ? (
                        <div className="space-y-2">
                          {[1,2,3].map(i => (
                            <div key={i} className="h-10 rounded-lg animate-pulse" style={{ background: colors.skeletonHighlight }} />
                          ))}
                        </div>
                      ) : dealMessages.length === 0 ? (
                        <div className="flex items-center justify-center h-full">
                          <div className="text-center">
                            <MessageSquare size={28} style={{ color: colors.textFaint }} className="mx-auto mb-2" />
                            <p className="text-xs font-medium" style={{ color: colors.textSecondary }}>No messages yet</p>
                            <p className="text-[10px] mt-0.5" style={{ color: colors.textMuted }}>Send a message to the Firm Funds team below</p>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {dealMessages.map((msg: any) => (
                            <div
                              key={msg.id}
                              className={`px-3 py-2.5 rounded-xl max-w-[85%] ${msg.sender_role === 'brokerage_admin' ? 'ml-auto' : ''}`}
                              style={{
                                background: msg.sender_role === 'admin' ? '#0F2A18'
                                  : msg.sender_role === 'brokerage_admin' ? colors.tableHeaderBg
                                  : '#1A2240',
                                border: `1px solid ${msg.sender_role === 'admin' ? '#1E4A2C' : msg.sender_role === 'brokerage_admin' ? colors.border : '#2D3A5C'}`,
                              }}
                            >
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-[10px] font-semibold" style={{
                                  color: msg.sender_role === 'admin' ? '#5FA873'
                                    : msg.sender_role === 'brokerage_admin' ? colors.gold
                                    : '#7B9FE0',
                                }}>
                                  {msg.sender_role === 'admin' ? 'Firm Funds' : msg.sender_role === 'brokerage_admin' ? 'You' : msg.sender_name || 'Agent'}
                                </span>
                                <span className="text-[9px]" style={{ color: colors.textFaint }}>
                                  {new Date(msg.created_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                              <p className="text-xs whitespace-pre-wrap leading-relaxed" style={{ color: colors.textPrimary }}>{msg.message}</p>
                            </div>
                          ))}
                          <div ref={msgEndRef} />
                        </div>
                      )}
                    </div>

                    {/* Reply input */}
                    <div className="px-4 py-2.5 flex gap-2" style={{ borderTop: `1px solid ${colors.border}`, background: colors.tableHeaderBg }}>
                      <input
                        type="text"
                        value={msgText}
                        onChange={(e) => setMsgText(e.target.value)}
                        placeholder="Message Firm Funds..."
                        className="flex-1 px-3 py-2 rounded-lg text-xs outline-none"
                        style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter' && !e.shiftKey && msgText.trim() && selectedMsgDealId) {
                            e.preventDefault()
                            setMsgSending(true)
                            const result = await sendBrokerageMessage({ dealId: selectedMsgDealId, message: msgText })
                            if (result.success && result.data) {
                              setDealMessages(prev => [...prev, result.data])
                              setMsgText('')
                              setTimeout(() => msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
                            }
                            setMsgSending(false)
                          }
                        }}
                      />
                      <button
                        onClick={async () => {
                          if (!selectedMsgDealId || !msgText.trim()) return
                          setMsgSending(true)
                          const result = await sendBrokerageMessage({ dealId: selectedMsgDealId, message: msgText })
                          if (result.success && result.data) {
                            setDealMessages(prev => [...prev, result.data])
                            setMsgText('')
                            setTimeout(() => msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
                          }
                          setMsgSending(false)
                        }}
                        disabled={msgSending || !msgText.trim()}
                        className="px-3 py-2 rounded-lg text-xs font-medium text-white disabled:opacity-40 flex items-center gap-1 transition-colors"
                        style={{ background: '#5FA873' }}
                      >
                        <Send size={12} />
                        {msgSending ? '...' : 'Send'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
