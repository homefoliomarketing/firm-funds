// =============================================================================
// Firm Funds Business Constants
// =============================================================================
// ALL business-critical values are defined here. Do NOT hardcode these values
// anywhere else in the codebase. Import from this file.
// =============================================================================

/** Discount rate: $0.75 per $1,000 of net commission per day until closing */
export const DISCOUNT_RATE_PER_1000_PER_DAY = 0.75

/** Default brokerage referral fee: 20% of the discount fee */
export const DEFAULT_BROKERAGE_REFERRAL_PCT = 0.20

/** Maximum daily EFT transfer amount */
export const MAX_DAILY_EFT = 25_000

/** Minimum days until closing for a deal to be eligible */
export const MIN_DAYS_UNTIL_CLOSING = 1

/** Maximum days until closing for a deal to be eligible */
export const MAX_DAYS_UNTIL_CLOSING = 120

/** Grace period (days) after closing before late interest starts */
export const LATE_CLOSING_GRACE_DAYS = 5

/** Maximum gross commission allowed (sanity check) */
export const MAX_GROSS_COMMISSION = 1_000_000

/** Minimum gross commission allowed */
export const MIN_GROSS_COMMISSION = 1

/** Maximum file upload size in bytes (25MB) */
export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024

/** Allowed file upload MIME types */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/gif',
  'text/csv',
  'text/plain',
] as const

/** Allowed file extensions for upload */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.jpg', '.jpeg', '.png', '.gif', '.csv', '.txt',
] as const

/** Allowed document types (must match DB check constraint) */
export const DOCUMENT_TYPES = [
  { value: 'aps', label: 'Agreement of Purchase and Sale' },
  { value: 'amendment', label: 'Amendment' },
  { value: 'trade_record', label: 'Trade Record Sheet / Deal Sheet' },
  { value: 'mls_listing', label: 'MLS Listing' },
  { value: 'commission_agreement', label: 'Commission Agreement' },
  { value: 'direction_to_pay', label: 'Direction to Pay' },
  { value: 'notice_of_fulfillment', label: 'Notice of Fulfillment/Waiver' },
  { value: 'kyc_fintrac', label: 'KYC / FINTRAC Documents' },
  { value: 'id_verification', label: 'Agent ID Verification' },
  { value: 'other', label: 'Other' },
] as const

/** Valid document type values for DB constraint */
export const VALID_DOCUMENT_TYPE_VALUES = DOCUMENT_TYPES.map(d => d.value)

/** Valid upload source values (must match DB check constraint) */
export const VALID_UPLOAD_SOURCES = ['nexone_auto', 'manual_upload'] as const

/** Session inactivity timeout for admin users (ms) — 15 minutes */
export const ADMIN_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000

/** Session inactivity timeout for agent users (ms) — 30 minutes */
export const AGENT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000

/** User roles */
export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  FIRM_FUNDS_ADMIN: 'firm_funds_admin',
  BROKERAGE_ADMIN: 'brokerage_admin',
  AGENT: 'agent',
} as const

/** Admin roles that can access /admin routes */
export const ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.FIRM_FUNDS_ADMIN] as const

/** Deal statuses */
export const DEAL_STATUSES = {
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  FUNDED: 'funded',
  COMPLETED: 'completed',
  DENIED: 'denied',
  CANCELLED: 'cancelled',
} as const

// =============================================================================
// Status Badge Styles (shared across all portals)
// =============================================================================
// IMPORTANT: These are the single source of truth for status badge colors.
// Import from here — do NOT duplicate in page components.
// =============================================================================

export const STATUS_BADGE_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  under_review: { bg: '#1A2240', text: '#7B9FE0', border: '#2D3A5C' },
  approved:     { bg: '#0F2A18', text: '#5FA873', border: '#1E4A2C' },
  funded:       { bg: '#1F1535', text: '#A385D0', border: '#352A50' },
  completed:    { bg: '#0F2A24', text: '#5FB8A0', border: '#1E4A3C' },
  denied:       { bg: '#2A1212', text: '#E07B7B', border: '#4A2020' },
  cancelled:    { bg: '#2A1F0F', text: '#D4A04A', border: '#4A3820' },
}

