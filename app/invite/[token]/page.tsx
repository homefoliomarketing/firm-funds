'use client'

import { useState, useEffect, use } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent } from '@/components/ui/card'

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)

  const [status, setStatus] = useState<'loading' | 'valid' | 'invalid' | 'setting' | 'success'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [agentName, setAgentName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

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
        // Auto-login: sign in with the password they just set
        const supabase = createClient()
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (!signInError) {
          // Redirect based on role (the middleware will handle routing)
          window.location.href = '/'
          return
        }
        // If auto-login fails for any reason, fall back to success screen
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

  const bgClass = 'min-h-screen flex items-center justify-center bg-background'

  // ---- Loading ----
  if (status === 'loading') {
    return (
      <div className={bgClass}>
        <div className="text-center">
          <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 w-auto mx-auto mb-5" />
          <p className="text-sm text-muted-foreground">Validating your invite...</p>
        </div>
      </div>
    )
  }

  // ---- Invalid / Expired ----
  if (status === 'invalid') {
    return (
      <div className={bgClass}>
        <div className="relative max-w-md w-full mx-4">
          <div className="text-center mb-8">
            <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 w-auto mx-auto mb-5" />
          </div>
          <Card className="border-border/50">
            <CardContent className="p-6 text-center">
              <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center bg-destructive/10">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--destructive))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              </div>
              <h2 className="text-lg font-bold mb-2 text-foreground">
                Invite Link Unavailable
              </h2>
              <p className="text-sm mb-6 text-muted-foreground">
                {error}
              </p>
              <a href="/login" className="inline-flex items-center justify-center rounded-md px-6 py-2 text-sm font-bold uppercase tracking-wider bg-primary hover:bg-primary/90 text-primary-foreground transition-colors">
                Go to Login
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // ---- Success ----
  if (status === 'success') {
    return (
      <div className={bgClass}>
        <div className="relative max-w-md w-full mx-4">
          <div className="text-center mb-8">
            <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 w-auto mx-auto mb-5" />
          </div>
          <Card className="border-border/50">
            <CardContent className="p-6 text-center">
              <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center bg-primary/10">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--primary))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2 className="text-lg font-bold mb-2 text-foreground">
                You&apos;re All Set!
              </h2>
              <p className="text-sm mb-6 text-muted-foreground">
                Your password has been set successfully. You can now log in to the Firm Funds portal.
              </p>
              <a href="/login" className="inline-flex items-center justify-center rounded-md px-6 py-2 text-sm font-bold uppercase tracking-wider bg-primary hover:bg-primary/90 text-primary-foreground transition-colors">
                Log In Now
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // ---- Set Password Form ----
  const isSubmitting = status === 'setting'

  return (
    <div className={bgClass}>
      <div className="absolute top-0 right-0 w-96 h-96 opacity-5 rounded-full bg-primary blur-[80px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-80 h-80 opacity-5 rounded-full bg-primary blur-[60px] pointer-events-none" />

      <div className="relative max-w-md w-full mx-4">
        <div className="text-center mb-8">
          <img src="/brand/white.png" alt="Firm Funds" className="h-28 sm:h-36 md:h-48 w-auto mx-auto mb-5" />
          <p className="text-sm font-medium tracking-wide text-primary">
            Commission Advance Portal
          </p>
        </div>

        <Card className="border-border/50 shadow-2xl">
          <CardContent className="p-5 sm:p-8">
            <div className="mb-6">
              <h2 className="text-lg font-bold mb-1 text-foreground">
                Welcome{agentName ? `, ${agentName.split(' ')[0]}` : ''}!
              </h2>
              <p className="text-sm text-muted-foreground">
                Create your password to get started with Firm Funds.
              </p>
              {email && (
                <p className="text-xs mt-2 px-3 py-1.5 rounded-lg inline-block bg-muted text-muted-foreground">
                  {email}
                </p>
              )}
            </div>

            <form onSubmit={handleSetPassword} className="space-y-5">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider">
                  Password
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(null) }}
                    placeholder="Min. 12 chars, upper/lower/number/special"
                    className="focus-visible:ring-primary pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword" className="text-xs font-semibold uppercase tracking-wider">
                  Confirm Password
                </Label>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => { setConfirmPassword(e.target.value); setError(null) }}
                    placeholder="Re-enter your password"
                    className="focus-visible:ring-primary pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    tabIndex={-1}
                  >
                    {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3.5 text-sm font-bold uppercase tracking-wider bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {isSubmitting ? 'Setting up your account...' : 'Set Password & Continue'}
              </Button>
            </form>

            <div className="mt-6 pt-5 border-t border-border/50">
              <p className="text-center text-xs text-muted-foreground">
                Already have an account? <a href="/login" className="text-primary hover:underline">Log in here</a>
              </p>
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs mt-6 text-white/30">
          &copy; {new Date().getFullYear()} Firm Funds Inc. All rights reserved.
        </p>
      </div>
    </div>
  )
}
