'use server'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'

// ============================================================================
// Clear the must_reset_password flag after user sets a new password
// ============================================================================

export async function clearMustResetPassword(): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { success: false, error: 'Not authenticated' }
  }

  // Use service role to bypass RLS
  const serviceClient = createServiceRoleClient()
  const { error } = await serviceClient
    .from('user_profiles')
    .update({ must_reset_password: false })
    .eq('id', user.id)

  if (error) {
    console.error('Failed to clear must_reset_password:', error.message)
    return { success: false, error: 'Failed to update profile' }
  }

  return { success: true }
}
