import { NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'

export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false }, { status: 401 })

    const serviceClient = createServiceRoleClient()

    // Clear the DB flag (service role bypasses RLS)
    await serviceClient
      .from('user_profiles')
      .update({ must_reset_password: false })
      .eq('id', user.id)

    // Also set the metadata flag via admin API as a belt-and-suspenders measure
    await serviceClient.auth.admin.updateUserById(user.id, {
      user_metadata: { password_changed: true },
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ success: false }, { status: 500 })
  }
}
