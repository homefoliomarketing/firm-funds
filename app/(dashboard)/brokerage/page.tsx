'use client'

import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, Users, DollarSign, ChevronDown, ChevronUp, AlertTriangle,
  CheckCircle, Upload, ChevronLeft, ChevronRight, Download, Calendar,
  TrendingUp, BarChart3, Shield, CreditCard, XCircle, Clock, Send,
  MessageSquare, Inbox, Settings, Bell, CheckCircle2,
} from 'lucide-react'
import { uploadDocument } from '@/lib/actions/deal-actions'
import { getBrokerageInbox, getDealMessages, getNewMessages, sendBrokerageMessage, getBrokerageNotificationCounts, markBrokerageMessagesRead } from '@/lib/actions/notification-actions'
import { getStatusBadgeClass, formatStatusLabel } from '@/lib/constants'
import MessageThread from '@/components/messaging/MessageThread'
import MessageInput from '@/components/messaging/MessageInput'
import type { MessageData } from '@/components/messaging/MessageBubble'
import { formatCurrency, formatDate } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

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
  const [dealTradeRecords, setDealTradeRecords] = useState<Map<string, { file_name: string; created_at: string }>>(new Map())
  const [dealsPage, setDealsPage] = useState(1)
  const [referralMonth, setReferralMonth] = useState<string>('all')
  const [referralFilter, setReferralFilter] = useState<'all' | 'earned' | 'pending'>('all')
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [downloadingCsv, setDownloadingCsv] = useState(false)
  const [showMonthlyChart, setShowMonthlyChart] = useState(true)
  const [brokerageInbox, setBrokerageInbox] = useState<any[]>([])
  const [selectedMsgDealId, setSelectedMsgDealId] = useState<string | null>(null)
  const [dealMessages, setDealMessages] = useState<any[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [unreadNotifCount, setUnreadNotifCount] = useState(0)
  const DEALS_PER_PAGE = 15
  const router = useRouter()
  const supabase = createClient()

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
        if (dealData && dealData.length > 0) {
          const dealIds = dealData.map((d: any) => d.id)
          const { data: tradeRecDocs } = await supabase
            .from('deal_documents')
            .select('deal_id, file_name, created_at')
            .in('deal_id', dealIds)
            .eq('document_type', 'trade_record')
            .order('created_at', { ascending: false })
          if (tradeRecDocs) {
            const map = new Map<string, { file_name: string; created_at: string }>()
            for (const doc of tradeRecDocs) {
              if (!map.has(doc.deal_id)) map.set(doc.deal_id, { file_name: doc.file_name, created_at: doc.created_at })
            }
            setDealTradeRecords(map)
          }
        }
        const { data: agentData } = await supabase.from('agents').select('*').eq('brokerage_id', profileData.brokerage_id).order('last_name', { ascending: true })
        setAgents(agentData || [])
        getBrokerageInbox(profileData.brokerage_id).then(r => {
          if (r.success && r.data) setBrokerageInbox(r.data.inbox)
        })
      }
      setLoading(false)
    }
    loadBrokerage()
  }, [])

  // Poll for notification counts every 30 seconds
  useEffect(() => {
    if (!profile?.brokerage_id) return
    const brokerageId = profile.brokerage_id

    const loadCounts = async () => {
      try {
        const result = await getBrokerageNotificationCounts(brokerageId)
        if (result.success && result.data) {
          setUnreadNotifCount(result.data.unreadMessages)
        }
      } catch { /* silent */ }
    }

    loadCounts()
    const interval = setInterval(loadCounts, 30000)
    return () => clearInterval(interval)
  }, [profile?.brokerage_id])

  // Poll for new messages in selected thread every 5 seconds
  const latestMsgRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedMsgDealId) return
    // Track the latest message timestamp
    if (dealMessages.length > 0) {
      latestMsgRef.current = dealMessages[dealMessages.length - 1].created_at
    }

    const pollNewMessages = async () => {
      if (!selectedMsgDealId || !latestMsgRef.current) return
      try {
        const result = await getNewMessages({ dealId: selectedMsgDealId, afterTimestamp: latestMsgRef.current })
        if (result.success && result.data && result.data.length > 0) {
          setDealMessages((prev: any[]) => {
            const existingIds = new Set(prev.map((m: any) => m.id))
            const newMsgs = result.data.filter((m: any) => !existingIds.has(m.id))
            if (newMsgs.length === 0) return prev
            latestMsgRef.current = newMsgs[newMsgs.length - 1].created_at
            return [...prev, ...newMsgs]
          })
          // Auto-mark as read when new messages arrive
          markBrokerageMessagesRead(selectedMsgDealId)
        }
      } catch { /* silent */ }
    }

    const interval = setInterval(pollNewMessages, 5000)
    return () => clearInterval(interval)
  }, [selectedMsgDealId, dealMessages.length])

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
      setDealTradeRecords(prev => {
        const next = new Map(prev)
        next.set(dealId, { file_name: file.name, created_at: new Date().toISOString() })
        return next
      })
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

  const sortedDeals = useMemo(() => {
    const getPriority = (deal: Deal) => {
      if (deal.status === 'under_review' && !dealTradeRecords.has(deal.id)) return 0
      if (deal.status === 'under_review') return 1
      if (deal.status === 'approved') return 2
      if (deal.status === 'funded') return 3
      return 4
    }
    const sorted = [...deals]
    sorted.sort((a, b) => {
      const pa = getPriority(a)
      const pb = getPriority(b)
      if (pa !== pb) return pa - pb
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
    return sorted
  }, [deals, dealTradeRecords])

  const earnedDeals = useMemo(() =>
    deals.filter(d => ['funded', 'completed'].includes(d.status)), [deals])
  const pendingDeals = useMemo(() =>
    deals.filter(d => ['under_review', 'approved'].includes(d.status)), [deals])

  const dealsMissingTradeRecord = useMemo(() =>
    deals.filter(d => !['denied', 'cancelled', 'completed'].includes(d.status) && !dealTradeRecords.has(d.id)).length,
    [deals, dealTradeRecords])
  const unansweredMessageCount = useMemo(() =>
    brokerageInbox.reduce((sum: number, item: any) => sum + (item.unread_message_count || 0), 0),
    [brokerageInbox])
  const totalReferralFees = useMemo(() =>
    earnedDeals.reduce((sum, d) => sum + d.brokerage_referral_fee, 0), [earnedDeals])
  const pendingReferralFees = useMemo(() =>
    pendingDeals.reduce((sum, d) => sum + d.brokerage_referral_fee, 0), [pendingDeals])

  const availableMonths = useMemo(() => {
    const months = new Set<string>()
    deals.forEach(d => {
      if (['funded', 'completed', 'under_review', 'approved'].includes(d.status) && d.closing_date) {
        months.add(d.closing_date.slice(0, 7))
      }
    })
    return Array.from(months).sort().reverse()
  }, [deals])

  const filteredReferralDeals = useMemo(() => {
    let allReferral = [...earnedDeals, ...pendingDeals]
    if (referralFilter === 'earned') {
      allReferral = allReferral.filter(d => ['funded', 'completed'].includes(d.status))
    } else if (referralFilter === 'pending') {
      allReferral = allReferral.filter(d => ['under_review', 'approved'].includes(d.status))
    }
    if (referralMonth === 'all') return allReferral
    return allReferral.filter(d => d.closing_date?.startsWith(referralMonth))
  }, [earnedDeals, pendingDeals, referralMonth, referralFilter])

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

  const avgFeePerDeal = earnedDeals.length > 0 ? totalReferralFees / earnedDeals.length : 0

  const formatMonthLabel = (ym: string) => {
    const [year, month] = ym.split('-').map(Number)
    return new Date(year, month - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background" role="status" aria-label="Loading brokerage dashboard">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-6 w-36 bg-white/10" />
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Skeleton className="h-6 w-48 rounded-lg mb-2" />
          <Skeleton className="h-3 w-36 rounded mb-4" />
          <Skeleton className="h-3 w-48 rounded mb-4" />
          <span className="sr-only">Loading brokerage dashboard...</span>
        </main>
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
              <img src="/brand/white.png" alt="Firm Funds" className="h-10 sm:h-12 w-auto" />
              <div className="w-px h-8 hidden sm:block bg-white/15" />
              <p className="text-xs sm:text-sm font-medium tracking-wide text-white hidden sm:block">
                Brokerage Portal{brokerage ? ` — ${brokerage.name}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs hidden sm:inline text-primary">{profile?.full_name}</span>
              <button
                onClick={() => setActiveTab('messages')}
                className="relative p-1.5 rounded-lg transition-colors text-white/50 hover:text-primary"
                title="Messages"
                aria-label={`Messages${unreadNotifCount > 0 ? `, ${unreadNotifCount} unread` : ''}`}
              >
                <Bell size={16} />
                {unreadNotifCount > 0 && (
                  <span className="absolute -top-1 -right-1 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold bg-red-500 text-white">
                    {unreadNotifCount > 99 ? '99+' : unreadNotifCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => router.push('/brokerage/settings')}
                className="p-1.5 rounded-lg transition-colors text-white/50 hover:text-primary"
                title="Settings"
                aria-label="Settings"
              >
                <Settings size={16} />
              </button>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Welcome */}
        <section aria-label="Welcome" className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Welcome back, {profile?.full_name?.split(' ')[0]}
          </h1>
          <p className="text-sm mt-1 text-muted-foreground">Manage your brokerage&apos;s commission advance activity.</p>
        </section>

        {/* KPI Summary */}
        {deals.length > 0 && (
          <section aria-label="Key metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Total Deals', value: deals.length, icon: FileText, accent: 'text-primary' },
              { label: 'Active', value: deals.filter(d => ['under_review', 'approved', 'funded'].includes(d.status)).length, icon: TrendingUp, accent: 'text-status-blue' },
              { label: 'Referral Fees Earned', value: formatCurrency(earnedDeals.reduce((s, d) => s + d.brokerage_referral_fee, 0)), icon: DollarSign, accent: 'text-primary' },
              { label: 'Missing Trade Records', value: dealsMissingTradeRecord, icon: AlertTriangle, accent: dealsMissingTradeRecord > 0 ? 'text-status-red' : 'text-status-teal' },
            ].map(stat => (
              <Card key={stat.label} className="border-border/40 bg-card/60">
                <CardContent className="p-4 sm:p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{stat.label}</span>
                    <stat.icon size={15} className={`${stat.accent} opacity-60`} aria-hidden="true" />
                  </div>
                  <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums">{stat.value}</p>
                </CardContent>
              </Card>
            ))}
          </section>
        )}

        {/* Tabbed Content */}
        <Card className="overflow-hidden border-border/40 shadow-lg shadow-black/20">
          <div className="flex overflow-x-auto border-b border-border/50" role="tablist" aria-label="Brokerage dashboard tabs">
            {(['deals', 'agents', 'referrals', 'payments', 'messages'] as const).map((tab) => {
              const tabLabels: Record<string, string> = { deals: `Deals (${deals.length})`, agents: `Agents (${agents.length})`, referrals: 'Referral Fees', payments: 'Payment Status', messages: 'Messages' }
              return (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={activeTab === tab}
                  aria-controls={`tabpanel-${tab}`}
                  id={`tab-${tab}`}
                  onClick={() => {
                    setActiveTab(tab)
                    if (tab === 'messages' && profile?.brokerage_id) {
                      getBrokerageInbox(profile.brokerage_id).then(r => {
                        if (r.success && r.data) setBrokerageInbox(r.data.inbox)
                      })
                    }
                  }}
                  className={`px-4 sm:px-5 py-3 text-[13px] font-medium transition-all whitespace-nowrap inline-flex items-center gap-1.5 border-b-2 -mb-px ${
                    activeTab === tab
                      ? 'text-primary border-primary'
                      : 'text-muted-foreground/70 border-transparent hover:text-foreground hover:border-border'
                  }`}
                >
                  {tabLabels[tab]}
                  {tab === 'deals' && dealsMissingTradeRecord > 0 && (
                    <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[11px] font-bold bg-red-600 text-white">
                      {dealsMissingTradeRecord}
                    </span>
                  )}
                  {tab === 'messages' && unansweredMessageCount > 0 && (
                    <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[11px] font-bold bg-red-600 text-white">
                      {unansweredMessageCount}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Upload Status Message */}
          {uploadMessage && (
            <div
              role="status"
              aria-live="polite"
              className={`mx-4 sm:mx-6 mt-4 p-3 rounded-lg text-sm font-medium border ${
                uploadMessage.type === 'success'
                  ? 'bg-green-950/50 border-green-800 text-green-400'
                  : 'bg-red-950/50 border-red-800 text-red-400'
              }`}
            >
              {uploadMessage.text}
            </div>
          )}

          {/* ================================================================ */}
          {/* DEALS TAB                                                        */}
          {/* ================================================================ */}
          {activeTab === 'deals' && (
            <section role="tabpanel" id="tabpanel-deals" aria-labelledby="tab-deals">
              {deals.length === 0 ? (
                <div className="px-6 py-20 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-secondary/80 flex items-center justify-center mx-auto mb-5">
                    <FileText className="text-muted-foreground/50" size={28} />
                  </div>
                  <p className="text-base font-semibold text-foreground mb-1">No deals yet</p>
                  <p className="text-sm text-muted-foreground max-w-xs mx-auto">Deals will appear here when your agents request commission advances.</p>
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
                        className="group px-4 sm:px-6 py-4 flex items-center justify-between cursor-pointer transition-all duration-150 hover:bg-white/[0.03] border-b border-border/20"
                        onClick={() => setExpandedDeal(expandedDeal === deal.id ? null : deal.id)}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {!dealTradeRecords.has(deal.id) && !['denied', 'cancelled', 'completed'].includes(deal.status) && (
                              <span className="inline-flex w-2 h-2 rounded-full bg-red-500 flex-shrink-0 animate-pulse" title="Trade record needed" />
                            )}
                            <p className="text-[13px] font-semibold truncate text-foreground group-hover:text-primary transition-colors">{deal.property_address}</p>
                          </div>
                          <p className="text-xs mt-1.5 text-muted-foreground/70">
                            {deal.agent?.first_name} {deal.agent?.last_name} <span className="text-muted-foreground/30 mx-1" aria-hidden="true">|</span> {formatDate(deal.created_at)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 ml-3">
                          {!dealTradeRecords.has(deal.id) && !['denied', 'cancelled', 'completed'].includes(deal.status) && (
                            <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-md bg-red-950/50 text-red-400 border border-red-800">
                              <AlertTriangle size={11} />
                              Trade Record Needed
                            </span>
                          )}
                          <span
                            className={`inline-flex px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md ${getStatusBadgeClass(deal.status)}`}
                          >
                            {formatStatusLabel(deal.status)}
                          </span>
                          <p className="text-sm font-bold w-24 sm:w-28 text-right text-green-400">{formatCurrency(deal.advance_amount)}</p>
                          {expandedDeal === deal.id
                            ? <ChevronUp size={16} className="text-muted-foreground/40" />
                            : <ChevronDown size={16} className="text-muted-foreground/40" />
                          }
                        </div>
                      </div>

                      {expandedDeal === deal.id && (
                        <div className="px-4 pb-4 bg-muted/20 border-b border-border/30">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3">
                            <div>
                              <h4 className="text-xs font-bold uppercase tracking-wider mb-3 text-primary">Deal Details</h4>
                              <div className="space-y-2.5 text-sm">
                                <div className="flex justify-between"><span className="text-muted-foreground">Property</span><span className="font-medium text-right text-foreground">{deal.property_address}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Closing Date</span><span className="font-medium text-foreground">{formatDate(deal.closing_date)}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Days Until Closing</span><span className="font-medium text-foreground">{deal.days_until_closing}</span></div>
                              </div>
                            </div>
                            <div>
                              <h4 className="text-xs font-bold uppercase tracking-wider mb-3 text-primary">Financial Summary</h4>
                              <div className="space-y-2.5 text-sm">
                                <div className="flex justify-between"><span className="text-muted-foreground">Gross Commission</span><span className="font-medium text-foreground">{formatCurrency(deal.gross_commission)}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Brokerage Split</span><span className="font-medium text-foreground">{deal.brokerage_split_pct}%</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Agent Advance</span><span className="font-medium text-foreground">{formatCurrency(deal.advance_amount)}</span></div>
                              </div>
                            </div>
                            <div>
                              <h4 className="text-xs font-bold uppercase tracking-wider mb-3 text-primary">Brokerage Info</h4>
                              <div className="space-y-2.5 text-sm">
                                <div className="flex justify-between"><span className="text-muted-foreground">Referral Fee</span><span className="font-bold text-green-400">{formatCurrency(deal.brokerage_referral_fee)}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Due to Firm Funds</span><span className="font-medium text-foreground">{formatCurrency(deal.amount_due_from_brokerage)}</span></div>
                              </div>
                              {deal.status === 'denied' && deal.denial_reason && (
                                <div className="mt-3 rounded-lg p-3 bg-red-950/50 border border-red-800">
                                  <p className="text-xs font-bold text-red-400">Denial Reason</p>
                                  <p className="text-xs mt-1 text-red-400/90">{deal.denial_reason}</p>
                                </div>
                              )}
                              <div className="mt-4 pt-3 border-t border-border/50">
                                {/* Trade Record Section */}
                                {dealTradeRecords.has(deal.id) ? (
                                  <>
                                    <div className="flex items-center gap-2 mb-2">
                                      <CheckCircle size={14} className="text-green-400" />
                                      <span className="text-xs font-semibold text-green-400">Trade Record Uploaded</span>
                                    </div>
                                    <div className="flex items-center justify-between rounded-lg px-3 py-2 bg-muted/50 border border-border/50">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <FileText size={14} className="text-muted-foreground flex-shrink-0" />
                                        <span className="text-xs font-medium truncate text-foreground">{dealTradeRecords.get(deal.id)?.file_name}</span>
                                      </div>
                                      <label className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors text-muted-foreground hover:text-foreground hover:bg-muted">
                                        <Upload size={10} />
                                        Replace
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
                                    </div>
                                  </>
                                ) : !['denied', 'cancelled', 'completed'].includes(deal.status) ? (
                                  <>
                                    <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 mb-2 bg-red-950/50 border border-red-800">
                                      <AlertTriangle size={14} className="text-red-400 flex-shrink-0" />
                                      <span className="text-xs font-semibold text-red-400">Trade Record Required</span>
                                    </div>
                                    <label className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg cursor-pointer transition-colors bg-red-950/40 text-red-400 border border-red-800 hover:bg-red-950/60">
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
                                  </>
                                ) : (
                                  <p className="text-xs text-muted-foreground/50">No trade record uploaded</p>
                                )}
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
                      <nav aria-label="Deal list pagination" className="px-4 sm:px-6 py-3 flex items-center justify-between border-t border-border/30 bg-card/50">
                        <p className="text-xs text-muted-foreground/70 tabular-nums">
                          {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, sortedDeals.length)} of {sortedDeals.length}
                        </p>
                        <div className="flex items-center gap-1">
                          <Button
                            onClick={() => setDealsPage(p => Math.max(1, p - 1))}
                            disabled={page === 1}
                            variant="outline"
                            size="sm"
                            className="p-2 h-8 w-8"
                            aria-label="Previous page"
                          >
                            <ChevronLeft size={14} />
                          </Button>
                          <span className="text-xs font-semibold px-3 text-foreground/80">{page} / {totalPages}</span>
                          <Button
                            onClick={() => setDealsPage(p => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                            variant="outline"
                            size="sm"
                            className="p-2 h-8 w-8"
                            aria-label="Next page"
                          >
                            <ChevronRight size={14} />
                          </Button>
                        </div>
                      </nav>
                    )
                  })()}
                </div>
              )}
            </section>
          )}

          {/* ================================================================ */}
          {/* AGENTS TAB                                                       */}
          {/* ================================================================ */}
          {activeTab === 'agents' && (
            <section role="tabpanel" id="tabpanel-agents" aria-labelledby="tab-agents">
              {agents.length === 0 ? (
                <div className="px-6 py-20 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-secondary/80 flex items-center justify-center mx-auto mb-5">
                    <Users className="text-muted-foreground/50" size={28} />
                  </div>
                  <p className="text-base font-semibold text-foreground mb-1">No agents registered</p>
                  <p className="text-sm text-muted-foreground max-w-xs mx-auto">Agents will appear here once they are added to the system.</p>
                </div>
              ) : (
                <div>
                  {agents.map((agent, i) => (
                    <div
                      key={agent.id}
                      className="px-4 sm:px-6 py-4 flex items-center justify-between transition-all duration-150 hover:bg-white/[0.03] border-b border-border/20 last:border-0"
                    >
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold truncate text-foreground">{agent.first_name} {agent.last_name}</p>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className="text-xs truncate text-muted-foreground/70">{agent.email}{agent.phone ? ` | ${agent.phone}` : ''}</span>
                          {agent.kyc_status === 'verified' ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-950/50 text-green-400 border border-green-800">
                              <Shield size={9} /> KYC
                            </span>
                          ) : agent.kyc_status === 'submitted' ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-yellow-950/50 text-yellow-400 border border-yellow-800">
                              <Clock size={9} /> KYC Pending
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-red-950/50 text-red-400 border border-red-800">
                              <XCircle size={9} /> No KYC
                            </span>
                          )}
                          {agent.banking_verified ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-950/50 text-green-400 border border-green-800">
                              <CreditCard size={9} /> Banking
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-950/30 text-blue-400/70 border border-blue-900/50">
                              <CreditCard size={9} /> No Banking
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 ml-3">
                        {agent.flagged_by_brokerage ? (
                          <span className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md bg-red-950/50 text-red-400 border border-red-800">
                            <AlertTriangle size={12} />
                            <span className="hidden sm:inline">Flagged</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md bg-green-950/50 text-green-400 border border-green-800">
                            <CheckCircle size={12} />
                            <span className="hidden sm:inline">Good Standing</span>
                          </span>
                        )}
                        <Button
                          onClick={() => handleToggleFlag(agent.id, agent.flagged_by_brokerage)}
                          variant="outline"
                          size="sm"
                          className={`text-xs ${agent.flagged_by_brokerage ? 'text-green-400 border-green-800 hover:bg-green-950/30' : 'text-red-400 border-red-800 hover:bg-red-950/30'}`}
                        >
                          {agent.flagged_by_brokerage ? 'Remove Flag' : 'Flag'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ================================================================ */}
          {/* REFERRAL FEES TAB                                                */}
          {/* ================================================================ */}
          {activeTab === 'referrals' && (
            <section role="tabpanel" id="tabpanel-referrals" aria-labelledby="tab-referrals" className="p-4">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4" aria-label="Referral fee summary">
                <div
                  className={`rounded-xl px-4 py-3 cursor-pointer transition-all bg-status-green-muted/60 border ${referralFilter === 'earned' ? 'border-status-green ring-1 ring-status-green/20' : 'border-status-green-border/60 hover:border-status-green-border'}`}
                  onClick={() => setReferralFilter(referralFilter === 'earned' ? 'all' : 'earned')}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-status-green/70">Total Earned</p>
                  <p className="text-xl font-bold mt-1 text-status-green tabular-nums">{formatCurrency(totalReferralFees)}</p>
                  <p className="text-xs text-status-green/50">{earnedDeals.length} funded deal{earnedDeals.length !== 1 ? 's' : ''}</p>
                </div>
                <div
                  className={`rounded-xl px-4 py-3 cursor-pointer transition-all bg-status-amber-muted/60 border ${referralFilter === 'pending' ? 'border-status-amber ring-1 ring-status-amber/20' : 'border-status-amber-border/60 hover:border-status-amber-border'}`}
                  onClick={() => setReferralFilter(referralFilter === 'pending' ? 'all' : 'pending')}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-status-amber/70">Pending</p>
                  <p className="text-xl font-bold mt-1 text-status-amber tabular-nums">{formatCurrency(pendingReferralFees)}</p>
                  <p className="text-xs text-status-amber/50">{pendingDeals.length} deal{pendingDeals.length !== 1 ? 's' : ''} in progress</p>
                </div>
                <div className="rounded-xl px-4 py-3 bg-status-blue-muted/60 border border-status-blue-border/60">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-status-blue/70">Avg Fee / Deal</p>
                  <p className="text-xl font-bold mt-1 text-status-blue tabular-nums">{formatCurrency(avgFeePerDeal)}</p>
                  <p className="text-xs text-status-blue/50">across funded deals</p>
                </div>
                <div className="rounded-xl px-4 py-3 bg-card/60 border border-border/40">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Combined Total</p>
                  <p className="text-xl font-bold mt-1 text-primary tabular-nums">{formatCurrency(totalReferralFees + pendingReferralFees)}</p>
                  <p className="text-xs text-muted-foreground/50">earned + pending</p>
                </div>
              </div>

              {/* Monthly Trend Chart */}
              {monthlySummary.length > 1 && (
                <div className="rounded-lg p-4 mb-4 bg-card border border-border/50">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <BarChart3 size={16} className="text-primary" />
                      <h4 className="text-xs font-bold uppercase tracking-wider text-primary">Monthly Trend</h4>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setShowMonthlyChart(!showMonthlyChart)}
                    >
                      {showMonthlyChart ? 'Hide' : 'Show'}
                    </Button>
                  </div>
                  {showMonthlyChart && (() => {
                    const chartData = [...monthlySummary].reverse().slice(-12)
                    const maxVal = Math.max(...chartData.map(m => m.earned + m.pending), 1)
                    return (
                      <div>
                        <div className="flex items-center gap-4 mb-3">
                          <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-sm bg-green-400" />
                            <span className="text-xs text-muted-foreground">Earned</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-sm bg-yellow-400" />
                            <span className="text-xs text-muted-foreground">Pending</span>
                          </div>
                        </div>
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
                                    <div className="w-full max-w-[32px] rounded-t-sm opacity-70" style={{ height: `${pendingH}px`, background: 'var(--warning)' }} />
                                  )}
                                  {earnedH > 0 && (
                                    <div className="w-full max-w-[32px]" style={{ height: `${earnedH}px`, background: 'var(--success)', borderRadius: pendingH > 0 ? '0' : '4px 4px 0 0' }} />
                                  )}
                                </div>
                                <span className="text-[10px] font-medium text-muted-foreground">{monthLabel}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* Fee Breakdown */}
              {earnedDeals.length === 0 && pendingDeals.length === 0 ? (
                <div className="text-center py-8">
                  <DollarSign className="mx-auto mb-3 text-muted-foreground/30" size={32} />
                  <p className="text-sm text-muted-foreground">No referral fees yet. Fees are earned when deals are funded.</p>
                </div>
              ) : (
                <div>
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-primary">Fee Breakdown by Deal</h4>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="text-muted-foreground" aria-hidden="true" />
                        <label htmlFor="referral-month-filter" className="sr-only">Filter by month</label>
                        <select
                          id="referral-month-filter"
                          value={referralMonth}
                          onChange={(e) => setReferralMonth(e.target.value)}
                          className="text-xs rounded-lg px-3 py-1.5 font-medium bg-input border border-border text-foreground"
                        >
                          <option value="all">All Time</option>
                          {availableMonths.map(m => (
                            <option key={m} value={m}>{formatMonthLabel(m)}</option>
                          ))}
                        </select>
                      </div>
                      <Button
                        onClick={handleDownloadCsv}
                        disabled={downloadingCsv || filteredReferralDeals.length === 0}
                        variant="outline"
                        size="sm"
                        className="gap-2 text-xs"
                      >
                        <Download size={13} />
                        {downloadingCsv ? 'Exporting...' : 'Export CSV'}
                      </Button>
                      <Button
                        onClick={handleDownloadPdf}
                        disabled={downloadingPdf}
                        size="sm"
                        className="gap-2 text-xs"
                      >
                        <Download size={13} />
                        {downloadingPdf ? 'Generating...' : 'Download PDF'}
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-lg overflow-x-auto border border-border/50">
                    <table className="w-full min-w-[600px]" aria-label="Referral fee breakdown by deal">
                      <thead>
                        <tr className="bg-muted/50 border-b border-border/50">
                          <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Property</th>
                          <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Agent</th>
                          <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Closing Date</th>
                          <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Status</th>
                          <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Referral Fee</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredReferralDeals.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                              No deals found for the selected period.
                            </td>
                          </tr>
                        ) : (
                          <>
                            {filteredReferralDeals.map((deal) => {
                              const isEarned = ['funded', 'completed'].includes(deal.status)
                              return (
                                <tr key={deal.id} className="border-b border-border/30 last:border-0">
                                  <td className="px-4 py-3 text-sm font-medium text-foreground">{deal.property_address}</td>
                                  <td className="px-4 py-3 text-sm text-foreground/80">{deal.agent?.first_name} {deal.agent?.last_name}</td>
                                  <td className="px-4 py-3 text-sm text-foreground/80">{formatDate(deal.closing_date)}</td>
                                  <td className="px-4 py-3">
                                    <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-md ${getStatusBadgeClass(deal.status)}`}>
                                      {formatStatusLabel(deal.status)}
                                    </span>
                                  </td>
                                  <td className={`px-4 py-3 text-sm text-right font-bold ${isEarned ? 'text-green-400' : 'text-yellow-400'}`}>
                                    {formatCurrency(deal.brokerage_referral_fee)}
                                    {!isEarned && <span className="text-xs font-normal ml-1 text-muted-foreground">(pending)</span>}
                                  </td>
                                </tr>
                              )
                            })}
                            <tr className="bg-muted/50 border-t-2 border-border/50">
                              <td colSpan={4} className="px-4 py-3 text-sm font-bold text-foreground">
                                Total ({filteredReferralDeals.length} deal{filteredReferralDeals.length !== 1 ? 's' : ''})
                              </td>
                              <td className="px-4 py-3 text-sm text-right font-bold text-green-400">
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
                      <h4 className="text-xs font-bold uppercase tracking-wider mb-2 text-primary">
                        <TrendingUp size={13} className="inline mr-1" style={{ verticalAlign: 'text-bottom' }} />
                        Monthly Summary
                      </h4>
                      <div className="rounded-lg overflow-x-auto border border-border/50">
                        <table className="w-full" aria-label="Monthly referral fee summary">
                          <thead>
                            <tr className="bg-muted/50 border-b border-border/50">
                              <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Month</th>
                              <th className="px-4 py-2 text-center text-xs font-bold uppercase tracking-wider text-muted-foreground">Deals</th>
                              <th className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wider text-green-400">Earned</th>
                              <th className="px-4 py-2 text-center text-xs font-bold uppercase tracking-wider text-muted-foreground">Pending</th>
                              <th className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wider text-yellow-400">Pending $</th>
                              <th className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {monthlySummary.map((m) => (
                              <tr key={m.month} className="border-b border-border/30 last:border-0">
                                <td className="px-4 py-2 text-sm font-medium text-foreground">{formatMonthLabel(m.month)}</td>
                                <td className="px-4 py-2 text-sm text-center text-foreground/80">{m.dealCount}</td>
                                <td className="px-4 py-2 text-sm text-right font-semibold text-green-400">{formatCurrency(m.earned)}</td>
                                <td className="px-4 py-2 text-sm text-center text-foreground/80">{m.pendingCount}</td>
                                <td className="px-4 py-2 text-sm text-right font-semibold text-yellow-400">{formatCurrency(m.pending)}</td>
                                <td className="px-4 py-2 text-sm text-right font-bold text-foreground">{formatCurrency(m.earned + m.pending)}</td>
                              </tr>
                            ))}
                            <tr className="bg-muted/50 border-t-2 border-border/50">
                              <td className="px-4 py-2 text-sm font-bold text-foreground">Total</td>
                              <td className="px-4 py-2 text-sm text-center font-bold text-foreground">{monthlySummary.reduce((s, m) => s + m.dealCount, 0)}</td>
                              <td className="px-4 py-2 text-sm text-right font-bold text-green-400">{formatCurrency(monthlySummary.reduce((s, m) => s + m.earned, 0))}</td>
                              <td className="px-4 py-2 text-sm text-center font-bold text-foreground">{monthlySummary.reduce((s, m) => s + m.pendingCount, 0)}</td>
                              <td className="px-4 py-2 text-sm text-right font-bold text-yellow-400">{formatCurrency(monthlySummary.reduce((s, m) => s + m.pending, 0))}</td>
                              <td className="px-4 py-2 text-sm text-right font-black text-primary">{formatCurrency(monthlySummary.reduce((s, m) => s + m.earned + m.pending, 0))}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <p className="text-xs mt-3 text-muted-foreground/50">
                    Referral fees are earned when deals reach &quot;Funded&quot; status. Export CSV for spreadsheet use or download the PDF report for accounting records.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* ================================================================ */}
          {/* PAYMENTS TAB                                                     */}
          {/* ================================================================ */}
          {activeTab === 'payments' && (
            <section role="tabpanel" id="tabpanel-payments" aria-labelledby="tab-payments" className="p-4 sm:p-6">
              {(() => {
                const fundedDeals = deals.filter(d => ['funded', 'completed'].includes(d.status))
                if (fundedDeals.length === 0) {
                  return (
                    <div className="py-12 text-center">
                      <DollarSign className="mx-auto mb-4 text-muted-foreground/30" size={40} />
                      <p className="text-base font-semibold text-muted-foreground">No payments to track</p>
                      <p className="text-sm mt-1 text-muted-foreground/70">Payment tracking appears when your agents have funded deals.</p>
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
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                      <div className="rounded-lg p-4 bg-blue-950/40 border border-blue-800">
                        <p className="text-xs font-semibold uppercase tracking-wider text-blue-400">Total Owed</p>
                        <p className="text-xl font-black mt-1 text-blue-400">{formatCurrency(totalOwed)}</p>
                      </div>
                      <div className="rounded-lg p-4 bg-green-950/40 border border-green-800">
                        <p className="text-xs font-semibold uppercase tracking-wider text-green-400">Paid</p>
                        <p className="text-xl font-black mt-1 text-green-400">{formatCurrency(totalPaid)}</p>
                      </div>
                      <div className={`rounded-lg p-4 ${outstanding > 0.01 ? 'bg-yellow-950/40 border border-yellow-800' : 'bg-green-950/40 border border-green-800'}`}>
                        <p className={`text-xs font-semibold uppercase tracking-wider ${outstanding > 0.01 ? 'text-yellow-400' : 'text-green-400'}`}>Outstanding</p>
                        <p className={`text-xl font-black mt-1 ${outstanding > 0.01 ? 'text-yellow-400' : 'text-green-400'}`}>{formatCurrency(Math.max(outstanding, 0))}</p>
                      </div>
                    </div>

                    <div className="mb-6">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-muted-foreground">Payment Progress</span>
                        <span className="text-xs font-semibold text-muted-foreground">{paidPct.toFixed(0)}%</span>
                      </div>
                      <div className="h-3 rounded-full overflow-hidden bg-muted">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${paidPct}%`,
                            background: paidPct >= 99.9 ? 'var(--success)' : 'var(--primary)',
                          }}
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      {fundedDeals.map(deal => {
                        const owed = deal.amount_due_from_brokerage || 0
                        const payments = (deal as any).brokerage_payments || []
                        const paid = payments.reduce((s: number, p: any) => s + p.amount, 0)
                        const remaining = owed - paid
                        const isPaid = Math.abs(remaining) < 0.01 && paid > 0
                        const isPartial = paid > 0 && !isPaid

                        return (
                          <div key={deal.id} className="rounded-lg p-4 bg-muted/30 border border-border/30">
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <p className="font-medium text-sm text-foreground">{deal.property_address}</p>
                                <p className="text-xs mt-0.5 text-muted-foreground">
                                  {deal.agent ? `${deal.agent.first_name} ${deal.agent.last_name}` : ''} &middot; {formatStatusLabel(deal.status)}
                                </p>
                              </div>
                              <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-md border ${
                                isPaid
                                  ? 'bg-green-950/50 text-green-400 border-green-800'
                                  : isPartial
                                  ? 'bg-yellow-950/50 text-yellow-400 border-yellow-800'
                                  : 'bg-muted text-muted-foreground border-border'
                              }`}>
                                {isPaid ? 'Paid' : isPartial ? 'Partial' : 'Pending'}
                              </span>
                            </div>
                            <div className="grid grid-cols-3 gap-3 text-sm">
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
                            {payments.length > 0 && (
                              <div className="mt-3 pt-2 border-t border-border/30">
                                {payments.map((p: any, idx: number) => (
                                  <div key={idx} className="flex justify-between items-center text-xs py-1">
                                    <div className="flex items-center gap-2">
                                      <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                      <span className="text-foreground/80">{formatDate(p.date)}</span>
                                      {p.reference && <span className="text-muted-foreground">Ref: {p.reference}</span>}
                                    </div>
                                    <span className="font-semibold text-green-400">{formatCurrency(p.amount)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>

                    <p className="text-xs mt-4 text-muted-foreground/50">
                      Payments shown are recorded by Firm Funds. Contact your account manager if you believe there is a discrepancy.
                    </p>
                  </>
                )
              })()}
            </section>
          )}

          {/* ================================================================ */}
          {/* MESSAGES TAB                                                     */}
          {/* ================================================================ */}
          {activeTab === 'messages' && (
            <section role="tabpanel" id="tabpanel-messages" aria-labelledby="tab-messages" className="flex" style={{ minHeight: '500px', height: '60vh' }}>
              {/* Deal list */}
              <nav aria-label="Deal conversations" className="flex flex-col border-r border-border/50" style={{ width: '300px', minWidth: '250px' }}>
                <div className="p-3 border-b border-border/50">
                  <p className="text-xs font-bold text-muted-foreground">
                    Select a deal to message Firm Funds
                  </p>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {brokerageInbox.length === 0 ? (
                    <div className="p-6 text-center">
                      <Inbox size={32} className="text-muted-foreground/30 mx-auto mb-2" />
                      <p className="text-xs text-muted-foreground">No active deals</p>
                    </div>
                  ) : (
                    brokerageInbox.map((item: any) => {
                      const isSelected = item.deal_id === selectedMsgDealId
                      const hasUnread = (item.unread_message_count || 0) > 0
                      return (
                        <button
                          key={item.deal_id}
                          onClick={async () => {
                            setSelectedMsgDealId(item.deal_id)
                            setMessagesLoading(true)
                            const result = await getDealMessages(item.deal_id)
                            if (result.success && result.data) setDealMessages(result.data)
                            setMessagesLoading(false)
                            // Mark messages as read
                            await markBrokerageMessagesRead(item.deal_id)
                            // Update local unread count
                            setBrokerageInbox((prev: any[]) =>
                              prev.map((d: any) => d.deal_id === item.deal_id ? { ...d, unread_message_count: 0 } : d)
                            )
                            // Refresh notification count
                            if (profile?.brokerage_id) {
                              getBrokerageNotificationCounts(profile.brokerage_id).then(r => {
                                if (r.success && r.data) setUnreadNotifCount(r.data.unreadMessages)
                              })
                            }
                          }}
                          className={`w-full text-left px-3 py-3 transition-colors border-b border-border/30 border-l-[3px] ${
                            isSelected
                              ? 'bg-muted border-l-primary'
                              : 'border-l-transparent hover:bg-muted/30'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            {hasUnread && (
                              <span className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                            )}
                            <p className="text-xs font-semibold truncate text-foreground">{item.property_address}</p>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-muted-foreground">{item.agent_name}</span>
                            <span className={`inline-flex px-1.5 py-0.5 text-[9px] font-semibold rounded ${getStatusBadgeClass(item.deal_status)}`}>
                              {formatStatusLabel(item.deal_status)}
                            </span>
                          </div>
                          {item.total_message_count > 0 && (
                            <p className="text-[10px] mt-1 truncate text-muted-foreground/50">
                              {hasUnread
                                ? `${item.unread_message_count} new message${item.unread_message_count !== 1 ? 's' : ''}`
                                : `${item.total_message_count} message${item.total_message_count !== 1 ? 's' : ''}`
                              }
                            </p>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              </nav>

              {/* Message thread */}
              <div className="flex-1 flex flex-col min-w-0">
                {!selectedMsgDealId ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <MessageSquare size={36} className="text-muted-foreground/30 mx-auto mb-2" />
                      <p className="text-sm font-medium text-muted-foreground">Select a deal to view messages</p>
                      <p className="text-xs mt-1 text-muted-foreground/70">You can message the Firm Funds team about any active deal</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="px-4 py-2.5 flex items-center gap-2 border-b border-border/50">
                      <p className="text-xs font-bold truncate text-foreground">
                        {brokerageInbox.find((d: any) => d.deal_id === selectedMsgDealId)?.property_address}
                      </p>
                    </div>

                    <MessageThread
                      messages={dealMessages as MessageData[]}
                      viewerRole="brokerage_admin"
                      loading={messagesLoading}
                      emptyMessage="Send a message to the Firm Funds team below"
                    />

                    <MessageInput
                      onSend={async (message, file) => {
                        if (!selectedMsgDealId) return
                        let filePath: string | null = null
                        let fileName: string | null = null
                        let fileSize: number | null = null
                        let fileType: string | null = null
                        if (file) {
                          const fd = new FormData()
                          fd.append('file', file)
                          fd.append('dealId', selectedMsgDealId)
                          fd.append('documentType', 'other')
                          const uploadResult = await uploadDocument(fd)
                          if (!uploadResult.success) throw new Error(uploadResult.error || 'Upload failed')
                          filePath = uploadResult.data?.file_path || null
                          fileName = file.name
                          fileSize = file.size
                          fileType = file.type
                        }
                        const result = await sendBrokerageMessage({ dealId: selectedMsgDealId, message, filePath, fileName, fileSize, fileType })
                        if (result.success && result.data) {
                          setDealMessages((prev: any) => [...prev, result.data])
                        } else {
                          throw new Error(result.error)
                        }
                      }}
                      placeholder="Message Firm Funds..."
                    />
                  </>
                )}
              </div>
            </section>
          )}
        </Card>
      </main>
    </div>
  )
}
