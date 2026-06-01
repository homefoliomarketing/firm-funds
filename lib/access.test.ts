import { describe, it, expect } from 'vitest'
import {
  isInternalAdminRole,
  canViewBrokerageReferralFees,
  getProfileStatusError,
  getAgentStatusError,
  isActiveBrokerageStatus,
  getBrokerageStatusError,
} from './access'

describe('isInternalAdminRole', () => {
  it('true for internal admin roles', () => {
    expect(isInternalAdminRole('super_admin')).toBe(true)
    expect(isInternalAdminRole('firm_funds_admin')).toBe(true)
  })

  it('false for non-admin roles and falsy/odd inputs', () => {
    expect(isInternalAdminRole('agent')).toBe(false)
    expect(isInternalAdminRole('brokerage_admin')).toBe(false)
    expect(isInternalAdminRole(null)).toBe(false)
    expect(isInternalAdminRole(undefined)).toBe(false)
    expect(isInternalAdminRole('')).toBe(false)
    expect(isInternalAdminRole('Super_Admin')).toBe(false) // wrong case
    expect(isInternalAdminRole('SUPER_ADMIN')).toBe(false)
  })
})

describe('canViewBrokerageReferralFees', () => {
  it('true for qualifying titles with mixed case and surrounding whitespace', () => {
    expect(canViewBrokerageReferralFees('broker of record')).toBe(true)
    expect(canViewBrokerageReferralFees('Broker Of Record')).toBe(true)
    expect(canViewBrokerageReferralFees('  BROKER OF RECORD  ')).toBe(true)
    expect(canViewBrokerageReferralFees('brokerage manager')).toBe(true)
    expect(canViewBrokerageReferralFees('Brokerage Manager')).toBe(true)
    expect(canViewBrokerageReferralFees(' brokerage manager ')).toBe(true)
  })

  it('false for null/empty/non-qualifying titles', () => {
    expect(canViewBrokerageReferralFees(null)).toBe(false)
    expect(canViewBrokerageReferralFees(undefined)).toBe(false)
    expect(canViewBrokerageReferralFees('')).toBe(false)
    expect(canViewBrokerageReferralFees('   ')).toBe(false)
    expect(canViewBrokerageReferralFees('office admin')).toBe(false)
    expect(canViewBrokerageReferralFees('broker')).toBe(false)
    expect(canViewBrokerageReferralFees('manager')).toBe(false)
  })
})

describe('getProfileStatusError', () => {
  it('returns null for active profiles', () => {
    expect(getProfileStatusError({ role: 'agent', is_active: true })).toBeNull()
    expect(getProfileStatusError({ role: 'super_admin', is_active: true })).toBeNull()
  })

  it('agent / brokerage_admin get the user-facing inactive message', () => {
    const msg = 'Your account is inactive. Please contact Firm Funds support.'
    expect(getProfileStatusError({ role: 'agent', is_active: false })).toBe(msg)
    expect(getProfileStatusError({ role: 'brokerage_admin', is_active: false })).toBe(msg)
  })

  it('admins get the admin inactive message', () => {
    expect(getProfileStatusError({ role: 'super_admin', is_active: false })).toBe('This admin account is inactive.')
    expect(getProfileStatusError({ role: 'firm_funds_admin', is_active: false })).toBe('This admin account is inactive.')
  })
})

describe('getAgentStatusError', () => {
  it('null when active and not flagged', () => {
    expect(getAgentStatusError({ status: 'active', flagged_by_brokerage: false })).toBeNull()
  })

  it('non-active status returns the inactive message (takes priority over flag check)', () => {
    const msg = 'Your agent account is not active. Please contact your brokerage or Firm Funds support.'
    expect(getAgentStatusError({ status: 'inactive', flagged_by_brokerage: false })).toBe(msg)
    expect(getAgentStatusError({ status: 'suspended', flagged_by_brokerage: true })).toBe(msg)
  })

  it('active but flagged returns the flagged message', () => {
    expect(getAgentStatusError({ status: 'active', flagged_by_brokerage: true })).toBe(
      'Your agent account is flagged. Please contact your brokerage or Firm Funds support.',
    )
  })
})

describe('isActiveBrokerageStatus', () => {
  it('true only for active', () => {
    expect(isActiveBrokerageStatus('active')).toBe(true)
    expect(isActiveBrokerageStatus('suspended')).toBe(false)
    expect(isActiveBrokerageStatus('inactive')).toBe(false)
    expect(isActiveBrokerageStatus(null)).toBe(false)
    expect(isActiveBrokerageStatus(undefined)).toBe(false)
  })
})

describe('getBrokerageStatusError', () => {
  it('null for active brokerage', () => {
    expect(getBrokerageStatusError('active', 'brokerage_admin')).toBeNull()
    expect(getBrokerageStatusError('active', 'agent')).toBeNull()
  })

  it('brokerage_admin gets the brokerage-admin worded message', () => {
    expect(getBrokerageStatusError('suspended', 'brokerage_admin')).toBe(
      'Your brokerage account is not active. Please contact Firm Funds support.',
    )
  })

  it('non brokerage_admin roles get the generic worded message', () => {
    expect(getBrokerageStatusError('inactive', 'agent')).toBe(
      'Your brokerage is not active. Please contact Firm Funds support.',
    )
  })
})
