'use server'

import { headers } from 'next/headers'
import { createServiceRoleClient, createClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import { checkPasswordRateLimit } from '@/lib/rate-limit'
import { logAuditEventServiceRole } from '@/lib/audit'

const APP_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'

// ============================================================================
// Password Change
// ============================================================================

export async function changePassword(data: {
  currentPassword: string
  newPassword: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !user.email) return { success: false, error: 'Not authenticated' }

  // Rate-limit the wrong-current-password path. Without this, a stolen
  // session cookie lets an attacker brute-force the current password by
  // repeatedly calling this action.
  const hdrs = await headers()
  const ip = (hdrs.get('x-forwarded-for') || hdrs.get('x-real-ip') || 'unknown').split(',')[0].trim()
  const rateCheck = await checkPasswordRateLimit(ip)
  if (!rateCheck.allowed) {
    return { success: false, error: 'Too many password change attempts. Try again in a few minutes.' }
  }

  // Verify current password by attempting sign-in
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: data.currentPassword,
  })

  if (signInError) {
    return { success: false, error: 'Current password is incorrect' }
  }

  // Validate new password
  if (data.newPassword.length < 8) {
    return { success: false, error: 'New password must be at least 8 characters' }
  }

  if (data.newPassword === data.currentPassword) {
    return { success: false, error: 'New password must be different from current password' }
  }

  // Update password
  const { error: updateError } = await supabase.auth.updateUser({
    password: data.newPassword,
  })

  if (updateError) {
    console.error('Password update error:', updateError.message)
    return { success: false, error: 'Failed to update password. Please try again.' }
  }

  // Clear must_reset_password flag if set
  const serviceClient = createServiceRoleClient()
  await serviceClient
    .from('user_profiles')
    .update({ must_reset_password: false })
    .eq('id', user.id)

  return { success: true }
}

// ============================================================================
// Update Display Name
// ============================================================================

export async function updateDisplayName(newName: string) {
  const { error: authError, user } = await getAuthenticatedUser()
  if (authError || !user) return { success: false, error: authError || 'Not authenticated' }

  if (!newName.trim() || newName.trim().length < 2) {
    return { success: false, error: 'Name must be at least 2 characters' }
  }

  const serviceClient = createServiceRoleClient()

  const { error } = await serviceClient
    .from('user_profiles')
    .update({ full_name: newName.trim() })
    .eq('id', user.id)

  if (error) {
    console.error('Name update error:', error.message)
    return { success: false, error: 'Failed to update name' }
  }

  return { success: true }
}

// ============================================================================
// Update Email
// ============================================================================

export async function updateEmail(newEmail: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(newEmail)) {
    return { success: false, error: 'Invalid email address' }
  }

  if (newEmail.toLowerCase() === user.email?.toLowerCase()) {
    return { success: false, error: 'New email is the same as your current email' }
  }

  const oldEmail = user.email ?? null

  // Update in Supabase Auth (sends confirmation email to the new address).
  // emailRedirectTo points at our /auth/email-confirmed route so the redirect
  // after the user clicks the link runs reconcileUserEmail and mirrors
  // auth.users.email -> user_profiles.email. See lib/email-reconcile.ts.
  const { error: authUpdateError } = await supabase.auth.updateUser(
    { email: newEmail },
    { emailRedirectTo: `${APP_URL}/auth/email-confirmed` }
  )

  if (authUpdateError) {
    console.error('Email update auth error:', authUpdateError.message)
    return { success: false, error: 'Failed to update email. It may already be in use.' }
  }

  // Finding #42: do NOT mirror the new email to user_profiles here. Magic-link
  // and invite recovery flows key on user_profiles.email; writing the
  // unverified new address lets a stolen-session attacker redirect recovery
  // to themselves. The mirror happens in reconcileUserEmail only after
  // Supabase verifies the user actually owns the new inbox.
  await logAuditEventServiceRole({
    userId: user.id,
    action: 'user.email_change_requested',
    entityType: 'user',
    entityId: user.id,
    severity: 'warning',
    actorEmail: oldEmail ?? undefined,
    metadata: { old_email: oldEmail, new_email: newEmail.toLowerCase() },
  })

  return { success: true, message: 'A confirmation email has been sent to your new address. Please verify it to complete the change.' }
}

// ============================================================================
// Notification Preferences
// ============================================================================

export async function getNotificationPreferences() {
  const { error: authError, user } = await getAuthenticatedUser()
  if (authError || !user) return { success: false, error: authError || 'Not authenticated', data: null }

  const serviceClient = createServiceRoleClient()
  const { data, error } = await serviceClient
    .from('user_profiles')
    .select('notification_preferences')
    .eq('id', user.id)
    .single()

  if (error) {
    return { success: true, data: getDefaultPrefs() }
  }

  return { success: true, data: data?.notification_preferences || getDefaultPrefs() }
}

