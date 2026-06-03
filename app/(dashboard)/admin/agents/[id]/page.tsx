import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, User, Building2, DollarSign, Mail, Phone,
  FileText, ChevronRight, AlertTriangle, BadgeCheck,
} from 'lucide-react'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { getStatusBadgeClass } from '@/lib/constants'
import AgentLedger from '@/components/AgentLedger'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { AgentAccountTransaction } from '@/types/database'

export const metadata = {
  title: 'Agent Profile | Firm Funds Admin',
  robots: { index: false, follow: false },
}

const humanizeStatus = (s: string) =>
  s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

type DealRow = {
  id: string
  property_address: string | null
  status: string
  advance_amount: number | string | null
  gross_commission: number | string | null
  closing_date: string | null
  created_at: string
}

// Admin-facing read-only window into a single agent: identity, current balance,
// their deals, and the full transaction ledger (the same ledger the agent sees
// on /agent/account, rendered via the shared <AgentLedger>). Linked from the
// agent's name on the deal page. Service-role reads — RLS would otherwise hide
// cross-brokerage agents from admins in some cases.
export default async function AdminAgentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (
    !profile ||
    profile.is_active === false ||
    !['super_admin', 'firm_funds_admin'].includes(profile.role)
  ) {
    redirect('/login')
  }

  const service = createServiceRoleClient()

  const { data: agent } = await service
    .from('agents')
    .select(
      'id, first_name, last_name, email, phone, reco_number, status, account_balance, flagged_by_brokerage, outstanding_recovery, created_at, brokerages(id, name, brand)',
    )
    .eq('id', id)
    .single()

  if (!agent) notFound()

  const brokerageRel = agent.brokerages as
    | { id: string; name: string | null; brand: string | null }[]
    | { id: string; name: string | null; brand: string | null }
    | null
  const brokerage = Array.isArray(brokerageRel) ? brokerageRel[0] ?? null : brokerageRel

  const { data: dealRows } = await service
    .from('deals')
    .select('id, property_address, status, advance_amount, gross_commission, closing_date, created_at')
    .eq('agent_id', id)
    .order('created_at', { ascending: false })

  const deals = (dealRows ?? []) as DealRow[]

  const { data: txnRows } = await service
    .from('agent_transactions')
    .select('id, agent_id, deal_id, type, amount, running_balance, description, reference_id, created_by, created_at')
    .eq('agent_id', id)
    .order('created_at', { ascending: false })

  const transactions = (txnRows ?? []) as AgentAccountTransaction[]
  const balance = Number(agent.account_balance) || 0
  const recovery = agent.outstanding_recovery != null ? Number(agent.outstanding_recovery) : 0
  const fullName = `${agent.first_name ?? ''} ${agent.last_name ?? ''}`.trim() || 'Agent'

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/admin"
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Admin
          </Link>
          <div className="w-px h-6 bg-border/30" aria-hidden="true" />
          <div className="flex items-center gap-2 min-w-0">
            <User size={16} className="text-primary flex-shrink-0" aria-hidden="true" />
            <h1 className="text-sm font-semibold text-foreground truncate">{fullName}</h1>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        {/* Identity */}
        <section aria-label="Agent details">
          <Card className="border-border/40">
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <User className="w-6 h-6 text-primary" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-lg font-bold text-foreground leading-tight">{fullName}</h2>
                    <Badge variant="outline" className={`text-[10px] py-0 h-5 ${getStatusBadgeClass(agent.status)}`}>
                      {humanizeStatus(agent.status)}
                    </Badge>
                    {agent.flagged_by_brokerage && (
                      <Badge variant="outline" className="text-[10px] py-0 h-5 border-amber-800/40 text-amber-400 bg-amber-950/30 inline-flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" aria-hidden="true" /> Flagged by brokerage
                      </Badge>
                    )}
                    {recovery > 0 && (
                      <Badge variant="outline" className="text-[10px] py-0 h-5 border-destructive/40 text-destructive bg-destructive/10">
                        Recovery: {formatCurrency(recovery)}
                      </Badge>
                    )}
                  </div>

                  <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <Mail size={14} className="text-muted-foreground/60 flex-shrink-0" aria-hidden="true" />
                      <dt className="sr-only">Email</dt>
                      <dd className="min-w-0 truncate">
                        {agent.email ? (
                          <a href={`mailto:${agent.email}`} className="text-foreground hover:text-primary hover:underline underline-offset-2">
                            {agent.email}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">No email on file</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <Phone size={14} className="text-muted-foreground/60 flex-shrink-0" aria-hidden="true" />
                      <dt className="sr-only">Phone</dt>
                      <dd className="min-w-0 truncate">
                        {agent.phone ? (
                          <a href={`tel:${agent.phone}`} className="text-foreground hover:text-primary hover:underline underline-offset-2">
                            {agent.phone}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">No phone on file</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 size={14} className="text-muted-foreground/60 flex-shrink-0" aria-hidden="true" />
                      <dt className="sr-only">Brokerage</dt>
                      <dd className="min-w-0 truncate">
                        {brokerage ? (
                          <Link href={`/admin/brokerages/${brokerage.id}`} className="text-foreground hover:text-primary hover:underline underline-offset-2">
                            {brokerage.name}{brokerage.brand ? ` · ${brokerage.brand}` : ''}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">No brokerage</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <BadgeCheck size={14} className="text-muted-foreground/60 flex-shrink-0" aria-hidden="true" />
                      <dt className="sr-only">RECO number</dt>
                      <dd className="text-foreground">
                        {agent.reco_number ? `RECO ${agent.reco_number}` : <span className="text-muted-foreground">No RECO number</span>}
                      </dd>
                    </div>
                  </dl>
                  <p className="text-xs text-muted-foreground/70 mt-3">Member since {formatDate(agent.created_at)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Balance */}
        <section aria-label="Account balance">
          <Card className={`border-border/40 ${balance > 0 ? 'ring-1 ring-status-amber-border/40' : ''}`}>
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">
                    Current Balance
                  </p>
                  <p className={`text-3xl font-bold tabular-nums ${balance > 0 ? 'text-status-amber' : 'text-status-teal'}`}>
                    {formatCurrency(balance)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {balance > 0 ? 'This agent has an outstanding balance owing.' : 'This agent has no outstanding charges.'}
                  </p>
                </div>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${balance > 0 ? 'bg-status-amber-muted/60' : 'bg-status-teal-muted/60'}`}>
                  <DollarSign size={24} className={balance > 0 ? 'text-status-amber' : 'text-status-teal'} aria-hidden="true" />
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Deals */}
        <section aria-label="Agent deals">
          <Card className="overflow-hidden border-border/40">
            <div className="px-5 sm:px-6 py-4 border-b border-border/40 flex items-center gap-2">
              <FileText size={16} className="text-primary" aria-hidden="true" />
              <h2 className="text-base font-bold text-foreground">Deals</h2>
              <span className="text-xs text-muted-foreground">({deals.length})</span>
            </div>
            {deals.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-sm text-muted-foreground">This agent has no deals yet.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border/20">
                {deals.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/admin/deals/${d.id}`}
                      className="group flex items-center gap-3 px-5 sm:px-6 py-3 hover:bg-white/5 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                          {d.property_address || 'Untitled deal'}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {d.closing_date ? `Closing ${formatDate(d.closing_date)}` : 'No closing date'}
                          {d.advance_amount != null ? ` · Advance ${formatCurrency(Number(d.advance_amount))}` : ''}
                        </p>
                      </div>
                      <Badge variant="outline" className={`text-[10px] py-0 h-5 flex-shrink-0 ${getStatusBadgeClass(d.status)}`}>
                        {humanizeStatus(d.status)}
                      </Badge>
                      <ChevronRight size={16} className="text-muted-foreground/50 group-hover:text-primary transition-colors flex-shrink-0" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        {/* Ledger */}
        <AgentLedger transactions={transactions} emptyHint="This agent has no account activity yet." />
      </main>
    </div>
  )
}
