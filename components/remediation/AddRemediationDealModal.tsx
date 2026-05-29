'use client'

// Shared "Add Remediation Deal" modal. Used by:
//   - FF admin failed-deal detail panel (RemediationDealsPanel.tsx)
//   - Brokerage admin failed-deals list page (/brokerage/failed-deals)
//   - Agent's own failed-deals list page (/agent/failed-deals)
//
// The form fields and validation are identical across all three callers.
// Server-side authorization decides whether the caller is allowed to act
// on this failed deal; see lib/actions/remediation-actions.ts for the
// tenancy guard.

import { useEffect, useState } from 'react'
import { FileSignature, RefreshCw } from 'lucide-react'
import { createRemediationDeal } from '@/lib/actions/remediation-actions'
import { formatCurrency } from '@/lib/formatting'
import { SETTLEMENT_PERIOD_DAYS } from '@/lib/constants'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface AgentBrokerageDefaults {
  brokerageId: string | null
  brokerageName: string
  brokerageAddress: string
  brokerOfRecordName: string
  brokerOfRecordEmail: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  failedDealId: string
  /** Current live balance owed on the failed deal — pre-fills directed amount. */
  liveBalanceOwed: number
  /** Brokerage details for the agent (defaults from the agent's file). */
  brokerageDefaults: AgentBrokerageDefaults | null
  /** Fired after a successful create. Parent should refresh its list. */
  onCreated?: () => void
}

const emptyForm = () => ({
  propertyAddress: '',
  mlsNumber: '',
  brokerageLegalName: '',
  brokerageAddress: '',
  brokerOfRecordName: '',
  brokerOfRecordEmail: '',
  expectedCommission: '',
  expectedClosingDate: '',
  expectedPaymentDate: '',
  directedAmount: '',
  notes: '',
})

function addDaysIso(dateStr: string, days: number): string {
  if (!dateStr) return ''
  const ms = new Date(dateStr + 'T00:00:00Z').getTime() + days * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

export default function AddRemediationDealModal({
  open,
  onOpenChange,
  failedDealId,
  liveBalanceOwed,
  brokerageDefaults,
  onCreated,
}: Props) {
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the form whenever the modal opens. This keeps prior typed values
  // from leaking back when the user reopens after a cancel.
  useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      ...emptyForm(),
      brokerageLegalName: brokerageDefaults?.brokerageName || '',
      brokerageAddress: brokerageDefaults?.brokerageAddress || '',
      brokerOfRecordName: brokerageDefaults?.brokerOfRecordName || '',
      brokerOfRecordEmail: brokerageDefaults?.brokerOfRecordEmail || '',
      directedAmount: liveBalanceOwed > 0 ? liveBalanceOwed.toFixed(2) : '',
    })
  }, [open, brokerageDefaults, liveBalanceOwed])

  const handleSubmit = async () => {
    setError(null)
    const directed = parseFloat(form.directedAmount)
    if (!form.propertyAddress.trim()) { setError('Property address is required'); return }
    if (!form.brokerageLegalName.trim()) { setError('Brokerage legal name is required'); return }
    if (!Number.isFinite(directed) || directed <= 0) { setError('Directed amount must be greater than zero'); return }

    setSaving(true)
    const result = await createRemediationDeal({
      failedDealId,
      propertyAddress: form.propertyAddress,
      mlsNumber: form.mlsNumber || null,
      brokerageId: brokerageDefaults?.brokerageId || null,
      brokerageLegalName: form.brokerageLegalName,
      brokerageAddress: form.brokerageAddress || null,
      brokerOfRecordName: form.brokerOfRecordName || null,
      brokerOfRecordEmail: form.brokerOfRecordEmail || null,
      expectedCommission: form.expectedCommission ? parseFloat(form.expectedCommission) : null,
      expectedClosingDate: form.expectedClosingDate || null,
      expectedPaymentDate: form.expectedPaymentDate || null,
      directedAmount: directed,
      notes: form.notes || null,
    })
    setSaving(false)
    if (result.success) {
      onOpenChange(false)
      onCreated?.()
    } else {
      setError(result.error || 'Failed to create remediation deal')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-300">
            <FileSignature className="w-5 h-5 text-amber-400" />
            Add Remediation Deal
          </DialogTitle>
          <DialogDescription>
            Record an upcoming commission the agent will assign to clear the failed-deal balance.
            Brokerage details default from the agent&apos;s file. Override if the agent has transferred.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Property Address *</label>
              <input
                type="text"
                value={form.propertyAddress}
                onChange={(e) => setForm(f => ({ ...f, propertyAddress: e.target.value }))}
                placeholder="e.g. 123 Main St, Toronto, ON, M4V 1L7"
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">MLS Number</label>
              <input
                type="text"
                value={form.mlsNumber}
                onChange={(e) => setForm(f => ({ ...f, mlsNumber: e.target.value }))}
                placeholder="Optional"
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Expected Commission (CAD)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.expectedCommission}
                onChange={(e) => setForm(f => ({ ...f, expectedCommission: e.target.value }))}
                placeholder="Net to agent"
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Expected Closing Date</label>
              <input
                type="date"
                value={form.expectedClosingDate}
                onChange={(e) => {
                  const v = e.target.value
                  setForm(f => ({ ...f, expectedClosingDate: v, expectedPaymentDate: f.expectedPaymentDate || addDaysIso(v, SETTLEMENT_PERIOD_DAYS) }))
                }}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Expected Payment Date</label>
              <input
                type="date"
                value={form.expectedPaymentDate}
                onChange={(e) => setForm(f => ({ ...f, expectedPaymentDate: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-muted-foreground/60 mt-1">Defaults to closing + {SETTLEMENT_PERIOD_DAYS} days</p>
            </div>

            <div className="sm:col-span-2 pt-2 border-t border-border/30">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">Brokerage handling this commission</p>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Brokerage Legal Name *</label>
              <input
                type="text"
                value={form.brokerageLegalName}
                onChange={(e) => setForm(f => ({ ...f, brokerageLegalName: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Brokerage Address</label>
              <input
                type="text"
                value={form.brokerageAddress}
                onChange={(e) => setForm(f => ({ ...f, brokerageAddress: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Broker of Record</label>
              <input
                type="text"
                value={form.brokerOfRecordName}
                onChange={(e) => setForm(f => ({ ...f, brokerOfRecordName: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Broker of Record Email</label>
              <input
                type="email"
                value={form.brokerOfRecordEmail}
                onChange={(e) => setForm(f => ({ ...f, brokerOfRecordEmail: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
              />
            </div>

            <div className="sm:col-span-2 pt-2 border-t border-border/30">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">Direction</p>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Directed Amount (CAD) *</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.directedAmount}
                onChange={(e) => setForm(f => ({ ...f, directedAmount: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary tabular-nums"
              />
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                Defaults to current live balance owing on the failed deal ({formatCurrency(liveBalanceOwed)}).
                Override if a different amount has been agreed for this assignment.
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                rows={2}
                placeholder="Any context, e.g. partial assignment, dispute, etc."
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary resize-none"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground bg-muted hover:bg-muted/70 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-amber-600 hover:bg-amber-600/90 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {saving ? 'Saving…' : 'Add Remediation Deal'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
