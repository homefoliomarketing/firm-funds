'use client'

import { useEffect, useState, useMemo } from 'react'
import Image from 'next/image'
import type { User } from '@supabase/supabase-js'
import type { UserProfile } from '@/types/database'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, Building2, DollarSign, Clock, ChevronRight, Search, X,
  ChevronLeft, BarChart3, Shield, MessageSquare, AlertTriangle, Settings,
  CreditCard, Eye, EyeOff, ClipboardList, TimerReset, Inbox,
  TrendingUp, Mail, ChevronDown,
} from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { approveAgentBanking, rejectAgentBanking } from '@/lib/actions/profile-actions'
import { getAgentPreauthFormSignedUrl, getOverdueSettlementDeals } from '@/lib/actions/admin-actions'
import { getStatusBadgeClass, formatStatusLabel } from '@/lib/constants'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { hasCapability } from '@/lib/access'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { DealNumber } from '@/components/DealNumber'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'

interface DashboardStats {
  underReviewDeals: number
  pendingKycCount: number
  pendingBankingCount: number
  unreadAgentMessages: number
  dealsWithUnreadMessages: string[]
  firmDealPending: number
}

// Shapes returned by the dashboard SELECTs. PostgREST nests one-to-many
// FKs but our admin queries hit unique 1:1 relations (deal -> single agent,
// agent -> single brokerage), so we model the joined fields as the singular
// row shape directly — the runtime payload matches.
type DashboardDeal = {
  id: string
  status: string
  deal_number: string | null
  property_address: string | null
  closing_date: string | null
  advance_amount: number | null
  gross_commission: number | null
  created_at: string
  assigned_to_user_id: string | null
  // See note on `brokerages`. We pick the first element defensively below.
  agents?: { first_name: string | null; last_name: string | null }[] | { first_name: string | null; last_name: string | null } | null
}

type DashboardBankingAgent = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  banking_submitted_at: string | null
  banking_approval_status: string | null
  banking_submitted_transit: string | null
  banking_submitted_institution: string | null
  banking_submitted_account: string | null
  preauth_form_path: string | null
  brokerage_id: string | null
  // PostgREST types nested relations as arrays. Runtime is a single row for
  // a many-to-one FK; we read the optional `?.name` defensively in render.
  brokerages?: { name: string | null }[] | { name: string | null } | null
}

type DashboardKycAgent = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  kyc_status: string | null
  kyc_submitted_at: string | null
  kyc_document_path: string | null
  kyc_document_type: string | null
  brokerage_id: string | null
  // PostgREST types nested relations as arrays. Runtime is a single row for
  // a many-to-one FK; we read the optional `?.name` defensively in render.
  brokerages?: { name: string | null }[] | { name: string | null } | null
}

type OverdueSettlementRow = {
  deal_id: string
  property_address: string | null
  agent_name: string | null
  brokerage_name: string | null
  due_date: string | null
  days_overdue: number
  outstanding: number
  amount_due: number
}

