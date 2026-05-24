'use server'

import crypto from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import { sendAgentInviteNotification, sendPaymentClaimSubmittedNotification } from '@/lib/email'
import { CreateAgentSchema } from '@/lib/validations'
import { insertPayment } from '@/lib/brokerage-payments'

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

// ============================================================================
// Submit a brokerage payment claim
//
// Brokerage admin logs "I sent $X via method Y on date Z, reference W". The
// entry lands in deals.brokerage_payments with status='pending' so it doesn't
// count toward repayment totals until an FF admin confirms a bank match. This
// is the brokerage-side counterpart to admin's recordBrokeragePayment.
// ============================================================================

const PAYMENT_METHODS = ['eft', 'wire', 'cheque', 'cash', 'other'] as const

export async function submitBrokeragePaymentClaim(input: {
  dealId: string
  amount: number
  date: string
  reference?: string
  method?: typeof PAYMENT_METHODS[number]
  notes?: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Your account is not linked to a brokerage' }

  // Basic validation
  if (!input.dealId) return { success: false, error: 'Deal is required' }
  if (!input.amount || input.amount <= 0) return { success: false, error: 'Amount must be greater than $0' }
  if (input.amount > 10_000_000) return { success: false, error: 'Amount exceeds maximum' }
  if (!input.date) return { success: false, error: 'Payment date is required' }
  // Validate date is not in the future
  const today = new Date()
  today.setHours(23, 59, 59, 999)
  const paymentDate = new Date(input.date + 'T00:00:00')
  if (Number.isNaN(paymentDate.getTime())) return { success: false, error: 'Invalid payment date' }
  if (paymentDate > today) return { success: false, error: 'Payment date cannot be in the future' }
  if (input.method && !PAYMENT_METHODS.includes(input.method)) {
    return { success: false, error: 'Invalid payment method' }
  }

  const serviceClient = createServiceRoleClient()

  // Verify the deal exists, is owned by this brokerage, and is in a payable state
  const { data: deal, error: dealError } = await serviceClient
    .from('deals')
    .select('id, brokerage_id, agent_id, status, property_address, amount_due_from_brokerage, brokerage_payments(status)')
    .eq('id', input.dealId)
    .single()

  if (dealError || !deal) return { success: false, error: 'Deal not found' }
  if (deal.brokerage_id !== profile.brokerage_id) {
    return { success: false, error: 'You do not have access to this deal' }
  }
  if (!['funded', 'completed'].includes(deal.status)) {
    return { success: false, error: 'Payments can only be recorded on funded or completed deals' }
  }

  // Block runaway duplicates: more than 3 outstanding pending claims is suspicious
  const existingPending = ((deal.brokerage_payments as { status: string }[]) || [])
    .filter((p) => p.status === 'pending').length
  if (existingPending >= 3) {
    return { success: false, error: 'There are already 3 pending payment claims on this deal. Please wait for confirmation before submitting more.' }
  }

  const amount = Math.round(input.amount * 100) / 100
  const reference = input.reference ? input.reference.slice(0, 200) : null
  const notes = input.notes ? input.notes.slice(0, 1000) : null
  const method = input.method || null

  let newEntry
  try {
    newEntry = await insertPayment(
      {
        dealId: input.dealId,
        brokerageId: profile.brokerage_id,
        amount,
        paymentDate: input.date,
        reference,
        method,
        notes,
        status: 'pending',
        submittedByRole: 'brokerage_admin',
        submittedByUserId: user.id,
      },
      serviceClient,
    )
  } catch (err: any) {
    console.error('Payment claim insert error:', err?.message)
    return { success: false, error: 'Failed to record payment claim' }
  }

  await logAuditEvent({
    action: 'brokerage_payment.claim_submitted',
    entityType: 'deal',
    entityId: input.dealId,
    metadata: {
      payment_id: newEntry.id,
      amount: newEntry.amount,
      date: newEntry.payment_date,
      method: newEntry.method,
      reference: newEntry.reference,
      submitted_by_user_id: user.id,
      brokerage_id: profile.brokerage_id,
    },
  })

  // Notify admin — wrapped in try/catch so a Resend hiccup never fails the action.
  // Awaited (not fire-and-forget) because Netlify can kill background work after return.
  try {
    const [{ data: brokerageData }, { data: agentData }] = await Promise.all([
      serviceClient
        .from('brokerages')
        .select('name')
        .eq('id', profile.brokerage_id!)
        .single(),
      serviceClient
        .from('agents')
        .select('first_name, last_name')
        .eq('id', deal.agent_id)
        .single(),
    ])
    await sendPaymentClaimSubmittedNotification({
      dealId: deal.id,
      propertyAddress: deal.property_address,
      brokerageName: brokerageData?.name || 'A brokerage',
      agentName: agentData ? `${agentData.first_name} ${agentData.last_name}` : 'Agent',
      amount: newEntry.amount,
      paymentDate: newEntry.payment_date,
      method: newEntry.method || undefined,
      reference: newEntry.reference || undefined,
    })
  } catch (err) {
    console.error('[brokerage-actions] payment claim notification dispatch failed:', err)
  }

  return { success: true, data: { paymentId: newEntry.id } }
}

// ============================================================================
// Get all deals (with payment claim state) for the authed brokerage
// Used by the dashboard's "Send a Payment" modal to populate the deal picker.
// ============================================================================

export async function getBrokeragePayableDeals(): Promise<ActionResult> {
  const { error: authErr, profile } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Your account is not linked to a brokerage' }

  const serviceClient = createServiceRoleClient()

  const { data, error } = await serviceClient
    .from('deals')
    .select(`
      id,
      property_address,
      status,
      amount_due_from_brokerage,
      closing_date,
      brokerage_payments ( id, amount, payment_date, reference, method, notes, status, submitted_by_role, submitted_at, reviewed_at, rejection_reason ),
      agents ( first_name, last_name )
    `)
    .eq('brokerage_id', profile.brokerage_id)
    .in('status', ['funded', 'completed'])
    .order('closing_date', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, data: { deals: data || [] } }
}