// Finding #41: whitelist of valid notification preference keys. Anything not
// in this set is silently dropped so users cannot opt out of legally-required
// notices (late-payment warnings, demand letters, etc.) by smuggling extra
// keys into this payload.
const ALLOWED_PREF_KEYS = [
  'email_deal_updates',
  'email_new_messages',
  'email_status_changes',
  'email_document_requests',
] as const

export async function updateNotificationPreferences(prefs: Record<string, boolean>) {
  const { error: authError, user } = await getAuthenticatedUser()
  if (authError || !user) return { success: false, error: authError || 'Not authenticated' }

  // Filter to allowlisted keys with boolean values; drop everything else.
  const filtered: Record<string, boolean> = {}
  for (const key of ALLOWED_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(prefs, key) && typeof prefs[key] === 'boolean') {
      filtered[key] = prefs[key]
    }
  }

  const serviceClient = createServiceRoleClient()
  const { error } = await serviceClient
    .from('user_profiles')
    .update({ notification_preferences: filtered })
    .eq('id', user.id)

  if (error) {
    console.error('Notification prefs update error:', error.message)
    return { success: false, error: 'Failed to update notification preferences' }
  }

  return { success: true }
}

function getDefaultPrefs() {
  return {
    email_deal_updates: true,
    email_new_messages: true,
    email_status_changes: true,
    email_document_requests: true,
  }
}

// ============================================================================
// Update Brokerage Contact Email
// ============================================================================

export async function updateBrokerageContactEmail(newEmail: string) {
  const { error: authError, user, profile } = await getAuthenticatedUser(['brokerage_admin'])
  if (authError || !user || !profile) return { success: false, error: authError || 'Not authorized' }
  if (!profile.brokerage_id) return { success: false, error: 'Your account is not linked to a brokerage' }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(newEmail)) {
    return { success: false, error: 'Invalid email address' }
  }

  const serviceClient = createServiceRoleClient()

  // Finding #40: do NOT flip brokerages.email immediately. A stolen
  // brokerage_admin session could otherwise silently redirect every brokerage
  // notification to an attacker-owned inbox. Write the requested address to
  // pending_contact_email + a hashed single-use token, email the raw token
  // to the new address, and only flip on confirmation. The OLD address is
  // notified immediately so the legitimate owner gets early warning.
  // (Column is brokerages.email; the pending_contact_email* naming on the
  // staging fields is descriptive but not load-bearing.)
  const { data: existing } = await serviceClient
    .from('brokerages')
    .select('email, name')
    .eq('id', profile.brokerage_id)
    .single()

  const oldEmail: string | null = existing?.email ?? null
  const brokerageName: string = existing?.name ?? 'Your brokerage'
  const newEmailLc = newEmail.toLowerCase()

  if (oldEmail && oldEmail.toLowerCase() === newEmailLc) {
    return { success: true }
  }

  const { randomBytes, createHash } = await import('node:crypto')
  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const requestedAt = new Date()
  const expiresAt = new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000) // 24h

  const { error } = await serviceClient
    .from('brokerages')
    .update({
      pending_contact_email: newEmailLc,
      pending_contact_email_token_hash: tokenHash,
      pending_contact_email_requested_at: requestedAt.toISOString(),
      pending_contact_email_expires_at: expiresAt.toISOString(),
    })
    .eq('id', profile.brokerage_id)

  if (error) {
    console.error('Brokerage email pending-update error:', error.message)
    return { success: false, error: 'Failed to start brokerage contact email change' }
  }

  await logAuditEventServiceRole({
    userId: user.id,
    action: 'brokerage.contact_email_change_requested',
    entityType: 'brokerage',
    entityId: profile.brokerage_id,
    severity: 'warning',
    actorEmail: user.email ?? undefined,
    actorRole: 'brokerage_admin',
    metadata: {
      old_email: oldEmail,
      pending_email: newEmailLc,
      brokerage_name: brokerageName,
      expires_at: expiresAt.toISOString(),
    },
  })

  const confirmUrl = `${APP_URL}/api/brokerage/confirm-contact-email?token=${encodeURIComponent(rawToken)}`

  try {
    const { sendBrokerageContactEmailConfirm, sendBrokerageContactEmailChangeRequested } = await import('@/lib/email')
    await sendBrokerageContactEmailConfirm({
      brokerageName,
      newEmail: newEmailLc,
      confirmUrl,
      expiresAtIso: expiresAt.toISOString(),
    })
    if (oldEmail) {
      await sendBrokerageContactEmailChangeRequested({
        brokerageName,
        oldEmail,
        newEmail: newEmailLc,
        expiresAtIso: expiresAt.toISOString(),
      })
    }
  } catch (emailErr: unknown) {
    const _msg = emailErr instanceof Error ? emailErr.message : "Unknown error"
    console.error('Brokerage email change notification error (non-fatal):', _msg)
  }

  return {
    success: true,
    message: `Confirmation email sent to ${newEmailLc}. The change will take effect only after the new address confirms.`,
  }
}
