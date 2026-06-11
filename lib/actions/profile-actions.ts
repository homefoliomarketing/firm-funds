'use server'

import { createServiceRoleClient, createClient } from '@/lib/supabase/server'
import { hasCapability } from '@/lib/access'
import crypto from 'crypto'
import {
  sendBankingSubmittedNotification,
  sendBankingApprovalNotification,
  sendBrokerageInviteNotification,
  sendKycApprovedNotification,
  sendAgentPhoneChangedNotification,
} from '@/lib/email'
import { logAuditEventServiceRole } from '@/lib/audit'
import { normalizeE164, PHONE_VALIDATION_MESSAGE } from '@/lib/phone'
import { fireQueuedFirmDealOffersForAgent } from '@/lib/firm-deal-detection/offer-acceptance'

// ============================================================================
// Agent Profile Actions
// ============================================================================

export async function updateAgentProfile(data: {
  agentId: string
  phone?: string | null
  addressStreet?: string | null
  addressCity?: string | null
  addressProvince?: string | null
  addressPostalCode?: string | null
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Verify the user owns this agent profile
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('agent_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'agent' || profile.agent_id !== data.agentId) {
    return { success: false, error: 'Not authorized' }
  }

  const serviceClient = createServiceRoleClient()

  // Finding #43: validate phone format (Canadian E.164) before persisting.
  // SMS OTP on change was discussed and deferred: phone is not an auth factor
  // anywhere in this app (no SMS recovery, no SMS OTP, no SMS notifications),
  // so paying for Twilio would defend against an attack we are not exposed
  // to. The cheap mitigation (audit-log + notify the agent's verified email)
  // is below; revisit if SMS-based recovery is ever added.
  let phoneChanged = false
  let priorPhone: string | null = null
  let newPhone: string | null = null
  let normalizedPhone: string | null = null
  let oldPhoneLast4: string | null = null
  let newPhoneLast4: string | null = null

  // Read prior phone regardless of whether the new value is set/cleared, so a
  // change-to-empty (clear the phone) is also detected and audited. Accept any
  // human format ((416) 555-1234, 416-555-1234, 4165551234, ...) and store the
  // canonical E.164 (+1XXXXXXXXXX) so the SMS path and display agree.
  if (data.phone !== undefined) {
    if (data.phone !== null && data.phone !== '') {
      normalizedPhone = normalizeE164(data.phone)
      if (!normalizedPhone) {
        return { success: false, error: PHONE_VALIDATION_MESSAGE }
      }
    }
    const { data: existing } = await serviceClient
      .from('agents')
      .select('phone')
      .eq('id', data.agentId)
      .single()
    priorPhone = existing?.phone ?? null
    newPhone = normalizedPhone
    if (priorPhone !== newPhone) {
      phoneChanged = true
      oldPhoneLast4 = priorPhone ? priorPhone.slice(-4) : null
      newPhoneLast4 = newPhone ? newPhone.slice(-4) : null
    }
  }

  // Only update fields that are explicitly provided (not undefined)
  const updates: Record<string, string | null> = {}
  if (data.phone !== undefined) updates.phone = normalizedPhone
  if (data.addressStreet !== undefined) updates.address_street = data.addressStreet || null
  if (data.addressCity !== undefined) updates.address_city = data.addressCity || null
  if (data.addressProvince !== undefined) updates.address_province = data.addressProvince || null
  if (data.addressPostalCode !== undefined) updates.address_postal_code = data.addressPostalCode || null

  const { error } = await serviceClient
    .from('agents')
    .update(updates)
    .eq('id', data.agentId)

  if (error) {
    console.error('Profile update error:', error.message)
    return { success: false, error: 'Failed to update profile' }
  }

  if (phoneChanged) {
    const changedAt = new Date().toISOString()

    await logAuditEventServiceRole({
      userId: user.id,
      action: 'agent.update_phone',
      entityType: 'agent',
      entityId: data.agentId,
      severity: 'warning',
      actorEmail: user.email ?? undefined,
      actorRole: 'agent',
      metadata: { old_phone_last4: oldPhoneLast4, new_phone_last4: newPhoneLast4 },
    })

    // Notify the agent's verified Firm Funds email so silent tampering by a
    // stolen-session attacker is visible to the legitimate owner.
    try {
      const { data: agent } = await serviceClient
        .from('agents')
        .select('first_name, last_name')
        .eq('id', data.agentId)
        .single()

      const recipientEmail = user.email
      const recipientName = agent
        ? `${agent.first_name ?? ''} ${agent.last_name ?? ''}`.trim() || 'there'
        : 'there'

      if (recipientEmail) {
        // Pass agentId so the email header shows the brokerage's generated
        // logo (migration 096).
        await sendAgentPhoneChangedNotification({
          recipientEmail,
          recipientName,
          oldPhoneLast4,
          newPhoneLast4,
          changedAtIso: changedAt,
          agentId: data.agentId,
        })
      }
    } catch (notifyErr: unknown) {
      const notifyMessage = notifyErr instanceof Error ? notifyErr.message : 'Unknown error'
      console.error('Phone-changed notification error (non-fatal):', notifyMessage)
    }
  }

  return { success: true }
}

// ============================================================================
// Mark KYC Modal as Seen (uses service role to bypass RLS)
// ============================================================================

export async function markKycModalSeen(agentId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('agent_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'agent' || profile.agent_id !== agentId) {
    return { success: false }
  }

  const serviceClient = createServiceRoleClient()
  await serviceClient
    .from('agents')
    .update({ kyc_verified_modal_seen: true })
    .eq('id', agentId)

  return { success: true }
}

// ============================================================================
// Mark first-login welcome as seen (drives "Welcome" vs "Welcome back")
// ============================================================================

/**
 * Stamp user_profiles.welcomed_at the first time a user lands on their
 * dashboard, so subsequent visits greet them with "Welcome back". Idempotent:
 * only writes when the flag is still NULL. Service role to bypass RLS.
 */
export async function markWelcomeSeen() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false }

  const serviceClient = createServiceRoleClient()
  const { data: profile } = await serviceClient
    .from('user_profiles')
    .select('welcomed_at')
    .eq('id', user.id)
    .single()

  // Already welcomed — nothing to do.
  if (profile?.welcomed_at) return { success: true }

  await serviceClient
    .from('user_profiles')
    .update({ welcomed_at: new Date().toISOString() })
    .eq('id', user.id)

  return { success: true }
}

