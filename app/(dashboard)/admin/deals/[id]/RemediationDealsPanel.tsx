'use client'

import { useCallback, useEffect, useState } from 'react'
import { FileSignature, Plus, RefreshCw, AlertTriangle, CheckCircle2, XCircle, DollarSign, Send } from 'lucide-react'
import { formatCurrency } from '@/lib/formatting'
import {
  cancelRemediationDeal,
  markRemediationDealRemitted,
  getRemediationDealsForFailedDeal,
} from '@/lib/actions/remediation-actions'
import { sendRemediationIdpForSignature } from '@/lib/actions/esign-actions'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import AddRemediationDealModal from '@/components/remediation/AddRemediationDealModal'

interface RemediationDealRow {
  id: string
  failed_deal_id: string
  agent_id: string
  property_address: string
  mls_number: string | null
  brokerage_id: string | null
  brokerage_legal_name: string
  brokerage_address: string | null
  broker_of_record_name: string | null
  broker_of_record_email: string | null
  expected_commission: number | null
  expected_closing_date: string | null
  expected_payment_date: string | null
  directed_amount: number
  status: 'pending' | 'idp_sent' | 'idp_signed' | 'remitted' | 'cancelled'
  notes: string | null
  remitted_at: string | null
  remitted_amount: number | null
  created_at: string
  updated_at: string
  esignature_envelopes?: { envelope_id: string; status: string; agent_signed_at: string | null }[]
}

interface AgentBrokerageDefaults {
  brokerageId: string | null
  brokerageName: string
  brokerageAddress: string
  brokerOfRecordName: string
  brokerOfRecordEmail: string
}

interface Props {
  failedDealId: string
  liveBalanceOwed: number
  brokerageDefaults: AgentBrokerageDefaults | null
  onCured?: () => void
  onChange?: () => void
}

const STATUS_LABEL: Record<RemediationDealRow['status'], string> = {
  pending: 'Draft — IDP not yet sent',
  idp_sent: 'IDP sent — awaiting signature',
  idp_signed: 'IDP signed — awaiting remittance',
  remitted: 'Remitted',
  cancelled: 'Cancelled',
}

const STATUS_STYLE: Record<RemediationDealRow['status'], string> = {
  pending: 'bg-muted text-muted-foreground border-border/40',
  idp_sent: 'bg-amber-950/40 text-amber-300 border-amber-800/50',
  idp_signed: 'bg-blue-950/40 text-blue-300 border-blue-800/50',
  remitted: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50',
  cancelled: 'bg-muted text-muted-foreground/60 border-border/30',
}

