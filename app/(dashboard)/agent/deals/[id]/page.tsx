'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft, FileText, DollarSign, MapPin, Clock,
  Upload, Download, ChevronDown, ChevronUp, Paperclip,
  CheckCircle2, AlertTriangle, Pencil, Save, X
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import SignOutModal from '@/components/SignOutModal'
import {
  MAX_UPLOAD_SIZE_BYTES,
  ALLOWED_UPLOAD_EXTENSIONS,
  DOCUMENT_TYPES as DOC_TYPES,
  getStatusBadgeStyle,
  formatStatusLabel,
} from '@/lib/constants'
import { updateDealDetails, cancelDeal } from '@/lib/actions/deal-actions'
import { AlertCircle } from 'lucide-react'

interface Deal {
  id: string; agent_id: string; brokerage_id: string; status: string
  property_address: string; closing_date: string; gross_commission: number
  brokerage_split_pct: number; net_commission: number; days_until_closing: number
  discount_fee: number; advance_amount: number; brokerage_referral_fee: number
  amount_due_from_brokerage: number; funding_date: string | null
  repayment_date: string | null; source: string; denial_reason: string | null
  notes: string | null; created_at: string; updated_at: string
}

interface DealDocument {
  id: string; deal_id: string; uploaded_by: string; document_type: string
  file_name: string; file_path: string; file_size: number
  upload_source: string; notes: string | null; created_at: string
}

interface DocumentRequest {
  id: string
  deal_id: string
  document_type: string
  message: string | null
  status: 'pending' | 'fulfilled' | 'cancelled'
  created_at: string
}

const DOCUMENT_TYPES = DOC_TYPES

// Status badge styles and labels now imported from @/lib/constants

