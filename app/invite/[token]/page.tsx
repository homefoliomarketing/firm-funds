'use client'

import { useState, useEffect, use } from 'react'
import { useTheme } from '@/lib/theme'

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const { colors, isDark } = useTheme()

  const [status, setStatus] = useState<'loading' | 'valid' | 'invalid' | 'setting' | 'success'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [agentName, setAgentName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Validate the token on page load
  useEffect(() => {
    async function validateToken() {
      try {
        const res = await fetch('/api/magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const data = await res.json()
        if (data.success) {
          setAgentName(data.data.agentName || '')
          setEmail(data.data.email || '')
          setStatus('valid')
        } else {
          setError(data.error || 'Invalid invite link.')
          setStatus('invalid')
        }
      } catch {
        setError('Unable to validate invite link. Please try again.')
        setStatus('invalid')
      }
    }
    validateToken()
  }, [token])

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Client-side password validation
    const hasUpper = /[A-Z]/.test(password)
    const hasLower = /[a-z]/.test(password)
    const hasNumber = /\d/.test(password)
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)

    if (password.length < 12 || !hasUpper || !hasLower || !hasNumber || !hasSpecial) {
      setError('Password must be at least 12 characters with uppercase, lowercase, number, and special character.')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setStatus('setting')

    try {
      const res = await fetch('/api/magic-link', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json()

      if (data.success) {
        setStatus('success')
      } else {
        setError(data.error || 'Failed to set password.')
        setStatus('valid')
      }
    } catch {
      setError('Something went wrong. Please try again.')
      setStatus('valid')
    }
  }

  // ---- Loading ----
  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: isDark ? 'linear-gradient(145deg, #121212 0%, #181818 40%, #1E1E1E 100%)' : 'linear-gradient(145deg, #1E1E1E 0%, #2D2D2D 40%, #3D3D3D 100%)' }}>
        <div className="text-center">
          <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 w-auto mx-auto mb-5" />
          <p className="text-sm" style={{ color: colors.textMuted }}>Validating your invite...</p>
        </div>
      </div>
    )
  }

  // ---- Invalid / Expired ----
  if (status === 'invalid') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: isDark ? 'linear-gradient(145deg, #121212 0%, #181818 40%, #1E1E1E 100%)' : 'linear-gradient(145deg, #1E1E1E 0%, #2D2D2D 40%, #3D3D3D 100%)' }}>
        <div className="relative max-w-md w-full mx-4">
          <div className="text-center mb-8">
            <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 w-auto mx-auto mb-5" />
          </div>
          <div className="rounded-2xl shadow-2xl p-5 sm:p-8" style={{ background: colors.cardBg, boxShadow: `0 25px 60px ${colors.shadowColor}` }}>
            <div className="text-center">
              <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ background: colors.errorBg }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={colors.errorText} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              </div>
              <h2 className="text-lg font-bold mb-2" style={{ color: colors.textPrimary }}>
                Invite Link Unavailable
              </h2>
              <p className="text-sm mb-6" style={{ color: colors.textSecondary }}>
                {error}
              </p>
              <a
                href="/login"
                className="inline-block px-6 py-3 rounded-lg text-sm font-bold uppercase tracking-wider text-white transition-all"
                style={{ background: 'linear-gradient(135deg, #5FA873, #4A8F5D)' }}
              >
                Go to Login
              </a>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---- Success ----
  if (status === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: isDark ? 'linear-gradient(145deg, #121212 0%, #181818 40%, #1E1E1E 100%)' : 'linear-gradient(145deg, #1E1E1E 0%, #2D2D2D 40%, #3D3D3D 100%)' }}>
        <div className="relative max-w-md w-full mx-4">
          <div className="text-center mb-8">
            <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 w-auto mx-auto mb-5" />
          </div>
          <div className="rounded-2xl shadow-2xl p-5 sm:p-8" style={{ background: colors.cardBg, boxShadow: `0 25px 60px ${colors.shadowColor}` }}>
            <div className="text-center">
              <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ background: colors.successBg }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={colors.successText} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2 className="text-lg font-bold mb-2" style={{ color: colors.textPrimary }}>
                You&apos;re All Set!
              </h2>
              <p className="text-sm mb-6" style={{ color: colors.textSecondary }}>
                Your password has been set successfully. You can now log in to the Firm Funds portal.
              </p>
              <a
                href="/login"
                className="inline-block px-6 py-3 rounded-lg text-sm font-bold uppercase tracking-wider text-white transition-all"
                style={{ background: 'linear-gradient(135deg, #5FA873, #4A8F5D)', boxShadow: '0 4px 12px rgba(95, 168, 115, 0.3)' }}
              >
                Log In Now
              </a>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---- Set Password Form ----
  const isSubmitting = status === 'setting'

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: isDark ? 'linear-gradient(145deg, #121212 0%, #181818 40%, #1E1E1E 100%)' : 'linear-gradient(145deg, #1E1E1E 0%, #2D2D2D 40%, #3D3D3D 100%)' }}>
      <div className="absolute top-0 right-0 w-96 h-96 opacity-5 rounded-full" style={{ background: 'radial-gradient(circle, #5FA873, transparent)', filter: 'blur(80px)' }} />
      <div className="absolute bottom-0 left-0 w-80 h-80 opacity-5 rounded-full" style={{ background: 'radial-gradient(circle, #5FA873, transparent)', filter: 'blur(60px)' }} />

      <div className="relative max-w-md w-full mx-4">
        <div className="text-center mb-8">
          <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 md:h-48 w-auto mx-auto mb-5" />
          <p className="text-sm font-medium tracking-wide" style={{ color: '#5FA873' }}>
            Commission Advance Portal
          </p>
        </div>

        <div className="rounded-2xl shadow-2xl p-5 sm:p-8" style={{ background: colors.cardBg, boxShadow: `0 25px 60px ${colors.shadowColor}` }}>
          <div className="mb-6">
            <h2 className="text-lg font-bold mb-1" style={{ color: colors.textPrimary }}>
              Welcome{agentName ? `, ${agentName.split(' ')[0]}` : ''}!
            </h2>
            <p className="text-sm" style={{ color: colors.textSecondary }}>
              Create your password to get started with Firm Funds.
            </p>
            {email && (
              <p className="text-xs mt-2 px-3 py-1.5 rounded-lg inline-block" style={{ background: colors.inputBg, color: colors.textMuted }}>
                {email}
              </p>
            )}
          </div>

          <form onSubmit={handleSetPassword} className="space-y-5">
            {error && (
              <div className="px-4 py-3 rounded-lg text-sm" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }}>
                {error}
              </div>
            )}

            <div>
              <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textPrimary }}>
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null) }}
                className="block w-full px-4 py-3 rounded-lg text-sm transition-all duration-200 outline-none"
                style={{ border: `1.5px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                onFocus={(e) => { e.target.style.borderColor = '#5FA873'; e.target.style.boxShadow = isDark ? '0 0 0 3px rgba(95, 168, 115, 0.25)' : '0 0 0 3px rgba(95, 168, 115, 0.15)' }}
                onBlur={(e) => { e.target.style.borderColor = colors.inputBorder; e.target.style.boxShadow = 'none' }}
                placeholder="Min. 12 chars, upper/lower/number/special"
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textPrimary }}>
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(null) }}
                className="block w-full px-4 py-3 rounded-lg text-sm transition-all duration-200 outline-none"
                style={{ border: `1.5px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                onFocus={(e) => { e.target.style.borderColor = '#5FA873'; e.target.style.boxShadow = isDark ? '0 0 0 3px rgba(95, 168, 115, 0.25)' : '0 0 0 3px rgba(95, 168, 115, 0.15)' }}
                onBlur={(e) => { e.target.style.borderColor = colors.inputBorder; e.target.style.boxShadow = 'none' }}
                placeholder="Re-enter your password"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3.5 px-4 rounded-lg text-sm font-bold uppercase tracking-wider text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'linear-gradient(135deg, #5FA873, #4A8F5D)', boxShadow: '0 4px 12px rgba(95, 168, 115, 0.3)' }}
              onMouseEnter={(e) => { if (!isSubmitting) e.currentTarget.style.background = 'linear-gradient(135deg, #6FBA83, #5FA873)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, #5FA873, #4A8F5D)' }}
            >
              {isSubmitting ? 'Setting Password...' : 'Set Password & Continue'}
            </button>
          </form>

          <div className="mt-6 pt-5" style={{ borderTop: `1px solid ${colors.border}` }}>
            <p className="text-center text-xs" style={{ color: colors.textMuted }}>
              Already have an account? <a href="/login" style={{ color: '#5FA873' }}>Log in here</a>
            </p>
          </div>
        </div>

        <p className="text-center text-xs mt-6" style={{ color: 'rgba(255,255,255,0.3)' }}>
          &copy; {new Date().getFullYear()} Firm Funds Inc. All rights reserved.
        </p>
      </div>
    </div>
  )
}