// ============================================================================
// Brokerage-Scoped KYC Actions (callable by brokerage_admin for their agents)
// ============================================================================

/** Helper: verify caller is brokerage_admin and agent belongs to their brokerage */
async function verifyBrokerageAgentAccess(agentId: string): Promise<
  | { error: string }
  | {
      user: { id: string; email?: string }
      profile: { brokerage_id: string | null; role: string; full_name: string | null }
      agent: {
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
        kyc_status: string | null
        kyc_document_path: string | null
        kyc_document_type: string | null
        brokerage_id: string | null
      }
      serviceClient: ReturnType<typeof createServiceRoleClient>
    }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('brokerage_id, role, full_name')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'brokerage_admin' || !profile.brokerage_id) {
    return { error: 'Not authorized' }
  }

  const serviceClient = createServiceRoleClient()

  // Verify agent belongs to this brokerage
  const { data: agent } = await serviceClient
    .from('agents')
    .select('id, first_name, last_name, email, kyc_status, kyc_document_path, kyc_document_type, brokerage_id')
    .eq('id', agentId)
    .single()

  if (!agent || agent.brokerage_id !== profile.brokerage_id) {
    return { error: 'Agent not found in your brokerage' }
  }

  return { user, profile, agent, serviceClient }
}

/** Brokerage admin: verify agent KYC */
export async function brokerageVerifyAgentKyc(input: { agentId: string }) {
  const access = await verifyBrokerageAgentAccess(input.agentId)
  if ('error' in access) return { success: false, error: access.error }
  const { profile, agent, serviceClient } = access

  if (agent.kyc_status !== 'submitted') {
    return { success: false, error: `Cannot verify agent in "${agent.kyc_status}" status.` }
  }

  const now = new Date().toISOString()

  const { error: updateError } = await serviceClient
    .from('agents')
    .update({
      kyc_status: 'verified',
      kyc_verified_at: now,
      kyc_verified_by: profile.full_name || 'Brokerage Admin',
      kyc_rejection_reason: null,
    })
    .eq('id', input.agentId)

  if (updateError) return { success: false, error: `Failed to verify: ${updateError.message}` }

  // Auto-check KYC checklist on agent's deals
  try {
    const { data: agentDeals } = await serviceClient
      .from('deals')
      .select('id')
      .eq('agent_id', input.agentId)

    if (agentDeals && agentDeals.length > 0) {
      await serviceClient
        .from('underwriting_checklist')
        .update({
          is_checked: true,
          checked_by: `${profile.full_name || 'Brokerage Admin'} (auto)`,
          checked_at: now,
          notes: 'Auto-checked: Agent KYC verified by brokerage',
        })
        .in('deal_id', agentDeals.map((d: { id: string }) => d.id))
        .eq('checklist_item', 'Agent ID - FINTRAC Verification')
    }
  } catch { /* non-fatal */ }

  // Send approval email
  if (agent.email) {
    sendKycApprovedNotification({
      agentEmail: agent.email,
      agentFirstName: agent.first_name || 'there',
    }).catch(() => {})
  }

  // Audit log
  await serviceClient.from('audit_log').insert({
    user_id: access.user?.id ?? null,
    action: 'agent.kyc_verify_by_brokerage',
    entity_type: 'agent',
    entity_id: input.agentId,
    severity: 'info',
    actor_email: access.user?.email ?? null,
    actor_role: 'brokerage_admin',
    metadata: { agent_name: `${agent.first_name} ${agent.last_name}`, verified_by: profile.full_name },
  })

  // If this verification just activated the account (banking already approved),
  // fire any firm-deal advance the agent pre-requested during onboarding.
  // No-ops if not yet activated. Best-effort.
  await fireQueuedFirmDealOffersForAgent(serviceClient, input.agentId)

  return { success: true }
}

