'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import type { User } from '@supabase/supabase-js'
import type { UserProfile } from '@/types/database'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Plus, Edit2, Search, ChevronLeft, AlertCircle, CheckCircle, CheckCircle2, Clock, ChevronDown, ChevronRight, Users, UserPlus, X, Upload, Download, FileSpreadsheet, Archive, Eye, EyeOff, FileText, Trash2, Shield, ExternalLink, XCircle, Mail, CreditCard, KeyRound, AtSign, Phone, DollarSign, Inbox, Wand2, Sparkles } from 'lucide-react'
import { generateBrokerageLogoSvg, svgToFile } from '@/lib/brokerage-logo-generator'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { StatusToast } from '@/components/StatusToast'
import { createBrokerage, updateBrokerage, createAgent, updateAgent, bulkImportAgentsRoster, inviteAgent, archiveAgent, permanentlyDeleteAgent, permanentlyDeleteBrokerage, archiveBrokerage, resendAgentWelcomeEmail, sendWelcomeToAllBrokerageAgents, adminResetUserPassword, adminChangeUserEmail, getBrokerageUserProfiles, inviteBrokerageAdmin, inviteBrokerageOnboardingContacts, resendBrokerageSetupLink, resetBrokerageLateStrikes, getAgentPreauthFormSignedUrl, getSignedBcaUrl } from '@/lib/actions/admin-actions'
import { getAgentTransactions, adjustAgentBalance } from '@/lib/actions/account-actions'
import type { AgentAccountTransaction } from '@/types/database'
import { sendBcaForSignature, voidBcaEnvelope, getBcaSignatureStatus } from '@/lib/actions/esign-actions'
import { updateAgentBanking, approveAgentBanking, rejectAgentBanking } from '@/lib/actions/profile-actions'
import { verifyBrokerageKyc, revokeBrokerageKyc, verifyAgentKyc, rejectAgentKyc, getAgentKycDocumentUrl } from '@/lib/actions/kyc-actions'
import { getStatusBadgeClass as getSharedStatusBadgeClass, formatStatusLabel, getKycBadgeClass, RECO_PUBLIC_REGISTER_URL, BROKERAGE_LATE_STRIKE_THRESHOLD, SETTLEMENT_PERIOD_DAYS, BROKERAGE_BUMPED_SETTLEMENT_DAYS, BRAND_GREEN_HEX } from '@/lib/constants'
import SignOutModal from '@/components/SignOutModal'
import { KycMediaPreview } from '@/components/admin/KycMediaPreview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ============================================================================
// Types
// ============================================================================

interface Agent {
  id: string
  first_name: string
  last_name: string
  email: string | null  // TEMPORARY: nullable for testing, revert before go-live
  phone: string | null
  reco_number: string | null
  status: 'active' | 'suspended' | 'archived'
  flagged_by_brokerage: boolean
  outstanding_recovery: number
  account_balance: number
  kyc_status: 'pending' | 'submitted' | 'verified' | 'rejected'
  // Banking fields
  bank_transit_number: string | null
  bank_institution_number: string | null
  bank_account_number: string | null
  banking_verified: boolean
  // Banking self-service submission
  banking_submitted_transit: string | null
  banking_submitted_institution: string | null
  banking_submitted_account: string | null
  banking_submitted_at: string | null
  banking_approval_status: 'none' | 'pending' | 'approved' | 'rejected'
  banking_rejection_reason: string | null
  preauth_form_path: string | null
  preauth_form_uploaded_at: string | null
  // Direct-deposit authorization consent (migration 107)
  deposit_authorized_at: string | null
  // White-label activation tracking (Session 34)
  welcome_email_sent_at: string | null
  account_activated_at: string | null
  // Mailing address fields — surfaced on the KYC preview panel but not on
  // every agent fetch path, so they're optional here.
  address_street?: string | null
  address_city?: string | null
  address_province?: string | null
  address_postal_code?: string | null
  created_at: string
}

interface Deal {
  id: string
  property_address: string
  status: string
  advance_amount: number
  closing_date: string
  created_at: string
}

interface Brokerage {
  id: string
  name: string
  brand: string | null
  address: string | null
  city: string | null
  province: string | null
  postal_code: string | null
  phone: string | null
  email: string
  status: 'active' | 'suspended' | 'inactive' | 'archived' | 'archived'
  referral_fee_percentage: number
  transaction_system: string | null
  notes: string | null
  broker_of_record_name: string | null
  broker_of_record_email: string | null
  bca_signed_at: string | null
  bca_signed_pdf_path: string | null
  logo_url: string | null
  brand_color: string | null
  logo_includes_tagline: boolean
  is_white_label_partner: boolean
  profit_share_pct: number
  late_strike_count: number
  auto_bumped_to_14_days_at: string | null
  last_strike_reset_at: string | null
  settlement_days_override: number | null
  // KYC verification fields (loaded with the brokerage row but typed as
  // optional because not every code path populates them).
  kyc_verified?: boolean | null
  kyc_verified_at?: string | null
  kyc_verified_by?: string | null
  reco_registration_number?: string | null
  reco_verification_date?: string | null
  reco_verification_notes?: string | null
  created_at: string
  updated_at: string
}

interface BrokerageWithAgents extends Brokerage {
  agents: Agent[]
}

interface BrokerageFormData {
  name: string
  email: string
  brand: string
  address: string
  city: string
  province: string
  postalCode: string
  phone: string
  referralFeePercentage: string
  transactionSystem: string
  notes: string
  brokerOfRecordName: string
  brokerOfRecordEmail: string
  logoUrl: string
  /** TRUE if logoUrl was produced by the generator (Powered by Firm Funds baked in). */
  logoIncludesTagline: boolean
  brandColor: string
  isWhiteLabelPartner: boolean
  profitSharePct: string
  status?: 'active' | 'suspended' | 'inactive' | 'archived'
}

// ============================================================================
// Onboarding contacts (FF admin "New Brokerage" only)
// ============================================================================
// Five canonical contacts seeded at brokerage creation. Each non-blank email
// gets a brokerage_admin login + magic-link invite via
// inviteBrokerageOnboardingContacts(). Broker of Record + Brokerage Manager
// are persisted with the matching staff_title so they see the Referral Fees
// tab (gate in lib/access.ts → canViewBrokerageReferralFees). Admin 1/2/3
// store NULL so they don't.
//
// The Broker of Record fields live on BrokerageFormData (broker_of_record_*)
// because the brokerages table itself needs them for the BCA flow. The four
// remaining contacts only need an invite + user_profile, so they live in
// this lightweight sibling state.
// ============================================================================
interface OnboardingContactsForm {
  brokerageManagerName: string
  brokerageManagerEmail: string
  admin1Name: string
  admin1Email: string
  admin2Name: string
  admin2Email: string
  admin3Name: string
  admin3Email: string
}

const emptyOnboardingContactsForm: OnboardingContactsForm = {
  brokerageManagerName: '', brokerageManagerEmail: '',
  admin1Name: '', admin1Email: '',
  admin2Name: '', admin2Email: '',
  admin3Name: '', admin3Email: '',
}

interface AgentFormData {
  firstName: string
  lastName: string
  email: string
  phone: string
  recoNumber: string
}

const emptyAgentForm: AgentFormData = { firstName: '', lastName: '', email: '', phone: '', recoNumber: '' }

// Subset of the user_profiles + agents tables surfaced by the user-management
// modal. Used as the inner row type for brokerageUserProfiles state.
interface BrokerageUserProfile {
  id: string
  full_name?: string | null
  email?: string | null
  role?: string | null
  agent_id?: string | null
  brokerage_id?: string | null
  is_active?: boolean
  last_login?: string | null
  created_at?: string
  // Agents lookup may also carry the agents row directly.
  first_name?: string | null
  last_name?: string | null
}

// ============================================================================
// Status badge helper (local, no colors dependency)
// ============================================================================

function getLocalStatusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-950/50 text-green-400 border border-green-800'
    case 'suspended': return 'bg-yellow-950/50 text-yellow-400 border border-yellow-800'
    case 'inactive': return 'bg-muted text-muted-foreground border border-border'
    case 'archived': return 'bg-muted text-muted-foreground border border-border'
    default: return 'bg-muted text-muted-foreground border border-border'
  }
}

