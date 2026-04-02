'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useTheme } from '@/lib/theme'
import ThemeToggle from '@/components/ThemeToggle'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [resetting, setResetting] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResetSent(false)

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (profile) {
        switch (profile.role) {
          case 'agent':
            router.push('/agent')
            break
          case 'brokerage_admin':
            router.push('/brokerage')
            break
          case 'firm_funds_admin':
          case 'super_admin':
            router.push('/admin')
            break
          default:
            router.push('/agent')
        }
      }
    }
  }

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError('Please enter your email address first, then click Forgot Password.')
      return
    }
    setResetting(true)
    setError(null)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    })
    if (error) {
      setError(error.message)
    } else {
      setResetSent(true)
    }
    setResetting(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: isDark ? 'linear-gradient(145deg, #121212 0%, #181818 40%, #1E1E1E 100%)' : 'linear-gradient(145deg, #1E1E1E 0%, #2D2D2D 40%, #3D3D3D 100%)' }}>
      {/* Subtle decorative elements */}
      <div className="absolute top-0 right-0 w-96 h-96 opacity-5 rounded-full" style={{ background: 'radial-gradient(circle, #C4B098, transparent)', filter: 'blur(80px)' }} />
      <div className="absolute bottom-0 left-0 w-80 h-80 opacity-5 rounded-full" style={{ background: 'radial-gradient(circle, #C4B098, transparent)', filter: 'blur(60px)' }} />

      <div className="absolute top-4 right-4"><ThemeToggle /></div>

      <div className="relative max-w-md w-full mx-4">
        {/* Logo / Brand Area */}
        <div className="text-center mb-8">
          <img src="/brand/logo-white.png" alt="Firm Funds" className="h-24 w-auto mx-auto mb-3" />
          <p className="text-sm font-medium tracking-wide" style={{ color: '#C4B098', fontFamily: 'var(--font-geist-sans), sans-serif' }}>
            Commission Advance Portal
          </p>
        </div>

        {/* Login Card */}
        <div className="rounded-2xl shadow-2xl p-8" style={{ background: colors.cardBg, boxShadow: `0 25px 60px ${colors.shadowColor}` }}>
          <form onSubmit={handleLogin} className="space-y-5">
            {error && (
              <div className="px-4 py-3 rounded-lg text-sm" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }}>
                {error}
              </div>
            )}
            {resetSent && (
              <div className="px-4 py-3 rounded-lg text-sm" style={{ background: colors.successBg, border: `1px solid ${colors.successBorder}`, color: colors.successText }}>
                Password reset email sent! Check your inbox.
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textPrimary }}>
                Email Address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null) }}
                className="block w-full px-4 py-3 rounded-lg text-sm transition-all duration-200 outline-none"
                style={{
                  border: `1.5px solid ${colors.inputBorder}`,
                  color: colors.inputText,
                  background: colors.inputBg,
                }}
                onFocus={(e) => { e.target.style.borderColor = '#C4B098'; e.target.style.boxShadow = isDark ? '0 0 0 3px rgba(196, 176, 152, 0.25)' : '0 0 0 3px rgba(196, 176, 152, 0.15)' }}
                onBlur={(e) => { e.target.style.borderColor = colors.inputBorder; e.target.style.boxShadow = 'none' }}
                placeholder="you@example.com"
              />
            </div>

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
                style={{
                  border: `1.5px solid ${colors.inputBorder}`,
                  color: colors.inputText,
                  background: colors.inputBg,
                }}
                onFocus={(e) => { e.target.style.borderColor = '#C4B098'; e.target.style.boxShadow = isDark ? '0 0 0 3px rgba(196, 176, 152, 0.25)' : '0 0 0 3px rgba(196, 176, 152, 0.15)' }}
                onBlur={(e) => { e.target.style.borderColor = colors.inputBorder; e.target.style.boxShadow = 'none' }}
                placeholder="Enter your password"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={resetting}
                className="text-xs font-medium transition-colors"
                style={{ color: '#C4B098' }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#A8926F'}
                onMouseLeave={(e) => e.currentTarget.style.color = '#C4B098'}
              >
                {resetting ? 'Sending...' : 'Forgot password?'}
              </button>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 px-4 rounded-lg text-sm font-bold uppercase tracking-wider text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'linear-gradient(135deg, #2D2D2D, #1E1E1E)',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
              }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = 'linear-gradient(135deg, #3D3D3D, #2D2D2D)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, #2D2D2D, #1E1E1E)' }}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {/* Divider */}
          <div className="mt-6 pt-5" style={{ borderTop: `1px solid ${colors.border}` }}>
            <p className="text-center text-xs" style={{ color: colors.textMuted }}>
              Don&apos;t have an account? Contact your brokerage administrator.
            </p>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs mt-6" style={{ color: 'rgba(255,255,255,0.3)' }}>
          &copy; {new Date().getFullYear()} Firm Funds Inc. All rights reserved.
        </p>
      </div>
    </div>
  )
}