/** Brokerage admin: reject agent KYC */
export async function brokerageRejectAgentKyc(input: { agentId: string; reason: string }) {
  const access = await verifyBrokerageAgentAccess(input.agentId)
  if ('error' in access) return { success: false, error: access.error }
  const { profile, agent, serviceClient } = access

  if (agent.kyc_status !== 'submitted') {
    return { success: false, error: `Cannot reject agent in "${agent.kyc_status}" status.` }
  }

  const { error: updateError } = await serviceClient
    .from('agents')
    .update({
      kyc_status: 'rejected',
      kyc_rejection_reason: input.reason,
    })
    .eq('id', input.agentId)

  if (updateError) return { success: false, error: `Failed to reject: ${updateError.message}` }

  await serviceClient.from('audit_log').insert({
    user_id: access.user?.id ?? null,
    action: 'agent.kyc_reject_by_brokerage',
    entity_type: 'agent',
    entity_id: input.agentId,
    severity: 'info',
    actor_email: access.user?.email ?? null,
    actor_role: 'brokerage_admin',
    metadata: { agent_name: `${agent.first_name} ${agent.last_name}`, reason: input.reason, rejected_by: profile.full_name },
  })

  return { success: true }
}

/** Brokerage admin: get agent KYC document URLs */
export async function brokerageGetAgentKycDocumentUrl(input: { agentId: string }) {
  const access = await verifyBrokerageAgentAccess(input.agentId)
  if ('error' in access) return { success: false, error: access.error }
  const { agent, serviceClient } = access

  if (!agent.kyc_document_path) {
    return { success: false, error: 'No KYC document found for this agent' }
  }

  // Handle multiple files (path may be comma-separated or JSON array)
  let paths: string[] = []
  try {
    paths = JSON.parse(agent.kyc_document_path)
  } catch {
    paths = [agent.kyc_document_path]
  }

  const urls: string[] = []
  for (const p of paths) {
    const { data } = await serviceClient.storage.from('agent-kyc').createSignedUrl(p, 600)
    if (data?.signedUrl) urls.push(data.signedUrl)
  }

  if (urls.length === 0) return { success: false, error: 'Failed to generate document URLs' }
  return { success: true, data: { urls } }
}

// ============================================================================
// Brokerage Staff Management (callable by brokerage_admin)
// ============================================================================

/** Get all staff members for the authenticated brokerage admin's brokerage */
export async function getBrokerageStaff() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('brokerage_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'brokerage_admin' || !profile.brokerage_id) {
    return { success: false, error: 'Not authorized' }
  }

  const serviceClient = createServiceRoleClient()

  const { data: staff, error } = await serviceClient
    .from('user_profiles')
    .select('id, full_name, email, staff_title, last_login, is_active, created_at')
    .eq('brokerage_id', profile.brokerage_id)
    .eq('role', 'brokerage_admin')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Get brokerage staff error:', error.message)
    return { success: false, error: 'Failed to load staff' }
  }

  return { success: true, data: staff || [] }
}

