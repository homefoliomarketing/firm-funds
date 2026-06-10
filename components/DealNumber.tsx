import { cn } from '@/lib/utils'

interface DealNumberProps {
  /** The deal's deal_number (e.g. "0001-0609-26"). NULL for unsubmitted offers. */
  value: string | null | undefined
  /** Visual size. "sm" for dense lists, "md" for headers. */
  size?: 'sm' | 'md'
  /** When true, render a muted "Not yet submitted" chip instead of nothing for a null value. */
  showPending?: boolean
  /** Optional leading label, e.g. "Deal". Rendered before the number, outside the chip. */
  label?: string
  className?: string
}

/**
 * Consistent display for a deal's human-readable tracking number
 * (format NNNN-MMDD-YY, assigned at submission — see migration 108).
 *
 * Server-safe (no client hooks) so it renders in both server and client
 * components. Returns null when there is no number (unsubmitted firm-deal
 * offers) unless `showPending` is set.
 */
export function DealNumber({ value, size = 'sm', showPending = false, label, className }: DealNumberProps) {
  if (!value) {
    if (!showPending) return null
    return (
      <span
        className={cn(
          'inline-flex items-center rounded border border-border/60 bg-muted/40 font-mono text-muted-foreground/70',
          size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs',
          className,
        )}
        title="A deal number is assigned when the advance is submitted"
      >
        Not yet submitted
      </span>
    )
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {label && (
        <span className={cn('text-muted-foreground', size === 'sm' ? 'text-[11px]' : 'text-xs')}>{label}</span>
      )}
      <span
        className={cn(
          'inline-flex items-center rounded border border-border bg-muted/60 font-mono font-medium tracking-tight text-foreground tabular-nums',
          size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs',
        )}
        title="Deal number"
      >
        {value}
      </span>
    </span>
  )
}
