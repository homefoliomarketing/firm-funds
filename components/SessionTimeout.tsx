'use client'

import { useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { ADMIN_INACTIVITY_TIMEOUT_MS, AGENT_INACTIVITY_TIMEOUT_MS, ADMIN_ROLES } from '@/lib/constants'

interface SessionTimeoutProps {
  userRole: string
}

/**
 * Monitors user activity and logs out after inactivity timeout.
 * Admin users: 15 minutes. Agent users: 30 minutes.
 */
export default function SessionTimeout({ userRole }: SessionTimeoutProps) {
  const router = useRouter()
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const warningRef = useRef<NodeJS.Timeout | null>(null)

  const isAdmin = ADMIN_ROLES.includes(userRole as any)
  const timeoutMs = isAdmin ? ADMIN_INACTIVITY_TIMEOUT_MS : AGENT_INACTIVITY_TIMEOUT_MS
  const warningMs = timeoutMs - 60_000 // Show warning 1 minute before timeout

  const handleLogout = useCallback(async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login?reason=timeout')
  }, [router])

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (warningRef.current) clearTimeout(warningRef.current)

    // Dismiss any existing warning
    const existingWarning = document.getElementById('session-timeout-warning')
    if (existingWarning) existingWarning.remove()

    // Set warning timer
    warningRef.current = setTimeout(() => {
      // Show a simple warning banner
      const warning = document.createElement('div')
      warning.id = 'session-timeout-warning'
      warning.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#f59e0b;color:#000;text-align:center;padding:12px;font-size:14px;font-weight:600;'
      warning.textContent = 'Your session will expire in 1 minute due to inactivity. Move your mouse or press a key to stay logged in.'
      document.body.appendChild(warning)
    }, warningMs)

    // Set logout timer
    timerRef.current = setTimeout(handleLogout, timeoutMs)
  }, [timeoutMs, warningMs, handleLogout])

  useEffect(() => {
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click']

    // Throttle: only reset timer once per 30 seconds of activity
    let lastReset = Date.now()
    const throttledReset = () => {
      const now = Date.now()
      if (now - lastReset > 30_000) {
        lastReset = now
        resetTimer()
      }
    }

    events.forEach(event => document.addEventListener(event, throttledReset, { passive: true }))
    resetTimer() // Start initial timer

    return () => {
      events.forEach(event => document.removeEventListener(event, throttledReset))
      if (timerRef.current) clearTimeout(timerRef.current)
      if (warningRef.current) clearTimeout(warningRef.current)
      const existingWarning = document.getElementById('session-timeout-warning')
      if (existingWarning) existingWarning.remove()
    }
  }, [resetTimer])

  return null // This is a behavior-only component, no visual output
}
