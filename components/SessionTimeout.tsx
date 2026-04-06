'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { ADMIN_INACTIVITY_TIMEOUT_MS, AGENT_INACTIVITY_TIMEOUT_MS, ADMIN_ROLES } from '@/lib/constants'
import { Clock, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface SessionTimeoutProps {
  userRole: string
  userId?: string
}

/** Warning period: show modal 2 minutes before timeout */
const WARNING_BEFORE_TIMEOUT_MS = 2 * 60 * 1000

/** Throttle activity resets to once per 30 seconds */
const ACTIVITY_THROTTLE_MS = 30_000

/** Throttle server-side last_active_at updates to once per 60 seconds */
const SERVER_PING_THROTTLE_MS = 60_000

/**
 * Session Timeout Component (Security Audit Item M2)
 *
 * - Tracks user activity (mouse, keyboard, scroll, click, touch)
 * - Shows a themed warning modal 2 minutes before timeout
 * - Auto-logs out if user doesn't respond
 * - Periodically updates server-side last_active_at for defense-in-depth
 * - Logs session timeout events to audit trail
 */
export default function SessionTimeout({ userRole, userId }: SessionTimeoutProps) {
  const router = useRouter()
  const [showWarning, setShowWarning] = useState(false)
  const [countdown, setCountdown] = useState(120) // seconds remaining
  const [loggingOut, setLoggingOut] = useState(false)

  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const warningTimerRef = useRef<NodeJS.Timeout | null>(null)
  const countdownRef = useRef<NodeJS.Timeout | null>(null)
  const lastResetRef = useRef(Date.now())
  const lastServerPingRef = useRef(0)
  const isWarningVisibleRef = useRef(false)

  const isAdmin = ADMIN_ROLES.includes(userRole as any)
  const timeoutMs = isAdmin ? ADMIN_INACTIVITY_TIMEOUT_MS : AGENT_INACTIVITY_TIMEOUT_MS
  const warningMs = timeoutMs - WARNING_BEFORE_TIMEOUT_MS

  // Update server-side last_active_at (throttled to once per minute)
  const pingServer = useCallback(async () => {
    const now = Date.now()
    if (now - lastServerPingRef.current < SERVER_PING_THROTTLE_MS) return
    lastServerPingRef.current = now

    try {
      await fetch('/api/session-heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: new Date().toISOString() }),
      })
    } catch {
      // Non-blocking — don't break the app if heartbeat fails
    }
  }, [])

  // Perform logout
  const handleLogout = useCallback(async (reason: 'timeout' | 'manual' = 'timeout') => {
    if (loggingOut) return
    setLoggingOut(true)

    try {
      // Log the timeout event to audit trail via API (fire-and-forget)
      fetch('/api/session-heartbeat', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }).catch(() => {})

      const supabase = createClient()
      await supabase.auth.signOut()
    } catch {
      // Even if sign out fails, redirect to login
    }

    // Hard redirect to prevent stale state
    window.location.href = '/login?reason=timeout'
  }, [loggingOut])

  // Clear all timers
  const clearAllTimers = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    if (warningTimerRef.current) { clearTimeout(warningTimerRef.current); warningTimerRef.current = null }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
  }, [])

  // Start countdown when warning shows
  const startCountdown = useCallback(() => {
    const warningSeconds = Math.floor(WARNING_BEFORE_TIMEOUT_MS / 1000)
    setCountdown(warningSeconds)
    setShowWarning(true)
    isWarningVisibleRef.current = true

    if (countdownRef.current) clearInterval(countdownRef.current)
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [])

  // Reset all timers (called on user activity)
  const resetTimer = useCallback(() => {
    clearAllTimers()
    setShowWarning(false)
    isWarningVisibleRef.current = false

    // Set warning timer (fires 2 min before timeout)
    warningTimerRef.current = setTimeout(() => {
      startCountdown()
    }, warningMs)

    // Set auto-logout timer
    timerRef.current = setTimeout(() => {
      handleLogout('timeout')
    }, timeoutMs)
  }, [clearAllTimers, warningMs, timeoutMs, startCountdown, handleLogout])

  // "Stay Logged In" button handler
  const handleStayLoggedIn = useCallback(() => {
    lastResetRef.current = Date.now()
    resetTimer()
    pingServer()
  }, [resetTimer, pingServer])

  // Set up activity listeners
  useEffect(() => {
    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click']

    const throttledReset = () => {
      // Don't reset if warning modal is showing — user must click "Stay Logged In"
      if (isWarningVisibleRef.current) return

      const now = Date.now()
      if (now - lastResetRef.current > ACTIVITY_THROTTLE_MS) {
        lastResetRef.current = now
        resetTimer()
        pingServer()
      }
    }

    events.forEach(event => document.addEventListener(event, throttledReset, { passive: true }))

    // Start initial timer
    resetTimer()
    // Initial server ping
    pingServer()

    return () => {
      events.forEach(event => document.removeEventListener(event, throttledReset))
      clearAllTimers()
    }
  }, [resetTimer, pingServer, clearAllTimers])

  // Format seconds as MM:SS
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // Warning modal
  if (!showWarning) return null

  return (
    <div className="fixed inset-0 bg-black/60 z-[99999] flex items-center justify-center p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-timeout-title"
        className="bg-card border border-yellow-600/40 rounded-2xl p-8 max-w-[420px] w-full text-center shadow-2xl"
      >
        {/* Icon */}
        <div className="w-14 h-14 rounded-full bg-yellow-500/10 border border-yellow-600/30 flex items-center justify-center mx-auto mb-5" aria-hidden="true">
          <ShieldAlert size={28} className="text-yellow-500" />
        </div>

        {/* Title */}
        <h2 id="session-timeout-title" className="text-foreground text-lg font-bold mb-2">
          Session Expiring
        </h2>

        {/* Description */}
        <p className="text-muted-foreground text-sm leading-relaxed mb-5">
          Your session will expire due to inactivity. Click below to stay logged in.
        </p>

        {/* Countdown */}
        <div className="bg-yellow-500/10 border border-yellow-600/30 rounded-xl px-4 py-3 mb-6 flex items-center justify-center gap-2" role="status" aria-live="polite">
          <Clock size={18} className="text-yellow-500" aria-hidden="true" />
          <span className="text-yellow-500 font-bold text-xl tabular-nums" aria-label={`${formatTime(countdown)} remaining`}>
            {formatTime(countdown)}
          </span>
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={() => handleLogout('manual')}
            disabled={loggingOut}
            className="flex-1"
          >
            Log Out
          </Button>
          <Button
            onClick={handleStayLoggedIn}
            disabled={loggingOut}
            className="flex-[2] bg-primary hover:bg-primary/90 text-primary-foreground font-bold"
          >
            Stay Logged In
          </Button>
        </div>
      </div>
    </div>
  )
}