/** Invite a new staff member to the brokerage (callable by brokerage_admin) */
export async function inviteBrokerageStaff(input: {
  fullName: string
  email: string
  staffTitle?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('brokerage_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'brokerage_admin' || !profile.brokerage_id) {
    return { success: false, error: 'Not authorized' }
  }

  const serviceClient = createServiceRoleClient()

  // Get brokerage info
  const { data: brokerage } = await serviceClient
    .from('brokerages')
    .select('id, name')
    .eq('id', profile.brokerage_id)
    .single()

  if (!brokerage) return { success: false, error: 'Brokerage not found' }

  // Check if email already has an account
  const { data: existingProfile } = await serviceClient
    .from('user_profiles')
    .select('id')
    .eq('email', input.email)
    .maybeSingle()

  if (existingProfile) {
    return { success: false, error: 'This email already has a Firm Funds account.' }
  }

  // Create auth user with temp password
  const tempPassword = crypto.randomBytes(16).toString('hex') + 'A1!'

  const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
    email: input.email,
    password: tempPassword,
    email_confirm: true,
  })

  if (signUpError || !authData?.user) {
    return { success: false, error: `Failed to create account: ${signUpError?.message || 'Unknown error'}` }
  }

  // Create user_profile
  const { error: profileError } = await serviceClient
    .from('user_profiles')
    .insert({
      id: authData.user.id,
      email: input.email,
      role: 'brokerage_admin',
      full_name: input.fullName,
      brokerage_id: profile.brokerage_id,
      staff_title: input.staffTitle || null,
      is_active: true,
      must_reset_password: true,
    })

  if (profileError) {
    console.error('Staff profile create error:', profileError.message)
    return { success: false, error: `Account created but profile failed: ${profileError.message}` }
  }

  // Generate magic link token (72-hour expiry)
  const inviteToken = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

  await serviceClient
    .from('invite_tokens')
    .insert({
      token: inviteToken,
      user_id: authData.user.id,
      email: input.email,
      expires_at: expiresAt,
    })

  // Send invite email
  await sendBrokerageInviteNotification({
    adminName: input.fullName.split(' ')[0],
    adminEmail: input.email,
    brokerageName: brokerage.name,
    inviteToken,
  })

  // Audit log
  await serviceClient.from('audit_log').insert({
    user_id: user.id,
    action: 'brokerage_staff.invite',
    entity_type: 'user',
    entity_id: authData.user.id,
    severity: 'info',
    actor_email: user.email,
    actor_role: 'brokerage_admin',
    metadata: {
      brokerage_id: profile.brokerage_id,
      brokerage_name: brokerage.name,
      staff_name: input.fullName,
      staff_email: input.email,
      staff_title: input.staffTitle || null,
    },
  })

  return { success: true }
}

/** Update a staff member's title */
export async function updateStaffTitle(staffUserId: string, title: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('brokerage_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'brokerage_admin' || !profile.brokerage_id) {
    return { success: false, error: 'Not authorized' }
  }

  const serviceClient = createServiceRoleClient()

  // Verify the target user is in the same brokerage
  const { data: targetProfile } = await serviceClient
    .from('user_profiles')
    .select('brokerage_id')
    .eq('id', staffUserId)
    .eq('role', 'brokerage_admin')
    .single()

  if (!targetProfile || targetProfile.brokerage_id !== profile.brokerage_id) {
    return { success: false, error: 'Staff member not found' }
  }

  const { error } = await serviceClient
    .from('user_profiles')
    .update({ staff_title: title || null })
    .eq('id', staffUserId)

  if (error) return { success: false, error: 'Failed to update title' }
  return { success: true }
}

// ============================================================================
// Admin Banking Actions
// ============================================================================

