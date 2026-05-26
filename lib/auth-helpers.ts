'use server'

import { createClient } from '@/lib/supabase/server'
import { reconcileUserEmail } from '@/lib/email-reconcile'
import type { SupabaseClient, User } from '@supabase/supabase-js'

// ============================================================================
// Types
// ============================================================================

interface AuthResult {
  error: string | null
  user: User | null
  profile: any | null
  supabase: SupabaseClient
}

// ============================================================================
// Shared auth helpers — used by admin-actions, kyc-actions, report-actions, deal-actions
// ============================================================================

/**
 * Get the current authenticated user, verify they have an admin role
 * (super_admin or firm_funds_admin), and return their profile + supabase client.
 */
export async function getAuthenticatedAdmin(): Promise<AuthResult> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: 'Not authenticated', user: null, profile: null, supabase }
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return { error: 'User profile not found', user, profile: null, supabase }
  }

  // Deactivated admins cannot perform privileged actions even if their auth
  // user still has a valid session. Middleware handles UI bouncing; this is
  // belt-and-suspenders for server actions invoked before the next page load.
  if (profile.is_active === false) {
    return { error: 'Account deactivated', user, profile, supabase }
  }

  if (!['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

  await maybeReconcileEmail(user, profile)

  return { error: null, user, profile, supabase }
}

/**
 * Get the current authenticated user with optional role check.
 * If requiredRoles is provided, verifies the user has one of those roles.
 */
export async function getAuthenticatedUser(requiredRoles?: string[]): Promise<AuthResult> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: 'Not authenticated', user: null, profile: null, supabase }
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return { error: 'User profile not found', user, profile: null, supabase }
  }

  if (profile.is_active === false) {
    return { error: 'Account deactivated', user, profile, supabase }
  }

  if (requiredRoles && !requiredRoles.includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

  await maybeReconcileEmail(user, profile)

  return { error: null, user, profile, supabase }
}

// Finding #42 follow-up: safety net for the cross-device case. If the user
// initiated an email change here but confirmed it on a phone that isn't
// logged in to this app, the dedicated /auth/email-confirmed route never
// runs. Reconcile on the next authenticated server-action call instead.
async function maybeReconcileEmail(user: User, profile: any): Promise<void> {
  const authEmail = user.email ?? null
  const profileEmail = profile?.email ?? null
  if (!authEmail || !profile?.id) return
  if (authEmail.toLowerCase() === (profileEmail ?? '').toLowerCase()) return

  try {
    const result = await reconcileUserEmail({
      userId: profile.id,
      authEmail,
      profileEmail,
    })
    if (result.changed) {
      profile.email = result.newEmail
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.warn(`[auth-helpers] email reconcile failed: ${message}`)
  }
}
