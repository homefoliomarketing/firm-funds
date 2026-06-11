'use client'

import { Suspense, useEffect, useRef, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  FileText, Clock, TrendingUp, CheckCircle2, DollarSign,
  PlusCircle, Search, Calendar, ChevronRight, ChevronLeft, CreditCard,
  AlertTriangle, Shield, Sparkles, X, Download,
} from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { getStatusBadgeClass, formatStatusLabel, BROKERAGE_PUBLIC_COLUMNS } from '@/lib/constants'
import { markKycModalSeen, markWelcomeSeen } from '@/lib/actions/profile-actions'
import { getAgentBalanceSummary } from '@/lib/actions/account-actions'
import {
  getFirmDealOfferForCurrentAgent,
  acceptFirmDealOffer,
  type FirmDealOfferSummary,
} from '@/lib/actions/firm-deal-offer-actions'
import AgentKycGate from '@/components/AgentKycGate'
import AgentHeader from '@/components/AgentHeader'
import { DealNumber } from '@/components/DealNumber'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import type { UserProfile } from '@/types/database'

interface AgentForDashboard {
  id: string
  first_name: string
  last_name: string
  kyc_status: string
  kyc_rejection_reason: string | null
  kyc_verified_modal_seen?: boolean | null
  banking_verified: boolean | null
  banking_approval_status?: 'none' | 'pending' | 'approved' | 'rejected' | null
  preauth_form_path: string | null
  account_activated_at: string | null
  phone: string | null
  address_street: string | null
  address_city: string | null
  address_province: string | null
  address_postal_code: string | null
  brokerages?: { name: string | null; logo_url: string | null; logo_includes_tagline: boolean; brand_color: string | null } | null
}

/**
 * Format a bare YYYY-MM-DD calendar date without timezone drift. The shared
 * formatDate parses ISO strings as UTC midnight, which shifts to the previous
 * day in negative-offset timezones (ET). The firm-deal offer banner shows a
 * closing date the agent recognises from the offer message; that text has to
 * match the underlying calendar date, not whatever Date interprets it as.
 */
function formatCalendarDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(iso)
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

interface Deal {
  id: string
  status: string
  property_address: string
  deal_number: string | null
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
  // Failed-to-close + cure election fields (only present when status === 'failed_to_close'/'cured')
  failed_to_close_at?: string | null
  cure_election?: 'cash_repayment' | 'commission_assignment' | null
  cure_election_deadline?: string | null
  denial_reason?: string | null
}

// useSearchParams() requires a Suspense boundary in Next.js 16. Wrap the
// inner page so server-rendered prerenders don't suspend the whole tree.
export default function AgentDashboard() {
  return (
    <Suspense>
      <AgentDashboardInner />
    </Suspense>
  )
}

