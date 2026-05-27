'use client'

import { useMemo, useState } from 'react'
import { CalendarClock, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { formatCurrency, formatDate } from '@/lib/formatting'

// Lazy-bind to the server action. If it isn't there yet (the backend agent is
// still scaffolding `lib/actions/admin-actions.ts`), surface a clean error.
async function callRecordEarlyClosing(payload: {
  dealId: string
  actualClosingDate: string
}): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@/lib/actions/admin-actions' as any)
    if (typeof mod.recordEarlyClosing === 'function') {
      return mod.recordEarlyClosing(payload)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dealMod: any = await import('@/lib/actions/deal-actions' as any)
    if (typeof dealMod.recordEarlyClosing === 'function') {
      return dealMod.recordEarlyClosing(payload)
    }
    return {
      success: false,
      error: 'recordEarlyClosing server action not yet deployed.',
    }
  } catch {
    return {
      success: false,
      error: 'recordEarlyClosing server action not yet deployed.',
    }
  }
}

// Mirror the project-wide discount-rate constant. Imported through the lib
// path would be ideal, but keeping it inline here makes this component
// drop-in-able without forcing the constants module into a client bundle.
const DISCOUNT_RATE_PER_1000_PER_DAY = 0.8

function todayIso(): string {
  // Toronto-local date so date pickers default to the operator's day, not UTC.
  const now = new Date()
  const tz = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const y = tz.find(p => p.type === 'year')?.value
  const m = tz.find(p => p.type === 'month')?.value
  const d = tz.find(p => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}

function tomorrowIso(): string {
  const base = todayIso()
  const d = new Date(`${base}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

// ============================================================================
// Component
// ============================================================================

export function EarlyClosingButton({
  dealId,
  scheduledClosingDate,
  netCommission,
  disabled,
  onChanged,
}: {
  dealId: string
  scheduledClosingDate: string
  netCommission?: number | null
  disabled?: boolean
  onChanged: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [actualDate, setActualDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const maxDate = tomorrowIso()
  const todayStr = todayIso()

  // Quick refund preview — uses the same daily rate the backend uses, so the
  // admin sees a ballpark figure before submitting. The server is the source
  // of truth and will return the canonical number in its response.
  const refundPreview = useMemo(() => {
    if (!actualDate || !netCommission) return null
    const actualMs = new Date(`${actualDate}T00:00:00`).getTime()
    const scheduledMs = new Date(`${scheduledClosingDate}T00:00:00`).getTime()
    const daysSaved = Math.max(0, Math.round((scheduledMs - actualMs) / 86400000))
    if (daysSaved <= 0) return null
    const dailyRate = DISCOUNT_RATE_PER_1000_PER_DAY / 1000
    const refund = Math.round(netCommission * dailyRate * daysSaved * 100) / 100
    return { daysSaved, refund }
  }, [actualDate, netCommission, scheduledClosingDate])

  const validate = (): string | null => {
    if (!actualDate) return 'Pick the actual closing date.'
    if (actualDate >= scheduledClosingDate) {
      return 'Actual closing date must be before the scheduled date. If the deal closed on time, no early-closing entry is needed.'
    }
    if (actualDate > maxDate) {
      return 'Actual closing date cannot be in the future.'
    }
    return null
  }

  const submit = async () => {
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await callRecordEarlyClosing({
        dealId,
        actualClosingDate: actualDate,
      })
      if (!result?.success) {
        setError(result?.error || 'Could not record early closing.')
        return
      }
      const serverRefund =
        (result.data as any)?.refundAmount ?? refundPreview?.refund ?? null
      toast.success('Early closing recorded', {
        description:
          serverRefund != null
            ? `Discount refund of ${formatCurrency(serverRefund)} credited to the agent.`
            : 'Discount refund applied.',
      })
      setOpen(false)
      setActualDate('')
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
        onClick={() => {
          setActualDate('')
          setError(null)
          setOpen(true)
        }}
        className="gap-1.5 border-border/50 hover:border-primary/40 hover:text-primary"
      >
        <CalendarClock size={14} aria-hidden="true" />
        Record Early Closing
      </Button>

      <Dialog
        open={open}
        onOpenChange={o => {
          if (!submitting) setOpen(o)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock size={16} aria-hidden="true" />
              Record early closing
            </DialogTitle>
            <DialogDescription>
              When a deal closes sooner than the scheduled date, the agent is
              owed a refund on the discount fee for the days saved. Enter the
              actual closing date below — we&apos;ll calculate the refund and
              credit their ledger.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-border/40 bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Scheduled closing</span>
                <span className="font-semibold text-foreground">
                  {formatDate(scheduledClosingDate)}
                </span>
              </div>
              {netCommission ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Net commission</span>
                  <span className="font-semibold text-foreground tabular-nums">
                    {formatCurrency(netCommission)}
                  </span>
                </div>
              ) : null}
            </div>

            <div>
              <Label htmlFor="actual-closing-date" className="text-xs">
                Actual closing date
              </Label>
              <Input
                id="actual-closing-date"
                type="date"
                value={actualDate}
                max={maxDate}
                onChange={e => {
                  setError(null)
                  setActualDate(e.target.value)
                }}
                className="mt-1.5 [color-scheme:dark]"
                aria-describedby="actual-closing-date-hint"
                required
                aria-required="true"
              />
              <p
                id="actual-closing-date-hint"
                className="text-[11px] text-muted-foreground mt-1"
              >
                Must be before the scheduled date ({formatDate(scheduledClosingDate)}) and
                no later than tomorrow ({formatDate(maxDate)}).
                Today is {formatDate(todayStr)}.
              </p>
            </div>

            {refundPreview ? (
              <div
                aria-live="polite"
                className="rounded-lg border border-status-green/40 bg-status-green/10 p-3 text-sm"
              >
                <p className="text-status-green font-semibold flex items-center gap-1.5">
                  <CheckCircle2 size={14} aria-hidden="true" />
                  Refund preview
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Closing {refundPreview.daysSaved} day
                  {refundPreview.daysSaved === 1 ? '' : 's'} early — agent will
                  be credited approximately{' '}
                  <span className="font-semibold text-status-green tabular-nums">
                    {formatCurrency(refundPreview.refund)}
                  </span>
                  . The server will calculate the exact amount.
                </p>
              </div>
            ) : null}

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
              disabled={submitting || !actualDate}
              className="gap-1.5"
            >
              {submitting ? (
                <>
                  <LoadingSpinner label="" />
                  Recording...
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} aria-hidden="true" />
                  Record early closing
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
