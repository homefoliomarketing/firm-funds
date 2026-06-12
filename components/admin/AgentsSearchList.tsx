'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, ChevronRight } from 'lucide-react'

import { formatCurrency } from '@/lib/formatting'
import { getStatusBadgeClass, formatStatusLabel } from '@/lib/constants'
import { EmptyState } from '@/components/ui/empty-state'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

// One agent row as loaded by the server page. The brokerage relation is already
// normalized to a single object (or null) before it reaches this component.
export type AgentListItem = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  reco_number: string | null
  status: string
  account_balance: number
  brokerage: { id: string; name: string | null } | null
}

// Client-side searchable list/table of every agent. The full set is passed down
// from the server page (modest count) and filtered live by name, email, or RECO
// number. Each result links to the agent's ledger at /admin/agents/[id].
export function AgentsSearchList({ agents }: { agents: AgentListItem[] }) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return agents
    return agents.filter((a) => {
      const fullName = `${a.first_name ?? ''} ${a.last_name ?? ''}`.toLowerCase()
      const email = (a.email ?? '').toLowerCase()
      const reco = (a.reco_number ?? '').toLowerCase()
      return fullName.includes(q) || email.includes(q) || reco.includes(q)
    })
  }, [agents, query])

  return (
    <section aria-label="Agents">
      <Card className="border-border/40 shadow-lg shadow-black/20 overflow-hidden">
        {/* Search + result count */}
        <div className="py-4 px-5 sm:px-6 border-b border-border/40 bg-card/80 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-foreground">All Agents</h2>
            <span className="text-xs text-muted-foreground/60 tabular-nums" aria-live="polite">
              {filtered.length} of {agents.length}
            </span>
          </div>
          <div className="relative">
            <Label htmlFor="agent-search" className="sr-only">
              Search agents by name, email, or RECO number
            </Label>
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/40"
              aria-hidden="true"
            />
            <Input
              id="agent-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email, or RECO..."
              aria-label="Search agents by name, email, or RECO number"
              className="pl-9 h-9 w-full sm:w-72 bg-secondary/30 border-border/30 placeholder:text-muted-foreground/40"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title={query.trim() ? 'No agents match your search' : 'No agents yet'}
            description={
              query.trim()
                ? 'Try a different name, email, or RECO number.'
                : 'Agents will appear here once they are added to a brokerage.'
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-border/50">
                    <TableHead scope="col" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Agent</TableHead>
                    <TableHead scope="col" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Brokerage</TableHead>
                    <TableHead scope="col" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Email</TableHead>
                    <TableHead scope="col" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">RECO</TableHead>
                    <TableHead scope="col" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5">Status</TableHead>
                    <TableHead scope="col" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70 py-3.5 text-right">Balance</TableHead>
                    <TableHead scope="col" className="w-8"><span className="sr-only">Open ledger</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((agent) => (
                    <AgentTableRow key={agent.id} agent={agent} />
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <ul className="md:hidden divide-y divide-border/20">
              {filtered.map((agent) => (
                <li key={agent.id}>
                  <AgentMobileCard agent={agent} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </section>
  )
}

const fullNameOf = (a: AgentListItem) =>
  `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || 'Unnamed agent'

// Balance coloring mirrors the agent profile page's balance card exactly:
//   > 0  → agent owes Firm Funds an outstanding balance (amber)
//   < 0  → a credit Firm Funds owes back to the agent, a refund (teal)
//   == 0 → nothing outstanding (muted)
// The credit is shown as a positive amount with a "credit" label, matching the
// profile card which renders Math.abs(balance) for the owed-refund state.
function BalanceCell({ balance }: { balance: number }) {
  const owesUs = balance > 0
  const owedRefund = balance < 0
  const accent = owesUs
    ? 'text-status-amber'
    : owedRefund
      ? 'text-status-teal'
      : 'text-muted-foreground'
  const display = formatCurrency(owedRefund ? Math.abs(balance) : balance)
  const srSuffix = owesUs ? ', owing' : owedRefund ? ' credit, refund owed' : ', no balance'
  return (
    <span className={`font-bold tabular-nums ${accent}`}>
      {display}
      <span className="sr-only">{srSuffix}</span>
    </span>
  )
}

function AgentTableRow({ agent }: { agent: AgentListItem }) {
  const name = fullNameOf(agent)
  return (
    <TableRow className="border-border/30 hover:bg-white/[0.03] transition-colors group">
      <TableCell className="text-[13px] font-semibold">
        <Link
          href={`/admin/agents/${agent.id}`}
          className="text-foreground hover:text-primary hover:underline underline-offset-2 transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {name}
        </Link>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {agent.brokerage?.name ?? <span className="text-muted-foreground/50">No brokerage</span>}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {agent.email ?? <span className="text-muted-foreground/50">No email</span>}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground tabular-nums">
        {agent.reco_number ?? <span className="text-muted-foreground/50">-</span>}
      </TableCell>
      <TableCell>
        <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-md ${getStatusBadgeClass(agent.status)}`}>
          {formatStatusLabel(agent.status)}
        </span>
      </TableCell>
      <TableCell className="text-sm text-right">
        <BalanceCell balance={agent.account_balance} />
      </TableCell>
      <TableCell>
        <Link
          href={`/admin/agents/${agent.id}`}
          aria-label={`Open ledger for ${name}`}
          className="inline-flex rounded-sm text-muted-foreground/30 group-hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </TableCell>
    </TableRow>
  )
}

function AgentMobileCard({ agent }: { agent: AgentListItem }) {
  const name = fullNameOf(agent)
  return (
    <Link
      href={`/admin/agents/${agent.id}`}
      className="group flex items-center gap-3 px-4 py-3.5 hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:bg-white/5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
            {name}
          </p>
          <span className={`inline-flex px-1.5 py-0 text-[10px] font-semibold rounded ${getStatusBadgeClass(agent.status)}`}>
            {formatStatusLabel(agent.status)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {agent.brokerage?.name ?? 'No brokerage'}
          {agent.email ? ` · ${agent.email}` : ''}
        </p>
        <p className="text-[11px] text-muted-foreground/70 mt-0.5">
          {agent.reco_number ? `RECO ${agent.reco_number} · ` : ''}
          <BalanceCell balance={agent.account_balance} />
        </p>
      </div>
      <ChevronRight size={16} className="text-muted-foreground/50 group-hover:text-primary transition-colors flex-shrink-0" aria-hidden="true" />
    </Link>
  )
}
