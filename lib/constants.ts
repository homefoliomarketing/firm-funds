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

/** Maximum gross commission allowed (sanity check) */
export const MAX_GROSS_COMMISSION = 1_000_000

/** Minimum gross commission allowed */
export const MIN_GROSS_COMMISSION = 1

/** Maximum file upload size in bytes (10MB) */
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024

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
  REPAID: 'repaid',
  CLOSED: 'closed',
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
  under_review: { bg: '#F0F4FF', text: '#3D5A99', border: '#C5D3F0' },
  approved:     { bg: '#EDFAF0', text: '#1A7A2E', border: '#B8E6C4' },
  funded:       { bg: '#F5F0FF', text: '#5B3D99', border: '#D5C5F0' },
  repaid:       { bg: '#EDFAF5', text: '#0D7A5F', border: '#B8E6D8' },
  closed:       { bg: '#F2F2F0', text: '#5A5A5A', border: '#D0D0CC' },
  denied:       { bg: '#FFF0F0', text: '#993D3D', border: '#F0C5C5' },
  cancelled:    { bg: '#FFF5ED', text: '#995C1A', border: '#F0D5B8' },
}

/** Helper: get inline style object for a status badge */
export function getStatusBadgeStyle(status: string) {
  const s = STATUS_BADGE_STYLES[status] || STATUS_BADGE_STYLES.closed
  return { backgroundColor: s.bg, color: s.text, border: `1px solid ${s.border}` }
}

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
