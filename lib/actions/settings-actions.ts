'use server'

import { headers } from 'next/headers'
import { createServiceRoleClient, createClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import { checkPasswordRateLimit } from '@/lib/rate-limit'

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

  // Update in Supabase Auth (sends confirmation email)
  const { error: authUpdateError } = await supabase.auth.updateUser({
    email: newEmail,
  })

  if (authUpdateError) {
    console.error('Email update auth error:', authUpdateError.message)
    return { success: false, error: 'Failed to update email. It may already be in use.' }
  }

  // Finding #42: do NOT mirror new email to user_profiles here. Magic-link
  // and invite recovery flows key on user_profiles.email, so writing the
  // unverified new address lets an attacker with a stolen session redirect
  // recovery to themselves. user_profiles.email should remain pointing at
  // the previously-verified address until Supabase confirms the change.
  // TODO: add an auth event handler on EMAIL_CHANGE_CONFIRM (or a webhook
  // from Supabase Auth) that mirrors auth.users.email to user_profiles.email
  // ONLY after the user clicks the confirmation link on the new address.

  // Audit log every change attempt with old + new addresses.
  const serviceClient = createServiceRoleClient()
  void serviceClient.from('audit_log').insert({
    user_id: user.id,
    action: 'user.email_change_requested',
    entity_type: 'user',
    entity_id: user.id,
    severity: 'warning',
    actor_email: oldEmail,
    actor_role: null,
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

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(newEmail)) {
    return { success: false, error: 'Invalid email address' }
  }

  const serviceClient = createServiceRoleClient()

  // Finding #40: read the existing contact_email so we can audit-log the
  // change and notify the OLD address. This gives the legitimate owner a
  // chance to detect an attacker silently redirecting all brokerage
  // notifications (deal status, invoices, settlement reminders) to a new
  // inbox they control.
  // TODO: require confirmation token from new address before persisting
  // (see audit finding #40)
  const { data: existing } = await serviceClient
    .from('brokerages')
    .select('contact_email, name')
    .eq('id', profile.brokerage_id)
    .single()

  const oldEmail: string | null = existing?.contact_email ?? null
  const brokerageName: string = existing?.name ?? 'Your brokerage'
  const newEmailLc = newEmail.toLowerCase()

  if (oldEmail && oldEmail.toLowerCase() === newEmailLc) {
    return { success: true }
  }

  const { error } = await serviceClient
    .from('brokerages')
    .update({ contact_email: newEmailLc })
    .eq('id', profile.brokerage_id)

  if (error) {
    console.error('Brokerage email update error:', error.message)
    return { success: false, error: 'Failed to update brokerage contact email' }
  }

  void serviceClient.from('audit_log').insert({
    user_id: user.id,
    action: 'brokerage.contact_email_change',
    entity_type: 'brokerage',
    entity_id: profile.brokerage_id,
    severity: 'warning',
    actor_email: user.email,
    actor_role: 'brokerage_admin',
    metadata: { old_email: oldEmail, new_email: newEmailLc, brokerage_name: brokerageName },
  })

  // Notify the OLD address so the legitimate owner can spot tampering.
  if (oldEmail) {
    try {
      const { sendEmailChangeNotification } = await import('@/lib/email')
      await sendEmailChangeNotification({
        recipientName: brokerageName,
        oldEmail,
        newEmail: newEmailLc,
      })
    } catch (emailErr: any) {
      console.error('Brokerage email change notification error (non-fatal):', emailErr?.message)
    }
  }

  return { success: true }
}
