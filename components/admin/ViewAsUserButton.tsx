'use client'

import { useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Exactly one of agentId / targetUserId is required. agentId resolves to that
// agent's login server-side; targetUserId is a user_profiles.id (used for
// brokerage users, who have no agents row).
type ViewAsUserButtonProps = {
  /** Display name shown in the confirm prompt. */
  name: string
  /** Trigger label. Defaults to "View as this user" (block) / "View as" (compact). */
  label?: string
  /**
   * Compact row variant: a small trigger button plus a modal confirm, so it can
   * sit inside a tight list row without expanding the row. The default (block)
   * variant keeps the inline confirm used on the deal page.
   */
  compact?: boolean
} & (
  | { agentId: string; targetUserId?: undefined }
  | { targetUserId: string; agentId?: undefined }
)

/**
 * Owner-only "View as user" control (look-only impersonation). Renders a confirm
 * step, then POSTs to /api/impersonation/start and hard-redirects to the target's
 * dashboard so the new view-as identity takes effect. Only shown when the caller
 * holds the `impersonate` capability; the endpoint re-checks server-side.
 *
 * Used for both agents (deal page) and brokerage users (brokerage admins panel).
 */
export default function ViewAsUserButton({
  name,
  label,
  compact,
  agentId,
  targetUserId,
}: ViewAsUserButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const body = agentId ? { agentId } : { targetUserId }
      const res = await fetch('/api/impersonation/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) {
        setError(data?.error || 'Could not start view-as.')
        setStarting(false)
        setConfirming(false)
        return
      }
      // Hard navigation so the browser picks up the view-as hint cookie and the
      // client renders the target's world.
      window.location.href = data.redirectTo || '/agent'
    } catch {
      setError('Could not start view-as.')
      setStarting(false)
      setConfirming(false)
    }
  }

  // Compact variant: small trigger + modal confirm (for list rows).
  if (compact) {
    return (
      <>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setConfirming(true)}
          className="h-7 gap-1.5 text-xs border-status-amber-border text-status-amber hover:bg-status-amber-muted"
        >
          <Eye size={13} aria-hidden="true" />
          {label ?? 'View as'}
        </Button>
        <Dialog
          open={confirming}
          onOpenChange={o => {
            if (!starting) setConfirming(o)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Eye size={16} aria-hidden="true" />
                View as {name}?
              </DialogTitle>
              <DialogDescription>
                You&apos;ll see the app exactly as {name} does, but look-only: you
                cannot make any changes on their behalf. The session is
                time-limited and logged.
              </DialogDescription>
            </DialogHeader>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            ) : null}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirming(false)}
                disabled={starting}
              >
                Cancel
              </Button>
              <Button
                onClick={start}
                disabled={starting}
                className="gap-1.5 bg-status-amber text-background hover:bg-status-amber/90 font-semibold"
              >
                {starting ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Eye size={14} aria-hidden="true" />
                )}
                {starting ? 'Starting…' : 'Start view-as'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  // Block variant: inline confirm below the button (deal page).
  if (confirming) {
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        <p className="text-[11px] text-muted-foreground">
          View the app as {name} (look-only)? You will not be able to make changes, and it is logged.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={start}
            disabled={starting}
            className="h-7 gap-1.5 bg-status-amber text-background hover:bg-status-amber/90 font-semibold"
          >
            {starting ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
            {starting ? 'Starting…' : 'Start view-as'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(false)}
            disabled={starting}
            className="h-7"
          >
            Cancel
          </Button>
        </div>
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="mt-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => setConfirming(true)}
        className="h-7 gap-1.5 text-xs border-status-amber-border text-status-amber hover:bg-status-amber-muted"
      >
        <Eye size={13} aria-hidden="true" />
        {label ?? 'View as this user'}
      </Button>
      {error && <p className="text-[11px] text-destructive mt-1">{error}</p>}
    </div>
  )
}
