import * as React from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Shared "nothing here" placeholder for admin tables, lists, and panels.
 *
 * Renders a tasteful empty illustration with a title, optional description,
 * and an optional CTA slot. Uses design tokens (`text-muted-foreground`,
 * `bg-muted/30`) so it stays on-brand in dark mode and never hardcodes hex.
 */
export interface EmptyStateProps {
  /** Lucide icon component (e.g. `FileText`, `Inbox`). Falls back to a neutral disc. */
  icon?: LucideIcon
  /** Short title. Required — this is what the user reads first. */
  title: string
  /** Optional second-line description / hint. Keep it under ~120 chars. Accepts JSX so callers can embed links. */
  description?: React.ReactNode
  /** Optional CTA / action slot rendered below the description. */
  action?: React.ReactNode
  /** Compact: tighter padding, smaller icon. Use inside cards / panels. */
  compact?: boolean
  /** Extra classnames for the outer wrapper. */
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-8 px-4' : 'py-16 px-6',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'rounded-2xl bg-muted/30 flex items-center justify-center mb-4',
          compact ? 'w-10 h-10' : 'w-14 h-14',
        )}
      >
        {Icon ? (
          <Icon
            className="text-muted-foreground/40"
            size={compact ? 18 : 24}
          />
        ) : (
          <span className="block w-3 h-3 rounded-full bg-muted-foreground/40" />
        )}
      </div>
      <p
        className={cn(
          'font-semibold text-muted-foreground',
          compact ? 'text-xs' : 'text-sm',
        )}
      >
        {title}
      </p>
      {description ? (
        <p
          className={cn(
            'text-muted-foreground/60 max-w-xs',
            compact ? 'text-[11px] mt-1' : 'text-xs mt-1.5',
          )}
        >
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}
