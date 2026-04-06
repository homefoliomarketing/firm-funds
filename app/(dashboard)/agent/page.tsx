'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  FileText, Clock,
  PlusCircle, Search, Calendar, ChevronRight, ChevronLeft, CreditCard,
} from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { getStatusBadgeStyle, formatStatusLabel } from '@/lib/constants'
import AgentKycGate from '@/components/AgentKycGate'
import AgentHeader from '@/components/AgentHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

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

  // Show KYC verified modal once — check both localStorage and sessionStorage to be safe
  useEffect(() => {
    if (agent?.kyc_status === 'verified' && agent?.id) {
      const key = `kyc_verified_seen_${agent.id}`
      // Check across all storage mechanisms
      const alreadySeen = localStorage.getItem(key) || sessionStorage.getItem(key)
      if (!alreadySeen) {
        setShowKycVerifiedModal(true)
        localStorage.setItem(key, 'true')
        sessionStorage.setItem(key, 'true')
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-lg text-muted-foreground">Loading your dashboard...</p>
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
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-card border-2 border-primary rounded-2xl p-10 max-w-md w-full text-center shadow-2xl"
          >
            <div className="w-16 h-16 rounded-full mx-auto mb-5 bg-primary/15 border-2 border-primary flex items-center justify-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 className="text-[22px] font-bold text-foreground mb-2">
              Identity Verified!
            </h2>
            <p className="text-[15px] leading-relaxed text-muted-foreground mb-6">
              Congratulations{agent?.first_name ? `, ${agent.first_name}` : ''}! Your identity has been verified.
              You can now submit advance requests on your deals.
            </p>
            <Button
              onClick={() => setShowKycVerifiedModal(false)}
              className="w-full"
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

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* KYC Banner */}
        {(kycPending || kycRejected) && (
          <AgentKycGate agent={agent} onKycSubmitted={() => window.location.reload()} />
        )}
        {kycSubmitted && (
          <div className="mb-6 rounded-xl p-4 flex items-center gap-3 bg-blue-950/40 border border-blue-800/50">
            <Clock size={18} className="text-blue-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-blue-400">Identity verification submitted</p>
              <p className="text-xs mt-0.5 text-blue-500/80">Your ID is under review. You can browse your dashboard but deal submission is locked until verified.</p>
            </div>
          </div>
        )}

        {/* Banking nudge — show after KYC verified but no banking on file */}
        {agent?.kyc_status === 'verified' && !agent?.banking_verified && !agent?.preauth_form_path && (
          <div className="mb-6 rounded-xl p-4 flex items-center justify-between gap-3 bg-amber-950/40 border border-amber-800/50">
            <div className="flex items-center gap-3">
              <CreditCard size={18} className="text-amber-400 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-400">Set up your banking info</p>
                <p className="text-xs mt-0.5 text-amber-500/80">Upload your pre-authorized debit form now so your first deal isn&apos;t delayed. Banking must be verified before advances can be funded.</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/agent/profile')}
              className="shrink-0 whitespace-nowrap border-amber-800/50 text-amber-400 hover:bg-amber-900/30 hover:text-amber-300"
            >
              Go to Profile →
            </Button>
          </div>
        )}

        {/* Banking submitted but not yet verified */}
        {agent?.kyc_status === 'verified' && !agent?.banking_verified && agent?.preauth_form_path && (
          <div className="mb-6 rounded-xl p-4 flex items-center gap-3 bg-blue-950/40 border border-blue-800/50">
            <Clock size={18} className="text-blue-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-blue-400">Banking info under review</p>
              <p className="text-xs mt-0.5 text-blue-500/80">Your pre-authorized debit form has been uploaded and is being reviewed. You can submit deals in the meantime.</p>
            </div>
          </div>
        )}

        {/* Welcome + New Deal Button */}
        <div className="mb-8 flex justify-between items-start">
          <div>
            <h2 className="text-2xl font-bold text-foreground">
              Welcome back, {profile?.full_name?.split(' ')[0]}
            </h2>
            {agent?.brokerages && (
              <p className="text-sm mt-1 text-muted-foreground">{agent.brokerages.name}</p>
            )}
          </div>
          <Button
            onClick={() => kycNotVerified ? null : router.push('/agent/new-deal')}
            disabled={!!kycNotVerified}
            title={kycNotVerified ? 'Complete identity verification to submit deals' : 'Submit a new advance request'}
            className="flex items-center gap-2"
          >
            <PlusCircle size={16} />
            New Advance Request
          </Button>
        </div>

        {/* Deals List */}
        <Card className="rounded-xl overflow-hidden border-border/50">
          {/* Header with search */}
          <div className="px-6 py-4 border-b border-border/50">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <h3 className="text-lg font-bold text-foreground shrink-0">Your Deals</h3>
              {deals.length > 0 && (
                <div className="relative flex-1 max-w-sm ml-auto">
                  <Search size={14} className="text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <Input
                    type="text"
                    placeholder="Search by address..."
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
                    className="pl-8 text-sm"
                  />
                </div>
              )}
            </div>

            {/* Status filter tabs */}
            {deals.length > 3 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                <button
                  onClick={() => { setStatusFilter(null); setCurrentPage(1) }}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors border ${
                    statusFilter === null
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-transparent text-muted-foreground border-border/50 hover:border-border hover:text-foreground'
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
                      onClick={() => { setStatusFilter(statusFilter === status ? null : status); setCurrentPage(1) }}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors border ${
                        statusFilter === status
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-transparent text-muted-foreground border-border/50 hover:border-border hover:text-foreground'
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
            <div className="px-6 py-16 text-center">
              <FileText className="mx-auto mb-4 text-muted-foreground/40" size={40} />
              <p className="text-base font-semibold text-muted-foreground">No deals yet</p>
              <p className="text-sm mt-1 mb-5 text-muted-foreground/70">Your commission advance requests will appear here.</p>
              {!kycNotVerified && (
                <Button
                  onClick={() => router.push('/agent/new-deal')}
                  className="inline-flex items-center gap-2"
                >
                  <PlusCircle size={16} />
                  Submit Your First Advance Request
                </Button>
              )}
            </div>
          ) : filteredDeals.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Search className="mx-auto mb-3 text-muted-foreground/40" size={32} />
              <p className="text-sm font-semibold text-muted-foreground">No matching deals</p>
              <p className="text-xs mt-1 text-muted-foreground/70">Try adjusting your search or filter.</p>
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
                          className={`px-6 py-4 flex items-center justify-between cursor-pointer transition-colors hover:bg-muted/30 ${
                            i < paged.length - 1 ? 'border-b border-border/30' : ''
                          }`}
                          onClick={() => router.push(`/agent/deals/${deal.id}`)}
                        >
                          <div className="flex-1 min-w-0 mr-3">
                            <p className="text-sm font-medium truncate text-foreground">{deal.property_address}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              <span className="text-xs text-muted-foreground">
                                {formatDate(deal.created_at)}
                              </span>
                              {deal.closing_date && (
                                <>
                                  <span className="text-xs hidden sm:inline text-muted-foreground/40">·</span>
                                  <span className={`text-xs flex items-center gap-1 ${deal.days_until_closing <= 7 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                                    <Calendar size={10} />
                                    Closing {formatDate(deal.closing_date)}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
                            <span
                              className="inline-flex px-2 py-0.5 sm:px-2.5 sm:py-1 text-[10px] sm:text-xs font-semibold rounded-md whitespace-nowrap"
                              style={getStatusBadgeStyle(deal.status)}
                            >
                              {formatStatusLabel(deal.status)}
                            </span>
                            <p className="text-sm font-bold text-right hidden sm:block text-primary">{formatCurrency(deal.advance_amount)}</p>
                            <ChevronRight size={16} className="text-muted-foreground/40" />
                          </div>
                        </div>
                      ))}
                    </div>
                    {totalPages > 1 && (
                      <div className="px-6 py-4 flex items-center justify-between border-t border-border/50">
                        <p className="text-xs text-muted-foreground">
                          Showing {(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, filteredDeals.length)} of {filteredDeals.length}
                        </p>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={page === 1}
                            className="p-2 rounded-lg transition-colors disabled:opacity-30 text-muted-foreground border border-border/50 hover:bg-muted/30"
                          >
                            <ChevronLeft size={14} />
                          </button>
                          <span className="px-3 text-xs font-semibold text-foreground">
                            {page} / {totalPages}
                          </span>
                          <button
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                            className="p-2 rounded-lg transition-colors disabled:opacity-30 text-muted-foreground border border-border/50 hover:bg-muted/30"
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
        </Card>
      </main>
    </div>
  )
}