/** Render a YYYY-MM-DD date string without timezone drift. */
function formatDateLocal(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function RemediationDealsPanel({
  failedDealId,
  liveBalanceOwed,
  brokerageDefaults,
  onCured,
  onChange,
}: Props) {
  const [deals, setDeals] = useState<RemediationDealRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [topLevelMessage, setTopLevelMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Add-modal state (form lives inside the shared component now)
  const [showAddModal, setShowAddModal] = useState(false)

  // Per-row action state
  const [sendingIdpFor, setSendingIdpFor] = useState<string | null>(null)
  const [activeMarkRemittedId, setActiveMarkRemittedId] = useState<string | null>(null)
  const [activeCancelId, setActiveCancelId] = useState<string | null>(null)
  const [remitForm, setRemitForm] = useState({ amount: '', date: '', notes: '' })
  const [remitSaving, setRemitSaving] = useState(false)
  const [remitError, setRemitError] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelSaving, setCancelSaving] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const result = await getRemediationDealsForFailedDeal(failedDealId)
    if (result.success) {
      setDeals((result.data || []) as RemediationDealRow[])
    } else {
      setTopLevelMessage({ type: 'error', text: result.error || 'Failed to load remediation deals' })
    }
    setLoading(false)
    setRefreshing(false)
  }, [failedDealId])

  // Effect kicks off the initial load; React Compiler flags the indirect
  // setState calls inside load(), but this is the standard fetch-on-mount
  // pattern — load() only re-runs when failedDealId changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  const openAddModal = () => {
    setShowAddModal(true)
  }

  const handleAddCreated = async () => {
    setTopLevelMessage({ type: 'success', text: 'Remediation deal added. Send the IDP when ready.' })
    await load()
    onChange?.()
  }

  const handleSendIdp = async (id: string) => {
    setTopLevelMessage(null)
    setSendingIdpFor(id)
    const result = await sendRemediationIdpForSignature({ remediationDealId: id })
    setSendingIdpFor(null)
    if (result.success) {
      setTopLevelMessage({ type: 'success', text: `Remediation IDP sent (${formatCurrency(result.data?.directedAmount || 0)}). Agent + brokerage will receive DocuSign emails.` })
      await load()
      onChange?.()
    } else {
      setTopLevelMessage({ type: 'error', text: result.error || 'Failed to send Remediation IDP' })
    }
  }

  const openMarkRemitted = (row: RemediationDealRow) => {
    setRemitError(null)
    setRemitForm({
      amount: Number(row.directed_amount).toFixed(2),
      date: new Date().toISOString().slice(0, 10),
      notes: '',
    })
    setActiveMarkRemittedId(row.id)
  }

  const handleMarkRemitted = async () => {
    if (!activeMarkRemittedId) return
    setRemitError(null)
    const amt = parseFloat(remitForm.amount)
    if (!Number.isFinite(amt) || amt <= 0) { setRemitError('Remitted amount must be greater than zero'); return }
    if (!remitForm.date) { setRemitError('Remitted date is required'); return }
    setRemitSaving(true)
    const result = await markRemediationDealRemitted({
      id: activeMarkRemittedId,
      remittedAmount: amt,
      remittedAt: remitForm.date,
      notes: remitForm.notes || undefined,
    })
    setRemitSaving(false)
    if (result.success) {
      const data = result.data as
        | { fullyCleared?: boolean; newPrincipal?: number; creditApplied?: number }
        | undefined
      const cured = data?.fullyCleared
      setActiveMarkRemittedId(null)
      setTopLevelMessage({
        type: 'success',
        text: cured
          ? `Remittance recorded. Failed deal balance fully cleared — status changed to Cured.`
          : `Remittance recorded. ${formatCurrency(data?.creditApplied || 0)} applied to balance. ${formatCurrency(data?.newPrincipal || 0)} principal still owing plus any remaining interest.`,
      })
      await load()
      if (cured) onCured?.()
      onChange?.()
    } else {
      setRemitError(result.error || 'Failed to record remittance')
    }
  }

  const handleCancel = async () => {
    if (!activeCancelId) return
    setCancelError(null)
    if (!cancelReason.trim()) { setCancelError('Cancellation reason is required'); return }
    setCancelSaving(true)
    const result = await cancelRemediationDeal(activeCancelId, cancelReason)
    setCancelSaving(false)
    if (result.success) {
      setActiveCancelId(null)
      setCancelReason('')
      setTopLevelMessage({ type: 'success', text: 'Remediation deal cancelled.' })
      await load()
      onChange?.()
    } else {
      setCancelError(result.error || 'Failed to cancel')
    }
  }

  const activeRemittedRow = activeMarkRemittedId ? deals.find(d => d.id === activeMarkRemittedId) : null
  const activeCancelRow = activeCancelId ? deals.find(d => d.id === activeCancelId) : null

  return (
    <section className="mb-6 rounded-xl border border-border/40 bg-card overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/40 bg-muted/30">
        <div className="flex items-center gap-2.5 min-w-0">
          <FileSignature className="w-5 h-5 text-amber-400 flex-shrink-0" />
          <h2 className="text-base font-bold text-foreground">
            Remediation Deals <span className="text-muted-foreground/60 font-normal ml-1">({deals.length})</span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setRefreshing(true); load() }}
            disabled={loading || refreshing}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={openAddModal}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-600/90 transition"
          >
            <Plus className="w-4 h-4" />
            Add Remediation Deal
          </button>
        </div>
      </header>

      {topLevelMessage && (
        <div className={`px-5 py-3 border-b border-border/40 ${topLevelMessage.type === 'success' ? 'bg-emerald-950/20 text-emerald-300' : 'bg-destructive/10 text-destructive'}`} role="status">
          <p className="text-xs font-medium">{topLevelMessage.text}</p>
        </div>
      )}

      <div className="p-5">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : deals.length === 0 ? (
          <div className="rounded-lg bg-muted/30 border border-border/30 p-5 text-center">
            <p className="text-sm text-muted-foreground">
              No remediation deals yet. Add one when the agent has a firm deal to assign.
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              The directed amount defaults to the current live balance owing ({formatCurrency(liveBalanceOwed)}).
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {deals.map(row => (
              <li key={row.id} className="rounded-lg border border-border/40 bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground truncate">{row.property_address}</p>
                      <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider border ${STATUS_STYLE[row.status]}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {row.brokerage_legal_name}
                      {row.broker_of_record_name && ` · BoR ${row.broker_of_record_name}`}
                      {row.expected_closing_date && ` · Closing ${formatDateLocal(row.expected_closing_date)}`}
                      {row.expected_payment_date && ` · Expected payment ${formatDateLocal(row.expected_payment_date)}`}
                    </p>
                    {row.status === 'remitted' && row.remitted_amount != null && row.remitted_at && (
                      <p className="text-[11px] text-emerald-300/80 mt-1">
                        Remitted {formatCurrency(Number(row.remitted_amount))} on {formatDateLocal(row.remitted_at.slice(0, 10))}
                      </p>
                    )}
                    {row.notes && (
                      <p className="text-[11px] text-muted-foreground/70 mt-1 italic line-clamp-2">{row.notes}</p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Directed</p>
                    <p className="text-sm font-bold tabular-nums text-amber-300">{formatCurrency(Number(row.directed_amount))}</p>
                    {row.expected_commission != null && (
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                        of ~{formatCurrency(Number(row.expected_commission))} commission
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {row.status === 'pending' && (
                    <button
                      type="button"
                      onClick={() => handleSendIdp(row.id)}
                      disabled={sendingIdpFor === row.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-amber-600 text-white hover:bg-amber-600/90 disabled:opacity-50 transition"
                    >
                      {sendingIdpFor === row.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      {sendingIdpFor === row.id ? 'Sending…' : 'Send Remediation IDP'}
                    </button>
                  )}
                  {(row.status === 'idp_sent' || row.status === 'idp_signed') && (
                    <button
                      type="button"
                      onClick={() => openMarkRemitted(row)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-700 text-white hover:bg-emerald-700/90 transition"
                    >
                      <DollarSign className="w-3.5 h-3.5" />
                      Mark Remitted
                    </button>
                  )}
                  {row.status !== 'remitted' && row.status !== 'cancelled' && (
                    <button
                      type="button"
                      onClick={() => { setCancelReason(''); setCancelError(null); setActiveCancelId(row.id) }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Cancel
                    </button>
                  )}
                  {row.esignature_envelopes && row.esignature_envelopes.length > 0 && (
                    <span className="text-[10px] text-muted-foreground/60">
                      Envelope: {row.esignature_envelopes[0].envelope_id.slice(0, 8)}…
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ============================================================ */}
      {/* Add Remediation Deal modal — shared component used by admin,    */}
      {/* brokerage admin, and agent failed-deals views.                  */}
      {/* ============================================================ */}
      <AddRemediationDealModal
        open={showAddModal}
        onOpenChange={setShowAddModal}
        failedDealId={failedDealId}
        liveBalanceOwed={liveBalanceOwed}
        brokerageDefaults={brokerageDefaults}
        onCreated={handleAddCreated}
      />

      {/* ============================================================ */}
      {/* Mark Remitted modal */}
      {/* ============================================================ */}
      <Dialog
        open={!!activeMarkRemittedId && !!activeRemittedRow}
        onOpenChange={(v) => !remitSaving && !v && setActiveMarkRemittedId(null)}
      >
        <DialogContent className="max-w-md">
          {activeRemittedRow && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  Mark Remitted
                </DialogTitle>
                <DialogDescription>
                  Record the payment received from <strong className="text-foreground">{activeRemittedRow.brokerage_legal_name}</strong> for {activeRemittedRow.property_address}.
                  The amount will be applied against the failed-deal balance (accrued interest first, then principal).
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Amount Remitted (CAD) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={remitForm.amount}
                    onChange={(e) => setRemitForm(f => ({ ...f, amount: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary tabular-nums"
                  />
                  <p className="text-[10px] text-muted-foreground/60 mt-1">
                    Directed amount on IDP: {formatCurrency(Number(activeRemittedRow.directed_amount))}
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Date Received *</label>
                  <input
                    type="date"
                    value={remitForm.date}
                    onChange={(e) => setRemitForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Notes</label>
                  <textarea
                    value={remitForm.notes}
                    onChange={(e) => setRemitForm(f => ({ ...f, notes: e.target.value }))}
                    rows={2}
                    placeholder="EFT reference, etc."
                    className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary resize-none"
                  />
                </div>
                {remitError && (
                  <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
                    <p className="text-xs text-destructive">{remitError}</p>
                  </div>
                )}
              </div>
              <DialogFooter>
                <button
                  onClick={() => setActiveMarkRemittedId(null)}
                  disabled={remitSaving}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground bg-muted hover:bg-muted/70 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleMarkRemitted}
                  disabled={remitSaving}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-700/90 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {remitSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  {remitSaving ? 'Recording…' : 'Record Remittance'}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ============================================================ */}
      {/* Cancel modal */}
      {/* ============================================================ */}
      <Dialog
        open={!!activeCancelId && !!activeCancelRow}
        onOpenChange={(v) => !cancelSaving && !v && setActiveCancelId(null)}
      >
        <DialogContent className="max-w-md">
          {activeCancelRow && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="w-5 h-5 text-destructive" />
                  Cancel Remediation Deal
                </DialogTitle>
                <DialogDescription>
                  Cancel the remediation deal for <strong className="text-foreground">{activeCancelRow.property_address}</strong>.
                  This does <strong>not</strong> clear the failed-deal balance — the agent still owes it. Use Cancel when this specific commission won&apos;t be the one used to remediate (e.g. deal fell through, agent reassigned).
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Reason *</label>
                  <textarea
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    rows={3}
                    placeholder="e.g. Buyer terminated on conditional; agent will reassign to a different upcoming commission."
                    className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:border-primary resize-none"
                  />
                </div>
                {cancelError && (
                  <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
                    <p className="text-xs text-destructive">{cancelError}</p>
                  </div>
                )}
              </div>
              <DialogFooter>
                <button
                  onClick={() => setActiveCancelId(null)}
                  disabled={cancelSaving}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground bg-muted hover:bg-muted/70 disabled:opacity-50 transition-colors"
                >
                  Keep
                </button>
                <button
                  onClick={handleCancel}
                  disabled={cancelSaving || !cancelReason.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-destructive hover:bg-destructive/90 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {cancelSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  {cancelSaving ? 'Cancelling…' : 'Confirm Cancel'}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
