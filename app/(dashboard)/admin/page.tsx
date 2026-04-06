'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { FileText, Building2, DollarSign, Clock, CheckCircle, ChevronRight, Search, X, ChevronLeft, BarChart3, Shield, Users, MessageSquare, AlertTriangle, Settings, Briefcase, CreditCard, Eye } from 'lucide-react'
import { approveAgentBanking, rejectAgentBanking } from '@/lib/actions/profile-actions'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import { formatCurrency } from '@/lib/formatting'
import { useTheme } from '@/lib/theme'
import SignOutModal from '@/components/SignOutModal'

interface DashboardStats {
  underReviewDeals: number
  pendingKycCount: number
  pendingBankingCount: number
  unreadAgentMessages: number
  dealsWithUnreadMessages: string[]
}

export default function AdminDashboard() {
  const [user, setUser] = useState<any>(null)
  const [profile, setProfile] = useState<any>(null)
  const [stats, setStats] = useState<DashboardStats>({
    underReviewDeals: 0,
    pendingKycCount: 0,
    pendingBankingCount: 0,
    unreadAgentMessages: 0,
    dealsWithUnreadMessages: [],
  })
  const [allDeals, setAllDeals] = useState<any[]>([])
  const [pendingBankingAgents, setPendingBankingAgents] = useState<any[]>([])
  const [pendingKycAgents, setPendingKycAgents] = useState<any[]>([])
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [rejectingAgentId, setRejectingAgentId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [preauthViewUrl, setPreauthViewUrl] = useState<string | null>(null)
  const [revealedBankingIds, setRevealedBankingIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const DEALS_PER_PAGE = 15
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  useEffect(() => {
    async function loadDashboard() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      setUser(user)

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()
      setProfile(profile)

      if (profile?.role !== 'super_admin' && profile?.role !== 'firm_funds_admin') {
        router.push('/login')
        return
      }

      // Fetch all deals once and compute stats client-side (replaces 6 separate count queries)
      const [
        { data: deals },
        { data: bankingAgents },
        { data: kycAgents },
        { data: allMsgs },
        { data: dismissals },
      ] = await Promise.all([
        supabase.from('deals').select('*, agents(first_name, last_name)').order('created_at', { ascending: false }),
        supabase.from('agents').select('id, first_name, last_name, email, banking_submitted_transit, banking_submitted_institution, banking_submitted_account, banking_submitted_at, banking_approval_status, preauth_form_path, brokerage_id, brokerages(name)').eq('banking_approval_status', 'pending'),
        supabase.from('agents').select('id, first_name, last_name, email, kyc_status, kyc_submitted_at, kyc_document_path, kyc_document_type, brokerage_id, brokerages(name)').eq('kyc_status', 'submitted'),
        supabase.from('deal_messages').select('deal_id, sender_role, created_at').order('created_at', { ascending: false }),
        supabase.from('admin_message_dismissals').select('deal_id, dismissed_at'),
      ])

      setPendingBankingAgents(bankingAgents || [])
      setPendingKycAgents(kycAgents || [])

      const allDealsList = deals || []

      // Build dismissal map: deal_id -> dismissed_at
      const dismissMap = new Map<string, string>()
      if (dismissals) {
        for (const d of dismissals) {
          dismissMap.set(d.deal_id, d.dismissed_at)
        }
      }

      // Find deals with unanswered messages (latest message is from agent or brokerage, not dismissed)
      const msgsByDeal = new Map<string, { sender_role: string; created_at: string }>()
      for (const msg of (allMsgs || [])) {
        if (!msgsByDeal.has(msg.deal_id)) {
          msgsByDeal.set(msg.deal_id, msg) // first = most recent (sorted desc)
        }
      }
      const dealsWithUnread: string[] = []
      msgsByDeal.forEach((latestMsg, dealId) => {
        if (latestMsg.sender_role === 'agent' || latestMsg.sender_role === 'brokerage_admin') {
          const dismissedAt = dismissMap.get(dealId)
          if (dismissedAt && new Date(dismissedAt) >= new Date(latestMsg.created_at)) {
            return // dismissed — skip
          }
          dealsWithUnread.push(dealId)
        }
      })

      setStats({
        underReviewDeals: allDealsList.filter(d => d.status === 'under_review').length,
        pendingKycCount: kycAgents?.length || 0,
        pendingBankingCount: bankingAgents?.length || 0,
        unreadAgentMessages: dealsWithUnread.length,
        dealsWithUnreadMessages: dealsWithUnread,
      })

      setAllDeals(allDealsList)

      setLoading(false)
    }
    loadDashboard()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <header style={{ background: colors.headerBgGradient }}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <div className="h-6 w-36 rounded-md animate-pulse" style={{ background: 'rgba(255,255,255,0.1)' }} />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="h-6 w-48 rounded-lg mb-2 animate-pulse" style={{ background: colors.skeletonBase }} />
          <div className="h-3 w-36 rounded mb-4 animate-pulse" style={{ background: colors.skeletonHighlight }} />
          <div className="rounded-lg p-4" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
            {[1,2,3,4,5].map(i => (
              <div key={i} className="flex gap-4 mb-4">
                <div className="h-4 flex-1 rounded animate-pulse" style={{ background: colors.skeletonHighlight }} />
                <div className="h-4 w-20 rounded animate-pulse" style={{ background: colors.skeletonHighlight }} />
                <div className="h-4 w-24 rounded animate-pulse" style={{ background: colors.skeletonHighlight }} />
              </div>
            ))}
          </div>
        </main>
      </div>
    )
  }

  // Status badge styles imported from shared constants (getStatusBadgeStyle)

  // formatCurrency imported from @/lib/formatting (used in deal table)

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-3">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-10 sm:h-12 w-auto" />
              <div className="w-px h-8" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <p className="text-sm font-medium tracking-wide text-white">Admin Dashboard</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs" style={{ color: '#5FA873' }}>{profile?.full_name}</span>
              <button
                onClick={() => router.push('/admin/settings')}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'rgba(255,255,255,0.5)' }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#5FA873'}
                onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.5)'}
                title="Settings"
              >
                <Settings size={16} />
              </button>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        {/* Welcome */}
        <div className="mb-4">
          <h2 className="text-lg font-bold" style={{ color: colors.textPrimary }}>
            Welcome back, {profile?.full_name?.split(' ')[0]}
          </h2>
          <p className="text-xs mt-0.5" style={{ color: colors.textMuted }}>Here is what is happening with Firm Funds.</p>
        </div>

        {/* Quick Links */}
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={() => router.push('/admin/messages')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors relative"
            style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
            onMouseLeave={(e) => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border }}
          >
            <MessageSquare size={14} style={{ color: colors.gold }} />
            Messages
            {stats.unreadAgentMessages > 0 && (
              <span className="ml-1 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold animate-pulse" style={{ background: '#DC2626', color: '#FFF' }}>
                {stats.unreadAgentMessages}
              </span>
            )}
          </button>
          <button
            onClick={() => router.push('/admin/brokerages')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors relative"
            style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
            onMouseLeave={(e) => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border }}
          >
            <Building2 size={14} style={{ color: colors.gold }} />
            Brokerages
            {(stats.pendingKycCount + stats.pendingBankingCount) > 0 && (
              <span className="ml-1 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold animate-pulse" style={{ background: '#DC2626', color: '#FFF' }}>
                {stats.pendingKycCount + stats.pendingBankingCount}
              </span>
            )}
          </button>
          <button
            onClick={() => router.push('/admin/reports')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
            onMouseLeave={(e) => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border }}
          >
            <BarChart3 size={14} style={{ color: colors.gold }} />
            Reports
          </button>
          <button
            onClick={() => router.push('/admin/payments')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
            onMouseLeave={(e) => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border }}
          >
            <DollarSign size={14} style={{ color: colors.gold }} />
            Payments
          </button>
          <button
            onClick={() => router.push('/admin/audit')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={{ background: colors.cardBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
            onMouseLeave={(e) => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border }}
          >
            <Shield size={14} style={{ color: colors.gold }} />
            Audit Trail
          </button>
        </div>

        {/* PENDING ACTIONS — Banking approvals, KYC reviews */}
        {(pendingBankingAgents.length > 0 || pendingKycAgents.length > 0) && (
          <div className="mb-4 rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid #D97706` }}>
            <div className="px-4 py-3 flex items-center gap-2" style={{ background: '#2A1F00', borderBottom: `1px solid #5C4400` }}>
              <AlertTriangle size={16} style={{ color: '#FBBF24' }} />
              <h3 className="text-sm font-bold" style={{ color: '#FBBF24' }}>
                Pending Actions ({pendingBankingAgents.length + pendingKycAgents.length})
              </h3>
            </div>
            <div className="divide-y" style={{ borderColor: colors.divider }}>
              {/* Pending Banking Approvals */}
              {pendingBankingAgents.map(agent => (
                <div key={agent.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex-1 min-w-[250px]">
                      <div className="flex items-center gap-2 mb-1">
                        <CreditCard size={14} style={{ color: '#7B9FE0' }} />
                        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: '#7B9FE0' }}>Banking Approval</span>
                      </div>
                      <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>
                        {agent.first_name} {agent.last_name}
                        <span className="text-xs font-normal ml-2" style={{ color: colors.textMuted }}>
                          {agent.brokerages?.name || ''} · {agent.email}
                        </span>
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {revealedBankingIds.has(agent.id) ? (
                          <p className="text-xs font-mono" style={{ color: colors.textSecondary }}>
                            Transit: {agent.banking_submitted_transit} · Institution: {agent.banking_submitted_institution} · Account: {agent.banking_submitted_account}
                          </p>
                        ) : (
                          <p className="text-xs font-mono" style={{ color: colors.textMuted }}>
                            Transit: ••••• · Institution: ••• · Account: •••••••
                          </p>
                        )}
                        <button
                          onClick={() => setRevealedBankingIds(prev => {
                            const next = new Set(prev)
                            if (next.has(agent.id)) next.delete(agent.id); else next.add(agent.id)
                            return next
                          })}
                          className="p-1 rounded transition-colors"
                          style={{ color: colors.textMuted }}
                          onMouseEnter={(e) => e.currentTarget.style.color = colors.textPrimary}
                          onMouseLeave={(e) => e.currentTarget.style.color = colors.textMuted}
                          title={revealedBankingIds.has(agent.id) ? 'Hide banking info' : 'Show banking info'}
                        >
                          {revealedBankingIds.has(agent.id) ? <X size={18} /> : <Eye size={18} />}
                        </button>
                      </div>
                      {agent.banking_submitted_at && (
                        <p className="text-[10px] mt-0.5" style={{ color: colors.textFaint }}>
                          Submitted {new Date(agent.banking_submitted_at).toLocaleDateString('en-CA')}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {agent.preauth_form_path && (
                        <button
                          onClick={async () => {
                            const { data } = await supabase.storage.from('agent-preauth-forms').createSignedUrl(agent.preauth_form_path, 300)
                            if (data?.signedUrl) setPreauthViewUrl(data.signedUrl)
                          }}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                          style={{ background: colors.inputBg, color: colors.textPrimary, border: `1px solid ${colors.border}` }}
                        >
                          <Eye size={12} />
                          Pre-Auth Form
                        </button>
                      )}
                      {rejectingAgentId === agent.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder="Reason..."
                            className="w-48 rounded-lg px-2.5 py-1.5 text-xs outline-none"
                            style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                            autoFocus
                          />
                          <button
                            disabled={!rejectReason.trim() || actionLoading === agent.id}
                            onClick={async () => {
                              setActionLoading(agent.id)
                              const res = await rejectAgentBanking({ agentId: agent.id, reason: rejectReason })
                              if (res.success) {
                                setPendingBankingAgents(prev => prev.filter(a => a.id !== agent.id))
                                setStats(prev => ({ ...prev, pendingBankingCount: prev.pendingBankingCount - 1 }))
                                setRejectingAgentId(null)
                                setRejectReason('')
                              }
                              setActionLoading(null)
                            }}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                            style={{ background: '#993D3D' }}
                          >
                            Confirm
                          </button>
                          <button onClick={() => { setRejectingAgentId(null); setRejectReason('') }}
                            className="text-xs" style={{ color: colors.textMuted }}>Cancel</button>
                        </div>
                      ) : (
                        <>
                          <button
                            disabled={actionLoading === agent.id}
                            onClick={async () => {
                              setActionLoading(agent.id)
                              const res = await approveAgentBanking({ agentId: agent.id })
                              if (res.success) {
                                setPendingBankingAgents(prev => prev.filter(a => a.id !== agent.id))
                                setStats(prev => ({ ...prev, pendingBankingCount: prev.pendingBankingCount - 1 }))
                              }
                              setActionLoading(null)
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 transition-colors"
                            style={{ background: '#1A7A2E' }}
                            onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#156A24' }}
                            onMouseLeave={(e) => e.currentTarget.style.background = '#1A7A2E'}
                          >
                            {actionLoading === agent.id ? 'Approving...' : 'Approve'}
                          </button>
                          <button
                            onClick={() => setRejectingAgentId(agent.id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                            style={{ background: '#2A1212', color: '#E07B7B', border: '1px solid #4A2020' }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {/* Pending KYC Reviews */}
              {pendingKycAgents.map(agent => (
                <div key={agent.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex-1 min-w-[250px]">
                      <div className="flex items-center gap-2 mb-1">
                        <Shield size={14} style={{ color: '#C4A5F5' }} />
                        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: '#C4A5F5' }}>KYC Review</span>
                      </div>
                      <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>
                        {agent.first_name} {agent.last_name}
                        <span className="text-xs font-normal ml-2" style={{ color: colors.textMuted }}>
                          {agent.brokerages?.name || ''} · {agent.email}
                        </span>
                      </p>
                      {agent.kyc_submitted_at && (
                        <p className="text-[10px] mt-0.5" style={{ color: colors.textFaint }}>
                          Submitted {new Date(agent.kyc_submitted_at).toLocaleDateString('en-CA')}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => router.push('/admin/brokerages')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                      style={{ background: '#1F1535', color: '#C4A5F5', border: '1px solid #352A50' }}
                    >
                      Review in Brokerages
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pre-auth form inline viewer */}
        {preauthViewUrl && (
          <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
            onClick={() => setPreauthViewUrl(null)}>
            <div className="relative w-full max-w-3xl mx-4" style={{ height: '80vh' }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setPreauthViewUrl(null)}
                className="absolute -top-10 right-0 flex items-center gap-1 text-sm font-medium" style={{ color: '#E8E4DF' }}>
                <X size={16} /> Close
              </button>
              <iframe src={preauthViewUrl} className="w-full h-full rounded-xl" style={{ background: '#FFF', border: `2px solid ${colors.border}` }} />
            </div>
          </div>
        )}

        {/* Overdue / Needs Attention Alerts */}
        {(() => {
          const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
          const todayMs = new Date(todayStr + 'T00:00:00').getTime()
          const threeDaysAgo = todayMs - (3 * 24 * 60 * 60 * 1000)

          const overdueClosings = allDeals.filter(d =>
            d.status === 'funded' &&
            new Date(d.closing_date + 'T00:00:00').getTime() < todayMs
          )
          const staleReviews = allDeals.filter(d =>
            d.status === 'under_review' &&
            new Date(d.created_at).getTime() < threeDaysAgo
          )
          const approvedNoFunding = allDeals.filter(d => {
            if (d.status !== 'approved') return false
            const approvedDays = (todayMs - new Date(d.created_at).getTime()) / (24 * 60 * 60 * 1000)
            return approvedDays > 5
          })

          const totalAlerts = overdueClosings.length + staleReviews.length + approvedNoFunding.length
          if (totalAlerts === 0) return null

          return (
            <div className="mb-4 rounded-lg overflow-hidden" style={{ background: '#2A1212', border: '1px solid #4A2020' }}>
              <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: totalAlerts > 0 ? '1px solid #4A2020' : 'none' }}>
                <AlertTriangle size={14} style={{ color: '#F87171' }} />
                <span className="text-xs font-bold" style={{ color: '#F87171' }}>
                  {totalAlerts} deal{totalAlerts !== 1 ? 's' : ''} need{totalAlerts === 1 ? 's' : ''} attention
                </span>
              </div>
              <div className="px-4 py-2 space-y-1.5">
                {overdueClosings.map(deal => (
                  <div
                    key={`overdue-${deal.id}`}
                    className="flex items-center justify-between gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors"
                    style={{ background: '#3A1818' }}
                    onClick={() => router.push(`/admin/deals/${deal.id}`)}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#4A2020'}
                    onMouseLeave={(e) => e.currentTarget.style.background = '#3A1818'}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Clock size={11} style={{ color: '#F87171' }} />
                      <span className="text-xs truncate" style={{ color: '#FCA5A5' }}>
                        <strong>Overdue:</strong> {deal.property_address} — closing was {new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}, still funded
                      </span>
                    </div>
                    <ChevronRight size={12} style={{ color: '#F87171' }} />
                  </div>
                ))}
                {staleReviews.map(deal => (
                  <div
                    key={`stale-${deal.id}`}
                    className="flex items-center justify-between gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors"
                    style={{ background: '#2A2210' }}
                    onClick={() => router.push(`/admin/deals/${deal.id}`)}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#3A3218'}
                    onMouseLeave={(e) => e.currentTarget.style.background = '#2A2210'}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Clock size={11} style={{ color: '#D4A04A' }} />
                      <span className="text-xs truncate" style={{ color: '#E8C060' }}>
                        <strong>Stale review:</strong> {deal.property_address} — under review for {Math.floor((todayMs - new Date(deal.created_at).getTime()) / (24 * 60 * 60 * 1000))} days
                      </span>
                    </div>
                    <ChevronRight size={12} style={{ color: '#D4A04A' }} />
                  </div>
                ))}
                {approvedNoFunding.map(deal => (
                  <div
                    key={`nofund-${deal.id}`}
                    className="flex items-center justify-between gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors"
                    style={{ background: '#1A2240' }}
                    onClick={() => router.push(`/admin/deals/${deal.id}`)}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#2A3250'}
                    onMouseLeave={(e) => e.currentTarget.style.background = '#1A2240'}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Clock size={11} style={{ color: '#7B9FE0' }} />
                      <span className="text-xs truncate" style={{ color: '#9BB8F0' }}>
                        <strong>Pending funding:</strong> {deal.property_address} — approved {Math.floor((todayMs - new Date(deal.created_at).getTime()) / (24 * 60 * 60 * 1000))} days ago
                      </span>
                    </div>
                    <ChevronRight size={12} style={{ color: '#7B9FE0' }} />
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {/* Status Filter Tabs */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {[
            { label: 'All', value: null },
            { label: 'Under Review', value: 'under_review' },
            { label: 'Approved', value: 'approved' },
            { label: 'Funded', value: 'funded' },
            { label: 'Completed', value: 'completed' },
            { label: 'Denied', value: 'denied' },
            { label: 'Cancelled', value: 'cancelled' },
          ].map((tab) => {
            const isActive = statusFilter === tab.value
            const count = tab.value ? allDeals.filter(d => d.status === tab.value).length : allDeals.length
            // Count unread messages for deals in this status
            const unreadInStatus = tab.value
              ? allDeals.filter(d => d.status === tab.value && stats.dealsWithUnreadMessages.includes(d.id)).length
              : stats.unreadAgentMessages
            const showNotificationBadge = (tab.value === 'under_review' && count > 0) || unreadInStatus > 0
            const badgeNumber = unreadInStatus > 0 ? unreadInStatus : count
            return (
              <button
                key={tab.label}
                onClick={() => { setStatusFilter(tab.value); setCurrentPage(1) }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={isActive
                  ? { background: colors.textPrimary, color: colors.pageBg }
                  : { background: colors.cardBg, color: colors.textSecondary, border: `1px solid ${colors.border}` }
                }
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = colors.cardHoverBg }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = colors.cardBg }}
              >
                {tab.label}
                {showNotificationBadge ? (
                  <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full text-[11px] font-bold animate-pulse" style={{ background: '#DC2626', color: '#FFF' }}>
                    {badgeNumber}
                  </span>
                ) : (
                  <span className="text-xs opacity-60">({count})</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Deals Table with Search, Filter & Pagination */}
        {(() => {
          // Status priority for sorting (lower = show first)
          const statusPriority: Record<string, number> = {
            under_review: 0, approved: 1, funded: 2,
            completed: 3, denied: 4, cancelled: 5,
          }

          // Filter, search, and sort by priority
          let filtered = allDeals
          if (statusFilter) filtered = filtered.filter(d => d.status === statusFilter)
          if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            filtered = filtered.filter(d => {
              const agentName = d.agents ? `${d.agents.first_name || ''} ${d.agents.last_name || ''}`.toLowerCase() : ''
              return d.property_address?.toLowerCase().includes(q) || agentName.includes(q)
            })
          }
          // Sort: active statuses first, then by created_at desc within each group
          filtered = [...filtered].sort((a, b) => {
            const pa = statusPriority[a.status] ?? 99
            const pb = statusPriority[b.status] ?? 99
            if (pa !== pb) return pa - pb
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          })
          const totalPages = Math.max(1, Math.ceil(filtered.length / DEALS_PER_PAGE))
          const page = Math.min(currentPage, totalPages)
          const paged = filtered.slice((page - 1) * DEALS_PER_PAGE, page * DEALS_PER_PAGE)

          return (
            <div className="rounded-lg overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
              <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold" style={{ color: colors.textPrimary }}>
                    {statusFilter ? `${statusFilter.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} Deals` : 'All Deals'}
                  </h3>
                  {statusFilter && (
                    <button
                      onClick={() => { setStatusFilter(null); setCurrentPage(1) }}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors"
                      style={{ background: isDark ? '#1A1A1A' : '#F2F2F0', color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                      onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                      onMouseLeave={(e) => e.currentTarget.style.background = isDark ? '#1A1A1A' : '#F2F2F0'}
                    >
                      <X size={12} /> Clear filter
                    </button>
                  )}
                  <span className="text-xs font-medium" style={{ color: colors.textMuted }}>{filtered.length} deal{filtered.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: colors.textFaint }} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
                    placeholder="Search by address or agent name..."
                    className="pl-9 pr-4 py-2 rounded-lg text-sm outline-none w-full sm:w-72"
                    style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = '#5FA873'; e.currentTarget.style.boxShadow = `0 0 0 2px rgba(95,168,115,${isDark ? '0.25' : '0.15'})` }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                  />
                </div>
              </div>
              {paged.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <FileText className="mx-auto mb-4" size={40} style={{ color: colors.textFaint }} />
                  <p className="text-base font-semibold" style={{ color: colors.textSecondary }}>
                    {searchQuery || statusFilter ? 'No deals match your search' : 'No deals yet'}
                  </p>
                  <p className="text-sm mt-1" style={{ color: colors.textMuted }}>
                    {searchQuery || statusFilter ? 'Try adjusting your search or clearing the filter.' : 'Deals will appear here once agents start submitting advance requests.'}
                  </p>
                </div>
              ) : (
                <>
                  {/* Desktop Table - hidden on mobile */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr style={{ background: colors.tableHeaderBg }}>
                          <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Property</th>
                          <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Agent</th>
                          <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Status</th>
                          <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Commission</th>
                          <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Advance</th>
                          <th className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wider" style={{ color: colors.textMuted }}>Closing</th>
                          <th className="px-4 py-2 w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {paged.map((deal, i) => (
                          <tr
                            key={deal.id}
                            className="cursor-pointer transition-colors"
                            style={{ borderBottom: i < paged.length - 1 ? `1px solid ${colors.divider}` : 'none' }}
                            onClick={() => router.push(`/admin/deals/${deal.id}`)}
                            onMouseEnter={(e) => e.currentTarget.style.background = colors.tableRowHoverBg}
                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                          >
                            <td className="px-4 py-2.5 text-sm font-medium" style={{ color: colors.textPrimary }}>
                              <span className="flex items-center gap-1.5">
                                {deal.property_address}
                                {stats.dealsWithUnreadMessages.includes(deal.id) && (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: '#DC262615', color: '#DC2626', flexShrink: 0 }}>
                                    <MessageSquare size={11} />
                                    New
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-sm" style={{ color: colors.textSecondary }}>
                              {deal.agents ? `${deal.agents.first_name || ''} ${deal.agents.last_name || ''}`.trim() : '—'}
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-md"
                                style={getStatusBadgeStyle(deal.status)}
                              >
                                {formatStatusLabel(deal.status)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-sm font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.gross_commission)}</td>
                            <td className="px-4 py-2.5 text-sm font-bold" style={{ color: ['denied', 'cancelled'].includes(deal.status) ? colors.errorText : colors.successText }}>{formatCurrency(deal.advance_amount)}</td>
                            <td className="px-4 py-2.5 text-sm" style={{ color: colors.textMuted }}>{new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                            <td className="px-4 py-2.5"><ChevronRight size={14} style={{ color: colors.textFaint }} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Card Layout - visible only on mobile */}
                  <div className="md:hidden space-y-2 px-4 py-3">
                    {paged.map((deal) => (
                      <div
                        key={deal.id}
                        className="cursor-pointer transition-colors rounded-lg p-3.5"
                        style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}
                        onClick={() => router.push(`/admin/deals/${deal.id}`)}
                        onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                        onMouseLeave={(e) => e.currentTarget.style.background = colors.cardBg}
                      >
                        {/* Property Address + New Badge */}
                        <div className="flex items-start gap-2 mb-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold truncate" style={{ color: colors.textPrimary }}>
                              {deal.property_address}
                            </p>
                          </div>
                          {stats.dealsWithUnreadMessages.includes(deal.id) && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap" style={{ background: '#DC262615', color: '#DC2626', flexShrink: 0 }}>
                              <MessageSquare size={11} />
                              New
                            </span>
                          )}
                        </div>

                        {/* Agent Name + Status Badge */}
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <p className="text-sm truncate" style={{ color: colors.textSecondary }}>
                            {deal.agents ? `${deal.agents.first_name || ''} ${deal.agents.last_name || ''}`.trim() : '—'}
                          </p>
                          <span
                            className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-md whitespace-nowrap"
                            style={getStatusBadgeStyle(deal.status)}
                          >
                            {formatStatusLabel(deal.status)}
                          </span>
                        </div>

                        {/* Commission and Advance */}
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <div>
                            <p className="text-xs" style={{ color: colors.textMuted }}>Commission</p>
                            <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>
                              {formatCurrency(deal.gross_commission)}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs" style={{ color: colors.textMuted }}>Advance</p>
                            <p className="text-sm font-bold" style={{ color: ['denied', 'cancelled'].includes(deal.status) ? colors.errorText : colors.successText }}>
                              {formatCurrency(deal.advance_amount)}
                            </p>
                          </div>
                        </div>

                        {/* Closing Date */}
                        <div>
                          <p className="text-xs" style={{ color: colors.textMuted }}>Closing</p>
                          <p className="text-sm" style={{ color: colors.textSecondary }}>
                            {new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {/* Pagination */}
              {totalPages > 1 && (
                <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: `1px solid ${colors.border}` }}>
                  <p className="text-xs" style={{ color: colors.textMuted }}>
                    Showing {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, filtered.length)} of {filtered.length}
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="p-2 rounded-lg transition-colors disabled:opacity-30"
                      style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = colors.cardHoverBg }}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                      let pageNum: number
                      if (totalPages <= 5) { pageNum = i + 1 }
                      else if (page <= 3) { pageNum = i + 1 }
                      else if (page >= totalPages - 2) { pageNum = totalPages - 4 + i }
                      else { pageNum = page - 2 + i }
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setCurrentPage(pageNum)}
                          className="w-8 h-8 rounded-lg text-xs font-semibold transition-colors"
                          style={pageNum === page
                            ? { background: '#1E1E1E', color: '#FFFFFF' }
                            : { color: colors.textSecondary, border: `1px solid ${colors.border}` }
                          }
                          onMouseEnter={(e) => { if (pageNum !== page) e.currentTarget.style.background = colors.cardHoverBg }}
                          onMouseLeave={(e) => { if (pageNum !== page) e.currentTarget.style.background = 'transparent' }}
                        >
                          {pageNum}
                        </button>
                      )
                    })}
                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="p-2 rounded-lg transition-colors disabled:opacity-30"
                      style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = colors.cardHoverBg }}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })()}
      </main>
    </div>
  )
}
