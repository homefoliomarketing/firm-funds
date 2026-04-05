'use server'

import { createServiceRoleClient, createClient } from '@/lib/supabase/server'

// ============================================================================
// Agent Profile Actions
// ============================================================================

export async function updateAgentProfile(data: {
  agentId: string
  phone: string | null
  addressStreet: string | null
  addressCity: string | null
  addressProvince: string | null
  addressPostalCode: string | null
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

  const { error } = await serviceClient
    .from('agents')
    .update({
      phone: data.phone || null,
      address_street: data.addressStreet || null,
      address_city: data.addressCity || null,
      address_province: data.addressProvince || null,
      address_postal_code: data.addressPostalCode || null,
    })
    .eq('id', data.agentId)

  if (error) {
    console.error('Profile update error:', error.message)
    return { success: false, error: 'Failed to update profile' }
  }

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
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
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

  return { success: true }
}

export async function getAgentProfile(agentId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', data: null }

  const serviceClient = createServiceRoleClient()

  const { data: agent, error } = await serviceClient
    .from('agents')
    .select('*, brokerages(name)')
    .eq('id', agentId)
    .single()

  if (error || !agent) {
    return { success: false, error: 'Agent not found', data: null }
  }

  return { success: true, data: agent }
}
