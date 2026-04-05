'use server'

import { createServiceRoleClient, createClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'

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

  // Update in Supabase Auth (sends confirmation email)
  const { error: authUpdateError } = await supabase.auth.updateUser({
    email: newEmail,
  })

  if (authUpdateError) {
    console.error('Email update auth error:', authUpdateError.message)
    return { success: false, error: 'Failed to update email. It may already be in use.' }
  }

  // Also update in user_profiles
  const serviceClient = createServiceRoleClient()
  await serviceClient
    .from('user_profiles')
    .update({ email: newEmail.toLowerCase() })
    .eq('id', user.id)

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

export async function updateNotificationPreferences(prefs: Record<string, boolean>) {
  const { error: authError, user } = await getAuthenticatedUser()
  if (authError || !user) return { success: false, error: authError || 'Not authenticated' }

  const serviceClient = createServiceRoleClient()
  const { error } = await serviceClient
    .from('user_profiles')
    .update({ notification_preferences: prefs })
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
  const { error } = await serviceClient
    .from('brokerages')
    .update({ contact_email: newEmail.toLowerCase() })
    .eq('id', profile.brokerage_id)

  if (error) {
    console.error('Brokerage email update error:', error.message)
    return { success: false, error: 'Failed to update brokerage contact email' }
  }

  return { success: true }
}
