'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, Building2, DollarSign, Clock, ChevronRight, Search, X,
  ChevronLeft, BarChart3, Shield, MessageSquare, AlertTriangle, Settings,
  CreditCard, Eye, EyeOff, Loader2
} from 'lucide-react'
import { approveAgentBanking, rejectAgentBanking } from '@/lib/actions/profile-actions'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import { formatCurrency } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'

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

  useEffect(() => {
    async function loadDashboard() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
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

      const dismissMap = new Map<string, string>()
      if (dismissals) {
        for (const d of dismissals) dismissMap.set(d.deal_id, d.dismissed_at)
      }

      const msgsByDeal = new Map<string, { sender_role: string; created_at: string }>()
      for (const msg of (allMsgs || [])) {
        if (!msgsByDeal.has(msg.deal_id)) msgsByDeal.set(msg.deal_id, msg)
      }
      const dealsWithUnread: string[] = []
      msgsByDeal.forEach((latestMsg, dealId) => {
        if (latestMsg.sender_role === 'agent' || latestMsg.sender_role === 'brokerage_admin') {
          const dismissedAt = dismissMap.get(dealId)
          if (dismissedAt && new Date(dismissedAt) >= new Date(latestMsg.created_at)) return
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
      <div className="min-h-screen bg-background">
        <header className="border-b border-border/50 bg-card">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <Skeleton className="h-8 w-40" />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-4 w-48 mb-6" />
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
          </div>
          <Skeleton className="h-96 rounded-lg" />
        </main>
      </div>
    )
  }

  // Status filter + sorting logic
  const statusPriority: Record<string, number> = {
    under_review: 0, approved: 1, funded: 2, completed: 3, denied: 4, cancelled: 5,
  }

  let filtered = allDeals
  if (statusFilter) filtered = filtered.filter(d => d.status === statusFilter)
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    filtered = filtered.filter(d => {
      const agentName = d.agents ? `${d.agents.first_name || ''} ${d.agents.last_name || ''}`.toLowerCase() : ''
      return d.property_address?.toLowerCase().includes(q) || agentName.includes(q)
    })
  }
  filtered = [...filtered].sort((a, b) => {
    const pa = statusPriority[a.status] ?? 99
    const pb = statusPriority[b.status] ?? 99
    if (pa !== pb) return pa - pb
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
  const totalPages = Math.max(1, Math.ceil(filtered.length / DEALS_PER_PAGE))
  const page = Math.min(currentPage, totalPages)
  const paged = filtered.slice((page - 1) * DEALS_PER_PAGE, page * DEALS_PER_PAGE)

  // Overdue/attention alerts
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const todayMs = new Date(todayStr + 'T00:00:00').getTime()
  const threeDaysAgo = todayMs - (3 * 24 * 60 * 60 * 1000)
  const overdueClosings = allDeals.filter(d => d.status === 'funded' && new Date(d.closing_date + 'T00:00:00').getTime() < todayMs)
  const staleReviews = allDeals.filter(d => d.status === 'under_review' && new Date(d.created_at).getTime() < threeDaysAgo)
  const approvedNoFunding = allDeals.filter(d => {
    if (d.status !== 'approved') return false
    return (todayMs - new Date(d.created_at).getTime()) / (24 * 60 * 60 * 1000) > 5
  })
  const totalAlerts = overdueClosings.length + staleReviews.length + approvedNoFunding.length

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-14">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-8 sm:h-9 w-auto" />
              <Separator orientation="vertical" className="h-6 bg-border/30" />
              <span className="text-sm font-medium text-muted-foreground">Admin</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-primary hidden sm:block">{profile?.full_name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="relative h-8 w-8 text-muted-foreground hover:text-primary"
                onClick={() => router.push('/admin/messages')}
                title="Messages"
              >
                <MessageSquare size={16} />
                {stats.unreadAgentMessages > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold bg-red-600 text-white animate-pulse">
                    {stats.unreadAgentMessages}
                  </span>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-primary"
                onClick={() => router.push('/admin/settings')}
                title="Settings"
              >
                <Settings size={16} />
              </Button>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Welcome */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-foreground">
            Welcome back, {profile?.full_name?.split(' ')[0]}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Here&apos;s what&apos;s happening with Firm Funds.</p>
        </div>

        {/* Quick Links */}
        <div className="flex flex-wrap gap-2 mb-6">
          {[
            { label: 'Brokerages', icon: Building2, path: '/admin/brokerages', badge: stats.pendingKycCount + stats.pendingBankingCount },
            { label: 'Reports', icon: BarChart3, path: '/admin/reports' },
            { label: 'Payments', icon: DollarSign, path: '/admin/payments' },
            { label: 'Audit Trail', icon: Shield, path: '/admin/audit' },
          ].map(link => (
            <Button
              key={link.label}
              variant="outline"
              size="sm"
              className="gap-1.5 border-border/50 hover:border-primary/50 hover:text-primary"
              onClick={() => router.push(link.path)}
            >
              <link.icon size={14} className="text-primary" />
              {link.label}
              {link.badge ? (
                <Badge className="ml-1 h-4 min-w-[16px] px-1 text-[10px] font-bold animate-pulse bg-red-600 text-white border-red-600">
                  {link.badge}
                </Badge>
              ) : null}
            </Button>
          ))}
        </div>

        {/* PENDING ACTIONS */}
        {(pendingBankingAgents.length > 0 || pendingKycAgents.length > 0) && (
          <Card className="mb-6 border-amber-500/40">
            <CardHeader className="py-3 px-4 bg-amber-500/5 border-b border-amber-500/20">
              <CardTitle className="text-sm font-semibold flex items-center gap-2 text-amber-400">
                <AlertTriangle size={16} />
                Pending Actions ({pendingBankingAgents.length + pendingKycAgents.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 divide-y divide-border/50">
              {pendingBankingAgents.map(agent => (
                <div key={agent.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex-1 min-w-[250px]">
                      <div className="flex items-center gap-2 mb-1">
                        <CreditCard size={14} className="text-blue-400" />
                        <span className="text-xs font-bold uppercase tracking-wider text-blue-400">Banking Approval</span>
                      </div>
                      <p className="text-sm font-medium text-foreground">
                        {agent.first_name} {agent.last_name}
                        <span className="text-xs font-normal ml-2 text-muted-foreground">
                          {agent.brokerages?.name || ''} · {agent.email}
                        </span>
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-xs font-mono text-muted-foreground">
                          {revealedBankingIds.has(agent.id)
                            ? `Transit: ${agent.banking_submitted_transit} · Inst: ${agent.banking_submitted_institution} · Acct: ${agent.banking_submitted_account}`
                            : 'Transit: ••••• · Inst: ••• · Acct: •••••••'
                          }
                        </p>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-foreground"
                          onClick={() => setRevealedBankingIds(prev => {
                            const next = new Set(prev)
                            if (next.has(agent.id)) next.delete(agent.id); else next.add(agent.id)
                            return next
                          })}
                        >
                          {revealedBankingIds.has(agent.id) ? <EyeOff size={14} /> : <Eye size={14} />}
                        </Button>
                      </div>
                      {agent.banking_submitted_at && (
                        <p className="text-[10px] mt-0.5 text-muted-foreground/60">
                          Submitted {new Date(agent.banking_submitted_at).toLocaleDateString('en-CA')}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {agent.preauth_form_path && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1 text-xs"
                          onClick={async () => {
                            const { data } = await supabase.storage.from('agent-preauth-forms').createSignedUrl(agent.preauth_form_path, 300)
                            if (data?.signedUrl) setPreauthViewUrl(data.signedUrl)
                          }}
                        >
                          <Eye size={12} />
                          Pre-Auth Form
                        </Button>
                      )}
                      {rejectingAgentId === agent.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder="Reason..."
                            className="w-48 h-8 text-xs"
                            autoFocus
                          />
                          <Button
                            size="sm"
                            variant="destructive"
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
                            className="text-xs"
                          >
                            Confirm
                          </Button>
                          <Button variant="ghost" size="sm" className="text-xs" onClick={() => { setRejectingAgentId(null); setRejectReason('') }}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <>
                          <Button
                            size="sm"
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
                            className="text-xs bg-emerald-600 hover:bg-emerald-700"
                          >
                            {actionLoading === agent.id ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" />Approving...</> : 'Approve'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setRejectingAgentId(agent.id)}
                            className="text-xs text-red-400 border-red-400/30 hover:bg-red-400/10"
                          >
                            Reject
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {pendingKycAgents.map(agent => (
                <div key={agent.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex-1 min-w-[250px]">
                      <div className="flex items-center gap-2 mb-1">
                        <Shield size={14} className="text-purple-400" />
                        <span className="text-xs font-bold uppercase tracking-wider text-purple-400">KYC Review</span>
                      </div>
                      <p className="text-sm font-medium text-foreground">
                        {agent.first_name} {agent.last_name}
                        <span className="text-xs font-normal ml-2 text-muted-foreground">
                          {agent.brokerages?.name || ''} · {agent.email}
                        </span>
                      </p>
                      {agent.kyc_submitted_at && (
                        <p className="text-[10px] mt-0.5 text-muted-foreground/60">
                          Submitted {new Date(agent.kyc_submitted_at).toLocaleDateString('en-CA')}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => router.push('/admin/brokerages')}
                      className="text-xs text-purple-400 border-purple-400/30 hover:bg-purple-400/10"
                    >
                      Review in Brokerages
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Pre-auth form viewer */}
        <Dialog open={!!preauthViewUrl} onOpenChange={() => setPreauthViewUrl(null)}>
          <DialogContent className="max-w-3xl h-[80vh] p-0">
            <DialogHeader className="px-4 py-3 border-b border-border/50">
              <DialogTitle>Pre-Authorization Form</DialogTitle>
            </DialogHeader>
            {preauthViewUrl && (
              <iframe src={preauthViewUrl} className="w-full flex-1 rounded-b-lg" style={{ height: 'calc(80vh - 60px)' }} />
            )}
          </DialogContent>
        </Dialog>

        {/* Attention Alerts */}
        {totalAlerts > 0 && (
          <Card className="mb-6 border-red-500/30 bg-red-500/5">
            <CardHeader className="py-2.5 px-4 border-b border-red-500/20">
              <CardTitle className="text-xs font-semibold flex items-center gap-2 text-red-400">
                <AlertTriangle size={14} />
                {totalAlerts} deal{totalAlerts !== 1 ? 's' : ''} need{totalAlerts === 1 ? 's' : ''} attention
              </CardTitle>
            </CardHeader>
            <CardContent className="p-2 space-y-1">
              {overdueClosings.map(deal => (
                <button
                  key={`overdue-${deal.id}`}
                  className="flex items-center justify-between gap-2 w-full py-2 px-3 rounded-md bg-red-500/5 hover:bg-red-500/10 transition-colors text-left"
                  onClick={() => router.push(`/admin/deals/${deal.id}`)}
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <Clock size={11} className="text-red-400 shrink-0" />
                    <span className="text-xs text-red-300 truncate">
                      <strong>Overdue:</strong> {deal.property_address} — closing was {new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                    </span>
                  </span>
                  <ChevronRight size={12} className="text-red-400 shrink-0" />
                </button>
              ))}
              {staleReviews.map(deal => (
                <button
                  key={`stale-${deal.id}`}
                  className="flex items-center justify-between gap-2 w-full py-2 px-3 rounded-md bg-amber-500/5 hover:bg-amber-500/10 transition-colors text-left"
                  onClick={() => router.push(`/admin/deals/${deal.id}`)}
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <Clock size={11} className="text-amber-400 shrink-0" />
                    <span className="text-xs text-amber-300 truncate">
                      <strong>Stale review:</strong> {deal.property_address} — {Math.floor((todayMs - new Date(deal.created_at).getTime()) / (24 * 60 * 60 * 1000))} days
                    </span>
                  </span>
                  <ChevronRight size={12} className="text-amber-400 shrink-0" />
                </button>
              ))}
              {approvedNoFunding.map(deal => (
                <button
                  key={`nofund-${deal.id}`}
                  className="flex items-center justify-between gap-2 w-full py-2 px-3 rounded-md bg-blue-500/5 hover:bg-blue-500/10 transition-colors text-left"
                  onClick={() => router.push(`/admin/deals/${deal.id}`)}
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <Clock size={11} className="text-blue-400 shrink-0" />
                    <span className="text-xs text-blue-300 truncate">
                      <strong>Pending funding:</strong> {deal.property_address} — approved {Math.floor((todayMs - new Date(deal.created_at).getTime()) / (24 * 60 * 60 * 1000))} days ago
                    </span>
                  </span>
                  <ChevronRight size={12} className="text-blue-400 shrink-0" />
                </button>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Status Filter Tabs */}
        <div className="flex flex-wrap gap-1.5 mb-4">
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
            const unreadInStatus = tab.value
              ? allDeals.filter(d => d.status === tab.value && stats.dealsWithUnreadMessages.includes(d.id)).length
              : stats.unreadAgentMessages
            const showBadge = (tab.value === 'under_review' && count > 0) || unreadInStatus > 0
            return (
              <Button
                key={tab.label}
                variant={isActive ? 'default' : 'outline'}
                size="sm"
                className={`gap-1.5 text-xs ${!isActive ? 'border-border/50 text-muted-foreground hover:text-foreground' : ''}`}
                onClick={() => { setStatusFilter(tab.value); setCurrentPage(1) }}
              >
                {tab.label}
                {showBadge ? (
                  <Badge className="h-4 min-w-[16px] px-1 text-[10px] font-bold animate-pulse bg-red-600 text-white border-red-600">
                    {unreadInStatus > 0 ? unreadInStatus : count}
                  </Badge>
                ) : (
                  <span className="text-xs opacity-50">({count})</span>
                )}
              </Button>
            )
          })}
        </div>

        {/* Deals Table */}
        <Card className="border-border/50">
          <CardHeader className="py-3 px-4 border-b border-border/50">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">
                  {statusFilter ? `${statusFilter.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} Deals` : 'All Deals'}
                </CardTitle>
                {statusFilter && (
                  <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs text-muted-foreground" onClick={() => { setStatusFilter(null); setCurrentPage(1) }}>
                    <X size={12} /> Clear
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">{filtered.length} deal{filtered.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
                <Input
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
                  placeholder="Search by address or agent..."
                  className="pl-9 h-9 w-full sm:w-72 bg-secondary/50 border-border/50"
                />
              </div>
            </div>
          </CardHeader>

          {paged.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <FileText className="mx-auto mb-4 text-muted-foreground/30" size={40} />
              <p className="text-sm font-medium text-muted-foreground">
                {searchQuery || statusFilter ? 'No deals match your search' : 'No deals yet'}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {searchQuery || statusFilter ? 'Try adjusting your search or clearing the filter.' : 'Deals will appear here once agents submit advance requests.'}
              </p>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent border-border/50">
                      <TableHead className="text-xs font-semibold uppercase tracking-wider">Property</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider">Agent</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider">Status</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider">Commission</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider">Advance</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider">Closing</TableHead>
                      <TableHead className="w-8"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.map((deal) => {
                      const hasUnread = stats.dealsWithUnreadMessages.includes(deal.id)
                      return (
                      <TableRow
                        key={deal.id}
                        className="cursor-pointer border-border/30 hover:bg-secondary/50 transition-colors"
                        onClick={() => router.push(`/admin/deals/${deal.id}${hasUnread ? '#messages' : ''}`)}
                      >
                        <TableCell className="text-sm font-medium">
                          <span className="flex items-center gap-1.5">
                            {deal.property_address}
                            {stats.dealsWithUnreadMessages.includes(deal.id) && (
                              <Badge className="gap-0.5 px-1.5 py-0 text-[10px] font-bold h-5 bg-red-600 text-white border-red-600">
                                <MessageSquare size={10} /> New
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {deal.agents ? `${deal.agents.first_name || ''} ${deal.agents.last_name || ''}`.trim() : '—'}
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-md" style={getStatusBadgeStyle(deal.status)}>
                            {formatStatusLabel(deal.status)}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm font-medium">{formatCurrency(deal.gross_commission)}</TableCell>
                        <TableCell className={`text-sm font-bold ${['denied', 'cancelled'].includes(deal.status) ? 'text-red-400' : 'text-emerald-400'}`}>
                          {formatCurrency(deal.advance_amount)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                        </TableCell>
                        <TableCell><ChevronRight size={14} className="text-muted-foreground/40" /></TableCell>
                      </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden space-y-2 p-3">
                {paged.map((deal) => {
                  const hasUnread = stats.dealsWithUnreadMessages.includes(deal.id)
                  return (
                  <Card
                    key={deal.id}
                    className="cursor-pointer border-border/30 hover:bg-secondary/50 transition-colors"
                    onClick={() => router.push(`/admin/deals/${deal.id}${hasUnread ? '#messages' : ''}`)}
                  >
                    <CardContent className="p-3.5">
                      <div className="flex items-start gap-2 mb-2">
                        <p className="text-sm font-bold text-foreground truncate flex-1">{deal.property_address}</p>
                        {stats.dealsWithUnreadMessages.includes(deal.id) && (
                          <Badge className="gap-0.5 px-1.5 py-0 text-[10px] font-bold shrink-0 bg-red-600 text-white border-red-600">
                            <MessageSquare size={10} /> New
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <p className="text-sm text-muted-foreground truncate">
                          {deal.agents ? `${deal.agents.first_name || ''} ${deal.agents.last_name || ''}`.trim() : '—'}
                        </p>
                        <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-md whitespace-nowrap" style={getStatusBadgeStyle(deal.status)}>
                          {formatStatusLabel(deal.status)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs text-muted-foreground">Commission</p>
                          <p className="text-sm font-medium">{formatCurrency(deal.gross_commission)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Advance</p>
                          <p className={`text-sm font-bold ${['denied', 'cancelled'].includes(deal.status) ? 'text-red-400' : 'text-emerald-400'}`}>
                            {formatCurrency(deal.advance_amount)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Closing</p>
                          <p className="text-sm text-muted-foreground">
                            {new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  )
                })}
              </div>
            </>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-3 flex items-center justify-between border-t border-border/50">
              <p className="text-xs text-muted-foreground">
                {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 border-border/50"
                  disabled={page === 1}
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={14} />
                </Button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  let pageNum: number
                  if (totalPages <= 5) pageNum = i + 1
                  else if (page <= 3) pageNum = i + 1
                  else if (page >= totalPages - 2) pageNum = totalPages - 4 + i
                  else pageNum = page - 2 + i
                  return (
                    <Button
                      key={pageNum}
                      variant={pageNum === page ? 'default' : 'outline'}
                      size="icon"
                      className={`h-8 w-8 text-xs ${pageNum !== page ? 'border-border/50' : ''}`}
                      onClick={() => setCurrentPage(pageNum)}
                    >
                      {pageNum}
                    </Button>
                  )
                })}
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 border-border/50"
                  disabled={page === totalPages}
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          )}
        </Card>
      </main>
    </div>
  )
}
