'use client'

import { useState } from 'react'
import { AlertTriangle, RefreshCw, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { formatDate } from '@/lib/formatting'

// Server actions may not exist yet — see Task spec. Bind lazily and surface a
// graceful "not deployed" message if the module can't be resolved.
async function callMarkFundingFailed(payload: {
  dealId: string
  failureReason: string
  notes?: string
}): Promise<any> {
  try {
    // Prefer the dedicated module described in the brief.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@/lib/actions/deal-actions' as any)
    if (typeof mod.markFundingFailed === 'function') {
      return mod.markFundingFailed(payload)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminMod: any = await import('@/lib/actions/admin-actions' as any)
    if (typeof adminMod.markFundingFailed === 'function') {
      return adminMod.markFundingFailed(payload)
    }
    return {
      success: false,
      error: 'markFundingFailed server action not yet deployed.',
    }
  } catch {
    return {
      success: false,
      error: 'markFundingFailed server action not yet deployed.',
    }
  }
}

async function callRetryFundingAfterFailure(payload: {
  dealId: string
}): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@/lib/actions/deal-actions' as any)
    if (typeof mod.retryFundingAfterFailure === 'function') {
      return mod.retryFundingAfterFailure(payload)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminMod: any = await import('@/lib/actions/admin-actions' as any)
    if (typeof adminMod.retryFundingAfterFailure === 'function') {
      return adminMod.retryFundingAfterFailure(payload)
    }
    return {
      success: false,
      error: 'retryFundingAfterFailure server action not yet deployed.',
    }
  } catch {
    return {
      success: false,
      error: 'retryFundingAfterFailure server action not yet deployed.',
    }
  }
}

async function callUpdateDealStatus(payload: {
  dealId: string
  newStatus: string
}): Promise<any> {
  // updateDealStatus is a known-existing action in lib/actions/deal-actions.ts
  // (used elsewhere on this page). Bind it without indirection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('@/lib/actions/deal-actions' as any)
  return mod.updateDealStatus(payload)
}

// ============================================================================
// Constants
// ============================================================================

const FAILURE_REASON_OPTIONS = [
  { value: 'wrong_bank_account', label: 'Wrong bank account' },
  { value: 'account_closed', label: 'Account closed' },
  { value: 'wire_returned', label: 'Wire returned by bank' },
  { value: 'other', label: 'Other' },
] as const

// ============================================================================
// Mark funding-failed button + modal — visible only on `funded` deals
// ============================================================================

export function MarkFundingFailedButton({
  dealId,
  disabled,
  onChanged,
}: {
  dealId: string
  disabled?: boolean
  onChanged: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<(typeof FAILURE_REASON_OPTIONS)[number]['value']>('wrong_bank_account')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await callMarkFundingFailed({
        dealId,
        failureReason: reason,
        notes: notes.trim() || undefined,
      })
      if (!result?.success) {
        setError(result?.error || 'Could not mark funding as failed.')
        return
      }
      toast.success('Deal marked as funding failed', {
        description: 'The deal is now flagged. Retry funding or cancel below.',
      })
      setOpen(false)
      setNotes('')
      setReason('wrong_bank_account')
      await onChanged()
    } catch (err: any) {
      setError(err?.message || 'Unexpected error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="gap-1.5 bg-red-950/30 text-red-400 border-red-800/50 hover:bg-red-950/50"
      >
        <AlertTriangle size={14} aria-hidden="true" />
        Mark Funding Failed
      </Button>

      <Dialog
        open={open}
        onOpenChange={o => {
          if (!submitting) setOpen(o)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle size={16} aria-hidden="true" />
              Mark funding as failed
            </DialogTitle>
            <DialogDescription>
              Use this when the EFT or wire didn&apos;t land in the agent&apos;s account.
              The deal will move to <strong>Funding Failed</strong> status so you can
              retry the transfer or cancel the deal entirely.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="failure-reason" className="text-xs">
                Reason
              </Label>
              <Select value={reason} onValueChange={v => setReason(v as typeof reason)}>
                <SelectTrigger id="failure-reason" className="w-full mt-1.5">
                  <SelectValue placeholder="Pick a reason" />
                </SelectTrigger>
                <SelectContent>
                  {FAILURE_REASON_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="failure-notes" className="text-xs">
                Notes (optional)
              </Label>
              <Textarea
                id="failure-notes"
                rows={3}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. RBC returned with NSF code R01, banking team retrying tomorrow."
                className="mt-1.5"
              />
            </div>
            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting}
              className="gap-1.5 bg-red-700 hover:bg-red-800 text-white"
            >
              {submitting ? (
                <>
                  <LoadingSpinner label="" />
                  Marking...
                </>
              ) : (
                <>
                  <AlertTriangle size={14} aria-hidden="true" />
                  Confirm — funding failed
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ============================================================================
// Big banner + retry/cancel buttons — shown when status === 'funding_failed'
// ============================================================================

export function FundingFailedBanner({
  dealId,
  failureReason,
  failureNotes,
  failedAt,
  onChanged,
}: {
  dealId: string
  failureReason?: string | null
  failureNotes?: string | null
  failedAt?: string | null
  onChanged: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState<null | 'retry' | 'cancel'>(null)

  const friendlyReason =
    FAILURE_REASON_OPTIONS.find(o => o.value === failureReason)?.label ??
    failureReason ??
    'Reason not recorded'

  const handleRetry = async () => {
    if (busy) return
    setBusy('retry')
    try {
      const result = await callRetryFundingAfterFailure({ dealId })
      if (!result?.success) {
        toast.error(result?.error || 'Could not retry funding')
        return
      }
      toast.success('Funding ready to retry', {
        description: 'Deal moved back to approved. Re-trigger the EFT when banking confirms the new account.',
      })
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  const handleCancel = async () => {
    if (busy) return
    if (
      !confirm(
        'Cancel this deal entirely? The agent will be notified and the funding will not be retried. Their ledger will need a separate adjustment if a partial transfer already cleared.',
      )
    ) {
      return
    }
    setBusy('cancel')
    try {
      const result = await callUpdateDealStatus({
        dealId,
        newStatus: 'cancelled',
      })
      if (!result?.success) {
        toast.error(result?.error || 'Could not cancel deal')
        return
      }
      toast.success('Deal cancelled')
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      role="alert"
      aria-labelledby="funding-failed-title"
      className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-3"
    >
      <div className="rounded-xl border-2 border-red-600 bg-red-950/30 px-4 py-3 shadow-[0_0_15px_rgba(220,38,38,0.3)]">
        <div className="flex items-start gap-3 flex-wrap">
          <AlertTriangle
            className="w-5 h-5 mt-0.5 text-red-500 shrink-0"
            aria-hidden="true"
          />
          <div className="flex-1 min-w-[240px]">
            <h2
              id="funding-failed-title"
              className="text-sm font-bold uppercase tracking-wider text-red-500"
            >
              Funding failed
            </h2>
            <p className="text-sm text-red-100 mt-0.5">
              <span className="font-semibold">{friendlyReason}</span>
              {failedAt ? (
                <span className="text-red-200/80">
                  {' '}
                  — recorded {formatDate(failedAt)}
                </span>
              ) : null}
            </p>
            {failureNotes ? (
              <p className="text-xs text-red-200/90 mt-1.5 whitespace-pre-wrap">
                <span className="font-semibold">Notes:</span> {failureNotes}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={handleRetry}
              disabled={busy !== null}
              className="gap-1.5"
            >
              {busy === 'retry' ? (
                <>
                  <LoadingSpinner label="" />
                  Retrying...
                </>
              ) : (
                <>
                  <RefreshCw size={14} aria-hidden="true" />
                  Retry funding
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCancel}
              disabled={busy !== null}
              className="gap-1.5 border-red-500 text-red-300 hover:bg-red-950/50"
            >
              {busy === 'cancel' ? (
                <>
                  <LoadingSpinner label="" />
                  Cancelling...
                </>
              ) : (
                <>
                  <XCircle size={14} aria-hidden="true" />
                  Cancel deal
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
