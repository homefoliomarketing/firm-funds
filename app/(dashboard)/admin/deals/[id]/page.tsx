'use client'

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft, CheckCircle2, Circle, FileText, DollarSign, MapPin,
  User, Building2, AlertTriangle, XCircle, Shield, ChevronDown,
  ChevronUp, Banknote, RefreshCw, Trash2, Download, Paperclip,
  StickyNote, AlertCircle, Undo2, Send, Eye, X, Plus, Clock, Edit2, ExternalLink
} from 'lucide-react'
import {
  updateDealStatus,
  toggleChecklistItem as serverToggleChecklistItem,
  deleteDocument as serverDeleteDocument,
  saveAdminNotes,
  addAdminNote,
  updateClosingDate,
  requestDocument,
  fulfillDocumentRequest,
  cancelDocumentRequest,
  deleteDeal,
} from '@/lib/actions/deal-actions'
import { recordEftTransfer, confirmEftTransfer, removeEftTransfer, recordBrokeragePayment, removeBrokeragePayment } from '@/lib/actions/admin-actions'
import { getStatusBadgeStyle } from '@/lib/constants'
import { useTheme } from '@/lib/theme'
import SignOutModal from '@/components/SignOutModal'

// ============================================================================
// PDF Canvas Viewer — renders PDFs via pdf.js (CDN) to canvas, no browser plugin needed
// ============================================================================
function PdfCanvasViewer({ pdfData }: { pdfData: ArrayBuffer }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const renderedRef = useRef(false)

  useEffect(() => {
    if (renderedRef.current) return
    renderedRef.current = true

    let cancelled = false

    async function render() {
      try {
        // Load pdf.js from CDN
        if (!(window as any).pdfjsLib) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script')
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs'
            script.type = 'module'
            // For module scripts, we need a different loading approach
            script.onerror = reject
            document.head.appendChild(script)

            // Use dynamic import instead since pdf.js 4.x is ESM
            const importScript = document.createElement('script')
            importScript.type = 'module'
            importScript.textContent = `
              import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
              pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
              window.pdfjsLib = pdfjsLib;
              window.dispatchEvent(new Event('pdfjsReady'));
            `
            document.head.appendChild(importScript)

            const onReady = () => {
              window.removeEventListener('pdfjsReady', onReady)
              resolve()
            }
            window.addEventListener('pdfjsReady', onReady)
            // Timeout after 10s
            setTimeout(() => reject(new Error('pdf.js load timeout')), 10000)
          })
        }

        if (cancelled) return

        const pdfjsLib = (window as any).pdfjsLib
        const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise

        if (cancelled || !containerRef.current) return

        // Render each page to a canvas
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i)
          const scale = 1.5
          const viewport = page.getViewport({ scale })

          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          canvas.style.display = 'block'

          if (i > 1) {
            // Add a subtle separator between pages
            const sep = document.createElement('div')
            sep.style.height = '4px'
            sep.style.background = '#333'
            containerRef.current.appendChild(sep)
          }

          containerRef.current.appendChild(canvas)

          const ctx = canvas.getContext('2d')!
          await page.render({ canvasContext: ctx, viewport }).promise
        }

        setLoading(false)
      } catch (err) {
        console.error('PDF render error:', err)
        if (!cancelled) {
          setError('Failed to render PDF')
          setLoading(false)
        }
      }
    }

    render()
    return () => { cancelled = true }
  }, [pdfData])

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <p style={{ color: '#E07B7B', fontSize: 14 }}>{error}</p>
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ padding: 0 }}>
      {loading && (
        <div className="flex items-center justify-center p-8">
          <div style={{
            width: 32, height: 32, border: '3px solid #333', borderTopColor: '#5FA873',
            borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          }} />
        </div>
      )}
    </div>
  )
}

interface Deal {
  id: string; agent_id: string; brokerage_id: string; status: string
  property_address: string; closing_date: string; gross_commission: number
  brokerage_split_pct: number; net_commission: number; days_until_closing: number
  discount_fee: number; advance_amount: number; brokerage_referral_fee: number
  amount_due_from_brokerage: number; funding_date: string | null
  repayment_date: string | null; repayment_amount: number | null
  eft_transfers: { amount: number; date: string; confirmed: boolean; reference?: string }[] | null
  brokerage_payments: { amount: number; date: string; reference?: string; method?: string }[] | null
  source: string; denial_reason: string | null
  notes: string | null; created_at: string; updated_at: string
  admin_notes: string | null
  admin_notes_timeline: { id: string; text: string; author_name: string; created_at: string }[] | null
}

interface ChecklistItem {
  id: string; deal_id: string; category: string; checklist_item: string; is_checked: boolean
  checked_by: string | null; checked_at: string | null; notes: string | null; sort_order: number
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
  requested_by: string
  status: 'pending' | 'fulfilled' | 'cancelled'
  fulfilled_at: string | null
  fulfilled_document_id: string | null
  created_at: string
  updated_at: string
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
  submitted: ['under_review', 'denied'], under_review: ['approved', 'denied', 'cancelled'],
  approved: ['funded', 'denied', 'cancelled', 'under_review'], funded: ['repaid', 'approved'],
  denied: ['under_review'], cancelled: ['under_review'], repaid: ['closed', 'funded'],
}

// Backward transitions that should trigger a warning
const BACKWARD_STATUSES: Record<string, string[]> = {
  approved: ['under_review'],
  funded: ['approved'],
  denied: ['under_review'],
  cancelled: ['under_review'],
  repaid: ['funded'],
}

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted', under_review: 'Under Review', approved: 'Approved',
  funded: 'Funded', repaid: 'Repaid', closed: 'Closed', denied: 'Denied', cancelled: 'Cancelled',
}

interface ChecklistCategory {
  label: string
  icon: any
  color: string
  bg: string
  border: string
  items: ChecklistItem[]
  matchingDocs: Map<string, DealDocument[]>
}

// Category display config — keyed by category name stored in DB
const CATEGORY_STYLES: Record<string, { icon: any; color: string; bg: string; border: string }> = {
  'Agent Verification': { icon: User, color: '#5B3D99', bg: '#F5F0FF', border: '#D5C5F0' },
  'Deal Document Review': { icon: FileText, color: '#3D5A99', bg: '#F0F4FF', border: '#C5D3F0' },
  'Financial': { icon: DollarSign, color: '#92700C', bg: '#FFF8ED', border: '#E8D5A8' },
  'Firm Funds Documents': { icon: Shield, color: '#2D7A4F', bg: '#F0FFF5', border: '#B5E0C5' },
}

// Fallback style for any category not in the map
const DEFAULT_CATEGORY_STYLE = { icon: FileText, color: '#666', bg: '#F5F5F5', border: '#DDD' }

// Category display order
const CATEGORY_ORDER = ['Agent Verification', 'Deal Document Review', 'Financial', 'Firm Funds Documents']

function categorizeChecklist(items: ChecklistItem[]): ChecklistCategory[] {
  // Group items by their DB category, preserving sort_order within each group
  const grouped = new Map<string, ChecklistItem[]>()
  for (const item of items.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))) {
    const cat = item.category || 'Uncategorized'
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(item)
  }

  // Build categories in defined order, then append any extras
  const result: ChecklistCategory[] = []
  const orderedKeys = [...CATEGORY_ORDER, ...Array.from(grouped.keys()).filter(k => !CATEGORY_ORDER.includes(k))]

  for (const key of orderedKeys) {
    const catItems = grouped.get(key)
    if (!catItems || catItems.length === 0) continue
    const style = CATEGORY_STYLES[key] || DEFAULT_CATEGORY_STYLE
    result.push({
      label: key,
      icon: style.icon,
      color: style.color,
      bg: style.bg,
      border: style.border,
      items: catItems,
      matchingDocs: new Map(),
    })
  }

  return result
}

const ACTION_CONFIG: Record<string, { label: string; icon: any; bg: string; hoverBg: string }> = {
  under_review: { label: 'Start Review', icon: RefreshCw, bg: '#3D5A99', hoverBg: '#2D4A89' },
  approved:     { label: 'Approve Deal', icon: CheckCircle2, bg: '#1A7A2E', hoverBg: '#156A24' },
  funded:       { label: 'Mark as Funded', icon: Banknote, bg: '#5B3D99', hoverBg: '#4B2D89' },
  repaid:       { label: 'Mark as Repaid', icon: DollarSign, bg: '#0D7A5F', hoverBg: '#0A6A4F' },
  closed:       { label: 'Close Deal', icon: CheckCircle2, bg: '#5A5A5A', hoverBg: '#4A4A4A' },
  denied:       { label: 'Deny Deal', icon: XCircle, bg: '#993D3D', hoverBg: '#892D2D' },
  cancelled:    { label: 'Cancel Deal', icon: XCircle, bg: '#666666', hoverBg: '#555555' },
}

