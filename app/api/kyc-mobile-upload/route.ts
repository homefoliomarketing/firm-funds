import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { checkApiRateLimit } from '@/lib/rate-limit'

// Step 1: Generate signed upload URLs so the client can upload directly to Supabase
// (No files touch Netlify — just a tiny JSON request/response)
export async function POST(request: Request) {
  try {
    // Rate limit check
    const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
    const rl = await checkApiRateLimit(ip)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })
    }

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
    // Rate limit (Finding 3): PUT was unprotected; an attacker holding any
    // leaked token (even expired/used) could spam this endpoint.
    const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
    const rl = await checkApiRateLimit(ip)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })
    }

    const { token, filePaths, documentType } = await request.json()

    if (!token || !filePaths?.length || !documentType) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    if (!Array.isArray(filePaths)) {
      return NextResponse.json({ success: false, error: 'filePaths must be an array' }, { status: 400 })
    }

    const serviceClient = createServiceRoleClient()

    // First, fetch the token row so we can validate the requested filePaths
    // against this token's agent_id BEFORE we burn the single-use claim. If we
    // claimed first and then rejected on path mismatch, an attacker who knew a
    // valid token could trivially burn it from afar.
    const { data: tokenRecord, error: tokenError } = await serviceClient
      .from('kyc_upload_tokens')
      .select('id, agent_id')
      .eq('token', token)
      .single()

    if (tokenError || !tokenRecord) {
      return NextResponse.json({ success: false, error: 'Invalid token.' })
    }

    // Server-derived agentId — not from client request body
    const agentId = tokenRecord.agent_id

    // Validate every filePath starts with this token's agent folder. Prevents
    // an attacker who controls the request body from pointing the KYC record
    // at another agent's storage path (Finding 3 part c).
    const expectedPrefix = `${agentId}/`
    for (const p of filePaths) {
      if (typeof p !== 'string' || !p.startsWith(expectedPrefix)) {
        return NextResponse.json({
          success: false,
          error: 'File paths must belong to this token\'s agent.',
        }, { status: 400 })
      }
    }

    // Atomic claim — only one parallel request will succeed. Previously this
    // route fetched the row, checked used_at/expires_at in JS, then UPDATE'd
    // at the end. Two concurrent requests could both pass the in-memory check
    // and both finalize the upload (TOCTOU). Combining the read+write into a
    // single conditional UPDATE closes the window: Postgres serializes the
    // matching rows so at most one client receives a row back. The .gt() on
    // expires_at also collapses the expiry check into the same statement.
    const now = new Date().toISOString()
    const { data: claimedToken, error: claimErr } = await serviceClient
      .from('kyc_upload_tokens')
      .update({ used_at: now })
      .eq('id', tokenRecord.id)
      .is('used_at', null)
      .gt('expires_at', now)
      .select('id, agent_id')
      .maybeSingle()

    if (claimErr || !claimedToken) {
      return NextResponse.json(
        { success: false, error: 'Token already used or expired' },
        { status: 400 }
      )
    }

    // Update agent record. Note: if this UPDATE fails after the token claim
    // succeeded, the token stays burned. That is the safe direction — the
    // agent can request a fresh KYC link rather than risk a reusable token
    // floating in the wild.
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

    // Audit log (fire and forget). Even though user_id is null (this route is
    // unauthenticated by design), the kyc_token_id + token short prefix let
    // forensics correlate the action back to the token that authorized it
    // when reviewing audit_log later.
    void serviceClient.from('audit_log').insert({
      user_id: null,
      action: 'agent.kyc_submit_mobile',
      entity_type: 'agent',
      entity_id: agentId,
      metadata: {
        document_type: documentType,
        file_paths: filePaths,
        kyc_token_id: tokenRecord.id,
        // Only log the prefix; the full token must never appear in audit_log.
        kyc_token_prefix: typeof token === 'string' ? token.slice(0, 8) : null,
        actor_kind: 'kyc_mobile_token',
      },
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('KYC finalize error:', err?.message)
    return NextResponse.json({ success: false, error: 'An unexpected error occurred.' })
  }
}