export async function updateAgentBanking(data: {
  agentId: string
  transitNumber: string
  institutionNumber: string
  accountNumber: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Verify admin role
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, staff_role')
    .eq('id', user.id)
    .single()

  if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return { success: false, error: 'Not authorized' }
  }
  // Least-privilege: entering agent banking is Manager and up (kyc.verify).
  if (!hasCapability(profile, 'kyc.verify')) {
    return { success: false, error: 'Not authorized' }
  }

  // Validate formats
  if (!/^\d{5}$/.test(data.transitNumber)) {
    return { success: false, error: 'Transit number must be exactly 5 digits' }
  }
  if (!/^\d{3}$/.test(data.institutionNumber)) {
    return { success: false, error: 'Institution number must be exactly 3 digits' }
  }
  if (!/^\d{7,12}$/.test(data.accountNumber)) {
    return { success: false, error: 'Account number must be 7-12 digits' }
  }

  const serviceClient = createServiceRoleClient()
  const now = new Date().toISOString()

  const { error } = await serviceClient
    .from('agents')
    .update({
      bank_transit_number: data.transitNumber,
      bank_institution_number: data.institutionNumber,
      bank_account_number: data.accountNumber,
      banking_verified: true,
      banking_verified_at: now,
      banking_verified_by: user.id,
    })
    .eq('id', data.agentId)

  if (error) {
    console.error('Banking update error:', error.message)
    return { success: false, error: 'Failed to update banking info' }
  }

  // Audit log
  void serviceClient.from('audit_log').insert({
    user_id: user.id,
    action: 'admin.update_agent_banking',
    entity_type: 'agent',
    entity_id: data.agentId,
    severity: 'info',
    actor_email: user.email,
    actor_role: profile.role,
    metadata: {
      transit: data.transitNumber,
      institution: data.institutionNumber,
      account_last4: data.accountNumber.slice(-4),
    },
  })

  // Auto-attach preauth form to all agent's deals if it exists
  try {
    const { data: agent } = await serviceClient
      .from('agents')
      .select('preauth_form_path')
      .eq('id', data.agentId)
      .single()

    if (agent?.preauth_form_path) {
      const { data: agentDeals } = await serviceClient
        .from('deals')
        .select('id')
        .eq('agent_id', data.agentId)

      if (agentDeals && agentDeals.length > 0) {
        for (const deal of agentDeals) {
          // Check if preauth doc already exists for this deal
          const { data: existing } = await serviceClient
            .from('deal_documents')
            .select('id')
            .eq('deal_id', deal.id)
            .eq('document_type', 'other')
            .ilike('file_name', '%preauth%')
            .limit(1)
            .single()

          if (!existing) {
            const ext = agent.preauth_form_path.split('.').pop() || 'pdf'
            await serviceClient
              .from('deal_documents')
              .insert({
                deal_id: deal.id,
                uploaded_by: user.id,
                document_type: 'other',
                file_name: `preauth-debit-form.${ext}`,
                file_path: `agent-preauth-forms/${agent.preauth_form_path}`,
                file_size: 0,
                upload_source: 'manual_upload',
                notes: 'Auto-attached: Pre-authorized debit form (banking verified)',
              })
          }
        }
      }
    }
  } catch (preauthErr: unknown) {
    // Non-fatal — don't fail the banking verification
    const preauthMessage = preauthErr instanceof Error ? preauthErr.message : 'Unknown error'
    console.error('Auto-attach preauth form error (non-fatal):', preauthMessage)
  }

  return { success: true }
}

// ============================================================================
// Agent Self-Service Banking Submission
// ============================================================================

