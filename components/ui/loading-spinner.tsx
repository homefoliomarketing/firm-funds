import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Small inline spinner for "submitting" / "loading" states inside buttons,
 * row actions, and inline confirmation flows.
 *
 * Use this anywhere you'd otherwise reach for `<Loader2 className="animate-spin" />`
 * — it keeps sizing and aria semantics consistent across the admin app.
 */
export function LoadingSpinner({
  size = 14,
  className,
  label = 'Loading',
}: {
  size?: number
  className?: string
  /**
   * Screen-reader-only label. Pass an empty string to suppress when the
   * surrounding text (e.g. "Submitting...") already announces state.
   */
  label?: string
}) {
  return (
    <>
      <Loader2
        aria-hidden="true"
        focusable="false"
        size={size}
        className={cn('animate-spin', className)}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  )
}