// Labels for backward-specific actions (override the forward label)
const BACKWARD_LABELS: Record<string, string> = {
  under_review: 'Revert to Under Review',
  approved: 'Revert to Approved',
  funded: 'Revert to Funded',
}

export default function DealDetailPage() {
  const [deal, setDeal] = useState<Deal | null>(null)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [brokerage, setBrokerage] = useState<Brokerage | null>(null)
  const [checklist, setChecklist] = useState<ChecklistItem[]>([])
  const [documents, setDocuments] = useState<DealDocument[]>([])
  const [docRequests, setDocRequests] = useState<DocumentRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [denialReason, setDenialReason] = useState('')
  const [showDenialInput, setShowDenialInput] = useState(false)
  const [pendingBackward, setPendingBackward] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [checklistExpanded, setChecklistExpanded] = useState(true)
  const [docsExpanded, setDocsExpanded] = useState(true)
  const [showEftForm, setShowEftForm] = useState(false)
  const [eftAmount, setEftAmount] = useState('')
  const [eftDate, setEftDate] = useState(new Date().toISOString().split('T')[0])
  const [eftReference, setEftReference] = useState('')
  const [eftSaving, setEftSaving] = useState(false)
  const [adminNotes, setAdminNotes] = useState('')
  const [adminNotesSaving, setAdminNotesSaving] = useState(false)
  const [adminNotesLastSaved, setAdminNotesLastSaved] = useState<string | null>(null)
  const [notesTimeline, setNotesTimeline] = useState<{ id: string; text: string; author_name: string; created_at: string }[]>([])
  const [newNoteText, setNewNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [editingClosingDate, setEditingClosingDate] = useState(false)
  const [newClosingDate, setNewClosingDate] = useState('')
  const [closingDateSaving, setClosingDateSaving] = useState(false)
  const [closingDateComparison, setClosingDateComparison] = useState<{ old: Record<string, any>; new: Record<string, any> } | null>(null)
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0])
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [showDocRequest, setShowDocRequest] = useState(false)
  const [docRequestType, setDocRequestType] = useState('')
  const [docRequestMessage, setDocRequestMessage] = useState('')
  const [docRequestSending, setDocRequestSending] = useState(false)
  const [viewingDoc, setViewingDoc] = useState<{ blobUrl: string; originalUrl: string; fileName: string; type: 'pdf' | 'image'; pdfData?: ArrayBuffer } | null>(null)
  const [viewLoading, setViewLoading] = useState<string | null>(null)
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
    if (!profile || (profile.role !== 'super_admin' && profile.role !== 'firm_funds_admin')) { router.push('/login'); return }
    const { data: dealData, error: dealError } = await supabase.from('deals').select('*').eq('id', dealId).single()
    if (dealError || !dealData) { router.push('/admin'); return }
    setDeal(dealData)
    setAdminNotes(dealData.admin_notes || '')
    setNotesTimeline(Array.isArray(dealData.admin_notes_timeline) ? dealData.admin_notes_timeline : [])
    const { data: agentData } = await supabase.from('agents').select('*').eq('id', dealData.agent_id).single()
    setAgent(agentData)
    const { data: brokerageData } = await supabase.from('brokerages').select('*').eq('id', dealData.brokerage_id).single()
    setBrokerage(brokerageData)
    const { data: checklistData } = await supabase.from('underwriting_checklist').select('*').eq('deal_id', dealId).order('sort_order', { ascending: true })
    setChecklist(checklistData || [])
    const { data: docsData } = await supabase.from('deal_documents').select('*').eq('deal_id', dealId).order('created_at', { ascending: false })
    setDocuments(docsData || [])
    const { data: requestsData } = await supabase.from('document_requests').select('*').eq('deal_id', dealId).order('created_at', { ascending: false })
    setDocRequests(requestsData || [])
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

  const isBackwardTransition = (newStatus: string) => {
    if (!deal) return false
    return (BACKWARD_STATUSES[deal.status] || []).includes(newStatus)
  }

  const handleStatusChange = async (newStatus: string) => {
    if (!deal) return
    if (newStatus === 'denied' && !denialReason.trim()) { setShowDenialInput(true); return }
    // Show confirmation for backward transitions
    if (isBackwardTransition(newStatus) && pendingBackward !== newStatus) {
      setPendingBackward(newStatus)
      return
    }
    setPendingBackward(null)
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
      setShowPaymentForm(false)
    }
    setUpdating(false)
  }

  // Generate signed URL client-side (direct to Supabase, no Netlify involved)
  // Storage policies allow any authenticated user to read from deal-documents
  const getSignedUrl = async (filePath: string) => {
    const { data, error } = await supabase.storage
      .from('deal-documents')
      .createSignedUrl(filePath, 3600, { download: false })
    if (error || !data?.signedUrl) {
      console.error('Signed URL error:', error?.message)
      return null
    }
    return data.signedUrl
  }

  const handleDocumentDownload = async (doc: DealDocument) => {
    const signedUrl = await getSignedUrl(doc.file_path)
    if (!signedUrl) {
      setStatusMessage({ type: 'error', text: 'Failed to generate download link' }); return
    }
    window.open(signedUrl, '_blank')
  }

  // Clean up blob URL when closing the viewer
  const closeDocViewer = () => {
    if (viewingDoc?.blobUrl) URL.revokeObjectURL(viewingDoc.blobUrl)
    setViewingDoc(null)
  }

  const handleDocumentView = async (doc: DealDocument) => {
    // Determine if the file is viewable
    const ext = doc.file_name.toLowerCase().split('.').pop() || ''
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
    const isPdf = ext === 'pdf'
    if (!isImage && !isPdf) {
      handleDocumentDownload(doc)
      return
    }
    setViewLoading(doc.id)
    const signedUrl = await getSignedUrl(doc.file_path)
    if (!signedUrl) {
      setStatusMessage({ type: 'error', text: 'Failed to load document' })
      setViewLoading(null)
      return
    }
    try {
      // Fetch as blob to bypass iframe/img content-blocking headers
      const response = await fetch(signedUrl)
      const arrayBuffer = await response.arrayBuffer()
      // Create blob with explicit MIME type so the browser knows how to render it
      const mimeType = isPdf ? 'application/pdf' : (response.headers.get('content-type') || 'image/png')
      const blob = new Blob([arrayBuffer], { type: mimeType })
      const blobUrl = URL.createObjectURL(blob)
      // Revoke previous blob URL if any
      if (viewingDoc?.blobUrl) URL.revokeObjectURL(viewingDoc.blobUrl)
      setViewingDoc({
        blobUrl,
        originalUrl: signedUrl,
        fileName: doc.file_name,
        type: isImage ? 'image' : 'pdf',
        ...(isPdf ? { pdfData: arrayBuffer } : {}),
      })
    } catch (err) {
      console.error('Blob fetch failed:', err)
      // Fallback: open in new tab if blob fetch fails
      window.open(signedUrl, '_blank')
    }
    setViewLoading(null)
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

  const handleSaveAdminNotes = async () => {
    if (!deal) return
    setAdminNotesSaving(true)
    const result = await saveAdminNotes({ dealId: deal.id, adminNotes })
    if (result.success) {
      setAdminNotesLastSaved(new Date().toISOString())
      setStatusMessage({ type: 'success', text: 'Admin notes saved' })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to save notes' })
    }
    setAdminNotesSaving(false)
  }

  const handleAddNote = async () => {
    if (!deal || !newNoteText.trim()) return
    setAddingNote(true)
    const result = await addAdminNote({ dealId: deal.id, note: newNoteText })
    if (result.success && result.data?.timeline) {
      setNotesTimeline(result.data.timeline)
      setNewNoteText('')
      setStatusMessage({ type: 'success', text: 'Note added' })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to add note' })
    }
    setAddingNote(false)
  }

  const handleUpdateClosingDate = async () => {
    if (!deal || !newClosingDate) return
    setClosingDateSaving(true)
    const result = await updateClosingDate({ dealId: deal.id, newClosingDate })
    if (result.success && result.data) {
      setClosingDateComparison({ old: result.data.old, new: result.data.new })
      // Update deal state directly from server response
      const updated = result.data.new
      setDeal({
        ...deal,
        closing_date: updated.closing_date,
        days_until_closing: updated.days_until_closing,
        discount_fee: updated.discount_fee,
        advance_amount: updated.advance_amount,
        brokerage_referral_fee: updated.brokerage_referral_fee,
        amount_due_from_brokerage: updated.amount_due_from_brokerage,
      })
      setEditingClosingDate(false)
      setStatusMessage({ type: 'success', text: 'Closing date updated and financials recalculated' })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update closing date' })
    }
    setClosingDateSaving(false)
  }

  const handleRequestDocument = async () => {
    if (!deal || !docRequestType) return
    setDocRequestSending(true)
    const result = await requestDocument({
      dealId: deal.id,
      documentType: docRequestType,
      message: docRequestMessage.trim() || undefined,
    })
    if (result.success) {
      setStatusMessage({ type: 'success', text: `Document request sent to ${agent?.email || 'agent'}` })
      setShowDocRequest(false)
      setDocRequestType('')
      setDocRequestMessage('')
      await loadDealData()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to send document request' })
    }
    setDocRequestSending(false)
  }

  const handleFulfillRequest = async (request: DocumentRequest) => {
    const result = await fulfillDocumentRequest({ requestId: request.id })
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Document request marked as fulfilled' })
      await loadDealData()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to fulfill request' })
    }
  }

  const handleCancelRequest = async (request: DocumentRequest) => {
    if (!confirm('Are you sure you want to cancel this document request?')) return
    const result = await cancelDocumentRequest({ requestId: request.id })
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Document request cancelled' })
      await loadDealData()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to cancel request' })
    }
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

  const statusBadge = getStatusBadgeStyle

  const checkedCount = checklist.filter(c => c.is_checked).length
  const totalChecklist = checklist.length
  const checklistPct = totalChecklist > 0 ? Math.round((checkedCount / totalChecklist) * 100) : 0
  const allChecklistComplete = totalChecklist > 0 && checkedCount === totalChecklist

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
              <div key={i} className="rounded-xl p-6 h-40" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }} />
            ))}
          </div>
          <div className="space-y-6">
            {[1,2].map(i => (
              <div key={i} className="rounded-xl p-6 h-48" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }} />
            ))}
          </div>
        </div>
      </main>
    </div>
  )

  if (!deal || !agent || !brokerage) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}>
      <div style={{ color: colors.textMuted }}>Deal not found</div>
    </div>
  )

  const nextStatuses = STATUS_FLOW[deal.status] || []
  const categorizedChecklist = categorizeChecklist(checklist)

  const docPanelWidth = 520
  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Main content area — shrinks when doc panel is open */}
      <div style={{ marginRight: viewingDoc ? docPanelWidth : 0, transition: 'margin-right 0.2s ease-out' }}>
      {/* HEADER */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-10 sm:h-12 w-auto" />
              <div className="w-px h-8" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <button onClick={() => router.push('/admin')} className="flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors text-sm font-medium" style={{ color: 'white' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
            </div>
            <SignOutModal onConfirm={handleLogout} />
          </div>
          <div>
            <h1 className="text-xl font-bold" style={{ color: 'white' }}>{deal.property_address}</h1>
          </div>
        </div>
      </header>

      {/* STATUS MESSAGE TOAST */}
      {statusMessage && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <div className="rounded-lg p-4 animate-fadeIn" style={{
            background: statusMessage.type === 'success' ? colors.successBg : colors.errorBg,
            border: `1px solid ${statusMessage.type === 'success' ? colors.successBorder : colors.errorBorder}`,
            color: statusMessage.type === 'success' ? colors.successText : colors.errorText,
          }}>
            {statusMessage.text}
          </div>
        </div>
      )}

      {/* FLAGGED AGENT WARNING BANNER */}
      {agent?.flagged_by_brokerage && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-3">
          <div className="rounded-md px-3 py-2 flex items-center gap-2" style={{
            background: '#1a0a0a',
            border: '2px solid #dc2626',
            boxShadow: '0 0 15px rgba(220, 38, 38, 0.3)',
          }}>
            <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: '#ef4444' }} />
            <p className="font-bold text-sm" style={{ color: '#ef4444' }}>
              ⚠ AGENT FLAGGED BY BROKERAGE — {agent.first_name} {agent.last_name}. Review carefully.
            </p>
          </div>
        </div>
      )}

      {/* OUTSTANDING RECOVERY WARNING BANNER */}
      {agent && agent.outstanding_recovery && agent.outstanding_recovery > 0 && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2">
          <div className="rounded-md px-3 py-2 flex items-center gap-2" style={{
            background: '#1a1400',
            border: '2px solid #d97706',
            boxShadow: '0 0 15px rgba(217, 119, 6, 0.2)',
          }}>
            <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: '#f59e0b' }} />
            <p className="font-bold text-sm" style={{ color: '#f59e0b' }}>
              OUTSTANDING RECOVERY: ${agent.outstanding_recovery.toLocaleString('en-CA', { minimumFractionDigits: 2 })} — {agent.first_name} {agent.last_name}
            </p>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        {/* DEAL PIPELINE */}
        <div className="mb-3">
          <div className="flex justify-between mb-1">
            <span className="text-xs font-semibold" style={{ color: colors.textPrimary }}>Pipeline</span>
            <span className="text-xs" style={{ color: colors.textMuted }}>{checklistPct}%</span>
          </div>
          <div className="w-full rounded-full h-1.5" style={{ background: colors.border }}>
            <div className="h-1.5 rounded-full transition-all" style={{ width: `${checklistPct}%`, background: colors.gold }} />
          </div>
        </div>

        {/* STICKY ACTION BAR */}
        <div className="sticky top-0 z-20 mb-4 rounded-lg px-3 py-2" style={{
          background: colors.cardBg,
          border: `1px solid ${colors.border}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        }}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              {statusBadge(deal.status) && (
                <div style={statusBadge(deal.status)}>
                  {STATUS_LABELS[deal.status]}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {/* Forward transitions */}
              {nextStatuses.filter(s => !isBackwardTransition(s)).map(status => {
                const config = ACTION_CONFIG[status]
                if (!config) return null
                const Icon = config.icon
                // Block approval/funding until all checklist items are complete
                const needsChecklist = (status === 'approved' || status === 'funded') && !allChecklistComplete
                // Block repaid until brokerage payments match expected amount
                const paymentTotal = (deal.brokerage_payments || []).reduce((sum, p) => sum + p.amount, 0)
                const paymentsMatch = Math.abs(paymentTotal - deal.amount_due_from_brokerage) < 0.01 && paymentTotal > 0
                const needsPayments = status === 'repaid' && !paymentsMatch
                const isDisabled = updating || needsChecklist || needsPayments
                return (
                  <div key={status} className="relative group">
                    <button
                      onClick={() => handleStatusChange(status)}
                      disabled={isDisabled}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ background: config.bg }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = config.hoverBg }}
                      onMouseLeave={(e) => e.currentTarget.style.background = config.bg}
                    >
                      <Icon className="w-4 h-4" />
                      {config.label}
                    </button>
                    {(needsChecklist || needsPayments) && (
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-30"
                        style={{ background: '#1A1A1A', color: '#E07B7B', border: '1px solid #333' }}>
                        {needsChecklist ? `Complete all checklist items first (${checkedCount}/${totalChecklist})` : 'Brokerage payments must match expected amount first'}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Backward transitions — subtle style */}
              {nextStatuses.filter(s => isBackwardTransition(s)).length > 0 && (
                <div className="w-px h-6 mx-1" style={{ background: colors.border }} />
              )}
              {nextStatuses.filter(s => isBackwardTransition(s)).map(status => {
                const config = ACTION_CONFIG[status]
                if (!config) return null
                return (
                  <button
                    key={status}
                    onClick={() => handleStatusChange(status)}
                    disabled={updating}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
                    style={{
                      background: 'transparent',
                      color: colors.textMuted,
                      border: `1px solid ${colors.border}`,
                    }}
                    onMouseEnter={(e) => { if (!e.currentTarget.disabled) { e.currentTarget.style.borderColor = '#D97706'; e.currentTarget.style.color = '#D97706' } }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted }}
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    {BACKWARD_LABELS[status] || config.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* BACKWARD TRANSITION WARNING */}
          {pendingBackward && (
            <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${colors.border}` }}>
              <div className="flex items-start gap-3 p-3 rounded-lg" style={{ background: '#2A1F00', border: '1px solid #5C4400' }}>
                <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#D97706' }} />
                <div className="flex-1">
                  <p className="text-sm font-semibold mb-1" style={{ color: '#FBBF24' }}>
                    Are you sure you want to revert this deal?
                  </p>
                  <p className="text-xs mb-3" style={{ color: '#D4A844' }}>
                    This will move the deal from <strong>{STATUS_LABELS[deal.status]}</strong> back to <strong>{STATUS_LABELS[pendingBackward]}</strong>.
                    {pendingBackward === 'under_review' && ' Any previous approval or denial will be cleared.'}
                    {pendingBackward === 'approved' && ' The funded date and recalculated financials will be preserved but the deal will need to be re-funded.'}
                    {pendingBackward === 'funded' && ' The repayment date will be cleared.'}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleStatusChange(pendingBackward)}
                      disabled={updating}
                      className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-colors"
                      style={{ background: '#D97706' }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#B45309' }}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#D97706'}
                    >
                      {updating ? 'Reverting...' : 'Yes, Revert'}
                    </button>
                    <button
                      onClick={() => setPendingBackward(null)}
                      className="px-4 py-1.5 rounded-lg text-sm font-medium transition"
                      style={{ background: colors.border, color: colors.textPrimary }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* DENIAL REASON TEXTAREA IN ACTION BAR */}
          {showDenialInput && (
            <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${colors.border}` }}>
              <label className="block text-sm font-medium mb-2" style={{ color: colors.textPrimary }}>Denial Reason</label>
              <textarea
                value={denialReason}
                onChange={(e) => setDenialReason(e.target.value)}
                placeholder="Explain why this deal is being denied..."
                className="w-full px-3 py-2 rounded-lg border text-sm resize-none focus:outline-none"
                style={{
                  background: colors.inputBg,
                  borderColor: colors.inputBorder,
                  color: colors.inputText,
                  minHeight: '80px',
                }}
              />
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => handleStatusChange('denied')}
                  disabled={updating || !denialReason.trim()}
                  className="px-4 py-2 rounded-lg font-medium text-white disabled:opacity-50 transition-colors"
                  style={{ background: '#993D3D' }}
                  onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#892D2D' }}
                  onMouseLeave={(e) => e.currentTarget.style.background = '#993D3D'}
                >
                  Confirm Denial
                </button>
                <button
                  onClick={() => { setShowDenialInput(false); setDenialReason('') }}
                  className="px-4 py-2 rounded-lg font-medium transition"
                  style={{ background: colors.border, color: colors.textPrimary }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* REPAYMENT AMOUNT INPUT */}
          {/* Old repayment input removed — replaced by Brokerage Payments section below */}
        </div>

        {/* EFT SECTION - ONLY FOR FUNDED/REPAID */}
        {['funded', 'repaid'].includes(deal.status) && (
          <div className="mb-4 rounded-lg p-4" style={{
            background: colors.cardBg,
            border: `1px solid ${colors.border}`,
          }}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold flex items-center gap-2" style={{ color: colors.textPrimary }}>
                <Banknote className="w-4 h-4" style={{ color: colors.gold }} />
                EFT Transfers
              </h2>
              <button
                onClick={() => setShowEftForm(!showEftForm)}
                className="px-4 py-2 rounded-lg font-medium text-white transition"
                style={{ background: colors.gold }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
              >
                {showEftForm ? 'Cancel' : 'Record Transfer'}
              </button>
            </div>

            {showEftForm && (
              <div className="mb-6 p-4 rounded-lg" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}` }}>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: colors.textPrimary }}>Amount (CAD)</label>
                    <input
                      type="number"
                      value={eftAmount}
                      onChange={(e) => setEftAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none"
                      style={{ background: colors.cardBg, borderColor: colors.inputBorder, color: colors.inputText }}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: colors.textPrimary }}>Transfer Date</label>
                    <input
                      type="date"
                      value={eftDate}
                      onChange={(e) => setEftDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none"
                      style={{ background: colors.cardBg, borderColor: colors.inputBorder, color: colors.inputText, colorScheme: 'dark' }}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: colors.textPrimary }}>Reference / Memo</label>
                    <input
                      type="text"
                      value={eftReference}
                      onChange={(e) => setEftReference(e.target.value)}
                      placeholder="Bank ref #, confirmation..."
                      className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none"
                      style={{ background: colors.cardBg, borderColor: colors.inputBorder, color: colors.inputText }}
                    />
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (!eftAmount || !eftDate) return
                    setEftSaving(true)
                    const result = await recordEftTransfer({
                      dealId: deal.id,
                      amount: parseFloat(eftAmount),
                      date: eftDate,
                      reference: eftReference.trim() || undefined,
                    })
                    if (result.success) {
                      setDeal(prev => prev ? { ...prev, ...result.data } : null)
                      setEftAmount(''); setEftReference('')
                      setEftDate(new Date().toISOString().split('T')[0])
                      setShowEftForm(false)
                      setStatusMessage({ type: 'success', text: 'EFT transfer recorded' })
                    } else {
                      setStatusMessage({ type: 'error', text: result.error || 'Failed to record transfer' })
                    }
                    setEftSaving(false)
                  }}
                  disabled={eftSaving || !eftAmount || !eftDate}
                  className="px-4 py-2 rounded-lg font-medium text-white disabled:opacity-50 transition-colors"
                  style={{ background: '#1A7A2E' }}
                  onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#156A24' }}
                  onMouseLeave={(e) => e.currentTarget.style.background = '#1A7A2E'}
                >
                  Record Transfer
                </button>
              </div>
            )}

            {/* EFT TOTAL TRACKER */}
            {(() => {
              const eftTotal = (deal.eft_transfers || []).reduce((sum, t) => sum + t.amount, 0)
              const expected = deal.advance_amount
              const diff = expected - eftTotal
              const isMatch = Math.abs(diff) < 0.01
              const isOver = eftTotal > expected + 0.01
              return (deal.eft_transfers && deal.eft_transfers.length > 0) ? (
                <div className="mb-4 p-3 rounded-lg flex items-center justify-between text-sm" style={{
                  background: isMatch ? 'rgba(95,168,115,0.1)' : isOver ? 'rgba(224,123,123,0.1)' : 'rgba(212,160,74,0.1)',
                  border: `1px solid ${isMatch ? '#5FA873' : isOver ? '#E07B7B' : '#D4A04A'}`,
                }}>
                  <div>
                    <span style={{ color: colors.textMuted }}>EFT Total: </span>
                    <span className="font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(eftTotal)}</span>
                    <span style={{ color: colors.textMuted }}> / Expected: </span>
                    <span className="font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(expected)}</span>
                  </div>
                  <span className="font-semibold" style={{ color: isMatch ? '#5FA873' : isOver ? '#E07B7B' : '#D4A04A' }}>
                    {isMatch ? 'Matched' : isOver ? `Over by ${formatCurrency(eftTotal - expected)}` : `Remaining: ${formatCurrency(diff)}`}
                  </span>
                </div>
              ) : null
            })()}

            {deal.eft_transfers && deal.eft_transfers.length > 0 ? (
              <div className="space-y-3">
                {deal.eft_transfers.map((eft, idx) => (
                  <div key={idx} className="flex items-center justify-between p-4 rounded-lg" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}` }}>
                    <div>
                      <p className="font-semibold" style={{ color: colors.textPrimary }}>{formatCurrency(eft.amount)}</p>
                      <p className="text-sm" style={{ color: colors.textMuted }}>
                        {formatDate(eft.date)}{eft.reference ? ` \u2022 Ref: ${eft.reference}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {eft.confirmed ? (
                        <span className="px-3 py-1 rounded-full text-sm font-medium" style={{ background: colors.successBg, color: colors.successText }}>
                          Confirmed
                        </span>
                      ) : (
                        <button
                          onClick={async () => {
                            const result = await confirmEftTransfer({ dealId: deal.id, transferIndex: idx })
                            if (result.success) {
                              setDeal(prev => prev ? { ...prev, ...result.data } : null)
                            }
                          }}
                          className="px-3 py-1 rounded-full text-sm font-medium transition"
                          style={{ background: colors.warningBg, color: colors.warningText }}
                        >
                          Confirm
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          const result = await removeEftTransfer({ dealId: deal.id, transferIndex: idx })
                          if (result.success) {
                            setDeal(prev => prev ? { ...prev, ...result.data } : null)
                          }
                        }}
                        className="p-2 rounded-lg transition-colors"
                        style={{ color: colors.errorText }}
                        onMouseEnter={(e) => e.currentTarget.style.background = colors.errorBg}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: colors.textMuted }}>No EFT transfers recorded yet</p>
            )}
          </div>
        )}

        {/* BROKERAGE PAYMENTS SECTION - ONLY FOR FUNDED/REPAID */}
        {['funded', 'repaid'].includes(deal.status) && (
          <div className="mb-4 rounded-lg p-4" style={{
            background: colors.cardBg,
            border: `1px solid ${colors.border}`,
          }}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold flex items-center gap-2" style={{ color: colors.textPrimary }}>
                <DollarSign className="w-4 h-4" style={{ color: '#06B6D4' }} />
                Brokerage Payments
              </h2>
              <button
                onClick={() => setShowPaymentForm(!showPaymentForm)}
                className="px-4 py-2 rounded-lg font-medium text-white transition"
                style={{ background: '#06B6D4' }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
              >
                {showPaymentForm ? 'Cancel' : 'Record Payment'}
              </button>
            </div>

            {showPaymentForm && (
              <div className="mb-6 p-4 rounded-lg" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}` }}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: colors.textPrimary }}>Amount (CAD)</label>
                    <input
                      type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)}
                      placeholder="0.00" step="0.01"
                      className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none"
                      style={{ background: colors.cardBg, borderColor: colors.inputBorder, color: colors.inputText }}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: colors.textPrimary }}>Date Received</label>
                    <input
                      type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none"
                      style={{ background: colors.cardBg, borderColor: colors.inputBorder, color: colors.inputText, colorScheme: 'dark' }}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: colors.textPrimary }}>Method</label>
                    <select
                      value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none"
                      style={{ background: colors.cardBg, borderColor: colors.inputBorder, color: colors.inputText }}
                    >
                      <option value="">Select...</option>
                      <option value="eft">EFT</option>
                      <option value="cheque">Cheque</option>
                      <option value="wire">Wire Transfer</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: colors.textPrimary }}>Reference</label>
                    <input
                      type="text" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)}
                      placeholder="Cheque #, ref..."
                      className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none"
                      style={{ background: colors.cardBg, borderColor: colors.inputBorder, color: colors.inputText }}
                    />
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (!paymentAmount || !paymentDate) return
                    setPaymentSaving(true)
                    const result = await recordBrokeragePayment({
                      dealId: deal.id,
                      amount: parseFloat(paymentAmount),
                      date: paymentDate,
                      reference: paymentReference.trim() || undefined,
                      method: paymentMethod || undefined,
                    })
                    if (result.success) {
                      setDeal(prev => prev ? { ...prev, ...result.data } : null)
                      setPaymentAmount(''); setPaymentReference(''); setPaymentMethod('')
                      setPaymentDate(new Date().toISOString().split('T')[0])
                      setShowPaymentForm(false)
                      setStatusMessage({ type: 'success', text: 'Brokerage payment recorded' })
                    } else {
                      setStatusMessage({ type: 'error', text: result.error || 'Failed to record payment' })
                    }
                    setPaymentSaving(false)
                  }}
                  disabled={paymentSaving || !paymentAmount || !paymentDate}
                  className="px-4 py-2 rounded-lg font-medium text-white disabled:opacity-50 transition-colors"
                  style={{ background: '#0D7A5F' }}
                  onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#0A6A4F' }}
                  onMouseLeave={(e) => e.currentTarget.style.background = '#0D7A5F'}
                >
                  Record Payment
                </button>
              </div>
            )}

            {/* PAYMENT TOTAL TRACKER */}
            {(() => {
              const payTotal = (deal.brokerage_payments || []).reduce((sum, p) => sum + p.amount, 0)
              const expected = deal.amount_due_from_brokerage
              const diff = expected - payTotal
              const isMatch = Math.abs(diff) < 0.01 && payTotal > 0
              const isOver = payTotal > expected + 0.01
              return (deal.brokerage_payments && deal.brokerage_payments.length > 0) ? (
                <div className="mb-4 p-3 rounded-lg flex items-center justify-between text-sm" style={{
                  background: isMatch ? 'rgba(95,168,115,0.1)' : isOver ? 'rgba(224,123,123,0.1)' : 'rgba(212,160,74,0.1)',
                  border: `1px solid ${isMatch ? '#5FA873' : isOver ? '#E07B7B' : '#D4A04A'}`,
                }}>
                  <div>
                    <span style={{ color: colors.textMuted }}>Received: </span>
                    <span className="font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(payTotal)}</span>
                    <span style={{ color: colors.textMuted }}> / Expected: </span>
                    <span className="font-bold" style={{ color: colors.textPrimary }}>{formatCurrency(expected)}</span>
                  </div>
                  <span className="font-semibold" style={{ color: isMatch ? '#5FA873' : isOver ? '#E07B7B' : '#D4A04A' }}>
                    {isMatch ? '✓ Ready to mark Repaid' : isOver ? `Over by ${formatCurrency(payTotal - expected)}` : `Outstanding: ${formatCurrency(diff)}`}
                  </span>
                </div>
              ) : (
                <p className="mb-4 text-sm" style={{ color: colors.textMuted }}>
                  Expected from brokerage: <strong style={{ color: colors.textPrimary }}>{formatCurrency(deal.amount_due_from_brokerage)}</strong> — no payments recorded yet
                </p>
              )
            })()}

            {/* PAYMENT LIST */}
            {deal.brokerage_payments && deal.brokerage_payments.length > 0 && (
              <div className="space-y-3">
                {deal.brokerage_payments.map((payment, idx) => (
                  <div key={idx} className="flex items-center justify-between p-4 rounded-lg" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}` }}>
                    <div>
                      <p className="font-semibold" style={{ color: colors.textPrimary }}>{formatCurrency(payment.amount)}</p>
                      <p className="text-sm" style={{ color: colors.textMuted }}>
                        {formatDate(payment.date)}
                        {payment.method ? ` • ${payment.method.charAt(0).toUpperCase() + payment.method.slice(1)}` : ''}
                        {payment.reference ? ` • Ref: ${payment.reference}` : ''}
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!confirm('Remove this payment?')) return
                        const result = await removeBrokeragePayment({ dealId: deal.id, paymentIndex: idx })
                        if (result.success) {
                          setDeal(prev => prev ? { ...prev, ...result.data } : null)
                          setStatusMessage({ type: 'success', text: 'Payment removed' })
                        } else {
                          setStatusMessage({ type: 'error', text: result.error || 'Failed to remove payment' })
                        }
                      }}
                      className="p-2 rounded-lg transition"
                      style={{ color: colors.textMuted }}
                      onMouseEnter={(e) => e.currentTarget.style.color = '#E07B7B'}
                      onMouseLeave={(e) => e.currentTarget.style.color = colors.textMuted}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* MAIN CONTENT GRID - Deal Details, Financial, Admin Notes (left 2/3) + Agent/Brokerage (right 1/3) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <div className="lg:col-span-2 space-y-4">
            {/* DEAL DETAILS */}
            <div className="rounded-lg p-4" style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
            }}>
              <h2 className="text-sm font-bold mb-3 flex items-center gap-2" style={{ color: colors.textPrimary }}>
                <FileText className="w-4 h-4" style={{ color: colors.gold }} />
                Deal Details
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Property Address</p>
                  <p className="text-sm font-medium flex items-start gap-1" style={{ color: colors.textPrimary }}>
                    <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    {deal.property_address}
                  </p>
                </div>
                <div>
                  <p className="text-xs flex items-center gap-1" style={{ color: colors.textMuted }}>
                    Closing Date
                    {!editingClosingDate && (deal.status === 'under_review' || deal.status === 'approved' || deal.status === 'funded') && (
                      <button onClick={() => { setEditingClosingDate(true); setNewClosingDate(deal.closing_date); setClosingDateComparison(null) }}
                        className="p-0.5 rounded transition-colors" style={{ color: colors.textFaint }}
                        onMouseEnter={(e) => e.currentTarget.style.color = colors.gold}
                        onMouseLeave={(e) => e.currentTarget.style.color = colors.textFaint}
                        title="Edit closing date"
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                    )}
                  </p>
                  {editingClosingDate ? (
                    <div className="space-y-2 mt-1">
                      <input
                        type="date" value={newClosingDate}
                        onChange={(e) => setNewClosingDate(e.target.value)}
                        min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                        className="w-full rounded px-2 py-1 text-sm outline-none"
                        style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText, colorScheme: 'dark' }}
                      />
                      <div className="flex gap-1.5">
                        <button onClick={handleUpdateClosingDate} disabled={closingDateSaving || newClosingDate === deal.closing_date}
                          className="px-2 py-1 rounded text-xs font-medium text-white disabled:opacity-50 transition-colors"
                          style={{ background: colors.gold }}>
                          {closingDateSaving ? 'Saving...' : 'Update & Recalc'}
                        </button>
                        <button onClick={() => { setEditingClosingDate(false); setClosingDateComparison(null) }}
                          className="px-2 py-1 rounded text-xs transition-colors"
                          style={{ color: colors.textMuted, border: `1px solid ${colors.border}` }}>
                          Cancel
                        </button>
                      </div>
                      {closingDateComparison && (
                        <div className="rounded-lg p-2 text-xs space-y-1" style={{ background: colors.infoBg, border: `1px solid ${colors.infoBorder}` }}>
                          <p className="font-semibold" style={{ color: colors.infoText }}>Recalculation complete:</p>
                          <p style={{ color: colors.infoText }}>Days: {closingDateComparison.old.days_until_closing} → {closingDateComparison.new.days_until_closing}</p>
                          <p style={{ color: colors.infoText }}>Discount Fee: ${closingDateComparison.old.discount_fee.toFixed(2)} → ${closingDateComparison.new.discount_fee.toFixed(2)}</p>
                          <p style={{ color: colors.infoText }}>Advance: ${closingDateComparison.old.advance_amount.toFixed(2)} → ${closingDateComparison.new.advance_amount.toFixed(2)}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{formatDate(deal.closing_date)}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Days Until Closing</p>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{deal.days_until_closing} days</p>
                </div>
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Source</p>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{deal.source}</p>
                </div>
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Created</p>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{formatDateTime(deal.created_at)}</p>
                </div>
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Last Updated</p>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{formatDateTime(deal.updated_at)}</p>
                </div>
              </div>
              {deal.denial_reason && (
                <div className="mt-3 p-2 rounded" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}` }}>
                  <p className="text-xs font-medium" style={{ color: colors.errorText }}>Denial Reason</p>
                  <p className="text-sm mt-1" style={{ color: colors.errorText }}>{deal.denial_reason}</p>
                </div>
              )}
            </div>

            {/* FINANCIAL BREAKDOWN */}
            <div className="rounded-lg p-4" style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
            }}>
              <h2 className="text-sm font-bold mb-2 flex items-center gap-2" style={{ color: colors.textPrimary }}>
                <DollarSign className="w-4 h-4" style={{ color: colors.gold }} />
                Financial Breakdown
              </h2>
              <div className="space-y-1">
                <div className="flex justify-between py-1.5 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <span style={{ color: colors.textMuted }}>Gross Commission</span>
                  <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.gross_commission)}</span>
                </div>
                <div className="flex justify-between py-1.5 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <span style={{ color: colors.textMuted }}>Brokerage Split</span>
                  <span className="font-medium" style={{ color: colors.textPrimary }}>{deal.brokerage_split_pct}%</span>
                </div>
                <div className="flex justify-between py-1.5 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <span style={{ color: colors.textMuted }}>Net Commission</span>
                  <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.net_commission)}</span>
                </div>
                <div className="flex justify-between py-1.5 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <span style={{ color: colors.textMuted }}>Discount Fee</span>
                  <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.discount_fee)}</span>
                </div>
                <div className="flex justify-between py-1.5 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <span style={{ color: colors.textMuted }}>Advance Amount</span>
                  <span className="font-bold" style={{ color: colors.gold }}>{formatCurrency(deal.advance_amount)}</span>
                </div>
                <div className="flex justify-between py-1.5 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <span style={{ color: colors.textMuted }}>Brokerage Referral Fee</span>
                  <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(deal.brokerage_referral_fee)}</span>
                </div>
                <div className="flex justify-between rounded px-2 py-1.5 text-sm mt-1" style={{ background: colors.goldBg }}>
                  <span className="font-semibold" style={{ color: colors.gold }}>Amount Due from Brokerage</span>
                  <span className="font-bold" style={{ color: colors.gold }}>{formatCurrency(deal.amount_due_from_brokerage)}</span>
                </div>
                {(() => {
                  const brokerageTotal = (deal.brokerage_payments || []).reduce((sum, p) => sum + p.amount, 0)
                  if (brokerageTotal <= 0) return null
                  const isFullyPaid = Math.abs(brokerageTotal - deal.amount_due_from_brokerage) < 0.01
                  const isOver = brokerageTotal > deal.amount_due_from_brokerage + 0.01
                  const statusColor = isFullyPaid ? '#5FA873' : isOver ? '#E07B7B' : '#D4A04A'
                  return (
                    <div className="flex justify-between rounded px-2 py-1.5 text-sm mt-1" style={{
                      background: isFullyPaid ? 'rgba(95,168,115,0.1)' : isOver ? 'rgba(224,123,123,0.1)' : 'rgba(212,160,74,0.15)',
                    }}>
                      <span className="font-semibold" style={{ color: statusColor }}>
                        Brokerage Payments ({(deal.brokerage_payments || []).length})
                      </span>
                      <span className="font-bold" style={{ color: statusColor }}>
                        {formatCurrency(brokerageTotal)}
                      </span>
                    </div>
                  )
                })()}
              </div>
            </div>

            {/* ADMIN NOTES TIMELINE */}
            <div className="rounded-lg p-4" style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
            }}>
              <h2 className="text-sm font-bold mb-3 flex items-center gap-2" style={{ color: colors.textPrimary }}>
                <StickyNote className="w-4 h-4" style={{ color: colors.gold }} />
                Admin Notes
              </h2>

              {/* Add new note */}
              <div className="flex gap-2 mb-3">
                <textarea
                  value={newNoteText}
                  onChange={(e) => setNewNoteText(e.target.value)}
                  placeholder="Add a note..."
                  className="flex-1 px-3 py-2 rounded border text-sm resize-none focus:outline-none"
                  style={{
                    background: colors.inputBg,
                    borderColor: colors.inputBorder,
                    color: colors.inputText,
                    minHeight: '60px',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAddNote()
                  }}
                />
              </div>
              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={handleAddNote}
                  disabled={addingNote || !newNoteText.trim()}
                  className="px-3 py-1.5 rounded text-sm font-medium text-white disabled:opacity-50 transition-colors flex items-center gap-1.5"
                  style={{ background: '#3D5A99' }}
                  onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = '#2D4A89' }}
                  onMouseLeave={(e) => e.currentTarget.style.background = '#3D5A99'}
                >
                  <Plus className="w-3.5 h-3.5" />
                  {addingNote ? 'Adding...' : 'Add Note'}
                </button>
                <span className="text-xs" style={{ color: colors.textFaint }}>Ctrl+Enter to submit</span>
              </div>

              {/* Timeline */}
              {notesTimeline.length > 0 ? (
                <div className="space-y-2 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                  {[...notesTimeline].reverse().map((note) => (
                    <div key={note.id} className="rounded-lg px-3 py-2.5" style={{ background: colors.tableHeaderBg, border: `1px solid ${colors.divider}` }}>
                      <p className="text-sm whitespace-pre-wrap" style={{ color: colors.textPrimary }}>{note.text}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Clock className="w-3 h-3" style={{ color: colors.textFaint }} />
                        <span className="text-xs" style={{ color: colors.textMuted }}>{note.author_name} &bull; {formatDateTime(note.created_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-center py-2" style={{ color: colors.textMuted }}>No notes yet</p>
              )}

              {/* Legacy notes (read-only, if present) */}
              {adminNotes && (
                <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${colors.divider}` }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Legacy Notes</p>
                  <p className="text-xs whitespace-pre-wrap" style={{ color: colors.textFaint }}>{adminNotes}</p>
                </div>
              )}
            </div>
          </div>

          {/* AGENT & BROKERAGE CARDS (right 1/3) */}
          <div className="space-y-4">
            {/* AGENT CARD */}
            <div className="rounded-lg p-4" style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
            }}>
              <h3 className="text-sm font-bold mb-2 flex items-center gap-2" style={{ color: colors.textPrimary }}>
                <User className="w-4 h-4" style={{ color: colors.gold }} />
                Agent
              </h3>
              <div className="space-y-1.5">
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Name</p>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{agent.first_name} {agent.last_name}</p>
                </div>
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Email</p>
                  <p className="text-sm font-medium break-all" style={{ color: colors.textPrimary }}>{agent.email}</p>
                </div>
                {agent.phone && (
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>Phone</p>
                    <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{agent.phone}</p>
                  </div>
                )}
                {agent.reco_number && (
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>RECO #</p>
                    <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{agent.reco_number}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Status</p>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{agent.status}</p>
                </div>
                {agent.flagged_by_brokerage && (
                  <div className="px-2 py-1 rounded" style={{ background: colors.warningBg }}>
                    <p className="text-xs font-medium" style={{ color: colors.warningText }}>Flagged by Brokerage</p>
                  </div>
                )}
                {agent.outstanding_recovery !== null && agent.outstanding_recovery > 0 && (
                  <div className="px-2 py-1 rounded" style={{ background: colors.errorBg }}>
                    <p className="text-xs font-medium" style={{ color: colors.errorText }}>Recovery: {formatCurrency(agent.outstanding_recovery)}</p>
                  </div>
                )}
              </div>
            </div>

            {/* BROKERAGE CARD */}
            <div className="rounded-lg p-4" style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
            }}>
              <h3 className="text-sm font-bold mb-2 flex items-center gap-2" style={{ color: colors.textPrimary }}>
                <Building2 className="w-4 h-4" style={{ color: colors.gold }} />
                Brokerage
              </h3>
              <div className="space-y-1.5">
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Name</p>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{brokerage.name}</p>
                </div>
                {brokerage.brand && (
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>Brand</p>
                    <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{brokerage.brand}</p>
                  </div>
                )}
                {brokerage.address && (
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>Address</p>
                    <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{brokerage.address}</p>
                  </div>
                )}
                {brokerage.phone && (
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>Phone</p>
                    <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{brokerage.phone}</p>
                  </div>
                )}
                {brokerage.email && (
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>Email</p>
                    <p className="text-sm font-medium break-all" style={{ color: colors.textPrimary }}>{brokerage.email}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs" style={{ color: colors.textMuted }}>Status</p>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{brokerage.status}</p>
                </div>
                {brokerage.referral_fee_percentage !== null && (
                  <div>
                    <p className="text-xs" style={{ color: colors.textMuted }}>Referral Fee %</p>
                    <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{brokerage.referral_fee_percentage}%</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* UNDERWRITING SECTION - FULL WIDTH, 2-COLUMN (CHECKLIST LEFT, DOCS RIGHT) */}
        <div className="mb-4">
          <h2 className="text-sm font-bold mb-3" style={{ color: colors.textPrimary }}>Underwriting</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* LEFT: CHECKLIST */}
            <div className="space-y-2">
              {categorizedChecklist.map((category, catIdx) => (
                <div key={catIdx} className="rounded-lg overflow-hidden" style={{
                  background: colors.cardBg,
                  border: `1px solid ${colors.border}`,
                }}>
                  <button
                    onClick={() => setChecklistExpanded(!checklistExpanded)}
                    className="w-full px-4 py-2.5 flex items-center justify-between text-sm font-semibold transition"
                    style={{ background: category.bg, color: category.color, borderBottom: `1px solid ${category.border}` }}
                  >
                    <div className="flex items-center gap-2">
                      <category.icon className="w-4 h-4" />
                      {category.label}
                      <span className="ml-1 text-xs font-normal" style={{ opacity: 0.7 }}>({category.items.filter(i => i.is_checked).length}/{category.items.length})</span>
                    </div>
                    {checklistExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>

                  {checklistExpanded && (
                    <div>
                      {category.items.map(item => {
                        const matchingDocs = category.matchingDocs.get(item.id) || []
                        const checked = item.is_checked
                        return (
                          <div
                            key={item.id}
                            onClick={() => handleChecklistToggle(item)}
                            className="flex items-start gap-3 px-4 py-3 cursor-pointer transition-all duration-200 select-none"
                            style={{
                              borderBottom: `1px solid ${colors.divider}`,
                              background: checked ? `${colors.gold}08` : 'transparent',
                            }}
                            onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = `${colors.gold}0D` }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = checked ? `${colors.gold}08` : 'transparent' }}
                          >
                            <div className="flex-shrink-0 mt-0.5 transition-transform duration-200" style={{ transform: checked ? 'scale(1.1)' : 'scale(1)' }}>
                              {checked ? (
                                <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: colors.gold }}>
                                  <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                                </div>
                              ) : (
                                <div className="w-5 h-5 rounded-full border-2 transition-colors" style={{ borderColor: colors.textMuted }} />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm transition-colors duration-200" style={{
                                color: checked ? colors.textMuted : colors.textPrimary,
                                fontWeight: checked ? 400 : 500,
                              }}>
                                {item.checklist_item}
                              </p>
                              {item.checked_at && (
                                <p className="text-xs mt-0.5" style={{ color: colors.textFaint }}>
                                  Completed {formatDateTime(item.checked_at)}
                                </p>
                              )}
                              {matchingDocs.length > 0 && (
                                <div className="mt-1.5 space-y-0.5">
                                  {matchingDocs.map(doc => (
                                    <a
                                      key={doc.id}
                                      onClick={(e) => { e.stopPropagation(); handleDocumentDownload(doc) }}
                                      className="text-xs flex items-center gap-1.5 cursor-pointer transition"
                                      style={{ color: colors.gold }}
                                      onMouseEnter={(e) => e.currentTarget.style.opacity = '0.7'}
                                      onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                                    >
                                      <FileText className="w-3 h-3" />
                                      {doc.file_name}
                                    </a>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* RIGHT: DOCUMENTS */}
            <div className="rounded-lg overflow-hidden" style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
            }}>
              <div className="px-4 py-2.5 flex items-center justify-between"
                style={{ background: colors.goldBg, borderBottom: `1px solid ${colors.gold}` }}>
                <button
                  onClick={() => setDocsExpanded(!docsExpanded)}
                  className="flex items-center gap-2 text-sm font-semibold transition"
                  style={{ color: colors.gold }}
                >
                  <Paperclip className="w-4 h-4" />
                  Documents
                  <span className="ml-1 text-xs font-normal" style={{ opacity: 0.7 }}>({documents.length})</span>
                  {docsExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => setShowDocRequest(!showDocRequest)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: colors.gold, color: '#FFFFFF' }}
                  onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                  onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                >
                  <Send className="w-3.5 h-3.5" />
                  Request Doc
                </button>
              </div>

              {/* DOCUMENT REQUEST FORM */}
              {showDocRequest && (
                <div className="px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}`, background: colors.inputBg }}>
                  <p className="text-sm font-semibold mb-3" style={{ color: colors.textPrimary }}>
                    Request a document from {agent?.first_name || 'agent'}
                  </p>
                  <div className="mb-3">
                    <label className="block text-xs font-medium mb-1" style={{ color: colors.textMuted }}>Document Type</label>
                    <select
                      value={docRequestType}
                      onChange={(e) => setDocRequestType(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border text-sm focus:outline-none"
                      style={{
                        background: colors.cardBg,
                        borderColor: colors.inputBorder,
                        color: colors.inputText,
                      }}
                    >
                      <option value="">Select document type...</option>
                      {DOCUMENT_TYPES.map(dt => (
                        <option key={dt.value} value={dt.value}>{dt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mb-3">
                    <label className="block text-xs font-medium mb-1" style={{ color: colors.textMuted }}>Message (optional)</label>
                    <textarea
                      value={docRequestMessage}
                      onChange={(e) => setDocRequestMessage(e.target.value)}
                      placeholder="Add any instructions or context for the agent..."
                      className="w-full px-3 py-2 rounded-lg border text-sm resize-none focus:outline-none"
                      style={{
                        background: colors.cardBg,
                        borderColor: colors.inputBorder,
                        color: colors.inputText,
                        minHeight: '60px',
                      }}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleRequestDocument}
                      disabled={docRequestSending || !docRequestType}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-white disabled:opacity-50 transition-colors"
                      style={{ background: colors.gold }}
                      onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.opacity = '0.9' }}
                      onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                    >
                      <Send className="w-4 h-4" />
                      {docRequestSending ? 'Sending...' : 'Send Request'}
                    </button>
                    <button
                      onClick={() => { setShowDocRequest(false); setDocRequestType(''); setDocRequestMessage('') }}
                      className="px-4 py-2 rounded-lg font-medium transition"
                      style={{ background: colors.border, color: colors.textPrimary }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* PENDING DOCUMENT REQUESTS */}
              {docsExpanded && docRequests.some(r => r.status === 'pending') && (
                <div className="px-6 py-4 border-l-4" style={{
                  borderLeftColor: '#5FA873',
                  background: isDark ? 'rgba(95, 168, 115, 0.08)' : 'rgba(95, 168, 115, 0.05)',
                  borderBottom: `1px solid ${colors.border}`
                }}>
                  <p className="text-sm font-semibold mb-3" style={{ color: colors.textPrimary }}>
                    Pending Requests ({docRequests.filter(r => r.status === 'pending').length})
                  </p>
                  <div className="space-y-3">
                    {docRequests.filter(r => r.status === 'pending').map(request => (
                      <div key={request.id} className="rounded-lg p-3" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
                        <div className="flex items-start gap-3 mb-2">
                          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#5FA873' }} />
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm" style={{ color: colors.textPrimary }}>
                              {getDocTypeLabel(request.document_type)}
                            </p>
                            {request.message && (
                              <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                                {request.message}
                              </p>
                            )}
                            <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                              Requested {formatDate(request.created_at)}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 ml-7">
                          <button
                            onClick={() => handleFulfillRequest(request)}
                            className="flex items-center gap-1 px-3 py-1 rounded text-xs font-medium transition-colors"
                            style={{ background: '#5FA873', color: '#FFFFFF' }}
                            onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                            onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Mark Fulfilled
                          </button>
                          <button
                            onClick={() => handleCancelRequest(request)}
                            className="flex items-center gap-1 px-3 py-1 rounded text-xs font-medium transition"
                            style={{ background: colors.border, color: colors.textMuted }}
                            onMouseEnter={(e) => e.currentTarget.style.opacity = '0.7'}
                            onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            Cancel
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {docsExpanded && (
                <div className="divide-y max-h-96 overflow-y-auto" style={{ borderColor: colors.border }}>
                  {documents.length > 0 ? (
                    documents.map(doc => (
                      <div key={doc.id} className="px-4 py-2 flex items-center gap-3">
                        <FileText className="w-4 h-4 flex-shrink-0" style={{ color: colors.gold }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" style={{ color: colors.textPrimary }}>{doc.file_name}</p>
                          <p className="text-xs" style={{ color: colors.textMuted }}>
                            {getDocTypeLabel(doc.document_type)} • {formatFileSize(doc.file_size)} • {formatDate(doc.created_at)}
                          </p>
                        </div>
                        <div className="flex gap-1.5 flex-shrink-0">
                          {(() => {
                            const ext = doc.file_name.toLowerCase().split('.').pop() || ''
                            const isViewable = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
                            return isViewable ? (
                              <button
                                onClick={() => handleDocumentView(doc)}
                                disabled={viewLoading === doc.id}
                                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition"
                                style={{ background: colors.gold, color: '#fff', opacity: viewLoading === doc.id ? 0.6 : 1 }}
                                onMouseEnter={(e) => { if (viewLoading !== doc.id) e.currentTarget.style.background = colors.goldDark }}
                                onMouseLeave={(e) => e.currentTarget.style.background = colors.gold}
                              >
                                <Eye className="w-3 h-3" />
                                {viewLoading === doc.id ? '...' : 'View'}
                              </button>
                            ) : null
                          })()}
                          <button
                            onClick={() => handleDocumentDownload(doc)}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition"
                            style={{ background: colors.inputBg, color: colors.gold }}
                            onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                            onMouseLeave={(e) => e.currentTarget.style.background = colors.inputBg}
                          >
                            <Download className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleDocumentDelete(doc)}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition"
                            style={{ background: colors.errorBg, color: colors.errorText }}
                            onMouseEnter={(e) => e.currentTarget.style.opacity = '0.8'}
                            onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center">
                      <p className="text-sm" style={{ color: colors.textMuted }}>No documents uploaded yet</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* DELETE DEAL (only for under_review, cancelled, or denied) */}
        {deal && ['under_review', 'cancelled', 'denied'].includes(deal.status) && (
          <div className="mt-6 rounded-lg p-4" style={{ background: colors.cardBg, border: `1px solid ${colors.errorBorder}` }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold" style={{ color: colors.errorText }}>Delete This Deal</p>
                <p className="text-xs mt-0.5" style={{ color: colors.textMuted }}>Permanently removes this deal and all associated documents and checklist items. This cannot be undone.</p>
              </div>
              <button
                onClick={async () => {
                  if (!confirm('Are you SURE you want to permanently delete this deal? This cannot be undone.')) return
                  if (!confirm('This will delete the deal, all uploaded documents, and all checklist data. Last chance — proceed?')) return
                  const result = await deleteDeal({ dealId: deal.id })
                  if (result.success) {
                    router.push('/admin')
                  } else {
                    setStatusMessage({ type: 'error', text: result.error || 'Failed to delete deal' })
                  }
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors flex items-center gap-1.5 shrink-0"
                style={{ background: '#DC2626' }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#B91C1C'}
                onMouseLeave={(e) => e.currentTarget.style.background = '#DC2626'}
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete Deal
              </button>
            </div>
          </div>
        )}

      </main>
      </div>{/* end of content area that shrinks */}

      {/* Document Side Panel — sits beside main content, not on top */}
      {viewingDoc && (
        <div
          className="fixed top-0 right-0 z-30 h-full flex flex-col shadow-xl"
          style={{
            width: docPanelWidth,
            background: colors.cardBg,
            borderLeft: `2px solid ${colors.gold}`,
            animation: 'slideInRight 0.2s ease-out',
          }}
        >
          {/* Panel Header */}
          <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={14} style={{ color: colors.gold }} />
              <p className="text-xs font-semibold truncate" style={{ color: colors.textPrimary }}>{viewingDoc.fileName}</p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => window.open(viewingDoc.originalUrl, '_blank')}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition"
                style={{ background: colors.inputBg, color: colors.gold, border: `1px solid ${colors.border}` }}
                onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                onMouseLeave={(e) => e.currentTarget.style.background = colors.inputBg}
                title="Open in new tab"
              >
                <ExternalLink size={11} />
              </button>
              <button
                onClick={() => window.open(viewingDoc.originalUrl, '_blank')}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition"
                style={{ background: colors.inputBg, color: colors.textSecondary, border: `1px solid ${colors.border}` }}
                onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                onMouseLeave={(e) => e.currentTarget.style.background = colors.inputBg}
                title="Download"
              >
                <Download size={11} />
              </button>
              <button
                onClick={closeDocViewer}
                className="p-1 rounded transition"
                style={{ color: colors.textMuted }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.errorBg; e.currentTarget.style.color = colors.errorText }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textMuted }}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          {/* Panel Content */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {viewingDoc.type === 'image' ? (
              <div className="flex items-center justify-center p-3">
                <img
                  src={viewingDoc.blobUrl}
                  alt={viewingDoc.fileName}
                  className="max-w-full rounded-lg"
                  style={{ maxHeight: 'calc(100vh - 60px)', objectFit: 'contain' }}
                />
              </div>
            ) : viewingDoc.pdfData ? (
              <PdfCanvasViewer pdfData={viewingDoc.pdfData} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
                <p style={{ color: colors.textSecondary }} className="text-sm text-center">
                  Unable to render PDF.
                </p>
                <button
                  onClick={() => window.open(viewingDoc.originalUrl, '_blank')}
                  className="px-4 py-2 rounded text-sm font-medium"
                  style={{ backgroundColor: colors.gold, color: '#fff' }}
                >
                  Open in New Tab
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}
