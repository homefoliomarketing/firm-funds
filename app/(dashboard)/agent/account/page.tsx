'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { ArrowDownLeft, ArrowUpRight, Receipt, Clock, AlertTriangle, DollarSign } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { getAgentTransactions } from '@/lib/actions/account-actions'
import AgentHeader from '@/components/AgentHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AgentAccountTransaction } from '@/types/database'

const TRANSACTION_TYPE_CONFIG: Record<string, { label: string; color: string; icon: typeof ArrowUpRight }> = {
  late_closing_interest: { label: 'Late Closing Interest', color: 'text-status-amber', icon: Clock },
  late_payment_interest: { label: 'Late Payment Interest', color: 'text-status-amber', icon: Clock },
  balance_deduction: { label: 'Balance Deduction', color: 'text-status-teal', icon: ArrowDownLeft },
  invoice_payment: { label: 'Invoice Payment', color: 'text-status-teal', icon: Receipt },
  adjustment: { label: 'Adjustment', color: 'text-muted-foreground', icon: DollarSign },
  credit: { label: 'Credit', color: 'text-status-teal', icon: ArrowDownLeft },
}

export default function AgentAccountPage() {
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [transactions, setTransactions] = useState<AgentAccountTransaction[]>([])
  const [currentBalance, setCurrentBalance] = useState(0)
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
          .select('*, brokerages(*)')
          .eq('id', profileData.agent_id)
          .single()
        setAgent(agentData)

        // Fetch transactions via server action (service role, bypasses RLS)
        const result = await getAgentTransactions(profileData.agent_id)
        if (result.success && result.data) {
          setTransactions(result.data.transactions)
          setCurrentBalance(result.data.currentBalance)
        }
      }

      setLoading(false)
    }
    load()
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
        brokerageName={agent?.brokerages?.name}
      />

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
        <section aria-label="Transaction history">
          <Card className="overflow-hidden border-border/40 shadow-lg shadow-black/20">
            <div className="px-5 sm:px-6 py-4 border-b border-border/40">
              <h2 className="text-base font-bold text-foreground">Transaction History</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {transactions.length} transaction{transactions.length !== 1 ? 's' : ''}
              </p>
            </div>

            {transactions.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <div className="w-12 h-12 rounded-xl bg-secondary/80 flex items-center justify-center mx-auto mb-4">
                  <Receipt className="text-muted-foreground/50" size={20} />
                </div>
                <p className="text-sm font-semibold text-foreground mb-1">No transactions yet</p>
                <p className="text-xs text-muted-foreground">Your account activity will appear here.</p>
              </div>
            ) : (
              <>
                {/* Desktop table */}
                <div className="hidden sm:block">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/30">
                        <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Date</TableHead>
                        <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Type</TableHead>
                        <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Description</TableHead>
                        <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/70 text-right">Amount</TableHead>
                        <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/70 text-right">Balance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transactions.map((tx) => {
                        const config = TRANSACTION_TYPE_CONFIG[tx.type] || {
                          label: tx.type,
                          color: 'text-muted-foreground',
                          icon: DollarSign,
                        }
                        const Icon = config.icon
                        const isDebit = tx.amount > 0
                        return (
                          <TableRow key={tx.id} className="border-border/20">
                            <TableCell className="text-xs text-muted-foreground tabular-nums">
                              {formatDate(tx.created_at)}
                            </TableCell>
                            <TableCell>
                              <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${config.color}`}>
                                <Icon size={12} />
                                {config.label}
                              </span>
                            </TableCell>
                            <TableCell className="text-xs text-foreground max-w-[300px] truncate">
                              {tx.description}
                            </TableCell>
                            <TableCell className={`text-xs font-semibold text-right tabular-nums ${isDebit ? 'text-status-amber' : 'text-status-teal'}`}>
                              {isDebit ? '+' : ''}{formatCurrency(tx.amount)}
                            </TableCell>
                            <TableCell className="text-xs font-medium text-right tabular-nums text-foreground">
                              {formatCurrency(tx.running_balance)}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile cards */}
                <div className="sm:hidden divide-y divide-border/20">
                  {transactions.map((tx) => {
                    const config = TRANSACTION_TYPE_CONFIG[tx.type] || {
                      label: tx.type,
                      color: 'text-muted-foreground',
                      icon: DollarSign,
                    }
                    const Icon = config.icon
                    const isDebit = tx.amount > 0
                    return (
                      <div key={tx.id} className="px-5 py-3.5">
                        <div className="flex items-center justify-between mb-1">
                          <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${config.color}`}>
                            <Icon size={12} />
                            {config.label}
                          </span>
                          <span className={`text-sm font-semibold tabular-nums ${isDebit ? 'text-status-amber' : 'text-status-teal'}`}>
                            {isDebit ? '+' : ''}{formatCurrency(tx.amount)}
                          </span>
                        </div>
                        <p className="text-xs text-foreground/80 truncate">{tx.description}</p>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[11px] text-muted-foreground/60 tabular-nums">{formatDate(tx.created_at)}</span>
                          <span className="text-[11px] text-muted-foreground/60 tabular-nums">Bal: {formatCurrency(tx.running_balance)}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </Card>
        </section>
      </main>
    </div>
  )
}
