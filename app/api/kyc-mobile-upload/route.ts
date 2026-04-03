import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { MAX_KYC_UPLOAD_SIZE_BYTES, ALLOWED_KYC_MIME_TYPES } from '@/lib/constants'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const serviceClient = createServiceRoleClient()

    const token = formData.get('token') as string | null
    if (!token) return NextResponse.json({ success: false, error: 'Missing token' }, { status: 400 })

    // Look up the token
    const { data: tokenRecord, error: tokenError } = await serviceClient
      .from('kyc_upload_tokens')
      .select('id, agent_id, expires_at, used_at')
      .eq('token', token)
      .single()

    if (tokenError || !tokenRecord) {
      return NextResponse.json({ success: false, error: 'Invalid or expired link. Please request a new one from your desktop.' })
    }

    // Check if already used
    if (tokenRecord.used_at) {
      return NextResponse.json({ success: false, error: 'This link has already been used. Please request a new one from your desktop.' })
    }

    // Check expiry
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return NextResponse.json({ success: false, error: 'This link has expired. Please request a new one from your desktop.' })
    }

    // Validate files
    const files = formData.getAll('files') as File[]
    const documentType = formData.get('documentType') as string | null

    if (!files || files.length === 0) return NextResponse.json({ success: false, error: 'No files provided' })
    if (!documentType) return NextResponse.json({ success: false, error: 'Document type is required' })

    for (const file of files) {
      if (file.size > MAX_KYC_UPLOAD_SIZE_BYTES) {
        return NextResponse.json({ success: false, error: `File "${file.name}" exceeds 10MB limit` })
      }
      if (!(ALLOWED_KYC_MIME_TYPES as readonly string[]).includes(file.type)) {
        return NextResponse.json({ success: false, error: `File "${file.name}" is not a valid type. Please upload JPEG, PNG, or PDF.` })
      }
    }

    // Upload each file to agent-kyc bucket
    const timestamp = Date.now()
    const filePaths: string[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const fileExt = file.name.split('.').pop()?.toLowerCase() || 'jpg'
      const filePath = `${tokenRecord.agent_id}/id-${timestamp}-${i}.${fileExt}`

      const { error: uploadError } = await serviceClient.storage
        .from('agent-kyc')
        .upload(filePath, file, {
          contentType: file.type,
          upsert: false,
        })

      if (uploadError) {
        console.error('KYC mobile upload error:', uploadError.message)
        return NextResponse.json({ success: false, error: `Upload failed for file ${i + 1}: ${uploadError.message}` })
      }
      filePaths.push(filePath)
    }

    // Update agent record with KYC info
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
      .eq('id', tokenRecord.agent_id)

    if (updateError) {
      console.error('Agent KYC update error (mobile):', updateError.message)
      return NextResponse.json({ success: false, error: 'Failed to update your verification status' })
    }

    // Mark token as used
    await serviceClient
      .from('kyc_upload_tokens')
      .update({ used_at: now })
      .eq('id', tokenRecord.id)

    // Audit log (best effort, non-blocking)
    void serviceClient.from('audit_log').insert({
      user_id: null,
      action: 'agent.kyc_submit_mobile',
      entity_type: 'agent',
      entity_id: tokenRecord.agent_id,
      metadata: { document_type: documentType, file_paths: filePaths },
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('KYC mobile upload error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred' })
  }
}
