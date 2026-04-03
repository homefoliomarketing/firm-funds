// Firm Funds Database Types

export type DealStatus =
  | 'under_review'
  | 'approved'
  | 'funded'
  | 'repaid'
  | 'closed'
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
  | 'other'

export type BrokerageStatus = 'active' | 'suspended' | 'inactive'
export type AgentStatus = 'active' | 'suspended' | 'flagged'
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
  created_at: string
  updated_at: string
}

export interface Agent {
  id: string
  brokerage_id: string
  first_name: string
  last_name: string
  email: string
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
  checklist_item: string
  is_checked: boolean
  checked_by: string | null
  checked_at: string | null
  notes: string | null
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