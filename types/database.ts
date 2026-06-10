// Firm Funds Database Types

export type DealStatus =
  | 'under_review'
  | 'approved'
  | 'funded'
  | 'completed'
  | 'denied'
  | 'cancelled'
  // Post-funding remediation lifecycle (CPA Article 5)
  | 'failed_to_close'
  | 'cured'
  // EFT-bounced funding (migration 084)
  | 'funding_failed'
  // Firm-deal offer (auto-pipeline) — agent has accepted but admin hasn't submitted
  | 'offered'

export type UserRole = 'agent' | 'brokerage_admin' | 'firm_funds_admin' | 'super_admin'

// Least-privilege internal staff tier (migration 102). NULL for non-internal
// users (agents, brokerage admins). super_admin is always treated as 'owner'
// in code regardless of this column. Drives the capability layer in
// lib/access.ts.
export type StaffRole = 'owner' | 'manager' | 'staff'

export type DocumentType =
  | 'aps'
  | 'amendment'
  | 'trade_record'
  | 'mls_listing'
  | 'commission_agreement'
  | 'direction_to_pay'
  | 'notice_of_fulfillment'
  | 'kyc_fintrac'
  | 'id_verification'
  | 'brokerage_cooperation_agreement'
  | 'other'

export type BrokerageStatus = 'active' | 'suspended' | 'inactive' | 'archived'
export type AgentStatus = 'active' | 'inactive' | 'suspended' | 'flagged' | 'archived'
export type UploadSource = 'nexone_auto' | 'manual_upload'
export type DealSource = 'nexone_auto' | 'manual_portal'

export type AgentKycStatus = 'pending' | 'submitted' | 'verified' | 'rejected'

export type AgentKycDocumentType =
  | 'drivers_license'
  | 'passport'
  | 'ontario_photo_card'
  | 'permanent_resident_card'
  | 'citizenship_card'

export interface Brokerage {
  id: string
  name: string
  brand: string | null
  address: string | null
  city: string | null
  province: string | null
  postal_code: string | null
  phone: string | null
  email: string
  status: BrokerageStatus
  referral_fee_percentage: number
  transaction_system: string | null
  notes: string | null
  // FINTRAC KYC fields
  kyc_verified: boolean
  kyc_verified_at: string | null
  kyc_verified_by: string | null
  reco_registration_number: string | null
  reco_verification_date: string | null
  reco_verification_notes: string | null
  // White-label branding
  logo_url: string | null
  brand_color: string | null
  /** TRUE when logo_url has "Powered by Firm Funds" baked in (generated logos
   *  from lib/brokerage-logo-generator.ts). Templates check this to avoid
   *  double-rendering the FF wordmark next to the logo. Migration 096. */
  logo_includes_tagline: boolean
  /** Public PNG of the white-label logo for social / SMS link-preview cards
   *  (Open Graph). Raster companion to logo_url (SVG). Migration 104. */
  og_image_url: string | null
  // White-label partner — Session 34
  is_white_label_partner: boolean
  profit_share_pct: number  // Negotiated %, per-brokerage. Whole numbers (20.00 = 20%). Never hardcoded.
  // Broker of Record (legal authority — signs BCA, receives IDP copies)
  broker_of_record_name: string | null
  broker_of_record_email: string | null
  bca_signed_at: string | null
  created_at: string
  updated_at: string
}

export interface Agent {
  id: string
  brokerage_id: string
  first_name: string
  last_name: string
  email: string | null  // ⚠️ TEMPORARY: nullable for testing — revert before go-live
  phone: string | null
  reco_number: string | null
  status: AgentStatus
  flagged_by_brokerage: boolean
  outstanding_recovery: number
  // FINTRAC KYC fields
  kyc_status: AgentKycStatus
  kyc_submitted_at: string | null
  kyc_verified_at: string | null
  kyc_verified_by: string | null
  kyc_document_path: string | null
  kyc_document_type: AgentKycDocumentType | null
  kyc_rejection_reason: string | null
  // Banking fields (verified/approved by admin)
  bank_transit_number: string | null
  bank_institution_number: string | null
  bank_account_number: string | null
  banking_verified: boolean
  banking_verified_at: string | null
  banking_verified_by: string | null
  // Banking self-service submission (agent-entered, pending admin approval)
  banking_submitted_at: string | null
  banking_submitted_transit: string | null
  banking_submitted_institution: string | null
  banking_submitted_account: string | null
  banking_approval_status: 'none' | 'pending' | 'approved' | 'rejected'
  banking_rejection_reason: string | null
  // Void cheque / direct deposit authorization form
  preauth_form_path: string | null
  preauth_form_uploaded_at: string | null
  // Direct-deposit authorization consent (migration 107)
  deposit_authorized_at?: string | null
  deposit_authorized_by?: string | null
  // Address
  address_street: string | null
  address_city: string | null
  address_province: string | null
  address_postal_code: string | null
  // White-label activation tracking — Session 34
  welcome_email_sent_at: string | null
  account_activated_at: string | null  // Auto-set by trigger when kyc_status=verified AND banking_approval_status=approved
  created_at: string
  updated_at: string
}