function AgentDashboardInner() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [agent, setAgent] = useState<AgentForDashboard | null>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [showKycVerifiedModal, setShowKycVerifiedModal] = useState(false)
  const [accountBalance, setAccountBalance] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  // Offer surfacing — set when the magic link lands the agent on
  // /agent?firm_deal=<id>. The banner is the offer's home; if a deal record
  // already exists for the offer we also scroll the list to it.
  const [firmDealOffer, setFirmDealOffer] = useState<FirmDealOfferSummary | null>(null)
  // Collapsing (not removing) the offer banner: the X used to set this true
  // and the banner vanished for the session, taking the primary CTA with it.
  // Now the X collapses the banner to a small persistent pill the agent can
  // re-expand, so the offer is never lost. Purely client-side.
  const [firmDealOfferCollapsed, setFirmDealOfferCollapsed] = useState(false)
  // Offer-acceptance UX: the banner button changes to a confirmation state
  // after the agent clicks "Notify my brokerage". We track the inflight
  // call so we can show a spinner and disable the button against
  // double-clicks (Resend takes ~300ms on a warm path, longer on cold).
  const [acceptingOffer, setAcceptingOffer] = useState(false)
  const [offerAcceptError, setOfferAcceptError] = useState<string | null>(null)
  const [offerJustAccepted, setOfferJustAccepted] = useState(false)
  // Confirmation gate on "Notify my brokerage" — one accidental click used to
  // submit an advance application outright. The button now opens this dialog
  // and the real accept call only fires on explicit confirm.
  const [confirmingOffer, setConfirmingOffer] = useState(false)
  const dealRowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [highlightedDealId, setHighlightedDealId] = useState<string | null>(null)
  // "Your statement" download - tracks which format is in flight so we can
  // show "Generating..." and disable both buttons, plus an inline status
  // message (matches the offerAcceptError inline-status pattern used above;
  // this page does not use the shared StatusToast component).
  const [downloadingStatement, setDownloadingStatement] = useState<null | 'pdf' | 'xlsx'>(null)
  const [statementMsg, setStatementMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const DEALS_PER_PAGE = 10
  const router = useRouter()
  const searchParams = useSearchParams()
  const firmDealParam = searchParams.get('firm_deal')
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
          .select(`*, brokerages(${BROKERAGE_PUBLIC_COLUMNS})`)
          .eq('id', profile.agent_id)
          .single()
        setAgent(agentData as AgentForDashboard | null)

        const { data: dealData } = await supabase
          .from('deals')
          .select('*')
          .eq('agent_id', profile.agent_id)
          .order('created_at', { ascending: false })
        setDeals((dealData as Deal[] | null) || [])

        // Fetch account balance
        const balanceResult = await getAgentBalanceSummary(profile.agent_id)
        if (balanceResult.success && balanceResult.data) {
          const bal = balanceResult.data as { balance: number }
          setAccountBalance(bal.balance)
        }
      }

      setLoading(false)
    }
    loadAgent()
    // supabase/router are stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch the firm-deal offer summary when the agent lands via the magic
  // link. The action enforces that the caller is the matched agent so we
  // never accidentally reveal someone else's offer if the URL is fiddled
  // with.
  useEffect(() => {
    if (!firmDealParam || !profile?.agent_id) return
    let cancelled = false
    ;(async () => {
      const res = await getFirmDealOfferForCurrentAgent(firmDealParam)
      if (cancelled) return
      if (res.success && res.data) {
        setFirmDealOffer(res.data)
      }
    })()
    return () => { cancelled = true }
  }, [firmDealParam, profile?.agent_id])

  // If the offer is already linked to a deal in this agent's list, scroll
  // the row into view and flash the highlight. Filters can hide the row
  // (e.g. statusFilter set), so we clear them before scrolling.
  useEffect(() => {
    if (!firmDealOffer?.offer_deal_id || deals.length === 0) return
    const dealId = firmDealOffer.offer_deal_id
    const inList = deals.some(d => d.id === dealId)
    if (!inList) return
    setSearchQuery('')
    setStatusFilter(null)
    // Defer to the next frame so the unfiltered list renders before we look
    // up the ref.
    const handle = requestAnimationFrame(() => {
      const node = dealRowRefs.current[dealId]
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setHighlightedDealId(dealId)
        window.setTimeout(() => setHighlightedDealId(null), 3500)
      }
    })
    return () => cancelAnimationFrame(handle)
  }, [firmDealOffer?.offer_deal_id, deals])

  // handleLogout moved to AgentHeader

  // Filtered deals
  const filteredDeals = useMemo(() => {
    let result = deals

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(d =>
        d.property_address.toLowerCase().includes(q) ||
        d.status.toLowerCase().includes(q) ||
        formatCurrency(d.advance_amount).toLowerCase().includes(q) ||
        (d.deal_number?.toLowerCase().includes(q) ?? false)
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
    const active = deals.filter(d => ['offered', 'under_review', 'approved', 'funded'].includes(d.status))
    const funded = deals.filter(d => d.status === 'funded' || d.status === 'completed')
    const totalAdvanced = funded.reduce((sum, d) => sum + d.advance_amount, 0)
    return {
      total: deals.length,
      active: active.length,
      funded: funded.length,
      totalAdvanced,
    }
  }, [deals])

  // Download the agent's own all-time financial statement. The endpoint is
  // auth-scoped server-side to the caller's own agent record, so no id is
  // passed. We stream the file back as a blob and trigger a browser download
  // via a temporary anchor. Errors surface inline through statementMsg.
  async function handleDownloadStatement(format: 'pdf' | 'xlsx') {
    if (downloadingStatement) return
    setDownloadingStatement(format)
    setStatementMsg(null)
    try {
      const res = await fetch(`/api/agent/reports/export?format=${format}&month=all`)
      if (!res.ok) {
        setStatementMsg({
          kind: 'error',
          text: 'We could not download your statement. Check your connection and try again.',
        })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.headers.get('Content-Disposition')?.split('filename=')[1]?.replace(/"/g, '') || `statement.${format}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setStatementMsg({ kind: 'success', text: 'Your statement is downloading.' })
    } catch {
      setStatementMsg({
        kind: 'error',
        text: 'We could not download your statement. Check your connection and try again.',
      })
    } finally {
      setDownloadingStatement(null)
    }
  }

  // Accept the firm-deal offer — only invoked after the agent confirms in the
  // dialog. Notifies the brokerage so they can submit the advance on the
  // agent's behalf, then refreshes the deals list so the new 'offered' row
  // appears and the scroll-to-row effect picks it up.
  async function handleConfirmAccept() {
    if (!firmDealOffer) return
    if (acceptingOffer) return
    setAcceptingOffer(true)
    setOfferAcceptError(null)
    try {
      const res = await acceptFirmDealOffer(firmDealOffer.event_id)
      if (!res.success || !res.data) {
        setOfferAcceptError(res.error || 'Something went wrong. Try again.')
        return
      }
      setOfferJustAccepted(true)
      // Re-load the deals list so the new 'offered' row appears in "Your
      // Deals" and the scroll-to-row effect picks it up.
      if (profile?.agent_id) {
        const { data: refreshed } = await supabase
          .from('deals')
          .select('*')
          .eq('agent_id', profile.agent_id)
          .order('created_at', { ascending: false })
        setDeals(refreshed || [])
      }
      // Patch the offer summary so the banner switches to the "already
      // started" state on the next navigation back.
      setFirmDealOffer({
        ...firmDealOffer,
        offer_deal_id: res.data.deal_id,
      })
      setConfirmingOffer(false)
    } catch (e) {
      setOfferAcceptError(e instanceof Error ? e.message : 'Unexpected error.')
    } finally {
      setAcceptingOffer(false)
    }
  }

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

  // First-login greeting: the very first time a user reaches their dashboard we
  // stamp welcomed_at so future visits say "Welcome back". markWelcomeSeen is
  // idempotent, so firing it on a null flag is safe.
  useEffect(() => {
    if (profile && !profile.welcomed_at) void markWelcomeSeen()
  }, [profile])

  // KYC status
  const kycPending = agent && agent.kyc_status === 'pending'
  const kycSubmitted = agent && agent.kyc_status === 'submitted'
  const kycRejected = agent && agent.kyc_status === 'rejected'
  const kycNotVerified = agent && agent.kyc_status !== 'verified'

  // Account activation status (Session 34 — white-label flow)
  const notActivated = agent && !agent.account_activated_at

  // Distinguish "still has setup work to do" from "everything submitted, waiting
  // on staff approval". account_activated_at only flips once BOTH KYC and
  // banking are APPROVED, so without this split a fully-submitted agent is wrongly
  // told to "continue setup".
  const kycActionNeeded = agent && (agent.kyc_status === 'pending' || agent.kyc_status === 'rejected')
  const bankingStatus = agent?.banking_approval_status ?? 'none'
  const bankingActionNeeded = agent && (bankingStatus === 'none' || bankingStatus === 'rejected')
  const setupIncomplete = !!notActivated && (kycActionNeeded || bankingActionNeeded)
  const awaitingApproval = !!notActivated && !setupIncomplete

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
      {/* KYC Verified Congratulations — shadcn Dialog (was hand-rolled
          modal until the 2026-05-26 sweep, switched for built-in focus
          trap, ESC handling, scroll lock, and click-outside dismiss
          coming for free). */}
      <Dialog open={showKycVerifiedModal} onOpenChange={setShowKycVerifiedModal}>
        <DialogContent className="max-w-md text-center sm:rounded-2xl border-primary/30 shadow-2xl shadow-primary/10">
          <div className="w-16 h-16 rounded-full mx-auto mb-2 bg-primary/10 border border-primary/30 flex items-center justify-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-foreground text-center">
              Identity Verified!
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground text-center">
              Congratulations{agent?.first_name ? `, ${agent.first_name}` : ''}! Your identity has been verified.
              You can now submit advance requests on your deals.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setShowKycVerifiedModal(false)}
              className="w-full h-10"
            >
              Get Started
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before notifying the brokerage — guards against an
          accidental click on the offer banner submitting an advance
          application outright. */}
      <Dialog open={confirmingOffer} onOpenChange={(open) => { if (!open) setConfirmingOffer(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submit advance request?</DialogTitle>
            <DialogDescription>
              Are you sure you would like to submit an application for an advance on this commission? We&apos;ll notify your brokerage to send us the paperwork.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingOffer(false)} disabled={acceptingOffer}>
              Cancel
            </Button>
            <Button onClick={handleConfirmAccept} disabled={acceptingOffer}>
              {acceptingOffer ? 'Sending…' : 'Yes, submit my request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageLogoIncludesTagline={agent?.brokerages?.logo_includes_tagline}
        brokerageName={agent?.brokerages?.name}
      />

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Failed-deals summary strip: single entry-point card whenever the
            agent has ANY failed_to_close deal on file. Lives above the cure
            election prompts because it's the long-lived destination (the
            election prompt below is per-deal and goes away once a choice
            is made). Visual treatment matches the brokerage-side
            ActionRequiredStrip amber tone for "action required, ongoing"
            (red is reserved for the per-deal election deadline). */}
        {(() => {
          const failedDeals = deals.filter(d => d.status === 'failed_to_close')
          if (failedDeals.length === 0) return null
          return (
            <section aria-label="Failed deals on your account" className="mb-6">
              <button
                type="button"
                onClick={() => router.push('/agent/failed-deals')}
                aria-label={`${failedDeals.length} failed deal${failedDeals.length === 1 ? '' : 's'} on your account, click to manage`}
                className="group w-full text-left rounded-xl px-5 py-3.5 transition-all border flex items-center gap-4 bg-amber-950/30 border-amber-800/50 hover:border-amber-600 hover:bg-amber-950/45 focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-amber-500/15" aria-hidden="true">
                  <AlertTriangle size={17} className="text-amber-400" />
                </div>
                <div className="flex-1 min-w-0 flex items-baseline gap-2 flex-wrap">
                  <span className="text-xl font-bold tabular-nums leading-none text-amber-300">{failedDeals.length}</span>
                  <span className="text-sm text-foreground/85">
                    {failedDeals.length === 1 ? 'Failed deal on your account' : 'Failed deals on your account'}
                  </span>
                  <span className="text-xs text-muted-foreground basis-full sm:basis-auto sm:ml-2">
                    Manage your remediation deals and clear the balance.
                  </span>
                </div>
                <ChevronRight
                  size={16}
                  className="opacity-50 group-hover:opacity-100 transition flex-shrink-0 text-amber-400"
                  aria-hidden="true"
                />
              </button>
            </section>
          )
        })()}

        {/* Cure-election prompt — any failed_to_close deal without an
            election yet needs the agent's attention. We surface this above
            everything else because the 15-day clock keeps ticking even
            while the agent ignores the dashboard. */}
        {(() => {
          const needsElection = deals.filter(d =>
            d.status === 'failed_to_close' &&
            !d.cure_election &&
            d.cure_election_deadline
          )
          if (needsElection.length === 0) return null
          return (
            <section aria-label="Action required: cure election" className="mb-6 space-y-2">
              {needsElection.map(d => {
                const deadline = d.cure_election_deadline ? new Date(d.cure_election_deadline) : null
                const msLeft = deadline ? deadline.getTime() - Date.now() : null
                const isOverdue = msLeft !== null && msLeft < 0
                const daysLeft = msLeft !== null
                  ? Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)))
                  : null
                return (
                  <div
                    key={d.id}
                    className={`rounded-xl p-4 sm:p-5 flex items-start justify-between gap-4 border ${
                      isOverdue
                        ? 'bg-destructive/10 border-destructive/40'
                        : 'bg-status-amber-muted/50 border-status-amber-border/60'
                    }`}
                    role="alert"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <AlertTriangle
                        size={20}
                        className={isOverdue ? 'text-destructive shrink-0 mt-0.5' : 'text-status-amber shrink-0 mt-0.5'}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className={`text-sm font-semibold ${isOverdue ? 'text-destructive' : 'text-status-amber'}`}>
                          {isOverdue
                            ? 'Cure election overdue. Contact Firm Funds'
                            : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left to choose how to cure this deal`}
                        </p>
                        <p className="text-xs mt-1 text-foreground/80 truncate">
                          {d.property_address}
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => router.push(`/agent/cure-election/${d.id}`)}
                      className="shrink-0"
                    >
                      Review options
                    </Button>
                  </div>
                )
              })}
            </section>
          )
        })()}

        {/* Firm-deal offer banner — appears when the agent lands here via
            the offer email/SMS magic link with ?firm_deal=<id>. Three
            states render here based on offer_deal_id + just-accepted:

              A. Not yet accepted (offer_deal_id IS NULL, not just-clicked)
                 → CTA: "Notify my brokerage I want an advance"
              B. Just accepted in this session (offerJustAccepted=true)
                 → Confirmation message + link to the offered deal row
              C. Previously accepted (offer_deal_id set from server)
                 → "We've already started a request" + scroll-to-row link

            Why a separate offerJustAccepted state instead of relying on
            offer_deal_id from the server: the action returns a deal id
            but we don't re-fetch the offer summary, so offer_deal_id in
            firmDealOffer stays null. The just-accepted flag bridges that
            gap and also gives us a moment to celebrate the click. */}
        {firmDealOffer && firmDealOfferCollapsed && (
          <section aria-label="Firm deal offer">
            <button
              type="button"
              onClick={() => setFirmDealOfferCollapsed(false)}
              aria-expanded={false}
              aria-label="You have an advance offer. Expand to view the details."
              className="group mb-6 w-full text-left rounded-xl px-4 py-2.5 flex items-center gap-3 bg-primary/10 border border-primary/30 hover:bg-primary/15 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <Sparkles size={16} className="text-primary shrink-0" aria-hidden="true" />
              <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
                {offerJustAccepted
                  ? `${agent?.brokerages?.name || 'Your brokerage'} has been notified about your advance`
                  : 'You have an advance offer'}
                {firmDealOffer.address && (
                  <span className="text-muted-foreground font-normal"> ({firmDealOffer.address})</span>
                )}
              </span>
              <span className="shrink-0 text-xs font-semibold text-primary inline-flex items-center gap-0.5">
                View
                <ChevronRight size={13} aria-hidden="true" />
              </span>
            </button>
          </section>
        )}
        {firmDealOffer && !firmDealOfferCollapsed && (
          <section aria-label="Firm deal offer">
            <div className="mb-6 rounded-xl p-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4 bg-primary/10 border border-primary/30 relative">
              <div className="flex items-start gap-3 min-w-0">
                <Sparkles size={20} className="text-primary shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {offerJustAccepted
                      ? `${agent?.brokerages?.name || 'Your brokerage'} has been notified`
                      : firmDealOffer.brand_name
                        ? `${firmDealOffer.brand_name}: your deal just firmed up`
                        : 'Your deal just firmed up'}
                  </p>
                  <p className="text-xs mt-1 text-muted-foreground">
                    {firmDealOffer.address
                      ? <span className="font-medium text-foreground">{firmDealOffer.address}</span>
                      : 'A new firm deal'}
                    {firmDealOffer.closing_date_iso && (
                      <>
                        <span aria-hidden="true"> · </span>
                        Closing {formatCalendarDate(firmDealOffer.closing_date_iso)}
                      </>
                    )}
                  </p>
                  <p className="text-xs mt-2 text-muted-foreground">
                    {offerJustAccepted
                      ? `We sent ${agent?.brokerages?.name || 'them'} the details. Your advance request is in their queue and shows below as "Offered" until they submit it. You don't need to do anything else.`
                      : firmDealOffer.offer_deal_id
                        ? "We've already let your brokerage know about this one. See your deal below."
                        : `Want an advance on this commission? Click below and we'll let ${agent?.brokerages?.name || 'your brokerage'} know to send us the paperwork.`}
                  </p>
                  {offerAcceptError && (
                    <p className="text-xs mt-2 text-status-red" role="alert">{offerAcceptError}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-end">
                {!firmDealOffer.offer_deal_id && !offerJustAccepted && (
                  <Button
                    onClick={() => {
                      if (kycNotVerified) return
                      setOfferAcceptError(null)
                      setConfirmingOffer(true)
                    }}
                    disabled={!!kycNotVerified}
                    title={kycNotVerified ? 'Complete identity verification first' : 'Notify your brokerage so they can submit on your behalf'}
                    className="flex-1 sm:flex-initial min-w-0 whitespace-normal sm:whitespace-nowrap h-auto min-h-9 py-2 bg-primary text-primary-foreground hover:bg-primary/90"
                    size="sm"
                  >
                    Notify my brokerage I want an advance
                    <ChevronRight size={14} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setFirmDealOfferCollapsed(true)}
                  aria-label="Collapse offer banner to a smaller strip"
                  aria-expanded={true}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* KYC / Banking status banners */}
        <section aria-label="Account status notifications">
          {/* Activation CTA — only while the agent still has setup work to do */}
          {setupIncomplete && (
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

          {/* Everything submitted — waiting on staff approval */}
          {awaitingApproval && (
            <div className="mb-6 rounded-xl p-5 bg-status-blue-muted/60 border border-status-blue-border/60" role="status">
              <div className="flex items-start gap-3">
                <Clock size={20} className="text-status-blue shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-status-blue">Pending approval</p>
                  <p className="text-xs mt-0.5 text-status-blue/70">
                    Your information is in and under review by {agent?.brokerages?.name || 'your brokerage'} and Firm Funds. We&apos;ll email you the moment your account is activated. Nothing more is needed from you right now.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-status-blue/70">
                    <span>Identity: {agent?.kyc_status === 'verified' ? 'Approved' : 'Under review'}</span>
                    <span>Banking: {bankingStatus === 'approved' ? 'Approved' : 'Under review'}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* KYC Banner — only show when activated but somehow KYC issue (rare edge case) */}
          {!notActivated && agent && (kycPending || kycRejected) && (
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

        {/* Credit banner — a negative balance means Firm Funds owes the agent
            a refund. Without this the credit was invisible unless they opened
            the ledger. Teal "good news" treatment to match the success states
            used elsewhere. */}
        {accountBalance < 0 && (
          <div className="mb-6 rounded-xl p-4 flex items-center justify-between gap-3 bg-status-teal-muted/60 border border-status-teal-border/60" role="status">
            <div className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-status-teal shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-status-teal">You have a credit</p>
                <p className="text-xs mt-0.5 text-status-teal/70">Firm Funds owes you a refund of {formatCurrency(Math.abs(accountBalance))}.</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/agent/account')}
              className="shrink-0 whitespace-nowrap border-status-teal-border text-status-teal hover:bg-status-teal-muted hover:text-status-teal"
            >
              View Ledger
              <ChevronRight size={14} />
            </Button>
          </div>
        )}
        </section>

        {/* Your statement - branded PDF / Excel download of the agent's own
            deals, advances, fees paid, and account ledger. Sits next to the
            balance/ledger area above. The export endpoint is auth-scoped to
            the caller, so no extra gating is needed here. */}
        <section aria-label="Your statement" className="mb-8">
          <div className="rounded-xl p-5 bg-card border border-border/40">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-primary/10 border border-primary/30" aria-hidden="true">
                  <FileText size={17} className="text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">Your statement</p>
                  <p className="text-xs mt-0.5 text-muted-foreground">
                    Your deals, advances, the fees you paid, and your account ledger - for your records or your accountant.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownloadStatement('pdf')}
                  disabled={downloadingStatement !== null}
                  className="whitespace-nowrap"
                >
                  <Download size={14} aria-hidden="true" />
                  {downloadingStatement === 'pdf' ? 'Generating...' : 'Download PDF'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownloadStatement('xlsx')}
                  disabled={downloadingStatement !== null}
                  className="whitespace-nowrap"
                >
                  <Download size={14} aria-hidden="true" />
                  {downloadingStatement === 'xlsx' ? 'Generating...' : 'Download Excel'}
                </Button>
              </div>
            </div>
            {statementMsg && (
              <p
                className={`text-xs mt-3 ${statementMsg.kind === 'error' ? 'text-status-red' : 'text-status-teal'}`}
                role={statementMsg.kind === 'error' ? 'alert' : 'status'}
              >
                {statementMsg.text}
              </p>
            )}
          </div>
        </section>

        {/* Welcome + New Deal Button */}
        <section aria-label="Welcome and actions">
        <div className="mb-6 flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {profile?.welcomed_at ? 'Welcome back' : 'Welcome'}, {profile?.full_name?.split(' ')[0]}
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
                    placeholder="Search by deal #, address, or status..."
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
                {['offered', 'under_review', 'approved', 'funded', 'completed', 'denied', 'cancelled'].map(status => {
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
                          ref={(el) => { dealRowRefs.current[deal.id] = el }}
                          role="listitem"
                          className={`group px-5 sm:px-6 py-4 flex items-center justify-between cursor-pointer transition-all duration-150 hover:bg-white/[0.03] ${
                            i < paged.length - 1 ? 'border-b border-border/20' : ''
                          } ${
                            highlightedDealId === deal.id ? 'bg-primary/10 ring-1 ring-primary/40' : ''
                          }`}
                          onClick={() => router.push(`/agent/deals/${deal.id}`)}
                        >
                          <div className="flex-1 min-w-0 mr-4">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="text-[13px] font-semibold truncate text-foreground group-hover:text-primary transition-colors">{deal.property_address}</p>
                              <DealNumber value={deal.deal_number} className="shrink-0" />
                            </div>
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
                            {deal.status === 'offered' ? (
                              // Offered deals carry placeholder 0s for
                              // advance_amount; showing "$0.00" would
                              // confuse the agent. The brokerage fills
                              // these in when they submit.
                              <p className="text-xs italic text-right text-muted-foreground hidden sm:block">Pending brokerage</p>
                            ) : (
                              <p className="text-sm font-bold text-right text-primary tabular-nums hidden sm:block">{formatCurrency(deal.advance_amount)}</p>
                            )}
                            <ChevronRight size={16} className="text-muted-foreground/20 group-hover:text-muted-foreground/60 transition-colors" />
                          </div>
                        </div>
                      ))}
                    </div>
                    {totalPages > 1 && (
                      <nav className="px-5 sm:px-6 py-3 flex flex-col gap-2 min-[375px]:flex-row min-[375px]:items-center min-[375px]:justify-between border-t border-border/30 bg-card/50" aria-label="Deals pagination">
                        <p className="text-xs text-muted-foreground/70 tabular-nums text-center min-[375px]:text-left">
                          <span className="hidden min-[400px]:inline">{(page - 1) * DEALS_PER_PAGE + 1}–{Math.min(page * DEALS_PER_PAGE, filteredDeals.length)} of {filteredDeals.length}</span>
                          <span className="min-[400px]:hidden">{filteredDeals.length} deals</span>
                        </p>
                        <div className="flex items-center gap-1 justify-center min-[375px]:justify-end">
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
