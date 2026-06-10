'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, DollarSign, ArrowRight } from 'lucide-react'
import { formatCurrency } from '@/lib/formatting'
import { getAgentTransactions } from '@/lib/actions/account-actions'
import { BROKERAGE_PUBLIC_COLUMNS } from '@/lib/constants'
import AgentHeader from '@/components/AgentHeader'
import AgentLedger from '@/components/AgentLedger'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { AgentAccountTransaction, UserProfile } from '@/types/database'

interface PendingElection {
  id: string
  property_address: string
  outstanding_balance: number | null
  cure_election_deadline: string | null
  cure_election: 'cash_repayment' | 'commission_assignment' | null
}

interface AgentForHeader {
  id: string
  brokerages?: { name: string | null; logo_url: string | null;  logo_includes_tagline?: boolean | null} | null
}

export default function AgentAccountPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [agent, setAgent] = useState<AgentForHeader | null>(null)
  const [transactions, setTransactions] = useState<AgentAccountTransaction[]>([])
  // Maps deal_id -> deal_number so the ledger can show the human-readable deal
  // number on rows tied to a deal. The transaction rows carry deal_id but not
  // the number, so we resolve it from the deals table after loading them.
  const [dealNumbers, setDealNumbers] = useState<Record<string, string | null>>({})
  const [currentBalance, setCurrentBalance] = useState(0)
  const [pendingElections, setPendingElections] = useState<PendingElection[]>([])
  const [loading, setLoading] = useState(true)
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
      setProfile(profileData)

      if (profileData?.role !== 'agent') { router.push('/login'); return }

      if (profileData?.agent_id) {
        const { data: agentData } = await supabase
          .from('agents')
          .select(`*, brokerages(${BROKERAGE_PUBLIC_COLUMNS})`)
          .eq('id', profileData.agent_id)
          .single()
        setAgent(agentData as AgentForHeader | null)

        // Fetch transactions via server action (service role, bypasses RLS)
        const result = await getAgentTransactions(profileData.agent_id)
        if (result.success && result.data) {
          const data = result.data as { transactions: AgentAccountTransaction[]; currentBalance: number }
          setTransactions(data.transactions)
          setCurrentBalance(data.currentBalance)

          // Resolve deal numbers for any deal-linked transactions so the
          // ledger can show the tracking number alongside the description.
          const dealIds = Array.from(
            new Set(data.transactions.map(t => t.deal_id).filter((id): id is string => !!id)),
          )
          if (dealIds.length > 0) {
            const { data: dealRows } = await supabase
              .from('deals')
              .select('id, deal_number')
              .in('id', dealIds)
            if (dealRows) {
              const map: Record<string, string | null> = {}
              for (const d of dealRows as Array<{ id: string; deal_number: string | null }>) {
                map[d.id] = d.deal_number
              }
              setDealNumbers(map)
            }
          }
        }

        // Fetch all failed-to-close deals on this agent. Some need an election
        // decision still, others have a chosen path and need the agent to
        // manage remediation deals. Split into two groups for the two UI
        // sections below.
        const { data: failed } = await supabase
          .from('deals')
          .select('id, property_address, outstanding_balance, cure_election_deadline, cure_election')
          .eq('agent_id', profileData.agent_id)
          .eq('status', 'failed_to_close')
          .order('cure_election_deadline', { ascending: true })

        if (failed) setPendingElections(failed as PendingElection[])
      }

      setLoading(false)
    }
    load()
    // supabase + router are stable for the life of the page; including them
    // here would cause an infinite re-fetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-background" role="status" aria-label="Loading account">
        <header className="border-b border-border/50 bg-card/80">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-10 w-48" />
          </div>
        </header>
        <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-8 w-64 mb-6" />
          <Skeleton className="h-32 rounded-xl mb-6" />
          <Skeleton className="h-96 rounded-xl" />
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        backHref="/agent"
        title="Account & Ledger"
        subtitle={currentBalance > 0 ? `Balance owing: ${formatCurrency(currentBalance)}` : 'No balance owing'}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageLogoIncludesTagline={agent?.brokerages?.logo_includes_tagline}
        brokerageName={agent?.brokerages?.name}
      />

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Pending cure election banner(s) — for failed deals without an
            election yet (CPA Article 5.5). One row per pending deal links
            into the election flow. */}
        {pendingElections.filter(p => p.cure_election == null).length > 0 && (
          <section aria-label="Action required" className="mb-6 space-y-3">
            {pendingElections.filter(p => p.cure_election == null).map((p) => {
              const deadlineFmt = p.cure_election_deadline
                ? new Date(p.cure_election_deadline).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
                : null
              const daysLeft = p.cure_election_deadline
                ? Math.max(0, Math.ceil((new Date(p.cure_election_deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
                : 0
              return (
                <Link
                  key={p.id}
                  href={`/agent/account/cure-election/${p.id}`}
                  className="block rounded-xl border border-status-red-border/40 bg-status-red-muted/15 hover:bg-status-red-muted/25 transition-colors"
                >
                  <div className="p-4 sm:p-5 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-status-red-muted/60 flex items-center justify-center flex-shrink-0">
                      <AlertTriangle size={20} className="text-status-red" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-status-red mb-0.5">
                        Action required: choose your repayment method
                      </p>
                      <p className="text-xs text-foreground/80 truncate">
                        {p.property_address}
                        {p.outstanding_balance != null && (
                          <span className="text-muted-foreground"> · Balance owing: <strong className="text-foreground">{formatCurrency(Number(p.outstanding_balance))}</strong></span>
                        )}
                      </p>
                      {deadlineFmt && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Election due by {deadlineFmt} ({daysLeft} {daysLeft === 1 ? 'day' : 'days'} left)
                        </p>
                      )}
                      <p className="text-[11px] text-status-red/80 mt-1">
                        After you choose commission assignment, add the upcoming deals at <span className="font-semibold">My failed deals</span>.
                      </p>
                    </div>
                    <ArrowRight size={18} className="text-status-red flex-shrink-0" />
                  </div>
                </Link>
              )
            })}
          </section>
        )}

        {/* Manage failed deals link, shown whenever the agent has any failed
            deal at all (election made or not). One-click path into the
            remediation page so the agent can add commission assignments. */}
        {pendingElections.length > 0 && (
          <section aria-label="Failed deals" className="mb-6">
            <Link
              href="/agent/failed-deals"
              className="block rounded-xl border border-amber-800/40 bg-amber-950/15 hover:bg-amber-950/30 transition-colors"
            >
              <div className="p-4 sm:p-5 flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-amber-900/40 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={18} className="text-amber-300" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-amber-200 mb-0.5">My failed deals</p>
                  <p className="text-xs text-foreground/80">
                    Review the balance owing on each failed deal and add commission assignments to clear it.
                  </p>
                </div>
                <ArrowRight size={18} className="text-amber-300 flex-shrink-0" />
              </div>
            </Link>
          </section>
        )}

        {/* Balance Card */}
        <section aria-label="Account balance">
          <Card className={`mb-6 border-border/40 ${currentBalance > 0 ? 'ring-1 ring-status-amber-border/40' : ''}`}>
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">
                    Current Balance
                  </p>
                  <p className={`text-3xl font-bold tabular-nums ${currentBalance > 0 ? 'text-status-amber' : 'text-status-teal'}`}>
                    {formatCurrency(currentBalance)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {currentBalance > 0
                      ? 'This balance is due immediately.'
                      : 'You have no outstanding charges.'
                    }
                  </p>
                </div>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                  currentBalance > 0 ? 'bg-status-amber-muted/60' : 'bg-status-teal-muted/60'
                }`}>
                  <DollarSign size={24} className={currentBalance > 0 ? 'text-status-amber' : 'text-status-teal'} />
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Transaction Ledger */}
        <AgentLedger transactions={transactions} dealNumbers={dealNumbers} emptyHint="Your account activity will appear here." />
      </main>
    </div>
  )
}
