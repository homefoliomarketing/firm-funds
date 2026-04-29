'use server'

import crypto from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import { sendAgentInviteNotification } from '@/lib/email'
import { CreateAgentSchema } from '@/lib/validations'

interface ActionResult {
  success: boolean
  error?: string
  data?: Record<string, any>
}

function generateTempPassword(): string {
  // 16-char temp password matching admin-actions semantics — never shown to the agent.
  const bytes = crypto.randomBytes(12)
  return bytes.toString('base64').replace(/[+/=]/g, 'X') + 'A1!'
}

// ============================================================================
// Add an agent (brokerage admin scope — limited to their own brokerage)
// Auto-sends welcome email when an email is provided.
// ============================================================================

export async function addAgentAsBrokerage(input: {
  firstName: string
  lastName: string
  email?: string | null
  phone?: string
  recoNumber?: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Your account is not linked to a brokerage' }

  // Reuse the existing agent schema; pass brokerageId from the authed profile (not from input)
  const parsed = CreateAgentSchema.safeParse({
    ...input,
    brokerageId: profile.brokerage_id,
  })
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
  }
  const v = parsed.data
  const email = v.email || null

  try {
    if (email) {
      const { data: existing } = await supabase
        .from('agents')
        .select('id')
        .eq('email', email)
        .neq('status', 'archived')
        .maybeSingle()
      if (existing) return { success: false, error: 'An agent with this email already exists' }
    }

    const serviceClient = createServiceRoleClient()
    const { data: agent, error: insertError } = await serviceClient
      .from('agents')
      .insert({
        brokerage_id: profile.brokerage_id,
        first_name: v.firstName,
        last_name: v.lastName,
        email,
        phone: v.phone || null,
        reco_number: v.recoNumber || null,
        status: 'active',
        flagged_by_brokerage: false,
        outstanding_recovery: 0,
      })
      .select()
      .single()

    if (insertError) {
      console.error('Brokerage agent create error:', insertError.message)
      return { success: false, error: `Failed to create agent: ${insertError.message}` }
    }

    // Auto-send welcome email if agent has an email
    let welcomeSent = false
    if (email) {
      try {
        const tempPassword = generateTempPassword()
        const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
          email,
          password: tempPassword,
          email_confirm: true,
        })
        if (!signUpError && authData?.user) {
          await serviceClient.from('user_profiles').insert({
            id: authData.user.id,
            email,
            role: 'agent',
            full_name: `${v.firstName} ${v.lastName}`,
            agent_id: agent.id,
            brokerage_id: profile.brokerage_id,
            is_active: true,
            must_reset_password: true,
          })
          // Magic link invite token (72hr)
          const token = crypto.randomBytes(32).toString('hex')
          const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
          await serviceClient.from('invite_tokens').insert({
            token, user_id: authData.user.id, agent_id: agent.id, email, expires_at: expiresAt,
          })

          const { data: brokerage } = await serviceClient
            .from('brokerages')
            .select('name, logo_url, is_white_label_partner')
            .eq('id', profile.brokerage_id)
            .single()

          await sendAgentInviteNotification({
            agentFirstName: v.firstName,
            agentEmail: email,
            brokerageName: brokerage?.name || 'Your Brokerage',
            brokerageLogoUrl: brokerage?.logo_url,
            inviteToken: token,
          })

          await serviceClient
            .from('agents')
            .update({ welcome_email_sent_at: new Date().toISOString() })
            .eq('id', agent.id)

          welcomeSent = true
        }
      } catch (err: any) {
        console.error('Welcome email send failed:', err?.message)
      }
    }

    await logAuditEvent({
      action: 'agent.create_by_brokerage',
      entityType: 'agent',
      entityId: agent.id,
      metadata: {
        name: `${v.firstName} ${v.lastName}`,
        email: email || 'no-email',
        brokerage_id: profile.brokerage_id,
        welcome_sent: welcomeSent,
        created_by_user_id: user.id,
      },
    })

    return { success: true, data: { ...agent, welcomeSent } }
  } catch (err: any) {
    console.error('Brokerage agent create error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Update an agent's contact info (email/phone) — brokerage scope
// ============================================================================

export async function brokerageUpdateAgentContact(input: {
  agentId: string
  email?: string | null
  phone?: string | null
  recoNumber?: string | null
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Your account is not linked to a brokerage' }

  const { data: agent } = await supabase
    .from('agents')
    .select('id, brokerage_id, email')
    .eq('id', input.agentId)
    .single()
  if (!agent) return { success: false, error: 'Agent not found' }
  if (agent.brokerage_id !== profile.brokerage_id) {
    return { success: false, error: 'Agent does not belong to your brokerage' }
  }

  const newEmail = input.email?.trim().toLowerCase() || null
  if (newEmail && newEmail !== agent.email) {
    // Email format check (rough)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return { success: false, error: 'Invalid email address' }
    }
    // Uniqueness check
    const { data: dup } = await supabase
      .from('agents')
      .select('id')
      .eq('email', newEmail)
      .neq('id', input.agentId)
      .neq('status', 'archived')
      .maybeSingle()
    if (dup) return { success: false, error: 'Another agent already uses this email' }
  }

  const serviceClient = createServiceRoleClient()
  const updates: Record<string, any> = {}
  if (input.email !== undefined) updates.email = newEmail
  if (input.phone !== undefined) updates.phone = input.phone?.trim() || null
  if (input.recoNumber !== undefined) updates.reco_number = input.recoNumber?.trim() || null

  if (Object.keys(updates).length === 0) return { success: true }

  const { error: updateErr } = await serviceClient
    .from('agents')
    .update(updates)
    .eq('id', input.agentId)
  if (updateErr) return { success: false, error: `Failed to update agent: ${updateErr.message}` }

  await logAuditEvent({
    action: 'agent.update_contact_by_brokerage',
    entityType: 'agent',
    entityId: input.agentId,
    metadata: { ...updates, updated_by_user_id: user.id },
  })

  return { success: true }
}

// ============================================================================
// Re-send the welcome email to one of the brokerage's own agents
// (Wrapper around the admin variant — restricts to the calling brokerage's roster)
// ============================================================================

export async function brokerageResendWelcomeEmail(input: { agentId: string }): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Your account is not linked to a brokerage' }

  // Verify the agent is on this brokerage's roster
  const { data: agent } = await supabase
    .from('agents')
    .select('id, first_name, last_name, email, status, brokerage_id')
    .eq('id', input.agentId)
    .single()
  if (!agent) return { success: false, error: 'Agent not found' }
  if (agent.brokerage_id !== profile.brokerage_id) {
    return { success: false, error: 'Agent does not belong to your brokerage' }
  }
  if (agent.status === 'archived') return { success: false, error: 'Cannot send email to archived agent' }
  if (!agent.email) return { success: false, error: 'Agent has no email on file — add one first' }

  // Delegate to the admin-actions implementation by replicating the magic-link logic against the service client.
  const serviceClient = createServiceRoleClient()

  let { data: existingProfile } = await serviceClient
    .from('user_profiles')
    .select('id')
    .eq('agent_id', agent.id)
    .maybeSingle()

  const tempPassword = generateTempPassword()

  if (!existingProfile) {
    const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
      email: agent.email,
      password: tempPassword,
      email_confirm: true,
    })
    if (signUpError || !authData?.user) {
      return { success: false, error: `Failed to create login: ${signUpError?.message || 'Unknown error'}` }
    }
    await serviceClient.from('user_profiles').insert({
      id: authData.user.id,
      email: agent.email,
      role: 'agent',
      full_name: `${agent.first_name} ${agent.last_name}`,
      agent_id: agent.id,
      brokerage_id: profile.brokerage_id,
      is_active: true,
      must_reset_password: true,
    })
    existingProfile = { id: authData.user.id }
  } else {
    // Force them to reset on next login
    await serviceClient.auth.admin.updateUserById(existingProfile.id, { password: tempPassword })
    await serviceClient.from('user_profiles').update({ must_reset_password: true }).eq('id', existingProfile.id)
    await serviceClient.auth.admin.updateUserById(existingProfile.id, { user_metadata: { password_changed: false } })
  }

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
  await serviceClient.from('invite_tokens').insert({
    token, user_id: existingProfile.id, agent_id: agent.id, email: agent.email, expires_at: expiresAt,
  })

  const { data: brokerage } = await serviceClient
    .from('brokerages')
    .select('name, logo_url, is_white_label_partner')
    .eq('id', profile.brokerage_id)
    .single()

  await sendAgentInviteNotification({
    agentFirstName: agent.first_name,
    agentEmail: agent.email,
    brokerageName: brokerage?.name || 'Your Brokerage',
    brokerageLogoUrl: brokerage?.logo_url,
    inviteToken: token,
  })

  await serviceClient
    .from('agents')
    .update({ welcome_email_sent_at: new Date().toISOString() })
    .eq('id', agent.id)

  await logAuditEvent({
    action: 'agent.resend_welcome_by_brokerage',
    entityType: 'agent',
    entityId: agent.id,
    metadata: {
      name: `${agent.first_name} ${agent.last_name}`,
      email: agent.email,
      sent_by_user_id: user.id,
    },
  })

  return { success: true }
}
