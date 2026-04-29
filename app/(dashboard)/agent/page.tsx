'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, Clock, TrendingUp, CheckCircle2, DollarSign,
  PlusCircle, Search, Calendar, ChevronRight, ChevronLeft, CreditCard,
  AlertTriangle, Shield,
} from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { getStatusBadgeClass, formatStatusLabel } from '@/lib/constants'
import { markKycModalSeen } from '@/lib/actions/profile-actions'
import { getAgentBalanceSummary } from '@/lib/actions/account-actions'
import AgentKycGate from '@/components/AgentKycGate'
import AgentHeader from '@/components/AgentHeader'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

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
  const [accountBalance, setAccountBalance] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const DEALS_PER_PAGE = 10
  const router = useRouter()
  const supabase = createClient()

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

        // Fetch account balance
        const balanceResult = await getAgentBalanceSummary(profile.agent_id)
        if (balanceResult.success && balanceResult.data) {
          setAccountBalance(balanceResult.data.balance)
        }
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

  // Summary stats
  const summaryStats = useMemo(() => {
    const active = deals.filter(d => ['under_review', 'approved', 'funded'].includes(d.status))
    const funded = deals.filter(d => d.status === 'funded' || d.status === 'completed')
    const totalAdvanced = funded.reduce((sum, d) => sum + d.advance_amount, 0)
    return {
      total: deals.length,
      active: active.length,
      funded: funded.length,
      totalAdvanced,
    }
  }, [deals])

  // Show KYC verified modal ONCE — localStorage + DB double-lock
  useEffect(() => {
    if (!agent?.id || agent?.kyc_status !== 'verified') return

    // Check localStorage FIRST (instant, same browser)
    const localKey = `kyc_modal_seen_${agent.id}`
    if (localStorage.getItem(localKey) === 'true') return

    // Check DB flag (cross-browser persistence)
    if (agent?.kyc_verified_modal_seen) return

    // Show the modal
    setShowKycVerifiedModal(true)

    // Lock it in localStorage immediately (prevents repeat on refresh)
    localStorage.setItem(localKey, 'true')

    // Also persist to DB via server action (bypasses RLS)
    void markKycModalSeen(agent.id)
  }, [agent?.kyc_status, agent?.id, agent?.kyc_verified_modal_seen])

  // KYC status
  const kycPending = agent && agent.kyc_status === 'pending'
  const kycSubmitted = agent && agent.kyc_status === 'submitted'
  const kycRejected = agent && agent.kyc_status === 'rejected'
  const kycNotVerified = agent && agent.kyc_status !== 'verified'

  // Account activation status (Session 34 — white-label flow)
  const notActivated = agent && !agent.account_activated_at

  if (loading) {
    return (
      <div className="min-h-screen bg-background" role="status" aria-label="Loading deals">
        <header className="border-b border-border/50 bg-card/80">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-10 w-48" />
          </div>
        </header>
        <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-4 w-40 mb-8" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-[88px] rounded-xl" />)}
          </div>
          <Skeleton className="h-96 rounded-xl" />
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* KYC Verified Congratulations Modal */}
      {showKycVerifiedModal && (
        <div
          className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setShowKycVerifiedModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="kyc-verified-title"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-card border border-primary/30 rounded-2xl p-10 max-w-md w-full text-center shadow-2xl shadow-primary/10"
          >
            <div className="w-16 h-16 rounded-full mx-auto mb-5 bg-primary/10 border border-primary/30 flex items-center justify-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 id="kyc-verified-title" className="text-xl font-bold text-foreground mb-2">
              Identity Verified!
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground mb-8">
              Congratulations{agent?.first_name ? `, ${agent.first_name}` : ''}! Your identity has been verified.
              You can now submit advance requests on your deals.
            </p>
            <Button
              onClick={() => setShowKycVerifiedModal(false)}
              className="w-full h-10"
            >
              Get Started
            </Button>
          </div>
        </div>
      )}

      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageName={agent?.brokerages?.name}
      />

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* KYC / Banking status banners */}
        <section aria-label="Account status notifications">
          {/* Activation CTA — single entry point to the setup wizard */}
          {notActivated && (
            <div className="mb-6 rounded-xl p-5 flex items-center justify-between gap-4 bg-primary/10 border border-primary/30">
              <div className="flex items-center gap-3">
                <Shield size={20} className="text-primary shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Activate your account</p>
                  <p className="text-xs mt-0.5 text-muted-foreground">
                    Verify your identity and add banking info so {agent?.brokerages?.name || 'your brokerage'} can submit advance requests on your behalf.
                  </p>
                </div>
              </div>
              <Button
                onClick={() => router.push('/agent/setup')}
                className="shrink-0 whitespace-nowrap bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Continue setup
                <ChevronRight size={14} />
              </Button>
            </div>
          )}

          {/* KYC Banner — only show when activated but somehow KYC issue (rare edge case) */}
          {!notActivated && (kycPending || kycRejected) && (
            <AgentKycGate agent={agent} onKycSubmitted={() => window.location.reload()} />
          )}
          {!notActivated && kycSubmitted && (
            <div className="mb-6 rounded-xl p-4 flex items-center gap-3 bg-status-blue-muted/60 border border-status-blue-border/60" role="status">
              <Clock size={18} className="text-status-blue shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-status-blue">Identity verification submitted</p>
                <p className="text-xs mt-0.5 text-status-blue/60">Your ID is under review. You can browse your dashboard but deal submission is locked until verified.</p>
              </div>
            </div>
          )}

          {/* Banking nudge — show after KYC verified but no banking on file (only when activated) */}
          {!notActivated && agent?.kyc_status === 'verified' && !agent?.banking_verified && !agent?.preauth_form_path && (
          <div className="mb-6 rounded-xl p-4 flex items-center justify-between gap-3 bg-status-amber-muted/60 border border-status-amber-border/60">
            <div className="flex items-center gap-3">
              <CreditCard size={18} className="text-status-amber shrink-0" />
              <div>
                <p className="text-sm font-medium text-status-amber">Set up your banking info</p>
                <p className="text-xs mt-0.5 text-status-amber/60">Upload your pre-authorized debit form now so your first deal isn&apos;t delayed. Banking must be verified before advances can be funded.</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/agent/profile')}
              className="shrink-0 whitespace-nowrap border-status-amber-border text-status-amber hover:bg-status-amber-muted hover:text-status-amber"
            >
              Go to Profile
              <ChevronRight size={14} />
            </Button>
          </div>
        )}

        {/* Banking submitted but not yet verified */}
        {!notActivated && agent?.kyc_status === 'verified' && !agent?.banking_verified && agent?.preauth_form_path && (
          <div className="mb-6 rounded-xl p-4 flex items-center gap-3 bg-status-blue-muted/60 border border-status-blue-border/60" role="status">
            <Clock size={18} className="text-status-blue shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-status-blue">Banking info under review</p>
              <p className="text-xs mt-0.5 text-status-blue/60">Your pre-authorized debit form has been uploaded and is being reviewed. You can submit deals in the meantime.</p>
            </div>
          </div>
        )}

        {/* Account balance warning — show when agent owes money */}
        {accountBalance > 0 && (
          <div className="mb-6 rounded-xl p-4 flex items-center justify-between gap-3 bg-status-amber-muted/60 border border-status-amber-border/60" role="alert">
            <div className="flex items-center gap-3">
              <AlertTriangle size={18} className="text-status-amber shrink-0" />
              <div>
                <p className="text-sm font-medium text-status-amber">Outstanding balance: {formatCurrency(accountBalance)}</p>
                <p className="text-xs mt-0.5 text-status-amber/60">This amount will be deducted from your next advance. View your transaction history for details.</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/agent/account')}
              className="shrink-0 whitespace-nowrap border-status-amber-border text-status-amber hover:bg-status-amber-muted hover:text-status-amber"
            >
              View Ledger
              <ChevronRight size={14} />
            </Button>
          </div>
        )}
        </section>

        {/* Welcome + New Deal Button */}
        <section aria-label="Welcome and actions">
        <div className="mb-6 flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Welcome back, {profile?.full_name?.split(' ')[0]}
            </h1>
            {agent?.brokerages && (
              <p className="text-sm mt-1 text-muted-foreground">{agent.brokerages.name}</p>
            )}
          </div>
          <Button
            onClick={() => kycNotVerified ? null : router.push('/agent/new-deal')}
            disabled={!!kycNotVerified}
            title={kycNotVerified ? 'Complete identity verification to submit deals' : 'Submit a new advance request'}
            className="flex items-center gap-2 h-9"
          >
            <PlusCircle size={16} />
            New Advance Request
          </Button>
        </div>
        </section>

        {/* Summary Stat Cards */}
        {deals.length > 0 && (
          <section aria-label="Deal summary" className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
            {[
              { label: 'Total Deals', value: summaryStats.total, icon: FileText, accent: 'text-primary' },
              { label: 'Active', value: summaryStats.active, icon: TrendingUp, accent: 'text-status-blue' },
              { label: 'Funded', value: summaryStats.funded, icon: CheckCircle2, accent: 'text-status-teal' },
              { label: 'Total Advanced', value: formatCurrency(summaryStats.totalAdvanced), icon: DollarSign, accent: 'text-primary' },
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

        {/* Deals List */}
        <section aria-label="Your deals">
        <Card className="overflow-hidden border-border/40 shadow-lg shadow-black/20">
          {/* Header with search */}
          <div className="px-5 sm:px-6 py-4 border-b border-border/40">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <h2 className="text-base font-bold text-foreground shrink-0">Your Deals</h2>
              {deals.length > 0 && (
                <div className="relative flex-1 max-w-sm ml-auto">
                  <Search size={14} className="text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                  <label htmlFor="agent-search" className="sr-only">Search deals</label>
                  <Input
                    id="agent-search"
                    type="text"
                    placeholder="Search by address..."
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
                    className="pl-9 h-8 text-sm bg-secondary/50"
                  />
                </div>
              )}
            </div>

            {/* Status filter tabs */}
            {deals.length > 3 && (
              <div className="flex flex-wrap gap-1.5 mt-3" role="tablist" aria-label="Filter deals by status">
                <button
                  role="tab"
                  aria-selected={statusFilter === null}
                  onClick={() => { setStatusFilter(null); setCurrentPage(1) }}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                    statusFilter === null
                      ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                  }`}
                >
                  All ({deals.length})
                </button>
                {['under_review', 'approved', 'funded', 'completed', 'denied', 'cancelled'].map(status => {
                  const count = statusCounts[status] || 0
                  if (count === 0) return null
                  return (
                    <button
                      key={status}
                      role="tab"
                      aria-selected={statusFilter === status}
                      onClick={() => { setStatusFilter(statusFilter === status ? null : status); setCurrentPage(1) }}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        statusFilter === status
                          ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                          : 'text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                      }`}
                    >
                      {formatStatusLabel(status)} ({count})
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {deals.length === 0 ? (
            <div className="px-6 py-20 text-center">
              <div className="w-16 h-16 rounded-2xl bg-secondary/80 flex items-center justify-center mx-auto mb-5">
                <FileText className="text-muted-foreground/50" size={28} />
              </div>
              <p className="text-base font-semibold text-foreground mb-1">No deals yet</p>
              <p className="text-sm text-muted-foreground mb-6 max-w-xs mx-auto">Submit your first commission advance request to get started.</p>
              {!kycNotVerified && (
                <Button
                  onClick={() => router.push('/agent/new-deal')}
                  className="inline-flex items-center gap-2 h-9"
                >
                  <PlusCircle size={16} />
                  Submit Your First Request
                </Button>
              )}
            </div>
          ) : filteredDeals.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <div className="w-12 h-12 rounded-xl bg-secondary/80 flex items-center justify-center mx-auto mb-4">
                <Search className="text-muted-foreground/50" size={20} />
              </div>
              <p className="text-sm font-semibold text-foreground mb-1">No matching deals</p>
              <p className="text-xs text-muted-foreground">Try adjusting your search or filter.</p>
            </div>
          ) : (
            <>
              {(() => {
                const totalPages = Math.max(1, Math.ceil(filteredDeals.length / DEALS_PER_PAGE))
                const page = Math.min(currentPage, totalPages)
                const paged = filteredDeals.slice((page - 1) * DEALS_PER_PAGE, page * DEALS_PER_PAGE)
                return (
                  <>
                    <div role="list" aria-label="Deal list">
                      {paged.map((deal, i) => (
                        <div
                          key={deal.id}
                          role="listitem"
                          className={`group px-5 sm:px-6 py-4 flex items-center justify-between cursor-pointer transition-all duration-150 hover:bg-white/[0.03] ${
                            i < paged.length - 1 ? 'border-b border-border/20' : ''
                          }`}
                          onClick={() => router.push(`/agent/deals/${deal.id}`)}
                        >
                          <div className="flex-1 min-w-0 mr-4">
                            <p className="text-[13px] font-semibold truncate text-foreground group-hover:text-primary transition-colors">{deal.property_address}</p>
                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                              <span className="text-xs text-muted-foreground/70">
                                {formatDate(deal.created_at)}
                              </span>
                              {deal.closing_date && (
                                <>
                                  <span className="text-[10px] hidden sm:inline text-muted-foreground/30" aria-hidden="true">|</span>
                                  <span className={`text-xs flex items-center gap-1 ${deal.days_until_closing <= 7 ? 'text-status-amber' : 'text-muted-foreground/70'}`}>
                                    <Calendar size={10} aria-hidden="true" />
                                    Closing {formatDate(deal.closing_date)}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-3 sm:gap-4 shrink-0">
                            <span
                              className={`inline-flex px-2.5 py-0.5 text-[10px] sm:text-xs font-semibold rounded-md whitespace-nowrap ${getStatusBadgeClass(deal.status)}`}
                            >
                              {formatStatusLabel(deal.status)}
                            </span>
                            <p className="text-sm font-bold text-right text-primary tabular-nums hidden sm:block">{formatCurrency(deal.advance_amount)}</p>
                            <ChevronRight size={16} className="text-muted-foreground/20 group-hover:text-muted-foreground/60 transition-colors" />
                          </div>
                        </div>
                      ))}
                    </div>
                    {totalPages > 1 && (
                      <nav className="px-5 sm:px-6 py-3 flex items-center justify-between border-t border-border/30 bg-card/50" aria-label="Deals pagination">
                        <p className="text-xs text-muted-foreground/70 tabular-nums">
                          {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, filteredDeals.length)} of {filteredDeals.length}
                        </p>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Previous page"
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={page === 1}
                          >
                            <ChevronLeft size={14} aria-hidden="true" />
                          </Button>
                          <span className="px-2 text-xs font-medium text-muted-foreground tabular-nums">
                            {page} / {totalPages}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Next page"
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                          >
                            <ChevronRight size={14} aria-hidden="true" />
                          </Button>
                        </div>
                      </nav>
                    )}
                  </>
                )
              })()}
            </>
          )}
        </Card>
        </section>
      </main>
    </div>
  )
}
