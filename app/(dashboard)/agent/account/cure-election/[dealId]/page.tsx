'use client'

import { useEffect, useState, use } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { AlertTriangle, DollarSign, FileSignature, CheckCircle2, Clock, ArrowRight } from 'lucide-react'
import { formatCurrency } from '@/lib/formatting'
import { submitCureElection } from '@/lib/actions/deal-actions'
import AgentHeader from '@/components/AgentHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface PageProps {
  params: Promise<{ dealId: string }>
}

interface DealRow {
  id: string
  property_address: string
  failed_to_close_at: string | null
  failure_type: 'non_closing' | 'commission_deficiency' | null
  failure_reason: string | null
  outstanding_balance: number | null
  cure_election: 'cash' | 'commission_assignment' | null
  cure_election_at: string | null
  cure_election_deadline: string | null
  status: string
  agent_id: string
}

function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function daysRemaining(deadlineIso: string): number {
  const ms = new Date(deadlineIso).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
}

export default function CureElectionPage({ params }: PageProps) {
  const { dealId } = use(params)
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [deal, setDeal] = useState<DealRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<'cash' | 'commission_assignment' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      if (profileData?.role !== 'agent') {
        router.push('/login')
        return
      }
      setProfile(profileData)

      if (profileData?.agent_id) {
        const { data: agentData } = await supabase
          .from('agents')
          .select('*, brokerages(name, logo_url)')
          .eq('id', profileData.agent_id)
          .single()
        setAgent(agentData)
      }

      const { data: dealData, error: dealErr } = await supabase
        .from('deals')
        .select('id, property_address, failed_to_close_at, failure_type, failure_reason, outstanding_balance, cure_election, cure_election_at, cure_election_deadline, status, agent_id')
        .eq('id', dealId)
        .single()

      if (dealErr || !dealData) {
        setError('Deal not found, or you do not have access to it.')
      } else if (dealData.status !== 'failed_to_close') {
        setError('This deal is not in a failed-to-close state.')
      } else {
        setDeal(dealData as DealRow)
      }
      setLoading(false)
    }
    load()
  }, [dealId])

  const handleSubmit = async () => {
    if (!selected || !deal) return
    setSubmitting(true)
    setError(null)
    const result = await submitCureElection({ dealId: deal.id, election: selected })
    if (result.success) {
      // Refresh the deal
      const { data: refreshed } = await supabase
        .from('deals')
        .select('id, property_address, failed_to_close_at, failure_type, failure_reason, outstanding_balance, cure_election, cure_election_at, cure_election_deadline, status, agent_id')
        .eq('id', deal.id)
        .single()
      if (refreshed) setDeal(refreshed as DealRow)
    } else {
      setError(result.error || 'Failed to submit election')
    }
    setSubmitting(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background" role="status" aria-label="Loading election">
        <header className="border-b border-border/50 bg-card/80">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-10 w-48" />
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-32 rounded-xl mb-6" />
          <Skeleton className="h-48 rounded-xl mb-6" />
          <Skeleton className="h-48 rounded-xl" />
        </main>
      </div>
    )
  }

  if (error || !deal) {
    return (
      <div className="min-h-screen bg-background">
        <AgentHeader
          agentName={profile?.full_name || ''}
          agentId={agent?.id || ''}
          backHref="/agent/account"
          title="Cure Election"
          brokerageLogo={agent?.brokerages?.logo_url}
          brokerageName={agent?.brokerages?.name}
        />
        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card className="border-destructive/40">
            <CardContent className="p-6 text-center">
              <AlertTriangle className="w-10 h-10 text-destructive mx-auto mb-3" />
              <p className="text-sm font-semibold text-destructive">{error || 'Unable to load this election.'}</p>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  const isComplete = !!deal.cure_election
  const outstanding = Number(deal.outstanding_balance || 0)
  const deadline = deal.cure_election_deadline ? formatDeadline(deal.cure_election_deadline) : '—'
  const remaining = deal.cure_election_deadline ? daysRemaining(deal.cure_election_deadline) : 0

  return (
    <div className="min-h-screen bg-background">
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        backHref="/agent/account"
        title="Choose Your Repayment Method"
        subtitle={deal.property_address}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageName={agent?.brokerages?.name}
      />

      <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Outstanding balance card */}
        <Card className="mb-6 border-status-red-border/40 bg-status-red-muted/20">
          <CardContent className="p-5 sm:p-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">
                  Outstanding Balance
                </p>
                <p className="text-3xl font-bold tabular-nums text-status-red">
                  {formatCurrency(outstanding)}
                </p>
                <p className="text-xs text-muted-foreground mt-2 max-w-md">
                  {deal.failure_type === 'non_closing'
                    ? 'Your funded deal did not close. The full Purchase Price is owed back per CPA Article 5.1.'
                    : 'Your deal closed with a commission shortfall. The difference is owed back per CPA Article 5.2.'}
                </p>
                {deal.failure_reason && (
                  <p className="text-[11px] text-muted-foreground/70 mt-2">
                    <span className="font-semibold uppercase tracking-wider">Reason:</span> {deal.failure_reason}
                  </p>
                )}
              </div>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-status-red-muted/60 flex-shrink-0">
                <AlertTriangle size={22} className="text-status-red" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Election state — done */}
        {isComplete ? (
          <Card className="border-status-teal-border/40 bg-status-teal-muted/10">
            <CardContent className="p-6">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-6 h-6 text-status-teal flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-status-teal mb-1">Election Recorded</p>
                  <p className="text-sm text-foreground mb-2">
                    You chose <strong>{deal.cure_election === 'cash' ? 'Cash Repayment' : 'Assignment of Next Commission(s)'}</strong>
                    {deal.cure_election_at && ` on ${formatDeadline(deal.cure_election_at)}`}.
                  </p>
                  {deal.cure_election === 'cash' ? (
                    <div className="text-xs text-muted-foreground leading-relaxed space-y-2 mt-3">
                      <p><strong className="text-foreground">Next steps:</strong> Pay the full outstanding balance to Firm Funds within 30 days of the failure notice by electronic funds transfer.</p>
                      <p>Banking details for the transfer have been sent to your email. If you don't see them, reply to that message and we'll resend.</p>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground leading-relaxed space-y-2 mt-3">
                      <p><strong className="text-foreground">Next steps:</strong> When your next commission becomes firm, notify Firm Funds within 2 business days (CPA 5.7).</p>
                      <p>We'll send you a Remediation Direction to Pay to sign via DocuSign. Your brokerage will remit the commission directly to Firm Funds to clear the balance. No discount fee or settlement fee applies — this is not a new advance.</p>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Deadline banner */}
            <Card className="mb-6 border-status-amber-border/40 bg-status-amber-muted/10">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center gap-3">
                  <Clock className="w-5 h-5 text-status-amber flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-status-amber">
                      Election deadline: {deadline}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {remaining > 0
                        ? `${remaining} ${remaining === 1 ? 'day' : 'days'} remaining. If you do not choose by this date, you'll be deemed to have elected cash and the full balance becomes immediately due.`
                        : 'Your election deadline has passed. Please contact Firm Funds.'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Option A: Cash */}
            <button
              type="button"
              onClick={() => setSelected('cash')}
              disabled={submitting}
              className={`w-full text-left mb-3 rounded-xl border transition-all p-5 sm:p-6 ${
                selected === 'cash'
                  ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                  : 'border-border/40 bg-card hover:border-border'
              }`}
              aria-pressed={selected === 'cash'}
            >
              <div className="flex items-start gap-4">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                  selected === 'cash' ? 'bg-primary/20' : 'bg-secondary/80'
                }`}>
                  <DollarSign className={selected === 'cash' ? 'text-primary' : 'text-muted-foreground'} size={22} />
                </div>
                <div className="flex-1">
                  <p className="text-base font-bold text-foreground mb-1">Option A — Pay from Your Own Funds</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Repay the full outstanding balance to Firm Funds by electronic funds transfer within 30 days of the failure notice.
                  </p>
                  <ul className="text-xs text-muted-foreground/80 mt-2 space-y-1 list-disc list-inside">
                    <li>Banking details emailed after election</li>
                    <li>Settles the balance immediately</li>
                    <li>No further obligations on future commissions</li>
                  </ul>
                </div>
              </div>
            </button>

            {/* Option B: Commission Assignment */}
            <button
              type="button"
              onClick={() => setSelected('commission_assignment')}
              disabled={submitting}
              className={`w-full text-left mb-6 rounded-xl border transition-all p-5 sm:p-6 ${
                selected === 'commission_assignment'
                  ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                  : 'border-border/40 bg-card hover:border-border'
              }`}
              aria-pressed={selected === 'commission_assignment'}
            >
              <div className="flex items-start gap-4">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                  selected === 'commission_assignment' ? 'bg-primary/20' : 'bg-secondary/80'
                }`}>
                  <FileSignature className={selected === 'commission_assignment' ? 'text-primary' : 'text-muted-foreground'} size={22} />
                </div>
                <div className="flex-1">
                  <p className="text-base font-bold text-foreground mb-1">Option B — Assign Your Next Commission(s)</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Direct your brokerage to remit your next eligible commission(s) to Firm Funds until the balance is cleared.
                  </p>
                  <ul className="text-xs text-muted-foreground/80 mt-2 space-y-1 list-disc list-inside">
                    <li>No discount fee or settlement fee — this is not a new advance</li>
                    <li>You'll sign a Remediation Direction to Pay when your next deal goes firm</li>
                    <li>24% interest continues to accrue on the unpaid balance until cleared</li>
                  </ul>
                </div>
              </div>
            </button>

            {error && (
              <Card className="mb-4 border-destructive/40 bg-destructive/5">
                <CardContent className="p-4">
                  <p className="text-sm text-destructive">{error}</p>
                </CardContent>
              </Card>
            )}

            <button
              onClick={handleSubmit}
              disabled={!selected || submitting}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 rounded-lg text-sm font-bold text-white bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Recording your election...' : 'Submit Election'}
              {!submitting && <ArrowRight className="w-4 h-4" />}
            </button>
            <p className="text-[11px] text-muted-foreground mt-3">
              By submitting, you confirm your election under Article 5.5 of your Commission Purchase Agreement.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
