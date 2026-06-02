'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ImpersonationBannerProps {
  targetName: string | null
  targetEmail: string | null
  targetRole: string
  /** Hard expiry as an ISO timestamp. The bar counts down to this. */
  expiresAt: string
}

const roleLabel: Record<string, string> = {
  agent: 'Agent',
  brokerage_admin: 'Brokerage user',
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Persistent "You are viewing as <name>" bar shown on every dashboard page
 * while an Owner is impersonating (look-only). Counts down to the hard time
 * limit and auto-exits at zero. Exit ends the view-as session server-side and
 * hard-reloads to /admin so the browser drops the view-as identity entirely.
 */
export default function ImpersonationBanner({
  targetName,
  targetEmail,
  targetRole,
  expiresAt,
}: ImpersonationBannerProps) {
  const expiryMs = Date.parse(expiresAt)
  // Initialised on mount to avoid an SSR/CSR hydration mismatch on the clock.
  const [remaining, setRemaining] = useState<number | null>(null)
  const [exiting, setExiting] = useState(false)
  const exitedRef = useRef(false)

  const exit = useCallback(async () => {
    if (exitedRef.current) return
    exitedRef.current = true
    setExiting(true)
    try {
      await fetch('/api/impersonation/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    } catch {
      // Even if the call fails, hard-redirect: the cookie may already be gone
      // and /admin will re-resolve the real identity.
    }
    // Hard navigation so the browser re-reads cookies and drops the view-as
    // identity from the client Supabase wrapper.
    window.location.href = '/admin'
  }, [])

  useEffect(() => {
    const tick = () => {
      const left = expiryMs - Date.now()
      setRemaining(left)
      if (left <= 0) void exit()
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiryMs, exit])

  const name = targetName || targetEmail || 'this user'
  const label = roleLabel[targetRole] || 'user'

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-[100] w-full bg-card border-b-2 border-status-amber-border shadow-md"
    >
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="flex items-center justify-center w-7 h-7 rounded-full bg-status-amber-muted border border-status-amber-border shrink-0"
            aria-hidden="true"
          >
            <Eye size={15} className="text-status-amber" />
          </span>
          <p className="text-sm text-foreground truncate">
            <span className="font-bold text-status-amber">Viewing as</span>{' '}
            <span className="font-semibold">{name}</span>
            {targetEmail && targetName ? (
              <span className="text-muted-foreground"> ({targetEmail})</span>
            ) : null}
            <span className="text-muted-foreground"> &middot; {label} &middot; look-only</span>
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
            {remaining === null ? '' : `Ends in ${formatRemaining(remaining)}`}
          </span>
          <Button
            onClick={() => void exit()}
            disabled={exiting}
            size="sm"
            className="bg-status-amber text-background hover:bg-status-amber/90 font-bold gap-1.5"
          >
            <LogOut size={14} aria-hidden="true" />
            {exiting ? 'Exiting…' : 'Exit view-as'}
          </Button>
        </div>
      </div>
    </div>
  )
}