// ============================================================================
// BrokerageRowSection
// ============================================================================
// Shared chrome for the inline sub-sections that render inside an expanded
// brokerage row (FINTRAC verification, Documents, Portal Access, Agent
// Roster, etc). Each follows the same "icon + bold title + optional inline
// extras + optional right-side action" pattern. Extracting it kept this
// 3000+ line file from drifting further into copy-paste land.
//
// Spacing knobs match the variations already present in the file when this
// component was introduced — `compact` for the py-3 portal-access strip,
// `noBorder` for the trailing Agent Roster section, `headerSpacing` for the
// occasional mb-4 vs default mb-3. No behavior change: this is pure markup
// consolidation.
//
// Not exported — the brokerage row is the only consumer right now and the
// layout assumptions (px-6 padding inside an existing card border, no
// internal scroll) are baked in. Promote to components/admin/ if a second
// consumer appears.
// ============================================================================
function BrokerageRowSection({
  icon,
  title,
  titleExtras,
  rightSlot,
  compact = false,
  noBorder = false,
  headerSpacing = 'mb-3',
  className,
  children,
}: {
  /** Lucide icon element, sized to size={15} per the existing convention. */
  icon: React.ReactNode
  /** Plain text or ReactNode (e.g. with embedded count span). */
  title: React.ReactNode
  /** Rendered next to the title inside the left-aligned group. Use for
   *  status badges, inline action buttons like "Show archived", etc. */
  titleExtras?: React.ReactNode
  /** Rendered on the right edge of the header. Triggers
   *  justify-between on the header flex when set. */
  rightSlot?: React.ReactNode
  /** py-3 instead of py-4. Used by the Portal Access strip which has no
   *  body and reads better tightened up. */
  compact?: boolean
  /** Skip the bottom border. Used by the last section in the row stack. */
  noBorder?: boolean
  /** Margin below the header strip. Defaults to mb-3 (most common). Pass
   *  '' to drop the margin entirely (single-line sections with no body). */
  headerSpacing?: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={`px-6 ${compact ? 'py-3' : 'py-4'} ${
        noBorder ? '' : 'border-b border-border/50'
      } ${className ?? ''}`}
    >
      <div
        className={`flex items-center ${rightSlot ? 'justify-between' : ''} gap-2 ${headerSpacing}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <h4 className="text-sm font-bold text-foreground">{title}</h4>
          {titleExtras}
        </div>
        {rightSlot}
      </div>
      {children}
    </div>
  )
}

// ============================================================================
// FieldValue
// ============================================================================
// Read-only "uppercase label + value" pair used in the brokerage details
// grid, the FINTRAC verified state, and a handful of other admin readouts.
// All three of those grids drop em-dashes in for blank values; the consumer
// keeps owning that so we don't accidentally convert empty strings to '—'
// where the original code would render a blank.
//
// `detail` slot mirrors the broker_of_record pattern (small muted line
// beneath the value). Pass children freely for cases that need extra
// inline markup (e.g. broken-out date components).
// ============================================================================
function FieldValue({
  label,
  children,
  detail,
}: {
  label: string
  children: React.ReactNode
  detail?: React.ReactNode
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">{label}</p>
      <p className="text-foreground">{children}</p>
      {detail && <p className="text-xs mt-0.5 text-muted-foreground">{detail}</p>}
    </div>
  )
}

// ============================================================================
// Late Settlement Strikes Section
// ============================================================================

function LateStrikeSection({ brokerage, onChange }: { brokerage: Brokerage; onChange: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false)
  const [showResetUI, setShowResetUI] = useState(false)
  const [reason, setReason] = useState('')
  const [clearAutoBump, setClearAutoBump] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const strikeCount = brokerage.late_strike_count || 0
  const autoBumped = !!brokerage.auto_bumped_to_14_days_at
  const override = brokerage.settlement_days_override
  const effectiveDays = override ?? (autoBumped ? BROKERAGE_BUMPED_SETTLEMENT_DAYS : SETTLEMENT_PERIOD_DAYS)
  const lastReset = brokerage.last_strike_reset_at

  const tone =
    autoBumped
      ? 'border-red-800/50 bg-red-950/15'
      : strikeCount >= BROKERAGE_LATE_STRIKE_THRESHOLD - 2
        ? 'border-amber-800/50 bg-amber-950/15'
        : 'border-border/40 bg-card/60'

  const handleReset = async () => {
    setSubmitting(true)
    setError(null)
    const res = await resetBrokerageLateStrikes({
      brokerageId: brokerage.id,
      clearAutoBump,
      reason: reason.trim(),
    })
    if (res.success) {
      setShowResetUI(false)
      setReason('')
      await onChange()
    } else {
      setError(res.error || 'Failed to reset strikes')
    }
    setSubmitting(false)
  }

  return (
    <div className={`px-6 py-4 border-b border-border/50`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Clock size={15} className="text-primary" />
          <h4 className="text-sm font-bold text-foreground">Settlement Window</h4>
        </div>
        <span className="text-xs font-semibold tabular-nums text-foreground">
          {effectiveDays} days
          {autoBumped && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-red-300/80">auto-bumped</span>}
          {override != null && override > 0 && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-blue-300/80">override</span>}
        </span>
      </div>
      <div className={`rounded-lg border p-3 ${tone}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground/80 font-semibold">Late strikes</p>
            <p className="text-base font-bold tabular-nums text-foreground">
              {strikeCount} / {BROKERAGE_LATE_STRIKE_THRESHOLD}
              <span className="ml-2 text-[11px] font-normal text-muted-foreground/70">
                {strikeCount >= BROKERAGE_LATE_STRIKE_THRESHOLD
                  ? 'auto-bump triggered'
                  : `${BROKERAGE_LATE_STRIKE_THRESHOLD - strikeCount} more before auto-bump`}
              </span>
            </p>
            {lastReset && (
              <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                Last reset {new Date(lastReset).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => { setShowResetUI(v => !v); setError(null) }}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-border/50 hover:border-primary/40 hover:text-primary transition"
            disabled={strikeCount === 0 && !autoBumped}
          >
            {showResetUI ? 'Cancel' : 'Reset strikes'}
          </button>
        </div>

        {showResetUI && (
          <div className="mt-3 pt-3 border-t border-border/40 space-y-2">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Reason (required, audit-logged)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Brokerage explained Aug payment delay; one-time"
              className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-input text-foreground focus:outline-none focus:border-primary"
            />
            {autoBumped && (
              <label className="flex items-center gap-2 text-xs text-foreground select-none cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={clearAutoBump}
                  onChange={(e) => setClearAutoBump(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border/60 bg-input text-primary"
                />
                Also clear the auto-bump (return to {SETTLEMENT_PERIOD_DAYS}-day settlement on new deals)
              </label>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleReset}
                disabled={submitting || !reason.trim()}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition"
              >
                {submitting ? 'Resetting...' : 'Confirm reset'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// BCA Status Section (Brokerage Cooperation Agreement)
// ============================================================================

function BcaStatusSection({ brokerage }: { brokerage: Brokerage }) {
  const [bcaLoading, setBcaLoading] = useState(false)
  const [bcaStatus, setBcaStatus] = useState<string | null>(null)
  // Envelope id is tracked for future void/resend flows; rendering uses it
  // implicitly through the void action which calls the server.
  const [, setBcaEnvelopeId] = useState<string | null>(null)
  const [bcaError, setBcaError] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [showVoidInput, setShowVoidInput] = useState(false)
  const [viewingBca, setViewingBca] = useState(false)

  // Fetch BCA status on mount
  useEffect(() => {
    async function fetchBcaStatus() {
      const result = await getBcaSignatureStatus(brokerage.id)
      if (result.success && result.data && result.data.length > 0) {
        const latest = result.data[0]
        setBcaStatus(latest.status)
        setBcaEnvelopeId(latest.envelope_id)
      }
    }
    fetchBcaStatus()
  }, [brokerage.id])

  const handleSendBca = async () => {
    setBcaLoading(true)
    setBcaError(null)
    const result = await sendBcaForSignature(brokerage.id)
    if (result.success) {
      setBcaStatus('sent')
      setBcaEnvelopeId(result.data?.envelopeId || null)
    } else {
      setBcaError(result.error || 'Failed to send BCA')
    }
    setBcaLoading(false)
  }

  const handleVoidBca = async () => {
    if (!voidReason.trim()) return
    setBcaLoading(true)
    setBcaError(null)
    const result = await voidBcaEnvelope(brokerage.id, voidReason.trim())
    if (result.success) {
      setBcaStatus('voided')
      setShowVoidInput(false)
      setVoidReason('')
    } else {
      setBcaError(result.error || 'Failed to void BCA')
    }
    setBcaLoading(false)
  }

  const handleViewBca = async () => {
    setViewingBca(true)
    setBcaError(null)
    const result = await getSignedBcaUrl({ brokerageId: brokerage.id })
    if (result.success && result.data?.signedUrl) {
      window.open(result.data.signedUrl, '_blank', 'noopener,noreferrer')
    } else {
      setBcaError(result.error || 'Failed to open the signed BCA')
    }
    setViewingBca(false)
  }

  const getBcaBadgeClass = (status: string | null) => {
    switch (status) {
      case 'signed': return 'bg-green-950/50 text-green-400 border border-green-800'
      case 'sent':
      case 'delivered': return 'bg-blue-950/50 text-blue-400 border border-blue-800'
      case 'declined': return 'bg-red-950/50 text-red-400 border border-red-800'
      case 'voided': return 'bg-muted text-muted-foreground border border-border'
      default: return 'bg-yellow-950/50 text-yellow-400 border border-yellow-800'
    }
  }

  const displayStatus = brokerage.bca_signed_at ? 'signed' : bcaStatus
  const canSend = !brokerage.bca_signed_at && (!bcaStatus || bcaStatus === 'voided' || bcaStatus === 'declined')
  const canVoid = bcaStatus === 'sent' || bcaStatus === 'delivered'

  return (
    <div className="px-6 py-4 border-b border-border/50">
      <div className="flex items-center gap-2 mb-3">
        <FileText size={15} className="text-primary" />
        <h4 className="text-sm font-bold text-foreground">
          Brokerage Cooperation Agreement
        </h4>
        {displayStatus && (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ml-2 ${getBcaBadgeClass(displayStatus)}`}>
            {displayStatus === 'signed' && <><CheckCircle size={11} /> Signed</>}
            {displayStatus === 'sent' && 'Sent, awaiting signature'}
            {displayStatus === 'delivered' && 'Delivered, awaiting signature'}
            {displayStatus === 'declined' && <><XCircle size={11} /> Declined</>}
            {displayStatus === 'voided' && 'Voided'}
          </span>
        )}
        {!displayStatus && (
          <span className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded ml-2 ${getBcaBadgeClass(null)}`}>
            Not Sent
          </span>
        )}
      </div>

      {/* Signed date */}
      {brokerage.bca_signed_at && (
        <p className="text-xs text-muted-foreground mb-3">
          Signed on {new Date(brokerage.bca_signed_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      )}

      {/* Signed document — view / download */}
      {brokerage.bca_signed_at && brokerage.bca_signed_pdf_path && (
        <button
          onClick={handleViewBca}
          disabled={viewingBca}
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 bg-muted text-foreground border border-border hover:bg-muted/70"
        >
          <Download size={12} /> {viewingBca ? 'Opening...' : 'View signed BCA'}
        </button>
      )}

      {/* Missing BOR warning */}
      {!brokerage.broker_of_record_email && (
        <p className="text-xs text-yellow-400 mb-3 flex items-center gap-1.5">
          <AlertCircle size={12} /> Add a Broker of Record email before sending the BCA.
        </p>
      )}

      {/* Error */}
      {bcaError && (
        <p className="text-xs text-red-400 mb-3 flex items-center gap-1.5">
          <AlertCircle size={12} /> {bcaError}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        {canSend && brokerage.broker_of_record_email && (
          <button
            onClick={handleSendBca}
            disabled={bcaLoading}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Mail size={12} /> {bcaLoading ? 'Sending...' : (bcaStatus === 'voided' || bcaStatus === 'declined' ? 'Resend BCA' : 'Send BCA')}
          </button>
        )}

        {canVoid && !showVoidInput && (
          <button
            onClick={() => setShowVoidInput(true)}
            disabled={bcaLoading}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 bg-red-950/50 text-red-400 border border-red-800 hover:bg-red-900/50"
          >
            <XCircle size={12} /> Void
          </button>
        )}
      </div>

      {/* Void reason input */}
      {showVoidInput && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={voidReason}
            onChange={e => setVoidReason(e.target.value)}
            placeholder="Reason for voiding..."
            className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground placeholder:text-muted-foreground"
          />
          <button
            onClick={handleVoidBca}
            disabled={bcaLoading || !voidReason.trim()}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50 bg-red-950/50 text-red-400 border border-red-800 hover:bg-red-900/50"
          >
            {bcaLoading ? 'Voiding...' : 'Confirm Void'}
          </button>
          <button
            onClick={() => { setShowVoidInput(false); setVoidReason('') }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Component
// ============================================================================

export default function BrokeragesPage() {
  // `user` retained for parity / future audit-log integration.
  const [, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [brokerages, setBrokerages] = useState<BrokerageWithAgents[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingBrokerageId, setEditingBrokerageId] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showAddAgentFor, setShowAddAgentFor] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [createFormData, setCreateFormData] = useState<BrokerageFormData>({
    name: '', email: '', brand: '', address: '', city: '', province: '', postalCode: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '', brokerOfRecordName: '', brokerOfRecordEmail: '', logoUrl: '', logoIncludesTagline: false, brandColor: BRAND_GREEN_HEX, isWhiteLabelPartner: false, profitSharePct: '',
  })
  // Onboarding contacts (Brokerage Manager + Admin 1/2/3). BOR lives on
  // createFormData because it also writes to the brokerages table.
  const [onboardingContacts, setOnboardingContacts] = useState<OnboardingContactsForm>(emptyOnboardingContactsForm)
  const [editFormData, setEditFormData] = useState<BrokerageFormData & { status: 'active' | 'suspended' | 'inactive' | 'archived' }>({
    name: '', email: '', brand: '', address: '', city: '', province: '', postalCode: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '', brokerOfRecordName: '', brokerOfRecordEmail: '', logoUrl: '', logoIncludesTagline: false, brandColor: BRAND_GREEN_HEX, isWhiteLabelPartner: false, profitSharePct: '', status: 'active',
  })
  const [agentForm, setAgentForm] = useState<AgentFormData>(emptyAgentForm)
  const [sendInvite, setSendInvite] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [archivingAgentId, setArchivingAgentId] = useState<string | null>(null)
  const [importingFor, setImportingFor] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)
  const [createRosterFile, setCreateRosterFile] = useState<File | null>(null)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const [agentDeals, setAgentDeals] = useState<Record<string, Deal[]>>({})
  const [agentTransactions, setAgentTransactions] = useState<Record<string, AgentAccountTransaction[]>>({})
  const [editAgentForm, setEditAgentForm] = useState<AgentFormData & { status: string; flaggedByBrokerage: boolean; outstandingRecovery: string }>(
    { firstName: '', lastName: '', email: '', phone: '', recoNumber: '', status: 'active', flaggedByBrokerage: false, outstandingRecovery: '0' }
  )
  const [uploadingLogo, setUploadingLogo] = useState(false)
  // Logo generator dialog state — see lib/brokerage-logo-generator.ts
  const [logoGenOpen, setLogoGenOpen] = useState<{ brokerageId: string; isCreate: boolean } | null>(null)
  const [logoGenName, setLogoGenName] = useState('')
  const [logoGenBusy, setLogoGenBusy] = useState(false)
  // KYC state
  const [kycRecoNumber, setKycRecoNumber] = useState('')
  const [kycNotes, setKycNotes] = useState('')
  const [kycSubmitting, setKycSubmitting] = useState(false)
  const [kycChecks, setKycChecks] = useState({ nameMatch: false, addressMatch: false, idValid: false })
  const [kycRejectingAgentId, setKycRejectingAgentId] = useState<string | null>(null)
  const [kycRejectReason, setKycRejectReason] = useState('')
  // Legacy single-URL preview state removed — KYC preview now flows through
  // kycPreviewPanel, which manages multiple blob URLs and lifecycle.
  const [kycPreviewPanel, setKycPreviewPanel] = useState<{ blobUrls: string[]; originalUrls: string[]; fileName: string; agentName: string; agentId: string; agentPhone: string | null; agentAddress: string | null } | null>(null)
  const [kycPreviewLoading, setKycPreviewLoading] = useState<string | null>(null)
  // Banking state
  const [bankingForm, setBankingForm] = useState<{ transit: string; institution: string; account: string }>({ transit: '', institution: '', account: '' })
  const [bankingEditingAgentId, setBankingEditingAgentId] = useState<string | null>(null)
  const [bankingSaving, setBankingSaving] = useState(false)
  const [bankingMessage, setBankingMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [bankingApprovingId, setBankingApprovingId] = useState<string | null>(null)
  const [bankingRejectingId, setBankingRejectingId] = useState<string | null>(null)
  const [bankingRejectReason, setBankingRejectReason] = useState('')
  const [preauthViewingAgentId, setPreauthViewingAgentId] = useState<string | null>(null)
  const [preauthViewUrl, setPreauthViewUrl] = useState<string | null>(null)
  const [preauthViewType, setPreauthViewType] = useState<'pdf' | 'image'>('pdf')
  // User management state (password reset, email change)
  const [resettingPasswordForUserId, setResettingPasswordForUserId] = useState<string | null>(null)
  const [changingEmailForUserId, setChangingEmailForUserId] = useState<string | null>(null)
  const [changeEmailValue, setChangeEmailValue] = useState('')
  const [changingEmailSaving, setChangingEmailSaving] = useState(false)
  const [brokerageUserProfiles, setBrokerageUserProfiles] = useState<Record<string, { brokerageAdmins: BrokerageUserProfile[]; agents: BrokerageUserProfile[] }>>({})
  const [loadingUserProfiles, setLoadingUserProfiles] = useState<string | null>(null)
  const [showUserManagement, setShowUserManagement] = useState<string | null>(null)
  const [showCreateBrokerageLogin, setShowCreateBrokerageLogin] = useState(false)
  const [brokerageLoginForm, setBrokerageLoginForm] = useState({ fullName: '', email: '' })
  const [creatingBrokerageLogin, setCreatingBrokerageLogin] = useState(false)
  const [resendingSetupLink, setResendingSetupLink] = useState<string | null>(null)

  // Balance adjustment modal (Firm Funds admin posts a credit or charge to an
  // agent's ledger). idempotencyKey is generated once when the modal opens
  // and re-sent on retries so a double-click or quick re-submit doesn't
  // double-post the same adjustment.
  const [adjustBalanceForAgentId, setAdjustBalanceForAgentId] = useState<string | null>(null)
  const [adjustDirection, setAdjustDirection] = useState<'credit' | 'charge'>('credit')
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustDescription, setAdjustDescription] = useState('')
  const [adjustIdempotencyKey, setAdjustIdempotencyKey] = useState<string>('')
  const [adjustSubmitting, setAdjustSubmitting] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)

  const openAdjustBalanceModal = (agentId: string) => {
    setAdjustBalanceForAgentId(agentId)
    setAdjustDirection('credit')
    setAdjustAmount('')
    setAdjustDescription('')
    setAdjustError(null)
    setAdjustIdempotencyKey(typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  }

  const closeAdjustBalanceModal = () => {
    setAdjustBalanceForAgentId(null)
    setAdjustError(null)
  }

  const submitBalanceAdjustment = async () => {
    if (!adjustBalanceForAgentId) return
    const parsed = parseFloat(adjustAmount)
    if (!isFinite(parsed) || parsed <= 0) {
      setAdjustError('Enter a positive dollar amount.')
      return
    }
    if (!adjustDescription.trim()) {
      setAdjustError('Description is required so this adjustment is explainable later.')
      return
    }

    setAdjustSubmitting(true)
    setAdjustError(null)
    try {
      // Credit reduces what the agent owes (negative delta). Charge increases
      // it (positive delta). The server-side ledger expects the signed value.
      const signedAmount = adjustDirection === 'credit' ? -parsed : parsed
      const result = await adjustAgentBalance({
        agentId: adjustBalanceForAgentId,
        amount: signedAmount,
        description: adjustDescription.trim(),
        idempotencyKey: adjustIdempotencyKey,
      })
      if (!result.success) {
        setAdjustError(result.error || 'Failed to post adjustment.')
        return
      }
      // Refresh transactions + balance for this agent.
      const txnResult = await getAgentTransactions(adjustBalanceForAgentId)
      if (txnResult.success && txnResult.data) {
        setAgentTransactions(prev => ({ ...prev, [adjustBalanceForAgentId]: txnResult.data || [] }))
      }
      const newBalance = (result.data as { newBalance?: number } | null)?.newBalance
      if (typeof newBalance === 'number') {
        setBrokerages(prev => prev.map(b => ({
          ...b,
          agents: b.agents?.map(a => a.id === adjustBalanceForAgentId ? { ...a, account_balance: newBalance } : a),
        })))
      }
      closeAdjustBalanceModal()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.'
      setAdjustError(msg)
    } finally {
      setAdjustSubmitting(false)
    }
  }

  const kycPanelWidth = 520
  const closeKycPanel = () => {
    if (kycPreviewPanel) {
      for (const url of kycPreviewPanel.blobUrls) URL.revokeObjectURL(url)
    }
    setKycPreviewPanel(null)
  }

  const router = useRouter()
  const supabase = createClient()

  // ---- Load data ----
  useEffect(() => {
    async function loadPage() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setUser(user)

      const { data: profile } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
      setProfile(profile)

      if (profile?.role !== 'super_admin' && profile?.role !== 'firm_funds_admin') {
        router.push('/login'); return
      }

      await loadBrokerages()
      setLoading(false)
    }
    loadPage()
    // loadBrokerages is intentionally not in deps — its identity changes on
    // every render and the auth+load flow only runs on mount. router/supabase
    // are stable refs in this tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-expand the first brokerage with pending actions
  useEffect(() => {
    if (loading || brokerages.length === 0 || expandedId) return
    const brokerageWithAction = brokerages.find(b =>
      b.agents.some(a => a.kyc_status === 'submitted' || a.banking_approval_status === 'pending')
    )
    if (brokerageWithAction) {
      setExpandedId(brokerageWithAction.id)
    }
    // We re-check only when loading flips or the list length changes — adding
    // the full `brokerages` array would auto-expand on every internal edit,
    // which is jarring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, brokerages.length])

  async function loadBrokerages() {
    // audit finding #16: hide soft-deleted brokerages and agents from the
    // default admin list. Recovery happens via a separate restore flow.
    const { data, error } = await supabase
      .from('brokerages')
      .select('*, agents(*)')
      .is('deleted_at', null)
      .is('agents.deleted_at', null)
      .order('name')
      .order('last_name', { referencedTable: 'agents', ascending: true })

    if (error) {
      console.error('Error loading brokerages:', error)
      setStatusMessage({ type: 'error', text: 'Failed to load brokerages' })
      return
    }

    setBrokerages((data || []) as BrokerageWithAgents[])
  }

  const handleLogout = async () => { await supabase.auth.signOut(); router.push('/login') }

  // ---- Brokerage CRUD ----
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createFormData.name.trim() || !createFormData.email.trim() || !createFormData.referralFeePercentage) {
      setStatusMessage({ type: 'error', text: 'Please fill in all required fields' }); return
    }
    setSubmitting(true)
    const result = await createBrokerage({
      name: createFormData.name, email: createFormData.email,
      brand: createFormData.brand || undefined, address: createFormData.address || undefined,
      city: createFormData.city || undefined, province: createFormData.province || undefined,
      postalCode: createFormData.postalCode || undefined,
      phone: createFormData.phone || undefined,
      // One "Profit Share %" input drives both fee columns in lockstep.
      referralFeePercentage: parseFloat(createFormData.referralFeePercentage) / 100,
      profitSharePct: parseFloat(createFormData.referralFeePercentage) || 0,
      isWhiteLabelPartner: (parseFloat(createFormData.referralFeePercentage) || 0) > 0,
      transactionSystem: createFormData.transactionSystem || undefined, notes: createFormData.notes || undefined,
      brokerOfRecordName: createFormData.brokerOfRecordName || undefined, brokerOfRecordEmail: createFormData.brokerOfRecordEmail || undefined,
      logoUrl: createFormData.logoUrl || undefined, brandColor: createFormData.brandColor || undefined,
      logoIncludesTagline: createFormData.logoIncludesTagline,
    })
    if (result.success) {
      const newBrokerageId = result.data?.id
      let rosterMsg = ''

      // If a roster file was attached, import it now
      if (createRosterFile && newBrokerageId) {
        try {
          const formData = new FormData()
          formData.append('brokerageId', newBrokerageId)
          formData.append('file', createRosterFile)
          const importRes = await bulkImportAgentsRoster(formData)
          if (importRes.success && importRes.data) {
            rosterMsg = ` - ${importRes.data.imported} agent${importRes.data.imported !== 1 ? 's' : ''} imported`
            if (importRes.data.skipped > 0) rosterMsg += ` (${importRes.data.skipped} skipped)`
            if (importRes.data.errors.length > 0) {
              setImportResult(importRes.data)
              setImportingFor(newBrokerageId)
              setExpandedId(newBrokerageId)
            }
          } else {
            rosterMsg = ` - roster import failed: ${importRes.error || 'invalid file'}`
          }
        } catch (err) {
          console.error('Roster import error during create:', err)
          rosterMsg = ' - roster import failed, you can re-upload from the brokerage view'
        }
      }

      // Fan out invites to the five canonical onboarding contacts. Each
      // non-blank email becomes a brokerage_admin login with the matching
      // staff_title. BOR + Brokerage Manager get the Referral Fees tab via
      // canViewBrokerageReferralFees(); Admin 1/2/3 store NULL.
      let contactsMsg = ''
      if (newBrokerageId) {
        const contactsRes = await inviteBrokerageOnboardingContacts({
          brokerageId: newBrokerageId,
          contacts: [
            { roleLabel: 'Broker of Record', staffTitle: 'Broker of Record', fullName: createFormData.brokerOfRecordName, email: createFormData.brokerOfRecordEmail },
            { roleLabel: 'Brokerage Manager', staffTitle: 'Brokerage Manager', fullName: onboardingContacts.brokerageManagerName, email: onboardingContacts.brokerageManagerEmail },
            { roleLabel: 'Admin 1', staffTitle: null, fullName: onboardingContacts.admin1Name, email: onboardingContacts.admin1Email },
            { roleLabel: 'Admin 2', staffTitle: null, fullName: onboardingContacts.admin2Name, email: onboardingContacts.admin2Email },
            { roleLabel: 'Admin 3', staffTitle: null, fullName: onboardingContacts.admin3Name, email: onboardingContacts.admin3Email },
          ],
        })
        if (contactsRes.success && contactsRes.data) {
          const { sent, failed, errors } = contactsRes.data as { sent: number; failed: number; errors: Array<{ roleLabel: string; email: string; error: string }> }
          if (sent > 0) contactsMsg += ` - ${sent} invite${sent !== 1 ? 's' : ''} sent`
          if (failed > 0) {
            const detail = errors.map(e => `${e.roleLabel} (${e.email}): ${e.error}`).join('; ')
            contactsMsg += ` - ${failed} invite${failed !== 1 ? 's' : ''} failed: ${detail}`
          }
        } else if (contactsRes.error) {
          contactsMsg += ` - onboarding invites failed: ${contactsRes.error}`
        }
      }

      setStatusMessage({ type: 'success', text: `Brokerage created successfully${rosterMsg}${contactsMsg}` })
      setCreateFormData({ name: '', email: '', brand: '', address: '', city: '', province: '', postalCode: '', phone: '', referralFeePercentage: '', transactionSystem: '', notes: '', brokerOfRecordName: '', brokerOfRecordEmail: '', logoUrl: '', logoIncludesTagline: false, brandColor: BRAND_GREEN_HEX, isWhiteLabelPartner: false, profitSharePct: '' })
      setOnboardingContacts(emptyOnboardingContactsForm)
      setCreateRosterFile(null)
      setShowCreateForm(false)
      await loadBrokerages()
      if (newBrokerageId) setExpandedId(newBrokerageId)
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to create brokerage' })
    }
    setSubmitting(false)
  }

  const handleEditSubmit = async (e: React.FormEvent, brokerageId: string) => {
    e.preventDefault()
    if (!editFormData.name.trim() || !editFormData.email.trim() || !editFormData.referralFeePercentage) {
      setStatusMessage({ type: 'error', text: 'Please fill in all required fields' }); return
    }
    // One "Profit Share %" input now drives both fee columns; derive the whole-number
    // profit share from it (referral_fee_percentage stays its 0-1 decimal mirror).
    const profitSharePct = editFormData.referralFeePercentage ? parseFloat(editFormData.referralFeePercentage) : 0
    if (Number.isNaN(profitSharePct) || profitSharePct < 0 || profitSharePct > 100) {
      setStatusMessage({ type: 'error', text: 'Profit share % must be between 0 and 100' }); return
    }
    setSubmitting(true)
    const result = await updateBrokerage({
      id: brokerageId, name: editFormData.name, email: editFormData.email,
      brand: editFormData.brand || undefined, address: editFormData.address || undefined,
      city: editFormData.city || undefined, province: editFormData.province || undefined,
      postalCode: editFormData.postalCode || undefined,
      phone: editFormData.phone || undefined,
      referralFeePercentage: parseFloat(editFormData.referralFeePercentage) / 100,
      transactionSystem: editFormData.transactionSystem || undefined, notes: editFormData.notes || undefined,
      brokerOfRecordName: editFormData.brokerOfRecordName || undefined, brokerOfRecordEmail: editFormData.brokerOfRecordEmail || undefined,
      logoUrl: editFormData.logoUrl || undefined, brandColor: editFormData.brandColor || undefined,
      logoIncludesTagline: editFormData.logoIncludesTagline,
      isWhiteLabelPartner: profitSharePct > 0,
      profitSharePct,
      status: editFormData.status,
    })
    if (result.success) {
      const queued = (result.data as { welcomeQueued?: { sent: number; failed: number } } | null)?.welcomeQueued
      let msg = 'Brokerage updated successfully'
      if (queued) {
        msg += `: welcome emails queued: ${queued.sent} sent, ${queued.failed} failed`
      }
      setStatusMessage({ type: 'success', text: msg })
      setEditingBrokerageId(null)
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update brokerage' })
    }
    setSubmitting(false)
  }

  const openEditForm = (brokerage: BrokerageWithAgents) => {
    setEditFormData({
      name: brokerage.name, email: brokerage.email,
      brand: brokerage.brand || '', address: brokerage.address || '',
      city: brokerage.city || '', province: brokerage.province || '', postalCode: brokerage.postal_code || '',
      phone: brokerage.phone || '',
      // Single "Profit Share %" field. Prefer the whole-number profit_share_pct when it's
      // set (it governs funded payouts); otherwise fall back to the legacy referral decimal.
      referralFeePercentage: (Number(brokerage.profit_share_pct ?? 0) > 0
        ? Number(brokerage.profit_share_pct)
        : brokerage.referral_fee_percentage * 100).toString(),
      transactionSystem: brokerage.transaction_system || '', notes: brokerage.notes || '',
      brokerOfRecordName: brokerage.broker_of_record_name || '', brokerOfRecordEmail: brokerage.broker_of_record_email || '',
      logoUrl: brokerage.logo_url || '', logoIncludesTagline: brokerage.logo_includes_tagline ?? false, brandColor: brokerage.brand_color || BRAND_GREEN_HEX,
      isWhiteLabelPartner: brokerage.is_white_label_partner ?? false,
      profitSharePct: (brokerage.profit_share_pct ?? 0).toString(),
      status: brokerage.status,
    })
    setEditingBrokerageId(brokerage.id)
    setExpandedId(brokerage.id)
  }

  // ---- Logo Upload ----
  const handleLogoUpload = async (file: File, brokerageId: string, isCreate: boolean) => {
    const allowed = ['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']
    if (!allowed.includes(file.type)) {
      setStatusMessage({ type: 'error', text: 'Logo must be JPEG, PNG, SVG, or WebP' }); return
    }
    if (file.size > 2 * 1024 * 1024) {
      setStatusMessage({ type: 'error', text: 'Logo must be under 2MB' }); return
    }
    setUploadingLogo(true)
    try {
      const ext = file.name.split('.').pop() || 'png'
      const path = `${brokerageId}/logo.${ext}`
      const { error: uploadErr } = await supabase.storage.from('brokerage-logos').upload(path, file, { upsert: true })
      if (uploadErr) { setStatusMessage({ type: 'error', text: 'Failed to upload logo' }); setUploadingLogo(false); return }
      const { data: { publicUrl } } = supabase.storage.from('brokerage-logos').getPublicUrl(path)
      // Add cache-busting param
      const logoUrl = `${publicUrl}?t=${Date.now()}`
      if (isCreate) {
        // Uploaded logos do NOT include the tagline — templates will add it.
        setCreateFormData(prev => ({ ...prev, logoUrl, logoIncludesTagline: false }))
      } else {
        setEditFormData(prev => ({ ...prev, logoUrl, logoIncludesTagline: false }))
      }
      setStatusMessage({ type: 'success', text: 'Logo uploaded' })
      setTimeout(() => setStatusMessage(null), 2000)
    } catch {
      setStatusMessage({ type: 'error', text: 'Logo upload failed' })
    }
    setUploadingLogo(false)
  }

  // ---- Logo Generator ----
  // Opens the generator dialog. brokerageId is 'new-brokerage-<ts>' for the
  // create form (matches the handleLogoUpload pattern at line ~994).
  const openLogoGenerator = (brokerageId: string, currentName: string, isCreate: boolean) => {
    setLogoGenName(currentName.trim() || 'Brokerage Name')
    setLogoGenOpen({ brokerageId, isCreate })
  }

  // Generates the SVG, uploads it to brokerage-logos storage, and updates form
  // state with the new logoUrl + logoIncludesTagline=true. Form save (Save
  // Changes) persists to the brokerages table.
  const handleApplyGeneratedLogo = async () => {
    if (!logoGenOpen || !logoGenName.trim()) return
    setLogoGenBusy(true)
    try {
      const svg = generateBrokerageLogoSvg(logoGenName, { background: 'transparent' })
      const file = svgToFile(svg, 'logo-generated.svg')
      const path = `${logoGenOpen.brokerageId}/logo-generated.svg`
      const { error: uploadErr } = await supabase.storage.from('brokerage-logos').upload(path, file, { upsert: true, contentType: 'image/svg+xml' })
      if (uploadErr) {
        setStatusMessage({ type: 'error', text: `Failed to save logo: ${uploadErr.message}` })
        setLogoGenBusy(false)
        return
      }
      const { data: { publicUrl } } = supabase.storage.from('brokerage-logos').getPublicUrl(path)
      const logoUrl = `${publicUrl}?t=${Date.now()}`
      if (logoGenOpen.isCreate) {
        setCreateFormData(prev => ({ ...prev, logoUrl, logoIncludesTagline: true }))
      } else {
        setEditFormData(prev => ({ ...prev, logoUrl, logoIncludesTagline: true }))
      }
      setStatusMessage({ type: 'success', text: 'Logo generated. Click Save to apply.' })
      setTimeout(() => setStatusMessage(null), 3000)
      setLogoGenOpen(null)
    } catch (e) {
      setStatusMessage({ type: 'error', text: `Generator failed: ${e instanceof Error ? e.message : 'unknown error'}` })
    }
    setLogoGenBusy(false)
  }

  // Live preview SVGs for the dialog (re-generated on every name change).
  const logoGenPreviewDark = logoGenName.trim()
    ? generateBrokerageLogoSvg(logoGenName, { background: 'dark' })
    : null
  const logoGenPreviewLight = logoGenName.trim()
    ? generateBrokerageLogoSvg(logoGenName, { background: 'light' })
    : null

  // ---- Agent CRUD ----
  const handleAddAgent = async (e: React.FormEvent, brokerageId: string) => {
    e.preventDefault()
    // TEMPORARY: email not required for testing, REVERT BEFORE GO-LIVE
    if (!agentForm.firstName.trim() || !agentForm.lastName.trim()) {
      setStatusMessage({ type: 'error', text: 'First name and last name are required' }); return
    }
    // If invite is on but no email, force "roster only" mode
    const canInvite = sendInvite && agentForm.email.trim()
    setSubmitting(true)

    if (canInvite) {
      // Create agent record + auth user (no email yet, send in bulk when brokerage is ready)
      const result = await inviteAgent({
        brokerageId,
        firstName: agentForm.firstName, lastName: agentForm.lastName,
        email: agentForm.email, phone: agentForm.phone || undefined,
        recoNumber: agentForm.recoNumber || undefined,
        skipEmail: true,
      })
      if (result.success) {
        setStatusMessage({ type: 'success', text: `Agent added with login created. Use "Send Welcome to All" when ready.` })
        setAgentForm(emptyAgentForm)
        setSendInvite(true)
        setShowAddAgentFor(null)
        await loadBrokerages()
      } else {
        // Check if agent was created but login failed
        if (result.data?.agentCreated && !result.data?.loginCreated) {
          setStatusMessage({ type: 'error', text: result.error || 'Agent added to roster but login creation failed. See error for details.' })
          await loadBrokerages()
        } else {
          setStatusMessage({ type: 'error', text: result.error || 'Failed to invite agent' })
        }
      }
    } else {
      // Just create the agent record (no login, no email)
      const result = await createAgent({
        brokerageId,
        firstName: agentForm.firstName, lastName: agentForm.lastName,
        email: agentForm.email || undefined, phone: agentForm.phone || undefined,
        recoNumber: agentForm.recoNumber || undefined,
      })
      if (result.success) {
        setStatusMessage({ type: 'success', text: 'Agent added to roster (no login created)' })
        setAgentForm(emptyAgentForm)
        setShowAddAgentFor(null)
        await loadBrokerages()
      } else {
        setStatusMessage({ type: 'error', text: result.error || 'Failed to add agent' })
      }
    }
    setSubmitting(false)
  }

  const openEditAgent = (agent: Agent) => {
    setEditAgentForm({
      firstName: agent.first_name, lastName: agent.last_name, email: agent.email || '',
      phone: agent.phone || '', recoNumber: agent.reco_number || '',
      status: agent.status, flaggedByBrokerage: agent.flagged_by_brokerage,
      outstandingRecovery: (agent.outstanding_recovery || 0).toString(),
    })
    setEditingAgentId(agent.id)
  }

  const handleEditAgentSubmit = async (e: React.FormEvent, agentId: string, brokerageId: string) => {
    e.preventDefault()
    if (!editAgentForm.firstName.trim() || !editAgentForm.lastName.trim() || !editAgentForm.email.trim()) {
      setStatusMessage({ type: 'error', text: 'First name, last name, and email are required' }); return
    }
    setSubmitting(true)
    const result = await updateAgent({
      id: agentId, brokerageId,
      firstName: editAgentForm.firstName, lastName: editAgentForm.lastName,
      email: editAgentForm.email, phone: editAgentForm.phone || undefined,
      recoNumber: editAgentForm.recoNumber || undefined,
      status: editAgentForm.status, flaggedByBrokerage: editAgentForm.flaggedByBrokerage,
      outstandingRecovery: parseFloat(editAgentForm.outstandingRecovery) || 0,
    })
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Agent updated successfully' })
      setEditingAgentId(null)
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update agent' })
    }
    setSubmitting(false)
  }

  // ---- Bulk import ----
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, brokerageId: string) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset so same file can be re-selected

    setSubmitting(true)
    setImportResult(null)
    setImportingFor(brokerageId)

    try {
      const formData = new FormData()
      formData.append('brokerageId', brokerageId)
      formData.append('file', file)
      const result = await bulkImportAgentsRoster(formData)

      if (result.success && result.data) {
        setImportResult(result.data)
        if (result.data.imported > 0) {
          setStatusMessage({ type: 'success', text: `Imported ${result.data.imported} agent${result.data.imported !== 1 ? 's' : ''}${result.data.skipped > 0 ? ` (${result.data.skipped} skipped)` : ''}` })
          await loadBrokerages()
        } else {
          setStatusMessage({ type: 'error', text: `No agents imported. ${result.data.skipped} row${result.data.skipped !== 1 ? 's' : ''} skipped.` })
        }
      } else {
        setStatusMessage({ type: 'error', text: result.error || 'Import failed' })
      }
    } catch (err: unknown) {
      console.error('Roster import error:', err)
      setStatusMessage({ type: 'error', text: 'Failed to read the file. Make sure it is a valid .csv or .xlsx file.' })
    }
    setImportingFor(null)
    setSubmitting(false)
  }

  const downloadTemplate = () => {
    const csv = [
      'First Name,Last Name,Email,Phone,RECO Number,Address Street,Address City,Address Province,Address Postal Code',
      'Jane,Realtor,jane@example.com,+1 416 555 0100,1234567,123 Main St,Toronto,ON,M5V 1A1',
    ].join('\r\n')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    link.download = 'firm-funds-agent-import-template.csv'
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const handleArchiveAgent = async (agentId: string, agentName: string) => {
    if (!confirm(`Archive "${agentName}"? They will be removed from the active roster and their login will be deactivated. Their deal history will be preserved.`)) return
    setArchivingAgentId(agentId)
    const result = await archiveAgent({ agentId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `${agentName} has been archived` })
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to archive agent' })
    }
    setArchivingAgentId(null)
  }

  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null)

  const handlePermanentlyDeleteAgent = async (agentId: string, agentName: string) => {
    if (!confirm(`PERMANENTLY DELETE "${agentName}"?\n\nThis will delete the agent and ALL associated data (deals, transactions, invoices, messages). This cannot be undone!`)) return
    setDeletingAgentId(agentId)
    const result = await permanentlyDeleteAgent({ agentId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `${agentName} has been permanently deleted` })
      await loadBrokerages()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to delete agent' })
    }
    setDeletingAgentId(null)
  }

  const [resendingAgentId, setResendingAgentId] = useState<string | null>(null)
  const [sendingAllFor, setSendingAllFor] = useState<string | null>(null)
  const [sendingBrokerageWelcome, setSendingBrokerageWelcome] = useState<string | null>(null)

  const handleSendWelcomeToAll = async (brokerageId: string, brokerageName: string) => {
    if (!confirm(`Send welcome emails to ALL active agents at ${brokerageName}? Each agent will receive a magic link to set up their account.`)) return
    setSendingAllFor(brokerageId)
    const result = await sendWelcomeToAllBrokerageAgents({ brokerageId })
    if (result.success) {
      const sent = result.data?.sent || 0
      const failed = result.data?.failed || 0
      if (failed > 0) {
        setStatusMessage({ type: 'success', text: `Welcome emails sent to ${sent} agent${sent !== 1 ? 's' : ''}. ${failed} failed, use individual resend for those.` })
      } else {
        setStatusMessage({ type: 'success', text: `Welcome emails sent to ${sent} agent${sent !== 1 ? 's' : ''}!` })
      }
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to send welcome emails' })
    }
    setSendingAllFor(null)
  }

  const handleResendWelcome = async (agentId: string, agentName: string) => {
    if (!confirm(`Resend welcome email to ${agentName}? This will generate a new magic link.`)) return
    setResendingAgentId(agentId)
    const result = await resendAgentWelcomeEmail({ agentId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Welcome email resent to ${agentName}` })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to resend email' })
    }
    setResendingAgentId(null)
  }

  const handleResetPassword = async (id: string, userName: string, type: 'agent' | 'user' = 'agent') => {
    if (!confirm(`Reset password for ${userName}? They will receive an email with a link to set a new password.`)) return
    setResettingPasswordForUserId(id)
    const result = await adminResetUserPassword(type === 'agent' ? { agentId: id } : { userId: id })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Password reset email sent to ${userName}` })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to reset password' })
    }
    setResettingPasswordForUserId(null)
  }

  const handleChangeEmail = async (id: string, userName: string, type: 'agent' | 'user' = 'agent', brokerageId?: string) => {
    if (!changeEmailValue.trim()) {
      setStatusMessage({ type: 'error', text: 'Enter a new email address' })
      return
    }
    if (!confirm(`Change login email for ${userName} to ${changeEmailValue}? They will be notified at their old email.`)) return
    setChangingEmailSaving(true)
    const result = await adminChangeUserEmail(type === 'agent' ? { agentId: id, newEmail: changeEmailValue } : { userId: id, newEmail: changeEmailValue })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Email changed for ${userName}. Notification sent to old address.` })
      setChangingEmailForUserId(null)
      setChangeEmailValue('')
      loadBrokerages()
      // Also refresh the manage logins panel if open for a brokerage
      if (brokerageId) {
        const refreshed = await getBrokerageUserProfiles(brokerageId)
        if (refreshed.success && refreshed.data) {
          setBrokerageUserProfiles(prev => ({ ...prev, [brokerageId]: refreshed.data as { brokerageAdmins: BrokerageUserProfile[]; agents: BrokerageUserProfile[] } }))
        }
      }
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to change email' })
    }
    setChangingEmailSaving(false)
  }

  const handleLoadUserProfiles = async (brokerageId: string) => {
    if (showUserManagement === brokerageId) {
      setShowUserManagement(null)
      return
    }
    setLoadingUserProfiles(brokerageId)
    const result = await getBrokerageUserProfiles(brokerageId)
    if (result.success && result.data) {
      setBrokerageUserProfiles(prev => ({ ...prev, [brokerageId]: result.data as { brokerageAdmins: BrokerageUserProfile[]; agents: BrokerageUserProfile[] } }))
    }
    setShowUserManagement(brokerageId)
    setLoadingUserProfiles(null)
  }

  const handleSendBrokerageWelcome = async (brokerage: { id: string; name: string; email: string }) => {
    if (!confirm(`Send welcome email to ${brokerage.email}? This will create a brokerage admin login for ${brokerage.name}.`)) return
    setSendingBrokerageWelcome(brokerage.id)
    const result = await inviteBrokerageAdmin({
      brokerageId: brokerage.id,
      fullName: brokerage.name,
      email: brokerage.email,
    })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Welcome email sent to ${brokerage.email}` })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to send welcome email' })
    }
    setSendingBrokerageWelcome(null)
  }

  const handleCreateBrokerageLogin = async (brokerageId: string, brokerageName: string) => {
    if (!brokerageLoginForm.fullName.trim() || !brokerageLoginForm.email.trim()) {
      setStatusMessage({ type: 'error', text: 'Full name and email are required' })
      return
    }
    setCreatingBrokerageLogin(true)
    const result = await inviteBrokerageAdmin({
      brokerageId,
      fullName: brokerageLoginForm.fullName,
      email: brokerageLoginForm.email,
    })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Setup link sent to ${brokerageLoginForm.email} for ${brokerageName}` })
      setShowCreateBrokerageLogin(false)
      setBrokerageLoginForm({ fullName: '', email: '' })
      // Reload the user profiles to show the new login
      const refreshed = await getBrokerageUserProfiles(brokerageId)
      if (refreshed.success && refreshed.data) {
        setBrokerageUserProfiles(prev => ({ ...prev, [brokerageId]: refreshed.data as { brokerageAdmins: BrokerageUserProfile[]; agents: BrokerageUserProfile[] } }))
      }
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to invite brokerage admin' })
    }
    setCreatingBrokerageLogin(false)
  }

  const handleResendSetupLink = async (userId: string, adminName: string) => {
    if (!confirm(`Resend setup link to ${adminName}? This will generate a new magic link and email it to them.`)) return
    setResendingSetupLink(userId)
    const result = await resendBrokerageSetupLink({ userId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `New setup link sent to ${adminName}` })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to resend setup link' })
    }
    setResendingSetupLink(null)
  }

  const handleExpandAgent = async (agentId: string) => {
    if (expandedAgentId === agentId) {
      setExpandedAgentId(null)
      return
    }

    // Fetch deals for this agent
    const { data, error } = await supabase
      .from('deals')
      .select('id, property_address, status, advance_amount, closing_date, created_at')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error loading agent deals:', error)
      setStatusMessage({ type: 'error', text: 'Failed to load agent deals' })
      return
    }

    setAgentDeals({ ...agentDeals, [agentId]: data || [] })

    // Fetch transactions for this agent
    const txResult = await getAgentTransactions(agentId)
    if (txResult.success && txResult.data) {
      setAgentTransactions(prev => ({ ...prev, [agentId]: txResult.data.transactions }))
    }

    setExpandedAgentId(agentId)
  }

  // ---- Filtering (searches brokerage name/email AND agent names) ----
  const q = searchQuery.toLowerCase().trim()
  const filteredBrokerages = brokerages.filter(b => {
    if (!q) return true
    // Match brokerage fields
    if (b.name.toLowerCase().includes(q) || b.email.toLowerCase().includes(q)) return true
    if (b.brand && b.brand.toLowerCase().includes(q)) return true
    // Match agent names within this brokerage
    if (b.agents.some(a =>
      `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
      (a.email || '').toLowerCase().includes(q)
    )) return true
    return false
  })

  // Auto-expand brokerages where the match is on an agent (not the brokerage itself)
  const agentMatchBrokerageIds = q ? brokerages
    .filter(b => {
      const brokerageMatch = b.name.toLowerCase().includes(q) || b.email.toLowerCase().includes(q) || (b.brand && b.brand.toLowerCase().includes(q))
      if (brokerageMatch) return false // don't auto-expand if the brokerage itself matches
      return b.agents.some(a =>
        `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
        (a.email || '').toLowerCase().includes(q)
      )
    })
    .map(b => b.id)
    : []

  // If searching and we have agent matches, auto-expand those
  useEffect(() => {
    if (agentMatchBrokerageIds.length === 1) {
      setExpandedId(agentMatchBrokerageIds[0])
    }
    // Only re-run on searchQuery changes — agentMatchBrokerageIds is derived
    // and re-evaluated every render, so adding it would cause an extra
    // expand cycle after every keystroke-induced filter pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  // ---- Input class helper (replaces inputStyle object) ----
  const inputCls = 'w-full px-3 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors'
  const inputSmCls = 'rounded px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary transition-colors font-mono'

  // ---- Render a form input (DRY helper) ----
  const renderInput = (
    label: string, value: string, onChange: (val: string) => void,
    opts?: { required?: boolean; placeholder?: string; type?: string; step?: string; min?: string; max?: string; hint?: string }
  ) => (
    <div>
      <label className="block text-sm font-medium mb-2 text-muted-foreground">
        {label}{opts?.required ? ' *' : ''}
      </label>
      <input
        type={opts?.type || 'text'}
        step={opts?.step}
        min={opts?.min}
        max={opts?.max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={opts?.placeholder || ''}
        className={inputCls}
      />
      {opts?.hint && <p className="text-[11px] mt-1.5 text-muted-foreground/70">{opts.hint}</p>}
    </div>
  )

  // ---- Loading skeleton ----
  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-6 w-36" />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-8 w-64 rounded-lg mb-2" />
          <Skeleton className="h-4 w-48 rounded mb-8" />
          <div className="bg-card border border-border/40 rounded-xl p-6 shadow-lg shadow-black/20">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="flex gap-4 mb-4">
                <Skeleton className="h-4 flex-1 rounded" />
                <Skeleton className="h-4 w-20 rounded" />
                <Skeleton className="h-4 w-24 rounded" />
              </div>
            ))}
          </div>
        </main>
      </div>
    )
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="min-h-screen bg-background">
      {/* Main content area - shrinks when KYC panel is open */}
      <div style={{ marginRight: kycPreviewPanel ? kycPanelWidth : 0, transition: 'margin-right 0.2s ease-out' }}>
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center gap-2 py-3 sm:py-5">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <button
                onClick={() => router.push('/admin')}
                className="p-1.5 rounded-lg transition-colors text-primary hover:bg-primary/10 flex-shrink-0"
              >
                <ChevronLeft size={20} />
              </button>
              <Image src="/brand/white.png" alt="Firm Funds" width={280} height={112} className="h-9 sm:h-20 md:h-28 w-auto flex-shrink-0" />
              <div className="hidden sm:block w-px h-10 bg-white/15" />
              <p className="text-base sm:text-lg font-medium tracking-wide text-white truncate" style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}>Manage Brokerages</p>
            </div>
            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
              <span className="text-sm text-primary hidden sm:block">{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      {/* Floating status toast — fixed to the viewport so feedback shows up
          wherever you're scrolled, instead of being pinned to the top of the
          page far from the control you just used. */}
      <StatusToast message={statusMessage} onDismiss={() => setStatusMessage(null)} />

      <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Title + Search */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Brokerages</h2>
            <p className="text-sm mt-1 text-muted-foreground">
              {brokerages.length} brokerage{brokerages.length !== 1 ? 's' : ''} - {brokerages.reduce((sum, b) => sum + b.agents.length, 0)} total agents
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search brokerages or agents..."
                className="pl-9 pr-4 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary w-full sm:w-72 transition-colors"
              />
            </div>
            {!showCreateForm && (
              <Button
                onClick={() => setShowCreateForm(true)}
                className="bg-primary text-primary-foreground hover:bg-primary/90 whitespace-nowrap"
              >
                <Plus size={16} />
                Add Brokerage
              </Button>
            )}
          </div>
        </div>

        {/* Create Brokerage Form */}
        {showCreateForm && (
          <div className="mb-8 rounded-xl overflow-hidden bg-card border border-border/40 shadow-lg shadow-black/20">
            <div className="px-6 py-5 border-b border-border/40 bg-card/80">
              <h3 className="text-lg font-bold text-foreground">Create New Brokerage</h3>
            </div>
            <form onSubmit={handleCreateSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderInput('Name', createFormData.name, (v) => setCreateFormData({ ...createFormData, name: v }), { required: true, placeholder: 'e.g., Acme Realty' })}
                {renderInput('Email', createFormData.email, (v) => setCreateFormData({ ...createFormData, email: v }), { required: true, placeholder: 'contact@acmerealty.com', type: 'email' })}
                {renderInput('Brand', createFormData.brand, (v) => setCreateFormData({ ...createFormData, brand: v }), { placeholder: 'e.g., ACME' })}
                {/* Single "Profit Share %" field. Stored canonically in referral_fee_percentage
                    (0-1 decimal, used by the contract/calc/reports) AND mirrored to
                    profit_share_pct (whole number, used by the funding + statement paths) so the
                    two columns can never diverge. Entered as a whole number (e.g. 20 = 20%). */}
                {renderInput('Profit Share %', createFormData.referralFeePercentage, (v) => setCreateFormData({ ...createFormData, referralFeePercentage: v }), { required: true, placeholder: '20', type: 'number', step: '0.1', min: '0', max: '100' })}
                {renderInput('Street Address', createFormData.address, (v) => setCreateFormData({ ...createFormData, address: v }), { placeholder: '123 Main St' })}
                {renderInput('City', createFormData.city, (v) => setCreateFormData({ ...createFormData, city: v }), { placeholder: 'Toronto' })}
                {renderInput('Province', createFormData.province, (v) => setCreateFormData({ ...createFormData, province: v }), { placeholder: 'ON' })}
                {renderInput('Postal Code', createFormData.postalCode, (v) => setCreateFormData({ ...createFormData, postalCode: v }), { placeholder: 'M5V 1A1' })}
                {renderInput('Phone', createFormData.phone, (v) => setCreateFormData({ ...createFormData, phone: v }), { placeholder: '(416) 555-0123', type: 'tel' })}
                {renderInput('Transaction System', createFormData.transactionSystem, (v) => setCreateFormData({ ...createFormData, transactionSystem: v }), { placeholder: 'e.g., Nexone' })}
                <div>
                  <label className="block text-sm font-medium mb-2 text-muted-foreground">Brokerage Logo</label>
                  <div className="flex items-center gap-3 flex-wrap">
                    {/* User-supplied external URL — next/image would need
                        runtime domain config for arbitrary brokerage hosts. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {createFormData.logoUrl && <img src={createFormData.logoUrl} alt="Logo" className="h-10 w-auto rounded bg-muted" />}
                    <button type="button"
                      onClick={() => openLogoGenerator('new-brokerage-' + Date.now(), createFormData.name, true)}
                      disabled={!createFormData.name.trim()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed">
                      <Wand2 size={14} />
                      {createFormData.logoIncludesTagline ? 'Regenerate' : 'Generate Logo'}
                    </button>
                    <label className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-colors bg-input border border-border text-foreground hover:bg-muted ${uploadingLogo ? 'opacity-50' : ''}`}>
                      <Upload size={14} />
                      {uploadingLogo ? 'Uploading...' : createFormData.logoUrl ? 'Replace Upload' : 'Upload Logo'}
                      <input type="file" accept="image/jpeg,image/png,image/svg+xml,image/webp" className="hidden" disabled={uploadingLogo}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f, 'new-brokerage-' + Date.now(), true); e.target.value = '' }} />
                    </label>
                    {createFormData.logoIncludesTagline && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-2 py-1 rounded">
                        <Sparkles size={10} /> Generated
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] mt-1 text-muted-foreground/60">Generate a wordmark logo from the brokerage name (recommended), or upload a custom file.</p>
                </div>
              </div>

              {/* Onboarding Contacts (five logins) */}
              <div className="p-4 rounded-lg bg-background border border-dashed border-border">
                <div className="flex items-center gap-2 mb-1">
                  <UserPlus size={16} className="text-primary" />
                  <label className="text-sm font-medium text-foreground">Onboarding Contacts (optional)</label>
                </div>
                <p className="text-xs mb-4 text-muted-foreground">
                  Each non-blank email gets a brokerage admin login and a magic-link setup email.
                  Broker of Record and Brokerage Manager see the Referral Fees tab; Admin 1/2/3 do not.
                  Full name is optional and falls back to the role label.
                </p>
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {renderInput('Broker of Record', createFormData.brokerOfRecordName, (v) => setCreateFormData({ ...createFormData, brokerOfRecordName: v }), { placeholder: 'Full legal name' })}
                    {renderInput('Broker of Record Email', createFormData.brokerOfRecordEmail, (v) => setCreateFormData({ ...createFormData, brokerOfRecordEmail: v }), { placeholder: 'bor@brokerage.com', type: 'email' })}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {renderInput('Brokerage Manager', onboardingContacts.brokerageManagerName, (v) => setOnboardingContacts({ ...onboardingContacts, brokerageManagerName: v }), { placeholder: 'Full legal name' })}
                    {renderInput('Brokerage Manager Email', onboardingContacts.brokerageManagerEmail, (v) => setOnboardingContacts({ ...onboardingContacts, brokerageManagerEmail: v }), { placeholder: 'manager@brokerage.com', type: 'email' })}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {renderInput('Admin 1 Name', onboardingContacts.admin1Name, (v) => setOnboardingContacts({ ...onboardingContacts, admin1Name: v }), { placeholder: 'Full legal name' })}
                    {renderInput('Admin 1 Email', onboardingContacts.admin1Email, (v) => setOnboardingContacts({ ...onboardingContacts, admin1Email: v }), { placeholder: 'admin1@brokerage.com', type: 'email' })}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {renderInput('Admin 2 Name', onboardingContacts.admin2Name, (v) => setOnboardingContacts({ ...onboardingContacts, admin2Name: v }), { placeholder: 'Full legal name' })}
                    {renderInput('Admin 2 Email', onboardingContacts.admin2Email, (v) => setOnboardingContacts({ ...onboardingContacts, admin2Email: v }), { placeholder: 'admin2@brokerage.com', type: 'email' })}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {renderInput('Admin 3 Name', onboardingContacts.admin3Name, (v) => setOnboardingContacts({ ...onboardingContacts, admin3Name: v }), { placeholder: 'Full legal name' })}
                    {renderInput('Admin 3 Email', onboardingContacts.admin3Email, (v) => setOnboardingContacts({ ...onboardingContacts, admin3Email: v }), { placeholder: 'admin3@brokerage.com', type: 'email' })}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2 text-muted-foreground">Notes</label>
                <textarea
                  value={createFormData.notes}
                  onChange={(e) => setCreateFormData({ ...createFormData, notes: e.target.value })}
                  placeholder="Any additional notes..."
                  rows={3}
                  className="w-full px-4 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary resize-none transition-colors"
                />
              </div>
              {/* Agent Roster Upload */}
              <div className="p-4 rounded-lg bg-background border border-dashed border-border">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet size={16} className="text-primary" />
                    <label className="text-sm font-medium text-muted-foreground">Agent Roster (optional)</label>
                  </div>
                  <button type="button" onClick={downloadTemplate}
                    className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded transition-colors text-primary hover:bg-muted"
                  >
                    <Download size={12} /> Download Template
                  </button>
                </div>
                <p className="text-xs mb-3 text-muted-foreground">
                  Upload a .csv or .xlsx with columns: First Name, Last Name, Email, Phone, RECO Number. The Firm Funds onboarding roster works as-is. Agents will be imported automatically when the brokerage is created.
                </p>
                <div className="flex items-center gap-3">
                  <label
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors bg-card text-foreground border border-border hover:border-primary"
                  >
                    <Upload size={14} />
                    {createRosterFile ? 'Change File' : 'Choose File'}
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="hidden"
                      onChange={(e) => setCreateRosterFile(e.target.files?.[0] || null)}
                    />
                  </label>
                  {createRosterFile && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-green-400">{createRosterFile.name}</span>
                      <button type="button" onClick={() => setCreateRosterFile(null)}
                        className="p-0.5 rounded text-muted-foreground hover:text-red-400"
                      ><X size={14} /></button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-3 pt-4">
                <Button type="button" variant="outline" className="flex-1" onClick={() => { setShowCreateForm(false); setCreateRosterFile(null); setOnboardingContacts(emptyOnboardingContactsForm) }}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting} className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {submitting ? 'Saving...' : createRosterFile ? 'Save Brokerage & Import Agents' : 'Save Brokerage'}
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* Brokerage List */}
        {filteredBrokerages.length === 0 ? (
          <div className="rounded-xl px-6 py-16 text-center bg-card border border-border/40 shadow-lg shadow-black/20">
            <p className="text-base font-semibold text-muted-foreground">
              {searchQuery ? 'No brokerages match your search' : 'No brokerages yet'}
            </p>
            <p className="text-sm mt-1 text-muted-foreground/60">
              {searchQuery ? 'Try adjusting your search.' : 'Click "Add Brokerage" to create the first one.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredBrokerages.map((brokerage) => {
              const isExpanded = expandedId === brokerage.id
              const isEditing = editingBrokerageId === brokerage.id
              const allAgents = brokerage.agents
              const nonArchivedAgents = allAgents.filter(a => a.status !== 'archived')
              const archivedAgents = allAgents.filter(a => a.status === 'archived')
              const visibleAgents = showArchived ? allAgents : nonArchivedAgents
              const agentCount = visibleAgents.length
              const activeAgents = allAgents.filter(a => a.status === 'active').length
              // Count agents needing attention in this brokerage
              const pendingKycInBrokerage = allAgents.filter(a => a.kyc_status === 'submitted').length
              const pendingBankingInBrokerage = allAgents.filter(a => a.banking_approval_status === 'pending').length
              const actionCount = pendingKycInBrokerage + pendingBankingInBrokerage

              return (
                <div key={brokerage.id} className={`rounded-xl overflow-hidden transition-all bg-card shadow-lg shadow-black/20 ${isExpanded ? 'border border-primary/50' : 'border border-border/40'}`}>
                  {/* Brokerage Row (click to expand) */}
                  <div
                    className={`flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6 cursor-pointer transition-colors ${isExpanded ? 'bg-muted/30' : 'hover:bg-muted/20'}`}
                    onClick={() => {
                      if (isEditing) return
                      const newId = isExpanded ? null : brokerage.id
                      setExpandedId(newId)
                      setEditingBrokerageId(null)
                      setShowAddAgentFor(null)
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0 sm:flex-1">
                      <div className="flex-shrink-0 text-primary">
                        {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
                          <p className="text-sm font-bold truncate text-foreground">{brokerage.name}</p>
                          {brokerage.brand && (
                            <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">{brokerage.brand}</span>
                          )}
                          {brokerage.is_white_label_partner && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-primary/15 text-primary border border-primary/30"
                              title={`White-label partner, ${Number(brokerage.profit_share_pct ?? 0).toFixed(1)}% profit share`}
                            >
                              White-Label
                            </span>
                          )}
                          {actionCount > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-600 text-white">
                              <AlertCircle size={10} />
                              {actionCount} pending
                            </span>
                          )}
                        </div>
                        <p className="text-xs mt-0.5 text-muted-foreground truncate">{brokerage.email}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-4 sm:flex-shrink-0">
                      <span className={`inline-flex px-2.5 py-1 text-xs font-semibold rounded-md ${getLocalStatusBadgeClass(brokerage.status)}`}>
                        {brokerage.status.charAt(0).toUpperCase() + brokerage.status.slice(1)}
                      </span>
                      {brokerage.kyc_verified ? (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ${getKycBadgeClass('verified')}`}
                          title={`KYC verified${brokerage.kyc_verified_at ? ' on ' + new Date(brokerage.kyc_verified_at).toLocaleDateString('en-CA') : ''}`}
                        >
                          <Shield size={11} /> KYC
                        </span>
                      ) : (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ${getKycBadgeClass('pending')}`}
                          title="KYC not verified"
                        >
                          <Shield size={11} /> No KYC
                        </span>
                      )}
                      <span className="text-xs font-medium text-muted-foreground">
                        {(brokerage.referral_fee_percentage * 100).toFixed(1)}% fee
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Users size={13} className="text-muted-foreground" />
                        <span className="text-xs font-semibold text-foreground">{agentCount}</span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); router.push(`/admin/brokerages/${brokerage.id}`) }}
                        className="p-1.5 rounded-md transition-colors text-muted-foreground hover:bg-muted hover:text-primary"
                        title="Manage admins for this brokerage"
                        aria-label="Manage brokerage admins"
                      >
                        <Shield size={14} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); router.push(`/admin/brokerages/${brokerage.id}/firm-deal-pipe`) }}
                        className="p-1.5 rounded-md transition-colors text-muted-foreground hover:bg-muted hover:text-primary"
                        title="Firm deal pipe (Google Sheet connection)"
                        aria-label="Configure firm deal pipe"
                      >
                        <Inbox size={14} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); openEditForm(brokerage) }}
                        className="p-1.5 rounded-md transition-colors text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Edit2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="border-t border-border/50">
                      {/* Brokerage Details (or Edit Form) */}
                      {isEditing ? (
                        <form onSubmit={(e) => handleEditSubmit(e, brokerage.id)} className="p-6 space-y-4 border-b border-border/50">
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-sm font-bold uppercase tracking-wider text-primary">Edit Brokerage</h4>
                            <button type="button" onClick={() => setEditingBrokerageId(null)} className="text-muted-foreground hover:text-foreground">
                              <X size={16} />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {renderInput('Name', editFormData.name, (v) => setEditFormData({ ...editFormData, name: v }), { required: true })}
                            {renderInput('Email', editFormData.email, (v) => setEditFormData({ ...editFormData, email: v }), { required: true, type: 'email' })}
                            {renderInput('Brand', editFormData.brand, (v) => setEditFormData({ ...editFormData, brand: v }))}
                            <div>
                              <label className="block text-sm font-medium mb-2 text-muted-foreground">Status *</label>
                              <select
                                value={editFormData.status}
                                onChange={(e) => setEditFormData({ ...editFormData, status: e.target.value as 'active' | 'suspended' | 'inactive' | 'archived' })}
                                className={inputCls}
                              >
                                <option value="active">Active</option>
                                <option value="suspended">Suspended</option>
                                <option value="inactive">Inactive</option>
                              </select>
                            </div>
                            {/* Single "Profit Share %" field — see create form for the lockstep note. */}
                            {renderInput('Profit Share %', editFormData.referralFeePercentage, (v) => setEditFormData({ ...editFormData, referralFeePercentage: v }), { required: true, type: 'number', step: '0.1', min: '0', max: '100', hint: 'The brokerage’s negotiated share of the advance fees (discount + settlement). Snapshotted on each funded deal. Raising this above 0 queues welcome emails to roster agents on save.' })}
                            {renderInput('Street Address', editFormData.address, (v) => setEditFormData({ ...editFormData, address: v }))}
                            {renderInput('City', editFormData.city, (v) => setEditFormData({ ...editFormData, city: v }))}
                            {renderInput('Province', editFormData.province, (v) => setEditFormData({ ...editFormData, province: v }))}
                            {renderInput('Postal Code', editFormData.postalCode, (v) => setEditFormData({ ...editFormData, postalCode: v }))}
                            {renderInput('Phone', editFormData.phone, (v) => setEditFormData({ ...editFormData, phone: v }), { type: 'tel' })}
                            {renderInput('Transaction System', editFormData.transactionSystem, (v) => setEditFormData({ ...editFormData, transactionSystem: v }))}
                            {renderInput('Broker of Record', editFormData.brokerOfRecordName, (v) => setEditFormData({ ...editFormData, brokerOfRecordName: v }), { placeholder: 'Full legal name' })}
                            {renderInput('Broker of Record Email', editFormData.brokerOfRecordEmail, (v) => setEditFormData({ ...editFormData, brokerOfRecordEmail: v }), { placeholder: 'broker@brokerage.com', type: 'email' })}
                            <div>
                              <label className="block text-sm font-medium mb-2 text-muted-foreground">Brokerage Logo</label>
                              <div className="flex items-center gap-3 flex-wrap">
                                {/* User-supplied external URL. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {editFormData.logoUrl && <img src={editFormData.logoUrl} alt="Logo" className="h-10 w-auto rounded bg-muted" />}
                                <button type="button"
                                  onClick={() => editingBrokerageId && openLogoGenerator(editingBrokerageId, editFormData.name, false)}
                                  disabled={!editFormData.name.trim()}
                                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed">
                                  <Wand2 size={14} />
                                  {editFormData.logoIncludesTagline ? 'Regenerate' : 'Generate Logo'}
                                </button>
                                <label className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-colors bg-input border border-border text-foreground hover:bg-muted ${uploadingLogo ? 'opacity-50' : ''}`}>
                                  <Upload size={14} />
                                  {uploadingLogo ? 'Uploading...' : editFormData.logoUrl ? 'Replace Upload' : 'Upload Logo'}
                                  <input type="file" accept="image/jpeg,image/png,image/svg+xml,image/webp" className="hidden" disabled={uploadingLogo}
                                    onChange={(e) => { const f = e.target.files?.[0]; if (f && editingBrokerageId) handleLogoUpload(f, editingBrokerageId, false); e.target.value = '' }} />
                                </label>
                                {editFormData.logoUrl && (
                                  <button type="button" onClick={() => setEditFormData(prev => ({ ...prev, logoUrl: '', logoIncludesTagline: false }))}
                                    className="text-xs text-muted-foreground hover:text-foreground">Remove</button>
                                )}
                                {editFormData.logoIncludesTagline && (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-2 py-1 rounded">
                                    <Sparkles size={10} /> Generated
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] mt-1 text-muted-foreground/60">Generate a wordmark logo from the brokerage name, or upload a custom file (JPEG, PNG, SVG, or WebP, max 2MB).</p>
                            </div>
                          </div>
                          <div>
                            <label className="block text-sm font-medium mb-2 text-muted-foreground">Notes</label>
                            <textarea value={editFormData.notes} onChange={(e) => setEditFormData({ ...editFormData, notes: e.target.value })}
                              rows={3} className="w-full px-4 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary resize-none transition-colors" />
                          </div>

                          <div className="flex gap-3 pt-2">
                            <Button type="button" variant="outline" className="flex-1" onClick={() => setEditingBrokerageId(null)}>
                              Cancel
                            </Button>
                            <Button type="submit" disabled={submitting} className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                              {submitting ? 'Saving...' : 'Save Changes'}
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm border-b border-border/50">
                          <FieldValue label="Address">
                            {[brokerage.address, brokerage.city, brokerage.province, brokerage.postal_code].filter(Boolean).join(', ') || '-'}
                          </FieldValue>
                          <FieldValue label="Phone">{brokerage.phone || '-'}</FieldValue>
                          <FieldValue label="Transaction System">{brokerage.transaction_system || '-'}</FieldValue>
                          <FieldValue label="Notes">{brokerage.notes || '-'}</FieldValue>
                          <FieldValue
                            label="Broker of Record"
                            detail={brokerage.broker_of_record_email || undefined}
                          >
                            {brokerage.broker_of_record_name || '-'}
                          </FieldValue>
                        </div>
                      )}

                      {/* FINTRAC KYC Verification */}
                      <BrokerageRowSection
                        icon={<Shield size={15} className="text-primary" />}
                        title="FINTRAC - RECO Verification"
                        titleExtras={
                          brokerage.kyc_verified ? (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ml-2 ${getKycBadgeClass('verified')}`}>
                              <CheckCircle size={11} /> Verified
                            </span>
                          ) : undefined
                        }
                      >
                        {brokerage.kyc_verified ? (
                          /* Verified state - show verification details */
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                              <FieldValue label="RECO Reg #">{brokerage.reco_registration_number || '-'}</FieldValue>
                              <FieldValue label="Verified On">
                                {brokerage.reco_verification_date
                                  ? new Date(brokerage.reco_verification_date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
                                  : '-'}
                              </FieldValue>
                              <FieldValue label="Verified By">{brokerage.kyc_verified_by || '-'}</FieldValue>
                              <FieldValue label="Notes">{brokerage.reco_verification_notes || '-'}</FieldValue>
                            </div>
                            <button
                              onClick={async () => {
                                if (!confirm('Revoke KYC verification for this brokerage? This will require re-verification.')) return
                                setKycSubmitting(true)
                                const result = await revokeBrokerageKyc({ brokerageId: brokerage.id })
                                if (result.success) {
                                  setStatusMessage({ type: 'success', text: 'KYC verification revoked' })
                                  await loadBrokerages()
                                } else {
                                  setStatusMessage({ type: 'error', text: result.error || 'Failed to revoke KYC' })
                                }
                                setKycSubmitting(false)
                              }}
                              disabled={kycSubmitting}
                              className="text-xs px-3 py-1 rounded transition-colors mt-1 bg-red-950/50 text-red-400 border border-red-800 hover:bg-red-950/70 disabled:opacity-50"
                            >
                              Revoke Verification
                            </button>
                          </div>
                        ) : (
                          /* Not verified - show verification form */
                          <div className="space-y-3">
                            <p className="text-xs text-muted-foreground">
                              Verify this brokerage on the RECO Public Register, then record the verification below.
                            </p>
                            <a
                              href={RECO_PUBLIC_REGISTER_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity hover:opacity-85"
                              style={{ background: 'var(--status-blue-muted)', color: 'var(--status-blue)', border: '1px solid var(--status-blue-border)' }}
                            >
                              <ExternalLink size={12} /> Open RECO Public Register
                            </a>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium mb-1 text-muted-foreground">RECO Registration Number *</label>
                                <input
                                  type="text"
                                  value={kycRecoNumber}
                                  onChange={(e) => setKycRecoNumber(e.target.value)}
                                  placeholder="e.g. 12345"
                                  className={inputCls}
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium mb-1 text-muted-foreground">Verification Notes</label>
                                <input
                                  type="text"
                                  value={kycNotes}
                                  onChange={(e) => setKycNotes(e.target.value)}
                                  placeholder="e.g. Confirmed active on RECO register"
                                  className={inputCls}
                                />
                              </div>
                            </div>
                            <button
                              onClick={async () => {
                                if (!kycRecoNumber.trim()) { setStatusMessage({ type: 'error', text: 'RECO registration number is required' }); return }
                                setKycSubmitting(true)
                                const result = await verifyBrokerageKyc({
                                  brokerageId: brokerage.id,
                                  recoRegistrationNumber: kycRecoNumber,
                                  verificationNotes: kycNotes,
                                })
                                if (result.success) {
                                  setStatusMessage({ type: 'success', text: `${brokerage.name} KYC verified successfully` })
                                  setKycRecoNumber('')
                                  setKycNotes('')
                                  await loadBrokerages()
                                } else {
                                  setStatusMessage({ type: 'error', text: result.error || 'Verification failed' })
                                }
                                setKycSubmitting(false)
                              }}
                              disabled={kycSubmitting || !kycRecoNumber.trim()}
                              className="flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
                            >
                              <CheckCircle size={13} /> {kycSubmitting ? 'Verifying...' : 'Mark as KYC Verified'}
                            </button>
                          </div>
                        )}
                      </BrokerageRowSection>

                      {/* Settlement Window + Late Strikes */}
                      <LateStrikeSection brokerage={brokerage} onChange={loadBrokerages} />

                      {/* Brokerage Cooperation Agreement (BCA) */}
                      <BcaStatusSection brokerage={brokerage} />

                      {/* Brokerage Portal Access */}
                      <BrokerageRowSection
                        icon={<Mail size={15} className="text-primary" />}
                        title="Brokerage Portal Access"
                        compact
                        headerSpacing=""
                        rightSlot={
                          <button
                            onClick={() => handleSendBrokerageWelcome(brokerage)}
                            disabled={sendingBrokerageWelcome === brokerage.id}
                            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors text-primary border border-border hover:bg-muted hover:border-primary disabled:opacity-60"
                          >
                            <Mail size={13} />
                            {sendingBrokerageWelcome === brokerage.id ? 'Sending...' : `Send Welcome Email to ${brokerage.email}`}
                          </button>
                        }
                      />

                      {/* Agent Roster */}
                      <BrokerageRowSection
                        icon={<Users size={15} className="text-primary" />}
                        noBorder
                        headerSpacing="mb-4"
                        title={
                          <>
                            Agent Roster
                            <span className="font-normal ml-1.5 text-muted-foreground">
                              ({activeAgents} active{nonArchivedAgents.length !== activeAgents ? `, ${nonArchivedAgents.length} total` : ''}{archivedAgents.length > 0 ? `, ${archivedAgents.length} archived` : ''})
                            </span>
                          </>
                        }
                        titleExtras={
                          archivedAgents.length > 0 ? (
                            <button
                              onClick={() => setShowArchived(!showArchived)}
                              className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors text-muted-foreground border border-border hover:bg-muted"
                            >
                              {showArchived ? <EyeOff size={11} /> : <Eye size={11} />}
                              {showArchived ? 'Hide Archived' : 'Show Archived'}
                            </button>
                          ) : undefined
                        }
                        rightSlot={
                          showAddAgentFor !== brokerage.id ? (
                            <div className="flex items-center gap-2 flex-wrap">
                              <button
                                onClick={() => { setShowAddAgentFor(brokerage.id); setAgentForm(emptyAgentForm) }}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors text-primary border border-border hover:bg-muted hover:border-primary"
                              >
                                <UserPlus size={13} /> Add Agent
                              </button>
                              <label
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors cursor-pointer text-primary border border-border hover:bg-muted hover:border-primary"
                              >
                                <Upload size={13} /> Import Roster
                                <input
                                  type="file"
                                  accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                                  className="hidden"
                                  onChange={(e) => handleFileUpload(e, brokerage.id)}
                                  disabled={submitting}
                                />
                              </label>
                              <button
                                onClick={downloadTemplate}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors text-muted-foreground border border-border hover:bg-muted hover:text-foreground"
                                title="Download CSV template"
                              >
                                <Download size={13} /> Template
                              </button>
                              <button
                                onClick={() => handleSendWelcomeToAll(brokerage.id, brokerage.name)}
                                disabled={sendingAllFor === brokerage.id}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors text-primary border border-border hover:bg-muted hover:border-primary disabled:opacity-60"
                                title="Send welcome email with magic link to all agents in this brokerage"
                              >
                                <Mail size={13} /> {sendingAllFor === brokerage.id ? 'Sending...' : 'Send Welcome to All'}
                              </button>
                              <button
                                onClick={() => handleLoadUserProfiles(brokerage.id)}
                                disabled={loadingUserProfiles === brokerage.id}
                                className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors border disabled:opacity-60 ${
                                  showUserManagement === brokerage.id
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'text-primary border-border hover:bg-muted hover:border-primary'
                                }`}
                                title="Manage brokerage admin logins"
                              >
                                <KeyRound size={13} /> {loadingUserProfiles === brokerage.id ? 'Loading...' : 'Manage Logins'}
                              </button>
                              <button
                                onClick={async () => {
                                  const agentCount = brokerage.agents?.length || 0
                                  const confirmed = confirm(`PERMANENTLY DELETE "${brokerage.name}"${agentCount > 0 ? ` and its ${agentCount} agent(s)` : ''}? This cannot be undone.`)
                                  if (!confirmed) return
                                  setSubmitting(true)
                                  // Archive first (required before permanent delete)
                                  if (brokerage.status !== 'archived') {
                                    const archiveResult = await archiveBrokerage({ brokerageId: brokerage.id })
                                    if (!archiveResult.success) {
                                      setStatusMessage({ type: 'error', text: archiveResult.error || 'Failed to archive brokerage' })
                                      setSubmitting(false)
                                      return
                                    }
                                  }
                                  const result = await permanentlyDeleteBrokerage({ brokerageId: brokerage.id })
                                  if (result.success) {
                                    setStatusMessage({ type: 'success', text: `"${brokerage.name}" has been permanently deleted.` })
                                    loadBrokerages()
                                  } else {
                                    setStatusMessage({ type: 'error', text: result.error || 'Failed to delete brokerage' })
                                  }
                                  setSubmitting(false)
                                }}
                                disabled={submitting}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 bg-red-950/50 text-red-400 border border-red-800 hover:bg-red-950/70"
                                title="Permanently delete this brokerage and all its data"
                              >
                                <Trash2 size={13} /> Delete
                              </button>
                            </div>
                          ) : undefined
                        }
                      >

                        {/* Brokerage Admin Login Management Panel */}
                        {showUserManagement === brokerage.id && brokerageUserProfiles[brokerage.id] && (
                          <div className="mb-4 p-4 rounded-lg bg-blue-950/20 border border-blue-800/50">
                            <h4 className="text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2 text-blue-400">
                              <KeyRound size={14} /> Brokerage Admin Login{brokerageUserProfiles[brokerage.id].brokerageAdmins.length !== 1 ? 's' : ''}
                            </h4>
                            {brokerageUserProfiles[brokerage.id].brokerageAdmins.length === 0 ? (
                              <div>
                                {!showCreateBrokerageLogin ? (
                                  <div className="flex items-center justify-between">
                                    <p className="text-xs text-muted-foreground">No brokerage admin login found.</p>
                                    <button
                                      onClick={() => { setShowCreateBrokerageLogin(true); setBrokerageLoginForm({ fullName: '', email: brokerage.email || '' }) }}
                                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90"
                                    >
                                      <Plus size={13} /> Create Login
                                    </button>
                                  </div>
                                ) : (
                                  <div className="p-3 rounded-lg space-y-3 bg-card border border-border">
                                    <div className="flex items-center justify-between">
                                      <p className="text-xs font-bold uppercase tracking-wider text-primary">Create Brokerage Admin Login</p>
                                      <button onClick={() => setShowCreateBrokerageLogin(false)} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <div>
                                        <label className="block text-[10px] font-semibold mb-0.5 text-muted-foreground">Full Name *</label>
                                        <input
                                          type="text" value={brokerageLoginForm.fullName}
                                          onChange={(e) => setBrokerageLoginForm({ ...brokerageLoginForm, fullName: e.target.value })}
                                          className="w-full rounded-md px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary" placeholder="e.g. John Smith"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-[10px] font-semibold mb-0.5 text-muted-foreground">Email *</label>
                                        <input
                                          type="email" value={brokerageLoginForm.email}
                                          onChange={(e) => setBrokerageLoginForm({ ...brokerageLoginForm, email: e.target.value })}
                                          className="w-full rounded-md px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary" placeholder="admin@brokerage.com"
                                        />
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => handleCreateBrokerageLogin(brokerage.id, brokerage.name)}
                                        disabled={creatingBrokerageLogin || !brokerageLoginForm.fullName.trim() || !brokerageLoginForm.email.trim()}
                                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
                                      >
                                        <Mail size={13} /> {creatingBrokerageLogin ? 'Sending...' : 'Create Login & Send Setup Link'}
                                      </button>
                                      <button
                                        onClick={() => setShowCreateBrokerageLogin(false)}
                                        className="text-xs px-3 py-1.5 rounded-md text-muted-foreground border border-border hover:bg-muted"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                    <p className="text-[10px] text-muted-foreground/60">
                                      <Mail size={10} className="inline mr-1" style={{ verticalAlign: 'middle' }} />
                                      A branded setup email will be sent with a magic link. They&apos;ll set their own password - no credentials to share.
                                    </p>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {brokerageUserProfiles[brokerage.id].brokerageAdmins.map(admin => (
                                  <div key={admin.id} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-card border border-border/50">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium truncate text-foreground">{admin.full_name}</p>
                                      <p className="text-xs truncate text-muted-foreground">{admin.email}</p>
                                      <p className="text-[10px] text-muted-foreground/60">
                                        Last login: {admin.last_login ? new Date(admin.last_login).toLocaleString('en-CA') : 'Never'}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        onClick={() => handleResetPassword(admin.id, admin.full_name ?? admin.email ?? admin.id, 'user')}
                                        disabled={resettingPasswordForUserId === admin.id}
                                        className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 bg-yellow-950/50 text-yellow-400 border border-yellow-800 hover:bg-yellow-950/70"
                                      >
                                        <KeyRound size={12} /> Reset Password
                                      </button>
                                      <button
                                        onClick={() => { setChangingEmailForUserId(changingEmailForUserId === admin.id ? null : admin.id); setChangeEmailValue(admin.email ?? '') }}
                                        className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors border ${
                                          changingEmailForUserId === admin.id
                                            ? 'bg-primary/20 text-blue-400 border-primary'
                                            : 'text-blue-400 bg-card border-border hover:bg-blue-950/30'
                                        }`}
                                      >
                                        <AtSign size={12} /> Change Email
                                      </button>
                                      <button
                                        onClick={() => handleResendSetupLink(admin.id, admin.full_name ?? admin.email ?? admin.id)}
                                        disabled={resendingSetupLink === admin.id}
                                        className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 text-primary bg-card border border-border hover:bg-muted hover:border-primary"
                                      >
                                        <Mail size={12} /> {resendingSetupLink === admin.id ? 'Sending...' : 'Resend Setup Link'}
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                {/* Inline email change for brokerage admin */}
                                {brokerageUserProfiles[brokerage.id].brokerageAdmins.some(a => changingEmailForUserId === a.id) && (
                                  <div className="flex items-center gap-2 p-2 rounded-lg bg-card border border-border">
                                    <input
                                      type="email"
                                      value={changeEmailValue}
                                      onChange={(e) => setChangeEmailValue(e.target.value)}
                                      className="rounded-md px-2 py-1 text-xs flex-1 bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                                      placeholder="New login email"
                                    />
                                    <button
                                      onClick={() => {
                                        const admin = brokerageUserProfiles[brokerage.id].brokerageAdmins.find(a => a.id === changingEmailForUserId)
                                        if (admin) handleChangeEmail(admin.id, admin.full_name ?? admin.email ?? admin.id, 'user', brokerage.id)
                                      }}
                                      disabled={changingEmailSaving || !changeEmailValue.trim()}
                                      className="text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
                                    >
                                      {changingEmailSaving ? 'Saving...' : 'Save'}
                                    </button>
                                    <button
                                      onClick={() => { setChangingEmailForUserId(null); setChangeEmailValue('') }}
                                      className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:text-foreground"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Add Agent Form */}
                        {showAddAgentFor === brokerage.id && (
                          <form onSubmit={(e) => handleAddAgent(e, brokerage.id)}
                            className="mb-4 p-4 rounded-lg space-y-3 bg-background border border-border"
                          >
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-bold uppercase tracking-wider text-primary">New Agent</p>
                              <button type="button" onClick={() => setShowAddAgentFor(null)} className="text-muted-foreground hover:text-foreground">
                                <X size={14} />
                              </button>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              {renderInput('First Name', agentForm.firstName, (v) => setAgentForm({ ...agentForm, firstName: v }), { required: true })}
                              {renderInput('Last Name', agentForm.lastName, (v) => setAgentForm({ ...agentForm, lastName: v }), { required: true })}
                              {renderInput('Email', agentForm.email, (v) => setAgentForm({ ...agentForm, email: v }), { type: 'email', placeholder: 'Optional for testing' })}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {renderInput('Phone', agentForm.phone, (v) => setAgentForm({ ...agentForm, phone: v }), { type: 'tel' })}
                              {renderInput('RECO Number', agentForm.recoNumber, (v) => setAgentForm({ ...agentForm, recoNumber: v }))}
                            </div>
                            <div className="flex items-center gap-2 pt-1">
                              <input
                                type="checkbox"
                                id={`invite-${brokerage.id}`}
                                checked={sendInvite}
                                onChange={(e) => setSendInvite(e.target.checked)}
                                className="rounded accent-primary"
                              />
                              <label htmlFor={`invite-${brokerage.id}`} className="text-xs font-medium cursor-pointer text-foreground">
                                Create login
                              </label>
                              <span className="text-xs text-muted-foreground">
                                {sendInvite ? '(login created, send welcome email later)' : '(roster only, no login)'}
                              </span>
                            </div>
                            <div className="flex gap-3 pt-1">
                              <Button type="button" variant="outline" onClick={() => { setShowAddAgentFor(null); setSendInvite(true) }}>
                                Cancel
                              </Button>
                              <Button type="submit" disabled={submitting} className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                                {submitting ? (sendInvite ? 'Creating...' : 'Adding...') : (sendInvite ? 'Add Agent + Login' : 'Add Agent')}
                              </Button>
                            </div>
                          </form>
                        )}

                        {/* Import Results */}
                        {importingFor === brokerage.id && importResult && (
                          <div className="mb-4 p-4 rounded-lg space-y-2 bg-background border border-border">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <FileSpreadsheet size={15} className="text-primary" />
                                <p className="text-sm font-bold text-foreground">
                                  Import Results
                                </p>
                              </div>
                              <button onClick={() => { setImportResult(null); setImportingFor(null) }}
                                className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                            </div>
                            <div className="flex gap-4 text-sm">
                              <span className="text-green-400">{importResult.imported} imported</span>
                              {importResult.skipped > 0 && (
                                <span className="text-yellow-400">{importResult.skipped} skipped</span>
                              )}
                            </div>
                            {importResult.errors.length > 0 && (
                              <div className="text-xs space-y-1 max-h-32 overflow-y-auto mt-2 p-2 rounded bg-card border border-border">
                                {importResult.errors.map((err, i) => (
                                  <p key={i} className="text-yellow-400">{err}</p>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Agent List */}
                        {agentCount === 0 ? (
                          <EmptyState
                            compact
                            icon={Users}
                            title="No agents added yet"
                            description="Add an agent above or bulk-import a roster to populate this brokerage."
                          />
                        ) : (
                          <div className="overflow-x-auto rounded-lg border border-border">
                            <table className="w-full">
                              <thead>
                                <tr className="bg-muted/50">
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Email</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Phone</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">RECO #</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">Status</th>
                                  <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground">Balance</th>
                                  <th className="px-4 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">KYC</th>
                                  <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleAgents
                                  .sort((a, b) => a.last_name.localeCompare(b.last_name))
                                  .map((agent, idx) => {
                                    const isAgentMatch = q && (
                                      `${agent.first_name} ${agent.last_name}`.toLowerCase().includes(q) ||
                                      (agent.email || '').toLowerCase().includes(q)
                                    )
                                    const isEditingAgent = editingAgentId === agent.id

                                    if (isEditingAgent) {
                                      return (
                                        <tr key={agent.id} className="bg-primary/5 border-b border-border">
                                          <td className="px-3 py-2" colSpan={8}>
                                            <form onSubmit={(e) => handleEditAgentSubmit(e, agent.id, brokerage.id)} className="space-y-3">
                                              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">First Name *</label>
                                                  <input value={editAgentForm.firstName} onChange={(e) => setEditAgentForm({ ...editAgentForm, firstName: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">Last Name *</label>
                                                  <input value={editAgentForm.lastName} onChange={(e) => setEditAgentForm({ ...editAgentForm, lastName: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">Email *</label>
                                                  <input type="email" value={editAgentForm.email} onChange={(e) => setEditAgentForm({ ...editAgentForm, email: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">Phone</label>
                                                  <input value={editAgentForm.phone} onChange={(e) => setEditAgentForm({ ...editAgentForm, phone: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                                <div>
                                                  <label className="block text-xs font-semibold mb-1 text-muted-foreground">RECO #</label>
                                                  <input value={editAgentForm.recoNumber} onChange={(e) => setEditAgentForm({ ...editAgentForm, recoNumber: e.target.value })}
                                                    className={inputCls} />
                                                </div>
                                              </div>
                                              <div className="flex items-center gap-4">
                                                <div className="flex items-center gap-2">
                                                  <label className="text-xs font-semibold text-muted-foreground">Status:</label>
                                                  <select value={editAgentForm.status} onChange={(e) => setEditAgentForm({ ...editAgentForm, status: e.target.value })}
                                                    className="px-2 py-1 rounded text-xs bg-input border border-border text-foreground focus:outline-none focus:border-primary">
                                                    <option value="active">Active</option>
                                                    <option value="suspended">Suspended</option>
                                                    <option value="archived">Archived</option>
                                                  </select>
                                                </div>
                                                <label className="flex items-center gap-1.5 text-xs cursor-pointer text-muted-foreground">
                                                  <input type="checkbox" checked={editAgentForm.flaggedByBrokerage}
                                                    onChange={(e) => setEditAgentForm({ ...editAgentForm, flaggedByBrokerage: e.target.checked })} />
                                                  Flagged by Brokerage
                                                </label>
                                                <div className="flex items-center gap-1.5">
                                                  <label className="text-xs font-semibold text-muted-foreground">Recovery $:</label>
                                                  <input type="number" step="0.01" min="0" value={editAgentForm.outstandingRecovery}
                                                    onChange={(e) => setEditAgentForm({ ...editAgentForm, outstandingRecovery: e.target.value })}
                                                    className="w-24 px-2 py-1 rounded text-xs bg-input border border-border text-foreground focus:outline-none focus:border-primary" />
                                                </div>
                                                <div className="flex-1" />
                                                <button type="button" onClick={() => setEditingAgentId(null)}
                                                  className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors text-muted-foreground border border-border hover:bg-muted">
                                                  Cancel
                                                </button>
                                                <button type="submit" disabled={submitting}
                                                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors disabled:opacity-50 bg-primary hover:bg-primary/90">
                                                  {submitting ? 'Saving...' : 'Save'}
                                                </button>
                                              </div>
                                            </form>
                                          </td>
                                        </tr>
                                      )
                                    }

                                    const needsAction = agent.kyc_status === 'submitted' || agent.banking_approval_status === 'pending'
                                    return [
                                      <tr key={agent.id}
                                        className={`transition-colors ${isAgentMatch ? 'bg-primary/5 border-l-2 border-l-primary' : needsAction ? 'bg-amber-500/5 border-l-2 border-l-amber-500' : 'hover:bg-muted/20'} ${idx < agentCount - 1 ? 'border-b border-border' : ''}`}
                                      >
                                        <td className="px-4 py-3 text-sm font-medium text-foreground">
                                          <button
                                            onClick={() => handleExpandAgent(agent.id)}
                                            className="flex items-center gap-2 cursor-pointer transition-colors text-primary hover:underline"
                                            title="Click to view deals"
                                          >
                                            <span>{agent.first_name} {agent.last_name}</span>
                                            {expandedAgentId === agent.id && <ChevronDown size={14} />}
                                            {expandedAgentId !== agent.id && <ChevronRight size={14} />}
                                          </button>
                                          {(() => {
                                            const addr = [agent.address_street, agent.address_city, agent.address_province, agent.address_postal_code].filter(Boolean).join(', ')
                                            return addr ? (
                                              <p className="text-[11px] text-muted-foreground/70 mt-0.5 leading-tight">{addr}</p>
                                            ) : null
                                          })()}
                                          {agent.flagged_by_brokerage && (
                                            <span className="inline-block text-xs px-1.5 py-0.5 rounded font-semibold mt-1 bg-red-950/50 text-red-400 border border-red-800">
                                              Flagged
                                            </span>
                                          )}
                                          {agent.kyc_status === 'submitted' && (
                                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold mt-1 bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                              <Shield size={9} /> ID needs review
                                            </span>
                                          )}
                                          {agent.banking_approval_status === 'pending' && (
                                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold mt-1 bg-blue-500/15 text-blue-400 border border-blue-500/30">
                                              <CreditCard size={9} /> Banking needs review
                                            </span>
                                          )}
                                          {agent.account_activated_at ? (
                                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold mt-1 bg-primary/15 text-primary border border-primary/30"
                                              title={`Activated ${new Date(agent.account_activated_at).toLocaleDateString('en-CA')}`}>
                                              <CheckCircle2 size={9} /> Activated
                                            </span>
                                          ) : agent.welcome_email_sent_at ? (
                                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold mt-1 bg-blue-500/15 text-blue-400 border border-blue-500/30"
                                              title={`Welcome sent ${new Date(agent.welcome_email_sent_at).toLocaleDateString('en-CA')}`}>
                                              <Clock size={9} /> Setup pending
                                            </span>
                                          ) : null}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-muted-foreground">{agent.email || '-'}</td>
                                        <td className="px-4 py-3 text-sm text-muted-foreground">{agent.phone || '-'}</td>
                                        <td className="px-4 py-3 text-sm text-muted-foreground">{agent.reco_number || '-'}</td>
                                        <td className="px-4 py-3">
                                          <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded ${getLocalStatusBadgeClass(agent.status)}`}>
                                            {agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
                                          </span>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                          {(agent.account_balance || 0) > 0 ? (
                                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-status-amber tabular-nums">
                                              <DollarSign size={11} />
                                              {formatCurrency(agent.account_balance)}
                                            </span>
                                          ) : (
                                            <span className="text-xs text-muted-foreground/50">-</span>
                                          )}
                                        </td>
                                        <td className="px-4 py-3">
                                          {(() => {
                                            const kycStatus = agent.kyc_status || 'pending'
                                            const kycBadgeClass = getKycBadgeClass(kycStatus)
                                            return (
                                              <div className="flex flex-col gap-1">
                                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded w-fit ${kycBadgeClass}`}
                                                >
                                                  <Shield size={10} />
                                                  {kycStatus === 'pending' ? 'Pending' : kycStatus === 'submitted' ? 'Submitted' : kycStatus === 'verified' ? 'Verified' : 'Rejected'}
                                                </span>
                                                {kycStatus === 'submitted' && (
                                                  <div className="flex flex-col gap-1.5 mt-1.5">
                                                    {/* VIEW ID - large button */}
                                                    <button
                                                      onClick={async (e) => {
                                                        e.stopPropagation()
                                                        setKycPreviewLoading(agent.id)
                                                        const urlRes = await getAgentKycDocumentUrl({ agentId: agent.id })
                                                        if (urlRes.success && urlRes.data?.urls) {
                                                          const urls: string[] = urlRes.data.urls
                                                          try {
                                                            // Fetch all as blobs to bypass content-blocking headers
                                                            const blobUrls: string[] = []
                                                            for (const url of urls) {
                                                              const response = await fetch(url)
                                                              const arrayBuffer = await response.arrayBuffer()
                                                              const mimeType = response.headers.get('content-type') || 'image/png'
                                                              const blob = new Blob([arrayBuffer], { type: mimeType })
                                                              blobUrls.push(URL.createObjectURL(blob))
                                                            }
                                                            if (kycPreviewPanel) {
                                                              for (const u of kycPreviewPanel.blobUrls) URL.revokeObjectURL(u)
                                                            }
                                                            setKycChecks({ nameMatch: false, addressMatch: false, idValid: false })
                                                            // Build address string from agent fields
                                                            const addrParts = [
                                                              agent.address_street,
                                                              agent.address_city,
                                                              agent.address_province,
                                                              agent.address_postal_code,
                                                            ].filter(Boolean)
                                                            setKycPreviewPanel({
                                                              blobUrls,
                                                              originalUrls: urls,
                                                              fileName: `${agent.first_name}_${agent.last_name}_ID`,
                                                              agentName: `${agent.first_name} ${agent.last_name}`,
                                                              agentId: agent.id,
                                                              agentPhone: agent.phone || null,
                                                              agentAddress: addrParts.length > 0 ? addrParts.join(', ') : null,
                                                            })
                                                          } catch {
                                                            window.open(urls[0], '_blank')
                                                          }
                                                        } else {
                                                          setStatusMessage({ type: 'error', text: urlRes.error || 'Failed to load ID' })
                                                        }
                                                        setKycPreviewLoading(null)
                                                      }}
                                                      disabled={kycPreviewLoading === agent.id}
                                                      className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all disabled:opacity-50 hover:opacity-90"
                                                      style={{ color: 'var(--status-blue)', background: 'var(--status-blue-muted)', border: '1px solid var(--status-blue-border)' }}
                                                    >
                                                      <Eye size={13} />
                                                      {kycPreviewLoading === agent.id ? 'Loading...' : 'View ID'}
                                                    </button>
                                                    {/* Approve/Reject only available through View ID panel (requires verification checklist) */}
                                                    <p className="text-[10px] text-muted-foreground italic">View ID to approve or reject</p>
                                                  </div>
                                                )}
                                                {kycRejectingAgentId === agent.id && (
                                                  <div className="flex flex-col gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                      type="text"
                                                      value={kycRejectReason}
                                                      onChange={(e) => setKycRejectReason(e.target.value)}
                                                      placeholder="Reason for rejection..."
                                                      className="text-xs px-3 py-2 rounded-md bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary w-full"
                                                      autoFocus
                                                      onKeyDown={(e) => {
                                                        if (e.key === 'Escape') setKycRejectingAgentId(null)
                                                      }}
                                                    />
                                                    <div className="flex items-center gap-1.5">
                                                      <button
                                                        onClick={async () => {
                                                          if (!kycRejectReason.trim()) return
                                                          setKycSubmitting(true)
                                                          const result = await rejectAgentKyc({ agentId: agent.id, reason: kycRejectReason })
                                                          if (result.success) {
                                                            setStatusMessage({ type: 'success', text: `${agent.first_name} ${agent.last_name} KYC rejected` })
                                                            setKycRejectingAgentId(null)
                                                            await loadBrokerages()
                                                          } else {
                                                            setStatusMessage({ type: 'error', text: result.error || 'Rejection failed' })
                                                          }
                                                          setKycSubmitting(false)
                                                        }}
                                                        disabled={kycSubmitting || !kycRejectReason.trim()}
                                                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold disabled:opacity-50 transition-all text-white hover:opacity-90"
                                                        style={{ background: 'var(--action-red)', border: '1px solid var(--action-red-border)' }}
                                                      >
                                                        Confirm Reject
                                                      </button>
                                                      <button
                                                        onClick={() => setKycRejectingAgentId(null)}
                                                        className="px-3 py-1.5 rounded-md text-xs transition-all text-muted-foreground border border-border hover:bg-muted"
                                                      >
                                                        Cancel
                                                      </button>
                                                    </div>
                                                  </div>
                                                )}
                                              </div>
                                            )
                                          })()}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                          <div className="flex items-center justify-end gap-1">
                                            <button
                                              onClick={() => openEditAgent(agent)}
                                              className="text-xs px-2 py-1 rounded transition-colors text-muted-foreground hover:text-primary hover:bg-primary/10"
                                              title="Edit agent"
                                            >
                                              <Edit2 size={13} />
                                            </button>
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleResendWelcome(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={resendingAgentId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 text-muted-foreground hover:text-green-400 hover:bg-green-950/30"
                                                title="Resend welcome email"
                                              >
                                                <Mail size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleResetPassword(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={resettingPasswordForUserId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 text-muted-foreground hover:text-yellow-400 hover:bg-yellow-950/30"
                                                title="Reset password"
                                              >
                                                <KeyRound size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => { setChangingEmailForUserId(changingEmailForUserId === agent.id ? null : agent.id); setChangeEmailValue(agent.email || '') }}
                                                className={`text-xs px-2 py-1 rounded transition-colors ${
                                                  changingEmailForUserId === agent.id ? 'text-primary' : 'text-muted-foreground hover:text-blue-400 hover:bg-blue-950/30'
                                                }`}
                                                title="Change login email"
                                              >
                                                <AtSign size={13} />
                                              </button>
                                            )}
                                            {agent.status !== 'archived' && (
                                              <button
                                                onClick={() => handleArchiveAgent(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={archivingAgentId === agent.id}
                                                className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 text-muted-foreground hover:text-red-400 hover:bg-red-950/30"
                                                title="Archive agent"
                                              >
                                                <Archive size={13} />
                                              </button>
                                            )}
                                            {agent.status === 'archived' && (
                                              <button
                                                onClick={() => handlePermanentlyDeleteAgent(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={deletingAgentId === agent.id}
                                                className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 bg-red-950/50 text-red-400 border border-red-800 hover:bg-red-950/70"
                                                title="Permanently delete agent and all associated data"
                                              >
                                                <Trash2 size={12} /> {deletingAgentId === agent.id ? 'Deleting...' : 'Delete'}
                                              </button>
                                            )}
                                          </div>
                                        </td>
                                      </tr>,
                                      // Inline email change row
                                      changingEmailForUserId === agent.id && (
                                        <tr key={`email-${agent.id}`} className="bg-blue-950/20 border-b border-border">
                                          <td colSpan={8} className="px-4 py-2">
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <AtSign size={14} className="text-blue-400" />
                                              <span className="text-xs font-semibold text-blue-400">Change login email for {agent.first_name} {agent.last_name}:</span>
                                              <input
                                                type="email"
                                                value={changeEmailValue}
                                                onChange={(e) => setChangeEmailValue(e.target.value)}
                                                className="rounded-md px-2 py-1 text-xs flex-1 min-w-[200px] bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                                                placeholder="New email address"
                                              />
                                              <button
                                                onClick={() => handleChangeEmail(agent.id, `${agent.first_name} ${agent.last_name}`)}
                                                disabled={changingEmailSaving || !changeEmailValue.trim() || changeEmailValue === (agent.email || '')}
                                                className="text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90"
                                              >
                                                {changingEmailSaving ? 'Saving...' : 'Save'}
                                              </button>
                                              <button
                                                onClick={() => { setChangingEmailForUserId(null); setChangeEmailValue('') }}
                                                className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:text-foreground"
                                              >
                                                Cancel
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      ),
                                      // Expanded deals row
                                      expandedAgentId === agent.id && (
                                        <tr key={`deals-${agent.id}`} className={`bg-card ${idx < agentCount - 1 ? 'border-b border-border' : ''}`}>
                                          <td colSpan={8} className="px-4 py-4">
                                            <div style={{ marginLeft: '20px' }}>
                                              {/* Banking Information */}
                                              <div className="mb-5 p-3 rounded-lg bg-muted/20 border border-border">
                                                <div className="flex items-center justify-between mb-2">
                                                  <h4 className="text-xs font-semibold flex items-center gap-1.5 text-foreground">
                                                    <CreditCard size={13} className="text-primary" />
                                                    Banking Information
                                                  </h4>
                                                  <div className="flex items-center gap-2">
                                                    {agent.preauth_form_path && (
                                                      <button
                                                        onClick={async () => {
                                                          try {
                                                            setPreauthViewingAgentId(agent.id)
                                                            const result = await getAgentPreauthFormSignedUrl({ agentId: agent.id })
                                                            if (result.success && typeof result.data?.signedUrl === 'string') {
                                                              // Fetch as blob to bypass content-blocking headers
                                                              const response = await fetch(result.data.signedUrl)
                                                              const arrayBuffer = await response.arrayBuffer()
                                                              const mimeType = response.headers.get('content-type') || 'application/pdf'
                                                              const blob = new Blob([arrayBuffer], { type: mimeType })
                                                              const blobUrl = URL.createObjectURL(blob)
                                                              setPreauthViewType(mimeType.startsWith('image/') ? 'image' : 'pdf')
                                                              setPreauthViewUrl(blobUrl)
                                                            }
                                                          } catch { /* ignore */ }
                                                          setPreauthViewingAgentId(null)
                                                        }}
                                                        disabled={preauthViewingAgentId === agent.id}
                                                        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors bg-input text-primary border border-border hover:bg-muted disabled:opacity-50"
                                                      >
                                                        <Eye size={12} />
                                                        {preauthViewingAgentId === agent.id ? 'Loading...' : 'View void cheque / direct deposit'}
                                                      </button>
                                                    )}
                                                    {!agent.preauth_form_path && (
                                                      <span className="text-xs text-muted-foreground">No void cheque / direct deposit form uploaded</span>
                                                    )}
                                                  </div>
                                                </div>
                                                {/* Direct-deposit authorization consent (migration 107) */}
                                                <p className="text-xs mb-2">
                                                  {agent.deposit_authorized_at ? (
                                                    <span className="inline-flex items-center gap-1.5 text-green-400">
                                                      <CheckCircle size={12} /> Authorized direct deposit on {new Date(agent.deposit_authorized_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                                                    </span>
                                                  ) : (
                                                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                                      <AlertCircle size={12} /> Direct-deposit authorization not yet given
                                                    </span>
                                                  )}
                                                </p>
                                                {/* Pending banking approval banner */}
                                                {agent.banking_approval_status === 'pending' && agent.banking_submitted_transit && (
                                                  <div className="mb-2 rounded-lg p-3" style={{ background: 'var(--status-blue-muted)', border: '1px solid var(--status-blue-border)' }}>
                                                    <div className="flex items-center justify-between mb-2">
                                                      <div className="flex items-center gap-1.5">
                                                        <AlertCircle size={13} style={{ color: 'var(--status-blue)' }} />
                                                        <span className="text-xs font-semibold" style={{ color: 'var(--status-blue)' }}>Pending Approval</span>
                                                        <span className="text-[10px] text-muted-foreground">
                                                          Submitted {agent.banking_submitted_at ? new Date(agent.banking_submitted_at).toLocaleDateString('en-CA') : ''}
                                                        </span>
                                                      </div>
                                                    </div>
                                                    <div className="flex items-center gap-4 mb-2">
                                                      <span className="text-xs font-mono text-muted-foreground">
                                                        Transit: {agent.banking_submitted_transit} - Inst: {agent.banking_submitted_institution} - Acct: {agent.banking_submitted_account}
                                                      </span>
                                                    </div>
                                                    {bankingRejectingId === agent.id ? (
                                                      <div className="flex items-center gap-2 flex-wrap">
                                                        <input
                                                          type="text"
                                                          value={bankingRejectReason}
                                                          onChange={(e) => setBankingRejectReason(e.target.value)}
                                                          placeholder="Reason for rejection..."
                                                          className="flex-1 min-w-[200px] rounded px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                                                        />
                                                        <button
                                                          disabled={!bankingRejectReason.trim() || bankingApprovingId === agent.id}
                                                          onClick={async () => {
                                                            setBankingApprovingId(agent.id)
                                                            const res = await rejectAgentBanking({ agentId: agent.id, reason: bankingRejectReason })
                                                            if (res.success) {
                                                              setBrokerages(prev => prev.map(b => ({
                                                                ...b,
                                                                agents: b.agents.map((a: Agent) => a.id === agent.id ? { ...a, banking_approval_status: 'rejected' as const, banking_rejection_reason: bankingRejectReason } : a),
                                                              })))
                                                              setBankingRejectingId(null)
                                                              setBankingRejectReason('')
                                                            }
                                                            setBankingApprovingId(null)
                                                          }}
                                                          className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40 hover:opacity-90"
                                                          style={{ background: 'var(--action-red)' }}
                                                        >
                                                          Confirm Reject
                                                        </button>
                                                        <button onClick={() => { setBankingRejectingId(null); setBankingRejectReason('') }} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                                                      </div>
                                                    ) : (
                                                      <div className="flex items-center gap-2">
                                                        <button
                                                          disabled={bankingApprovingId === agent.id}
                                                          onClick={async () => {
                                                            setBankingApprovingId(agent.id)
                                                            const res = await approveAgentBanking({ agentId: agent.id })
                                                            if (res.success) {
                                                              setBrokerages(prev => prev.map(b => ({
                                                                ...b,
                                                                agents: b.agents.map((a: Agent) => a.id === agent.id ? {
                                                                  ...a,
                                                                  bank_transit_number: a.banking_submitted_transit,
                                                                  bank_institution_number: a.banking_submitted_institution,
                                                                  bank_account_number: a.banking_submitted_account,
                                                                  banking_verified: true,
                                                                  banking_approval_status: 'approved' as const,
                                                                } : a),
                                                              })))
                                                            }
                                                            setBankingApprovingId(null)
                                                          }}
                                                          className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40 hover:opacity-90"
                                                          style={{ background: 'var(--action-green)' }}
                                                        >
                                                          {bankingApprovingId === agent.id ? 'Approving...' : 'Approve'}
                                                        </button>
                                                        <button
                                                          onClick={() => setBankingRejectingId(agent.id)}
                                                          className="px-3 py-1.5 rounded text-xs font-semibold transition-colors"
                                                          style={{ background: 'var(--status-red-muted)', color: 'var(--status-red)', border: '1px solid var(--status-red-border)' }}
                                                        >
                                                          Reject
                                                        </button>
                                                      </div>
                                                    )}
                                                  </div>
                                                )}
                                                {agent.banking_verified && agent.bank_transit_number ? (
                                                  <div className="flex items-center gap-4">
                                                    <div className="flex items-center gap-1.5">
                                                      <CheckCircle size={13} className="text-primary" />
                                                      <span className="text-xs font-medium text-primary">Verified</span>
                                                    </div>
                                                    <span className="text-xs font-mono text-muted-foreground">
                                                      Transit: {agent.bank_transit_number} - Inst: {agent.bank_institution_number} - Acct: {'*'.repeat(Math.max(0, (agent.bank_account_number?.length || 4) - 4))}{agent.bank_account_number?.slice(-4)}
                                                    </span>
                                                    <button
                                                      onClick={() => {
                                                        setBankingEditingAgentId(agent.id)
                                                        setBankingForm({
                                                          transit: agent.bank_transit_number || '',
                                                          institution: agent.bank_institution_number || '',
                                                          account: agent.bank_account_number || '',
                                                        })
                                                        setBankingMessage(null)
                                                      }}
                                                      className="text-xs font-medium transition-colors text-muted-foreground hover:text-primary"
                                                    >
                                                      Edit
                                                    </button>
                                                  </div>
                                                ) : bankingEditingAgentId === agent.id ? null : (
                                                  <button
                                                    onClick={() => {
                                                      setBankingEditingAgentId(agent.id)
                                                      setBankingForm({ transit: '', institution: '', account: '' })
                                                      setBankingMessage(null)
                                                    }}
                                                    className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors bg-primary text-primary-foreground hover:bg-primary/90"
                                                  >
                                                    Enter Banking Info
                                                  </button>
                                                )}
                                                {bankingEditingAgentId === agent.id && (
                                                  <div className="mt-3 flex items-end gap-2 flex-wrap">
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1 text-muted-foreground">Transit (5 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={5}
                                                        value={bankingForm.transit}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, transit: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                                                        placeholder="12345"
                                                        className={`w-24 ${inputSmCls}`}
                                                      />
                                                    </div>
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1 text-muted-foreground">Institution (3 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={3}
                                                        value={bankingForm.institution}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, institution: e.target.value.replace(/\D/g, '').slice(0, 3) }))}
                                                        placeholder="001"
                                                        className={`w-16 ${inputSmCls}`}
                                                      />
                                                    </div>
                                                    <div>
                                                      <label className="block text-xs font-semibold mb-1 text-muted-foreground">Account (7-12 digits)</label>
                                                      <input
                                                        type="text"
                                                        maxLength={12}
                                                        value={bankingForm.account}
                                                        onChange={(e) => setBankingForm(f => ({ ...f, account: e.target.value.replace(/\D/g, '').slice(0, 12) }))}
                                                        placeholder="1234567"
                                                        className={`w-36 ${inputSmCls}`}
                                                      />
                                                    </div>
                                                    <button
                                                      disabled={bankingSaving || bankingForm.transit.length !== 5 || bankingForm.institution.length !== 3 || bankingForm.account.length < 7}
                                                      onClick={async () => {
                                                        setBankingSaving(true)
                                                        setBankingMessage(null)
                                                        const res = await updateAgentBanking({
                                                          agentId: agent.id,
                                                          transitNumber: bankingForm.transit,
                                                          institutionNumber: bankingForm.institution,
                                                          accountNumber: bankingForm.account,
                                                        })
                                                        if (res.success) {
                                                          // Update local state
                                                          setBrokerages(prev => prev.map(b => ({
                                                            ...b,
                                                            agents: b.agents.map((a: Agent) => a.id === agent.id ? {
                                                              ...a,
                                                              bank_transit_number: bankingForm.transit,
                                                              bank_institution_number: bankingForm.institution,
                                                              bank_account_number: bankingForm.account,
                                                              banking_verified: true,
                                                            } : a),
                                                          })))
                                                          setBankingEditingAgentId(null)
                                                          setBankingMessage({ type: 'success', text: 'Banking info saved' })
                                                          setTimeout(() => setBankingMessage(null), 3000)
                                                        } else {
                                                          setBankingMessage({ type: 'error', text: res.error || 'Failed to save' })
                                                        }
                                                        setBankingSaving(false)
                                                      }}
                                                      className="px-3 py-1.5 rounded text-xs font-semibold text-white transition-colors disabled:opacity-40 bg-primary hover:bg-primary/90"
                                                    >
                                                      {bankingSaving ? 'Saving...' : 'Save'}
                                                    </button>
                                                    <button
                                                      onClick={() => setBankingEditingAgentId(null)}
                                                      className="px-2 py-1.5 rounded text-xs font-medium transition-colors text-muted-foreground hover:text-foreground"
                                                    >
                                                      Cancel
                                                    </button>
                                                    {bankingMessage && (
                                                      <span className={`text-xs font-medium ${bankingMessage.type === 'success' ? 'text-primary' : 'text-red-400'}`}>
                                                        {bankingMessage.text}
                                                      </span>
                                                    )}
                                                  </div>
                                                )}
                                              </div>

                                              {/* Account Balance & Transactions */}
                                              <div className="mb-5 p-3 rounded-lg bg-muted/20 border border-border">
                                                  <div className="flex items-center justify-between mb-2">
                                                    <h4 className="text-xs font-semibold flex items-center gap-1.5 text-foreground">
                                                      <DollarSign size={13} className="text-status-amber" />
                                                      Account Balance
                                                    </h4>
                                                    <div className="flex items-center gap-2">
                                                      <span className={`text-sm font-bold tabular-nums ${(agent.account_balance || 0) > 0 ? 'text-status-amber' : 'text-status-teal'}`}>
                                                        {formatCurrency(agent.account_balance || 0)}
                                                      </span>
                                                      <button
                                                        type="button"
                                                        onClick={() => openAdjustBalanceModal(agent.id)}
                                                        className="px-2 py-1 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 border border-border/50 transition-colors"
                                                        aria-label={`Adjust balance for ${agent.first_name} ${agent.last_name}`}
                                                      >
                                                        Adjust
                                                      </button>
                                                    </div>
                                                  </div>
                                                  {(agentTransactions[agent.id]?.length ?? 0) > 0 && (
                                                    <div className="space-y-1.5">
                                                      {agentTransactions[agent.id]?.map((tx) => {
                                                        const isDebit = tx.amount > 0
                                                        return (
                                                          <div key={tx.id} className="flex items-center justify-between p-2 rounded bg-card/60 border border-border/30">
                                                            <div className="flex-1 min-w-0">
                                                              <p className="text-xs text-foreground truncate">{tx.description}</p>
                                                              <p className="text-[10px] text-muted-foreground/60 tabular-nums mt-0.5">
                                                                {new Date(tx.created_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                                                                {' - '}{tx.type.replace(/_/g, ' ')}
                                                              </p>
                                                            </div>
                                                            <div className="text-right shrink-0 ml-3">
                                                              <p className={`text-xs font-semibold tabular-nums ${isDebit ? 'text-status-amber' : 'text-status-teal'}`}>
                                                                {isDebit ? '+' : ''}{formatCurrency(tx.amount)}
                                                              </p>
                                                              <p className="text-[10px] text-muted-foreground/60 tabular-nums">
                                                                Bal: {formatCurrency(tx.running_balance)}
                                                              </p>
                                                            </div>
                                                          </div>
                                                        )
                                                      })}
                                                    </div>
                                                  )}
                                                </div>

                                              <h4 className="text-xs font-semibold mb-3 text-foreground">Deal History</h4>
                                              {(agentDeals[agent.id]?.length ?? 0) === 0 ? (
                                                <p className="text-xs text-muted-foreground">No deals yet</p>
                                              ) : (
                                                <div className="space-y-2">
                                                  {agentDeals[agent.id]?.map((deal) => {
                                                    const dealBadgeClass = getSharedStatusBadgeClass(deal.status)
                                                    return (
                                                      <div key={deal.id} className="flex items-center justify-between p-2 rounded bg-muted/20 border border-border">
                                                        <div className="flex-1">
                                                          <p className="text-xs font-medium text-foreground">{deal.property_address}</p>
                                                          <div className="flex items-center gap-3 mt-1">
                                                            <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded ${dealBadgeClass}`}
                                                            >
                                                              {formatStatusLabel(deal.status)}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground">
                                                              Advance: ${deal.advance_amount.toLocaleString('en-CA', { maximumFractionDigits: 0 })}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground">
                                                              Closing: {formatDate(deal.closing_date)}
                                                            </span>
                                                          </div>
                                                        </div>
                                                      </div>
                                                    )
                                                  })}
                                                </div>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      ),
                                    ].filter(Boolean)
                                  })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </BrokerageRowSection>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </main>
      </div>{/* end of content area that shrinks */}

      {/* KYC Document Side Panel - sits beside main content, not on top */}
      {kycPreviewPanel && (
        <div
          className="fixed top-0 right-0 z-30 h-full flex flex-col shadow-xl bg-card border-l-2 border-l-primary"
          style={{
            width: kycPanelWidth,
            animation: 'slideInRight 0.2s ease-out',
          }}
        >
          {/* Panel Header */}
          <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0 border-b border-border">
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-sm font-semibold truncate text-foreground">
                <Shield size={13} className="inline mr-1 text-primary" />
                {kycPreviewPanel.agentName}
              </p>
              <p className="text-xs text-muted-foreground">ID Verification</p>
              {kycPreviewPanel.agentPhone && (
                <p className="text-xs text-muted-foreground truncate"><Phone size={10} className="inline mr-1" />{kycPreviewPanel.agentPhone}</p>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => { for (const u of kycPreviewPanel.originalUrls) window.open(u, '_blank') }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition bg-input text-primary border border-border hover:bg-muted"
                title="Open in new tab"
              >
                <ExternalLink size={11} />
              </button>
              <button
                onClick={closeKycPanel}
                className="p-1 rounded transition text-muted-foreground hover:bg-red-950/50 hover:text-red-400"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          {/* Agent Address - for cross-referencing with ID */}
          {kycPreviewPanel.agentAddress && (
            <div className="px-3 py-2 border-b border-border bg-primary/5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-primary mb-0.5">Address on File</p>
              <p className="text-xs text-foreground leading-relaxed">{kycPreviewPanel.agentAddress}</p>
            </div>
          )}
          {!kycPreviewPanel.agentAddress && (
            <div className="px-3 py-2 border-b border-border bg-status-amber-muted/30">
              <p className="text-[10px] font-bold uppercase tracking-wider text-status-amber mb-0.5">No Address on File</p>
              <p className="text-[11px] text-muted-foreground">Agent hasn&apos;t submitted their address yet</p>
            </div>
          )}
          {/* Panel Content - shows all uploaded ID images */}
          <div className="flex-1 overflow-auto p-3">
            {kycPreviewPanel.blobUrls.map((blobUrl, i) => {
              const ext = kycPreviewPanel.originalUrls[i]?.split('?')[0].split('.').pop()?.toLowerCase() || ''
              const isPdf = ext === 'pdf'
              return (
                <div key={i} style={{ marginBottom: i < kycPreviewPanel.blobUrls.length - 1 ? 12 : 0 }}>
                  {kycPreviewPanel.blobUrls.length > 1 && (
                    <p className="text-xs font-semibold mb-1.5 text-muted-foreground">
                      {i === 0 ? 'Front' : i === 1 ? 'Back' : `Photo ${i + 1}`}
                    </p>
                  )}
                  <KycMediaPreview
                    src={blobUrl}
                    alt={`${kycPreviewPanel.fileName} ${i + 1}`}
                    isPdf={isPdf}
                  />
                </div>
              )
            })}
          </div>
          {/* Verification checklist */}
          <div className="px-3 py-2.5 flex-shrink-0 border-t border-border bg-muted/30 space-y-1.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Verification Checklist</p>
            {([
              { key: 'nameMatch' as const, label: 'Name matches agent profile' },
              { key: 'addressMatch' as const, label: 'Address matches records' },
              { key: 'idValid' as const, label: 'ID is valid and not expired' },
            ]).map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={kycChecks[key]}
                  onChange={(e) => setKycChecks(prev => ({ ...prev, [key]: e.target.checked }))}
                  className="w-4 h-4 rounded border-border accent-[var(--action-green)]"
                />
                <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">{label}</span>
              </label>
            ))}
          </div>
          {/* Panel Footer - Approve/Reject actions */}
          <div className="flex items-center gap-2 px-3 py-2.5 flex-shrink-0 border-t border-border bg-background">
            <button
              onClick={async () => {
                setKycSubmitting(true)
                const result = await verifyAgentKyc({ agentId: kycPreviewPanel.agentId })
                if (result.success) {
                  setStatusMessage({ type: 'success', text: `${kycPreviewPanel.agentName} KYC verified` })
                  closeKycPanel()
                  await loadBrokerages()
                } else {
                  setStatusMessage({ type: 'error', text: result.error || 'Verification failed' })
                }
                setKycSubmitting(false)
              }}
              disabled={kycSubmitting || !kycChecks.nameMatch || !kycChecks.addressMatch || !kycChecks.idValid}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all disabled:opacity-50 text-white hover:opacity-90"
              style={{ background: 'var(--action-green)', border: '1px solid var(--action-green-border)' }}
            >
              <CheckCircle size={16} />
              Approve ID
            </button>
            <button
              onClick={() => {
                setKycRejectingAgentId(kycPreviewPanel.agentId)
                setKycRejectReason('')
                closeKycPanel()
              }}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all text-white hover:opacity-90"
              style={{ background: 'var(--action-red)', border: '1px solid var(--action-red-border)' }}
            >
              <XCircle size={16} />
              Reject ID
            </button>
          </div>
        </div>
      )}
      {/* Pre-auth form inline viewer */}
      <Dialog
        open={!!preauthViewUrl}
        onOpenChange={(open) => {
          if (!open) {
            if (preauthViewUrl) URL.revokeObjectURL(preauthViewUrl)
            setPreauthViewUrl(null)
          }
        }}
      >
        <DialogContent className="max-w-3xl h-[80vh] p-0 gap-0">
          <DialogHeader className="px-4 py-3 border-b border-border/50">
            <DialogTitle>Void Cheque / Direct Deposit Authorization</DialogTitle>
          </DialogHeader>
          {preauthViewUrl && (
            preauthViewType === 'image' ? (
              <div className="w-full overflow-auto p-4" style={{ height: 'calc(80vh - 60px)' }}>
                {/* Supabase signed URL — next/image domain config would
                    require knowing the project ref at build time. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preauthViewUrl} alt="Void Cheque / Direct Deposit Authorization" className="w-full rounded-lg" />
              </div>
            ) : (
              <iframe src={preauthViewUrl} className="w-full" style={{ height: 'calc(80vh - 60px)' }} />
            )
          )}
        </DialogContent>
      </Dialog>
      {/* Balance Adjustment Modal */}
      <Dialog
        open={!!adjustBalanceForAgentId}
        onOpenChange={(open) => {
          if (!open && !adjustSubmitting) closeAdjustBalanceModal()
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DollarSign size={14} className="text-status-amber" />
              Adjust Agent Balance
            </DialogTitle>
            <DialogDescription>
              Post a credit or charge to this agent&apos;s ledger. The reason is audit-logged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Direction</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAdjustDirection('credit')}
                  aria-pressed={adjustDirection === 'credit'}
                  className={`px-3 py-2 rounded text-xs font-medium border transition-colors ${
                    adjustDirection === 'credit'
                      ? 'bg-status-teal/20 border-status-teal text-status-teal'
                      : 'bg-muted/20 border-border/50 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Credit (reduce balance)
                </button>
                <button
                  type="button"
                  onClick={() => setAdjustDirection('charge')}
                  aria-pressed={adjustDirection === 'charge'}
                  className={`px-3 py-2 rounded text-xs font-medium border transition-colors ${
                    adjustDirection === 'charge'
                      ? 'bg-status-amber/20 border-status-amber text-status-amber'
                      : 'bg-muted/20 border-border/50 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Charge (increase balance)
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="adjust-amount" className="block text-xs font-medium text-muted-foreground mb-1.5">Amount (CAD)</label>
              <Input
                id="adjust-amount"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                placeholder="0.00"
                disabled={adjustSubmitting}
              />
            </div>
            <div>
              <label htmlFor="adjust-description" className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
              <textarea
                id="adjust-description"
                value={adjustDescription}
                onChange={(e) => setAdjustDescription(e.target.value)}
                placeholder="Reason for this adjustment (required, audit-logged)"
                disabled={adjustSubmitting}
                rows={3}
                className="w-full px-3 py-2 text-xs bg-muted/30 border border-border/50 rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-status-amber"
              />
            </div>
            {adjustError && (
              <div className="px-3 py-2 rounded text-xs bg-destructive/15 border border-destructive/30 text-destructive">
                {adjustError}
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={closeAdjustBalanceModal}
              disabled={adjustSubmitting}
              className="px-3 py-1.5 rounded text-xs font-medium text-muted-foreground bg-muted/40 hover:bg-muted/60 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitBalanceAdjustment}
              disabled={adjustSubmitting || !adjustAmount || !adjustDescription.trim()}
              className="px-3 py-1.5 rounded text-xs font-semibold text-white bg-status-amber hover:bg-status-amber/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {adjustSubmitting ? 'Posting...' : `Post ${adjustDirection === 'credit' ? 'Credit' : 'Charge'}`}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ============================================================
           Brokerage Logo Generator dialog
           Renders the Variant B layout (F-mark crown + wordmark + tagline)
           from lib/brokerage-logo-generator.ts. Live preview on dark + light
           backgrounds. On apply, uploads the SVG and updates form state with
           logoUrl + logoIncludesTagline=true (so templates skip the duplicate
           FF wordmark — see lib/email.ts brandHeader + components/AgentHeader).
         ============================================================ */}
      <Dialog open={!!logoGenOpen} onOpenChange={(open) => { if (!open) setLogoGenOpen(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wand2 size={18} className="text-primary" />
              Generate Brokerage Logo
            </DialogTitle>
            <DialogDescription>
              Creates a wordmark logo in the Firm Funds style with &ldquo;Powered by Firm Funds&rdquo; baked in. Used in the agent portal header and white-label emails.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2 text-muted-foreground">Brokerage Name</label>
              <Input
                value={logoGenName}
                onChange={(e) => setLogoGenName(e.target.value)}
                placeholder="e.g. Choice Advances"
                maxLength={60}
                disabled={logoGenBusy}
                autoFocus
              />
              <p className="text-[10px] mt-1 text-muted-foreground/60">
                Long names wrap to two lines automatically. {logoGenName.trim().length} characters.
              </p>
            </div>

            {/* Live preview */}
            <div>
              <label className="block text-sm font-medium mb-2 text-muted-foreground">Preview</label>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg overflow-hidden border border-border">
                  <div className="px-3 py-1.5 bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">On dark (portal &amp; emails)</div>
                  <div className="bg-background p-6 flex items-center justify-center min-h-[180px]">
                    {logoGenPreviewDark ? (
                      // The generated SVG has explicit width/height attrs (480 × ~265)
                      // intentionally — those are the intrinsic dimensions for downloads
                      // and email sizing. But the preview box is narrower, so force the
                      // SVG to scale down via Tailwind arbitrary descendant selectors.
                      <div className="w-full [&_svg]:w-full [&_svg]:h-auto [&_svg]:max-w-[360px]" dangerouslySetInnerHTML={{ __html: logoGenPreviewDark }} />
                    ) : (
                      <span className="text-xs text-muted-foreground">Enter a name to preview</span>
                    )}
                  </div>
                </div>
                <div className="rounded-lg overflow-hidden border border-border">
                  <div className="px-3 py-1.5 bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">On white (downloads &amp; print)</div>
                  <div className="bg-white p-6 flex items-center justify-center min-h-[180px]">
                    {logoGenPreviewLight ? (
                      <div className="w-full [&_svg]:w-full [&_svg]:h-auto [&_svg]:max-w-[360px]" dangerouslySetInnerHTML={{ __html: logoGenPreviewLight }} />
                    ) : (
                      <span className="text-xs text-muted-foreground">Enter a name to preview</span>
                    )}
                  </div>
                </div>
              </div>
              <p className="text-[10px] mt-2 text-muted-foreground/60">
                Only the dark version is saved (the SVG is transparent and uses light-grey + green that work on the dark portal and email backgrounds).
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => setLogoGenOpen(null)}
              disabled={logoGenBusy}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-muted text-foreground hover:bg-muted/80 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApplyGeneratedLogo}
              disabled={logoGenBusy || !logoGenName.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold text-white bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Sparkles size={12} />
              {logoGenBusy ? 'Saving...' : 'Use This Logo'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}
