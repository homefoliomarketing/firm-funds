import { NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { validateOrigin } from '@/lib/csrf'
import { checkApiRateLimit } from '@/lib/rate-limit'

export async function POST(request: Request) {
  // CSRF protection: validate request origin
  const originError = validateOrigin(request)
  if (originError) return originError

  // Rate limit check
  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
  const rl = await checkApiRateLimit(ip)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

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

    // Audit log: record password change event (M1 security fix)
    await serviceClient.from('audit_log').insert({
      user_id: user.id,
      action: 'user.password_changed',
      entity_type: 'user',
      entity_id: user.id,
      metadata: { email: user.email },
    })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ success: false }, { status: 500 })
  }
}
