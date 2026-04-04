'use server'

import crypto from 'crypto'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { sendAgentInviteNotification } from '@/lib/email'
import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import {
  CreateBrokerageSchema,
  UpdateBrokerageSchema,
  CreateAgentSchema,
  UpdateAgentSchema,
  CreateUserAccountSchema,
} from '@/lib/validations'

// ============================================================================
// Types
// ============================================================================

interface ActionResult {
  success: boolean
  error?: string
  data?: Record<string, any>
}

// ============================================================================
// Brokerage CRUD
// ============================================================================

export async function createBrokerage(input: {
  name: string
  email: string
  brand?: string
  address?: string
  phone?: string
  referralFeePercentage: number
  transactionSystem?: string
  notes?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = CreateBrokerageSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    const { data: brokerage, error: insertError } = await supabase
      .from('brokerages')
      .insert({
        name: v.name,
        email: v.email,
        brand: v.brand || null,
        address: v.address || null,
        phone: v.phone || null,
        referral_fee_percentage: v.referralFeePercentage,
        transaction_system: v.transactionSystem || null,
        notes: v.notes || null,
        status: 'active',
      })
      .select()
      .single()

    if (insertError) {
      console.error('Brokerage create error:', insertError.message)
      return { success: false, error: `Failed to create brokerage: ${insertError.message}` }
    }

    await logAuditEvent({
      action: 'brokerage.create',
      entityType: 'brokerage',
      entityId: brokerage.id,
      metadata: { name: input.name, email: input.email },
    })

    return { success: true, data: brokerage }
  } catch (err: any) {
    console.error('Brokerage create error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function updateBrokerage(input: {
  id: string
  name: string
  email: string
  brand?: string
  address?: string
  phone?: string
  referralFeePercentage: number
  transactionSystem?: string
  notes?: string
  status: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = UpdateBrokerageSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    const { data: brokerage, error: updateError } = await supabase
      .from('brokerages')
      .update({
        name: v.name,
        email: v.email,
        brand: v.brand || null,
        address: v.address || null,
        phone: v.phone || null,
        referral_fee_percentage: v.referralFeePercentage,
        transaction_system: v.transactionSystem || null,
        notes: v.notes || null,
        status: v.status,
      })
      .eq('id', v.id)
      .select()
      .single()

    if (updateError) {
      console.error('Brokerage update error:', updateError.message)
      return { success: false, error: `Failed to update brokerage: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'brokerage.update',
      entityType: 'brokerage',
      entityId: input.id,
      metadata: { name: input.name, status: input.status },
    })

    return { success: true, data: brokerage }
  } catch (err: any) {
    console.error('Brokerage update error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Agent CRUD
// ============================================================================

export async function createAgent(input: {
  brokerageId: string
  firstName: string
  lastName: string
  email: string
  phone?: string
  recoNumber?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = CreateAgentSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    // Verify brokerage exists
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('id, name')
      .eq('id', v.brokerageId)
      .single()

    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    const email = v.email

    // Check if agent email already exists (exclude archived agents so emails can be reused)
    const { data: existingAgent } = await supabase
      .from('agents')
      .select('id')
      .eq('email', email)
      .neq('status', 'archived')
      .maybeSingle()

    if (existingAgent) return { success: false, error: 'An agent with this email already exists' }

    const serviceClient = createServiceRoleClient()
    const { data: agent, error: insertError } = await serviceClient
      .from('agents')
      .insert({
        brokerage_id: v.brokerageId,
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
      console.error('Agent create error:', insertError.message)
      return { success: false, error: `Failed to create agent: ${insertError.message}` }
    }

    await logAuditEvent({
      action: 'agent.create',
      entityType: 'agent',
      entityId: agent.id,
      metadata: { name: `${v.firstName} ${v.lastName}`, email: v.email, brokerage_id: v.brokerageId },
    })

    return { success: true, data: agent }
  } catch (err: any) {
    console.error('Agent create error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Bulk import agents from parsed spreadsheet data
// ============================================================================

interface BulkAgentRow {
  firstName: string
  lastName: string
  email: string
  phone?: string
  recoNumber?: string
}

interface BulkImportResult {
  success: boolean
  error?: string
  data?: {
    imported: number
    skipped: number
    errors: string[]
  }
}

export async function bulkImportAgents(input: {
  brokerageId: string
  agents: BulkAgentRow[]
}): Promise<BulkImportResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (!input.brokerageId) return { success: false, error: 'Brokerage is required' }
    if (!input.agents || input.agents.length === 0) return { success: false, error: 'No agents to import' }
    if (input.agents.length > 200) return { success: false, error: 'Maximum 200 agents per import' }

    // Verify brokerage exists
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('id, name')
      .eq('id', input.brokerageId)
      .single()

    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    // Get existing agent emails for this brokerage to skip duplicates (exclude archived)
    const { data: existingAgents } = await supabase
      .from('agents')
      .select('email')
      .eq('brokerage_id', input.brokerageId)
      .neq('status', 'archived')

    const existingEmails = new Set((existingAgents || []).map(a => a.email.toLowerCase()))

    const errors: string[] = []
    let imported = 0
    let skipped = 0

    for (let i = 0; i < input.agents.length; i++) {
      const row = input.agents[i]
      const rowNum = i + 2 // +2 because row 1 is header, data starts row 2

      // Validate required fields
      if (!row.firstName?.trim() || !row.lastName?.trim() || !row.email?.trim()) {
        errors.push(`Row ${rowNum}: Missing required field (first name, last name, or email)`)
        skipped++
        continue
      }

      // Basic email validation
      const email = row.email.trim().toLowerCase()
      if (!email.includes('@') || !email.includes('.')) {
        errors.push(`Row ${rowNum}: Invalid email "${row.email}"`)
        skipped++
        continue
      }

      // Skip duplicates
      if (existingEmails.has(email)) {
        errors.push(`Row ${rowNum}: ${row.firstName} ${row.lastName} (${email}) already exists — skipped`)
        skipped++
        continue
      }

      const serviceClient = createServiceRoleClient()
      const { error: insertError } = await serviceClient
        .from('agents')
        .insert({
          brokerage_id: input.brokerageId,
          first_name: row.firstName.trim(),
          last_name: row.lastName.trim(),
          email,
          phone: row.phone?.trim() || null,
          reco_number: row.recoNumber?.trim() || null,
          status: 'active',
          flagged_by_brokerage: false,
          outstanding_recovery: 0,
        })

      if (insertError) {
        errors.push(`Row ${rowNum}: Failed to import ${row.firstName} ${row.lastName} — ${insertError.message}`)
        skipped++
      } else {
        existingEmails.add(email) // prevent dupes within same batch
        imported++
      }
    }

    await logAuditEvent({
      action: 'agent.bulk_import',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: { brokerage_name: brokerage.name, imported, skipped, total_rows: input.agents.length },
    })

    return {
      success: true,
      data: { imported, skipped, errors },
    }
  } catch (err: any) {
    console.error('Bulk import error:', err?.message)
    return { success: false, error: 'An unexpected error occurred during import' }
  }
}

export async function updateAgent(input: {
  id: string
  brokerageId: string
  firstName: string
  lastName: string
  email: string
  phone?: string
  recoNumber?: string
  status: string
  flaggedByBrokerage: boolean
  outstandingRecovery: number
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = UpdateAgentSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    const serviceClient = createServiceRoleClient()
    const { data: agent, error: updateError } = await serviceClient
      .from('agents')
      .update({
        brokerage_id: v.brokerageId,
        first_name: v.firstName,
        last_name: v.lastName,
        email: v.email,
        phone: v.phone || null,
        reco_number: v.recoNumber || null,
        status: v.status,
        flagged_by_brokerage: v.flaggedByBrokerage,
        outstanding_recovery: v.outstandingRecovery,
      })
      .eq('id', v.id)
      .select()
      .single()

    if (updateError) {
      console.error('Agent update error:', updateError.message)
      return { success: false, error: `Failed to update agent: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'agent.update',
      entityType: 'agent',
      entityId: v.id,
      metadata: { name: `${v.firstName} ${v.lastName}`, status: v.status },
    })

    return { success: true, data: agent }
  } catch (err: any) {
    console.error('Agent update error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Create Auth User + Profile (for agent or brokerage admin login)
// ============================================================================

export async function createUserAccount(input: {
  email: string
  password: string
  fullName: string
  role: 'agent' | 'brokerage_admin'
  agentId?: string
  brokerageId?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = CreateUserAccountSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    // Create auth user via service-role client (required for admin.createUser)
    const serviceClient = createServiceRoleClient()

    const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
      email: v.email,
      password: v.password,
      email_confirm: true,
    })

    if (signUpError) {
      console.error('Auth user create error:', signUpError.message)
      return { success: false, error: `Failed to create user account: ${signUpError.message}` }
    }

    if (!authData.user) {
      return { success: false, error: 'User creation returned no user object' }
    }

    // Create user_profile record (use service client to bypass RLS)
    const { error: profileError } = await serviceClient
      .from('user_profiles')
      .insert({
        id: authData.user.id,
        email: v.email,
        role: v.role,
        full_name: v.fullName,
        agent_id: v.agentId || null,
        brokerage_id: v.brokerageId || null,
        is_active: true,
      })

    if (profileError) {
      console.error('Profile create error:', profileError.message)
      return { success: false, error: `User created but profile failed: ${profileError.message}` }
    }

    await logAuditEvent({
      action: 'user.create',
      entityType: 'user',
      entityId: authData.user.id,
      metadata: { email: v.email, role: v.role, full_name: v.fullName },
    })

    return { success: true, data: { userId: authData.user.id } }
  } catch (err: any) {
    console.error('User account create error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Archive Agent: Soft-delete agent + deactivate login
// ============================================================================

export async function archiveAgent(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Fetch agent record
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, first_name, last_name, email, status, brokerage_id')
      .eq('id', input.agentId)
      .single()

    if (agentError || !agent) return { success: false, error: 'Agent not found' }
    if (agent.status === 'archived') return { success: false, error: 'Agent is already archived' }

    // Use service role client to bypass RLS for all mutations
    const serviceClient = createServiceRoleClient()

    // 1. Set agent status to archived
    const { error: updateError } = await serviceClient
      .from('agents')
      .update({ status: 'archived' })
      .eq('id', input.agentId)

    if (updateError) {
      console.error('Agent archive error:', updateError.message)
      return { success: false, error: `Failed to archive agent: ${updateError.message}` }
    }

    // 2. Deactivate any linked user_profile (prevents login)
    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('id')
      .eq('agent_id', input.agentId)
      .maybeSingle()

    if (profile) {
      await serviceClient
        .from('user_profiles')
        .update({ is_active: false })
        .eq('id', profile.id)

      // 3. Delete the auth user so their email is freed up for reuse
      try {
        await serviceClient.auth.admin.deleteUser(profile.id)
      } catch (err) {
        // Non-fatal — profile deactivation is the primary gate
        console.warn('[archiveAgent] Could not delete auth user:', err)
      }
    }

    await logAuditEvent({
      action: 'agent.archive',
      entityType: 'agent',
      entityId: input.agentId,
      metadata: {
        name: `${agent.first_name} ${agent.last_name}`,
        email: agent.email,
        brokerage_id: agent.brokerage_id,
        archived_by: user.id,
        had_login: !!profile,
      },
    })

    return { success: true, data: { agentId: input.agentId } }
  } catch (err: any) {
    console.error('Agent archive error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Invite Agent: Create agent record + auth user + user_profile + send email
// ============================================================================

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let password = ''
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

export async function inviteAgent(input: {
  brokerageId: string
  firstName: string
  lastName: string
  email: string
  phone?: string
  recoNumber?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (!input.firstName.trim()) return { success: false, error: 'First name is required' }
    if (!input.lastName.trim()) return { success: false, error: 'Last name is required' }
    if (!input.email.trim()) return { success: false, error: 'Email is required' }
    if (!input.brokerageId) return { success: false, error: 'Brokerage is required' }

    const email = input.email.trim().toLowerCase()

    // Verify brokerage exists
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('id, name')
      .eq('id', input.brokerageId)
      .single()

    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    // Check if agent email already exists (exclude archived agents so emails can be reused)
    const { data: existingAgent } = await supabase
      .from('agents')
      .select('id')
      .eq('email', email)
      .neq('status', 'archived')
      .maybeSingle()

    if (existingAgent) return { success: false, error: 'An agent with this email already exists' }

    // Use service role client for all mutations (bypasses RLS)
    const serviceClient = createServiceRoleClient()

    // 1. Create agent record
    const { data: agent, error: agentError } = await serviceClient
      .from('agents')
      .insert({
        brokerage_id: input.brokerageId,
        first_name: input.firstName.trim(),
        last_name: input.lastName.trim(),
        email,
        phone: input.phone?.trim() || null,
        reco_number: input.recoNumber?.trim() || null,
        status: 'active',
        flagged_by_brokerage: false,
        outstanding_recovery: 0,
      })
      .select()
      .single()

    if (agentError || !agent) {
      console.error('Agent create error:', agentError?.message)
      return { success: false, error: `Failed to create agent record: ${agentError?.message || 'Unknown error'}` }
    }

    // 2. Create auth user with a random password (agent will set their own via magic link)
    const tempPassword = generateTempPassword()  // Used only as initial placeholder — never shown to agent

    const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    })

    if (signUpError || !authData?.user) {
      console.error('Auth user create error:', signUpError?.message)
      return {
        success: false,
        error: `Agent record created but login creation failed: ${signUpError?.message || 'Unknown error'}. Create the login manually via the Supabase dashboard.`,
        data: { agentId: agent.id, agentCreated: true, loginCreated: false },
      }
    }

    // 3. Create user_profile record (use service client to bypass RLS)
    const { error: profileError } = await serviceClient
      .from('user_profiles')
      .insert({
        id: authData.user.id,
        email,
        role: 'agent',
        full_name: `${input.firstName.trim()} ${input.lastName.trim()}`,
        agent_id: agent.id,
        brokerage_id: input.brokerageId,
        is_active: true,
        must_reset_password: true,
      })

    if (profileError) {
      console.error('Profile create error:', profileError.message)
      return {
        success: false,
        error: `Agent and login created, but profile link failed: ${profileError.message}. Fix manually in Supabase.`,
        data: { agentId: agent.id, agentCreated: true, loginCreated: true, profileCreated: false },
      }
    }

    // 4. Generate magic link invite token (72-hour expiry)
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

    const { error: tokenError } = await serviceClient
      .from('invite_tokens')
      .insert({
        token: inviteToken,
        user_id: authData.user.id,
        agent_id: agent.id,
        email,
        expires_at: expiresAt,
      })

    if (tokenError) {
      console.error('Invite token create error:', tokenError.message)
      // Non-fatal — agent and auth user are already created, admin can resend invite
    }

    // 5. Send invite email with magic link (no temp password)
    await sendAgentInviteNotification({
      agentFirstName: input.firstName.trim(),
      agentEmail: email,
      brokerageName: brokerage.name,
      inviteToken,
    })

    // Audit log
    await logAuditEvent({
      action: 'agent.invite',
      entityType: 'agent',
      entityId: agent.id,
      metadata: {
        name: `${input.firstName} ${input.lastName}`,
        email,
        brokerage_id: input.brokerageId,
        brokerage_name: brokerage.name,
        invited_by: user.id,
        invite_method: 'magic_link',
      },
    })

    return {
      success: true,
      data: {
        agentId: agent.id,
        userId: authData.user.id,
        agentCreated: true,
        loginCreated: true,
        profileCreated: true,
        emailSent: true,
      },
    }
  } catch (err: any) {
    console.error('Agent invite error:', err?.message)
    return { success: false, error: 'An unexpected error occurred during agent invitation' }
  }
}

// ============================================================================
// Resend welcome email to an agent (generates new temp password)
// ============================================================================

export async function resendAgentWelcomeEmail(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Get agent details
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, first_name, last_name, email, status, brokerage_id')
      .eq('id', input.agentId)
      .single()

    if (agentError || !agent) return { success: false, error: 'Agent not found' }
    if (agent.status === 'archived') return { success: false, error: 'Cannot send email to archived agent' }

    // Get brokerage name
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('name')
      .eq('id', agent.brokerage_id)
      .single()

    const serviceClient = createServiceRoleClient()

    // Check if auth user exists for this agent
    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('id')
      .eq('agent_id', agent.id)
      .maybeSingle()

    const tempPassword = generateTempPassword()

    if (profile) {
      // Auth user exists — reset their password
      const { error: pwError } = await serviceClient.auth.admin.updateUserById(profile.id, {
        password: tempPassword,
      })

      if (pwError) {
        console.error('Password reset error:', pwError.message)
        return { success: false, error: `Failed to reset password: ${pwError.message}` }
      }

      // Set must_reset_password flag
      await serviceClient
        .from('user_profiles')
        .update({ must_reset_password: true })
        .eq('id', profile.id)

      // Clear any password_changed metadata so middleware forces change again
      await serviceClient.auth.admin.updateUserById(profile.id, {
        user_metadata: { password_changed: false },
      })
    } else {
      // No auth user — create one (agent was added without invite)
      const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
        email: agent.email,
        password: tempPassword,
        email_confirm: true,
      })

      if (signUpError || !authData?.user) {
        return { success: false, error: `Failed to create login: ${signUpError?.message || 'Unknown error'}` }
      }

      // Create user_profile
      await serviceClient
        .from('user_profiles')
        .insert({
          id: authData.user.id,
          email: agent.email,
          role: 'agent',
          full_name: `${agent.first_name} ${agent.last_name}`,
          agent_id: agent.id,
          brokerage_id: agent.brokerage_id,
          is_active: true,
          must_reset_password: true,
        })
    }

    // Get the user ID for the magic link token
    const userId = profile ? profile.id : (await serviceClient.from('user_profiles').select('id').eq('agent_id', agent.id).single()).data?.id

    if (userId) {
      // Generate magic link invite token (72-hour expiry)
      const inviteToken = crypto.randomBytes(32).toString('hex')
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

      await serviceClient
        .from('invite_tokens')
        .insert({
          token: inviteToken,
          user_id: userId,
          agent_id: agent.id,
          email: agent.email,
          expires_at: expiresAt,
        })

      // Send magic link invite email (no temp password)
      await sendAgentInviteNotification({
        agentFirstName: agent.first_name,
        agentEmail: agent.email,
        brokerageName: brokerage?.name || 'Your Brokerage',
        inviteToken,
      })
    } else {
      // Fallback: send legacy temp password email
      await sendAgentInviteNotification({
        agentFirstName: agent.first_name,
        agentEmail: agent.email,
        brokerageName: brokerage?.name || 'Your Brokerage',
        tempPassword,
      })
    }

    await logAuditEvent({
      action: 'agent.resend_welcome',
      entityType: 'agent',
      entityId: agent.id,
      metadata: {
        name: `${agent.first_name} ${agent.last_name}`,
        email: agent.email,
        resent_by: user.id,
        had_existing_login: !!profile,
        invite_method: userId ? 'magic_link' : 'temp_password',
      },
    })

    return { success: true }
  } catch (err: any) {
    console.error('Resend welcome email error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// EFT Transfer Tracking
// ============================================================================

export async function recordEftTransfer(input: {
  dealId: string
  amount: number
  date: string
  reference?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (input.amount <= 0) return { success: false, error: 'Amount must be greater than 0' }
    if (input.amount > 25000) return { success: false, error: 'Maximum EFT transfer is $25,000 per day' }

    // Fetch current deal
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, status, advance_amount, eft_transfers')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }
    if (deal.status !== 'funded') return { success: false, error: 'EFT transfers can only be recorded on funded deals' }

    // Add new transfer to the JSONB array
    const existingTransfers = deal.eft_transfers || []
    const newTransfer = {
      amount: input.amount,
      date: input.date,
      confirmed: false,
      ...(input.reference ? { reference: input.reference } : {}),
    }
    const updatedTransfers = [...existingTransfers, newTransfer]

    const { data: updatedDeal, error: updateError } = await supabase
      .from('deals')
      .update({ eft_transfers: updatedTransfers })
      .eq('id', input.dealId)
      .select()
      .single()

    if (updateError) {
      console.error('EFT transfer error:', updateError.message)
      return { success: false, error: `Failed to record transfer: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'eft.record',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { amount: input.amount, date: input.date },
    })

    return { success: true, data: updatedDeal }
  } catch (err: any) {
    console.error('EFT transfer error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function confirmEftTransfer(input: {
  dealId: string
  transferIndex: number
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, eft_transfers')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }

    const transfers = deal.eft_transfers || []
    if (input.transferIndex < 0 || input.transferIndex >= transfers.length) {
      return { success: false, error: 'Invalid transfer index' }
    }

    transfers[input.transferIndex].confirmed = true

    const { data: updatedDeal, error: updateError } = await supabase
      .from('deals')
      .update({ eft_transfers: transfers })
      .eq('id', input.dealId)
      .select()
      .single()

    if (updateError) {
      return { success: false, error: `Failed to confirm transfer: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'eft.confirm',
      entityType: 'deal',
      entityId: input.dealId,
      severity: 'critical',
      metadata: { transfer_index: input.transferIndex, transfer: transfers[input.transferIndex] },
    })

    return { success: true, data: updatedDeal }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function removeEftTransfer(input: {
  dealId: string
  transferIndex: number
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, eft_transfers')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }

    const transfers = deal.eft_transfers || []
    if (input.transferIndex < 0 || input.transferIndex >= transfers.length) {
      return { success: false, error: 'Invalid transfer index' }
    }

    const removedTransfer = transfers[input.transferIndex]
    transfers.splice(input.transferIndex, 1)

    const { data: updatedDeal, error: updateError } = await supabase
      .from('deals')
      .update({ eft_transfers: transfers })
      .eq('id', input.dealId)
      .select()
      .single()

    if (updateError) {
      return { success: false, error: `Failed to remove transfer: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'eft.remove',
      entityType: 'deal',
      entityId: input.dealId,
      severity: 'critical',
      metadata: { transfer_index: input.transferIndex, removed_transfer: removedTransfer },
    })

    return { success: true, data: updatedDeal }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Brokerage Payment: Record incoming payment from brokerage
// ============================================================================

export async function recordBrokeragePayment(input: {
  dealId: string
  amount: number
  date: string
  reference?: string
  method?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (input.amount <= 0) return { success: false, error: 'Amount must be greater than 0' }

    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, status, amount_due_from_brokerage, brokerage_payments')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }
    if (!['funded', 'repaid'].includes(deal.status)) {
      return { success: false, error: 'Brokerage payments can only be recorded on funded or repaid deals' }
    }

    const existingPayments = deal.brokerage_payments || []
    const newPayment = {
      amount: input.amount,
      date: input.date,
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.method ? { method: input.method } : {}),
    }
    const updatedPayments = [...existingPayments, newPayment]

    // Calculate new total
    const newTotal = updatedPayments.reduce((sum: number, p: any) => sum + p.amount, 0)
    const updateData: Record<string, any> = { brokerage_payments: updatedPayments }

    // Store total as repayment_amount for reporting
    updateData.repayment_amount = newTotal

    const { data: updatedDeal, error: updateError } = await supabase
      .from('deals')
      .update(updateData)
      .eq('id', input.dealId)
      .select()
      .single()

    if (updateError) {
      console.error('Brokerage payment error:', updateError.message)
      return { success: false, error: `Failed to record payment: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'brokerage_payment.record',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { amount: input.amount, date: input.date, new_total: newTotal, expected: deal.amount_due_from_brokerage },
    })

    return { success: true, data: updatedDeal }
  } catch (err: any) {
    console.error('Brokerage payment error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function removeBrokeragePayment(input: {
  dealId: string
  paymentIndex: number
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, brokerage_payments')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }

    const payments = deal.brokerage_payments || []
    if (input.paymentIndex < 0 || input.paymentIndex >= payments.length) {
      return { success: false, error: 'Invalid payment index' }
    }

    const removedPayment = payments[input.paymentIndex]
    payments.splice(input.paymentIndex, 1)
    const newTotal = payments.reduce((sum: number, p: any) => sum + p.amount, 0)

    const { data: updatedDeal, error: updateError } = await supabase
      .from('deals')
      .update({
        brokerage_payments: payments,
        repayment_amount: payments.length > 0 ? newTotal : null,
      })
      .eq('id', input.dealId)
      .select()
      .single()

    if (updateError) {
      return { success: false, error: `Failed to remove payment: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'brokerage_payment.remove',
      entityType: 'deal',
      entityId: input.dealId,
      severity: 'critical',
      metadata: { payment_index: input.paymentIndex, removed_payment: removedPayment },
    })

    return { success: true, data: updatedDeal }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}