/** Helper: get inline style object for a status badge */
export function getStatusBadgeStyle(status: string) {
  const s = STATUS_BADGE_STYLES[status] || STATUS_BADGE_STYLES.completed
  return { backgroundColor: s.bg, color: s.text, border: `1px solid ${s.border}` }
}

// =============================================================================
// FINTRAC KYC Constants
// =============================================================================

/** Acceptable government-issued photo ID types for agent KYC */
export const KYC_DOCUMENT_TYPES = [
  { value: 'drivers_license', label: "Ontario Driver's Licence" },
  { value: 'passport', label: 'Canadian Passport' },
  { value: 'ontario_photo_card', label: 'Ontario Photo Card' },
  { value: 'permanent_resident_card', label: 'Permanent Resident Card' },
  { value: 'citizenship_card', label: 'Canadian Citizenship Card' },
] as const

/** Agent KYC statuses */
export const KYC_STATUSES = {
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
} as const

/** KYC status badge styles */
export const KYC_STATUS_BADGE_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  pending:   { bg: '#2A1F0F', text: '#D4A04A', border: '#4A3820' },
  submitted: { bg: '#1A2240', text: '#7B9FE0', border: '#2D3A5C' },
  verified:  { bg: '#0F2A18', text: '#5FA873', border: '#1E4A2C' },
  rejected:  { bg: '#2A1212', text: '#E07B7B', border: '#4A2020' },
}

/** Helper: get inline style object for a KYC status badge */
export function getKycBadgeStyle(status: string) {
  const s = KYC_STATUS_BADGE_STYLES[status] || KYC_STATUS_BADGE_STYLES.pending
  return { backgroundColor: s.bg, color: s.text, border: `1px solid ${s.border}` }
}

/** Max file size for KYC document upload (10MB) */
export const MAX_KYC_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024

/** Allowed MIME types for KYC document upload */
export const ALLOWED_KYC_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const

/** RECO Public Register URL */
export const RECO_PUBLIC_REGISTER_URL = 'https://registrantsearch.reco.on.ca/'

/** Helper: format status string for display */
export function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

/**
 * Calculate days between today (Eastern Time) and a closing date string (YYYY-MM-DD).
 * Uses America/Toronto timezone to avoid server-timezone inconsistencies.
 * Returns number of calendar days (minimum 0).
 */
export function calcDaysUntilClosing(closingDateStr: string): number {
  // Get today's date in Eastern Time as YYYY-MM-DD
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) // 'en-CA' gives YYYY-MM-DD format
  const todayMs = new Date(todayET + 'T00:00:00Z').getTime()
  const closingMs = new Date(closingDateStr + 'T00:00:00Z').getTime()
  return Math.ceil((closingMs - todayMs) / (1000 * 60 * 60 * 24))
}

// =============================================================================
// Admin Quick-Reply Message Templates
// =============================================================================

export const ADMIN_QUICK_REPLIES = [
  {
    label: 'Request APS',
    message: 'Hi! We need your Agreement of Purchase & Sale (including all schedules and the confirmation of co-operation) to proceed with underwriting. Please upload it to your deal page at your earliest convenience.',
  },
  {
    label: 'Request NOF/Waiver',
    message: 'Could you please upload the Notice of Fulfillment or Waiver for this deal? We need it to confirm the deal is unconditional.',
  },
  {
    label: 'Closing Date Update',
    message: 'We noticed the closing date on this deal may have changed. Could you confirm the current closing date? If it has changed, please update it on your deal page.',
  },
  {
    label: 'Deal Approved',
    message: 'Great news — your advance request has been approved! We are processing the funds and will notify you once the transfer is complete.',
  },
  {
    label: 'Missing Documents',
    message: 'We are missing some documents needed to complete underwriting on this deal. Please check your deal page for any outstanding items and upload them as soon as possible.',
  },
  {
    label: 'General Follow-Up',
    message: 'Hi! Just following up on this deal. If you have any questions or need help with anything, feel free to reply here.',
  },
] as const
