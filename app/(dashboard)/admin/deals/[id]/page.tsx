'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft, CheckCircle2, Circle, FileText, DollarSign, MapPin,
  User, Building2, AlertTriangle, XCircle, Shield, ChevronDown,
  ChevronUp, Banknote, RefreshCw, Trash2, Download, Paperclip
} from 'lucide-react'
import {
  updateDealStatus,
  toggleChecklistItem as serverToggleChecklistItem,
  deleteDocument as serverDeleteDocument,
  getDocumentSignedUrl,
} from '@/lib/actions/deal-actions'
import { recordEftTransfer, confirmEftTransfer, removeEftTransfer } from '@/lib/actions/admin-actions'
import { getStatusBadgeStyle } from '@/lib/constants'
import { useTheme } from '@/lib/theme'
import ThemeToggle from '@/components/ThemeToggle'

interface Deal {
  id: string; agent_id: string; brokerage_id: string; status: string
  property_address: string; closing_date: string; gross_commission: number
  brokerage_split_pct: number; net_commission: number; days_until_closing: number
  discount_fee: number; advance_amount: number; brokerage_referral_fee: number
  amount_due_from_brokerage: number; funding_date: string | null
  repayment_date: string | null; eft_transfers: { amount: number; date: string; confirmed: boolean }[] | null
  source: string; denial_reason: string | null
  notes: string | null; created_at: string; updated_at: string
}

interface ChecklistItem {
  id: string; deal_id: string; checklist_item: string; is_checked: boolean
  checked_by: string | null; checked_at: string | null; notes: string | null
}

interface DealDocument {
  id: string; deal_id: string; uploaded_by: string; document_type: string
  file_name: string; file_path: string; file_size: number
  upload_source: string; notes: string | null; created_at: string
}

const DOCUMENT_TYPES = [
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
]

interface Agent {
  id: string; first_name: string; last_name: string; email: string
  phone: string | null; reco_number: string | null; status: string
  flagged_by_brokerage: boolean; outstanding_recovery: number | null
}

interface Brokerage {
  id: string; name: string; brand: string | null; address: string | null
  phone: string | null; email: string | null; status: string
  referral_fee_percentage: number | null; transaction_system: string | null
}

const STATUS_FLOW: Record<string, string[]> = {
  submitted: ['under_review', 'denied'], under_review: ['approved', 'denied'],
  approved: ['funded', 'denied'], funded: ['repaid'], repaid: ['closed'],
}

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted', under_review: 'Under Review', approved: 'Approved',
  funded: 'Funded', repaid: 'Repaid', closed: 'Closed', denied: 'Denied', cancelled: 'Cancelled',
}

// Using SHARED_STATUS_BADGE_STYLES from @/lib/constants

// Categorize checklist items into logical groups for the redesigned UI
interface ChecklistCategory {
  label: string
  icon: any
  color: string
  bg: string
  border: string
  items: ChecklistItem[]
  matchingDocs: Map<string, DealDocument[]>
}

const CATEGORY_RULES: { label: string; icon: any; color: string; bg: string; border: string; keywords: string[] }[] = [
  {
    label: 'Agent & Account Verification',
    icon: User,
    color: '#5B3D99',
    bg: '#F5F0FF',
    border: '#D5C5F0',
    keywords: ['agent', 'reco', 'registration', 'license', 'identity', 'id verification', 'kyc', 'fintrac', 'flagged', 'outstanding', 'recovery', 'void cheque', 'banking information'],
  },
  {
    label: 'Deal & Document Review',
    icon: FileText,
    color: '#3D5A99',
    bg: '#F0F4FF',
    border: '#C5D3F0',
    keywords: ['aps', 'agreement of purchase', 'trade record', 'mls', 'listing', 'amendment', 'commission agreement', 'direction to pay', 'notice of fulfillment', 'waiver', 'document', 'uploaded', 'deal is firm', 'property address', 'closing date', 'transaction type'],
  },
  {
    label: 'Financial & Compliance',
    icon: Shield,
    color: '#92700C',
    bg: '#FFF8ED',
    border: '#E8D5A8',
    keywords: ['commission amount', 'reasonable', 'red flag', 'compliance', 'legal', 'anti-money', 'aml', 'fraud', 'risk'],
  },
]

// Match a checklist item's document_type keyword to actual uploaded docs
const DOC_TYPE_KEYWORDS: Record<string, string[]> = {
  aps: ['aps', 'agreement of purchase'],
  trade_record: ['trade record', 'deal sheet'],
  mls_listing: ['mls', 'listing'],
  amendment: ['amendment'],
  commission_agreement: ['commission agreement'],
  direction_to_pay: ['direction to pay'],
  notice_of_fulfillment: ['notice of fulfillment', 'waiver'],
  kyc_fintrac: ['kyc', 'fintrac'],
  id_verification: ['id verification', 'identity'],
}

