'use client'

import { useEffect, useRef } from 'react'
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react'

export type StatusToastType = 'success' | 'error' | 'info'

export interface StatusToastMessage {
  type: StatusToastType
  text: string
}

// Variants map onto the shared status-color tokens (app/globals.css) so toast
// feedback matches the badges, alert strips, and ledger entries elsewhere in
// the app instead of drifting on raw Tailwind palette hex. Backgrounds are kept
// near-opaque (/95) for legibility over scrolled page content.
const VARIANTS: Record<StatusToastType, { box: string; text: string; icon: typeof CheckCircle; role: 'status' | 'alert'; live: 'polite' | 'assertive' }> = {
  success: { box: 'bg-status-teal-muted/95 border-status-teal-border', text: 'text-status-teal', icon: CheckCircle, role: 'status', live: 'polite' },
  error:   { box: 'bg-status-red-muted/95 border-status-red-border',   text: 'text-status-red',  icon: AlertCircle, role: 'alert',  live: 'assertive' },
  info:    { box: 'bg-status-blue-muted/95 border-status-blue-border', text: 'text-status-blue', icon: Info,        role: 'status', live: 'polite' },
}

/**
 * Floating status toast, fixed to the bottom-right of the viewport so feedback
 * shows up wherever the user is scrolled instead of being pinned to the top of
 * the page far from the control they just used. Auto-dismisses (success after
 * 5s, errors/info after 10s) and is manually closable.
 *
 * Usage:
 *   <StatusToast message={statusMessage} onDismiss={() => setStatusMessage(null)} />
 *
 * `message` should be `{ type, text } | null`. Pass `null` to render nothing.
 */
export function StatusToast({
  message,
  onDismiss,
}: {
  message: StatusToastMessage | null
  onDismiss: () => void
}) {
  // Keep the latest onDismiss in a ref so the auto-dismiss timer only resets
  // when the message itself changes, not on every parent re-render (an inline
  // `() => setX(null)` would otherwise change identity each render and keep
  // restarting the timer, so it would never fire). The ref is updated in an
  // effect (not during render) to satisfy react-hooks/refs.
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!message) return
    const ms = message.type === 'success' ? 5000 : 10000
    const t = setTimeout(() => dismissRef.current(), ms)
    return () => clearTimeout(t)
  }, [message])

  if (!message) return null

  const variant = VARIANTS[message.type] ?? VARIANTS.info
  const Icon = variant.icon

  return (
    <div
      role={variant.role}
      aria-live={variant.live}
      className={`fixed bottom-6 right-6 z-[60] max-w-sm w-[calc(100vw-3rem)] sm:w-auto p-4 rounded-lg flex items-start gap-3 border shadow-2xl backdrop-blur-sm animate-in fade-in slide-in-from-bottom-4 ${variant.box}`}
    >
      <Icon size={18} className={`${variant.text} flex-shrink-0 mt-0.5`} />
      <p className={`flex-1 text-sm ${variant.text}`}>{message.text}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className={`flex-shrink-0 -mr-1 -mt-1 p-1 rounded-md transition-colors hover:bg-white/10 ${variant.text}`}
      >
        <X size={16} />
      </button>
    </div>
  )
}
