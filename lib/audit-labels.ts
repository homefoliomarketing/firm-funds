// ============================================================================
// Audit Labels & Client-Safe Utilities
// ============================================================================
// This file contains NO 'use server' directive — safe to import in client components.
// Separated from lib/audit.ts because Next.js 16 'use server' files require
// all exports to be async functions (server actions).
// ============================================================================

export type AuditSeverity = 'info' | 'warning' | 'critical'

// ============================================================================
// Human-Readable Action Labels
// ============================================================================

export const ACTION_LABELS: Record<string, string> = {
  'deal.submit':              'Deal Submitted',
  'deal.status_change':       'Status Changed',
  'deal.edit':                'Deal Edited',
  'deal.cancel':              'Deal Cancelled',
  'deal.withdrawn':           'Deal Withdrawn',
  'deal.delete':              'Deal Deleted',
  'deal.closing_date_updated':'Closing Date Changed',
  'deal.admin_notes_updated': 'Admin Notes Updated',
  'deal.admin_note_added':    'Admin Note Added',
  'deal.firm_deal_offer_manually_nudged': 'Brokerage Reminded By Agent',
  'document.upload':          'Document Uploaded',
  'document.delete':          'Document Deleted',
  'document.view':            'Document Viewed',
  'document.request':         'Document Requested',
  'document.request_fulfilled':'Document Request Fulfilled',
  'document.request_cancelled':'Document Request Cancelled',
  'checklist.toggle':         'Checklist Item Toggled',
  'agent.create':             'Agent Created',
  'agent.update':             'Agent Updated',
  'agent.archive':            'Agent Archived',
  'agent.invite':             'Agent Invited',
  'agent.resend_welcome':     'Welcome Email Resent',
  'agent.bulk_import':        'Bulk Agent Import',
  'agent.kyc_submit':         'KYC Submitted',
  'agent.kyc_submit_mobile':  'KYC Submitted (Mobile)',
  'agent.kyc_verify':         'KYC Verified',
  'agent.kyc_reject':         'KYC Rejected',
  'agent.kyc_mobile_link_sent':'KYC Mobile Link Sent',
  'brokerage.create':         'Brokerage Created',
  'brokerage.update':         'Brokerage Updated',
  'brokerage.kyc_verify':     'Brokerage KYC Verified',
  'brokerage.kyc_revoke':     'Brokerage KYC Revoked',
  'user.create':              'User Account Created',
  'user.password_changed':    'Password Changed',
  'user.role_change':         'User Role Changed',
  'eft.record':               'EFT Recorded',
  'eft.confirm':              'EFT Confirmed',
  'eft.remove':               'EFT Removed',
  'brokerage_payment.record': 'Brokerage Payment Recorded',
  'brokerage_payment.remove': 'Brokerage Payment Removed',
  'auth.login':               'Logged In',
  'auth.login_failed':        'Login Failed',
  'auth.logout':              'Logged Out',
  'auth.session_timeout':     'Session Timed Out',
  'impersonation.start':      'Started Viewing As User',
  'impersonation.stop':       'Stopped Viewing As User',
  'impersonation.blocked':    'Action Blocked (Viewing As User)',
}

export function getActionLabel(action: string): string {
  return ACTION_LABELS[action] || action.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Every audit action that records a dollar moving or a compliance decision.
 * Strings here are verified against logAuditEvent / logAuditEventServiceRole
 * calls in the codebase — do not add an action name that is not actually
 * emitted somewhere. Powers the "Money & compliance" preset in the audit page.
 *
 * Lives here (a plain, client-safe module) rather than in the 'use server'
 * audit-actions.ts: a 'use server' file may only export async functions, so a
 * runtime const there is a violation that the Turbopack dev compiler rejects.
 */
export const MONEY_AND_COMPLIANCE_ACTIONS = [
  // Manual and automatic balance movements
  'account.manual_adjustment',
  'account.adjustment',
  'account.balance_deduction',
  'account.late_payment_interest',
  'deal.balance_deduction_reversed',
  // Funding lifecycle (status_change carries approved -> funded -> completed)
  'deal.status_change',
  'deal.early_closing_recorded',
  // EFT transfers
  'eft.record',
  'eft.confirm',
  'eft.remove',
  // Brokerage payments
  'brokerage_payment.record',
  'brokerage_payment.remove',
  'brokerage_payment.claim_submitted',
  // Brokerage late strikes
  'brokerage.late_strike_recorded',
  'brokerage.late_strikes_reset',
  // Remediation remittance
  'remediation_deal.remitted',
  // KYC compliance decisions
  'agent.kyc_verify',
  'agent.kyc_reject',
  'brokerage.kyc_verify',
  'brokerage.kyc_revoke',
] as const
