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
}

export function getActionLabel(action: string): string {
  return ACTION_LABELS[action] || action.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
