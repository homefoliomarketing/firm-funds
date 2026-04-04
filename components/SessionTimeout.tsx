'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { ADMIN_INACTIVITY_TIMEOUT_MS, AGENT_INACTIVITY_TIMEOUT_MS, ADMIN_ROLES } from '@/lib/constants'
import { useTheme } from '@/lib/theme'
import { Clock, ShieldAlert } from 'lucide-react'

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
  const { colors } = useTheme()
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
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: colors.overlayBg,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: colors.cardBg,
          border: `1px solid ${colors.warningBorder}`,
          borderRadius: '16px',
          padding: '2rem',
          maxWidth: '420px',
          width: '100%',
          textAlign: 'center',
          boxShadow: `0 25px 50px -12px ${colors.shadowColor}`,
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: colors.warningBg,
            border: `1px solid ${colors.warningBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1.25rem',
          }}
        >
          <ShieldAlert size={28} style={{ color: colors.warningText }} />
        </div>

        {/* Title */}
        <h2
          style={{
            color: colors.textPrimary,
            fontSize: '1.125rem',
            fontWeight: 700,
            marginBottom: '0.5rem',
          }}
        >
          Session Expiring
        </h2>

        {/* Description */}
        <p
          style={{
            color: colors.textSecondary,
            fontSize: '0.875rem',
            lineHeight: '1.5',
            marginBottom: '1.25rem',
          }}
        >
          Your session will expire due to inactivity. Click below to stay logged in.
        </p>

        {/* Countdown */}
        <div
          style={{
            background: colors.warningBg,
            border: `1px solid ${colors.warningBorder}`,
            borderRadius: '12px',
            padding: '0.75rem 1rem',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
        >
          <Clock size={18} style={{ color: colors.warningText }} />
          <span
            style={{
              color: colors.warningText,
              fontWeight: 700,
              fontSize: '1.25rem',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatTime(countdown)}
          </span>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={() => handleLogout('manual')}
            disabled={loggingOut}
            style={{
              flex: 1,
              padding: '0.75rem 1rem',
              borderRadius: '10px',
              border: `1px solid ${colors.border}`,
              background: 'transparent',
              color: colors.textSecondary,
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: loggingOut ? 'not-allowed' : 'pointer',
              opacity: loggingOut ? 0.5 : 1,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { if (!loggingOut) e.currentTarget.style.background = colors.cardHoverBg }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            Log Out
          </button>
          <button
            onClick={handleStayLoggedIn}
            disabled={loggingOut}
            style={{
              flex: 2,
              padding: '0.75rem 1rem',
              borderRadius: '10px',
              border: 'none',
              background: colors.gold,
              color: '#FFFFFF',
              fontSize: '0.875rem',
              fontWeight: 700,
              cursor: loggingOut ? 'not-allowed' : 'pointer',
              opacity: loggingOut ? 0.5 : 1,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { if (!loggingOut) e.currentTarget.style.background = colors.goldDark }}
            onMouseLeave={(e) => { e.currentTarget.style.background = colors.gold }}
          >
            Stay Logged In
          </button>
        </div>
      </div>
    </div>
  )
}
