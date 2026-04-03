'use server'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { MAX_KYC_UPLOAD_SIZE_BYTES, ALLOWED_KYC_MIME_TYPES } from '@/lib/constants'

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

    await logAuditEvent({
      action: 'agent.kyc_verify',
      entityType: 'agent',
      entityId: input.agentId,
      metadata: {
        agent_name: `${agent.first_name} ${agent.last_name}`,
        verified_by: profile.full_name || user.email,
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