function categorizeChecklist(items: ChecklistItem[], docs: DealDocument[]): ChecklistCategory[] {
  const categories: ChecklistCategory[] = CATEGORY_RULES.map(rule => ({
    ...rule,
    items: [],
    matchingDocs: new Map(),
  }))
  const uncategorized: ChecklistItem[] = []

  for (const item of items) {
    const itemLower = item.checklist_item.toLowerCase()
    let matched = false
    for (const cat of categories) {
      const rule = CATEGORY_RULES.find(r => r.label === cat.label)!
      if (rule.keywords.some(kw => itemLower.includes(kw))) {
        cat.items.push(item)
        // Find matching docs for this checklist item
        for (const [docType, keywords] of Object.entries(DOC_TYPE_KEYWORDS)) {
          if (keywords.some(kw => itemLower.includes(kw))) {
            const matchingDocs = docs.filter(d => d.document_type === docType)
            if (matchingDocs.length > 0) {
              cat.matchingDocs.set(item.id, matchingDocs)
            }
          }
        }
        matched = true
        break
      }
    }
    if (!matched) uncategorized.push(item)
  }

  // Put uncategorized items into the first category that has items, or the last one
  if (uncategorized.length > 0) {
    const target = categories.find(c => c.items.length > 0) || categories[categories.length - 1]
    target.items.push(...uncategorized)
  }

  return categories.filter(c => c.items.length > 0)
}

const ACTION_CONFIG: Record<string, { label: string; icon: any; bg: string; hoverBg: string }> = {
  under_review: { label: 'Start Review', icon: RefreshCw, bg: '#3D5A99', hoverBg: '#2D4A89' },
  approved:     { label: 'Approve Deal', icon: CheckCircle2, bg: '#1A7A2E', hoverBg: '#156A24' },
  funded:       { label: 'Mark as Funded', icon: Banknote, bg: '#5B3D99', hoverBg: '#4B2D89' },
  repaid:       { label: 'Mark as Repaid', icon: DollarSign, bg: '#0D7A5F', hoverBg: '#0A6A4F' },
  closed:       { label: 'Close Deal', icon: CheckCircle2, bg: '#5A5A5A', hoverBg: '#4A4A4A' },
  denied:       { label: 'Deny Deal', icon: XCircle, bg: '#993D3D', hoverBg: '#892D2D' },
}

