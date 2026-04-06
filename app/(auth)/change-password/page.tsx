'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

export default function ChangePasswordPage() {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Strong password policy for financial app (FINTRAC/PIPEDA compliance)
    const hasUpper = /[A-Z]/.test(newPassword)
    const hasLower = /[a-z]/.test(newPassword)
    const hasNumber = /\d/.test(newPassword)
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword)

    if (newPassword.length < 12 || !hasUpper || !hasLower || !hasNumber || !hasSpecial) {
      setError('Password must be at least 12 characters with uppercase, lowercase, number, and special character.')
      return
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)

    // Rate limit check
    try {
      const rlRes = await fetch('/api/rate-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'password' }),
      })
      const rlData = await rlRes.json()
      if (!rlData.allowed) {
        setError(rlData.error || 'Too many attempts. Please try again later.')
        setLoading(false)
        return
      }
    } catch {
      // Rate limit check failed — continue (fail open)
    }

    try {
      // Step 1: Update password + set metadata flag
      // This talks DIRECTLY to Supabase (not through Netlify)
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
        data: { password_changed: true },
      })

      if (updateError) {
        setError(updateError.message)
        setLoading(false)
        return
      }

      // Step 2: Force a session refresh so the JWT cookie gets the new metadata
      // Without this, the middleware might see the OLD JWT without password_changed
      await supabase.auth.refreshSession()

      // Step 3: Clear the DB flag via API route
      // Await this to ensure audit log is written and DB state is consistent
      try {
        const resetResponse = await fetch('/api/clear-reset-flag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        if (!resetResponse.ok) {
          console.warn('Failed to clear reset flag, but password was updated successfully')
        }
      } catch {
        // Non-critical: metadata flag is already set and middleware checks it first
        console.warn('clear-reset-flag request failed, continuing')
      }

      // Step 4: Get role for redirect (direct Supabase query, no Netlify)
      const { data: { user } } = await supabase.auth.getUser()
      let redirectPath = '/agent'

      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()

        if (profile) {
          switch (profile.role) {
            case 'agent': redirectPath = '/agent'; break
            case 'brokerage_admin': redirectPath = '/brokerage'; break
            case 'firm_funds_admin':
            case 'super_admin': redirectPath = '/admin'; break
          }
        }
      }

      // Step 5: Hard redirect (not router.push) to ensure middleware re-evaluates
      // with the fresh cookies from refreshSession()
      window.location.href = redirectPath
    } catch (err) {
      console.error('Change password error:', err)
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="absolute top-0 right-0 w-96 h-96 opacity-5 rounded-full bg-primary blur-[80px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-80 h-80 opacity-5 rounded-full bg-primary blur-[60px] pointer-events-none" />

      <div className="relative max-w-md w-full mx-4">
        <div className="text-center mb-8">
          <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 md:h-48 w-auto mx-auto mb-5" />
          <p className="text-sm font-medium tracking-wide text-primary">
            Commission Advance Portal
          </p>
        </div>

        <div className="rounded-2xl shadow-2xl p-5 sm:p-8 bg-card border border-border/50">
          <div className="mb-6">
            <h2 className="text-lg font-bold mb-1 text-foreground">
              Set Your New Password
            </h2>
            <p className="text-sm text-muted-foreground">
              For security, please create a new password before continuing.
            </p>
          </div>

          <form onSubmit={handleChangePassword} className="space-y-5">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="newPassword" className="text-xs font-semibold uppercase tracking-wider">
                New Password
              </Label>
              <Input
                id="newPassword"
                type="password"
                required
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(null) }}
                placeholder="Min. 12 chars, upper/lower/number/special"
                className="focus-visible:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirmPassword" className="text-xs font-semibold uppercase tracking-wider">
                Confirm Password
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(null) }}
                placeholder="Re-enter your new password"
                className="focus-visible:ring-primary"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 text-sm font-bold uppercase tracking-wider bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {loading ? 'Updating...' : 'Set Password & Continue'}
            </Button>
          </form>
        </div>

        <p className="text-center text-xs mt-6 text-white/30">
          &copy; {new Date().getFullYear()} Firm Funds Inc. All rights reserved.
        </p>
      </div>
    </div>
  )
}
