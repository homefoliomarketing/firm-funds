'use server'

import { createClient } from '@/lib/supabase/server'
import { reconcileUserEmail } from '@/lib/email-reconcile'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import {
  getAgentStatusError,
  getBrokerageStatusError,
  getProfileStatusError,
  hasCapability,
  INTERNAL_ADMIN_ROLES,
  type Capability,
} from '@/lib/access'
import { resolveActiveImpersonation } from '@/lib/impersonation'
import type { AgentStatus, BrokerageStatus, UserProfile, UserRole } from '@/types/database'

// ============================================================================
// Types
// ============================================================================

interface AuthResult {
  error: string | null
  user: User | null
  profile: UserProfile | null
  supabase: SupabaseClient
  // Impersonation ("view as user"). When an Owner is viewing-as another user,
  // `user`/`profile` are swapped to the TARGET so read paths render the
  // target's data, `isImpersonating` is true, and `realUser`/`realProfile`
  // carry the actual signed-in staffer (who remains the audit actor). For
  // normal requests these are false/undefined and behavior is unchanged.
  isImpersonating?: boolean
  realUser?: User | null
  realProfile?: UserProfile | null
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
 * Get the current authenticated internal staffer AND verify they hold a
 * specific capability (least-privilege roles — migration 102).
 *
 * Drop-in replacement for getAuthenticatedAdmin() in any server action that is
 * more sensitive than baseline read access. Returns the same AuthResult shape;
 * on a missing capability it returns a permission error while still including
 * the resolved profile so the caller can audit the denial if it wants.
 *
 * super_admin holds every capability; firm_funds_admin holds the subset for
 * its staff_role (owner / manager / staff). See lib/access.ts.
 */
export async function getAuthenticatedCapable(capability: Capability): Promise<AuthResult> {
  const result = await getAuthenticatedUser(INTERNAL_ADMIN_ROLES)
  if (result.error) return result

  if (!hasCapability(result.profile, capability)) {
    return {
      error: 'You do not have permission to perform this action.',
      user: result.user,
      profile: result.profile,
      supabase: result.supabase,
    }
  }

  return result
}

/**
 * Like getAuthenticatedUser, but for MUTATIONS. Refuses while the caller is
 * viewing-as another user (impersonation is look-only). Use this in agent /
 * brokerage self-service WRITE actions so an Owner who is "viewing as" the user
 * cannot change the target's data. Reads keep using getAuthenticatedUser so
 * dashboards still render the target's world.
 *
 * Admin/money/destructive actions do not need this: they go through
 * getAuthenticatedAdmin / getAuthenticatedCapable, which already deny during a
 * view-as (the resolved target holds no admin role / capabilities).
 */
export async function getAuthenticatedWriter(requiredRoles?: readonly UserRole[]): Promise<AuthResult> {
  const result = await getAuthenticatedUser(requiredRoles)
  if (result.error) return result
  if (result.isImpersonating) {
    return {
      ...result,
      error: 'You are viewing as another user (look-only) and cannot make changes. Exit view-as first.',
    }
  }
  return result
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

  // Reconcile the REAL identity's email before any impersonation swap, so the
  // cross-device safety net never runs against the target's profile.
  await maybeReconcileEmail(user, profile)

  // Impersonation ("view as user"). Only Owners can have an active session
  // (resolveActiveImpersonation returns null otherwise without a DB hit), so
  // this is a no-op for every normal user and preserves existing behavior.
  const impersonation = await resolveActiveImpersonation(profile)
  if (impersonation) {
    const targetProfile = impersonation.targetProfile

    // Admin/elevated callers (requiredRoles the target does NOT hold, e.g.
    // getAuthenticatedAdmin / getAuthenticatedCapable) are BLOCKED while
    // viewing-as: the staffer is "being" a non-privileged user and must Exit
    // first. This is the code-level half of the look-only guarantee (the proxy
    // blocks the transport). Read paths that the target legitimately holds
    // (e.g. an agent page calling getAuthenticatedUser(['agent'])) fall through
    // and render the target's data.
    if (requiredRoles && !requiredRoles.includes(targetProfile.role)) {
      return {
        error: 'This action is not available while you are viewing as another user. Exit view-as first.',
        user,
        profile,
        supabase,
        isImpersonating: true,
        realUser: user,
        realProfile: profile,
      }
    }

    // Swap the effective identity to the target for reads. The supabase client
    // is left as the real staffer's (super_admin RLS = read-all), and the
    // explicit agent_id/brokerage_id filters in the dashboards scope it to the
    // target. Writes never reach here — the proxy blocks all state-changing
    // requests while a view-as session is active.
    const effectiveUser = { ...user, id: targetProfile.id, email: targetProfile.email ?? user.email } as User
    return {
      error: null,
      user: effectiveUser,
      profile: targetProfile,
      supabase,
      isImpersonating: true,
      realUser: user,
      realProfile: profile,
    }
  }

  if (requiredRoles && !requiredRoles.includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

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
