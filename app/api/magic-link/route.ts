import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { checkSensitiveRateLimit } from '@/lib/rate-limit'
import { extractTrustedClientIpOrLocalhost } from '@/lib/request-helpers'

// ============================================================================
// Magic Link Token API
// ============================================================================
// POST: Validate a token and return basic info (email, agent name)
// PUT: Set password using the token (marks token as used)
// ============================================================================

/** POST: Validate token — returns agent info if valid */
export async function POST(request: Request) {
  try {
    // Sensitive bucket (5/min). The response shape leaks "token exists" vs
    // "doesn't" by content, so this is enumeration-friendly and needs a
    // tighter cap than the general API limit.
    const ip = extractTrustedClientIpOrLocalhost(request)
    const rl = await checkSensitiveRateLimit(ip)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })
    }

    const { token } = await request.json()
    if (!token) {
      return NextResponse.json({ success: false, error: 'Invalid or expired invite link.' })
    }

    const serviceClient = createServiceRoleClient()

    const { data: tokenRecord, error: tokenError } = await serviceClient
      .from('invite_tokens')
      .select('id, user_id, agent_id, email, expires_at, used_at')
      .eq('token', token)
      .single()

    // Normalize error messages to prevent token enumeration
    if (tokenError || !tokenRecord) {
      return NextResponse.json({ success: false, error: 'Invalid or expired invite link.' })
    }
    if (tokenRecord.used_at) {
      return NextResponse.json({ success: false, error: 'This invite link has already been used. Please log in with your password.' })
    }
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return NextResponse.json({ success: false, error: 'This invite link has expired. Please contact your administrator for a new invite.' })
    }

    // Get agent name for the welcome message
    let agentName = ''
    if (tokenRecord.agent_id) {
      const { data: agent } = await serviceClient
        .from('agents')
        .select('first_name, last_name')
        .eq('id', tokenRecord.agent_id)
        .single()
      if (agent) {
        agentName = `${agent.first_name} ${agent.last_name}`
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        email: tokenRecord.email,
        agentName,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('Magic link validate error:', message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}

/** PUT: Set password using the token */
export async function PUT(request: Request) {
  try {
    // Sensitive bucket (5/min). Same enumeration concern as POST plus a
    // password-set side effect; tight cap prevents credential stuffing
    // against guessed-token URLs.
    const ip = extractTrustedClientIpOrLocalhost(request)
    const rl = await checkSensitiveRateLimit(ip)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })
    }

    const { token, password } = await request.json()
    if (!token || !password) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    // Validate password strength (same rules as change-password page)
    const hasUpper = /[A-Z]/.test(password)
    const hasLower = /[a-z]/.test(password)
    const hasNumber = /\d/.test(password)
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)

    if (password.length < 12 || !hasUpper || !hasLower || !hasNumber || !hasSpecial) {
      return NextResponse.json({
        success: false,
        error: 'Password must be at least 12 characters with uppercase, lowercase, number, and special character.',
      })
    }

    const serviceClient = createServiceRoleClient()

    // Validate token
    const { data: tokenRecord, error: tokenError } = await serviceClient
      .from('invite_tokens')
      .select('id, user_id, agent_id, email, expires_at, used_at')
      .eq('token', token)
      .single()

    if (tokenError || !tokenRecord) {
      return NextResponse.json({ success: false, error: 'Invalid or expired invite link.' })
    }
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return NextResponse.json({ success: false, error: 'This invite link has expired.' })
    }

    // Atomic compare-and-swap claim on used_at (Finding 24). Previously we
    // checked used_at IS NULL then later UPDATE'd it after updateUserById,
    // leaving a TOCTOU window where two concurrent requests with the same
    // token could both pass the check and both call updateUserById. The CAS
    // below is a single statement: if used_at was already set, .maybeSingle()
    // returns no row and we reject. Fail-safe direction: if updateUserById
    // later fails, the token stays marked used and the user must request a
    // new invite (better than letting it be reused).
    const { data: claimed } = await serviceClient
      .from('invite_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', tokenRecord.id)
      .is('used_at', null)
      .select()
      .maybeSingle()
    if (!claimed) {
      return NextResponse.json({ success: false, error: 'This invite link has already been used.' })
    }

    // Set the user's password via admin API
    const { error: pwError } = await serviceClient.auth.admin.updateUserById(
      tokenRecord.user_id,
      {
        password,
        user_metadata: { password_changed: true },
      }
    )

    if (pwError) {
      console.error('Password set error:', pwError.message)
      return NextResponse.json({ success: false, error: 'Failed to set password. Please try again.' })
    }

    // Clear must_reset_password flag
    await serviceClient
      .from('user_profiles')
      .update({ must_reset_password: false })
      .eq('id', tokenRecord.user_id)

    // Audit log. Include invite_token_id + short token prefix so forensics
    // can correlate this password-set event back to the specific invite
    // token that was redeemed (the token itself is never logged).
    void serviceClient.from('audit_log').insert({
      user_id: tokenRecord.user_id,
      action: 'user.password_set_via_invite',
      entity_type: 'user',
      entity_id: tokenRecord.user_id,
      severity: 'info',
      actor_email: tokenRecord.email,
      actor_role: 'agent',
      metadata: {
        email: tokenRecord.email,
        agent_id: tokenRecord.agent_id,
        invite_token_id: tokenRecord.id,
        invite_token_prefix: typeof token === 'string' ? token.slice(0, 8) : null,
        actor_kind: 'magic_link_token',
      },
    })

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('Magic link set password error:', message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}
