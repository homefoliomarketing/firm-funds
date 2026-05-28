'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, DollarSign, Search, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/formatting'
import { cn } from '@/lib/utils'

// The server action wiring lives in lib/actions/balance-adjustment-actions.ts.
// It may not exist yet — see Task 1 in the prompt. Imports use a loose shape
// so TypeScript doesn't choke if the module is still being scaffolded by the
// backend agent. When the file lands we'll drop the cast.

interface AdjustAgentBalancePayload {
  agentId: string
  amount: number
  description: string
  reason: string
  notes: string
  idempotencyKey: string
}

interface AdjustAgentBalanceResult {
  success: boolean
  error?: string
  data?: { newBalance?: number } | null
}

type AdjustAgentBalanceFn = (
  payload: AdjustAgentBalancePayload,
) => Promise<AdjustAgentBalanceResult>

let adjustAgentBalanceImpl: AdjustAgentBalanceFn | null = null
async function callAdjustAgentBalance(
  payload: AdjustAgentBalancePayload,
): Promise<AdjustAgentBalanceResult> {
  if (!adjustAgentBalanceImpl) {
    try {
      // Dynamic import — module may not exist yet, cast loosely.
      const mod = (await import(
        '@/lib/actions/balance-adjustment-actions' as string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as any
      adjustAgentBalanceImpl = mod.adjustAgentBalance as AdjustAgentBalanceFn
    } catch {
      // Fallback to the long-standing per-agent action in brokerages page so
      // we always have a working server call until the dedicated module ships.
      const fallback = (await import('@/lib/actions/account-actions')) as unknown as {
        adjustAgentBalance: AdjustAgentBalanceFn
      }
      adjustAgentBalanceImpl = fallback.adjustAgentBalance
    }
  }
  return adjustAgentBalanceImpl(payload)
}

// ============================================================================
// Types
// ============================================================================

export interface BalanceAdjustmentAgent {
  id: string
  first_name: string
  last_name: string
  email: string | null
  account_balance: number
  brokerage_name?: string | null
}

type Direction = 'credit' | 'debit'

const REASON_OPTIONS = [
  { value: 'refund', label: 'Refund' },
  { value: 'correction', label: 'Correction' },
  { value: 'write_off', label: 'Write-off' },
  { value: 'manual_charge', label: 'Manual Charge' },
  { value: 'other', label: 'Other' },
] as const

// Default direction by reason — small UX win so admins start in the right place.
const DEFAULT_DIRECTION: Record<(typeof REASON_OPTIONS)[number]['value'], Direction> = {
  refund: 'credit',
  correction: 'credit',
  write_off: 'credit',
  manual_charge: 'debit',
  other: 'credit',
}

// ============================================================================
// Component
// ============================================================================

export function BalanceAdjustmentForm({
  agents,
}: {
  agents: BalanceAdjustmentAgent[]
}) {
  const router = useRouter()

  const [search, setSearch] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [direction, setDirection] = useState<Direction>('credit')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState<(typeof REASON_OPTIONS)[number]['value']>('refund')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Generated once when the modal opens so accidental double-clicks coalesce
  // to a single posting on the server (matches the pattern used in the
  // brokerages page balance modal). Regenerated whenever the user re-opens
  // the confirmation dialog so retried submissions are intentional.
  const [idempotencyKey, setIdempotencyKey] = useState('')

  const selectedAgent = useMemo(
    () => agents.find(a => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  )

  // Reset direction default whenever reason changes — but only if the user
  // hasn't manually picked a direction yet (i.e. amount field is still empty).
  useEffect(() => {
    if (!amount.trim()) {
      setDirection(DEFAULT_DIRECTION[reason])
    }
  }, [reason, amount])

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return agents.slice(0, 50)
    return agents
      .filter(a => {
        const name = `${a.first_name} ${a.last_name}`.toLowerCase()
        const email = (a.email ?? '').toLowerCase()
        const brokerage = (a.brokerage_name ?? '').toLowerCase()
        return (
          name.includes(q) || email.includes(q) || brokerage.includes(q)
        )
      })
      .slice(0, 50)
  }, [agents, search])

  const parsedAmount = useMemo(() => {
    const n = parseFloat(amount)
    return Number.isFinite(n) && n > 0 ? n : null
  }, [amount])

  const validate = (): string | null => {
    if (!selectedAgent) return 'Select an agent first.'
    if (parsedAmount == null) return 'Enter a positive dollar amount.'
    if (!notes.trim()) return 'Notes are required so we can explain this later.'
    return null
  }

  const openConfirm = () => {
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setError(null)
    setIdempotencyKey(
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    setConfirming(true)
  }

  const submit = async () => {
    if (!selectedAgent || parsedAmount == null) return

    setSubmitting(true)
    setError(null)

    try {
      // Credit reduces what the agent owes (delta is negative on the ledger);
      // debit / "manual charge" increases what they owe (positive delta).
      const signedAmount = direction === 'credit' ? -parsedAmount : parsedAmount

      const reasonLabel =
        REASON_OPTIONS.find(r => r.value === reason)?.label ?? reason
      const description = `${reasonLabel}: ${notes.trim()}`

      const result = await callAdjustAgentBalance({
        agentId: selectedAgent.id,
        amount: signedAmount,
        description,
        reason,
        notes: notes.trim(),
        idempotencyKey,
      })

      if (!result?.success) {
        setError(result?.error || 'Failed to post adjustment.')
        return
      }

      const newBalance =
        result.data?.newBalance ??
        // Optimistic fallback so the toast can still show a number when the
        // server response shape predates `newBalance`.
        selectedAgent.account_balance + signedAmount

      toast.success('Balance adjusted', {
        description: `${selectedAgent.first_name} ${selectedAgent.last_name} — new balance ${formatCurrency(newBalance)}`,
      })

      // Reset form, close modal, refresh agent list so balances repopulate
      // (server component re-renders).
      setConfirming(false)
      setSelectedAgentId(null)
      setAmount('')
      setNotes('')
      setReason('refund')
      setSearch('')
      router.refresh()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.'
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  // ==========================================================================
  // Render
  // ==========================================================================

  return (
    <Card className="border-border/40 bg-card">
      <CardHeader className="py-4 px-5 border-b border-border/40">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <DollarSign size={16} className="text-primary" />
          Adjust Agent Balance
        </CardTitle>
      </CardHeader>

      <CardContent className="p-5 space-y-5">
        {/* ===== Agent picker ===== */}
        <fieldset className="space-y-2">
          <legend className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80 mb-2">
            1. Agent
          </legend>

          {selectedAgent ? (
            <div
              className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-primary/40 bg-primary/5"
              aria-live="polite"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">
                  {selectedAgent.first_name} {selectedAgent.last_name}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {selectedAgent.email || 'No email on file'}
                  {selectedAgent.brokerage_name ? ` · ${selectedAgent.brokerage_name}` : ''}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Current balance:{' '}
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      selectedAgent.account_balance > 0
                        ? 'text-destructive'
                        : selectedAgent.account_balance < 0
                          ? 'text-status-green'
                          : 'text-foreground',
                    )}
                  >
                    {formatCurrency(selectedAgent.account_balance)}
                  </span>
                  {selectedAgent.account_balance > 0 && (
                    <span className="ml-1 text-muted-foreground/70">(owes)</span>
                  )}
                  {selectedAgent.account_balance < 0 && (
                    <span className="ml-1 text-muted-foreground/70">(credit)</span>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedAgentId(null)}
                className="gap-1"
                aria-label="Clear selected agent"
              >
                <X size={14} />
                Change
              </Button>
            </div>
          ) : (
            <>
              <Label htmlFor="agent-search" className="sr-only">
                Search agents by name, email, or brokerage
              </Label>
              <div className="relative">
                <Search
                  aria-hidden="true"
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50"
                />
                <Input
                  id="agent-search"
                  type="search"
                  autoComplete="off"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by name, email, or brokerage..."
                  className="pl-9"
                />
              </div>

              <div
                role="listbox"
                aria-label="Agent search results"
                className="border border-border/40 rounded-lg max-h-64 overflow-y-auto divide-y divide-border/30 bg-card/40"
              >
                {filteredAgents.length === 0 ? (
                  <EmptyState
                    compact
                    title="No agents match your search"
                    description="Try a different name, email, or brokerage."
                  />
                ) : (
                  filteredAgents.map(agent => (
                    <button
                      key={agent.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => setSelectedAgentId(agent.id)}
                      className="w-full text-left px-3 py-2.5 hover:bg-primary/5 focus:bg-primary/5 focus:outline-none transition-colors"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {agent.first_name} {agent.last_name}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {agent.email || 'No email'}
                            {agent.brokerage_name ? ` · ${agent.brokerage_name}` : ''}
                          </p>
                        </div>
                        <span
                          className={cn(
                            'text-xs font-semibold tabular-nums shrink-0',
                            agent.account_balance > 0
                              ? 'text-destructive'
                              : agent.account_balance < 0
                                ? 'text-status-green'
                                : 'text-muted-foreground',
                          )}
                        >
                          {formatCurrency(agent.account_balance)}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </fieldset>

        {/* ===== Amount + direction ===== */}
        <fieldset className="space-y-2">
          <legend className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80 mb-2">
            2. Amount
          </legend>

          <div
            role="radiogroup"
            aria-label="Adjustment direction"
            className="grid grid-cols-2 gap-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={direction === 'credit'}
              onClick={() => setDirection('credit')}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                direction === 'credit'
                  ? 'border-status-green bg-status-green/10 ring-2 ring-status-green/30'
                  : 'border-border/40 hover:border-border',
              )}
            >
              <p
                className={cn(
                  'text-sm font-semibold',
                  direction === 'credit' ? 'text-status-green' : 'text-foreground',
                )}
              >
                + Credit
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Reduces what the agent owes
              </p>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={direction === 'debit'}
              onClick={() => setDirection('debit')}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                direction === 'debit'
                  ? 'border-destructive bg-destructive/10 ring-2 ring-destructive/30'
                  : 'border-border/40 hover:border-border',
              )}
            >
              <p
                className={cn(
                  'text-sm font-semibold',
                  direction === 'debit' ? 'text-destructive' : 'text-foreground',
                )}
              >
                − Debit
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Increases what the agent owes
              </p>
            </button>
          </div>

          <div>
            <Label htmlFor="adjust-amount" className="text-xs">
              Dollar amount
            </Label>
            <div className="relative mt-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  'absolute left-3 top-1/2 -translate-y-1/2 text-base font-semibold tabular-nums',
                  direction === 'credit' ? 'text-status-green' : 'text-destructive',
                )}
              >
                {direction === 'credit' ? '+' : '−'}
              </span>
              <Input
                id="adjust-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="pl-7 tabular-nums"
                aria-describedby="adjust-amount-hint"
              />
            </div>
            <p
              id="adjust-amount-hint"
              className="text-[11px] text-muted-foreground mt-1"
            >
              The sign is set by the Credit / Debit choice above. Enter a positive number.
            </p>
          </div>
        </fieldset>

        {/* ===== Reason ===== */}
        <fieldset className="space-y-2">
          <legend className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80 mb-2">
            3. Reason
          </legend>

          <div>
            <Label htmlFor="adjust-reason" className="text-xs">
              Category
            </Label>
            <Select
              value={reason}
              onValueChange={v => setReason(v as typeof reason)}
            >
              <SelectTrigger id="adjust-reason" className="w-full mt-1.5">
                <SelectValue placeholder="Pick a reason" />
              </SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="adjust-notes" className="text-xs">
              Notes (required — explains the adjustment in audit log)
            </Label>
            <Textarea
              id="adjust-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Reversing duplicate late-interest charge on deal #1234"
              rows={3}
              className="mt-1.5"
              required
              aria-required="true"
            />
          </div>
        </fieldset>

        {/* ===== Error ===== */}
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        {/* ===== Submit ===== */}
        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-[11px] text-muted-foreground">
            A confirmation modal will appear before posting.
          </p>
          <Button
            onClick={openConfirm}
            disabled={!selectedAgent || !parsedAmount || !notes.trim()}
            className="gap-1.5"
          >
            Review adjustment
          </Button>
        </div>
      </CardContent>

      {/* ===== Confirmation dialog ===== */}
      <Dialog
        open={confirming}
        onOpenChange={open => {
          if (!submitting) setConfirming(open)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Confirm adjustment for {selectedAgent?.first_name} {selectedAgent?.last_name}?
            </DialogTitle>
            <DialogDescription>
              This posts a ledger entry and writes to the audit log. It can be reversed
              with a matching opposite adjustment, but not deleted.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border/40 bg-muted/30 p-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Agent</span>
              <span className="font-medium text-foreground">
                {selectedAgent?.first_name} {selectedAgent?.last_name}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Direction</span>
              <span
                className={cn(
                  'font-semibold',
                  direction === 'credit' ? 'text-status-green' : 'text-destructive',
                )}
              >
                {direction === 'credit' ? 'Credit (reduce owed)' : 'Debit (increase owed)'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount</span>
              <span
                className={cn(
                  'font-bold tabular-nums',
                  direction === 'credit' ? 'text-status-green' : 'text-destructive',
                )}
              >
                {direction === 'credit' ? '+' : '−'}
                {parsedAmount != null ? formatCurrency(parsedAmount) : '$0.00'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reason</span>
              <span className="font-medium text-foreground">
                {REASON_OPTIONS.find(r => r.value === reason)?.label}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground shrink-0">Notes</span>
              <span className="font-medium text-foreground text-right">
                {notes.trim()}
              </span>
            </div>
            {selectedAgent ? (
              <div className="flex justify-between pt-2 border-t border-border/40">
                <span className="text-muted-foreground">Resulting balance</span>
                <span className="font-bold tabular-nums text-foreground">
                  {formatCurrency(
                    selectedAgent.account_balance +
                      (direction === 'credit'
                        ? -(parsedAmount ?? 0)
                        : (parsedAmount ?? 0)),
                  )}
                </span>
              </div>
            ) : null}
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting}
              className="gap-1.5"
            >
              {submitting ? (
                <>
                  <LoadingSpinner label="" />
                  Submitting...
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} aria-hidden="true" />
                  Confirm adjustment
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
