// ============================================================================
// Brokerage admin sub-role helpers
// ============================================================================
// Pure-function helpers shared by server actions, server components, and
// client components. Kept outside the `'use server'` file in
// lib/actions/brokerage-admin-actions.ts because Next.js 16 forbids
// non-async exports from server-action modules.
// ============================================================================

export type BrokerageAdminRole =
  | 'broker_of_record'
  | 'brokerage_manager'
  | 'brokerage_admin'

export const ALL_BROKERAGE_ADMIN_ROLES: readonly BrokerageAdminRole[] = [
  'broker_of_record',
  'brokerage_manager',
  'brokerage_admin',
] as const

/** Roles that can manage other team admins inside their own brokerage. */
const MANAGER_ROLES: readonly BrokerageAdminRole[] = [
  'broker_of_record',
  'brokerage_manager',
]

export function canManageBrokerageTeam(
  role: BrokerageAdminRole | null | undefined,
): boolean {
  if (!role) return false
  return MANAGER_ROLES.includes(role)
}

export const BROKERAGE_ADMIN_ROLE_LABEL: Record<BrokerageAdminRole, string> = {
  broker_of_record: 'Broker of Record',
  brokerage_manager: 'Brokerage Manager',
  brokerage_admin: 'Brokerage Admin',
}

/**
 * Shape returned by listBrokerageAdmins. Pulled here so consumers can
 * import the type without crossing the `'use server'` boundary, which
 * Next.js 16 forbids for non-async exports.
 */
export interface BrokerageAdmin {
  id: string
  brokerage_id: string
  user_id: string
  role: BrokerageAdminRole
  invited_at: string | null
  accepted_at: string | null
  created_by: string | null
  full_name?: string | null
  email?: string | null
  last_login?: string | null
}