export interface Deal {
  id: string
  agent_id: string
  brokerage_id: string
  status: DealStatus
  property_address: string
  closing_date: string
  gross_commission: number
  brokerage_split_pct: number
  net_commission: number
  days_until_closing: number
  discount_fee: number
  advance_amount: number
  brokerage_referral_fee: number
  amount_due_from_brokerage: number
  settlement_period_fee: number
  settlement_days_at_funding: number | null  // 7 standard, 14 for brokerages auto-bumped after 5 strikes
  late_strike_recorded: boolean
  due_date: string | null
  brokerage_referral_pct: number | null
  balance_deducted: number
  payment_status: 'pending' | 'paid' | 'overdue' | 'not_applicable'
  funding_date: string | null
  repayment_date: string | null
  repayment_amount: number | null
  admin_notes_timeline: { id: string; text: string; author_name: string; created_at: string }[] | null
  // EFT transfers live in their own table as of migration 058 — query via
  // `.select('*, eft_transfers(*)')` to populate this field on the deal.
  eft_transfers: EftTransfer[] | null
  brokerage_payments: BrokeragePayment[] | null
  source: DealSource
  denial_reason: string | null
  notes: string | null
  // White-label broker share — Session 34
  broker_share_pct_at_funding: number | null  // Snapshot at funding so historical deals don't change if pct is renegotiated
  broker_share_amount: number | null  // (discount_fee + settlement_period_fee) * broker_share_pct_at_funding / 100, calculated at completion
  broker_share_remitted: boolean
  // Optimistic concurrency control (migration 083 — auto-incremented on every UPDATE via trigger)
  version: number
  // Assignment for routing/ownership (migration 083)
  assigned_to_user_id: string | null
  assigned_at: string | null // migration 100: when an underwriter was assigned
  // EFT funding failure tracking (migration 084)
  funding_failure_reason: string | null
  funding_failed_at: string | null
  // Resubmission lineage — points back to the denied/failed deal this was revised from (migration 084)
  revised_from_deal_id: string | null
  // Firm-deal offer: set when the agent took an 'offered' deal over to submit
  // it themselves; the brokerage is paused on it (migration 105). NULL = the
  // brokerage still owns the submission.
  agent_self_submit_at: string | null
  created_at: string
  updated_at: string
  // Joined data
  agent?: Agent
  brokerage?: Brokerage
  documents?: DealDocument[]
  checklist?: UnderwritingChecklistItem[]
}

export interface BrokeragePayment {
  amount: number
  date: string
  reference?: string
  method?: string
}

// Migration 058 promoted eft_transfers from a JSONB array on deals to its own
// table. The Deal.eft_transfers field above is populated via a PostgREST embed
// (e.g. select('*, eft_transfers(id, amount, transfer_date, confirmed, reference)'))
// and contains the fields below.
export interface EftTransfer {
  id: string
  amount: number
  transfer_date: string
  confirmed: boolean
  reference?: string | null
}

export interface DealDocument {
  id: string
  deal_id: string
  uploaded_by: string
  document_type: DocumentType
  file_name: string
  file_path: string
  file_size: number
  upload_source: UploadSource
  notes: string | null
  created_at: string
}

export interface UnderwritingChecklistItem {
  id: string
  deal_id: string
  category: string
  checklist_item: string
  is_checked: boolean
  is_na: boolean
  checked_by: string | null
  checked_at: string | null
  notes: string | null
  sort_order: number
}

