'use client'

import { useState, Suspense } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
import { Eye, EyeOff, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  )
}

function LoginPageInner() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = searchParams.get('redirect')
  const supabase = createClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResetSent(false)

    // Rate limit check
    try {
      const rlRes = await fetch('/api/rate-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login' }),
      })
      const rlData = await rlRes.json()
      if (!rlData.allowed) {
        setError(rlData.error || 'Too many login attempts. Please try again later.')
        setLoading(false)
        return
      }
    } catch {
      // Rate limit check failed — continue (fail open)
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      void supabase.from('audit_log').insert({
        action: 'auth.login_failed',
        entity_type: 'auth',
        severity: 'warning',
        metadata: { email, reason: error.message },
        actor_email: email,
      })
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

      void supabase.from('audit_log').insert({
        user_id: user.id,
        action: 'auth.login',
        entity_type: 'auth',
        severity: 'info',
        actor_email: user.email,
        actor_role: profile?.role || null,
        metadata: { email: user.email },
      })

      if (profile) {
        if (redirectTo) {
          const roleRoutes: Record<string, string> = {
            agent: '/agent',
            brokerage_admin: '/brokerage',
            firm_funds_admin: '/admin',
            super_admin: '/admin',
          }
          const allowedPrefix = roleRoutes[profile.role] || '/agent'
          if (redirectTo.startsWith(allowedPrefix)) {
            router.push(redirectTo)
            return
          }
        }

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

    try {
      const rlRes = await fetch('/api/rate-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
      const rlData = await rlRes.json()
      if (!rlData.allowed) {
        setError(rlData.error || 'Too many reset attempts. Please try again later.')
        setResetting(false)
        return
      }
    } catch {
      // Rate limit check failed — continue (fail open)
    }

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
    <div id="main-content" className="min-h-screen flex items-center justify-center relative overflow-hidden bg-background">
      {/* Premium ambient glow effects */}
      <div className="absolute top-[-200px] right-[-100px] w-[500px] h-[500px] rounded-full opacity-[0.03] blur-[80px] bg-primary" />
      <div className="absolute bottom-[-150px] left-[-80px] w-[400px] h-[400px] rounded-full opacity-[0.03] blur-[60px] bg-primary" />

      <div className="relative max-w-[420px] w-full mx-4">
        {/* Logo / Brand */}
        <div className="text-center mb-10">
          <img
            src="/brand/white.png"
            alt="Firm Funds"
            className="h-28 sm:h-36 md:h-44 w-auto mx-auto mb-4"
          />
          <h1 className="sr-only">Firm Funds — Sign In</h1>
          <p className="text-xs font-medium tracking-[0.2em] uppercase text-primary">
            Commission Advance Portal
          </p>
        </div>

        {/* Login Card */}
        <Card className="border-border/40 shadow-2xl shadow-black/50 bg-card/90 backdrop-blur-sm">
          <CardContent className="p-7 sm:p-9">
            <form onSubmit={handleLogin} className="space-y-5">
              {error && (
                <Alert variant="destructive" className="bg-destructive/10 border-destructive/30">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-sm">{error}</AlertDescription>
                </Alert>
              )}
              {resetSent && (
                <Alert className="bg-emerald-500/10 border-emerald-500/30 text-emerald-400">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <AlertDescription className="text-sm text-emerald-400">
                    Password reset email sent! Check your inbox.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Email Address
                </Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(null) }}
                  placeholder="you@example.com"
                  className="h-11 bg-secondary/50 border-border/50 text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-primary/30 focus-visible:border-primary/50 transition-all"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Password
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(null) }}
                    placeholder="Enter your password"
                    className="h-11 pr-10 bg-secondary/50 border-border/50 text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-primary/30 focus-visible:border-primary/50 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary transition-colors"
                    tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={resetting}
                  className="text-xs font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                >
                  {resetting ? 'Sending...' : 'Forgot password?'}
                </button>
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full h-11 text-sm font-semibold uppercase tracking-wider"
                size="lg"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  'Sign In'
                )}
              </Button>
            </form>

            <Separator className="my-6 bg-border/50" />

            <p className="text-center text-xs text-muted-foreground">
              Don&apos;t have an account? Contact your brokerage administrator.
            </p>
          </CardContent>
        </Card>

        {/* Footer */}
        <p className="text-center text-xs mt-8 text-muted-foreground/40">
          &copy; {new Date().getFullYear()} Firm Funds Inc. All rights reserved.
        </p>
      </div>
    </div>
  )
}
