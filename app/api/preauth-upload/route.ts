import { NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { checkApiRateLimit } from '@/lib/rate-limit'

// ============================================================================
// Preauthorized Debit Form Upload — Signed URL Pattern
// ============================================================================
// POST: Get signed upload URL (agent must be authenticated)
// PUT: Finalize upload (update agent record in DB)
// ============================================================================

export async function POST(request: Request) {
  try {
    const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
    const rl = await checkApiRateLimit(ip)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })
    }

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('agent_id, role')
      .eq('id', user.id)
      .single()

    if (!profile || profile.role !== 'agent' || !profile.agent_id) {
      return NextResponse.json({ success: false, error: 'Not authorized' }, { status: 403 })
    }

    const { fileName } = await request.json()

    if (!fileName) {
      return NextResponse.json({ success: false, error: 'Missing file name' }, { status: 400 })
    }

    const serviceClient = createServiceRoleClient()
    const timestamp = Date.now()
    const fileExt = fileName.split('.').pop()?.toLowerCase() || 'pdf'
    const filePath = `${profile.agent_id}/preauth-${timestamp}.${fileExt}`

    const { data, error } = await serviceClient.storage
      .from('agent-preauth-forms')
      .createSignedUploadUrl(filePath)

    if (error || !data) {
      console.error('Preauth signed upload URL error:', error?.message)
      return NextResponse.json({ success: false, error: 'Failed to prepare upload.' })
    }

    return NextResponse.json({
      success: true,
      data: { signedUrl: data.signedUrl, token: data.token, path: filePath, agentId: profile.agent_id },
    })
  } catch (err: any) {
    console.error('Preauth upload URL error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('agent_id, role')
      .eq('id', user.id)
      .single()

    if (!profile || profile.role !== 'agent' || !profile.agent_id) {
      return NextResponse.json({ success: false, error: 'Not authorized' }, { status: 403 })
    }

    const { filePath } = await request.json()

    if (!filePath) {
      return NextResponse.json({ success: false, error: 'Missing file path' }, { status: 400 })
    }

    const serviceClient = createServiceRoleClient()
    const now = new Date().toISOString()

    const { error: updateError } = await serviceClient
      .from('agents')
      .update({
        preauth_form_path: filePath,
        preauth_form_uploaded_at: now,
      })
      .eq('id', profile.agent_id)

    if (updateError) {
      console.error('Agent preauth update error:', updateError.message)
      return NextResponse.json({ success: false, error: 'Failed to update record.' })
    }

    void serviceClient.from('audit_log').insert({
      user_id: user.id,
      action: 'agent.preauth_form_upload',
      entity_type: 'agent',
      entity_id: profile.agent_id,
      severity: 'info',
      actor_email: user.email,
      actor_role: 'agent',
      metadata: { file_path: filePath },
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('Preauth finalize error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}
