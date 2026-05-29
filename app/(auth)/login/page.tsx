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
import { loginWithPassword } from '@/lib/actions/auth-actions'

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

  // Status banners surfaced from query params that other routes set when
  // bouncing the user back to /login (timeout, email-change confirmations,
  // brokerage contact-email confirmations, etc). Tone: success / info /
  // warning render differently from the destructive login error above.
  const statusBanner = (() => {
    const brokerageEmail = searchParams.get('brokerage_email')
    if (brokerageEmail === 'confirmed') {
      return { tone: 'success' as const, text: 'Brokerage contact email confirmed. Sign in to continue.' }
    }
    if (brokerageEmail === 'expired') {
      return { tone: 'warning' as const, text: 'That confirmation link has expired. Request the change again from Brokerage Settings.' }
    }
    if (brokerageEmail === 'invalid') {
      return { tone: 'warning' as const, text: 'That confirmation link is invalid or has already been used.' }
    }
    if (brokerageEmail === 'error') {
      return { tone: 'error' as const, text: 'Something went wrong confirming the brokerage contact email. Please try again.' }
    }
    const emailChange = searchParams.get('email_change')
    if (emailChange === 'confirmed') {
      return { tone: 'success' as const, text: 'Email change confirmed. Sign in with your new email address.' }
    }
    if (emailChange === 'confirmed_login_required') {
      return { tone: 'info' as const, text: 'Email change confirmed. Sign in to continue.' }
    }
    if (emailChange === 'failed') {
      return { tone: 'error' as const, text: 'Email change could not be confirmed. The link may be invalid or expired.' }
    }
    if (searchParams.get('reason') === 'timeout') {
      return { tone: 'info' as const, text: 'You were signed out due to inactivity.' }
    }
    // Firm-deal magic links from offer emails + SMS land here when the
    // /agent/firm-deal/[token] route can't sign the recipient in. Each
    // reason gets its own copy so the recipient knows what to do next
    // instead of staring at a blank login form. See
    // app/agent/firm-deal/[token]/route.ts for what sets each reason.
    const reason = searchParams.get('reason')
    if (reason === 'firm_deal_expired') {
      return {
        tone: 'warning' as const,
        text: 'That deal link has expired. Ask your brokerage to resend the offer, or sign in below if you already have an account.',
      }
    }
    if (reason === 'firm_deal_invalid') {
      return {
        tone: 'warning' as const,
        text: "We couldn't open that deal link. It may have been mistyped or expired. Ask your brokerage to resend it, or sign in below.",
      }
    }
    if (reason === 'firm_deal_no_account') {
      return {
        tone: 'warning' as const,
        text: "That deal was sent to you, but you don't have a Firm Funds account yet. Ask your brokerage admin to add you, then click the link in the welcome email.",
      }
    }
    return null
  })()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResetSent(false)

    // Single generic copy for every post-auth rejection (inactive profile,
    // flagged agent, suspended brokerage, missing profile, etc). The server
    // records the specific reason in audit_log.metadata.reason — never leak
    // it to the browser.
    const BLOCKED_LOGIN_MESSAGE =
      'Your account is not currently active. Please contact your brokerage administrator.'

    let result: Awaited<ReturnType<typeof loginWithPassword>>
    try {
      result = await loginWithPassword({
        email,
        password,
      })
    } catch {
      // Server action threw (network blip, server exception, revalidation
      // error, etc). Surface a generic failure and always release the
      // spinner so the user can retry.
      setError('Unable to sign in. Please try again.')
      setLoading(false)
      return
    }

    if (!result.success) {
      const message =
        result.code === 'blocked'
          ? BLOCKED_LOGIN_MESSAGE
          : result.error || 'Unable to sign in.'
      setError(message)
      setLoading(false)
      return
    }

    // Success — keep the spinner active while we navigate so the button
    // does not flicker back to "Sign In" mid-redirect.
    const role = result.data?.role || 'agent'
    if (redirectTo) {
      const roleRoutes: Record<string, string> = {
        agent: '/agent',
        brokerage_admin: '/brokerage',
        firm_funds_admin: '/admin',
        super_admin: '/admin',
      }
      const allowedPrefix = roleRoutes[role] || '/agent'
      if (redirectTo.startsWith(allowedPrefix)) {
        router.push(redirectTo)
        return
      }
    }

    switch (role) {
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
          {/* eslint-disable-next-line @next/next/no-img-element -- brand logo */}
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
        <Card className="border-border/40 shadow-2xl shadow-black/50 bg-card/90 backdrop-blur-sm overflow-hidden">
          <div className="h-[2px] bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
          <CardContent className="p-7 sm:p-9">
            <form onSubmit={handleLogin} className="space-y-6">
              {statusBanner && (
                <Alert
                  className={
                    statusBanner.tone === 'success'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : statusBanner.tone === 'warning'
                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                        : statusBanner.tone === 'error'
                          ? 'bg-destructive/10 border-destructive/30 text-destructive'
                          : 'bg-primary/10 border-primary/30 text-primary'
                  }
                >
                  {statusBanner.tone === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription className="text-sm">{statusBanner.text}</AlertDescription>
                </Alert>
              )}
              {error && (
                <Alert
                  variant="destructive"
                  className="bg-destructive/10 border-destructive/30"
                  aria-live="polite"
                  aria-atomic="true"
                >
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
                className="w-full h-12 text-sm font-bold uppercase tracking-[0.15em] shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 transition-all"
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
