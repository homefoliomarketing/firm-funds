import { NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { checkApiRateLimit } from '@/lib/rate-limit'

// ============================================================================
// Desktop KYC Upload — Signed URL Pattern
// ============================================================================
// Same pattern as kyc-mobile-upload but for authenticated desktop users.
// POST: Get signed upload URLs (agent must be authenticated)
// PUT: Finalize upload (update agent record in DB)
// ============================================================================

// Step 1: Generate signed upload URLs for the authenticated agent
export async function POST(request: Request) {
  try {
    // Rate limit
    const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
    const rl = await checkApiRateLimit(ip)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })
    }

    // Auth: must be a logged-in agent
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

    const { fileNames, documentType } = await request.json()

    if (!fileNames?.length || !documentType) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    const serviceClient = createServiceRoleClient()
    const timestamp = Date.now()
    const uploadUrls: { signedUrl: string; token: string; path: string }[] = []

    for (let i = 0; i < fileNames.length; i++) {
      const fileExt = fileNames[i].split('.').pop()?.toLowerCase() || 'jpg'
      const filePath = `${profile.agent_id}/id-${timestamp}-${i}.${fileExt}`

      const { data, error } = await serviceClient.storage
        .from('agent-kyc')
        .createSignedUploadUrl(filePath)

      if (error || !data) {
        console.error('Signed upload URL error:', error?.message)
        return NextResponse.json({ success: false, error: 'Failed to prepare upload.' })
      }

      uploadUrls.push({ signedUrl: data.signedUrl, token: data.token, path: filePath })
    }

    return NextResponse.json({
      success: true,
      data: { uploadUrls, agentId: profile.agent_id },
    })
  } catch (err: any) {
    console.error('Desktop KYC upload URL error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}

// Step 3: After client uploads files directly to Supabase, update the DB records
export async function PUT(request: Request) {
  try {
    // Auth: must be a logged-in agent
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

    const { filePaths, documentType } = await request.json()

    if (!filePaths?.length || !documentType) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    const serviceClient = createServiceRoleClient()

    // Update agent record — server-derived agentId from auth, not from client
    const now = new Date().toISOString()
    const { error: updateError } = await serviceClient
      .from('agents')
      .update({
        kyc_status: 'submitted',
        kyc_submitted_at: now,
        kyc_document_path: JSON.stringify(filePaths),
        kyc_document_type: documentType,
        kyc_rejection_reason: null,
      })
      .eq('id', profile.agent_id)

    if (updateError) {
      console.error('Agent KYC update error:', updateError.message)
      return NextResponse.json({ success: false, error: 'Failed to update verification status.' })
    }

    // Audit log (fire and forget)
    void serviceClient.from('audit_log').insert({
      user_id: user.id,
      action: 'agent.kyc_submit_desktop',
      entity_type: 'agent',
      entity_id: profile.agent_id,
      severity: 'info',
      actor_email: user.email,
      actor_role: 'agent',
      metadata: { document_type: documentType, file_paths: filePaths },
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('Desktop KYC finalize error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}