export interface AgentAccountTransaction {
  id: string
  agent_id: string
  deal_id: string | null
  type:
    | 'late_closing_interest'
    | 'late_payment_interest'
    | 'failed_deal_balance'
    | 'failed_deal_interest'
    | 'balance_deduction'
    | 'balance_deduction_reversed'
    | 'invoice_payment'
    | 'adjustment'
    | 'credit'
    | 'deal_advance'
    | 'deal_repayment'
  amount: number
  running_balance: number
  description: string
  reference_id: string | null
  created_by: string | null
  created_at: string
}

export interface AgentInvoice {
  id: string
  agent_id: string
  invoice_number: string
  amount: number
  status: 'pending' | 'paid' | 'overdue' | 'cancelled'
  due_date: string
  paid_at: string | null
  sent_at: string | null
  created_at: string
}

export interface DealMessage {
  id: string
  deal_id: string
  sender_id: string | null
  sender_role: 'admin' | 'agent' | 'brokerage_admin'
  sender_name?: string | null
  message: string
  is_email_reply: boolean
  file_path: string | null
  file_name: string | null
  file_size: number | null
  file_type: string | null
  created_at: string
}

export interface DocumentReturn {
  id: string
  deal_id: string
  document_id: string
  returned_by: string
  reason: string
  status: 'pending' | 'resolved'
  resolved_at: string | null
  created_at: string
}

export interface UserProfile {
  id: string
  email: string
  role: UserRole
  agent_id: string | null
  brokerage_id: string | null
  full_name: string
  is_active: boolean
  must_reset_password: boolean
  last_login: string | null
  // First-login greeting flag (migration 107): NULL until the dashboard has
  // welcomed the user once, then stamped. Drives "Welcome" vs "Welcome back".
  welcomed_at?: string | null
  created_at: string
  // Free-form job title for brokerage staff (e.g. "Broker of Record",
  // "Brokerage Manager", "Office Manager"). Used to gate the Referral Fees
  // tab in the brokerage portal — see canViewBrokerageReferralFees() in
  // lib/access.ts.
  staff_title?: string | null
  last_active_at?: string | null
  // Internal staff tier (migration 102): owner | manager | staff. NULL for
  // non-internal users. super_admin is always treated as owner in code.
  staff_role?: StaffRole | null
}

export type EsignatureStatus = 'sent' | 'delivered' | 'signed' | 'declined' | 'voided'
export type EsignatureDocumentType = 'cpa' | 'idp'
export type SignerStatus = 'pending' | 'sent' | 'delivered' | 'signed' | 'declined'

export interface EsignatureEnvelope {
  id: string
  deal_id: string
  envelope_id: string
  document_type: EsignatureDocumentType
  status: EsignatureStatus
  agent_signer_status: SignerStatus
  agent_signed_at: string | null
  brokerage_signer_status: SignerStatus | null
  brokerage_signed_at: string | null
  sent_by: string | null
  sent_at: string
  completed_at: string | null
  voided_at: string | null
  void_reason: string | null
  envelope_uri: string | null
  created_at: string
  updated_at: string
}

export interface NotificationLog {
  id: string
  user_id: string
  deal_id: string | null
  type: 'status_change' | 'document_request' | 'new_submission' | 'system'
  channel: 'email'
  subject: string
  body: string
  sent_at: string
  status: 'sent' | 'failed' | 'pending'
}

// Look-only "view as user" session (migration 103). One ACTIVE row
// (ended_at IS NULL, expires_at in the future) per real_user_id means that
// Owner is currently viewing the app as target_user_id. The real staffer's
// auth cookie is never touched; this row is the only source of truth for
// impersonation. See lib/impersonation.ts.
export interface ImpersonationSession {
  id: string
  real_user_id: string
  real_email: string | null
  real_role: string | null
  target_user_id: string
  target_email: string | null
  target_role: UserRole
  target_agent_id: string | null
  target_brokerage_id: string | null
  reason: string | null
  started_at: string
  expires_at: string
  ended_at: string | null
  ended_reason: 'manual' | 'expired' | 'logout' | 'switched' | 'revoked' | null
  ip_address: string | null
  user_agent: string | null
  created_at: string
}
