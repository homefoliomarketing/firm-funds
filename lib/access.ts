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
