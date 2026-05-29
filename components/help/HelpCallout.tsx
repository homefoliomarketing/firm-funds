import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, DollarSign, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

type HelpCalloutVariant = 'note' | 'warning' | 'success' | 'money'

interface HelpCalloutProps {
  variant: HelpCalloutVariant
  title?: string
  children: ReactNode
  className?: string
}

const VARIANTS: Record<
  HelpCalloutVariant,
  {
    classes: string
    Icon: typeof Info
    iconLabel: string
    role: 'note' | 'alert'
  }
> = {
  note: {
    classes: 'bg-status-blue-muted text-status-blue border-status-blue-border',
    Icon: Info,
    iconLabel: 'Note',
    role: 'note',
  },
  warning: {
    classes: 'bg-status-amber-muted text-status-amber border-status-amber-border',
    Icon: AlertTriangle,
    iconLabel: 'Warning',
    role: 'alert',
  },
  success: {
    classes: 'bg-status-green-muted text-status-green border-status-green-border',
    Icon: CheckCircle2,
    iconLabel: 'Success',
    role: 'note',
  },
  money: {
    classes: 'bg-primary/10 text-foreground border-primary/30',
    Icon: DollarSign,
    iconLabel: 'Money',
    role: 'note',
  },
}

/**
 * Inline callout block. Four variants tied to the status color tokens defined
 * in `app/globals.css`. Pure presentational, safe in server and client trees.
 *
 * Use:
 *   <HelpCallout variant="warning" title="Heads up">Body...</HelpCallout>
 */
export default function HelpCallout({
  variant,
  title,
  children,
  className,
}: HelpCalloutProps) {
  const { classes, Icon, iconLabel, role } = VARIANTS[variant]
  return (
    <aside
      role={role}
      className={cn(
        'flex gap-3 rounded-lg border px-4 py-3 text-sm',
        classes,
        className
      )}
    >
      <Icon size={18} className="shrink-0 mt-0.5" aria-label={iconLabel} />
      <div className="min-w-0 flex-1">
        {title && (
          <p className="font-semibold mb-1 leading-snug">{title}</p>
        )}
        <div className="text-foreground/90 [&_p]:text-foreground/90 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mt-1 space-y-2">
          {children}
        </div>
      </div>
    </aside>
  )
}
