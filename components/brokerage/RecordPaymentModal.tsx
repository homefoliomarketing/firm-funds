'use client'

import { useEffect, useMemo, useState } from 'react'
import { DollarSign, X, CheckCircle2, AlertTriangle } from 'lucide-react'
import { submitBrokeragePaymentClaim, getBrokeragePayableDeals } from '@/lib/actions/brokerage-actions'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface PaymentEntry {
  amount: number
  date: string
  status?: 'pending' | 'confirmed' | 'rejected'
}

interface PayableDeal {
  id: string
  property_address: string
  status: string
  amount_due_from_brokerage: number | null
  brokerage_payments: PaymentEntry[] | null
  closing_date: string
  agents: { first_name?: string; last_name?: string } | null
}

const METHODS = [
  { value: 'eft', label: 'EFT / e-Transfer' },
  { value: 'wire', label: 'Wire transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'cash', label: 'Cash / in-person' },
  { value: 'other', label: 'Other' },
] as const

interface Props {
  open: boolean
  initialDealId?: string | null
  onClose: () => void
  onSuccess: (msg: string) => void
}

export default function RecordPaymentModal({ open, initialDealId, onClose, onSuccess }: Props) {
  const [deals, setDeals] = useState<PayableDeal[]>([])
  const [dealsLoading, setDealsLoading] = useState(false)
  const [dealId, setDealId] = useState<string>('')
  const [amount, setAmount] = useState<string>('')
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [reference, setReference] = useState<string>('')
  const [method, setMethod] = useState<string>('eft')
  const [notes, setNotes] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load eligible deals when modal opens
  useEffect(() => {
    if (!open) return
    setError(null)
    setDealsLoading(true)
    getBrokeragePayableDeals().then(r => {
      if (r.success) {
        const list = (r.data?.deals || []) as PayableDeal[]
        setDeals(list)
        // Preselect initialDealId if it's in the list, otherwise first
        if (initialDealId && list.some(d => d.id === initialDealId)) {
          setDealId(initialDealId)
        } else if (list.length > 0) {
          setDealId(list[0].id)
        } else {
          setDealId('')
        }
      } else {
        setError(r.error || 'Failed to load deals')
      }
      setDealsLoading(false)
    })
  }, [open, initialDealId])

  const selectedDeal = useMemo(
    () => deals.find(d => d.id === dealId) || null,
    [deals, dealId],
  )

  const remainingOnDeal = useMemo(() => {
    if (!selectedDeal) return 0
    const owed = selectedDeal.amount_due_from_brokerage || 0
    const payments = selectedDeal.brokerage_payments || []
    const counted = payments
      .filter(p => p.status === 'confirmed' || p.status === undefined)
      .reduce((s, p) => s + (p.amount || 0), 0)
    return owed - counted
  }, [selectedDeal])

  const pendingOnDeal = useMemo(() => {
    if (!selectedDeal) return 0
    const payments = selectedDeal.brokerage_payments || []
    return payments.filter(p => p.status === 'pending').reduce((s, p) => s + (p.amount || 0), 0)
  }, [selectedDeal])

  const reset = () => {
    setAmount('')
    setReference('')
    setNotes('')
    setMethod('eft')
    setDate(new Date().toISOString().slice(0, 10))
    setError(null)
  }

  const handleClose = () => {
    if (busy) return
    reset()
    onClose()
  }

  const handleSubmit = async () => {
    setError(null)
    if (!dealId) { setError('Please choose a deal'); return }
    const amt = parseFloat(amount)
    if (!Number.isFinite(amt) || amt <= 0) { setError('Enter a valid amount'); return }
    if (!date) { setError('Choose a payment date'); return }
    setBusy(true)
    const result = await submitBrokeragePaymentClaim({
      dealId,
      amount: amt,
      date,
      reference: reference.trim() || undefined,
      method: method as 'eft' | 'wire' | 'cheque' | 'cash' | 'other',
      notes: notes.trim() || undefined,
    })
    setBusy(false)
    if (result.success) {
      onSuccess(`Payment recorded. Firm Funds will confirm once the deposit is matched.`)
      reset()
      onClose()
    } else {
      setError(result.error || 'Failed to record payment')
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Record a payment"
      onClick={handleClose}
    >
      <Card className="w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="border-b border-border flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-primary">
            <DollarSign size={18} />
            Record a payment
          </CardTitle>
          <button
            onClick={handleClose}
            disabled={busy}
            className="p-1 rounded transition-colors text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </CardHeader>
        <CardContent className="p-5 space-y-4">
          <p className="text-xs text-muted-foreground">
            Record a payment your brokerage has sent to Firm Funds. We&apos;ll match it to a bank deposit and mark it confirmed.
          </p>

          {/* Deal picker */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deal</Label>
            {dealsLoading ? (
              <div className="text-sm text-muted-foreground py-2">Loading eligible deals…</div>
            ) : deals.length === 0 ? (
              <div className="rounded-lg p-3 bg-muted/30 border border-border text-xs text-muted-foreground">
                No funded or completed deals to record a payment against yet.
              </div>
            ) : (
              <select
                value={dealId}
                onChange={(e) => setDealId(e.target.value)}
                disabled={busy}
                className="w-full rounded-lg px-3 py-2 text-sm bg-background border border-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
                aria-label="Deal"
              >
                {deals.map(d => {
                  const agentName = d.agents ? `${d.agents.first_name ?? ''} ${d.agents.last_name ?? ''}`.trim() : ''
                  return (
                    <option key={d.id} value={d.id}>
                      {d.property_address}{agentName ? ` · ${agentName}` : ''}
                    </option>
                  )
                })}
              </select>
            )}
          </div>

          {/* Deal summary */}
          {selectedDeal && (
            <div className="rounded-lg p-3 bg-muted/30 border border-border text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount owed</span>
                <span className="font-semibold text-foreground tabular-nums">{formatCurrency(selectedDeal.amount_due_from_brokerage || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Remaining (after confirmed)</span>
                <span className="font-semibold text-foreground tabular-nums">{formatCurrency(Math.max(remainingOnDeal, 0))}</span>
              </div>
              {pendingOnDeal > 0 && (
                <div className="flex justify-between text-amber-400">
                  <span>Pending confirmation</span>
                  <span className="font-semibold tabular-nums">{formatCurrency(pendingOnDeal)}</span>
                </div>
              )}
              <div className="flex justify-between text-muted-foreground/70 pt-1 border-t border-border/30 mt-1">
                <span>Closing</span>
                <span>{formatDate(selectedDeal.closing_date)}</span>
              </div>
            </div>
          )}

          {/* Amount + date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Amount (CAD)</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                disabled={busy}
              />
              {selectedDeal && remainingOnDeal > 0 && (
                <button
                  type="button"
                  onClick={() => setAmount(remainingOnDeal.toFixed(2))}
                  className="text-[11px] text-primary hover:underline"
                >
                  Fill {formatCurrency(remainingOnDeal)} (remaining)
                </button>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Date sent</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                max={new Date().toISOString().slice(0, 10)}
                disabled={busy}
              />
            </div>
          </div>

          {/* Method + reference */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Method</Label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                disabled={busy}
                className="w-full rounded-lg px-3 py-2 text-sm bg-background border border-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
                aria-label="Payment method"
              >
                {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reference (optional)</Label>
              <Input
                type="text"
                maxLength={200}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Cheque #, wire ref, etc."
                disabled={busy}
              />
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes (optional)</Label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              rows={3}
              disabled={busy}
              placeholder="Anything Firm Funds should know about this payment"
              className="w-full rounded-lg px-3 py-2 text-sm bg-background border border-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
            />
          </div>

          {/* Info banner */}
          <div className="rounded-lg px-3 py-2 bg-blue-500/10 border border-blue-500/20 text-xs">
            <p className="text-blue-300 leading-relaxed flex items-start gap-2">
              <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
              <span>
                <strong>What happens next:</strong> your claim is logged immediately. A Firm Funds admin will match it to a bank deposit and mark it confirmed, typically within 1 business day. Pending claims don&apos;t reduce your balance owed until confirmed.
              </span>
            </p>
          </div>

          {error && (
            <div className="rounded-lg px-3 py-2 bg-destructive/10 border border-destructive/30 text-xs text-destructive flex items-start gap-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={handleClose} disabled={busy}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={busy || deals.length === 0 || !dealId}>
              {busy ? 'Recording…' : 'Record payment'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