export default function AgentDealDetailPage() {
  const [deal, setDeal] = useState<Deal | null>(null)
  const [documents, setDocuments] = useState<DealDocument[]>([])
  const [docRequests, setDocRequests] = useState<DocumentRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadDocType, setUploadDocType] = useState('aps')
  const [docsExpanded, setDocsExpanded] = useState(true)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editStreetAddress, setEditStreetAddress] = useState('')
  const [editCity, setEditCity] = useState('')
  const [editProvince, setEditProvince] = useState('Ontario')
  const [editPostalCode, setEditPostalCode] = useState('')
  const [editClosingDate, setEditClosingDate] = useState('')
  const [editGrossCommission, setEditGrossCommission] = useState('')
  const [editBrokerageSplitPct, setEditBrokerageSplitPct] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const router = useRouter()
  const params = useParams()
  const dealId = params.id as string
  const supabase = createClient()
  const { colors, isDark } = useTheme()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  useEffect(() => { loadDealData() }, [dealId])

  async function loadDealData() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }
    const { data: profile } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
    if (!profile || profile.role !== 'agent') { router.push('/login'); return }
    const { data: dealData, error: dealError } = await supabase.from('deals').select('*').eq('id', dealId).single()
    if (dealError || !dealData) { router.push('/agent'); return }
    if (dealData.agent_id !== profile.agent_id) { router.push('/agent'); return }
    setDeal(dealData)
    const { data: docsData } = await supabase.from('deal_documents').select('*').eq('deal_id', dealId).order('created_at', { ascending: false })
    setDocuments(docsData || [])
    const { data: requestsData } = await supabase.from('document_requests').select('*').eq('deal_id', dealId).eq('status', 'pending').order('created_at', { ascending: false })
    setDocRequests(requestsData || [])
    setLoading(false)
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0 || !deal) return
    setUploading(true); setStatusMessage(null)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setStatusMessage({ type: 'error', text: 'You must be logged in to upload.' }); setUploading(false); return }

    let successCount = 0
    const failures: string[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file.size > MAX_UPLOAD_SIZE_BYTES) { failures.push(`${file.name} (exceeds 10MB)`); continue }
      const ext = '.' + file.name.split('.').pop()?.toLowerCase()
      if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext as any)) { failures.push(`${file.name} (unsupported type)`); continue }
      const safeExt = file.name.split('.').pop()?.toLowerCase() || 'bin'
      const sanitizedName = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${safeExt}`
      const filePath = `${deal.id}/${sanitizedName}`
      const { error: uploadError } = await supabase.storage.from('deal-documents').upload(filePath, file)
      if (uploadError) { failures.push(`${file.name} (upload failed)`); continue }
      const { data: docRecord, error: insertError } = await supabase.from('deal_documents').insert({
        deal_id: deal.id, uploaded_by: user.id, document_type: uploadDocType,
        file_name: file.name, file_path: filePath, file_size: file.size, upload_source: 'manual_upload',
      }).select().single()
      if (insertError) { failures.push(`${file.name} (save failed)`); continue }
      if (docRecord) { setDocuments(prev => [docRecord, ...prev]); successCount++ }
    }

    setUploading(false)
    if (failures.length > 0 && successCount > 0) {
      setStatusMessage({ type: 'error', text: `${successCount} uploaded, ${failures.length} failed: ${failures.join(', ')}` })
    } else if (failures.length > 0) {
      setStatusMessage({ type: 'error', text: `Upload failed: ${failures.join(', ')}` })
    } else {
      setStatusMessage({ type: 'success', text: `${successCount} document${successCount > 1 ? 's' : ''} uploaded successfully` })
    }
    e.target.value = ''
  }

  const handleDocumentDownload = async (doc: DealDocument) => {
    const response = await fetch('/api/documents/signed-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: doc.id, filePath: doc.file_path, dealId: dealId }),
    })
    const result = await response.json()
    if (!result.success || !result.data?.signedUrl) {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to generate download link' }); return
    }
    window.open(result.data.signedUrl, '_blank')
  }

  const startEditing = () => {
    if (!deal) return
    // Try to parse existing address back into parts (format: "street, city, province, postal")
    const parts = deal.property_address.split(',').map((p: string) => p.trim())
    if (parts.length >= 4) {
      setEditStreetAddress(parts[0])
      setEditCity(parts[1])
      setEditProvince(parts[2])
      setEditPostalCode(parts[3])
    } else if (parts.length === 3) {
      setEditStreetAddress(parts[0])
      setEditCity(parts[1])
      setEditProvince('Ontario')
      setEditPostalCode(parts[2])
    } else {
      // Older deals with non-standard format — put entire address in street field
      setEditStreetAddress(deal.property_address)
      setEditCity('')
      setEditProvince('Ontario')
      setEditPostalCode('')
    }
    setEditClosingDate(deal.closing_date)
    setEditGrossCommission(deal.gross_commission.toString())
    setEditBrokerageSplitPct(deal.brokerage_split_pct.toString())
    setEditing(true)
  }

  const cancelEditing = () => {
    setEditing(false)
    setStatusMessage(null)
  }

  const handleSaveEdit = async () => {
    if (!deal) return
    setSaving(true)
    setStatusMessage(null)
    const result = await updateDealDetails({
      dealId: deal.id,
      propertyAddress: [editStreetAddress.trim(), editCity.trim(), editProvince.trim(), editPostalCode.trim().toUpperCase()].filter(Boolean).join(', '),
      closingDate: editClosingDate,
      grossCommission: parseFloat(editGrossCommission),
      brokerageSplitPct: parseFloat(editBrokerageSplitPct),
    })
    if (result.success && result.data) {
      setDeal(result.data as Deal)
      setEditing(false)
      setStatusMessage({ type: 'success', text: 'Deal updated successfully. Financials have been recalculated.' })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update deal' })
    }
    setSaving(false)
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  const getDocTypeLabel = (type: string) => DOCUMENT_TYPES.find(d => d.value === type)?.label || type
  const scrollToDocumentSection = () => {
    const docsSection = document.querySelector('[data-section="documents"]')
    if (docsSection) {
      docsSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setDocsExpanded(true)
    }
  }
  const formatCurrency = (amount: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
  const formatDate = (date: string) => new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  const formatDateTime = (date: string) => new Date(date).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  const statusBadge = getStatusBadgeStyle

  if (loading) return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
          <div className="h-5 w-48 rounded animate-pulse mb-2" style={{ background: 'rgba(255,255,255,0.1)' }} />
          <div className="h-3 w-32 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.05)' }} />
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="rounded-xl p-6 mb-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          <div className="h-2 w-full rounded-full animate-pulse mb-4" style={{ background: colors.skeletonHighlight }} />
          <div className="flex gap-1.5">
            {[1,2,3,4,5,6].map(i => (<div key={i} className="flex-1 h-2 rounded-full animate-pulse" style={{ background: colors.skeletonHighlight }} />))}
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {[1,2].map(i => (
              <div key={i} className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                <div className="h-4 w-28 rounded animate-pulse mb-4" style={{ background: colors.skeletonBase }} />
                {[1,2,3].map(j => (<div key={j} className="h-3 w-full rounded animate-pulse mb-3" style={{ background: colors.skeletonHighlight }} />))}
              </div>
            ))}
          </div>
          <div className="space-y-6">
            <div className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
              <div className="h-3 w-20 rounded animate-pulse mb-4" style={{ background: colors.skeletonBase }} />
              {[1,2,3,4].map(j => (<div key={j} className="h-3 w-full rounded animate-pulse mb-3" style={{ background: colors.skeletonHighlight }} />))}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
  if (!deal) return (<div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}><div style={{ color: colors.textMuted }} className="text-lg">Deal not found</div></div>)

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-5">
            <div className="flex items-center gap-4">
              <img src="/brand/white.png" alt="Firm Funds" className="h-16 sm:h-20 md:h-28 w-auto" />
              <div className="w-px h-10" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <button
                onClick={() => router.push('/agent')}
                className="transition-colors"
                style={{ color: colors.textSecondary }}
                onMouseEnter={(e) => e.currentTarget.style.color = colors.gold}
                onMouseLeave={(e) => e.currentTarget.style.color = colors.textSecondary}
              >
                <ArrowLeft size={20} />
              </button>
              <div>
                <h1 className="text-lg font-bold text-white">{deal.property_address}</h1>
                <p className="text-xs" style={{ color: colors.textMuted }}>Submitted {formatDateTime(deal.created_at)}</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span
                className="inline-flex px-3 py-1.5 text-sm font-semibold rounded-lg"
                style={statusBadge(deal.status)}
              >
                {formatStatusLabel(deal.status)}
              </span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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

        {/* Document Requests Banner */}
        {docRequests.length > 0 && (
          <div
            className="mb-6 rounded-xl overflow-hidden"
            style={{ border: `1px solid ${colors.border}`, background: colors.cardBg }}
          >
            <div
              className="h-full w-1 absolute left-0"
              style={{ background: '#5FA873' }}
            />
            <div className="px-6 py-5 pl-5 flex gap-4">
              <div className="flex-shrink-0 mt-0.5">
                <AlertCircle size={20} style={{ color: '#5FA873' }} />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-sm mb-3" style={{ color: colors.textPrimary }}>
                  Firm Funds has requested the following documents for this deal:
                </h3>
                <div className="space-y-2">
                  {docRequests.map((request) => (
                    <div key={request.id} className="text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium" style={{ color: colors.textPrimary }}>
                            {getDocTypeLabel(request.document_type)}
                          </p>
                          {request.message && (
                            <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                              {request.message}
                            </p>
                          )}
                          <p className="text-xs mt-1" style={{ color: colors.textFaint }}>
                            Requested {formatDate(request.created_at)}
                          </p>
                        </div>
                        <button
                          onClick={scrollToDocumentSection}
                          className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap"
                          style={{
                            background: '#5FA873',
                            color: 'white',
                            border: '1px solid #5FA873'
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = '#4A8B5F' }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = '#5FA873' }}
                        >
                          Upload
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Deal Pipeline */}
        <div className="rounded-xl mb-6 p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          <h3 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: colors.gold }}>Deal Progress</h3>
          <div className="flex items-center gap-1.5">
            {['under_review', 'approved', 'funded', 'repaid', 'closed'].map((status, index) => {
              const isActive = status === deal.status
              const isPast = ['under_review', 'approved', 'funded', 'repaid', 'closed'].indexOf(deal.status) > index
              const isDenied = deal.status === 'denied'
              const barColor = isDenied ? '#F0C5C5' : isActive ? '#5FA873' : isPast ? '#1A7A2E' : '#E8E4DF'
              const labelColor = isDenied ? '#993D3D' : isActive ? '#5FA873' : isPast ? '#1A7A2E' : '#D0D0D0'
              return (
                <div key={status} className="flex-1">
                  <div className="h-2 rounded-full" style={{ background: barColor }} />
                  <p className={`text-xs mt-1.5 text-center ${isActive ? 'font-bold' : isPast ? 'font-medium' : ''}`} style={{ color: labelColor }}>
                    {formatStatusLabel(status)}
                  </p>
                </div>
              )
            })}
          </div>
          {deal.status === 'denied' && (
            <div className="mt-4 p-3 rounded-lg flex items-start gap-2" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}` }}>
              <AlertTriangle size={16} style={{ color: colors.errorText }} className="mt-0.5 flex-shrink-0" />
              <p className="text-sm" style={{ color: colors.errorText }}><strong>Denied:</strong> {deal.denial_reason || 'No reason provided'}</p>
            </div>
          )}
          {deal.status === 'cancelled' && (
            <div className="mt-4 p-3 rounded-lg flex items-start gap-2" style={{ background: colors.warningBg, border: `1px solid ${colors.warningBorder}` }}>
              <AlertTriangle size={16} style={{ color: colors.warningText }} className="mt-0.5 flex-shrink-0" />
              <p className="text-sm" style={{ color: colors.warningText }}><strong>Cancelled</strong> — This advance request was cancelled.</p>
            </div>
          )}
          {['under_review', 'approved'].includes(deal.status) && (
            <div className="mt-4 flex justify-end">
              <button
                onClick={async () => {
                  const msg = deal.status === 'under_review'
                    ? 'Withdraw this advance request? It will be permanently removed.'
                    : 'Are you sure you want to cancel this advance request? This cannot be undone.'
                  if (!confirm(msg)) return
                  setCancelling(true)
                  const result = await cancelDeal({ dealId: deal.id })
                  if (result.success) {
                    if (result.data?.deleted) {
                      router.push('/agent')
                    } else {
                      setDeal({ ...deal, status: 'cancelled' })
                      setStatusMessage({ type: 'success', text: 'Advance request cancelled successfully.' })
                    }
                  } else {
                    setStatusMessage({ type: 'error', text: result.error || 'Failed to cancel deal' })
                  }
                  setCancelling(false)
                }}
                disabled={cancelling}
                className="inline-flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                style={{ color: colors.errorText, border: `1px solid ${colors.errorBorder}`, background: colors.errorBg }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.errorBorder }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.errorBg }}
              >
                <X size={14} />
                {cancelling ? (deal.status === 'under_review' ? 'Withdrawing...' : 'Cancelling...') : (deal.status === 'under_review' ? 'Withdraw Request' : 'Cancel This Advance')}
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column */}
          <div className="lg:col-span-2 space-y-6">

            {/* Deal Details */}
            <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
              <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <div className="flex items-center gap-2">
                  <MapPin size={16} style={{ color: colors.gold }} />
                  <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Deal Details</h3>
                </div>
                {deal.status === 'under_review' && !editing && (
                  <button
                    onClick={startEditing}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                    style={{ color: colors.gold, border: `1px solid ${colors.border}` }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = colors.cardHoverBg; e.currentTarget.style.borderColor = colors.gold }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = colors.border }}
                  >
                    <Pencil size={12} /> Edit
                  </button>
                )}
              </div>
              <div className="p-6">
                {editing ? (
                  <>
                    <div className="space-y-4 text-sm">
                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Street Address</label>
                        <input type="text" value={editStreetAddress} onChange={(e) => setEditStreetAddress(e.target.value)} placeholder="123 Main Street" className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }} onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(95,168,115,0.25)' : '0 0 0 2px #5FA873' }} onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }} />
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>City</label>
                          <input type="text" value={editCity} onChange={(e) => setEditCity(e.target.value)} placeholder="Toronto" className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }} onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(95,168,115,0.25)' : '0 0 0 2px #5FA873' }} onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }} />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Province</label>
                          <input type="text" value={editProvince} onChange={(e) => setEditProvince(e.target.value)} placeholder="Ontario" className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }} onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(95,168,115,0.25)' : '0 0 0 2px #5FA873' }} onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }} />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Postal Code</label>
                          <input type="text" value={editPostalCode} onChange={(e) => setEditPostalCode(e.target.value)} placeholder="M5V 1A1" maxLength={7} className="w-full rounded-lg px-3 py-2.5 text-sm outline-none uppercase" style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }} onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(95,168,115,0.25)' : '0 0 0 2px #5FA873' }} onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Closing Date</label>
                          <input type="date" value={editClosingDate} onChange={(e) => setEditClosingDate(e.target.value)} min={new Date(Date.now() + 86400000).toISOString().split('T')[0]} className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }} onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(95,168,115,0.25)' : '0 0 0 2px #5FA873' }} onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }} />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Gross Commission ($)</label>
                          <input type="number" value={editGrossCommission} onChange={(e) => setEditGrossCommission(e.target.value)} min="0" step="0.01" className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }} onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(95,168,115,0.25)' : '0 0 0 2px #5FA873' }} onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }} />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Brokerage Split (%)</label>
                        <input type="number" value={editBrokerageSplitPct} onChange={(e) => setEditBrokerageSplitPct(e.target.value)} min="0" max="100" step="0.1" className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }} onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold; e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(95,168,115,0.25)' : '0 0 0 2px #5FA873' }} onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder; e.currentTarget.style.boxShadow = 'none' }} />
                      </div>
                    </div>
                    <div className="flex gap-3 mt-5">
                      <button onClick={cancelEditing} disabled={saving} className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-colors" style={{ border: `1px solid ${colors.border}`, color: colors.textSecondary }} onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                        <span className="flex items-center justify-center gap-1.5"><X size={14} /> Cancel</span>
                      </button>
                      <button onClick={handleSaveEdit} disabled={saving} className="flex-1 text-white py-2.5 px-4 rounded-lg font-bold text-sm flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #1A7A2E, #15631F)' }} onMouseEnter={(e) => { if (!saving) e.currentTarget.style.background = 'linear-gradient(135deg, #15631F, #0F4D17)' }} onMouseLeave={(e) => e.currentTarget.style.background = 'linear-gradient(135deg, #1A7A2E, #15631F)'}>
                        <Save size={14} /> {saving ? 'Saving...' : 'Save Changes'}
                      </button>
                    </div>
                    <p className="text-xs mt-3" style={{ color: colors.textMuted }}>Saving will recalculate your advance amount based on the updated details.</p>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-5 text-sm">
                      <div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Property Address</p><p className="font-medium" style={{ color: colors.textPrimary }}>{deal.property_address}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Closing Date</p><p className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.closing_date)}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Days Until Closing</p><p className="font-medium" style={{ color: colors.textPrimary }}>{deal.days_until_closing} days</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Source</p><p className="font-medium" style={{ color: colors.textPrimary }}>{deal.source === 'manual_portal' ? 'Agent Portal' : deal.source === 'nexone_auto' ? 'Nexone Auto' : deal.source}</p></div>
                      {deal.funding_date && (<div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Funding Date</p><p className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.funding_date)}</p></div>)}
                      {deal.repayment_date && (<div><p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Repayment Date</p><p className="font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.repayment_date)}</p></div>)}
                    </div>
                    {deal.notes && (
                      <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${colors.divider}` }}>
                        <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Notes</p>
                        <p className="text-sm whitespace-pre-line" style={{ color: colors.textPrimary }}>{deal.notes.replace(/^Transaction type: \w+\n?/, '').trim() || 'No additional notes'}</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Documents Section */}
            <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }} data-section="documents">
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
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-md" style={{ background: '#F2F2F0', color: '#5A5A5A', border: '1px solid #D0D0CC' }}>
                    {documents.length} file{documents.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {docsExpanded ? <ChevronUp size={16} style={{ color: colors.textFaint }} /> : <ChevronDown size={16} style={{ color: colors.textFaint }} />}
              </div>
              {docsExpanded && (
                <div className="p-6">
                  {/* Upload Area */}
                  <div className="rounded-xl p-6 mb-6 text-center transition-colors" style={{ border: `2px dashed ${colors.border}` }}
                    onMouseEnter={(e) => e.currentTarget.style.borderColor = colors.gold}
                    onMouseLeave={(e) => e.currentTarget.style.borderColor = colors.border}
                  >
                    <Upload className="mx-auto mb-2" size={28} style={{ color: colors.gold }} />
                    <p className="text-sm mb-3" style={{ color: colors.textSecondary }}>Upload documents for this deal</p>
                    <div className="flex items-center justify-center gap-3 mb-3">
                      <select
                        value={uploadDocType}
                        onChange={(e) => setUploadDocType(e.target.value)}
                        className="rounded-lg px-3 py-2 text-sm outline-none"
                        style={{ border: `1px solid ${colors.border}`, color: colors.inputText, background: colors.inputBg }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {DOCUMENT_TYPES.map(dt => (<option key={dt.value} value={dt.value}>{dt.label}</option>))}
                      </select>
                    </div>
                    <label
                      className="inline-flex items-center gap-2 text-white px-4 py-2 rounded-lg font-medium text-sm cursor-pointer transition-colors"
                      style={{ background: colors.headerBgGradient }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'linear-gradient(135deg, #2D2D2D, #3D3D3D)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = colors.headerBgGradient}
                    >
                      <Upload size={16} />{uploading ? 'Uploading...' : 'Choose Files'}
                      <input type="file" multiple onChange={handleFileUpload} disabled={uploading} className="hidden" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.xls,.xlsx,.csv,.txt" />
                    </label>
                    <p className="text-xs mt-2" style={{ color: colors.textFaint }}>PDF, Word, Excel, Images up to 10MB each</p>
                  </div>

                  {/* Document List */}
                  {documents.length === 0 ? (
                    <div className="text-center py-6">
                      <FileText className="mx-auto mb-3" size={32} style={{ color: colors.textFaint }} />
                      <p className="text-sm" style={{ color: colors.textMuted }}>No documents uploaded yet</p>
                      <p className="text-xs mt-1" style={{ color: colors.textFaint }}>Upload your APS, trade sheet, and other documents to speed up your advance.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {documents.map((doc) => (
                        <div
                          key={doc.id}
                          className="flex items-center justify-between p-3 rounded-lg transition-colors"
                          style={{ background: colors.tableHeaderBg }}
                          onMouseEnter={(e) => e.currentTarget.style.background = colors.divider}
                          onMouseLeave={(e) => e.currentTarget.style.background = colors.tableHeaderBg}
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <FileText size={18} style={{ color: colors.gold }} className="flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{doc.file_name}</p>
                              <p className="text-xs" style={{ color: colors.textMuted }}>{getDocTypeLabel(doc.document_type)} · {formatFileSize(doc.file_size)} · {formatDateTime(doc.created_at)}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => handleDocumentDownload(doc)}
                            className="p-2 rounded-lg transition-colors flex-shrink-0 ml-2"
                            style={{ color: colors.textMuted }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = colors.infoText; e.currentTarget.style.background = colors.infoBg }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = 'transparent' }}
                            title="Download"
                          >
                            <Download size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-6">
            {/* Financial Summary */}
            <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
              <div className="px-6 py-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <DollarSign size={14} style={{ color: colors.gold }} />
                <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Financial Summary</h3>
              </div>
              <div className="p-4 space-y-3 text-sm">
                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Gross Commission</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.gross_commission)}</span></div>
                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Brokerage Split ({deal.brokerage_split_pct}%)</span><span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(deal.gross_commission - deal.net_commission)}</span></div>
                <div className="flex justify-between pt-2" style={{ borderTop: `1px solid ${colors.divider}` }}><span className="font-medium" style={{ color: colors.textPrimary }}>Your Net Commission</span><span className="font-semibold" style={{ color: colors.textPrimary }}>{formatCurrency(deal.net_commission)}</span></div>
                <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Discount Fee</span><span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(deal.discount_fee)}</span></div>
                <div className="flex justify-between items-center rounded-xl px-4 py-3 -mx-1 mt-2" style={{ background: colors.successBg, border: `1px solid ${colors.successBorder}` }}>
                  <span className="font-bold" style={{ color: colors.successText }}>Advance Amount</span>
                  <span className="font-bold text-lg" style={{ color: colors.successText }}>{formatCurrency(deal.advance_amount)}</span>
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div className="rounded-xl overflow-hidden" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
              <div className="px-6 py-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                <Clock size={14} style={{ color: colors.gold }} />
                <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Timeline</h3>
              </div>
              <div className="p-4 space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={16} style={{ color: colors.successText }} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-medium" style={{ color: colors.textPrimary }}>Submitted</p>
                    <p className="text-xs" style={{ color: colors.textMuted }}>{formatDateTime(deal.created_at)}</p>
                  </div>
                </div>
                {deal.funding_date && (
                  <div className="flex items-start gap-3">
                    <CheckCircle2 size={16} style={{ color: '#5B3D99' }} className="mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-medium" style={{ color: colors.textPrimary }}>Funded</p>
                      <p className="text-xs" style={{ color: colors.textMuted }}>{formatDate(deal.funding_date)}</p>
                    </div>
                  </div>
                )}
                {deal.repayment_date && (
                  <div className="flex items-start gap-3">
                    <CheckCircle2 size={16} style={{ color: '#0D7A5F' }} className="mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-medium" style={{ color: colors.textPrimary }}>Repaid</p>
                      <p className="text-xs" style={{ color: colors.textMuted }}>{formatDate(deal.repayment_date)}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Documents checklist - dynamic, shows what's uploaded vs missing */}
            {(() => {
              const requiredDocs = [
                { type: 'aps', label: 'Agreement of Purchase and Sale', required: true },
                { type: 'trade_record', label: 'Trade Record Sheet', required: true, note: 'Uploaded by your brokerage' },
                { type: 'notice_of_fulfillment', label: 'Notice of Fulfillment / Waiver', required: false },
                { type: 'amendment', label: 'Amendments', required: false },
              ]
              const firstTimeDocs = [
                { type: 'kyc_fintrac', label: 'FINTRAC / ID Documents', required: true },
                { type: 'id_verification', label: 'Void Cheque or Banking Info', required: true },
              ]
              const uploadedTypes = new Set(documents.map(d => d.document_type))
              const allDocs = [...requiredDocs, ...firstTimeDocs]
              const missingRequired = allDocs.filter(d => d.required && !uploadedTypes.has(d.type))
              const allUploaded = missingRequired.length === 0

              return (
                <div className="rounded-xl p-4" style={{
                  background: allUploaded ? colors.successBg : colors.tableHeaderBg,
                  border: `1px solid ${allUploaded ? colors.successBorder : colors.border}`
                }}>
                  <div className="flex items-center gap-2 mb-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Document Checklist</h4>
                    {allUploaded ? (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ background: colors.successBg, color: colors.successText, border: `1px solid ${colors.successBorder}` }}>Complete</span>
                    ) : (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ background: colors.warningBg, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }}>{missingRequired.length} needed</span>
                    )}
                  </div>

                  <p className="text-xs font-semibold mb-1.5" style={{ color: colors.textPrimary }}>Each Advance</p>
                  <div className="space-y-1.5 mb-3">
                    {requiredDocs.map(doc => {
                      const uploaded = uploadedTypes.has(doc.type)
                      return (
                        <div key={doc.type} className="flex items-start gap-2">
                          {uploaded
                            ? <CheckCircle2 size={14} style={{ color: colors.successText, marginTop: 1 }} />
                            : <AlertTriangle size={14} style={{ color: doc.required ? colors.warningText : colors.textFaint, marginTop: 1 }} />
                          }
                          <div>
                            <span className="text-xs" style={{ color: uploaded ? colors.successText : (doc.required ? colors.textPrimary : colors.textSecondary) }}>
                              {doc.label}
                            </span>
                            {doc.note && <span className="text-xs ml-1" style={{ color: colors.textFaint }}>({doc.note})</span>}
                            {!doc.required && !uploaded && <span className="text-xs ml-1" style={{ color: colors.textFaint }}>(if applicable)</span>}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <p className="text-xs font-semibold mb-1.5" style={{ color: colors.textPrimary }}>First Time Only</p>
                  <div className="space-y-1.5 mb-3">
                    {firstTimeDocs.map(doc => {
                      const uploaded = uploadedTypes.has(doc.type)
                      return (
                        <div key={doc.type} className="flex items-start gap-2">
                          {uploaded
                            ? <CheckCircle2 size={14} style={{ color: colors.successText, marginTop: 1 }} />
                            : <AlertTriangle size={14} style={{ color: colors.warningText, marginTop: 1 }} />
                          }
                          <span className="text-xs" style={{ color: uploaded ? colors.successText : colors.textPrimary }}>
                            {doc.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  <p className="text-xs" style={{ color: colors.textMuted }}>Uploading all documents upfront helps us process your advance faster.</p>
                </div>
              )
            })()}
          </div>
        </div>
      </main>
    </div>
  )
}