export default function AdminDashboard() {
  // `user` is captured for parity with other pages; not currently rendered.
  const [, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [stats, setStats] = useState<DashboardStats>({
    underReviewDeals: 0,
    pendingKycCount: 0,
    pendingBankingCount: 0,
    unreadAgentMessages: 0,
    dealsWithUnreadMessages: [],
    firmDealPending: 0,
  })
  const [allDeals, setAllDeals] = useState<DashboardDeal[]>([])
  const [overdueSettlements, setOverdueSettlements] = useState<OverdueSettlementRow[]>([])
  const [pendingBankingAgents, setPendingBankingAgents] = useState<DashboardBankingAgent[]>([])
  const [pendingKycAgents, setPendingKycAgents] = useState<DashboardKycAgent[]>([])
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [rejectingAgentId, setRejectingAgentId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [preauthViewUrl, setPreauthViewUrl] = useState<string | null>(null)
  const [revealedBankingIds, setRevealedBankingIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const DEALS_PER_PAGE = 15
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

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

      let deals: DashboardDeal[] | null = null
      let bankingAgents: DashboardBankingAgent[] | null = null
      let kycAgents: DashboardKycAgent[] | null = null
      let allMsgs: { deal_id: string; sender_role: string; created_at: string }[] | null = null
      let dismissals: { deal_id: string; dismissed_at: string }[] | null = null
      let firmDealPendingCount: number | null = null
      try {
        const [
          { data: dealsRes, error: dealsErr },
          { data: bankingRes },
          { data: kycRes },
          { data: msgsRes },
          { data: dismissalsRes },
          { count: firmDealCountRes },
        ] = await Promise.all([
        // Safety cap. Long-term this should paginate/aggregate server-side.
        supabase.from('deals').select('*, agents(first_name, last_name)').order('created_at', { ascending: false }).limit(500),
        // TODO: banking_submitted_transit/institution/account should be fetched
        // lazily when an admin clicks into a specific pending row, not bulk-loaded
        // on dashboard mount. Removed from this query to limit PII exposure.
        supabase.from('agents').select('id, first_name, last_name, email, banking_submitted_at, banking_approval_status, preauth_form_path, brokerage_id, brokerages(name)').eq('banking_approval_status', 'pending').limit(500),
        supabase.from('agents').select('id, first_name, last_name, email, kyc_status, kyc_submitted_at, kyc_document_path, kyc_document_type, brokerage_id, brokerages(name)').eq('kyc_status', 'submitted').limit(500),
        supabase.from('deal_messages').select('deal_id, sender_role, created_at').order('created_at', { ascending: false }),
        supabase.from('admin_message_dismissals').select('deal_id, dismissed_at'),
        // Firm-deal review queue count. Three statuses sit in the queue
        // waiting for the admin: unmatched (needs human resolver),
        // awaiting_approval (parsed + matched, awaiting Send click), and
        // errored. RLS limits this to firm_funds_admin / super_admin.
        supabase
          .from('firm_deal_events')
          .select('id', { count: 'exact', head: true })
          .in('status', ['unmatched', 'awaiting_approval', 'errored']),
        ])
        // The deals query is the primary load — a PostgREST error here means
        // the queue could not be fetched, which is different from an empty
        // queue. Surface it so the UI can show a load-failed message.
        if (dealsErr) throw dealsErr
        deals = (dealsRes as DashboardDeal[] | null)
        bankingAgents = (bankingRes as DashboardBankingAgent[] | null)
        kycAgents = (kycRes as DashboardKycAgent[] | null)
        allMsgs = msgsRes
        dismissals = dismissalsRes
        firmDealPendingCount = firmDealCountRes ?? null
      } catch {
        // A failed primary load should not look like a genuinely empty queue.
        setLoadError(true)
        setLoading(false)
        return
      }

      setPendingBankingAgents((bankingAgents || []) as DashboardBankingAgent[])
      setPendingKycAgents((kycAgents || []) as DashboardKycAgent[])
      const allDealsList = (deals || []) as DashboardDeal[]

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

      const underReviewList = allDealsList.filter(d => d.status === 'under_review')

      setStats({
        underReviewDeals: underReviewList.length,
        pendingKycCount: kycAgents?.length || 0,
        pendingBankingCount: bankingAgents?.length || 0,
        unreadAgentMessages: dealsWithUnread.length,
        dealsWithUnreadMessages: dealsWithUnread,
        firmDealPending: firmDealPendingCount ?? 0,
      })
      setAllDeals(allDealsList)

      // Settlement-overdue deals (funded, past due_date, no strike yet)
      const overdueResult = await getOverdueSettlementDeals()
      if (overdueResult.success) setOverdueSettlements((overdueResult.data as OverdueSettlementRow[]) || [])

      setLoading(false)
    }
    loadDashboard()
  }, [router, supabase])

  // Poll for new messages + firm-deal review queue every 30 seconds. Cheap
  // count queries — no row payload pulled across the wire for either.
  useEffect(() => {
    if (loading) return
    const interval = setInterval(async () => {
      try {
        const [
          { data: allMsgs },
          { data: dismissals },
          { count: firmDealPendingCount },
        ] = await Promise.all([
          supabase.from('deal_messages').select('deal_id, sender_role, created_at').order('created_at', { ascending: false }),
          supabase.from('admin_message_dismissals').select('deal_id, dismissed_at'),
          supabase
            .from('firm_deal_events')
            .select('id', { count: 'exact', head: true })
            .in('status', ['unmatched', 'awaiting_approval', 'errored']),
        ])
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
        setStats(prev => ({
          ...prev,
          unreadAgentMessages: dealsWithUnread.length,
          dealsWithUnreadMessages: dealsWithUnread,
          firmDealPending: firmDealPendingCount ?? prev.firmDealPending,
        }))
      } catch {
        // Silently fail — don't break the dashboard
      }
    }, 30000)
    return () => clearInterval(interval)
  }, [loading, supabase])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background" role="status" aria-label="Loading dashboard">
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

  // Status filter + sorting logic. 'offered' sits after the active in-flight
  // statuses but ahead of terminal ones — it's a placeholder waiting on the
  // brokerage to submit, so admins should see them grouped near the top but
  // below anything actively under review.
  const statusPriority: Record<string, number> = {
    under_review: 0, approved: 1, funded: 2, offered: 3, completed: 4, denied: 5, cancelled: 6,
  }

  // PostgREST joins surface as arrays even on singular FKs; normalize.
  const pickAgent = (rel: DashboardDeal['agents']) => {
    if (!rel) return null
    return Array.isArray(rel) ? rel[0] ?? null : rel
  }

  let filtered = allDeals
  if (statusFilter) filtered = filtered.filter(d => d.status === statusFilter)
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    filtered = filtered.filter(d => {
      const a = pickAgent(d.agents)
      const agentName = a ? `${a.first_name || ''} ${a.last_name || ''}`.toLowerCase() : ''
      return d.property_address?.toLowerCase().includes(q)
        || agentName.includes(q)
        || (d.deal_number?.toLowerCase().includes(q) ?? false)
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

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <Image src="/brand/white.png" alt="Firm Funds" width={120} height={40} className="h-9 sm:h-10 w-auto" />
              <Separator orientation="vertical" className="h-6 bg-border/30" />
              <span className="text-sm font-semibold tracking-wide text-muted-foreground">Admin</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-primary font-medium hidden sm:block">{profile?.full_name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="relative h-10 w-10 text-muted-foreground hover:text-primary"
                onClick={() => router.push('/admin/messages')}
                title="Messages"
                aria-label={`Messages${stats.unreadAgentMessages ? `, ${stats.unreadAgentMessages} unread` : ''}`}
              >
                <Mail size={22} />
                {stats.unreadAgentMessages ? (
                  <Badge className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] px-1 text-[10px] font-bold bg-red-600 text-white border-red-600">
                    {stats.unreadAgentMessages}
                  </Badge>
                ) : null}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 text-muted-foreground hover:text-primary"
                onClick={() => router.push('/admin/settings')}
                title="Settings"
                aria-label="Settings"
              >
                <Settings size={22} />
              </Button>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome + Quick Links */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Welcome back, {profile?.full_name?.split(' ')[0]}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">Here&apos;s what&apos;s happening with Firm Funds.</p>
          </div>
          <nav aria-label="Admin quick links" className="flex items-center gap-2 flex-wrap">
            {[
              // Each link is shown only to tiers that can actually use the page,
              // so nobody clicks into a screen that just bounces them back.
              ...(hasCapability(profile, 'kyc.verify') ? [{ label: 'Brokerages', icon: Building2, path: '/admin/brokerages', badge: stats.pendingKycCount + stats.pendingBankingCount }] : []),
              ...(hasCapability(profile, 'firmdeal.review') ? [{ label: 'Firm Deal Review', icon: Inbox, path: '/admin/firm-deal-review', badge: stats.firmDealPending }] : []),
              // Assignments tab intentionally hidden for now: the underwriter
              // queue feature isn't wired and there's a single underwriter. The
              // /admin/assignments page + assignment-actions remain in the repo
              // so this is a one-line re-enable when the feature is picked up.
              ...(hasCapability(profile, 'deal.underwrite') ? [{ label: 'Pending Cures', icon: ClipboardList, path: '/admin/pending-elections' }] : []),
              ...(hasCapability(profile, 'money.write') ? [{ label: 'Payments', icon: DollarSign, path: '/admin/payments' }] : []),
              // Audit Trail + Staff & Roles now live under Settings; Messages moved
              // to the Mail icon in the header.
            ].map(link => (
              <Button
                key={link.label}
                variant="outline"
                size="sm"
                className="gap-1.5 border-border/50 hover:border-primary/40 hover:text-primary transition-colors"
                onClick={() => router.push(link.path)}
              >
                <link.icon size={14} className="text-primary/80" />
                {link.label}
                {link.badge ? (
                  <Badge className="ml-1 h-4 min-w-[16px] px-1 text-[10px] font-bold bg-red-600 text-white border-red-600">
                    {link.badge}
                  </Badge>
                ) : null}
              </Button>
            ))}
            {/* Portfolio + Reports combined into a single button. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-border/50 hover:border-primary/40 hover:text-primary transition-colors"
                  />
                }
              >
                <TrendingUp size={14} className="text-primary/80" />
                Portfolio & Reports
                <ChevronDown size={14} className="text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => router.push('/admin/portfolio')}>
                  <TrendingUp size={14} className="text-primary/80" />
                  Portfolio
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push('/admin/reports')}>
                  <BarChart3 size={14} className="text-primary/80" />
                  Reports
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>
        </div>

        {/* KPI Stat Cards */}
        <section aria-label="Key metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Total Deals', value: allDeals.length, icon: FileText, accent: 'text-primary' },
            { label: 'Under Review', value: stats.underReviewDeals, icon: Clock, accent: 'text-status-blue' },
            { label: 'Pending Actions', value: stats.pendingKycCount + stats.pendingBankingCount, icon: AlertTriangle, accent: 'text-status-amber' },
            { label: 'Unread Messages', value: stats.unreadAgentMessages, icon: MessageSquare, accent: 'text-status-red' },
          ].map(stat => (
            <Card key={stat.label} className="border-border/40 bg-card/60">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{stat.label}</span>
                  <stat.icon size={15} className={`${stat.accent} opacity-60`} />
                </div>
                <p className="text-2xl font-bold tracking-tight text-foreground">{stat.value}</p>
              </CardContent>
            </Card>
          ))}
        </section>

        {/* PENDING ACTIONS */}
        {(pendingBankingAgents.length > 0 || pendingKycAgents.length > 0) && (
          <section aria-label="Pending approvals">
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
                          {(Array.isArray(agent.brokerages) ? agent.brokerages[0]?.name : agent.brokerages?.name) || ''} · {agent.email || 'No email'}
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
                            const result = await getAgentPreauthFormSignedUrl({ agentId: agent.id })
                            if (result.success && typeof result.data?.signedUrl === 'string') {
                              setPreauthViewUrl(result.data.signedUrl)
                            }
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
                            {actionLoading === agent.id ? <><LoadingSpinner label="" /><span className="ml-1">Approving...</span></> : 'Approve'}
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
                          {(Array.isArray(agent.brokerages) ? agent.brokerages[0]?.name : agent.brokerages?.name) || ''} · {agent.email || 'No email'}
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
          </section>
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

        {/* Late Settlement Alerts — deals past their Payment Due Date that
            still need a human strike-or-skip decision */}
        {overdueSettlements.length > 0 && (
          <section aria-label="Late settlements" className="mb-6">
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardHeader className="py-3 px-4 bg-amber-500/5 border-b border-amber-500/20">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-amber-400">
                  <TimerReset size={16} />
                  {overdueSettlements.length} brokerage settlement{overdueSettlements.length === 1 ? '' : 's'} past due. Review for strike
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 divide-y divide-border/50">
                {overdueSettlements.map(d => (
                  <div key={d.deal_id} className="px-4 py-3 flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">
                        {d.property_address}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {d.agent_name ? `${d.agent_name} · ` : ''}
                        {d.brokerage_name || 'Brokerage on file'}
                      </p>
                      <p className="text-[11px] text-amber-300/80 mt-1">
                        Due {d.due_date ? formatDate(d.due_date) : '-'}
                        <span className="text-muted-foreground/70"> · {d.days_overdue} day{d.days_overdue === 1 ? '' : 's'} overdue</span>
                        <span className="text-muted-foreground/70"> · Outstanding {formatCurrency(d.outstanding)} of {formatCurrency(d.amount_due)}</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => router.push(`/admin/deals/${d.deal_id}`)}
                      className="text-xs gap-1.5 border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                    >
                      Review deal
                      <ChevronRight size={12} />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        )}

        {/* Deals Section */}
        <section aria-label="Deals">
        {/* Status Filter Tabs */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {[
            { label: 'All', value: null },
            { label: 'Offered', value: 'offered' },
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
                variant={isActive ? 'default' : 'ghost'}
                size="sm"
                className={`gap-1.5 text-xs ${isActive ? 'bg-primary/15 text-primary ring-1 ring-primary/30 hover:bg-primary/20' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => { setStatusFilter(tab.value); setCurrentPage(1) }}
              >
                {tab.label}
                {showBadge ? (
                  <Badge className="h-4 min-w-[16px] px-1 text-[10px] font-bold bg-red-600 text-white border-red-600">
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
        <Card className="border-border/40 shadow-lg shadow-black/20 overflow-hidden">
          <CardHeader className="py-4 px-5 sm:px-6 border-b border-border/40 bg-card/80">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3">
                <CardTitle className="text-base font-semibold">
                  {statusFilter ? `${statusFilter.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} Deals` : 'All Deals'}
                </CardTitle>
                <span className="text-xs text-muted-foreground/60 tabular-nums">{filtered.length}</span>
                {statusFilter && (
                  <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs text-muted-foreground" onClick={() => { setStatusFilter(null); setCurrentPage(1) }}>
                    <X size={12} /> Clear
                  </Button>
                )}
              </div>
              <div className="relative">
                <Label htmlFor="deal-search" className="sr-only">Search deals by deal number, address, or agent</Label>
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/40" />
                <Input
                  id="deal-search"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
                  placeholder="Search by deal #, address, or agent..."
                  className="pl-9 h-9 w-full sm:w-72 bg-secondary/30 border-border/30 placeholder:text-muted-foreground/40"
                />
              </div>
            </div>
          </CardHeader>

          {loadError ? (
            <div role="alert" className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <AlertTriangle size={28} className="text-status-amber" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-foreground">We could not load deals.</p>
                <p className="text-xs text-muted-foreground mt-1">Refresh to try again.</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                Refresh
              </Button>
            </div>
          ) : paged.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={searchQuery || statusFilter ? 'No deals match your filters' : 'No deals yet'}
              description={
                searchQuery || statusFilter
                  ? 'Try adjusting your search or clearing the filter.'
                  : 'Deals will appear here once agents submit advance requests.'
              }
            />
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent border-border/50">
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Property</TableHead>
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Agent</TableHead>
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Status</TableHead>
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Commission</TableHead>
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Advance</TableHead>
                      <TableHead className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Closing</TableHead>
                      <TableHead className="w-8"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.map((deal) => {
                      const hasUnread = stats.dealsWithUnreadMessages.includes(deal.id)
                      return (
                      <TableRow
                        key={deal.id}
                        className="cursor-pointer border-border/30 hover:bg-white/[0.03] transition-colors group"
                        onClick={() => router.push(`/admin/deals/${deal.id}${hasUnread ? '#messages' : ''}`)}
                      >
                        <TableCell className="text-[13px] font-semibold group-hover:text-primary transition-colors">
                          <span className="flex items-center gap-1.5">
                            {deal.property_address}
                            <DealNumber value={deal.deal_number} />
                            {stats.dealsWithUnreadMessages.includes(deal.id) && (
                              <Badge className="gap-0.5 px-1.5 py-0 text-[10px] font-bold h-5 bg-red-600 text-white border-red-600">
                                <MessageSquare size={10} /> New
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {(() => {
                            const a = pickAgent(deal.agents)
                            return a ? `${a.first_name || ''} ${a.last_name || ''}`.trim() : '-'
                          })()}
                        </TableCell>
                        <TableCell>
                          <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-md ${getStatusBadgeClass(deal.status)}`}>
                            {formatStatusLabel(deal.status)}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          {deal.status === 'offered'
                            // Offered rows carry $0 placeholders until the
                            // brokerage submits real numbers — showing
                            // "$0.00" would be misleading.
                            ? <span className="text-muted-foreground/50">Pending</span>
                            : formatCurrency(deal.gross_commission ?? 0)}
                        </TableCell>
                        <TableCell className={`text-sm font-bold tabular-nums ${['denied', 'cancelled'].includes(deal.status) ? 'text-status-red' : 'text-primary'}`}>
                          {deal.status === 'offered'
                            ? <span className="text-muted-foreground/50 font-normal">Pending</span>
                            : formatCurrency(deal.advance_amount ?? 0)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {deal.closing_date
                            ? new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
                            : <span className="text-muted-foreground/50">Pending</span>}
                        </TableCell>
                        <TableCell><ChevronRight size={14} className="text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" /></TableCell>
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
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-foreground truncate">{deal.property_address}</p>
                          <DealNumber value={deal.deal_number} className="mt-1" />
                        </div>
                        {stats.dealsWithUnreadMessages.includes(deal.id) && (
                          <Badge className="gap-0.5 px-1.5 py-0 text-[10px] font-bold shrink-0 bg-red-600 text-white border-red-600">
                            <MessageSquare size={10} /> New
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <p className="text-sm text-muted-foreground truncate">
                          {(() => {
                            const a = pickAgent(deal.agents)
                            return a ? `${a.first_name || ''} ${a.last_name || ''}`.trim() : '-'
                          })()}
                        </p>
                        <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-md whitespace-nowrap ${getStatusBadgeClass(deal.status)}`}>
                          {formatStatusLabel(deal.status)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs text-muted-foreground">Commission</p>
                          <p className="text-sm font-medium">
                            {deal.status === 'offered'
                              ? <span className="text-muted-foreground/50">Pending</span>
                              : formatCurrency(deal.gross_commission ?? 0)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Advance</p>
                          <p className={`text-sm font-bold ${['denied', 'cancelled'].includes(deal.status) ? 'text-red-400' : 'text-emerald-400'}`}>
                            {deal.status === 'offered'
                              ? <span className="text-muted-foreground/50 font-normal">Pending</span>
                              : formatCurrency(deal.advance_amount ?? 0)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Closing</p>
                          <p className="text-sm text-muted-foreground">
                            {deal.closing_date
                              ? new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
                              : <span className="text-muted-foreground/50">Pending</span>}
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
                  aria-label="Previous page"
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
                      aria-label={`Go to page ${pageNum}`}
                      aria-current={pageNum === page ? 'page' : undefined}
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
                  aria-label="Next page"
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
        </section>
      </main>
    </div>
  )
}
