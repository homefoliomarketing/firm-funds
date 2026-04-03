import { NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  try {
    const { newPassword } = await request.json()

    if (!newPassword || newPassword.length < 8) {
      return NextResponse.json({ success: false, error: 'Password must be at least 8 characters.' }, { status: 400 })
    }

    // Get the authenticated user from cookies
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'Not authenticated. Please log in again.' }, { status: 401 })
    }

    const serviceClient = createServiceRoleClient()

    // 1. Update password AND set metadata flag using admin API (bypasses RLS)
    const { error: pwError } = await serviceClient.auth.admin.updateUserById(user.id, {
      password: newPassword,
      user_metadata: { password_changed: true },
    })

    if (pwError) {
      console.error('Password update error:', pwError.message)
      return NextResponse.json({ success: false, error: pwError.message }, { status: 500 })
    }

    // 2. Clear the must_reset_password flag in DB (service role bypasses RLS)
    const { error: dbError } = await serviceClient
      .from('user_profiles')
      .update({ must_reset_password: false })
      .eq('id', user.id)

    if (dbError) {
      console.error('DB flag clear error:', dbError.message)
      // Non-fatal — the metadata flag is set so middleware will let them through
    }

    // 3. Get user role for redirect
    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    return NextResponse.json({ success: true, role: profile?.role || 'agent' })
  } catch (err: any) {
    console.error('Change password API error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
