// Firm Funds Database Types

export type DealStatus =
  | 'under_review'
  | 'approved'
  | 'funded'
  | 'completed'
  | 'denied'
  | 'cancelled'

export type UserRole = 'agent' | 'brokerage_admin' | 'firm_funds_admin' | 'super_admin'

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
export type AgentStatus = 'active' | 'suspended' | 'flagged' | 'archived'
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
  // Preauthorized debit form
  preauth_form_path: string | null
  preauth_form_uploaded_at: string | null
  // Address
  address_street: string | null
  address_city: string | null
  address_province: string | null
  address_postal_code: string | null
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
  due_date: string | null
  brokerage_referral_pct: number | null
  balance_deducted: number
  payment_status: 'pending' | 'paid' | 'overdue' | 'not_applicable'
  funding_date: string | null
  repayment_date: string | null
  repayment_amount: number | null
  admin_notes_timeline: { id: string; text: string; author_name: string; created_at: string }[] | null
  eft_transfers: EftTransfer[] | null
  brokerage_payments: BrokeragePayment[] | null
  source: DealSource
  denial_reason: string | null
  notes: string | null
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

export interface EftTransfer {
  amount: number
  date: string
  confirmed: boolean
  reference?: string
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
  type: 'late_closing_interest' | 'late_payment_interest' | 'balance_deduction' | 'invoice_payment' | 'adjustment' | 'credit'
  amount: number
  description: string
  reference_id: string | null
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
  last_login: string | null
  created_at: string
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