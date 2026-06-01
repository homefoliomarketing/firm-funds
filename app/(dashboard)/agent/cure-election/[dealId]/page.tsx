'use client'

import { use, useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import {
  AlertTriangle, Clock, DollarSign, Banknote, FileSignature, CheckCircle2,
  ArrowLeft, Loader2, ShieldAlert,
} from 'lucide-react'
import AgentHeader from '@/components/AgentHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { formatCurrency, formatDate } from '@/lib/formatting'
import {
  liveFailedDealInterestOwed,
  failedDealAccrualStartDate,
} from '@/lib/calculations'
import { submitCureElection } from '@/lib/actions/deal-actions'

interface AgentMinimal {
  id: string
  first_name: string
  last_name: string
}

interface FailedDeal {
  id: string
  agent_id: string
  status: string
  property_address: string
  failed_to_close_at: string | null
  failure_type: string | null
  failure_reason: string | null
  outstanding_balance: number
  advance_amount: number
  funding_date: string | null
  cure_election: 'cash_repayment' | 'commission_assignment' | null
  cure_election_at: string | null
  cure_election_deadline: string | null
  failed_deal_interest_charged: number | null
}

type Choice = 'cash_repayment' | 'commission_assignment'

interface PageProps {
  params: Promise<{ dealId: string }>
}

/**
 * Cure election page (CPA Article 5.5).
 *
 * Agent lands here from the failed-to-close email or the dashboard widget
 * and picks one of two cure paths within 15 days. Past the deadline the
 * submit button is replaced by a "contact Firm Funds" notice — we keep
 * the form mounted so the agent can still see what they would have chosen.
 */
export default function CureElectionPage({ params }: PageProps) {
  // Next.js 16: dynamic-route params are a Promise. React.use() unwraps the
  // server-passed payload in a way that works for both client and server
  // entry-points.
  const { dealId } = use(params)
  const router = useRouter()
  const supabase = createClient()

  const [agent, setAgent] = useState<AgentMinimal | null>(null)
  const [deal, setDeal] = useState<FailedDeal | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [choice, setChoice] = useState<Choice | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedChoice, setSubmittedChoice] = useState<Choice | null>(null)

  // Live re-render of the countdown so the agent can see seconds tick down
  // when they're close to the deadline. 60s is plenty for a multi-day count.
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNowTick(n => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('id, role, agent_id, full_name')
        .eq('id', user.id)
        .single()
      if (!profile || profile.role !== 'agent' || !profile.agent_id) {
        router.push('/login'); return
      }

      const { data: agentData } = await supabase
        .from('agents')
        .select('id, first_name, last_name')
        .eq('id', profile.agent_id)
        .single()
      setAgent(agentData)

      const { data: dealData, error: dealErr } = await supabase
        .from('deals')
        .select('id, agent_id, status, property_address, failed_to_close_at, failure_type, failure_reason, outstanding_balance, advance_amount, funding_date, cure_election, cure_election_at, cure_election_deadline, failed_deal_interest_charged')
        .eq('id', dealId)
        .single()

      if (dealErr || !dealData) {
        setLoadError('We couldn\'t load this deal. It may have been removed.')
        setLoading(false); return
      }
      if (dealData.agent_id !== profile.agent_id) {
        setLoadError('This deal isn\'t on your account.')
        setLoading(false); return
      }
      if (dealData.status !== 'failed_to_close' && dealData.status !== 'cured') {
        setLoadError(`This deal isn\'t in the failed-to-close state (current status: ${dealData.status}).`)
        setLoading(false); return
      }
      setDeal(dealData as FailedDeal)
      if (dealData.cure_election) {
        setChoice(dealData.cure_election as Choice)
        setSubmittedChoice(dealData.cure_election as Choice)
      }
      setLoading(false)
    }
    load().catch(() => {
      setLoadError('Something went wrong loading this page.')
      setLoading(false)
    })
  }, [dealId, supabase, router])

  // Derived live financial state. Recomputed whenever the deal loads or the
  // 60s tick fires.
  const financials = useMemo(() => {
    if (!deal || !deal.failed_to_close_at) return null
    const principal = Number(deal.outstanding_balance) || 0
    const failedAt = deal.failed_to_close_at.slice(0, 10)
    const accrualStart = failedDealAccrualStartDate(failedAt)
    const interest = liveFailedDealInterestOwed(principal, failedAt)
    const total = principal + interest

    const failedDate = new Date(deal.failed_to_close_at)
    // Intentional Date.now() during render — the setNowTick effect above
    // re-runs this memo every 60s so the countdown stays current.
    // eslint-disable-next-line react-hooks/purity
    const daysSinceFailed = Math.floor((Date.now() - failedDate.getTime()) / (1000 * 60 * 60 * 24))

    const deadline = deal.cure_election_deadline ? new Date(deal.cure_election_deadline) : null
    // eslint-disable-next-line react-hooks/purity
    const msToDeadline = deadline ? deadline.getTime() - Date.now() : null
    const isOverdue = msToDeadline !== null ? msToDeadline < 0 : false
    const daysToDeadline = msToDeadline !== null
      ? Math.ceil(msToDeadline / (1000 * 60 * 60 * 24))
      : null

    const todayYmd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
    const inGrace = todayYmd < accrualStart

    return {
      principal,
      interest,
      total,
      accrualStart,
      daysSinceFailed,
      deadline,
      daysToDeadline,
      isOverdue,
      inGrace,
    }
  }, [deal])

  const handleSubmit = useCallback(async () => {
    if (!deal || !choice) return
    if (!acknowledged) {
      setSubmitError('Please acknowledge the obligations before submitting.')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    const result = await submitCureElection({ dealId: deal.id, election: choice })
    if (result.success) {
      // Commission assignment: bounce to the failed-deals page so the
      // agent can add their next remediation deal without an extra click.
      // Before redirecting we surface a success toast and hold briefly so the
      // agent gets an explicit acknowledgement that this legally significant
      // election was recorded (the cash path keeps them on-page with its own
      // confirmation copy, so this matches that behaviour).
      if (choice === 'commission_assignment') {
        toast.success('Commission assignment election recorded', {
          description: 'We will send your Remediation IDP to sign. Taking you to your failed deals now.',
        })
        window.setTimeout(() => {
          router.push(`/agent/failed-deals?dealId=${deal.id}`)
        }, 1500)
        return
      }
      setSubmittedChoice(choice)
      setDeal({ ...deal, cure_election: choice, cure_election_at: new Date().toISOString() })
    } else {
      setSubmitError(result.error || 'Failed to record your election. Please try again.')
    }
    setSubmitting(false)
  }, [deal, choice, acknowledged, router])

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto px-4 py-12 space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  if (loadError || !deal) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto px-4 py-12">
          <Alert variant="destructive">
            <AlertTriangle size={16} aria-hidden="true" />
            <AlertDescription>{loadError || 'Deal not found.'}</AlertDescription>
          </Alert>
          <Button variant="outline" className="mt-4" onClick={() => router.push('/agent')}>
            <ArrowLeft size={14} className="mr-1.5" /> Back to dashboard
          </Button>
        </div>
      </div>
    )
  }

  const agentName = agent ? `${agent.first_name} ${agent.last_name}` : ''

  return (
    <div className="min-h-screen bg-background">
      <AgentHeader
        agentName={agentName}
        agentId={deal.agent_id}
        backHref="/agent"
        title="Cure Election"
        subtitle={deal.property_address}
      />

      <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        <h1 className="sr-only">Cure election for {deal.property_address}</h1>

        {/* Deadline banner — variant flips on overdue */}
        {financials?.isOverdue ? (
          <Alert variant="destructive" role="alert">
            <ShieldAlert size={16} aria-hidden="true" />
            <AlertDescription>
              <strong>Election overdue.</strong> Contact Firm Funds immediately at{' '}
              <a href="mailto:bud@firmfunds.ca" className="underline underline-offset-2 font-medium">
                bud@firmfunds.ca
              </a>{' '}
              so we can work out next steps for this deal.
            </AlertDescription>
          </Alert>
        ) : submittedChoice ? (
          <Alert role="status">
            <CheckCircle2 size={16} className="text-status-green" aria-hidden="true" />
            <AlertDescription>
              <strong>Election recorded.</strong> You chose{' '}
              <span className="font-semibold">
                {submittedChoice === 'cash_repayment' ? 'Cash Repayment' : 'Commission Assignment'}
              </span>
              . A Firm Funds team member will follow up with next steps.
            </AlertDescription>
          </Alert>
        ) : financials && financials.daysToDeadline !== null ? (
          <Alert>
            <Clock size={16} className="text-status-amber" aria-hidden="true" />
            <AlertDescription>
              <strong>{financials.daysToDeadline} {financials.daysToDeadline === 1 ? 'day' : 'days'} left to elect.</strong>{' '}
              Deadline:{' '}
              <span className="font-semibold">
                {financials.deadline?.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
              . After this you may lose the option to assign a future commission.
            </AlertDescription>
          </Alert>
        ) : null}

        {/* Deal summary */}
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle size={16} className="text-status-red" aria-hidden="true" />
              Failed-to-Close Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Property</p>
              <p className="font-medium text-foreground">{deal.property_address}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Failed-to-close date</p>
              <p className="font-medium text-foreground">
                {deal.failed_to_close_at ? formatDate(deal.failed_to_close_at) : 'Not recorded'}
              </p>
              {financials && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {financials.daysSinceFailed} day{financials.daysSinceFailed === 1 ? '' : 's'} ago
                </p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Original advance</p>
              <p className="font-medium text-foreground tabular-nums">{formatCurrency(deal.advance_amount)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Failure type</p>
              <p className="font-medium text-foreground capitalize">
                {deal.failure_type ? deal.failure_type.replace(/_/g, ' ') : 'Unspecified'}
              </p>
            </div>
            {deal.failure_reason && (
              <div className="sm:col-span-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Reason on file</p>
                <p className="text-sm text-foreground whitespace-pre-wrap">{deal.failure_reason}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Live balance */}
        {financials && (
          <Card className="border-status-red-border/60">
            <CardHeader className="border-b border-border bg-status-red-muted/30">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign size={16} className="text-status-red" aria-hidden="true" />
                Outstanding balance (live)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Principal owed</span>
                <span className="font-medium text-foreground tabular-nums">{formatCurrency(financials.principal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Accrued interest{financials.inGrace ? ' (none, still in 30-day grace)' : ' (24% APR, compounded daily)'}
                </span>
                <span className="font-medium text-foreground tabular-nums">{formatCurrency(financials.interest)}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-border">
                <span className="font-semibold text-foreground">Total owed today</span>
                <span className="font-bold text-status-red tabular-nums text-lg">
                  {formatCurrency(financials.total)}
                </span>
              </div>
              {!financials.inGrace && (
                <p className="text-xs text-muted-foreground">
                  Interest started accruing on {financials.accrualStart} and compounds daily until cleared.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Election cards */}
        {!submittedChoice && (
          <fieldset disabled={submitting || financials?.isOverdue}>
            <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Choose your cure
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Cash repayment */}
              <button
                type="button"
                onClick={() => setChoice('cash_repayment')}
                aria-pressed={choice === 'cash_repayment'}
                className={`text-left rounded-xl p-5 transition-all border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  choice === 'cash_repayment'
                    ? 'border-primary bg-primary/8'
                    : 'border-border bg-card hover:border-primary/40'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-9 w-9 rounded-lg bg-status-blue-muted text-status-blue flex items-center justify-center" aria-hidden="true">
                    <Banknote size={18} />
                  </div>
                  <h3 className="font-semibold text-foreground">Cash Repayment</h3>
                </div>
                <p className="text-sm text-muted-foreground mb-3">
                  Repay the full outstanding balance in cash. The repayment window is 90 days from
                  today (this is separate from the 15-day deadline to make this choice).
                </p>
                <div className="rounded-lg bg-status-amber-muted/50 border border-status-amber-border/60 p-3 text-xs text-status-amber">
                  <strong>Note:</strong> Choosing this means you accept personal liability for the full
                  amount. Missed payments accrue 24% APR daily compound interest.
                </div>
              </button>

              {/* Commission assignment */}
              <button
                type="button"
                onClick={() => setChoice('commission_assignment')}
                aria-pressed={choice === 'commission_assignment'}
                className={`text-left rounded-xl p-5 transition-all border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  choice === 'commission_assignment'
                    ? 'border-primary bg-primary/8'
                    : 'border-border bg-card hover:border-primary/40'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-9 w-9 rounded-lg bg-status-green-muted text-status-green flex items-center justify-center" aria-hidden="true">
                    <FileSignature size={18} />
                  </div>
                  <h3 className="font-semibold text-foreground">Commission Assignment</h3>
                </div>
                <p className="text-sm text-muted-foreground mb-3">
                  Assign a future commission to Firm Funds. We&apos;ll send a Remediation IDP for you to
                  sign. When that next deal closes, your brokerage pays Firm Funds the outstanding
                  amount directly out of your commission.
                </p>
                <div className="rounded-lg bg-status-blue-muted/50 border border-status-blue-border/60 p-3 text-xs text-status-blue">
                  <strong>Plain English:</strong> instead of paying cash now, you redirect part of a future
                  commission. Nothing to repay out-of-pocket if you have an upcoming closing.
                </div>
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-1 w-4 h-4 rounded accent-primary"
                  aria-describedby="cure-ack-help"
                />
                <span className="text-sm text-foreground">
                  I understand these obligations and the cure-path I&apos;ve selected. (CPA Article 5.5)
                </span>
              </label>
              <p id="cure-ack-help" className="sr-only">
                Checking this confirms you have read the cure options and agree to the obligation tied to your chosen path.
              </p>

              {submitError && (
                <Alert variant="destructive">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              <div className="flex gap-3 justify-end">
                <Button variant="outline" onClick={() => router.push('/agent')} disabled={submitting}>
                  Back to dashboard
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={submitting || !choice || !acknowledged || financials?.isOverdue}
                >
                  {submitting && <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" />}
                  {submitting ? 'Submitting election…' : 'Submit election'}
                </Button>
              </div>
            </div>
          </fieldset>
        )}
      </main>
    </div>
  )
}