export async function submitAgentBanking(data: {
  agentId: string
  transitNumber: string
  institutionNumber: string
  accountNumber: string
  /** Agent's "I authorize Firm Funds Inc. to deposit payments into this
   *  account" consent. Required by the onboarding flow; stamps deposit_authorized_at. */
  authorizeDeposit?: boolean
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Verify the user owns this agent profile
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('agent_id, role, email, full_name')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'agent' || profile.agent_id !== data.agentId) {
    return { success: false, error: 'Not authorized' }
  }

  // Validate formats
  if (!/^\d{5}$/.test(data.transitNumber)) {
    return { success: false, error: 'Transit number must be exactly 5 digits' }
  }
  if (!/^\d{3}$/.test(data.institutionNumber)) {
    return { success: false, error: 'Institution number must be exactly 3 digits' }
  }
  if (!/^\d{7,12}$/.test(data.accountNumber)) {
    return { success: false, error: 'Account number must be 7-12 digits' }
  }
  // The "I authorize Firm Funds Inc. to deposit payments into this account"
  // consent is mandatory to submit banking. Enforced server-side (the client
  // also disables the submit button until it's checked).
  if (!data.authorizeDeposit) {
    return { success: false, error: 'You must authorize Firm Funds Inc. to deposit payments into this account.' }
  }

  const serviceClient = createServiceRoleClient()
  const now = new Date().toISOString()

  const update: Record<string, string | null> = {
    banking_submitted_transit: data.transitNumber,
    banking_submitted_institution: data.institutionNumber,
    banking_submitted_account: data.accountNumber,
    banking_submitted_at: now,
    banking_approval_status: 'pending',
    banking_rejection_reason: null,
    // Record the direct-deposit authorization consent (migration 107).
    deposit_authorized_at: now,
    deposit_authorized_by: user.id,
  }

  const { error } = await serviceClient
    .from('agents')
    .update(update)
    .eq('id', data.agentId)

  if (error) {
    console.error('Banking submission error:', error.message)
    return { success: false, error: 'Failed to submit banking info' }
  }

  // Audit log
  void serviceClient.from('audit_log').insert({
    user_id: user.id,
    action: 'agent.submit_banking',
    entity_type: 'agent',
    entity_id: data.agentId,
    severity: 'info',
    actor_email: user.email,
    actor_role: 'agent',
    metadata: {
      transit: data.transitNumber,
      institution: data.institutionNumber,
      account_last4: data.accountNumber.slice(-4),
    },
  })

  // Notify admin
  try {
    await sendBankingSubmittedNotification({
      agentName: profile.full_name || profile.email || 'Unknown Agent',
      agentEmail: profile.email || '',
    })
  } catch (emailErr: unknown) {
    const emailMessage = emailErr instanceof Error ? emailErr.message : 'Unknown error'
    console.error('Banking notification email error (non-fatal):', emailMessage)
  }

  return { success: true }
}

// ============================================================================
// Admin: Approve Agent Banking
// ============================================================================

export async function approveAgentBanking(data: { agentId: string }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Verify admin role
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, staff_role')
    .eq('id', user.id)
    .single()

  if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return { success: false, error: 'Not authorized' }
  }
  // Least-privilege: approving agent banking is Manager and up (kyc.verify).
  // The actual disbursement (funding) stays Owner-only (money.write).
  if (!hasCapability(profile, 'kyc.verify')) {
    return { success: false, error: 'Not authorized' }
  }

  const serviceClient = createServiceRoleClient()

  // Get the agent's submitted banking info
  const { data: agent, error: fetchErr } = await serviceClient
    .from('agents')
    .select('banking_submitted_transit, banking_submitted_institution, banking_submitted_account, banking_approval_status, email, first_name, last_name')
    .eq('id', data.agentId)
    .single()

  if (fetchErr || !agent) return { success: false, error: 'Agent not found' }
  if (agent.banking_approval_status !== 'pending') return { success: false, error: 'No pending banking submission to approve' }
  if (!agent.banking_submitted_transit || !agent.banking_submitted_institution || !agent.banking_submitted_account) {
    return { success: false, error: 'Incomplete banking submission' }
  }

  const now = new Date().toISOString()

  // Copy submitted values to verified fields
  const { error } = await serviceClient
    .from('agents')
    .update({
      bank_transit_number: agent.banking_submitted_transit,
      bank_institution_number: agent.banking_submitted_institution,
      bank_account_number: agent.banking_submitted_account,
      banking_verified: true,
      banking_verified_at: now,
      banking_verified_by: user.id,
      banking_approval_status: 'approved',
      banking_rejection_reason: null,
    })
    .eq('id', data.agentId)

  if (error) {
    console.error('Banking approval error:', error.message)
    return { success: false, error: 'Failed to approve banking' }
  }

  // Audit log
  void serviceClient.from('audit_log').insert({
    user_id: user.id,
    action: 'admin.approve_agent_banking',
    entity_type: 'agent',
    entity_id: data.agentId,
    severity: 'info',
    actor_email: user.email,
    actor_role: profile.role,
    metadata: {
      transit: agent.banking_submitted_transit,
      institution: agent.banking_submitted_institution,
      account_last4: agent.banking_submitted_account.slice(-4),
    },
  })

  // Notify agent
  try {
    const agentName = `${agent.first_name} ${agent.last_name}`.trim()
    await sendBankingApprovalNotification({
      agentEmail: agent.email,
      agentName,
      approved: true,
    })
  } catch (emailErr: unknown) {
    const emailMessage = emailErr instanceof Error ? emailErr.message : 'Unknown error'
    console.error('Banking approval email error (non-fatal):', emailMessage)
  }

  // Banking approval is the second gate. If KYC is already verified, the agent
  // is now activated — fire any firm-deal advance they pre-requested during
  // onboarding (creates the offered deal + notifies their brokerage). No-ops if
  // KYC is still pending. Best-effort — never blocks the approval.
  await fireQueuedFirmDealOffersForAgent(serviceClient, data.agentId)

  return { success: true }
}

