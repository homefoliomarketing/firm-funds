import { NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  try {
    const { documentId, filePath, dealId } = await request.json()

    if (!filePath || !dealId) {
      return NextResponse.json({ success: false, error: 'Missing required fields.' }, { status: 400 })
    }

    // Authenticate — must be logged in with an appropriate role
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 })
    }

    // Verify the user has a valid role
    const serviceClient = createServiceRoleClient()
    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!profile || !['super_admin', 'firm_funds_admin', 'agent', 'brokerage_admin'].includes(profile.role)) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 403 })
    }

    // Generate signed URL using service role client (bypasses storage RLS)
    const { data, error } = await serviceClient.storage
      .from('deal-documents')
      .createSignedUrl(filePath, 3600, { download: false })

    if (error) {
      console.error('Signed URL error:', error.message)
      return NextResponse.json({ success: false, error: 'Failed to generate download link.' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: { signedUrl: data.signedUrl } })
  } catch (err: any) {
    console.error('Document signed URL API error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
