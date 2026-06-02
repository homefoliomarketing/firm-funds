'use client'

import { useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ViewAsAgentButtonProps {
  agentId: string
  agentName: string
}

/**
 * Owner-only "View as this agent" control (look-only impersonation). Renders a
 * small confirm step, then POSTs to /api/impersonation/start and hard-redirects
 * to the agent's dashboard so the new view-as identity takes effect. Only shown
 * when the caller holds the `impersonate` capability; the endpoint re-checks.
 */
export default function ViewAsAgentButton({ agentId, agentName }: ViewAsAgentButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const res = await fetch('/api/impersonation/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) {
        setError(data?.error || 'Could not start view-as.')
        setStarting(false)
        setConfirming(false)
        return
      }
      // Hard navigation so the browser picks up the view-as hint cookie and the
      // client renders the agent's world.
      window.location.href = data.redirectTo || '/agent'
    } catch {
      setError('Could not start view-as.')
      setStarting(false)
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        <p className="text-[11px] text-muted-foreground">
          View the app as {agentName} (look-only)? You will not be able to make changes, and it is logged.
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
        View as this agent
      </Button>
      {error && <p className="text-[11px] text-destructive mt-1">{error}</p>}
    </div>
  )
}
