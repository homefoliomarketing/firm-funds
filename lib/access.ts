import type { AgentStatus, BrokerageStatus, StaffRole, UserProfile, UserRole } from '@/types/database'

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

// ============================================================================
// Internal staff capabilities — least-privilege roles (migration 102)
// ============================================================================
// Three internal tiers, each a bundle of fine-grained capabilities ("keys"):
//   owner    — Bud. Every key, including the dangerous/structural ones.
//   manager  — runs day-to-day ops: deals, KYC, audit, agent invites,
//              paperwork. NO money movement, NO brokerage onboarding, NO
//              credential resets, NO deletes, NO role management, NO view-as.
//   staff    — General Staff: read, communicate, chase documents. Nothing
//              that moves money, reveals private banking, or changes access.
//
// The capability check is enforced in server actions (the real boundary,
// because mutations use the service-role client which bypasses RLS) and,
// as defense in depth, in proxy.ts route gating + in-page checks.
//
// super_admin is ALWAYS treated as owner. A firm_funds_admin without a
// staff_role defaults to manager (safe non-owner default; see migration 102).
// ============================================================================

export type Capability =
  | 'read' // baseline internal read access (dashboards, deals, agents, reports)
  | 'comms' // send/dismiss messages, internal admin notes
  | 'documents.write' // upload / request / fulfill / return deal documents
  | 'documents.delete' // delete deal documents
  | 'deal.underwrite' // checklist, approve/deny, assignments, amendments, closing date
  | 'deal.delete' // hard-delete a (non-funded) deal
  | 'money.write' // ALL money movement + funding a deal + balances/interest/strikes/invoices/remittance
  | 'kyc.verify' // verify / reject KYC
  | 'pii.identity' // open government ID documents
  | 'pii.banking' // open banking pre-auth forms / brokerage banking docs
  | 'audit.read' // read the audit log
  | 'audit.export' // export the audit log
  | 'agent.invite' // create / invite / bulk-import agents
  | 'brokerage.manage' // create/update brokerages, invite brokerage admins, BCA, setup links
  | 'users.credentials' // reset password / change login email / resend (password-resetting) welcome
  | 'account.archive' // reversible archive (disable login) of an agent or brokerage
  | 'account.delete' // soft-delete (quarantine) + permanent purge of an agent or brokerage
  | 'esign.deal' // send / void deal CPAs, amended CPAs, remediation IDPs
  | 'pipe.config' // configure firm-deal Google-Sheet ingestion pipes
  | 'firmdeal.review' // approve / reject / resolve firm-deal offers
  | 'roles.manage' // assign internal staff tiers (owner only)
  | 'impersonate' // "view as user" (owner only)

export const ALL_CAPABILITIES: readonly Capability[] = [
  'read',
  'comms',
  'documents.write',
  'documents.delete',
  'deal.underwrite',
  'deal.delete',
  'money.write',
  'kyc.verify',
  'pii.identity',
  'pii.banking',
  'audit.read',
  'audit.export',
  'agent.invite',
  'brokerage.manage',
  'users.credentials',
  'account.archive',
  'account.delete',
  'esign.deal',
  'pipe.config',
  'firmdeal.review',
  'roles.manage',
  'impersonate',
]

// Manager: everything operational, none of the dangerous/structural keys.
// Excludes (owner-only): money.write, deal.delete, brokerage.manage,
// users.credentials, account.delete, pii.banking, roles.manage, impersonate.
const MANAGER_CAPABILITIES: readonly Capability[] = [
  'read',
  'comms',
  'documents.write',
  'documents.delete',
  'deal.underwrite',
  'kyc.verify',
  'pii.identity',
  'audit.read',
  'audit.export',
  'agent.invite',
  'account.archive',
  'esign.deal',
  'pipe.config',
  'firmdeal.review',
]

// General Staff: read, communicate, chase paperwork. Nothing else.
const STAFF_CAPABILITIES: readonly Capability[] = ['read', 'comms', 'documents.write']

const STAFF_ROLE_CAPABILITIES: Record<StaffRole, ReadonlySet<Capability>> = {
  owner: new Set(ALL_CAPABILITIES),
  manager: new Set(MANAGER_CAPABILITIES),
  staff: new Set(STAFF_CAPABILITIES),
}

const NO_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>()

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'General Staff',
}

export const ASSIGNABLE_STAFF_ROLES: readonly StaffRole[] = ['owner', 'manager', 'staff']

/**
 * Resolve a profile to its internal staff tier.
 * super_admin -> always 'owner'. firm_funds_admin -> its staff_role, defaulting
 * to 'manager' (safe non-owner default). Non-internal roles -> null.
 */
export function resolveStaffRole(
  profile: Pick<UserProfile, 'role' | 'staff_role'> | null | undefined,
): StaffRole | null {
  if (!profile) return null
  if (profile.role === 'super_admin') return 'owner'
  if (profile.role === 'firm_funds_admin') return profile.staff_role ?? 'manager'
  return null
}

/** The full capability set for a profile (empty for non-internal users). */
export function getCapabilities(
  profile: Pick<UserProfile, 'role' | 'staff_role'> | null | undefined,
): ReadonlySet<Capability> {
  const tier = resolveStaffRole(profile)
  return tier ? STAFF_ROLE_CAPABILITIES[tier] : NO_CAPABILITIES
}

/** Does this profile hold a given capability? */
export function hasCapability(
  profile: Pick<UserProfile, 'role' | 'staff_role'> | null | undefined,
  capability: Capability,
): boolean {
  return getCapabilities(profile).has(capability)
}

/** Owner is the only tier that can manage roles and view-as. */
export function isOwner(
  profile: Pick<UserProfile, 'role' | 'staff_role'> | null | undefined,
): boolean {
  return resolveStaffRole(profile) === 'owner'
}

// Sub-paths under /admin that need more than baseline internal read access.
// proxy.ts bounces a staffer lacking the capability back to /admin; the page's
// own check + the server-action gates are the real boundary. Keep this list to
// pages that are ENTIRELY about a restricted capability — mixed hubs (deals,
// brokerages) stay readable and rely on per-button action gates.
export const ADMIN_ROUTE_CAPABILITIES: ReadonlyArray<readonly [string, Capability]> = [
  ['/admin/balance-adjustment', 'money.write'],
  ['/admin/payments', 'money.write'],
  ['/admin/audit', 'audit.read'],
]
