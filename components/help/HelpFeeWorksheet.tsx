'use client'

import { useId, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  calculateDeal,
  formatCurrency,
  getChargeDays,
  type DealResult,
} from '@/lib/calculations'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  SETTLEMENT_PERIOD_DAYS,
} from '@/lib/constants'
import HelpCallout from './HelpCallout'

interface HelpFeeWorksheetProps {
  defaultGross?: number
  defaultSplitPct?: number
  defaultDaysUntilClosing?: number
}

interface WorksheetState {
  result: DealResult | null
  chargeDays: number
  error: string | null
}

/**
 * Live fee worksheet. The user can edit gross, split, and days-until-closing;
 * every change re-runs `calculateDeal()` and shows the same numbers the agent
 * sees on the new-deal form. If `calculateDeal()` throws (out-of-band inputs),
 * we surface the error message in place instead of crashing the article.
 */
export default function HelpFeeWorksheet({
  defaultGross = 10000,
  defaultSplitPct = 30,
  defaultDaysUntilClosing = 30,
}: HelpFeeWorksheetProps) {
  const grossId = useId()
  const splitId = useId()
  const daysId = useId()

  const [gross, setGross] = useState<string>(String(defaultGross))
  const [splitPct, setSplitPct] = useState<string>(String(defaultSplitPct))
  const [daysUntilClosing, setDaysUntilClosing] = useState<string>(
    String(defaultDaysUntilClosing),
  )

  const { result, chargeDays, error } = useMemo<WorksheetState>(() => {
    const g = Number(gross)
    const s = Number(splitPct)
    const d = Number(daysUntilClosing)
    if (!Number.isFinite(g) || !Number.isFinite(s) || !Number.isFinite(d)) {
      return { result: null, chargeDays: 0, error: 'Enter valid numbers in all three fields.' }
    }
    try {
      const r = calculateDeal({
        grossCommission: g,
        brokerageSplitPct: s,
        daysUntilClosing: d,
      })
      return { result: r, chargeDays: getChargeDays(d), error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not calculate.'
      return { result: null, chargeDays: 0, error: message }
    }
  }, [gross, splitPct, daysUntilClosing])

  return (
    <HelpCallout
      variant="money"
      title="Worked example you can edit"
    >
      <p className="text-sm text-foreground/90">
        Change any number to see the fees update. Uses the same math your deal
        will use: ${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per
        day, plus a {SETTLEMENT_PERIOD_DAYS}-day settlement window at the same
        rate.
      </p>

      <form
        className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={grossId} className="text-xs text-foreground/80">
            Gross commission ($)
          </Label>
          <Input
            id={grossId}
            type="number"
            inputMode="decimal"
            min={1}
            step={100}
            value={gross}
            onChange={(e) => setGross(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={splitId} className="text-xs text-foreground/80">
            Brokerage split (%)
          </Label>
          <Input
            id={splitId}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={1}
            value={splitPct}
            onChange={(e) => setSplitPct(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={daysId} className="text-xs text-foreground/80">
            Days until closing
          </Label>
          <Input
            id={daysId}
            type="number"
            inputMode="numeric"
            min={2}
            max={120}
            step={1}
            value={daysUntilClosing}
            onChange={(e) => setDaysUntilClosing(e.target.value)}
          />
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="mt-2 text-xs text-status-red bg-status-red-muted border border-status-red-border rounded-md px-3 py-2"
        >
          {error}
        </p>
      )}

      {result && (
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div className="flex justify-between border-b border-border/50 py-1">
            <dt className="text-muted-foreground">Net commission</dt>
            <dd className="font-mono text-foreground">
              {formatCurrency(result.netCommission)}
            </dd>
          </div>
          <div className="flex justify-between border-b border-border/50 py-1">
            <dt className="text-muted-foreground">Charge days</dt>
            <dd className="font-mono text-foreground">{chargeDays}</dd>
          </div>
          <div className="flex justify-between border-b border-border/50 py-1">
            <dt className="text-muted-foreground">Discount fee</dt>
            <dd className="font-mono text-foreground">
              {formatCurrency(result.discountFee)}
            </dd>
          </div>
          <div className="flex justify-between border-b border-border/50 py-1">
            <dt className="text-muted-foreground">
              Settlement period fee ({SETTLEMENT_PERIOD_DAYS} days)
            </dt>
            <dd className="font-mono text-foreground">
              {formatCurrency(result.settlementPeriodFee)}
            </dd>
          </div>
          <div className="flex justify-between border-b border-border/50 py-1 sm:col-span-2">
            <dt className="text-muted-foreground">Total fees</dt>
            <dd className="font-mono text-foreground">
              {formatCurrency(result.totalFees)}
            </dd>
          </div>
          <div className="flex justify-between py-1.5 sm:col-span-2">
            <dt className="font-semibold text-foreground">Advance amount</dt>
            <dd className="font-mono font-semibold text-primary">
              {formatCurrency(result.advanceAmount)}
            </dd>
          </div>
        </dl>
      )}
    </HelpCallout>
  )
}
