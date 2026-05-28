'use server'

import { createClient } from '@/lib/supabase/server'
import { reconcileUserEmail } from '@/lib/email-reconcile'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import {
  getAgentStatusError,
  getBrokerageStatusError,
  getProfileStatusError,
  INTERNAL_ADMIN_ROLES,
} from '@/lib/access'
import type { AgentStatus, BrokerageStatus, UserProfile, UserRole } from '@/types/database'

// ============================================================================
// Types
// ============================================================================

interface AuthResult {
  error: string | null
  user: User | null
  profile: UserProfile | null
  supabase: SupabaseClient
}

interface AgentAccessRecord {
  id: string
  brokerage_id: string | null
  status: AgentStatus
  flagged_by_brokerage: boolean
}

interface BrokerageAccessRecord {
  id: string
  status: BrokerageStatus
}

// ============================================================================
// Shared auth helpers — used by admin-actions, kyc-actions, report-actions, deal-actions
// ============================================================================

/**
 * Get the current authenticated user, verify they have an admin role
 * (super_admin or firm_funds_admin), and return their profile + supabase client.
 */
export async function getAuthenticatedAdmin(): Promise<AuthResult> {
  return getAuthenticatedUser(INTERNAL_ADMIN_ROLES)
}

/**
 * Get the current authenticated user with optional role check.
 * If requiredRoles is provided, verifies the user has one of those roles.
 */
export async function getAuthenticatedUser(requiredRoles?: readonly UserRole[]): Promise<AuthResult> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: 'Not authenticated', user: null, profile: null, supabase }
  }

  const { data: profileData } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  const profile = profileData as UserProfile | null
  if (!profile) {
    return { error: 'User profile not found', user, profile: null, supabase }
  }

  const statusError = await validateProfileIsAllowed(supabase, profile)
  if (statusError) {
    return { error: statusError, user, profile, supabase }
  }

  if (requiredRoles && !requiredRoles.includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

  await maybeReconcileEmail(user, profile)

  return { error: null, user, profile, supabase }
}

async function getBrokerageStatus(
  supabase: SupabaseClient,
  brokerageId: string | null
): Promise<BrokerageStatus | null> {
  if (!brokerageId) return null

  const { data: brokerage } = await supabase
    .from('brokerages')
    .select('id, status')
    .eq('id', brokerageId)
    .single()

  return (brokerage as BrokerageAccessRecord | null)?.status ?? null
}

async function validateProfileIsAllowed(
  supabase: SupabaseClient,
  profile: UserProfile
): Promise<string | null> {
  const profileStatusError = getProfileStatusError(profile)
  if (profileStatusError) return profileStatusError

  if (profile.role === 'agent') {
    if (!profile.agent_id) return 'No agent profile linked to your account'

    const { data: agent } = await supabase
      .from('agents')
      .select('id, brokerage_id, status, flagged_by_brokerage')
      .eq('id', profile.agent_id)
      .single()

    const agentRecord = agent as AgentAccessRecord | null
    if (!agentRecord) return 'Agent profile not found'

    const agentStatusError = getAgentStatusError(agentRecord)
    if (agentStatusError) return agentStatusError

    const brokerageStatus = await getBrokerageStatus(supabase, agentRecord.brokerage_id)
    const brokerageStatusError = getBrokerageStatusError(brokerageStatus, profile.role)
    if (brokerageStatusError) return brokerageStatusError
  }

  if (profile.role === 'brokerage_admin') {
    const brokerageStatus = await getBrokerageStatus(supabase, profile.brokerage_id)
    const brokerageStatusError = getBrokerageStatusError(brokerageStatus, profile.role)
    if (brokerageStatusError) return brokerageStatusError
  }

  return null
}

// Finding #42 follow-up: safety net for the cross-device case. If the user
// initiated an email change here but confirmed it on a phone that isn't
// logged in to this app, the dedicated /auth/email-confirmed route never
// runs. Reconcile on the next authenticated server-action call instead.
async function maybeReconcileEmail(user: User, profile: UserProfile): Promise<void> {
  const authEmail = user.email ?? null
  const profileEmail = profile?.email ?? null
  if (!authEmail || !profile?.id) return
  if (authEmail.toLowerCase() === (profileEmail ?? '').toLowerCase()) return

  try {
    const result = await reconcileUserEmail({
      userId: profile.id,
      authEmail,
      profileEmail,
    })
    if (result.changed && result.newEmail) {
      profile.email = result.newEmail
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.warn(`[auth-helpers] email reconcile failed: ${message}`)
  }
}
