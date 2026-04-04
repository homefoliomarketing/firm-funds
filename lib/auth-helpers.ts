'use server'

import { createClient } from '@/lib/supabase/server'
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

  if (!['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

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

  if (requiredRoles && !requiredRoles.includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

  return { error: null, user, profile, supabase }
}
