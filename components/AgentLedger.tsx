import { ArrowDownLeft, ArrowUpRight, Receipt, Clock, AlertTriangle, DollarSign } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AgentAccountTransaction } from '@/types/database'

// Shared between the agent's own Account & Ledger page (/agent/account) and the
// admin agent profile page (/admin/agents/[id]). Presentational only — the
// caller fetches the transactions (agent self-serve via the client, admin via
// the service-role server query) and passes them in.
const TRANSACTION_TYPE_CONFIG: Record<string, { label: string; color: string; icon: typeof ArrowUpRight; informational?: boolean }> = {
  late_closing_interest: { label: 'Late Closing Interest', color: 'text-status-amber', icon: Clock },
  late_payment_interest: { label: 'Late Payment Interest', color: 'text-status-amber', icon: Clock },
  balance_deduction: { label: 'Balance Deduction', color: 'text-status-teal', icon: ArrowDownLeft },
  balance_deduction_reversed: { label: 'Balance Deduction Reversed', color: 'text-status-teal', icon: ArrowDownLeft },
  invoice_payment: { label: 'Invoice Payment', color: 'text-status-teal', icon: Receipt },
  adjustment: { label: 'Adjustment', color: 'text-muted-foreground', icon: DollarSign },
  credit: { label: 'Credit', color: 'text-status-teal', icon: ArrowDownLeft },
  failed_deal_balance: { label: 'Failed Deal Balance', color: 'text-status-red', icon: AlertTriangle },
  failed_deal_interest: { label: 'Failed Deal Interest', color: 'text-status-amber', icon: Clock },
  // Informational deal-activity entries (migration 106). Shown for the record;
  // they do NOT change the agent's account balance, so the Balance column
  // renders a dash rather than a (misleading) frozen running total.
  deal_advance: { label: 'Advance Issued', color: 'text-status-amber', icon: ArrowUpRight, informational: true },
  deal_repayment: { label: 'Repayment Received', color: 'text-status-teal', icon: ArrowDownLeft, informational: true },
}

export default function AgentLedger({
  transactions,
  emptyHint = 'Account activity will appear here.',
}: {
  transactions: AgentAccountTransaction[]
  emptyHint?: string
}) {
  const hasInformational = transactions.some(
    (tx) => TRANSACTION_TYPE_CONFIG[tx.type]?.informational,
  )
  return (
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
            <p className="text-xs text-muted-foreground">{emptyHint}</p>
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
                          {config.informational ? (
                            <span className="text-muted-foreground/50 font-normal" title="Does not affect your account balance">
                              n/a
                            </span>
                          ) : (
                            formatCurrency(tx.running_balance)
                          )}
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
                      <span className="text-[11px] text-muted-foreground/60 tabular-nums">
                        {config.informational ? 'Balance: not affected' : `Bal: ${formatCurrency(tx.running_balance)}`}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>

            {hasInformational && (
              <div className="px-5 sm:px-6 py-3 border-t border-border/40">
                <p className="text-[11px] text-muted-foreground">
                  Advance and repayment lines are shown for your records and do not change your account balance.
                </p>
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  )
}