export default function DealDetailPage() {
  const [deal, setDeal] = useState<Deal | null>(null)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [brokerage, setBrokerage] = useState<Brokerage | null>(null)
  const [checklist, setChecklist] = useState<ChecklistItem[]>([])
  const [documents, setDocuments] = useState<DealDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [denialReason, setDenialReason] = useState('')
  const [showDenialInput, setShowDenialInput] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [checklistExpanded, setChecklistExpanded] = useState(true)
  const [docsExpanded, setDocsExpanded] = useState(true)
  const [showEftForm, setShowEftForm] = useState(false)
  const [eftAmount, setEftAmount] = useState('')
  const [eftDate, setEftDate] = useState(new Date().toISOString().split('T')[0])
  const [eftSaving, setEftSaving] = useState(false)
  const router = useRouter()
  const params = useParams()
  const dealId = params.id as string
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  useEffect(() => { loadDealData() }, [dealId])

  async function loadDealData() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }
    const { data: profile } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
    if (!profile || (profile.role !== 'super_admin' && profile.role !== 'firm_funds_admin')) { router.push('/login'); return }
    const { data: dealData, error: dealError } = await supabase.from('deals').select('*').eq('id', dealId).single()
    if (dealError || !dealData) { router.push('/admin'); return }
    setDeal(dealData)
    const { data: agentData } = await supabase.from('agents').select('*').eq('id', dealData.agent_id).single()
    setAgent(agentData)
    const { data: brokerageData } = await supabase.from('brokerages').select('*').eq('id', dealData.brokerage_id).single()
    setBrokerage(brokerageData)
    const { data: checklistData } = await supabase.from('underwriting_checklist').select('*').eq('deal_id', dealId).order('id', { ascending: true })
    setChecklist(checklistData || [])
    const { data: docsData } = await supabase.from('deal_documents').select('*').eq('deal_id', dealId).order('created_at', { ascending: false })
    setDocuments(docsData || [])
    setLoading(false)
  }

  const handleChecklistToggle = async (item: ChecklistItem) => {
    const newChecked = !item.is_checked
    const result = await serverToggleChecklistItem({ itemId: item.id, isChecked: newChecked })
    if (result.success) {
      const { data: { user } } = await supabase.auth.getUser()
      setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, is_checked: newChecked, checked_by: newChecked ? user?.id || null : null, checked_at: newChecked ? new Date().toISOString() : null } : c))
    }
  }

  const handleStatusChange = async (newStatus: string) => {
    if (!deal) return
    if (newStatus === 'denied' && !denialReason.trim()) { setShowDenialInput(true); return }
    setUpdating(true); setStatusMessage(null)
    const result = await updateDealStatus({
      dealId: deal.id, newStatus,
      denialReason: newStatus === 'denied' ? denialReason.trim() : undefined,
    })
    if (!result.success) {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update deal status' })
    } else {
      setStatusMessage({ type: 'success', text: `Deal status updated to ${STATUS_LABELS[newStatus]}` })
      setDeal(prev => prev ? { ...prev, ...result.data } : null)
      setShowDenialInput(false); setDenialReason('')
    }
    setUpdating(false)
  }

  const handleDocumentDownload = async (doc: DealDocument) => {
    const result = await getDocumentSignedUrl({ documentId: doc.id, filePath: doc.file_path, dealId: dealId })
    if (!result.success || !result.data?.signedUrl) {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to generate download link' }); return
    }
    window.open(result.data.signedUrl, '_blank')
  }

  const handleDocumentDelete = async (doc: DealDocument) => {
    if (!confirm(`Delete "${doc.file_name}"? This cannot be undone.`)) return
    const result = await serverDeleteDocument({ documentId: doc.id, filePath: doc.file_path })
    if (!result.success) {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to delete document' }); return
    }
    setDocuments(prev => prev.filter(d => d.id !== doc.id))
    setStatusMessage({ type: 'success', text: 'Document deleted' })
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  const getDocTypeLabel = (type: string) => DOCUMENT_TYPES.find(d => d.value === type)?.label || type
  const formatCurrency = (amount: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  const formatDate = (date: string) => new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  const formatDateTime = (date: string) => new Date(date).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  // statusBadge now uses shared getStatusBadgeStyle from constants
  const statusBadge = getStatusBadgeStyle

  const checkedCount = checklist.filter(c => c.is_checked).length
  const totalChecklist = checklist.length
  const checklistPct = totalChecklist > 0 ? Math.round((checkedCount / totalChecklist) * 100) : 0

  if (loading) return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
          <div className="h-5 w-48 rounded animate-pulse mb-2" style={{ background: 'rgba(255,255,255,0.1)' }} />
          <div className="h-3 w-32 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.05)' }} />
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {[1,2,3].map(i => (
              <div key={i} className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="h-4 w-32 rounded animate-pulse mb-4" style={{ background: colors.skeletonBase }} />
                {[1,2,3].map(j => (<div key={j} className="h-3 w-full rounded animate-pulse mb-3" style={{ background: colors.skeletonHighlight }} />))}
              </div>
            ))}
          </div>
          <div className="space-y-6">
            {[1,2].map(i => (
              <div key={i} className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="h-3 w-16 rounded animate-pulse mb-4" style={{ background: colors.skeletonBase }} />
                {[1,2,3].map(j => (<div key={j} className="h-3 w-full rounded animate-pulse mb-3" style={{ background: colors.skeletonHighlight }} />))}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  )
  if (!deal) return (<div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}><div style={{ color: colors.textMuted }} className="text-lg">Deal not found</div></div>)

  const availableActions = STATUS_FLOW[deal.status] || []

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/admin')}
                className="transition-colors"
                style={{ color: '#888' }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#C4B098'}
                onMouseLeave={(e) => e.currentTarget.style.color = '#888'}
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                {/* Breadcrumb */}
                <div className="flex items-center gap-1.5 text-xs mb-0.5">
                  <button onClick={() => router.push('/admin')} className="transition-colors" style={{ color: '#888' }} onMouseEnter={(e) => e.currentTarget.style.color = '#C4B098'} onMouseLeave={(e) => e.currentTarget.style.color = '#888'}>Dashboard</button>
                  <span style={{ color: '#555' }}>/</span>
                  <span style={{ color: '#C4B098' }}>Deal Detail</span>
                </div>
                <h1 className="text-lg font-bold text-white">{deal.property_address}</h1>
                <p className="text-xs" style={{ color: colors.textMuted }}>Submitted {formatDateTime(deal.created_at)}</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <ThemeToggle />
              <span
                className="inline-flex px-3 py-1.5 text-sm font-semibold rounded-lg"
                style={statusBadge(deal.status)}
              >
                {STATUS_LABELS[deal.status]}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Status Message */}
        {statusMessage && (
          <div
            className="mb-6 p-4 rounded-xl text-sm font-medium"
            style={statusMessage.type === 'success'
              ? { background: colors.successBg, border: `1px solid ${colors.successBorder}`, color: colors.successText }
              : { background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }
            }
          >
            {statusMessage.text}
          </div>
        )}

        {/* Deal Pipeline */}
        <div className="rounded-xl mb-6 p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          <h3 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: colors.gold }}>Deal Pipeline</h3>
          <div className="flex items-center gap-1.5">
            {['under_review', 'approved', 'funded', 'repaid', 'closed'].map((status, index) => {
              const isActive = status === deal.status
              const isPast = ['under_review', 'approved', 'funded', 'repaid', 'closed'].indexOf(deal.status) > index
              const isDenied = deal.status === 'denied'
              const barColor = isDenied ? '#F0C5C5' : isActive ? '#C4B098' : isPast ? '#1A7A2E' : '#E8E4DF'
              const labelColor = isDenied ? '#993D3D' : isActive ? '#C4B098' : isPast ? '#1A7A2E' : '#D0D0D0'
              return (
                <div key={status} className="flex-1">
                  <div className="h-2 rounded-full" style={{ background: barColor }} />
                  <p className={`text-xs mt-1.5 text-center ${isActive ? 'font-bold' : isPast ? 'font-medium' : ''}`} style={{ color: labelColor }}>
                    {STATUS_LABELS[status]}
                  </p>
                </div>
              )
            })}
          </div>
          {deal.status === 'denied' && (
            <div className="mt-4 p-3 rounded-lg" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}` }}>
              <p className="text-sm" style={{ color: colors.errorText }}><strong>Denied:</strong> {deal.denial_reason || 'No reason provided'}</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-6">

            {/* Deal Details */}
            <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
              <div className="px-6 py-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <MapPin size={16} style={{ color: colors.gold }} />
                <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Deal Details</h3>
              </div>
              <div className="p-6">
                <div className="grid grid-cols-2 gap-5 text-sm">
                  <div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textSecondary }}>Property Address</p><p className="font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</p></div>
                  <div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textSecondary }}>Closing Date</p><p className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.closing_date)}</p></div>
                  <div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textSecondary }}>Days Until Closing</p><p className="font-medium" style={{ color: colors.textPrimary }}>{deal.days_until_closing} days</p></div>
                  <div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textSecondary }}>Source</p><p className="font-medium" style={{ color: colors.textPrimary }}>{deal.source === 'manual_portal' ? 'Agent Portal' : deal.source === 'nexone_auto' ? 'Nexone Auto' : deal.source}</p></div>
                  {deal.funding_date && (<div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textSecondary }}>Funding Date</p><p className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.funding_date)}</p></div>)}
                  {deal.repayment_date && (<div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textSecondary }}>Repayment Date</p><p className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.repayment_date)}</p></div>)}
                </div>
                {deal.notes && (
                  <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${colors.divider}` }}>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textSecondary }}>Notes</p>
                    <p className="text-sm whitespace-pre-line" style={{ color: colors.textPrimary }}>{deal.notes.replace(/^Transaction type: \w+\n?/, '').trim() || 'No additional notes'}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Financial Breakdown */}
            <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
              <div className="px-6 py-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <DollarSign size={16} style={{ color: colors.gold }} />
                <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Financial Breakdown</h3>
              </div>
              <div className="p-6">
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between"><span style={{ color: colors.textSecondary }}>Gross Commission</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.gross_commission)}</span></div>
                  <div className="flex justify-between"><span style={{ color: colors.textSecondary }}>Brokerage Split ({deal.brokerage_split_pct}%)</span><span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(deal.gross_commission - deal.net_commission)}</span></div>
                  <div className="flex justify-between pt-2" style={{ borderTop: `1px solid ${colors.divider}` }}><span className="font-medium" style={{ color: colors.textPrimary }}>Agent Net Commission</span><span className="font-semibold" style={{ color: colors.textPrimary }}>{formatCurrency(deal.net_commission)}</span></div>
                  <div className="flex justify-between"><span style={{ color: colors.textSecondary }}>Discount Fee ($0.75/$1K/day × {deal.days_until_closing} days)</span><span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(deal.discount_fee)}</span></div>
                  <div className="flex justify-between items-center rounded-xl px-5 py-4 -mx-1 mt-2" style={{ background: colors.successBg, border: `1px solid ${colors.successBorder}` }}>
                    <span className="font-bold text-base" style={{ color: colors.successText }}>Advance to Agent</span>
                    <span className="font-black text-xl" style={{ color: colors.successText }}>{formatCurrency(deal.advance_amount)}</span>
                  </div>
                </div>

                <div className="mt-6 pt-5" style={{ borderTop: `1px solid ${colors.divider}` }}>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Firm Funds Revenue</h4>
                  <div className="space-y-2.5 text-sm">
                    <div className="flex justify-between"><span style={{ color: colors.textSecondary }}>Total Discount Fee Earned</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.discount_fee)}</span></div>
                    <div className="flex justify-between"><span style={{ color: colors.textSecondary }}>Brokerage Referral Fee ({((brokerage?.referral_fee_percentage || 0.20) * 100).toFixed(0)}%)</span><span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(deal.brokerage_referral_fee)}</span></div>
                    <div className="flex justify-between pt-2" style={{ borderTop: `1px solid ${colors.divider}` }}><span className="font-semibold" style={{ color: colors.textPrimary }}>Net Revenue to Firm Funds</span><span className="font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(deal.discount_fee - deal.brokerage_referral_fee)}</span></div>
                  </div>
                </div>

                <div className="mt-6 pt-5" style={{ borderTop: `1px solid ${colors.divider}` }}>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: colors.gold }}>Settlement at Closing</h4>
                  <div className="space-y-2.5 text-sm">
                    <div className="flex justify-between"><span style={{ color: colors.textSecondary }}>Agent Net Commission (held in trust)</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.net_commission)}</span></div>
                    <div className="flex justify-between"><span style={{ color: colors.textSecondary }}>Less: Brokerage Referral Fee</span><span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(deal.brokerage_referral_fee)}</span></div>
                    <div className="flex justify-between pt-2" style={{ borderTop: `1px solid ${colors.divider}` }}><span className="font-semibold" style={{ color: colors.textPrimary }}>Brokerage EFT to Firm Funds</span><span className="font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(deal.net_commission - deal.brokerage_referral_fee)}</span></div>
                    <p className="text-xs" style={{ color: colors.textFaint }}>Brokerage retains their referral fee and sends the remainder to Firm Funds at closing.</p>
                  </div>
                </div>
              </div>
            </div>

            {/* EFT Transfer Tracking — Only for funded deals */}
            {(deal.status === 'funded' || deal.status === 'repaid') && (
              <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Banknote size={16} style={{ color: colors.gold }} />
                    <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>EFT Transfers</h3>
                  </div>
                  {!showEftForm && (
                    <button
                      onClick={() => setShowEftForm(true)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                      style={{ background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }}
                      onMouseEnter={(e) => e.currentTarget.style.background = isDark ? '#1A3420' : '#D5F0DC'}
                      onMouseLeave={(e) => e.currentTarget.style.background = colors.successBg}
                    >
                      + Record Transfer
                    </button>
                  )}
                </div>
                <div className="p-6">
                  {/* Add transfer form */}
                  {showEftForm && (
                    <div className="rounded-lg p-4 mb-4" style={{ background: colors.tableHeaderBg, border: `1px solid ${colors.border}` }}>
                      <div className="grid grid-cols-2 gap-4 mb-3">
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Amount ($)</label>
                          <input
                            type="number" value={eftAmount} onChange={(e) => setEftAmount(e.target.value)}
                            placeholder="25000" min="0" max="25000" step="0.01"
                            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                            style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                            onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                            onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                          />
                          <p className="text-xs mt-1" style={{ color: colors.textFaint }}>Max $25,000 per transfer</p>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Date</label>
                          <input
                            type="date" value={eftDate} onChange={(e) => setEftDate(e.target.value)}
                            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                            style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }}
                            onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098' }}
                            onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }}
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setShowEftForm(false); setEftAmount(''); setEftDate(new Date().toISOString().split('T')[0]) }}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                          style={{ color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                          onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={async () => {
                            const amt = parseFloat(eftAmount)
                            if (!amt || amt <= 0 || amt > 25000 || !eftDate) return
                            setEftSaving(true)
                            const result = await recordEftTransfer({ dealId: deal.id, amount: amt, date: eftDate })
                            if (result.success && result.data) {
                              setDeal({ ...deal, eft_transfers: result.data.eft_transfers })
                              setShowEftForm(false); setEftAmount(''); setEftDate(new Date().toISOString().split('T')[0])
                              setStatusMessage({ type: 'success', text: `EFT transfer of ${formatCurrency(amt)} recorded.` })
                            } else {
                              setStatusMessage({ type: 'error', text: result.error || 'Failed to record transfer' })
                            }
                            setEftSaving(false)
                          }}
                          disabled={eftSaving || !eftAmount || parseFloat(eftAmount) <= 0}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors disabled:opacity-50"
                          style={{ background: '#1A7A2E' }}
                          onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#156A24' }}
                          onMouseLeave={(e) => e.currentTarget.style.background = '#1A7A2E'}
                        >
                          {eftSaving ? 'Saving...' : 'Save Transfer'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Transfer list */}
                  {(() => {
                    const transfers = deal.eft_transfers || []
                    const totalSent = transfers.reduce((sum, t) => sum + t.amount, 0)
                    const remaining = deal.advance_amount - totalSent

                    return (
                      <>
                        {transfers.length === 0 ? (
                          <p className="text-sm" style={{ color: colors.textMuted }}>No EFT transfers recorded yet.</p>
                        ) : (
                          <div className="space-y-2 mb-4">
                            {transfers.map((transfer, idx) => (
                              <div key={idx} className="flex items-center justify-between px-4 py-3 rounded-lg" style={{ background: colors.tableHeaderBg, border: `1px solid ${colors.border}` }}>
                                <div className="flex items-center gap-3">
                                  <span className={`w-2 h-2 rounded-full`} style={{ background: transfer.confirmed ? colors.successText : colors.warningText }} />
                                  <div>
                                    <span className="text-sm font-semibold" style={{ color: colors.textPrimary }}>{formatCurrency(transfer.amount)}</span>
                                    <span className="text-xs ml-2" style={{ color: colors.textMuted }}>{formatDate(transfer.date)}</span>
                                  </div>
                                  <span className="text-xs px-2 py-0.5 rounded-md" style={transfer.confirmed
                                    ? { background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }
                                    : { background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }
                                  }>
                                    {transfer.confirmed ? 'Confirmed' : 'Pending'}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  {!transfer.confirmed && (
                                    <button
                                      onClick={async () => {
                                        const result = await confirmEftTransfer({ dealId: deal.id, transferIndex: idx })
                                        if (result.success && result.data) setDeal({ ...deal, eft_transfers: result.data.eft_transfers })
                                      }}
                                      className="text-xs px-2 py-1 rounded transition-colors"
                                      style={{ color: colors.successText }}
                                      onMouseEnter={(e) => e.currentTarget.style.background = colors.successBg}
                                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                      Confirm
                                    </button>
                                  )}
                                  <button
                                    onClick={async () => {
                                      if (!confirm('Remove this transfer?')) return
                                      const result = await removeEftTransfer({ dealId: deal.id, transferIndex: idx })
                                      if (result.success && result.data) {
                                        setDeal({ ...deal, eft_transfers: result.data.eft_transfers })
                                        setStatusMessage({ type: 'success', text: 'Transfer removed.' })
                                      }
                                    }}
                                    className="p-1 rounded transition-colors opacity-40 hover:opacity-100"
                                    style={{ color: colors.errorText }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = colors.errorBg}
                                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Summary bar */}
                        <div className="rounded-lg p-4" style={{ background: isDark ? '#101520' : '#F0F4FF', border: `1px solid ${isDark ? '#203050' : '#C5D3F0'}` }}>
                          <div className="flex justify-between text-sm mb-2">
                            <span style={{ color: colors.textSecondary }}>Total Advance</span>
                            <span className="font-semibold" style={{ color: colors.textPrimary }}>{formatCurrency(deal.advance_amount)}</span>
                          </div>
                          <div className="flex justify-between text-sm mb-2">
                            <span style={{ color: colors.textSecondary }}>Total Sent ({transfers.length} transfer{transfers.length !== 1 ? 's' : ''})</span>
                            <span className="font-semibold" style={{ color: colors.successText }}>{formatCurrency(totalSent)}</span>
                          </div>
                          <div className="flex justify-between text-sm pt-2" style={{ borderTop: `1px solid ${colors.divider}` }}>
                            <span className="font-semibold" style={{ color: remaining > 0 ? colors.warningText : colors.successText }}>{remaining > 0 ? 'Remaining' : 'Fully Sent'}</span>
                            <span className="font-bold" style={{ color: remaining > 0 ? colors.warningText : colors.successText }}>{remaining > 0 ? formatCurrency(remaining) : '✓'}</span>
                          </div>
                          {/* Progress bar */}
                          <div className="w-full rounded-full h-1.5 mt-3" style={{ background: colors.skeletonHighlight }}>
                            <div
                              className="h-1.5 rounded-full transition-all duration-300"
                              style={{ width: `${Math.min(100, (totalSent / deal.advance_amount) * 100)}%`, background: totalSent >= deal.advance_amount ? colors.successText : colors.gold }}
                            />
                          </div>
                        </div>
                      </>
                    )
                  })()}
                </div>
              </div>
            )}

            {/* Underwriting Checklist — Grouped */}
            {(() => {
              const groupedChecklist = categorizeChecklist(checklist, documents)
              return (
                <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                  <div
                    className="px-6 py-4 flex items-center justify-between cursor-pointer transition-colors"
                    style={{ borderBottom: checklistExpanded ? `1px solid ${colors.border}` : 'none' }}
                    onClick={() => setChecklistExpanded(!checklistExpanded)}
                    onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <Shield size={16} style={{ color: colors.gold }} />
                        <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Underwriting Checklist</h3>
                      </div>
                      <span
                        className="text-xs font-semibold px-2.5 py-0.5 rounded-md"
                        style={checklistPct === 100
                          ? { background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }
                          : checklistPct > 50
                            ? { background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }
                            : { background: colors.tableHeaderBg, color: colors.textSecondary, border: `1px solid ${colors.divider}` }
                        }
                      >
                        {checkedCount}/{totalChecklist} ({checklistPct}%)
                      </span>
                    </div>
                    {checklistExpanded ? <ChevronUp size={16} style={{ color: colors.textFaint }} /> : <ChevronDown size={16} style={{ color: colors.textFaint }} />}
                  </div>
                  {checklistExpanded && (
                    <div className="p-6">
                      {/* Overall Progress Bar */}
                      <div className="w-full rounded-full h-2 mb-6" style={{ background: colors.skeletonHighlight }}>
                        <div
                          className="h-2 rounded-full transition-all duration-300"
                          style={{
                            width: `${checklistPct}%`,
                            background: checklistPct === 100 ? '#1A7A2E' : checklistPct > 50 ? '#C4B098' : '#3D5A99'
                          }}
                        />
                      </div>

                      <div className="space-y-5">
                        {groupedChecklist.map((category) => {
                          const CatIcon = category.icon
                          const catChecked = category.items.filter(i => i.is_checked).length
                          const catTotal = category.items.length
                          return (
                            <div key={category.label}>
                              {/* Category Header */}
                              <div className="flex items-center gap-2 mb-2.5">
                                <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: category.bg }}>
                                  <CatIcon size={13} style={{ color: category.color }} />
                                </div>
                                <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: category.color }}>{category.label}</h4>
                                <span className="text-xs font-medium" style={{ color: catChecked === catTotal ? colors.successText : colors.textSecondary }}>
                                  {catChecked}/{catTotal}
                                </span>
                              </div>

                              {/* Category Items */}
                              <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${category.border}` }}>
                                {category.items.map((item, idx) => {
                                  const linkedDocs = category.matchingDocs.get(item.id) || []
                                  return (
                                    <div
                                      key={item.id}
                                      style={{ borderBottom: idx < category.items.length - 1 ? `1px solid ${category.border}40` : 'none' }}
                                    >
                                      <div
                                        className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
                                        style={{ background: item.is_checked ? `${category.bg}80` : 'transparent' }}
                                        onClick={() => handleChecklistToggle(item)}
                                        onMouseEnter={(e) => e.currentTarget.style.background = item.is_checked ? `${category.bg}` : colors.cardHoverBg}
                                        onMouseLeave={(e) => e.currentTarget.style.background = item.is_checked ? `${category.bg}80` : 'transparent'}
                                      >
                                        {item.is_checked
                                          ? <CheckCircle2 size={18} style={{ color: colors.successText }} className="flex-shrink-0" />
                                          : <Circle size={18} style={{ color: colors.textFaint }} className="flex-shrink-0" />
                                        }
                                        <div className="flex-1 min-w-0">
                                          <span className="text-sm" style={{ color: item.is_checked ? colors.textSecondary : colors.textPrimary }}>
                                            {item.checklist_item}
                                          </span>
                                          {/* Linked documents */}
                                          {linkedDocs.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                                              {linkedDocs.map(doc => (
                                                <button
                                                  key={doc.id}
                                                  onClick={(e) => { e.stopPropagation(); handleDocumentDownload(doc) }}
                                                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md transition-colors"
                                                  style={{ background: '#F0F4FF', color: '#3D5A99', border: '1px solid #C5D3F0' }}
                                                  onMouseEnter={(e) => { e.currentTarget.style.background = '#E0EAFF' }}
                                                  onMouseLeave={(e) => { e.currentTarget.style.background = '#F0F4FF' }}
                                                >
                                                  <Paperclip size={10} />
                                                  {doc.file_name.length > 25 ? doc.file_name.slice(0, 22) + '...' : doc.file_name}
                                                </button>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                        {item.checked_at && <span className="text-xs flex-shrink-0" style={{ color: colors.textFaint }}>{formatDateTime(item.checked_at)}</span>}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Documents */}
            <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
              <div
                className="px-6 py-4 flex items-center justify-between cursor-pointer transition-colors"
                style={{ borderBottom: docsExpanded ? `1px solid ${colors.border}` : 'none' }}
                onClick={() => setDocsExpanded(!docsExpanded)}
                onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Paperclip size={16} style={{ color: colors.gold }} />
                    <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Documents</h3>
                  </div>
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-md" style={{ background: colors.tableHeaderBg, color: colors.textSecondary, border: `1px solid ${colors.divider}` }}>
                    {documents.length} file{documents.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {docsExpanded ? <ChevronUp size={16} style={{ color: colors.textFaint }} /> : <ChevronDown size={16} style={{ color: colors.textFaint }} />}
              </div>
              {docsExpanded && (
                <div className="p-6">
                  {documents.length === 0 ? (
                    <div className="text-center py-6">
                      <FileText className="mx-auto mb-3" size={32} style={{ color: colors.textFaint }} />
                      <p className="text-sm" style={{ color: colors.textSecondary }}>No documents uploaded yet</p>
                      {agent && deal.status === 'under_review' && (
                        <p className="text-xs mt-2 px-4 py-2 rounded-lg inline-block" style={{ background: colors.warningBg, border: `1px solid ${colors.warningBorder}`, color: colors.warningText }}>
                          Reminder: Reach out to {agent.first_name} ({agent.email}) to upload supporting documents.
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {documents.map((doc) => (
                        <div
                          key={doc.id}
                          className="flex items-center justify-between p-3 rounded-lg transition-colors"
                          style={{ background: colors.tableHeaderBg }}
                          onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                          onMouseLeave={(e) => e.currentTarget.style.background = colors.tableHeaderBg}
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <FileText size={18} style={{ color: colors.gold }} className="flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{doc.file_name}</p>
                              <p className="text-xs" style={{ color: colors.textSecondary }}>{getDocTypeLabel(doc.document_type)} · {formatFileSize(doc.file_size)} · {formatDateTime(doc.created_at)}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                            <button
                              onClick={() => handleDocumentDownload(doc)}
                              className="p-2 rounded-lg transition-colors"
                              style={{ color: colors.textSecondary }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = '#3D5A99'; e.currentTarget.style.background = '#F0F4FF' }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = colors.textSecondary; e.currentTarget.style.background = 'transparent' }}
                              title="Download"
                            >
                              <Download size={16} />
                            </button>
                            <button
                              onClick={() => handleDocumentDelete(doc)}
                              className="p-2 rounded-lg transition-colors"
                              style={{ color: colors.textSecondary }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = colors.errorText; e.currentTarget.style.background = colors.errorBg }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = colors.textSecondary; e.currentTarget.style.background = 'transparent' }}
                              title="Delete"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right Column - Sidebar */}
          <div className="space-y-6">

            {/* Actions */}
            {availableActions.length > 0 && (
              <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Actions</h3>
                </div>
                <div className="p-4 space-y-3">
                  {showDenialInput && (
                    <div className="mb-3">
                      <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textSecondary }}>Reason for denial *</label>
                      <textarea
                        value={denialReason}
                        onChange={(e) => setDenialReason(e.target.value)}
                        placeholder="Explain why this deal is being denied..."
                        rows={3}
                        className="w-full rounded-lg px-3 py-2 text-sm outline-none resize-none"
                        style={{ border: `1px solid ${colors.border}`, color: colors.textPrimary, background: colors.pageBg }}
                        onFocus={(e) => e.currentTarget.style.boxShadow = `0 0 0 2px ${colors.gold}`}
                        onBlur={(e) => e.currentTarget.style.boxShadow = 'none'}
                      />
                    </div>
                  )}
                  {availableActions.map((nextStatus) => {
                    const action = ACTION_CONFIG[nextStatus]
                    if (!action) return null
                    const Icon = action.icon
                    if (nextStatus === 'denied' && showDenialInput) {
                      return (
                        <div key={nextStatus} className="flex gap-2">
                          <button
                            onClick={() => handleStatusChange('denied')}
                            disabled={updating || !denialReason.trim()}
                            className="flex-1 flex items-center justify-center gap-2 text-white py-2.5 px-4 rounded-lg font-medium text-sm disabled:opacity-50 transition-colors"
                            style={{ background: colors.errorText }}
                            onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#892D2D' }}
                            onMouseLeave={(e) => e.currentTarget.style.background = colors.errorText}
                          >
                            <XCircle size={16} />{updating ? 'Updating...' : 'Confirm Denial'}
                          </button>
                          <button
                            onClick={() => { setShowDenialInput(false); setDenialReason('') }}
                            className="px-3 py-2.5 rounded-lg text-sm transition-colors"
                            style={{ border: `1px solid ${colors.border}`, color: colors.textSecondary }}
                            onMouseEnter={(e) => e.currentTarget.style.background = colors.tableHeaderBg}
                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                          >
                            Cancel
                          </button>
                        </div>
                      )
                    }
                    return (
                      <button
                        key={nextStatus}
                        onClick={() => handleStatusChange(nextStatus)}
                        disabled={updating}
                        className="w-full flex items-center justify-center gap-2 text-white py-2.5 px-4 rounded-lg font-medium text-sm disabled:opacity-50 transition-colors"
                        style={{ background: action.bg }}
                        onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = action.hoverBg }}
                        onMouseLeave={(e) => e.currentTarget.style.background = action.bg}
                      >
                        <Icon size={16} />{updating ? 'Updating...' : action.label}
                      </button>
                    )
                  })}
                  {deal.status === 'approved' && (
                    <p className="text-xs text-center mt-2" style={{ color: colors.textFaint }}>Marking as funded will recalculate financials based on today&apos;s date.</p>
                  )}
                </div>
              </div>
            )}

            {/* Agent Card */}
            {agent && (
              <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="px-6 py-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <User size={14} style={{ color: colors.gold }} />
                  <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Agent</h3>
                </div>
                <div className="p-4 space-y-3 text-sm">
                  <div><p className="text-xs" style={{ color: colors.textSecondary }}>Name</p><p className="font-medium" style={{ color: colors.textPrimary }}>{agent.first_name} {agent.last_name}</p></div>
                  <div><p className="text-xs" style={{ color: colors.textSecondary }}>Email</p><p className="font-medium" style={{ color: colors.textPrimary }}>{agent.email}</p></div>
                  {agent.phone && (<div><p className="text-xs" style={{ color: colors.textSecondary }}>Phone</p><p className="font-medium" style={{ color: colors.textPrimary }}>{agent.phone}</p></div>)}
                  {agent.reco_number && (<div><p className="text-xs" style={{ color: colors.textSecondary }}>RECO #</p><p className="font-medium" style={{ color: colors.textPrimary }}>{agent.reco_number}</p></div>)}
                  <div><p className="text-xs" style={{ color: colors.textSecondary }}>Status</p><p className="font-medium" style={{ color: agent.status === 'active' ? colors.successText : colors.errorText }}>{agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}</p></div>
                  {agent.flagged_by_brokerage && (
                    <div className="flex items-start gap-2 p-3 rounded-lg" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}` }}>
                      <AlertTriangle size={16} style={{ color: colors.errorText }} className="mt-0.5 flex-shrink-0" />
                      <p className="text-xs font-medium" style={{ color: colors.errorText }}>This agent has been flagged by their brokerage</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Brokerage Card */}
            {brokerage && (
              <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="px-6 py-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <Building2 size={14} style={{ color: colors.gold }} />
                  <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Brokerage</h3>
                </div>
                <div className="p-4 space-y-3 text-sm">
                  <div><p className="text-xs" style={{ color: colors.textSecondary }}>Name</p><p className="font-medium" style={{ color: colors.textPrimary }}>{brokerage.name}</p></div>
                  {brokerage.brand && (<div><p className="text-xs" style={{ color: colors.textSecondary }}>Brand</p><p className="font-medium" style={{ color: colors.textPrimary }}>{brokerage.brand}</p></div>)}
                  {brokerage.email && (<div><p className="text-xs" style={{ color: colors.textSecondary }}>Email</p><p className="font-medium" style={{ color: colors.textPrimary }}>{brokerage.email}</p></div>)}
                  {brokerage.phone && (<div><p className="text-xs" style={{ color: colors.textSecondary }}>Phone</p><p className="font-medium" style={{ color: colors.textPrimary }}>{brokerage.phone}</p></div>)}
                  {brokerage.referral_fee_percentage && (<div><p className="text-xs" style={{ color: colors.textSecondary }}>Referral Fee</p><p className="font-medium" style={{ color: colors.textPrimary }}>{(brokerage.referral_fee_percentage * 100).toFixed(0)}%</p></div>)}
                  {brokerage.transaction_system && (<div><p className="text-xs" style={{ color: colors.textSecondary }}>Transaction System</p><p className="font-medium" style={{ color: colors.textPrimary }}>{brokerage.transaction_system}</p></div>)}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
