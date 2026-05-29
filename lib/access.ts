import type { AgentStatus, BrokerageStatus, UserProfile, UserRole } from '@/types/database'

export const INTERNAL_ADMIN_ROLES: readonly UserRole[] = ['super_admin', 'firm_funds_admin']

export function isInternalAdminRole(role: string | null | undefined): role is 'super_admin' | 'firm_funds_admin' {
  return role === 'super_admin' || role === 'firm_funds_admin'
}

export function getProfileStatusError(profile: Pick<UserProfile, 'role' | 'is_active'>): string | null {
  if (profile.is_active) return null

  return profile.role === 'agent' || profile.role === 'brokerage_admin'
    ? 'Your account is inactive. Please contact Firm Funds support.'
    : 'This admin account is inactive.'
}

export function getAgentStatusError(agent: {
  status: AgentStatus
  flagged_by_brokerage: boolean
}): string | null {
  if (agent.status !== 'active') {
    return 'Your agent account is not active. Please contact your brokerage or Firm Funds support.'
  }

  if (agent.flagged_by_brokerage) {
    return 'Your agent account is flagged. Please contact your brokerage or Firm Funds support.'
  }

  return null
}

export function isActiveBrokerageStatus(status: BrokerageStatus | null | undefined) {
  return status === 'active'
}

export function getBrokerageStatusError(status: BrokerageStatus | null | undefined, role: UserRole): string | null {
  if (isActiveBrokerageStatus(status)) return null

  return role === 'brokerage_admin'
    ? 'Your brokerage account is not active. Please contact Firm Funds support.'
    : 'Your brokerage is not active. Please contact Firm Funds support.'
}

// ============================================================================
// Referral-fee visibility
// ============================================================================
// Referral fees are commercially sensitive — brokerages don't want every
// office assistant or junior admin seeing what the brokerage earns back from
// Firm Funds. The convention is to limit visibility to the senior contacts
// on file: the Broker of Record (regulatory contact, signs the BCA) and the
// Brokerage Manager (day-to-day owner of the relationship). Those titles are
// captured in user_profiles.staff_title as free-form text — matched case-
// insensitively here so "broker of record", "Broker Of Record" and the like
// all qualify. Anyone else with role='brokerage_admin' (including the
// default-titled admin who was seeded before staff_title existed) is
// blocked. Firm Funds super_admin / firm_funds_admin never go through this
// path — they hit the admin reports page instead.
// ============================================================================
const REFERRAL_FEE_VISIBLE_TITLES = new Set([
  'broker of record',
  'brokerage manager',
])

export function canViewBrokerageReferralFees(
  staffTitle: string | null | undefined,
): boolean {
  if (!staffTitle) return false
  return REFERRAL_FEE_VISIBLE_TITLES.has(staffTitle.trim().toLowerCase())
}
