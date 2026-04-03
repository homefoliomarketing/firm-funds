import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/server'

// Step 1: Generate signed upload URLs so the client can upload directly to Supabase
// (No files touch Netlify — just a tiny JSON request/response)
export async function POST(request: Request) {
  try {
    const { token, fileNames, documentType } = await request.json()

    if (!token || !fileNames?.length || !documentType) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    const serviceClient = createServiceRoleClient()

    // Validate the token
    const { data: tokenRecord, error: tokenError } = await serviceClient
      .from('kyc_upload_tokens')
      .select('id, agent_id, expires_at, used_at')
      .eq('token', token)
      .single()

    if (tokenError || !tokenRecord) {
      return NextResponse.json({ success: false, error: 'Invalid or expired link.' })
    }
    if (tokenRecord.used_at) {
      return NextResponse.json({ success: false, error: 'This link has already been used.' })
    }
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return NextResponse.json({ success: false, error: 'This link has expired.' })
    }

    // Generate signed upload URLs for each file
    const timestamp = Date.now()
    const uploadUrls: { signedUrl: string; token: string; path: string }[] = []

    for (let i = 0; i < fileNames.length; i++) {
      const fileExt = fileNames[i].split('.').pop()?.toLowerCase() || 'jpg'
      const filePath = `${tokenRecord.agent_id}/id-${timestamp}-${i}.${fileExt}`

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
      data: {
        uploadUrls,
        agentId: tokenRecord.agent_id,
        tokenRecordId: tokenRecord.id,
      },
    })
  } catch (err: any) {
    console.error('KYC upload URL generation error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}

// Step 3: After client uploads files directly to Supabase, update the DB records
export async function PUT(request: Request) {
  try {
    const { token, filePaths, documentType, tokenRecordId, agentId } = await request.json()

    if (!token || !filePaths?.length || !documentType || !agentId) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    const serviceClient = createServiceRoleClient()

    // Re-validate the token (security: don't trust client-provided agentId alone)
    const { data: tokenRecord, error: tokenError } = await serviceClient
      .from('kyc_upload_tokens')
      .select('id, agent_id')
      .eq('token', token)
      .single()

    if (tokenError || !tokenRecord || tokenRecord.agent_id !== agentId) {
      return NextResponse.json({ success: false, error: 'Invalid token.' })
    }

    // Update agent record
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
      .eq('id', agentId)

    if (updateError) {
      console.error('Agent KYC update error:', updateError.message)
      return NextResponse.json({ success: false, error: 'Failed to update verification status.' })
    }

    // Mark token as used
    await serviceClient
      .from('kyc_upload_tokens')
      .update({ used_at: now })
      .eq('id', tokenRecord.id)

    // Audit log (fire and forget)
    void serviceClient.from('audit_log').insert({
      user_id: null,
      action: 'agent.kyc_submit_mobile',
      entity_type: 'agent',
      entity_id: agentId,
      metadata: { document_type: documentType, file_paths: filePaths },
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('KYC finalize error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}
