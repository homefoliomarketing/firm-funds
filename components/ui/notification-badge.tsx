import { cn } from '@/lib/utils'

/**
 * Small count pill for unread / attention indicators on nav items, bells, and
 * tabs (e.g. "3" unread messages, "5" trade records to upload).
 *
 * Consolidates the hand-rolled `bg-red-500`/`bg-red-600`/`bg-amber-500` count
 * spans that were duplicated across AgentHeader, the brokerage dashboard, and
 * the message inboxes. Uses theme tokens so it tracks the rest of the status
 * system instead of drifting on raw palette hex.
 *
 * Tones:
 *  - `attention` (default): destructive red — unread / action-needed counts.
 *  - `pending`: amber — softer "queued / waiting" counts (e.g. IDs to review).
 *
 * Counts above 99 render as "99+". Marked aria-hidden by default: the count is
 * decorative reinforcement and the parent control should already announce the
 * same information in its accessible name (e.g. aria-label="Messages, 3 unread").
 */
export function NotificationBadge({
  count,
  tone = 'attention',
  className,
  'aria-hidden': ariaHidden = true,
}: {
  count: number
  tone?: 'attention' | 'pending'
  className?: string
  'aria-hidden'?: boolean
}) {
  return (
    <span
      aria-hidden={ariaHidden}
      className={cn(
        'inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold tabular-nums',
        tone === 'pending'
          ? 'bg-status-amber text-status-amber-muted'
          : 'bg-destructive text-destructive-foreground',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
