'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useTheme } from '@/lib/theme'
import { clearMustResetPassword } from '@/lib/actions/auth-actions'

export default function ChangePasswordPage() {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters long.')
      return
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)

    // 1. Update the password in Supabase Auth
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    // 2. Clear the must_reset_password flag (server action bypasses RLS)
    await clearMustResetPassword()

    // 3. Redirect to appropriate dashboard
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (profile) {
        switch (profile.role) {
          case 'agent': router.push('/agent'); break
          case 'brokerage_admin': router.push('/brokerage'); break
          case 'firm_funds_admin':
          case 'super_admin': router.push('/admin'); break
          default: router.push('/agent')
        }
        return
      }
    }
    router.push('/agent')
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: isDark ? 'linear-gradient(145deg, #121212 0%, #181818 40%, #1E1E1E 100%)' : 'linear-gradient(145deg, #1E1E1E 0%, #2D2D2D 40%, #3D3D3D 100%)' }}>
      {/* Subtle decorative elements */}
      <div className="absolute top-0 right-0 w-96 h-96 opacity-5 rounded-full" style={{ background: 'radial-gradient(circle, #5FA873, transparent)', filter: 'blur(80px)' }} />
      <div className="absolute bottom-0 left-0 w-80 h-80 opacity-5 rounded-full" style={{ background: 'radial-gradient(circle, #5FA873, transparent)', filter: 'blur(60px)' }} />

      <div className="relative max-w-md w-full mx-4">
        {/* Logo / Brand Area */}
        <div className="text-center mb-8">
          <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 md:h-48 w-auto mx-auto mb-5" />
          <p className="text-sm font-medium tracking-wide" style={{ color: '#5FA873', fontFamily: 'var(--font-geist-sans), sans-serif' }}>
            Commission Advance Portal
          </p>
        </div>

        {/* Change Password Card */}
        <div className="rounded-2xl shadow-2xl p-5 sm:p-8" style={{ background: colors.cardBg, boxShadow: `0 25px 60px ${colors.shadowColor}` }}>
          <div className="mb-6">
            <h2 className="text-lg font-bold mb-1" style={{ color: colors.textPrimary }}>
              Set Your New Password
            </h2>
            <p className="text-sm" style={{ color: colors.textSecondary }}>
              For security, please create a new password before continuing.
            </p>
          </div>

          <form onSubmit={handleChangePassword} className="space-y-5">
            {error && (
              <div className="px-4 py-3 rounded-lg text-sm" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }}>
                {error}
              </div>
            )}

            <div>
              <label htmlFor="newPassword" className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textPrimary }}>
                New Password
              </label>
              <input
                id="newPassword"
                type="password"
                required
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(null) }}
                className="block w-full px-4 py-3 rounded-lg text-sm transition-all duration-200 outline-none"
                style={{
                  border: `1.5px solid ${colors.inputBorder}`,
                  color: colors.inputText,
                  background: colors.inputBg,
                }}
                onFocus={(e) => { e.target.style.borderColor = '#5FA873'; e.target.style.boxShadow = isDark ? '0 0 0 3px rgba(95, 168, 115, 0.25)' : '0 0 0 3px rgba(95, 168, 115, 0.15)' }}
                onBlur={(e) => { e.target.style.borderColor = colors.inputBorder; e.target.style.boxShadow = 'none' }}
                placeholder="Min. 8 characters"
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
                style={{
                  border: `1.5px solid ${colors.inputBorder}`,
                  color: colors.inputText,
                  background: colors.inputBg,
                }}
                onFocus={(e) => { e.target.style.borderColor = '#5FA873'; e.target.style.boxShadow = isDark ? '0 0 0 3px rgba(95, 168, 115, 0.25)' : '0 0 0 3px rgba(95, 168, 115, 0.15)' }}
                onBlur={(e) => { e.target.style.borderColor = colors.inputBorder; e.target.style.boxShadow = 'none' }}
                placeholder="Re-enter your new password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 px-4 rounded-lg text-sm font-bold uppercase tracking-wider text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'linear-gradient(135deg, #5FA873, #4A8F5D)',
                boxShadow: '0 4px 12px rgba(95, 168, 115, 0.3)',
              }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = 'linear-gradient(135deg, #6FBA83, #5FA873)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, #5FA873, #4A8F5D)' }}
            >
              {loading ? 'Updating...' : 'Set Password & Continue'}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-xs mt-6" style={{ color: 'rgba(255,255,255,0.3)' }}>
          &copy; {new Date().getFullYear()} Firm Funds Inc. All rights reserved.
        </p>
      </div>
    </div>
  )
}
