'use server'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'

// ============================================================================
// Change password AND clear the must_reset_password flag in one server action
// ============================================================================

export async function changePasswordAndClearFlag(newPassword: string): Promise<{ success: boolean; error?: string; role?: string }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { success: false, error: 'Not authenticated. Please log in again.' }
  }

  const serviceClient = createServiceRoleClient()

  // 1. Update password using admin API (more reliable than client-side updateUser)
  const { error: pwError } = await serviceClient.auth.admin.updateUserById(user.id, {
    password: newPassword,
  })

  if (pwError) {
    console.error('Password update error:', pwError.message)
    return { success: false, error: pwError.message }
  }

  // 2. Clear the must_reset_password flag
  const { error: flagError } = await serviceClient
    .from('user_profiles')
    .update({ must_reset_password: false })
    .eq('id', user.id)

  if (flagError) {
    console.error('Failed to clear must_reset_password:', flagError.message)
    // Password was changed successfully, so don't fail entirely
  }

  // 3. Get user role for redirect
  const { data: profile } = await serviceClient
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  return { success: true, role: profile?.role || 'agent' }
}