// ============================================================================
// Admin: Reject Agent Banking
// ============================================================================

export async function rejectAgentBanking(data: { agentId: string; reason: string }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Verify admin role
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, staff_role')
    .eq('id', user.id)
    .single()

  if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return { success: false, error: 'Not authorized' }
  }
  // Least-privilege: rejecting agent banking is Manager and up (kyc.verify).
  if (!hasCapability(profile, 'kyc.verify')) {
    return { success: false, error: 'Not authorized' }
  }

  if (!data.reason?.trim()) return { success: false, error: 'Rejection reason is required' }

  const serviceClient = createServiceRoleClient()

  // Get agent info for email notification
  const { data: agent, error: fetchErr } = await serviceClient
    .from('agents')
    .select('banking_approval_status, email, first_name, last_name')
    .eq('id', data.agentId)
    .single()

  if (fetchErr || !agent) return { success: false, error: 'Agent not found' }
  if (agent.banking_approval_status !== 'pending') return { success: false, error: 'No pending banking submission to reject' }

  const { error } = await serviceClient
    .from('agents')
    .update({
      banking_approval_status: 'rejected',
      banking_rejection_reason: data.reason.trim(),
    })
    .eq('id', data.agentId)

  if (error) {
    console.error('Banking rejection error:', error.message)
    return { success: false, error: 'Failed to reject banking' }
  }

  // Audit log
  void serviceClient.from('audit_log').insert({
    user_id: user.id,
    action: 'admin.reject_agent_banking',
    entity_type: 'agent',
    entity_id: data.agentId,
    severity: 'warning',
    actor_email: user.email,
    actor_role: profile.role,
    metadata: { reason: data.reason.trim() },
  })

  // Notify agent
  try {
    const agentName = `${agent.first_name} ${agent.last_name}`.trim()
    await sendBankingApprovalNotification({
      agentEmail: agent.email,
      agentName,
      approved: false,
      reason: data.reason.trim(),
    })
  } catch (emailErr: unknown) {
    const emailMessage = emailErr instanceof Error ? emailErr.message : 'Unknown error'
    console.error('Banking rejection email error (non-fatal):', emailMessage)
  }

  return { success: true }
}

export async function getAgentProfile(agentId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', data: null }

  const serviceClient = createServiceRoleClient()

  // Authorization check (Finding 10): the previous version only verified that
  // the caller was logged in, not that they had any right to see this agent's
  // banking + KYC info. An agent could pass any UUID and get back bank
  // transit, institution, and account numbers.
  const { data: callerProfile } = await serviceClient
    .from('user_profiles')
    .select('role, agent_id, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!callerProfile) {
    return { success: false, error: 'Caller profile not found', data: null }
  }

  const isAdmin = ['super_admin', 'firm_funds_admin'].includes(callerProfile.role)
  const isSelf = callerProfile.role === 'agent' && callerProfile.agent_id === agentId

  if (!isAdmin && !isSelf) {
    // Brokerage admin can see agents in their brokerage.
    if (callerProfile.role === 'brokerage_admin' && callerProfile.brokerage_id) {
      const { data: targetAgent } = await serviceClient
        .from('agents')
        .select('brokerage_id')
        .eq('id', agentId)
        .single()
      if (!targetAgent || targetAgent.brokerage_id !== callerProfile.brokerage_id) {
        return { success: false, error: 'Not authorized for this agent', data: null }
      }
    } else {
      return { success: false, error: 'Not authorized for this agent', data: null }
    }
  }

  // Finding #39: column allowlist. Admins and the agent themselves get the
  // full row (banking + KYC PII). Everyone else (brokerage_admin) gets a
  // safe subset only.
  const SAFE_COLUMNS = 'id, first_name, last_name, email, phone, kyc_status, kyc_verified_at, status, created_at, brokerages(name)'
  const columns = (isAdmin || isSelf) ? '*, brokerages(name)' : SAFE_COLUMNS

  const { data: agent, error } = await serviceClient
    .from('agents')
    .select(columns)
    .eq('id', agentId)
    .single()

  if (error || !agent) {
    return { success: false, error: 'Agent not found', data: null }
  }

  return { success: true, data: agent }
}
