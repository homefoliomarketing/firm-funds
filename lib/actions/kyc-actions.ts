'use server'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { MAX_KYC_UPLOAD_SIZE_BYTES, ALLOWED_KYC_MIME_TYPES } from '@/lib/constants'
import { sendKycMobileUploadLink } from '@/lib/email'
import { randomBytes } from 'crypto'

// ============================================================================
// Types
// ============================================================================

interface ActionResult {
  success: boolean
  error?: string
  data?: Record<string, any>
}

// ============================================================================
// Helper: get authenticated admin user
// ============================================================================

async function getAuthenticatedAdmin() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: 'Not authenticated', user: null, profile: null, supabase }
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return { error: 'User profile not found', user, profile: null, supabase }
  }

  if (!['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

  return { error: null, user, profile, supabase }
}

// ============================================================================
// Brokerage KYC: Verify brokerage on RECO registry
// ============================================================================

export async function verifyBrokerageKyc(input: {
  brokerageId: string
  recoRegistrationNumber: string
  verificationNotes: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (!input.brokerageId) return { success: false, error: 'Brokerage ID is required' }
    if (!input.recoRegistrationNumber.trim()) return { success: false, error: 'RECO registration number is required' }

    const now = new Date().toISOString()
    const today = now.split('T')[0] // YYYY-MM-DD

    const { data: brokerage, error: updateError } = await supabase
      .from('brokerages')
      .update({
        kyc_verified: true,
        kyc_verified_at: now,
        kyc_verified_by: profile.full_name || user.email || 'Admin',
        reco_registration_number: input.recoRegistrationNumber.trim(),
        reco_verification_date: today,
        reco_verification_notes: input.verificationNotes.trim() || null,
      })
      .eq('id', input.brokerageId)
      .select()
      .single()

    if (updateError) {
      console.error('Brokerage KYC verify error:', updateError.message)
      return { success: false, error: `Failed to verify brokerage: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'brokerage.kyc_verify',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: {
        reco_number: input.recoRegistrationNumber,
        verified_by: profile.full_name || user.email,
      },
    })

    return { success: true, data: brokerage }
  } catch (err: any) {
    console.error('Brokerage KYC verify error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function revokeBrokerageKyc(input: {
  brokerageId: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: brokerage, error: updateError } = await supabase
      .from('brokerages')
      .update({
        kyc_verified: false,
        kyc_verified_at: null,
        kyc_verified_by: null,
        reco_registration_number: null,
        reco_verification_date: null,
        reco_verification_notes: null,
      })
      .eq('id', input.brokerageId)
      .select()
      .single()

    if (updateError) {
      console.error('Brokerage KYC revoke error:', updateError.message)
      return { success: false, error: `Failed to revoke KYC: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'brokerage.kyc_revoke',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: { revoked_by: profile.full_name || user.email },
    })

    return { success: true, data: brokerage }
  } catch (err: any) {
    console.error('Brokerage KYC revoke error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Agent KYC: Upload government photo ID
// ============================================================================

export async function submitAgentKyc(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) return { success: false, error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('agent_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'agent' || !profile.agent_id) {
    return { success: false, error: 'Not authorized as an agent' }
  }

  try {
    const file = formData.get('file') as File | null
    const documentType = formData.get('documentType') as string | null

    if (!file) return { success: false, error: 'No file provided' }
    if (!documentType) return { success: false, error: 'Document type is required' }

    // Validate file size
    if (file.size > MAX_KYC_UPLOAD_SIZE_BYTES) {
      return { success: false, error: 'File size exceeds 10MB limit' }
    }

    // Validate MIME type
    if (!(ALLOWED_KYC_MIME_TYPES as readonly string[]).includes(file.type)) {
      return { success: false, error: 'Invalid file type. Please upload a JPEG, PNG, or PDF file.' }
    }

    // Use service role client for storage operations (bypasses RLS)
    const serviceClient = createServiceRoleClient()

    // Upload to agent-kyc bucket
    const fileExt = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const filePath = `${profile.agent_id}/id-${Date.now()}.${fileExt}`

    const { error: uploadError } = await serviceClient.storage
      .from('agent-kyc')
      .upload(filePath, file, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      console.error('KYC upload error:', uploadError.message)
      return { success: false, error: `Upload failed: ${uploadError.message}` }
    }

    // Update agent record with KYC info
    const now = new Date().toISOString()
    const { data: agent, error: updateError } = await serviceClient
      .from('agents')
      .update({
        kyc_status: 'submitted',
        kyc_submitted_at: now,
        kyc_document_path: filePath,
        kyc_document_type: documentType,
        kyc_rejection_reason: null, // Clear any previous rejection
      })
      .eq('id', profile.agent_id)
      .select()
      .single()

    if (updateError) {
      console.error('Agent KYC update error:', updateError.message)
      return { success: false, error: `Failed to update KYC status: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'agent.kyc_submit',
      entityType: 'agent',
      entityId: profile.agent_id,
      metadata: { document_type: documentType, file_path: filePath },
    })

    return { success: true, data: agent }
  } catch (err: any) {
    console.error('Agent KYC submit error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Agent KYC: Admin verify or reject
// ============================================================================

export async function verifyAgentKyc(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Fetch current agent to confirm they're in 'submitted' status
    const { data: agent } = await supabase
      .from('agents')
      .select('id, kyc_status, first_name, last_name, email')
      .eq('id', input.agentId)
      .single()

    if (!agent) return { success: false, error: 'Agent not found' }
    if (agent.kyc_status !== 'submitted') {
      return { success: false, error: `Cannot verify agent in "${agent.kyc_status}" status. Agent must submit ID first.` }
    }

    const now = new Date().toISOString()

    // Use service role to bypass RLS
    const serviceClient = createServiceRoleClient()

    // Fetch the agent's full record (need kyc_document_path for auto-attaching)
    const { data: fullAgent } = await serviceClient
      .from('agents')
      .select('kyc_document_path, kyc_document_type')
      .eq('id', input.agentId)
      .single()

    const { data: updatedAgent, error: updateError } = await serviceClient
      .from('agents')
      .update({
        kyc_status: 'verified',
        kyc_verified_at: now,
        kyc_verified_by: profile.full_name || user.email || 'Admin',
        kyc_rejection_reason: null,
      })
      .eq('id', input.agentId)
      .select()
      .single()

    if (updateError) {
      console.error('Agent KYC verify error:', updateError.message)
      return { success: false, error: `Failed to verify agent: ${updateError.message}` }
    }

    // ---------------------------------------------------------------
    // Auto-check KYC checklist item on all of this agent's deals
    // ---------------------------------------------------------------
    try {
      // Find all deals for this agent
      const { data: agentDeals } = await serviceClient
        .from('deals')
        .select('id')
        .eq('agent_id', input.agentId)

      if (agentDeals && agentDeals.length > 0) {
        const dealIds = agentDeals.map(d => d.id)

        // Check off "Agent ID & KYC/FINTRAC verification" in underwriting_checklist
        await serviceClient
          .from('underwriting_checklist')
          .update({
            is_checked: true,
            checked_by: profile.full_name || user.email || 'Admin (auto)',
            checked_at: now,
            notes: 'Auto-checked: Agent KYC verified',
          })
          .in('deal_id', dealIds)
          .eq('checklist_item', 'Agent ID & KYC/FINTRAC verification')

        // Auto-attach the agent's KYC document to each deal as a kyc_fintrac document
        if (fullAgent?.kyc_document_path) {
          for (const deal of agentDeals) {
            // Check if a kyc_fintrac doc already exists for this deal
            const { data: existingDoc } = await serviceClient
              .from('deal_documents')
              .select('id')
              .eq('deal_id', deal.id)
              .eq('document_type', 'kyc_fintrac')
              .limit(1)
              .single()

            if (!existingDoc) {
              const ext = fullAgent.kyc_document_path.split('.').pop() || 'jpg'
              const fileName = `agent-kyc-id.${ext}`

              await serviceClient
                .from('deal_documents')
                .insert({
                  deal_id: deal.id,
                  uploaded_by: user.id,
                  document_type: 'kyc_fintrac',
                  file_name: fileName,
                  file_path: `agent-kyc/${fullAgent.kyc_document_path}`,
                  file_size: 0, // Size unknown from storage reference
                  upload_source: 'manual_upload',
                  notes: `Auto-attached: Agent KYC ${fullAgent.kyc_document_type || 'ID'} verified by ${profile.full_name || user.email}`,
                })
            }
          }
        }
      }
    } catch (autoCheckErr: any) {
      // Non-fatal — log but don't fail the KYC verification
      console.error('Auto-check KYC checklist error (non-fatal):', autoCheckErr?.message)
    }

    await logAuditEvent({
      action: 'agent.kyc_verify',
      entityType: 'agent',
      entityId: input.agentId,
      metadata: {
        agent_name: `${agent.first_name} ${agent.last_name}`,
        verified_by: profile.full_name || user.email,
        auto_checked_deals: 'yes',
      },
    })

    return { success: true, data: updatedAgent }
  } catch (err: any) {
    console.error('Agent KYC verify error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function rejectAgentKyc(input: {
  agentId: string
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (!input.reason.trim()) return { success: false, error: 'Rejection reason is required' }

    const { data: agent } = await supabase
      .from('agents')
      .select('id, kyc_status, first_name, last_name')
      .eq('id', input.agentId)
      .single()

    if (!agent) return { success: false, error: 'Agent not found' }
    if (agent.kyc_status !== 'submitted') {
      return { success: false, error: `Cannot reject agent in "${agent.kyc_status}" status.` }
    }

    // Use service role to bypass RLS
    const serviceClient = createServiceRoleClient()

    const { data: updatedAgent, error: updateError } = await serviceClient
      .from('agents')
      .update({
        kyc_status: 'rejected',
        kyc_rejection_reason: input.reason.trim(),
        // Keep the document path so admin can still view it
      })
      .eq('id', input.agentId)
      .select()
      .single()

    if (updateError) {
      console.error('Agent KYC reject error:', updateError.message)
      return { success: false, error: `Failed to reject agent KYC: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'agent.kyc_reject',
      entityType: 'agent',
      entityId: input.agentId,
      metadata: {
        agent_name: `${agent.first_name} ${agent.last_name}`,
        rejected_by: profile.full_name || user.email,
        reason: input.reason,
      },
    })

    return { success: true, data: updatedAgent }
  } catch (err: any) {
    console.error('Agent KYC reject error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Agent KYC: Get signed URL for admin to view the uploaded ID
// ============================================================================

export async function getAgentKycDocumentUrl(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: agent } = await supabase
      .from('agents')
      .select('kyc_document_path')
      .eq('id', input.agentId)
      .single()

    if (!agent?.kyc_document_path) {
      return { success: false, error: 'No KYC document found for this agent' }
    }

    const serviceClient = createServiceRoleClient()

    const { data: urlData, error: urlError } = await serviceClient.storage
      .from('agent-kyc')
      .createSignedUrl(agent.kyc_document_path, 300) // 5-minute signed URL

    if (urlError || !urlData?.signedUrl) {
      console.error('KYC signed URL error:', urlError?.message)
      return { success: false, error: 'Failed to generate document URL' }
    }

    return { success: true, data: { url: urlData.signedUrl } }
  } catch (err: any) {
    console.error('KYC document URL error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Agent KYC: Send mobile upload link (agent sends to their own email)
// ============================================================================

const KYC_TOKEN_EXPIRY_MINUTES = 30

export async function sendKycMobileLink(): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) return { success: false, error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('agent_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'agent' || !profile.agent_id) {
    return { success: false, error: 'Not authorized as an agent' }
  }

  try {
    const serviceClient = createServiceRoleClient()

    // Fetch agent details for the email
    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, first_name, email, kyc_status')
      .eq('id', profile.agent_id)
      .single()

    if (!agent) return { success: false, error: 'Agent not found' }
    if (agent.kyc_status === 'verified') {
      return { success: false, error: 'Your identity has already been verified.' }
    }

    // Generate a secure one-time token
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + KYC_TOKEN_EXPIRY_MINUTES * 60 * 1000).toISOString()

    // Invalidate any previous unused tokens for this agent
    await serviceClient
      .from('kyc_upload_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('agent_id', agent.id)
      .is('used_at', null)

    // Insert new token
    const { error: insertError } = await serviceClient
      .from('kyc_upload_tokens')
      .insert({
        agent_id: agent.id,
        token,
        expires_at: expiresAt,
      })

    if (insertError) {
      console.error('KYC token insert error:', insertError.message)
      return { success: false, error: 'Failed to generate upload link' }
    }

    // Build upload URL and send email
    const appUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'
    const uploadUrl = `${appUrl}/kyc-upload/${token}`

    await sendKycMobileUploadLink({
      agentEmail: agent.email,
      agentFirstName: agent.first_name,
      uploadUrl,
      expiresInMinutes: KYC_TOKEN_EXPIRY_MINUTES,
    })

    await logAuditEvent({
      action: 'agent.kyc_mobile_link_sent',
      entityType: 'agent',
      entityId: agent.id,
      metadata: { email: agent.email },
    })

    return { success: true, data: { email: agent.email } }
  } catch (err: any) {
    console.error('Send KYC mobile link error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Agent KYC: Validate token and upload via mobile (PUBLIC — no auth required)
// ============================================================================

export async function submitKycViaMobileToken(input: {
  token: string
  formData: FormData
}): Promise<ActionResult> {
  try {
    const serviceClient = createServiceRoleClient()

    // Look up the token
    const { data: tokenRecord, error: tokenError } = await serviceClient
      .from('kyc_upload_tokens')
      .select('id, agent_id, expires_at, used_at')
      .eq('token', input.token)
      .single()

    if (tokenError || !tokenRecord) {
      return { success: false, error: 'Invalid or expired link. Please request a new one from your desktop.' }
    }

    // Check if already used
    if (tokenRecord.used_at) {
      return { success: false, error: 'This link has already been used. Please request a new one from your desktop.' }
    }

    // Check expiry
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return { success: false, error: 'This link has expired. Please request a new one from your desktop.' }
    }

    // Validate file
    const file = input.formData.get('file') as File | null
    const documentType = input.formData.get('documentType') as string | null

    if (!file) return { success: false, error: 'No file provided' }
    if (!documentType) return { success: false, error: 'Document type is required' }

    if (file.size > MAX_KYC_UPLOAD_SIZE_BYTES) {
      return { success: false, error: 'File size exceeds 10MB limit' }
    }

    if (!(ALLOWED_KYC_MIME_TYPES as readonly string[]).includes(file.type)) {
      return { success: false, error: 'Invalid file type. Please upload a JPEG, PNG, or PDF.' }
    }

    // Upload to agent-kyc bucket
    const fileExt = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const filePath = `${tokenRecord.agent_id}/id-${Date.now()}.${fileExt}`

    const { error: uploadError } = await serviceClient.storage
      .from('agent-kyc')
      .upload(filePath, file, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      console.error('KYC mobile upload error:', uploadError.message)
      return { success: false, error: `Upload failed: ${uploadError.message}` }
    }

    // Update agent record with KYC info
    const now = new Date().toISOString()
    const { error: updateError } = await serviceClient
      .from('agents')
      .update({
        kyc_status: 'submitted',
        kyc_submitted_at: now,
        kyc_document_path: filePath,
        kyc_document_type: documentType,
        kyc_rejection_reason: null,
      })
      .eq('id', tokenRecord.agent_id)

    if (updateError) {
      console.error('Agent KYC update error (mobile):', updateError.message)
      return { success: false, error: 'Failed to update your verification status' }
    }

    // Mark token as used
    await serviceClient
      .from('kyc_upload_tokens')
      .update({ used_at: now })
      .eq('id', tokenRecord.id)

    await logAuditEvent({
      action: 'agent.kyc_submit_mobile',
      entityType: 'agent',
      entityId: tokenRecord.agent_id,
      metadata: { document_type: documentType, file_path: filePath },
    })

    return { success: true }
  } catch (err: any) {
    console.error('KYC mobile upload error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Agent KYC: Validate a mobile upload token (for the page to check status)
// ============================================================================

export async function validateKycToken(token: string): Promise<ActionResult> {
  try {
    const serviceClient = createServiceRoleClient()

    const { data: tokenRecord, error } = await serviceClient
      .from('kyc_upload_tokens')
      .select('id, agent_id, expires_at, used_at')
      .eq('token', token)
      .single()

    if (error || !tokenRecord) {
      return { success: false, error: 'invalid' }
    }

    if (tokenRecord.used_at) {
      return { success: false, error: 'used' }
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return { success: false, error: 'expired' }
    }

    // Fetch agent name for the UI
    const { data: agent } = await serviceClient
      .from('agents')
      .select('first_name, last_name')
      .eq('id', tokenRecord.agent_id)
      .single()

    return {
      success: true,
      data: {
        agentName: agent ? `${agent.first_name} ${agent.last_name}` : 'Agent',
      },
    }
  } catch (err: any) {
    console.error('Validate KYC token error:', err?.message)
    return { success: false, error: 'invalid' }
  }
}
