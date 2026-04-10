'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/formatting'
import {
  ArrowLeft, CheckCircle2, Circle, FileText, DollarSign, MapPin,
  User, Building2, AlertTriangle, XCircle, Shield, ChevronDown,
  ChevronUp, Banknote, RefreshCw, Trash2, Download, Paperclip,
  StickyNote, AlertCircle, Undo2, Send, Eye, X, Plus, Clock, Edit2, ExternalLink, GripVertical, Link2, Unlink, Zap, FileSignature
} from 'lucide-react'
import {
  updateDealStatus,
  toggleChecklistItem as serverToggleChecklistItem,
  toggleChecklistItemNA as serverToggleChecklistItemNA,
  deleteDocument as serverDeleteDocument,
  saveAdminNotes,
  addAdminNote,
  updateClosingDate,
  requestDocument,
  fulfillDocumentRequest,
  cancelDocumentRequest,
  deleteDeal,
  linkDocumentToChecklist,
} from '@/lib/actions/deal-actions'
import {
  sendDealMessage,
  returnDocument,
  chargeLatePaymentInterest,
} from '@/lib/actions/account-actions'
import { dismissDealMessages } from '@/lib/actions/notification-actions'
import { recordEftTransfer, confirmEftTransfer, removeEftTransfer, recordBrokeragePayment, removeBrokeragePayment } from '@/lib/actions/admin-actions'
import { sendForSignature, getDealSignatureStatus, voidDealEnvelopes } from '@/lib/actions/esign-actions'
import { getDealAmendments, approveClosingDateAmendment, rejectClosingDateAmendment } from '@/lib/actions/amendment-actions'
import type { EsignatureEnvelope } from '@/types/database'
import { getStatusBadgeClass, ADMIN_QUICK_REPLIES, calcDaysUntilClosing, DISCOUNT_RATE_PER_1000_PER_DAY, MAX_DAILY_EFT, RETURN_PROCESSING_DAYS } from '@/lib/constants'
import { calculateDeal } from '@/lib/calculations'
import SignOutModal from '@/components/SignOutModal'
import AuditTimeline from '@/components/AuditTimeline'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

// ============================================================================
// Drag-to-pan hook — click and drag to scroll a container when zoomed
// ============================================================================
function useDragToPan(scrollRef: React.RefObject<HTMLDivElement | null>, isZoomed: boolean) {
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startY = useRef(0)
  const scrollLeft = useRef(0)
  const scrollTop = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isZoomed || !scrollRef.current) return
    if (e.button !== 0) return
    isDragging.current = true
    startX.current = e.clientX
    startY.current = e.clientY
    scrollLeft.current = scrollRef.current.scrollLeft
    scrollTop.current = scrollRef.current.scrollTop
    scrollRef.current.style.cursor = 'grabbing'
    scrollRef.current.style.userSelect = 'none'
    e.preventDefault()
  }, [isZoomed, scrollRef])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current || !scrollRef.current) return
    const dx = e.clientX - startX.current
    const dy = e.clientY - startY.current
    scrollRef.current.scrollLeft = scrollLeft.current - dx
    scrollRef.current.scrollTop = scrollTop.current - dy
  }, [scrollRef])

  const onMouseUp = useCallback(() => {
    if (!isDragging.current || !scrollRef.current) return
    isDragging.current = false
    scrollRef.current.style.cursor = isZoomed ? 'grab' : 'default'
    scrollRef.current.style.userSelect = ''
  }, [isZoomed, scrollRef])

  return { onMouseDown, onMouseMove, onMouseUp, onMouseLeave: onMouseUp }
}

// ============================================================================
// PDF Canvas Viewer — renders PDFs via pdf.js 3.x (CDN) to canvas
// ============================================================================
const PDFJS_VERSION = '3.11.174'
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`

function loadPdfJs(): Promise<any> {
  if ((window as any).pdfjsLib) return Promise.resolve((window as any).pdfjsLib)
  if ((window as any)._pdfjsLoading) return (window as any)._pdfjsLoading

  const promise = new Promise<any>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${PDFJS_CDN}/pdf.min.js`
    script.onload = () => {
      const lib = (window as any).pdfjsLib
      if (!lib) { reject(new Error('pdfjsLib not found after script load')); return }
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`
      resolve(lib)
    }
    script.onerror = () => reject(new Error('Failed to load pdf.js from CDN'))
    document.head.appendChild(script)
  })

  ;(window as any)._pdfjsLoading = promise
  return promise
}

const ZOOM_LEVELS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3]
const DEFAULT_ZOOM_INDEX = 1

function PdfCanvasViewer({ pdfData }: { pdfData: ArrayBuffer }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<any>(null)
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading')
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX)
  const [numPages, setNumPages] = useState(0)
  const isZoomed = zoomIndex > DEFAULT_ZOOM_INDEX
  const dragHandlers = useDragToPan(containerRef, isZoomed)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const pdfjsLib = await loadPdfJs()
        if (cancelled) return
        const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise
        if (cancelled) return
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
        setStatus('done')
      } catch (err) {
        console.error('PDF load error:', err)
        if (!cancelled) setStatus('error')
      }
    }
    load()
    return () => { cancelled = true }
  }, [pdfData])

  useEffect(() => {
    if (status !== 'done' || !pdfRef.current || !containerRef.current) return
    let cancelled = false

    async function renderPages() {
      const pdf = pdfRef.current
      const container = containerRef.current
      if (!container) return

      const toRemove = container.querySelectorAll('canvas, .pdf-page-sep')
      toRemove.forEach((el: Element) => el.remove())

      const renderScale = 2
      const visualZoom = ZOOM_LEVELS[zoomIndex]
      const widthPct = (visualZoom / ZOOM_LEVELS[DEFAULT_ZOOM_INDEX]) * 100

      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) return
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale: renderScale })

        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.style.display = 'block'
        canvas.style.width = `${widthPct}%`
        canvas.style.height = 'auto'

        if (i > 1) {
          const sep = document.createElement('div')
          sep.className = 'pdf-page-sep'
          sep.style.height = '4px'
          sep.style.background = 'hsl(var(--border))'
          container.appendChild(sep)
        }
        container.appendChild(canvas)

        const ctx = canvas.getContext('2d')!
        await page.render({ canvasContext: ctx, viewport }).promise
      }
    }

    renderPages()
    return () => { cancelled = true }
  }, [status, zoomIndex])

  const zoomIn = () => setZoomIndex(i => Math.min(i + 1, ZOOM_LEVELS.length - 1))
  const zoomOut = () => setZoomIndex(i => Math.max(i - 1, 0))
  const zoomPct = Math.round(ZOOM_LEVELS[zoomIndex] * 100)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        if (e.deltaY < 0) setZoomIndex(i => Math.min(i + 1, ZOOM_LEVELS.length - 1))
        else setZoomIndex(i => Math.max(i - 1, 0))
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [status])

  if (status === 'error') {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <p className="text-destructive text-sm">Failed to render PDF</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Zoom toolbar */}
      {status === 'done' && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 border-b border-border/50 bg-card flex-shrink-0">
          <button
            onClick={zoomOut}
            disabled={zoomIndex === 0}
            className="w-7 h-7 rounded-md border border-border/50 bg-muted flex items-center justify-center text-base font-bold disabled:opacity-30 disabled:cursor-not-allowed text-foreground hover:bg-muted/80 transition-colors"
          >−</button>
          <span className="text-muted-foreground text-xs font-semibold min-w-[40px] text-center">
            {zoomPct}%
          </span>
          <button
            onClick={zoomIn}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            className="w-7 h-7 rounded-md border border-border/50 bg-muted flex items-center justify-center text-base font-bold disabled:opacity-30 disabled:cursor-not-allowed text-foreground hover:bg-muted/80 transition-colors"
          >+</button>
          {numPages > 0 && (
            <span className="text-muted-foreground/60 text-[11px] ml-2">
              {numPages} page{numPages > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
      {/* Scrollable PDF content — drag to pan when zoomed, Ctrl+scroll to zoom */}
      <div
        ref={containerRef}
        {...dragHandlers}
        className="flex-1 overflow-auto p-0"
        style={{ cursor: isZoomed ? 'grab' : 'default' }}
      >
        {status === 'loading' && (
          <div className="flex items-center justify-center p-8">
            <div className="w-8 h-8 border-[3px] border-border border-t-primary rounded-full animate-spin" />
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Image Zoom Viewer
// ============================================================================
function ImageZoomViewer({ src, alt }: { src: string; alt: string }) {
  const [zoomIndex, setZoomIndex] = useState(0)
  const imgZoomLevels = [1, 1.5, 2, 2.5, 3, 4]
  const imgScrollRef = useRef<HTMLDivElement>(null)
  const isImgZoomed = zoomIndex > 0
  const imgDragHandlers = useDragToPan(imgScrollRef, isImgZoomed)

  const zoomIn = () => setZoomIndex(i => Math.min(i + 1, imgZoomLevels.length - 1))
  const zoomOut = () => setZoomIndex(i => Math.max(i - 1, 0))
  const zoomPct = Math.round(imgZoomLevels[zoomIndex] * 100)
  const scale = imgZoomLevels[zoomIndex]

  useEffect(() => {
    const el = imgScrollRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        if (e.deltaY < 0) setZoomIndex(i => Math.min(i + 1, imgZoomLevels.length - 1))
        else setZoomIndex(i => Math.max(i - 1, 0))
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [src])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-center gap-2 px-3 py-1.5 border-b border-border/50 bg-card flex-shrink-0">
        <button
          onClick={zoomOut}
          disabled={zoomIndex === 0}
          className="w-7 h-7 rounded-md border border-border/50 bg-muted flex items-center justify-center text-base font-bold disabled:opacity-30 disabled:cursor-not-allowed text-foreground hover:bg-muted/80 transition-colors"
        >−</button>
        <span className="text-muted-foreground text-xs font-semibold min-w-[40px] text-center">
          {zoomPct}%
        </span>
        <button
          onClick={zoomIn}
          disabled={zoomIndex === imgZoomLevels.length - 1}
          className="w-7 h-7 rounded-md border border-border/50 bg-muted flex items-center justify-center text-base font-bold disabled:opacity-30 disabled:cursor-not-allowed text-foreground hover:bg-muted/80 transition-colors"
        >+</button>
      </div>
      <div
        ref={imgScrollRef}
        {...imgDragHandlers}
        className="flex-1 overflow-auto p-2"
        style={{ cursor: isImgZoomed ? 'grab' : 'default' }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{
            display: 'block',
            width: `${scale * 100}%`,
            maxWidth: 'none',
            height: 'auto',
            borderRadius: 8,
            transition: 'width 0.15s ease',
          }}
        />
      </div>
    </div>
  )
}

interface Deal {
  id: string; agent_id: string; brokerage_id: string; status: string
  property_address: string; closing_date: string; gross_commission: number
  brokerage_split_pct: number; net_commission: number; days_until_closing: number
  discount_fee: number; settlement_period_fee: number; advance_amount: number
  brokerage_referral_fee: number; brokerage_referral_pct: number | null
  amount_due_from_brokerage: number; balance_deducted: number
  due_date: string | null; payment_status: string
  funding_date: string | null
  repayment_date: string | null; repayment_amount: number | null
  eft_transfers: { amount: number; date: string; confirmed: boolean; reference?: string }[] | null
  brokerage_payments: { amount: number; date: string; reference?: string; method?: string }[] | null
  source: string; denial_reason: string | null
  notes: string | null; created_at: string; updated_at: string
  admin_notes: string | null
  admin_notes_timeline: { id: string; text: string; author_name: string; created_at: string }[] | null
  actual_closing_date: string | null
  late_interest_charged: number | null
}

interface DealMessage {
  id: string; deal_id: string; sender_id: string | null; sender_role: string
  sender_name: string | null; message: string; is_email_reply: boolean; created_at: string
}

interface DocumentReturn {
  id: string; deal_id: string; document_id: string; returned_by: string
  reason: string; status: string; created_at: string
}

interface ChecklistItem {
  id: string; deal_id: string; category: string; checklist_item: string; is_checked: boolean
  is_na: boolean; checked_by: string | null; checked_at: string | null; notes: string | null; sort_order: number
  linked_document_id: string | null
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
  approved: ['funded', 'denied', 'cancelled', 'under_review'], funded: ['completed', 'approved'],
  denied: ['under_review'], cancelled: ['under_review'], completed: ['funded'],
}

const BACKWARD_STATUSES: Record<string, string[]> = {
  approved: ['under_review'],
  funded: ['approved'],
  denied: ['under_review'],
  cancelled: ['under_review'],
  completed: ['funded'],
}

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted', under_review: 'Under Review', approved: 'Approved',
  funded: 'Funded', completed: 'Completed', denied: 'Denied', cancelled: 'Cancelled',
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

const CATEGORY_STYLES: Record<string, { icon: any; color: string; bg: string; border: string }> = {
  'Agent Verification': { icon: User, color: 'var(--checklist-purple)', bg: 'color-mix(in srgb, var(--action-purple) 15%, transparent)', border: 'color-mix(in srgb, var(--action-purple) 30%, transparent)' },
  'Deal Verification': { icon: FileText, color: 'var(--checklist-blue)', bg: 'color-mix(in srgb, var(--action-blue) 15%, transparent)', border: 'color-mix(in srgb, var(--action-blue) 30%, transparent)' },
  'Deal Document Review': { icon: FileText, color: 'var(--checklist-blue)', bg: 'color-mix(in srgb, var(--action-blue) 15%, transparent)', border: 'color-mix(in srgb, var(--action-blue) 30%, transparent)' },
  'Financial': { icon: DollarSign, color: 'var(--checklist-amber)', bg: 'color-mix(in srgb, var(--status-amber) 15%, transparent)', border: 'color-mix(in srgb, var(--status-amber) 30%, transparent)' },
  'Firm Fund Documents': { icon: Shield, color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 15%, transparent)', border: 'color-mix(in srgb, var(--primary) 30%, transparent)' },
  'Firm Funds Documents': { icon: Shield, color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 15%, transparent)', border: 'color-mix(in srgb, var(--primary) 30%, transparent)' },
}

const DEFAULT_CATEGORY_STYLE = { icon: FileText, color: 'var(--action-grey)', bg: 'color-mix(in srgb, var(--action-grey) 15%, transparent)', border: 'color-mix(in srgb, var(--action-grey) 30%, transparent)' }

const CATEGORY_ORDER = ['Agent Verification', 'Deal Verification', 'Firm Fund Documents']

function categorizeChecklist(items: ChecklistItem[]): ChecklistCategory[] {
  const grouped = new Map<string, ChecklistItem[]>()
  for (const item of items.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))) {
    const cat = item.category || 'Uncategorized'
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(item)
  }

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
  under_review: { label: 'Start Review', icon: RefreshCw, bg: 'var(--action-blue)', hoverBg: 'var(--action-blue-hover)' },
  approved:     { label: 'Approve Deal', icon: CheckCircle2, bg: 'var(--action-green)', hoverBg: 'var(--action-green-hover)' },
  funded:       { label: 'Mark as Funded', icon: Banknote, bg: 'var(--action-purple)', hoverBg: 'var(--action-purple-hover)' },
  completed:    { label: 'Mark Complete', icon: CheckCircle2, bg: 'var(--action-teal)', hoverBg: 'var(--action-teal-hover)' },
  denied:       { label: 'Deny Deal', icon: XCircle, bg: 'var(--action-red)', hoverBg: 'var(--action-red-hover)' },
  cancelled:    { label: 'Cancel Deal', icon: XCircle, bg: 'var(--action-grey)', hoverBg: 'var(--action-grey-hover)' },
}

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
  const [showFundingConfirmation, setShowFundingConfirmation] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  // E-Signature state
  const [esignEnvelopes, setEsignEnvelopes] = useState<EsignatureEnvelope[]>([])
  const [sendingForSignature, setSendingForSignature] = useState(false)
  const [voidingEnvelopes, setVoidingEnvelopes] = useState(false)
  // Closing date amendment state
  const [amendments, setAmendments] = useState<any[]>([])
  const [amendmentProcessing, setAmendmentProcessing] = useState<string | null>(null)
  const [rejectingAmendment, setRejectingAmendment] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [underwritingExpanded, setUnderwritingExpanded] = useState(true)
  const [checklistExpanded, setChecklistExpanded] = useState(true)
  const [docsExpanded, setDocsExpanded] = useState(true)
  const [auditExpanded, setAuditExpanded] = useState(false)
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
  // Messages
  const [messages, setMessages] = useState<DealMessage[]>([])
  const [showMessageForm, setShowMessageForm] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [messageSending, setMessageSending] = useState(false)
  const [showDealQuickReplies, setShowDealQuickReplies] = useState(false)
  const adminMessagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  // Document returns
  const [docReturns, setDocReturns] = useState<DocumentReturn[]>([])
  const [returningDocId, setReturningDocId] = useState<string | null>(null)
  const [returnReason, setReturnReason] = useState('')
  const [returnSending, setReturnSending] = useState(false)
  // Late closing interest
  const [showLateInterest, setShowLateInterest] = useState(false)
  const [actualClosingDate, setActualClosingDate] = useState('')
  const [lateInterestSaving, setLateInterestSaving] = useState(false)
  // Agent account balance
  const [agentBalance, setAgentBalance] = useState<number>(0)
  // Collapsible sections
  const [notesExpanded, setNotesExpanded] = useState(false)
  const [messagesExpanded, setMessagesExpanded] = useState(false)
  const [messagesDismissed, setMessagesDismissed] = useState(false)
  // Unread = last message from agent AND not yet dismissed locally
  const hasUnreadMessages = !messagesDismissed && messages.length > 0 && messages[messages.length - 1].sender_role !== 'admin'
  const [lateInterestExpanded, setLateInterestExpanded] = useState(false)
  // Drag-and-drop
  const [draggingDocId, setDraggingDocId] = useState<string | null>(null)
  const [dropTargetItemId, setDropTargetItemId] = useState<string | null>(null)
  const router = useRouter()
  const params = useParams()
  const dealId = params.id as string
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  useEffect(() => { loadDealData() }, [dealId])

  // After expanding messages, scroll the inner container to bottom so newest messages are visible
  useEffect(() => {
    if (messagesExpanded && messages.length > 0) {
      const scrollContainerToBottom = () => {
        if (adminMessagesContainerRef.current) {
          adminMessagesContainerRef.current.scrollTop = adminMessagesContainerRef.current.scrollHeight
        }
      }
      // Multiple attempts — DOM needs time to render the expanded section
      requestAnimationFrame(scrollContainerToBottom)
      setTimeout(scrollContainerToBottom, 100)
      setTimeout(scrollContainerToBottom, 300)
    }
  }, [messagesExpanded, messages.length])

  // Auto-dismiss message notifications when admin expands the messages section
  useEffect(() => {
    if (messagesExpanded && dealId) {
      setMessagesDismissed(true)
      void dismissDealMessages(dealId)
    }
  }, [messagesExpanded, dealId])

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
    setAgentBalance(agentData?.account_balance || 0)
    const { data: brokerageData } = await supabase.from('brokerages').select('*').eq('id', dealData.brokerage_id).single()
    setBrokerage(brokerageData)
    const { data: checklistData } = await supabase.from('underwriting_checklist').select('*').eq('deal_id', dealId).order('sort_order', { ascending: true })
    setChecklist(checklistData || [])
    const { data: docsData } = await supabase.from('deal_documents').select('*').eq('deal_id', dealId).order('created_at', { ascending: false })
    setDocuments(docsData || [])
    const { data: requestsData } = await supabase.from('document_requests').select('*').eq('deal_id', dealId).order('created_at', { ascending: false })
    setDocRequests(requestsData || [])
    const { data: messagesData } = await supabase.from('deal_messages').select('*').eq('deal_id', dealId).order('created_at', { ascending: true })
    setMessages(messagesData || [])
    const { data: returnsData } = await supabase.from('document_returns').select('*').eq('deal_id', dealId).order('created_at', { ascending: false })
    setDocReturns(returnsData || [])
    const esignResult = await getDealSignatureStatus(dealId)
    if (esignResult.success) setEsignEnvelopes(esignResult.data || [])
    // Load amendments
    const amendResult = await getDealAmendments(dealId)
    if (amendResult.success) setAmendments(amendResult.data || [])
    setLoading(false)

    // After ALL data is loaded, handle auto-expand + scroll for #messages hash or unread messages
    const hasHash = window.location.hash === '#messages'
    const hasUnread = messagesData && messagesData.length > 0 && messagesData[messagesData.length - 1].sender_role !== 'admin'
    if (hasHash || hasUnread) {
      setMessagesExpanded(true)
      // Wait for React to render the expanded section, then scroll
      setTimeout(() => {
        // Scroll the messages container to bottom (newest messages visible)
        if (adminMessagesContainerRef.current) {
          adminMessagesContainerRef.current.scrollTop = adminMessagesContainerRef.current.scrollHeight
        }
        // Scroll the page to the messages section
        if (hasHash) {
          document.getElementById('messages')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          // After page scroll animation, scroll container again (scrollIntoView can reset it)
          setTimeout(() => {
            if (adminMessagesContainerRef.current) {
              adminMessagesContainerRef.current.scrollTop = adminMessagesContainerRef.current.scrollHeight
            }
          }, 500)
        }
      }, 200)
    }
  }

  const handleChecklistToggle = async (item: ChecklistItem) => {
    if (item.is_na) return
    if (item.checklist_item === 'Agent in good standing with Brokerage (Not flagged)' && agent?.flagged_by_brokerage) {
      setStatusMessage({ type: 'error', text: 'Cannot check — agent is flagged by their brokerage' })
      return
    }
    const newChecked = !item.is_checked
    setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, is_checked: newChecked, checked_at: newChecked ? new Date().toISOString() : null } : c))
    const result = await serverToggleChecklistItem({ itemId: item.id, isChecked: newChecked })
    if (!result.success) {
      setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, is_checked: !newChecked, checked_at: !newChecked ? item.checked_at : null } : c))
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update' })
    }
  }

  const handleSendMessage = async () => {
    if (!deal || !messageText.trim()) return
    setMessageSending(true)
    const result = await sendDealMessage({ dealId: deal.id, message: messageText.trim() })
    if (result.success) {
      setMessages(prev => [...prev, result.data.message])
      setMessageText('')
      setShowMessageForm(false)
      setStatusMessage({ type: 'success', text: 'Message sent to agent' })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to send message' })
    }
    setMessageSending(false)
  }

  const handleReturnDocument = async (docId: string) => {
    if (!deal || !returnReason.trim()) return
    setReturnSending(true)
    const result = await returnDocument({ dealId: deal.id, documentId: docId, reason: returnReason.trim() })
    if (result.success) {
      setDocReturns(prev => [{ id: result.data.returnId, deal_id: deal.id, document_id: docId, returned_by: '', reason: returnReason, status: 'pending', created_at: new Date().toISOString() }, ...prev])
      setReturningDocId(null)
      setReturnReason('')
      setStatusMessage({ type: 'success', text: 'Document returned to agent — email notification sent' })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to return document' })
    }
    setReturnSending(false)
  }

  const handleChargeLateInterest = async () => {
    if (!deal || !actualClosingDate) return
    setLateInterestSaving(true)
    const result = await chargeLatePaymentInterest({ dealId: deal.id, throughDate: actualClosingDate })
    if (result.success) {
      setAgentBalance(result.data.newBalance)
      setDeal(prev => prev ? { ...prev, actual_closing_date: actualClosingDate, late_interest_charged: (prev.late_interest_charged || 0) + result.data.interest } : prev)
      setShowLateInterest(false)
      setStatusMessage({ type: 'success', text: `Late interest of $${result.data.interest.toFixed(2)} charged to agent account (new balance: $${result.data.newBalance.toFixed(2)})` })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to charge late interest' })
    }
    setLateInterestSaving(false)
  }

  const handleChecklistNA = async (e: React.MouseEvent, item: ChecklistItem) => {
    e.stopPropagation()
    const newNA = !item.is_na
    const prevItem = { ...item }
    setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, is_na: newNA, is_checked: newNA ? false : c.is_checked } : c))
    const result = await serverToggleChecklistItemNA({ itemId: item.id, isNA: newNA })
    if (!result.success) {
      setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, is_na: prevItem.is_na, is_checked: prevItem.is_checked } : c))
      setStatusMessage({ type: 'error', text: result.error || 'Failed to update' })
    }
  }

  const handleDocDragStart = (e: React.DragEvent, docId: string) => {
    e.dataTransfer.setData('text/plain', docId)
    e.dataTransfer.effectAllowed = 'link'
    setDraggingDocId(docId)
  }
  const handleDocDragEnd = () => {
    setDraggingDocId(null)
    setDropTargetItemId(null)
  }
  const handleChecklistDragOver = (e: React.DragEvent, item: ChecklistItem) => {
    if (item.is_checked || item.is_na) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'link'
    setDropTargetItemId(item.id)
  }
  const handleChecklistDragLeave = () => {
    setDropTargetItemId(null)
  }
  const handleChecklistDrop = async (e: React.DragEvent, item: ChecklistItem) => {
    e.preventDefault()
    setDropTargetItemId(null)
    setDraggingDocId(null)
    if (item.is_checked || item.is_na) return
    const docId = e.dataTransfer.getData('text/plain')
    if (!docId) return
    setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, linked_document_id: docId } : c))
    const result = await linkDocumentToChecklist({ checklistItemId: item.id, documentId: docId })
    if (!result.success) {
      setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, linked_document_id: item.linked_document_id } : c))
      setStatusMessage({ type: 'error', text: result.error || 'Failed to link document' })
    }
  }
  const handleUnlinkDocument = async (e: React.MouseEvent, item: ChecklistItem) => {
    e.stopPropagation()
    if (item.is_checked) {
      setStatusMessage({ type: 'error', text: 'Uncheck the item first before removing the linked document.' })
      return
    }
    const prevDocId = item.linked_document_id
    setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, linked_document_id: null } : c))
    const result = await linkDocumentToChecklist({ checklistItemId: item.id, documentId: null })
    if (!result.success) {
      setChecklist(prev => prev.map(c => c.id === item.id ? { ...c, linked_document_id: prevDocId } : c))
      setStatusMessage({ type: 'error', text: result.error || 'Failed to unlink document' })
    }
  }

  const isBackwardTransition = (newStatus: string) => {
    if (!deal) return false
    return (BACKWARD_STATUSES[deal.status] || []).includes(newStatus)
  }

  const handleApproveAmendment = async (amendmentId: string) => {
    setAmendmentProcessing(amendmentId)
    const result = await approveClosingDateAmendment({ amendmentId })
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Amendment approved. Deal updated and amended CPA sent for signing.' })
      await loadDealData()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to approve amendment' })
    }
    setAmendmentProcessing(null)
  }

  const handleRejectAmendment = async (amendmentId: string) => {
    if (!rejectReason.trim()) {
      setStatusMessage({ type: 'error', text: 'Rejection reason is required' })
      return
    }
    setAmendmentProcessing(amendmentId)
    const result = await rejectClosingDateAmendment({ amendmentId, reason: rejectReason.trim() })
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Amendment rejected. Agent notified.' })
      setRejectingAmendment(null)
      setRejectReason('')
      await loadDealData()
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to reject amendment' })
    }
    setAmendmentProcessing(null)
  }

  const handleStatusChange = async (newStatus: string) => {
    if (!deal) return
    if (newStatus === 'denied' && !denialReason.trim()) { setShowDenialInput(true); return }
    if (newStatus === 'funded' && !showFundingConfirmation) { setShowFundingConfirmation(true); return }
    setShowFundingConfirmation(false)
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

  const handleSendForSignature = async () => {
    if (!deal) return
    setSendingForSignature(true)
    setStatusMessage(null)
    const result = await sendForSignature(deal.id)
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Contracts sent for e-signature via DocuSign!' })
      const esignResult = await getDealSignatureStatus(deal.id)
      if (esignResult.success) setEsignEnvelopes(esignResult.data || [])
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to send for signature' })
    }
    setSendingForSignature(false)
  }

  const handleVoidEnvelopes = async () => {
    if (!deal) return
    if (!confirm('Are you sure you want to void the pending signature request? The agent will be notified.')) return
    setVoidingEnvelopes(true)
    const result = await voidDealEnvelopes(deal.id, 'Voided by admin')
    if (result.success) {
      setStatusMessage({ type: 'success', text: 'Signature request voided' })
      const esignResult = await getDealSignatureStatus(deal.id)
      if (esignResult.success) setEsignEnvelopes(esignResult.data || [])
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to void' })
    }
    setVoidingEnvelopes(false)
  }

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
    if (deal) {
      supabase.auth.getUser().then(({ data: { user: authUser } }) => {
        void supabase.from('audit_log').insert({
          user_id: authUser?.id || null,
          action: 'document.view',
          entity_type: 'document',
          entity_id: doc.id,
          severity: 'info',
          actor_email: authUser?.email || null,
          metadata: { deal_id: deal.id, file_name: doc.file_name, access_type: 'download' },
        })
      })
    }
    window.open(signedUrl, '_blank')
  }

  const closeDocViewer = () => {
    if (viewingDoc?.blobUrl) URL.revokeObjectURL(viewingDoc.blobUrl)
    setViewingDoc(null)
  }

  const handleDocumentView = async (doc: DealDocument) => {
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
      const response = await fetch(signedUrl)
      const arrayBuffer = await response.arrayBuffer()
      const mimeType = isPdf ? 'application/pdf' : (response.headers.get('content-type') || 'image/png')
      const blob = new Blob([arrayBuffer], { type: mimeType })
      const blobUrl = URL.createObjectURL(blob)
      if (viewingDoc?.blobUrl) URL.revokeObjectURL(viewingDoc.blobUrl)
      setViewingDoc({
        blobUrl,
        originalUrl: signedUrl,
        fileName: doc.file_name,
        type: isImage ? 'image' : 'pdf',
        ...(isPdf ? { pdfData: arrayBuffer } : {}),
      })
      if (deal) {
        supabase.auth.getUser().then(({ data: { user: authUser } }) => {
          void supabase.from('audit_log').insert({
            user_id: authUser?.id || null,
            action: 'document.view',
            entity_type: 'document',
            entity_id: doc.id,
            severity: 'info',
            actor_email: authUser?.email || null,
            metadata: { deal_id: deal.id, file_name: doc.file_name, access_type: 'view' },
          })
        })
      }
    } catch (err) {
      console.error('Blob fetch failed:', err)
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

  const statusBadgeClass = getStatusBadgeClass

  const checkedCount = checklist.filter(c => c.is_checked || c.is_na).length
  const totalChecklist = checklist.length
  const checklistPct = totalChecklist > 0 ? Math.round((checkedCount / totalChecklist) * 100) : 0
  const allChecklistComplete = totalChecklist > 0 && checkedCount === totalChecklist
  const approvalItems = checklist.filter(c => c.category !== 'Firm Fund Documents')
  const approvalCheckedCount = approvalItems.filter(c => c.is_checked || c.is_na).length
  const allApprovalItemsComplete = approvalItems.length > 0 && approvalCheckedCount === approvalItems.length

  if (loading) return (
    <div className="min-h-screen bg-background">
      <header className="bg-card/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
          <Skeleton className="h-5 w-48 mb-2" />
          <Skeleton className="h-3 w-32" />
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {[1,2,3].map(i => <Skeleton key={i} className="h-40 rounded-xl" />)}
          </div>
          <div className="space-y-6">
            {[1,2].map(i => <Skeleton key={i} className="h-48 rounded-xl" />)}
          </div>
        </div>
      </main>
    </div>
  )

  if (!deal || !agent || !brokerage) return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-muted-foreground">Deal not found</div>
    </div>
  )

  const nextStatuses = STATUS_FLOW[deal.status] || []
  const categorizedChecklist = categorizeChecklist(checklist)

  return (
    <div className="min-h-screen bg-background">
      <div>
      {/* HEADER */}
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-8 sm:h-10 w-auto" />
              <Separator orientation="vertical" className="h-6 bg-border/30" />
              <button
                onClick={() => router.push('/admin')}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
            </div>
            <SignOutModal onConfirm={handleLogout} />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground">{deal.property_address}</h1>
          </div>
        </div>
      </header>

      {/* STATUS MESSAGE TOAST */}
      {statusMessage && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <Alert variant={statusMessage.type === 'error' ? 'destructive' : 'default'} className={statusMessage.type === 'success' ? 'border-primary/50 bg-primary/10 text-primary' : ''}>
            <AlertDescription>{statusMessage.text}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* FLAGGED AGENT WARNING BANNER */}
      {agent?.flagged_by_brokerage && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-3">
          <div className="rounded-md px-3 py-2 flex items-center gap-2 bg-status-red-muted border-2 border-red-600 shadow-[0_0_15px_rgba(220,38,38,0.3)]">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 text-red-500" />
            <p className="font-bold text-sm text-red-500">
              AGENT FLAGGED BY BROKERAGE — {agent.first_name} {agent.last_name}. Review carefully.
            </p>
          </div>
        </div>
      )}

      {/* OUTSTANDING RECOVERY WARNING BANNER */}
      {agent && agent.outstanding_recovery && agent.outstanding_recovery > 0 && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2">
          <div className="rounded-md px-3 py-2 flex items-center gap-2 bg-status-amber-muted border-2 border-amber-600 shadow-[0_0_15px_rgba(217,119,6,0.2)]">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-500" />
            <p className="font-bold text-sm text-amber-500">
              OUTSTANDING RECOVERY: ${agent.outstanding_recovery.toLocaleString('en-CA', { minimumFractionDigits: 2 })} — {agent.first_name} {agent.last_name}
            </p>
          </div>
        </div>
      )}

      <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* DEAL PIPELINE */}
        <div className="mb-4">
          <div className="flex justify-between mb-1.5">
            <span className="text-xs font-bold uppercase tracking-wider text-primary/80">Pipeline Progress</span>
            <span className="text-xs font-semibold tabular-nums text-muted-foreground">{checklistPct}%</span>
          </div>
          <div className="w-full rounded-full h-2 bg-secondary">
            <div className="h-2 rounded-full transition-all bg-primary shadow-sm shadow-primary/30" style={{ width: `${checklistPct}%` }} />
          </div>
        </div>

        {/* STICKY ACTION BAR */}
        <div className="sticky top-0 z-20 mb-5 rounded-xl px-4 py-3 bg-card/95 ff-header-blur border border-border/40 shadow-lg shadow-black/20 ff-card-elevated">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              {statusBadgeClass(deal.status) && (
                <div
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold tracking-wide ${statusBadgeClass(deal.status)}`}
                >
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
                const needsChecklist = (status === 'approved' && !allApprovalItemsComplete) || (status === 'funded' && !allChecklistComplete)
                const paymentTotal = (deal.brokerage_payments || []).reduce((sum, p) => sum + p.amount, 0)
                const paymentsMatch = Math.abs(paymentTotal - deal.amount_due_from_brokerage) < 0.01 && paymentTotal > 0
                const needsPayments = status === 'completed' && !paymentsMatch
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
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-30 bg-card border border-border text-destructive">
                        {needsChecklist
                          ? (status === 'approved'
                            ? `Complete verification checklist first (${approvalCheckedCount}/${approvalItems.length})`
                            : `Complete all checklist items first — signed contracts required (${checkedCount}/${totalChecklist})`)
                          : 'Brokerage payments must match expected amount first'}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* E-Signature Button */}
              {deal.status === 'approved' && (() => {
                const activeEnvelopes = esignEnvelopes.filter(e => ['sent', 'delivered'].includes(e.status))
                const signedEnvelopes = esignEnvelopes.filter(e => e.status === 'signed')
                const hasPending = activeEnvelopes.length > 0
                const allSigned = signedEnvelopes.length >= 2

                if (allSigned) {
                  return (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary/10 text-primary border border-primary/30">
                      <CheckCircle2 className="w-4 h-4" />
                      Contracts Signed
                    </div>
                  )
                }
                if (hasPending) {
                  return (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-950/30 text-amber-400 border border-amber-800/50">
                        <Clock className="w-4 h-4" />
                        Awaiting Signature
                      </div>
                      <button
                        onClick={handleVoidEnvelopes}
                        disabled={voidingEnvelopes}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition disabled:opacity-50 bg-red-950/30 text-red-400 border border-red-800/50 hover:bg-red-950/50"
                      >
                        {voidingEnvelopes ? 'Cancelling...' : 'Cancel Signing'}
                      </button>
                    </div>
                  )
                }
                return (
                  <button
                    onClick={handleSendForSignature}
                    disabled={sendingForSignature}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition disabled:opacity-50 bg-blue-700 hover:bg-blue-800"
                  >
                    <FileSignature className="w-4 h-4" />
                    {sendingForSignature ? 'Sending...' : 'Send for Signature'}
                  </button>
                )
              })()}

              {/* Backward transitions */}
              {nextStatuses.filter(s => isBackwardTransition(s)).length > 0 && (
                <Separator orientation="vertical" className="h-6 mx-1" />
              )}
              {nextStatuses.filter(s => isBackwardTransition(s)).map(status => {
                const config = ACTION_CONFIG[status]
                if (!config) return null
                return (
                  <button
                    key={status}
                    onClick={() => handleStatusChange(status)}
                    disabled={updating}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50 bg-transparent text-muted-foreground border border-border/50 hover:border-amber-600 hover:text-amber-600"
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
            <div className="mt-4 pt-4 border-t border-border/50">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-950/30 border border-amber-800/50">
                <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5 text-amber-600" />
                <div className="flex-1">
                  <p className="text-sm font-semibold mb-1 text-amber-400">
                    Are you sure you want to revert this deal?
                  </p>
                  <p className="text-xs mb-3 text-amber-600/80">
                    This will move the deal from <strong>{STATUS_LABELS[deal.status]}</strong> back to <strong>{STATUS_LABELS[pendingBackward]}</strong>.
                    {pendingBackward === 'under_review' && ' Any previous approval or denial will be cleared.'}
                    {pendingBackward === 'approved' && ' The funded date and recalculated financials will be preserved but the deal will need to be re-funded.'}
                    {pendingBackward === 'funded' && ' The repayment date will be cleared.'}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleStatusChange(pendingBackward)}
                      disabled={updating}
                      className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 bg-amber-600 hover:bg-amber-700 transition-colors"
                    >
                      {updating ? 'Reverting...' : 'Yes, Revert'}
                    </button>
                    <button
                      onClick={() => setPendingBackward(null)}
                      className="px-4 py-1.5 rounded-lg text-sm font-medium bg-muted text-foreground hover:bg-muted/70 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* FUNDING CONFIRMATION */}
          {showFundingConfirmation && deal && (() => {
            const daysUntilClosing = Math.max(1, calcDaysUntilClosing(deal.closing_date))
            const referralPct = brokerage?.referral_fee_percentage ?? 0.20
            const calc = calculateDeal({
              grossCommission: deal.gross_commission,
              brokerageSplitPct: deal.brokerage_split_pct,
              daysUntilClosing,
              discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
              brokerageReferralPct: referralPct,
            })
            const chargeDays = Math.max(1, daysUntilClosing - 1 + RETURN_PROCESSING_DAYS)
            const today = new Date()
            const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
            const closingDate = new Date(deal.closing_date + 'T00:00:00')
            const fmtDate = (d: Date) => d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
            return (
              <div className="mt-4 pt-4 border-t border-border/50">
                <div className="p-4 rounded-lg bg-purple-950/20 border border-purple-800/40">
                  <h4 className="text-sm font-bold mb-3 flex items-center gap-2 text-purple-400">
                    <Banknote className="w-4 h-4" />
                    Confirm Funding
                  </h4>
                  <div className="rounded-lg p-3 mb-3 bg-card/50">
                    <table className="w-full text-xs">
                      <tbody>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Funding Date</td>
                          <td className="py-1.5 text-right font-medium text-foreground">{fmtDate(today)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Charges Start</td>
                          <td className="py-1.5 text-right font-medium text-foreground">{fmtDate(tomorrow)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Closing Date</td>
                          <td className="py-1.5 text-right font-medium text-foreground">{fmtDate(closingDate)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Days Charged</td>
                          <td className="py-1.5 text-right font-mono font-bold text-purple-400">{chargeDays} days</td>
                        </tr>
                        <tr><td colSpan={2}><Separator className="my-1.5" /></td></tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Gross Commission</td>
                          <td className="py-1.5 text-right font-mono text-foreground">{formatCurrency(deal.gross_commission)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Brokerage Split ({deal.brokerage_split_pct}%)</td>
                          <td className="py-1.5 text-right font-mono text-muted-foreground">-{formatCurrency(deal.gross_commission * deal.brokerage_split_pct / 100)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 font-semibold text-foreground">Net Commission</td>
                          <td className="py-1.5 text-right font-mono font-semibold text-foreground">{formatCurrency(calc.netCommission)}</td>
                        </tr>
                        <tr><td colSpan={2}><Separator className="my-1.5" /></td></tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Discount Fee ({chargeDays}d x $0.75/$1k)</td>
                          <td className="py-1.5 text-right font-mono text-destructive">-{formatCurrency(calc.discountFee)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Settlement Period Fee (14d x $0.75/$1k)</td>
                          <td className="py-1.5 text-right font-mono text-destructive">-{formatCurrency(calc.settlementPeriodFee)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 font-bold text-primary">Agent Receives</td>
                          <td className="py-1.5 text-right font-mono font-bold text-primary">{formatCurrency(calc.advanceAmount)}</td>
                        </tr>
                        <tr><td colSpan={2}><Separator className="my-1.5" /></td></tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Brokerage Referral ({(referralPct * 100).toFixed(0)}% of discount fee)</td>
                          <td className="py-1.5 text-right font-mono text-muted-foreground">{formatCurrency(calc.brokerageReferralFee)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 font-semibold text-purple-400">Firm Funds Profit</td>
                          <td className="py-1.5 text-right font-mono font-semibold text-purple-400">{formatCurrency(calc.firmFundsProfit)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">Amount Due from Brokerage</td>
                          <td className="py-1.5 text-right font-mono text-foreground">{formatCurrency(calc.amountDueFromBrokerage)}</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-muted-foreground">EFT Transfer Days</td>
                          <td className="py-1.5 text-right font-mono text-foreground">{calc.eftTransferDays} day{calc.eftTransferDays !== 1 ? 's' : ''}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleStatusChange('funded')}
                      disabled={updating}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition-colors bg-purple-700 hover:bg-purple-800"
                    >
                      <Banknote className="w-4 h-4" />
                      {updating ? 'Funding...' : 'Confirm Funding'}
                    </button>
                    <button
                      onClick={() => setShowFundingConfirmation(false)}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-muted text-foreground hover:bg-muted/70 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* DENIAL REASON */}
          {showDenialInput && (
            <div className="mt-4 pt-4 border-t border-border/50">
              <Label className="block mb-2">Denial Reason</Label>
              <Textarea
                value={denialReason}
                onChange={(e) => setDenialReason(e.target.value)}
                placeholder="Explain why this deal is being denied..."
                className="min-h-[80px] mb-3"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => handleStatusChange('denied')}
                  disabled={updating || !denialReason.trim()}
                  className="px-4 py-2 rounded-lg font-medium text-white disabled:opacity-50 bg-red-700 hover:bg-red-800 transition-colors"
                >
                  Confirm Denial
                </button>
                <button
                  onClick={() => { setShowDenialInput(false); setDenialReason('') }}
                  className="px-4 py-2 rounded-lg font-medium bg-muted text-foreground hover:bg-muted/70 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* EFT SECTION */}
        {['funded', 'completed'].includes(deal.status) && (
          <div className="mb-4 rounded-xl p-4 bg-card border border-border/50 ff-card-elevated">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold flex items-center gap-2 text-foreground">
                <Banknote className="w-4 h-4 text-primary" />
                EFT Transfers
              </h2>
              <Button
                onClick={() => setShowEftForm(!showEftForm)}
                variant={showEftForm ? 'outline' : 'default'}
                size="sm"
              >
                {showEftForm ? 'Cancel' : 'Record Transfer'}
              </Button>
            </div>

            {showEftForm && (
              <div className="mb-6 p-4 rounded-lg bg-muted/30 border border-border/30">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div>
                    <Label className="mb-1 block">Amount (CAD)</Label>
                    <Input type="number" value={eftAmount} onChange={(e) => setEftAmount(e.target.value)} placeholder="0.00" />
                  </div>
                  <div>
                    <Label className="mb-1 block">Transfer Date</Label>
                    <Input type="date" value={eftDate} onChange={(e) => setEftDate(e.target.value)} className="[color-scheme:dark]" />
                  </div>
                  <div>
                    <Label className="mb-1 block">Reference / Memo</Label>
                    <Input type="text" value={eftReference} onChange={(e) => setEftReference(e.target.value)} placeholder="Bank ref #, confirmation..." />
                  </div>
                </div>
                <Button
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
                  size="sm"
                >
                  Record Transfer
                </Button>
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
                <div className="mb-4 p-3 rounded-lg flex items-center justify-between text-sm"
                  style={{
                    background: isMatch ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : isOver ? 'color-mix(in srgb, var(--status-red) 10%, transparent)' : 'color-mix(in srgb, var(--status-amber) 10%, transparent)',
                    border: `1px solid ${isMatch ? 'var(--primary)' : isOver ? 'var(--status-red)' : 'var(--status-amber)'}`,
                  }}>
                  <div>
                    <span className="text-muted-foreground">EFT Total: </span>
                    <span className="font-bold text-foreground">{formatCurrency(eftTotal)}</span>
                    <span className="text-muted-foreground"> / Expected: </span>
                    <span className="font-bold text-foreground">{formatCurrency(expected)}</span>
                  </div>
                  <span className="font-semibold" style={{ color: isMatch ? 'var(--primary)' : isOver ? 'var(--status-red)' : 'var(--status-amber)' }}>
                    {isMatch ? 'Matched' : isOver ? `Over by ${formatCurrency(eftTotal - expected)}` : `Remaining: ${formatCurrency(diff)}`}
                  </span>
                </div>
              ) : null
            })()}

            {deal.eft_transfers && deal.eft_transfers.length > 0 ? (
              <div className="space-y-2">
                {deal.eft_transfers.map((eft, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-muted/20 border border-border/30 transition-all duration-200 hover:border-primary/30 hover:bg-primary/[0.03] group">
                    <div>
                      <p className="font-semibold tabular-nums text-foreground transition-colors group-hover:text-primary">{formatCurrency(eft.amount)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(eft.date)}{eft.reference ? ` · Ref: ${eft.reference}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {eft.confirmed ? (
                        <Badge variant="outline" className="border-primary/40 text-primary bg-primary/10">
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          Confirmed
                        </Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            const result = await confirmEftTransfer({ dealId: deal.id, transferIndex: idx })
                            if (result.success) {
                              setDeal(prev => prev ? { ...prev, ...result.data } : null)
                            }
                          }}
                          className="text-amber-400 border-amber-800/40 bg-amber-950/30 hover:bg-amber-950/50 hover:text-amber-300"
                        >
                          Confirm
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={async () => {
                          const result = await removeEftTransfer({ dealId: deal.id, transferIndex: idx })
                          if (result.success) {
                            setDeal(prev => prev ? { ...prev, ...result.data } : null)
                          }
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No EFT transfers recorded yet</p>
            )}
          </div>
        )}

        {/* BROKERAGE PAYMENTS SECTION */}
        {['funded', 'completed'].includes(deal.status) && (
          <div className="mb-4 rounded-xl p-4 bg-card border border-border/50 ff-card-elevated">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold flex items-center gap-2 text-foreground">
                <DollarSign className="w-4 h-4 text-cyan-400" />
                Brokerage Payments
              </h2>
              <Button
                onClick={() => setShowPaymentForm(!showPaymentForm)}
                variant={showPaymentForm ? 'outline' : 'default'}
                size="sm"
                className={showPaymentForm ? '' : 'bg-cyan-600 hover:bg-cyan-700'}
              >
                {showPaymentForm ? 'Cancel' : 'Record Payment'}
              </Button>
            </div>

            {showPaymentForm && (
              <div className="mb-6 p-4 rounded-lg bg-muted/30 border border-border/30">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                  <div>
                    <Label className="mb-1 block">Amount (CAD)</Label>
                    <Input type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="0.00" step="0.01" />
                  </div>
                  <div>
                    <Label className="mb-1 block">Date Received</Label>
                    <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="[color-scheme:dark]" />
                  </div>
                  <div>
                    <Label className="mb-1 block">Method</Label>
                    <select
                      value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">Select...</option>
                      <option value="eft">EFT</option>
                      <option value="cheque">Cheque</option>
                      <option value="wire">Wire Transfer</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <Label className="mb-1 block">Reference</Label>
                    <Input type="text" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="Cheque #, ref..." />
                  </div>
                </div>
                <Button
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
                  size="sm"
                  className="bg-teal-700 hover:bg-teal-800"
                >
                  Record Payment
                </Button>
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
                <div className="mb-4 p-3 rounded-lg flex items-center justify-between text-sm"
                  style={{
                    background: isMatch ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : isOver ? 'color-mix(in srgb, var(--status-red) 10%, transparent)' : 'color-mix(in srgb, var(--status-amber) 10%, transparent)',
                    border: `1px solid ${isMatch ? 'var(--primary)' : isOver ? 'var(--status-red)' : 'var(--status-amber)'}`,
                  }}>
                  <div>
                    <span className="text-muted-foreground">Received: </span>
                    <span className="font-bold text-foreground">{formatCurrency(payTotal)}</span>
                    <span className="text-muted-foreground"> / Expected: </span>
                    <span className="font-bold text-foreground">{formatCurrency(expected)}</span>
                  </div>
                  <span className="font-semibold" style={{ color: isMatch ? 'var(--primary)' : isOver ? 'var(--status-red)' : 'var(--status-amber)' }}>
                    {isMatch ? '✓ Ready to mark Complete' : isOver ? `Over by ${formatCurrency(payTotal - expected)}` : `Outstanding: ${formatCurrency(diff)}`}
                  </span>
                </div>
              ) : (
                <p className="mb-4 text-sm text-muted-foreground">
                  Expected from brokerage: <strong className="text-foreground">{formatCurrency(deal.amount_due_from_brokerage)}</strong> — no payments recorded yet
                </p>
              )
            })()}

            {deal.brokerage_payments && deal.brokerage_payments.length > 0 && (
              <div className="space-y-2">
                {deal.brokerage_payments.map((payment, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-muted/20 border border-border/30 transition-all duration-200 hover:border-primary/30 hover:bg-primary/[0.03] group">
                    <div>
                      <p className="font-semibold tabular-nums text-foreground transition-colors group-hover:text-primary">{formatCurrency(payment.amount)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(payment.date)}
                        {payment.method ? ` · ${payment.method.charAt(0).toUpperCase() + payment.method.slice(1)}` : ''}
                        {payment.reference ? ` · Ref: ${payment.reference}` : ''}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
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
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* AGENT & BROKERAGE */}
        <div className="rounded-xl mb-3 flex flex-col sm:flex-row bg-card border border-border/50 ff-card-elevated overflow-hidden">
          <div className="flex-1 px-4 py-3 flex items-start gap-3 sm:border-r border-b sm:border-b-0 border-border/30">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-primary/10">
              <User className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground leading-tight">{agent.first_name} {agent.last_name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{agent.email || 'No email'}{agent.phone ? ` · ${agent.phone}` : ''}</p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {agent.reco_number && <span className="text-[10px] text-muted-foreground/60">RECO {agent.reco_number}</span>}
                {agent.flagged_by_brokerage && (
                  <Badge variant="outline" className="text-[10px] py-0 h-4 border-amber-800/40 text-amber-400 bg-amber-950/30">Flagged</Badge>
                )}
                {agent.outstanding_recovery != null && agent.outstanding_recovery > 0 && (
                  <Badge variant="outline" className="text-[10px] py-0 h-4 border-destructive/40 text-destructive bg-destructive/10">Recovery: {formatCurrency(agent.outstanding_recovery)}</Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex-1 px-4 py-3 flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-primary/10">
              <Building2 className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground leading-tight">{brokerage.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{brokerage.brand ? `${brokerage.brand} · ` : ''}{brokerage.email || ''}</p>
              {brokerage.referral_fee_percentage !== null && (
                <p className="text-[10px] text-muted-foreground/60 mt-1">Referral: {(brokerage.referral_fee_percentage * 100).toFixed(0)}%</p>
              )}
            </div>
          </div>
        </div>

        {/* DEAL DETAILS + FINANCIAL */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
          {/* DEAL DETAILS */}
          <div className="rounded-xl px-4 py-3 bg-card border border-border/50 ff-card-elevated">
            <h2 className="text-xs font-bold mb-3 flex items-center gap-1.5 uppercase tracking-wider text-primary">
              <FileText className="w-3.5 h-3.5" />
              Deal Details
            </h2>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <div className="col-span-2 mb-1">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Property Address</p>
                <p className="text-sm font-medium flex items-center gap-1 text-foreground">
                  <MapPin className="w-3 h-3 flex-shrink-0 text-primary" />{deal.property_address}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Closing Date
                  {!editingClosingDate && (deal.status === 'under_review' || deal.status === 'approved' || deal.status === 'funded') && (
                    <button onClick={() => { setEditingClosingDate(true); setNewClosingDate(deal.closing_date); setClosingDateComparison(null) }}
                      className="ml-1 p-0.5 rounded transition-colors inline text-muted-foreground/60 hover:text-primary"
                    ><Edit2 className="w-2.5 h-2.5 inline" /></button>
                  )}
                </p>
                {editingClosingDate ? (
                  <div className="space-y-1.5 mt-1">
                    <input type="date" value={newClosingDate} onChange={(e) => setNewClosingDate(e.target.value)}
                      min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                      className="w-full rounded px-2 py-1 text-xs outline-none bg-muted border border-border/50 text-foreground [color-scheme:dark]"
                    />
                    <div className="flex gap-1">
                      <button onClick={handleUpdateClosingDate} disabled={closingDateSaving || newClosingDate === deal.closing_date}
                        className="px-2 py-0.5 rounded text-[10px] font-medium text-white disabled:opacity-50 bg-primary hover:bg-primary/90 transition-colors">
                        {closingDateSaving ? 'Saving...' : 'Update & Recalc'}
                      </button>
                      <button onClick={() => { setEditingClosingDate(false); setClosingDateComparison(null) }}
                        className="px-2 py-0.5 rounded text-[10px] text-muted-foreground border border-border/50 hover:bg-muted transition-colors">Cancel</button>
                    </div>
                    {closingDateComparison && (
                      <div className="rounded p-1.5 text-[10px] space-y-0.5 bg-blue-950/20 border border-blue-800/30">
                        <p className="text-blue-400">Days: {closingDateComparison.old.days_until_closing} → {closingDateComparison.new.days_until_closing}</p>
                        <p className="text-blue-400">Fee: ${closingDateComparison.old.discount_fee.toFixed(2)} → ${closingDateComparison.new.discount_fee.toFixed(2)}</p>
                        <p className="text-blue-400">Advance: ${closingDateComparison.old.advance_amount.toFixed(2)} → ${closingDateComparison.new.advance_amount.toFixed(2)}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs font-medium text-foreground">{formatDate(deal.closing_date)}</p>
                )}
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Days Until Closing</p>
                <p className="text-xs font-medium text-foreground">{deal.days_until_closing} days</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Source</p>
                <p className="text-xs font-medium text-foreground">{deal.source}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Created</p>
                <p className="text-xs font-medium text-foreground">{formatDateTime(deal.created_at)}</p>
              </div>
            </div>
            {deal.denial_reason && (
              <div className="mt-2 p-1.5 rounded text-xs bg-destructive/10 border border-destructive/30 text-destructive">
                <strong>Denial:</strong> {deal.denial_reason}
              </div>
            )}
          </div>

          {/* CLOSING DATE AMENDMENTS */}
          {amendments.length > 0 && (
            <div className="rounded-xl px-4 py-3 mb-3 bg-card border border-border/50 ff-card-elevated">
              <h2 className="text-xs font-bold mb-3 flex items-center gap-1.5 uppercase tracking-wider text-amber-400">
                <Clock className="w-3.5 h-3.5" />
                Closing Date Amendments
              </h2>
              <div className="space-y-3">
                {amendments.map((am) => {
                  const isPending = am.status === 'pending'
                  const isApproved = am.status === 'approved'
                  const isRejected = am.status === 'rejected'
                  const docLink = am.amendment_document_id
                    ? documents.find((d: any) => d.id === am.amendment_document_id)
                    : null
                  return (
                    <div key={am.id} className={`rounded-lg p-3 border text-xs ${isPending ? 'bg-amber-500/5 border-amber-500/30' : isApproved ? 'bg-green-500/5 border-green-500/30' : 'bg-destructive/5 border-destructive/30'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className={`font-bold uppercase tracking-wider ${isPending ? 'text-amber-400' : isApproved ? 'text-green-400' : 'text-destructive'}`}>
                          {am.status}
                        </span>
                        <span className="text-muted-foreground">{new Date(am.created_at).toLocaleString('en-CA')}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px] mb-2">
                        <div>
                          <p className="text-muted-foreground">Old Closing Date</p>
                          <p className="font-semibold text-foreground">{new Date(am.old_closing_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">New Closing Date</p>
                          <p className="font-semibold text-foreground">{new Date(am.new_closing_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Old Advance</p>
                          <p className="font-semibold text-foreground">{formatCurrency(am.old_advance_amount || 0)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">New Advance</p>
                          <p className="font-semibold text-foreground">{formatCurrency(am.new_advance_amount || 0)}</p>
                        </div>
                      </div>
                      {docLink && (
                        <div className="mb-2">
                          <p className="text-muted-foreground mb-1">Uploaded Amendment:</p>
                          <button
                            onClick={async () => {
                              const { data } = await supabase.storage.from('deal-documents').createSignedUrl(docLink.file_path, 3600)
                              if (data?.signedUrl) window.open(data.signedUrl, '_blank')
                            }}
                            className="text-primary hover:underline font-medium"
                          >
                            {docLink.file_name}
                          </button>
                        </div>
                      )}
                      {isRejected && am.rejection_reason && (
                        <div className="mt-2 p-2 rounded bg-destructive/10 border border-destructive/20">
                          <p className="text-destructive"><strong>Rejected:</strong> {am.rejection_reason}</p>
                        </div>
                      )}
                      {isPending && (
                        <div className="mt-3 pt-3 border-t border-border/50">
                          {rejectingAmendment === am.id ? (
                            <div className="space-y-2">
                              <textarea
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                                placeholder="Reason for rejection..."
                                rows={2}
                                className="w-full px-2 py-1.5 rounded border border-border bg-background text-foreground text-xs"
                              />
                              <div className="flex gap-2 justify-end">
                                <button
                                  onClick={() => { setRejectingAmendment(null); setRejectReason('') }}
                                  className="px-3 py-1.5 rounded text-[11px] font-medium bg-muted text-foreground hover:bg-muted/70"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => handleRejectAmendment(am.id)}
                                  disabled={amendmentProcessing === am.id || !rejectReason.trim()}
                                  className="px-3 py-1.5 rounded text-[11px] font-medium bg-destructive text-white hover:bg-destructive/80 disabled:opacity-50"
                                >
                                  Confirm Reject
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => setRejectingAmendment(am.id)}
                                disabled={amendmentProcessing === am.id}
                                className="px-3 py-1.5 rounded text-[11px] font-medium bg-destructive/20 text-destructive hover:bg-destructive/30 disabled:opacity-50"
                              >
                                Reject
                              </button>
                              <button
                                onClick={() => handleApproveAmendment(am.id)}
                                disabled={amendmentProcessing === am.id}
                                className="px-3 py-1.5 rounded text-[11px] font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                              >
                                {amendmentProcessing === am.id ? 'Approving...' : 'Approve & Send Amended CPA'}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* FINANCIAL BREAKDOWN */}
          <div className="rounded-xl px-4 py-3 bg-card border border-border/50 ff-card-elevated">
            <h2 className="text-xs font-bold mb-3 flex items-center gap-1.5 uppercase tracking-wider text-primary">
              <DollarSign className="w-3.5 h-3.5" />
              Financial Breakdown
            </h2>
            <div className="space-y-0">
              {[
                { label: 'Gross Commission', value: formatCurrency(deal.gross_commission) },
                { label: `Brokerage Split (${deal.brokerage_split_pct}%)`, value: '' },
                { label: 'Net Commission', value: formatCurrency(deal.net_commission), bold: true },
                { label: `Discount Fee (${deal.days_until_closing}d)`, value: `-${formatCurrency(deal.discount_fee)}`, color: 'text-destructive' },
                { label: 'Settlement Period Fee (14d)', value: `-${formatCurrency(deal.settlement_period_fee || 0)}`, color: 'text-destructive' },
                { label: `Brokerage Referral Fee (${((deal.brokerage_referral_pct || 0) * 100).toFixed(0)}%)`, value: formatCurrency(deal.brokerage_referral_fee) },
              ].map((row) => (
                <div key={row.label} className="flex justify-between py-1.5 text-xs border-b border-border/20">
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className={`tabular-nums ${row.bold ? 'font-semibold text-foreground' : 'font-medium text-foreground'} ${(row as any).color || ''}`}>{row.value}</span>
                </div>
              ))}
              {(deal.balance_deducted || 0) > 0 && (
                <div className="flex justify-between py-1.5 text-xs border-b border-border/20">
                  <span className="text-muted-foreground">Balance Deducted</span>
                  <span className="tabular-nums font-medium text-destructive">-{formatCurrency(deal.balance_deducted)}</span>
                </div>
              )}
              <div className="flex justify-between py-2 text-sm border-b border-primary/20">
                <span className="font-semibold text-primary">Advance Amount</span>
                <span className="font-bold tabular-nums text-primary">{formatCurrency(deal.advance_amount)}</span>
              </div>
              {deal.due_date && (
                <div className="flex justify-between py-1.5 text-xs border-b border-border/20">
                  <span className="text-muted-foreground">Payment Due Date</span>
                  <span className={`tabular-nums font-medium ${deal.payment_status === 'overdue' ? 'text-destructive' : 'text-foreground'}`}>
                    {new Date(deal.due_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                    {deal.payment_status === 'overdue' && ' (OVERDUE)'}
                    {deal.payment_status === 'paid' && ' (PAID)'}
                  </span>
                </div>
              )}
              <div className="flex justify-between rounded-lg px-2.5 py-2 text-sm mt-2 bg-primary/10">
                <span className="font-semibold text-primary">Due from Brokerage</span>
                <span className="font-bold tabular-nums text-primary">{formatCurrency(deal.amount_due_from_brokerage)}</span>
              </div>
              {(() => {
                const brokerageTotal = (deal.brokerage_payments || []).reduce((sum: number, p: any) => sum + p.amount, 0)
                if (brokerageTotal <= 0) return null
                const isFullyPaid = Math.abs(brokerageTotal - deal.amount_due_from_brokerage) < 0.01
                const isOver = brokerageTotal > deal.amount_due_from_brokerage + 0.01
                const statusColor = isFullyPaid ? 'var(--primary)' : isOver ? 'var(--status-red)' : 'var(--status-amber)'
                return (
                  <div className="flex justify-between rounded px-1.5 py-1 text-xs mt-1"
                    style={{ background: isFullyPaid ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : isOver ? 'color-mix(in srgb, var(--status-red) 10%, transparent)' : 'color-mix(in srgb, var(--status-amber) 15%, transparent)' }}>
                    <span className="font-semibold" style={{ color: statusColor }}>Brokerage Payments ({(deal.brokerage_payments || []).length})</span>
                    <span className="font-bold" style={{ color: statusColor }}>{formatCurrency(brokerageTotal)}</span>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>

        {/* UNDERWRITING — collapsible */}
        <div className="rounded-xl overflow-hidden mb-3 bg-card border border-border/50 ff-card-elevated">
          <div
            className="flex items-center justify-between px-5 py-3 cursor-pointer bg-primary/5 border-b border-primary/20 transition-colors hover:bg-primary/[0.07]"
            onClick={() => setUnderwritingExpanded(!underwritingExpanded)}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-primary">
              <Shield className="w-4 h-4" />
              Underwriting
              {checklist.length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  ({checklist.filter(i => i.is_checked || i.is_na).length}/{checklist.length})
                </span>
              )}
              {documents.length > 0 && (
                <span className="text-xs font-normal ml-1 text-muted-foreground">
                  · {documents.length} doc{documents.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            {underwritingExpanded ? <ChevronUp className="w-4 h-4 text-primary" /> : <ChevronDown className="w-4 h-4 text-primary" />}
          </div>
          {underwritingExpanded && (
          <div className="p-4">

          {/* Document bar — compact horizontal list when viewer is open */}
          {viewingDoc && (
            <div className="rounded-lg mb-3 overflow-hidden bg-card border border-border/50">
              <div className="px-4 py-2 flex items-center gap-3 overflow-x-auto border-b border-border/20">
                <Paperclip className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
                <span className="text-xs font-semibold flex-shrink-0 text-primary">Documents ({documents.length})</span>
                <div className="flex items-center gap-1.5 overflow-x-auto">
                  {documents.map(doc => {
                    const isActive = viewingDoc?.fileName === doc.file_name
                    const ext = doc.file_name.toLowerCase().split('.').pop() || ''
                    const isViewable = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
                    return (
                      <button
                        key={doc.id}
                        draggable
                        onDragStart={(e) => handleDocDragStart(e, doc.id)}
                        onDragEnd={handleDocDragEnd}
                        onClick={() => isViewable ? handleDocumentView(doc) : handleDocumentDownload(doc)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-all flex-shrink-0 border ${
                          isActive
                            ? 'bg-primary/10 text-primary border-primary'
                            : 'bg-muted text-muted-foreground border-border/50 hover:border-primary'
                        }`}
                        style={{ opacity: draggingDocId === doc.id ? 0.5 : 1, cursor: 'grab' }}
                      >
                        <FileText className="w-3 h-3" />
                        {doc.file_name.length > 25 ? doc.file_name.slice(0, 22) + '...' : doc.file_name}
                      </button>
                    )
                  })}
                </div>
                <button
                  onClick={() => setShowDocRequest(!showDocRequest)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium flex-shrink-0 bg-primary text-white hover:bg-primary/90 transition-opacity"
                >
                  <Send className="w-3 h-3" />
                  Request
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* LEFT: CHECKLIST */}
            <div className="space-y-2">
              {categorizedChecklist.map((category, catIdx) => (
                <div key={catIdx} className="rounded-xl overflow-hidden bg-card border border-border/50">
                  <button
                    onClick={() => setChecklistExpanded(!checklistExpanded)}
                    className="w-full px-4 py-2.5 flex items-center justify-between text-sm font-semibold transition-colors"
                    style={{ background: category.bg, color: category.color, borderBottom: `1px solid ${category.border}` }}
                  >
                    <div className="flex items-center gap-2">
                      <category.icon className="w-4 h-4" />
                      {category.label}
                      <span className="ml-1 text-xs font-normal opacity-70">({category.items.filter(i => i.is_checked || i.is_na).length}/{category.items.length})</span>
                    </div>
                    {checklistExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>

                  {checklistExpanded && (
                    <div>
                      {category.items.map(item => {
                        const matchingDocs = category.matchingDocs.get(item.id) || []
                        const checked = item.is_checked
                        const na = item.is_na
                        const linkedDoc = item.linked_document_id ? documents.find(d => d.id === item.linked_document_id) : null
                        const isDropTarget = dropTargetItemId === item.id
                        return (
                          <div
                            key={item.id}
                            onClick={() => handleChecklistToggle(item)}
                            onDragOver={(e) => handleChecklistDragOver(e, item)}
                            onDragLeave={handleChecklistDragLeave}
                            onDrop={(e) => handleChecklistDrop(e, item)}
                            className="flex items-start gap-2.5 px-3 py-2 cursor-pointer transition-all duration-200 select-none border-b border-border/20"
                            style={{
                              background: isDropTarget ? 'rgba(95,168,115,0.1)' : na ? 'rgba(100,100,100,0.05)' : checked ? 'rgba(95,168,115,0.05)' : 'transparent',
                              opacity: na ? 0.6 : 1,
                              outline: isDropTarget ? '2px dashed var(--primary)' : 'none',
                              outlineOffset: '-2px',
                            }}
                            onMouseEnter={(e) => { if (!checked && !na && !isDropTarget) e.currentTarget.style.background = 'rgba(95,168,115,0.08)' }}
                            onMouseLeave={(e) => { if (!isDropTarget) e.currentTarget.style.background = na ? 'rgba(100,100,100,0.05)' : checked ? 'rgba(95,168,115,0.05)' : 'transparent' }}
                          >
                            <div className="flex-shrink-0 mt-0.5 transition-transform duration-200" style={{ transform: checked ? 'scale(1.1)' : 'scale(1)' }}>
                              {na ? (
                                <div className="w-5 h-5 rounded-full flex items-center justify-center bg-muted-foreground">
                                  <span className="text-white text-[9px] font-bold leading-none">N/A</span>
                                </div>
                              ) : checked ? (
                                <div className="w-5 h-5 rounded-full flex items-center justify-center bg-primary">
                                  <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                                </div>
                              ) : (
                                <div className="w-5 h-5 rounded-full border-2 transition-colors border-muted-foreground" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm transition-colors duration-200"
                                style={{
                                  color: na ? 'hsl(var(--muted-foreground)/0.5)' : checked ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
                                  fontWeight: checked || na ? 400 : 500,
                                  textDecoration: na ? 'line-through' : 'none',
                                }}>
                                {item.checklist_item}
                              </p>
                              {item.checked_at && !na && (
                                <p className="text-xs mt-0.5 text-muted-foreground/60">
                                  Completed {formatDateTime(item.checked_at)}
                                </p>
                              )}
                              {linkedDoc && (
                                <div className="mt-1 flex items-center gap-1.5">
                                  <span
                                    onClick={(e) => { e.stopPropagation(); handleDocumentDownload(linkedDoc) }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer transition-opacity hover:opacity-80"
                                    style={{
                                      background: checked ? 'rgba(95,168,115,0.15)' : 'rgba(95,168,115,0.1)',
                                      color: 'var(--primary)',
                                      border: `1px solid ${checked ? 'var(--primary)' : 'color-mix(in srgb, var(--primary) 25%, transparent)'}`,
                                    }}
                                  >
                                    <Link2 className="w-3 h-3" />
                                    {linkedDoc.file_name.length > 30 ? linkedDoc.file_name.slice(0, 27) + '...' : linkedDoc.file_name}
                                    {checked && <span className="ml-1 text-[9px] opacity-70">locked</span>}
                                  </span>
                                  {!checked && (
                                    <button
                                      onClick={(e) => handleUnlinkDocument(e, item)}
                                      className="p-0.5 rounded transition-colors text-muted-foreground/60 hover:text-destructive"
                                      title="Unlink document"
                                    >
                                      <Unlink className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              )}
                              {draggingDocId && !linkedDoc && !checked && !na && !isDropTarget && (
                                <p className="text-[10px] mt-1 italic text-muted-foreground/60">
                                  Drop document here
                                </p>
                              )}
                              {matchingDocs.length > 0 && !linkedDoc && (
                                <div className="mt-1.5 space-y-0.5">
                                  {matchingDocs.map(doc => (
                                    <a
                                      key={doc.id}
                                      onClick={(e) => { e.stopPropagation(); handleDocumentDownload(doc) }}
                                      className="text-xs flex items-center gap-1.5 cursor-pointer transition text-primary hover:opacity-70"
                                    >
                                      <FileText className="w-3 h-3" />
                                      {doc.file_name}
                                    </a>
                                  ))}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={(e) => handleChecklistNA(e, item)}
                              className={`flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors border ${
                                na
                                  ? 'text-amber-400 bg-amber-950/20 border-amber-700/40'
                                  : 'text-muted-foreground/60 bg-transparent border-transparent hover:text-muted-foreground hover:border-border/50'
                              }`}
                            >
                              N/A
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* RIGHT COLUMN: DOCUMENTS + MESSAGES */}
            <div className="space-y-3">
            {viewingDoc ? (
              <div className="rounded-xl overflow-hidden flex flex-col bg-card border-2 border-primary sticky top-4 ff-card-elevated"
                style={{ minHeight: 500, maxHeight: 'calc(100vh - 120px)' }}>
                {/* Inline viewer header */}
                <div className="flex items-center justify-between px-3 py-2 flex-shrink-0 border-b border-border/50 bg-primary/5">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText size={13} className="text-primary" />
                    <p className="text-xs font-semibold truncate text-foreground">{viewingDoc.fileName}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => window.open(viewingDoc.originalUrl, '_blank')}
                      className="p-1 rounded transition text-muted-foreground hover:text-primary"
                      title="Open in new tab"
                    >
                      <ExternalLink size={13} />
                    </button>
                    <button
                      onClick={() => window.open(viewingDoc.originalUrl, '_blank')}
                      className="p-1 rounded transition text-muted-foreground hover:text-primary"
                      title="Download"
                    >
                      <Download size={13} />
                    </button>
                    <button
                      onClick={closeDocViewer}
                      className="p-1 rounded transition text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
                {/* Inline viewer content */}
                <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  {viewingDoc.type === 'image' ? (
                    <ImageZoomViewer src={viewingDoc.blobUrl} alt={viewingDoc.fileName} />
                  ) : viewingDoc.pdfData ? (
                    <PdfCanvasViewer pdfData={viewingDoc.pdfData} />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
                      <p className="text-sm text-center text-muted-foreground">Unable to render PDF.</p>
                      <button
                        onClick={() => window.open(viewingDoc.originalUrl, '_blank')}
                        className="px-4 py-2 rounded text-sm font-medium bg-primary text-white hover:bg-primary/90 transition-colors"
                      >Open in New Tab</button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
            <div className="rounded-xl overflow-hidden bg-card border border-border/50">
              <div className="px-5 py-3 flex items-center justify-between bg-primary/5 border-b border-primary/20">
                <button
                  onClick={() => setDocsExpanded(!docsExpanded)}
                  className="flex items-center gap-2 text-sm font-semibold transition-colors text-primary hover:text-primary/80"
                >
                  <Paperclip className="w-4 h-4" />
                  Documents
                  <span className="ml-1 text-xs font-normal opacity-70">({documents.length})</span>
                  {docsExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                <Button
                  onClick={() => setShowDocRequest(!showDocRequest)}
                  size="sm"
                >
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                  Request Doc
                </Button>
              </div>

              {/* DOCUMENT REQUEST FORM */}
              {showDocRequest && (
                <div className="px-6 py-4 border-b border-border/50 bg-muted/20">
                  <p className="text-sm font-semibold mb-3 text-foreground">
                    Request a document from {agent?.first_name || 'agent'}
                  </p>
                  <div className="mb-3">
                    <Label className="text-xs mb-1 block">Document Type</Label>
                    <select
                      value={docRequestType}
                      onChange={(e) => setDocRequestType(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-muted text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">Select document type...</option>
                      {DOCUMENT_TYPES.map(dt => (
                        <option key={dt.value} value={dt.value}>{dt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mb-3">
                    <Label className="text-xs mb-1 block">Message (optional)</Label>
                    <Textarea
                      value={docRequestMessage}
                      onChange={(e) => setDocRequestMessage(e.target.value)}
                      placeholder="Add any instructions or context for the agent..."
                      className="min-h-[60px]"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleRequestDocument}
                      disabled={docRequestSending || !docRequestType}
                      size="sm"
                    >
                      <Send className="w-3.5 h-3.5 mr-1.5" />
                      {docRequestSending ? 'Sending...' : 'Send Request'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setShowDocRequest(false); setDocRequestType(''); setDocRequestMessage('') }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {/* PENDING DOCUMENT REQUESTS */}
              {docsExpanded && docRequests.some(r => r.status === 'pending') && (
                <div className="px-6 py-4 border-l-4 border-l-primary bg-primary/5 border-b border-border/50">
                  <p className="text-sm font-semibold mb-3 text-foreground">
                    Pending Requests ({docRequests.filter(r => r.status === 'pending').length})
                  </p>
                  <div className="space-y-3">
                    {docRequests.filter(r => r.status === 'pending').map(request => (
                      <div key={request.id} className="rounded-lg p-3 bg-card border border-border/50">
                        <div className="flex items-start gap-3 mb-2">
                          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" />
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm text-foreground">
                              {getDocTypeLabel(request.document_type)}
                            </p>
                            {request.message && (
                              <p className="text-xs mt-1 text-muted-foreground">{request.message}</p>
                            )}
                            <p className="text-xs mt-1 text-muted-foreground">
                              Requested {formatDate(request.created_at)}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 ml-7">
                          <button
                            onClick={() => handleFulfillRequest(request)}
                            className="flex items-center gap-1 px-3 py-1 rounded text-xs font-medium bg-primary text-white hover:bg-primary/90 transition-opacity"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Mark Fulfilled
                          </button>
                          <button
                            onClick={() => handleCancelRequest(request)}
                            className="flex items-center gap-1 px-3 py-1 rounded text-xs font-medium bg-muted text-muted-foreground hover:opacity-70 transition-opacity"
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
                <div className="divide-y divide-border/20 max-h-96 overflow-y-auto">
                  {documents.length > 0 ? (
                    documents.map(doc => (
                      <div
                        key={doc.id}
                        draggable
                        onDragStart={(e) => handleDocDragStart(e, doc.id)}
                        onDragEnd={handleDocDragEnd}
                        className="px-4 py-2.5 flex items-center gap-3 transition-colors duration-150 hover:bg-primary/[0.03] group/doc"
                        style={{ opacity: draggingDocId === doc.id ? 0.5 : 1, cursor: 'grab' }}
                      >
                        <GripVertical className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/30 transition-colors group-hover/doc:text-muted-foreground/60" />
                        <FileText className="w-4 h-4 flex-shrink-0 text-primary/70 transition-colors group-hover/doc:text-primary" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate text-foreground transition-colors group-hover/doc:text-primary">{doc.file_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {getDocTypeLabel(doc.document_type)} · {formatFileSize(doc.file_size)} · {formatDate(doc.created_at)}
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
                                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-primary text-white hover:bg-primary/90 transition-colors"
                                style={{ opacity: viewLoading === doc.id ? 0.6 : 1 }}
                              >
                                <Eye className="w-3 h-3" />
                                {viewLoading === doc.id ? '...' : 'View'}
                              </button>
                            ) : null
                          })()}
                          <button
                            onClick={() => handleDocumentDownload(doc)}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-muted text-primary hover:bg-muted/70 transition-colors"
                          >
                            <Download className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => { setReturningDocId(returningDocId === doc.id ? null : doc.id); setReturnReason('') }}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-950/30 text-amber-500 border border-amber-800/30"
                            title="Return to agent"
                          >
                            <Undo2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleDocumentDelete(doc)}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        {/* Document return form */}
                        {returningDocId === doc.id && (
                          <div className="mt-2 p-2 rounded bg-amber-950/20 border border-amber-800/30">
                            <Textarea
                              value={returnReason}
                              onChange={(e) => setReturnReason(e.target.value)}
                              placeholder="Reason for returning this document..."
                              className="text-xs min-h-[50px] mb-2"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleReturnDocument(doc.id)}
                                disabled={returnSending || !returnReason.trim()}
                                className="px-2 py-1 rounded text-xs font-medium text-white disabled:opacity-50 bg-amber-600 hover:bg-amber-700 transition-colors"
                              >
                                {returnSending ? 'Returning...' : 'Return & Notify Agent'}
                              </button>
                              <button
                                onClick={() => { setReturningDocId(null); setReturnReason('') }}
                                className="px-2 py-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                        {docReturns.some(r => r.document_id === doc.id && r.status === 'pending') && (
                          <div className="mt-1 px-2 py-1 rounded text-xs bg-red-950/20 border border-red-800/30 text-destructive">
                            Returned — {docReturns.find(r => r.document_id === doc.id && r.status === 'pending')?.reason}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center">
                      <p className="text-sm text-muted-foreground">No documents uploaded yet</p>
                    </div>
                  )}
                </div>
              )}
            </div>
            )}

            {/* MESSAGES — sits under documents in the right column */}
            <div id="messages" className={`rounded-xl overflow-hidden bg-card border transition-colors ${hasUnreadMessages ? 'border-red-500/50' : 'border-border/50'}`}>
              <div
                className={`flex items-center justify-between px-5 py-3 cursor-pointer border-b transition-colors ${hasUnreadMessages ? 'bg-red-500/10 border-red-500/20 hover:bg-red-500/[0.12]' : 'bg-primary/5 border-primary/20 hover:bg-primary/[0.07]'}`}
                onClick={() => setMessagesExpanded(!messagesExpanded)}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                  <Send className="w-4 h-4" />
                  Messages
                  {hasUnreadMessages && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-600 text-white">
                      New
                    </span>
                  )}
                </div>
                {messagesExpanded ? <ChevronUp className="w-4 h-4 text-primary" /> : <ChevronDown className="w-4 h-4 text-primary" />}
              </div>
              {messagesExpanded && (
                <div className="p-3">
                  {messages.length > 0 && (() => {
                    // Find the last admin message index to mark everything after as "New"
                    let lastAdminIdx = -1
                    for (let i = messages.length - 1; i >= 0; i--) {
                      if (messages[i].sender_role === 'admin') { lastAdminIdx = i; break }
                    }
                    return (
                    <div ref={adminMessagesContainerRef} className="space-y-2 max-h-72 overflow-y-auto mb-2 px-1" style={{ scrollbarWidth: 'thin' }}>
                      {messages.map((msg, idx) => {
                        const isOwn = msg.sender_role === 'admin'
                        const isNew = hasUnreadMessages && !isOwn && idx > lastAdminIdx
                        return (
                        <div key={msg.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                          <div className="max-w-[80%] rounded-xl px-3 py-2"
                            style={{
                              background: isOwn ? 'var(--status-green-muted)' : isNew ? 'rgba(239, 68, 68, 0.08)' : 'hsl(var(--muted)/0.5)',
                              border: `1px solid ${isOwn ? 'var(--status-green-border)' : isNew ? 'rgba(239, 68, 68, 0.3)' : 'hsl(var(--border)/0.5)'}`,
                            }}>
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-[10px] font-semibold" style={{ color: isOwn ? 'var(--status-green)' : 'var(--status-blue)' }}>
                                {isOwn ? 'You' : (msg.sender_name || 'Agent')}
                              </span>
                              {isNew && (
                                <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-red-600 text-white leading-none">New</span>
                              )}
                              {msg.is_email_reply && <span className="text-[10px] px-1 rounded bg-status-blue-border text-status-blue">email</span>}
                              <span className="text-[10px] text-muted-foreground/60">{formatDateTime(msg.created_at)}</span>
                            </div>
                            <p className="text-xs whitespace-pre-wrap text-foreground">{msg.message}</p>
                          </div>
                        </div>
                        )
                      })}
                      <div ref={messagesEndRef} />
                    </div>
                    )
                  })()}
                  {messages.length === 0 && (
                    <p className="text-xs text-center py-1 mb-2 text-muted-foreground">No messages yet</p>
                  )}
                  {showDealQuickReplies && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {ADMIN_QUICK_REPLIES.map((template, idx) => (
                        <button
                          key={idx}
                          onClick={() => { setMessageText(template.message); setShowDealQuickReplies(false) }}
                          className="px-2 py-1 rounded text-[10px] font-medium bg-card text-muted-foreground border border-border/50 hover:border-primary hover:text-primary transition-colors"
                        >
                          {template.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setShowDealQuickReplies(!showDealQuickReplies)}
                      className={`p-1.5 rounded transition-colors flex-shrink-0 border ${showDealQuickReplies ? 'text-primary border-primary' : 'text-muted-foreground border-border/50'}`}
                      title="Quick replies"
                    >
                      <Zap className="w-3 h-3" />
                    </button>
                    <input type="text" value={messageText} onChange={(e) => setMessageText(e.target.value)}
                      placeholder={messages.length === 0 ? 'Message agent... (sends email)' : 'Reply... (sends email)'}
                      className="flex-1 px-2.5 py-1.5 rounded border border-border/50 text-xs focus:outline-none bg-muted text-foreground focus:border-primary"
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
                    />
                    <Button onClick={handleSendMessage} disabled={messageSending || !messageText.trim()}
                      size="sm" className="h-[30px]">
                      <Send className="w-3 h-3 mr-1" />{messageSending ? '...' : 'Send'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>{/* close RIGHT COLUMN wrapper */}

          </div>
          )}
        </div>

        {/* LATE CLOSING INTEREST */}
        {deal && ['funded', 'completed'].includes(deal.status) && (
          <div className="rounded-xl mb-3 overflow-hidden bg-card border border-border/50 ff-card-elevated">
            <button
              onClick={() => setLateInterestExpanded(!lateInterestExpanded)}
              className="w-full px-5 py-3 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-amber-500 bg-amber-500/5 transition-colors hover:bg-amber-500/[0.07] border-b border-amber-500/10"
            >
              <div className="flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                Late Closing Interest
                {deal.late_interest_charged && deal.late_interest_charged > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-950/30 text-destructive">
                    ${deal.late_interest_charged.toFixed(2)} charged
                  </span>
                )}
              </div>
              {lateInterestExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            {lateInterestExpanded && (
              <div className="px-3 py-2">
                {agentBalance > 0 && (
                  <div className="mb-2 px-2 py-1.5 rounded text-xs bg-amber-950/20 border border-amber-800/30 text-amber-500">
                    Agent balance: <strong>${agentBalance.toFixed(2)}</strong>
                  </div>
                )}
                {deal.late_interest_charged && deal.late_interest_charged > 0 && (
                  <div className="mb-2 px-2 py-1.5 rounded text-xs bg-red-950/20 border border-red-800/30 text-destructive">
                    Previously charged: <strong>${deal.late_interest_charged.toFixed(2)}</strong>
                    {deal.actual_closing_date && <span> (actual close: {deal.actual_closing_date})</span>}
                  </div>
                )}
                {!showLateInterest ? (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {deal.late_interest_charged ? 'Interest has been applied.' : 'No late interest charged.'}
                    </p>
                    <button onClick={() => { setShowLateInterest(true); setActualClosingDate(deal.closing_date) }}
                      className="px-2 py-1 rounded text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 transition-colors">
                      Charge Interest
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-medium flex-shrink-0 text-muted-foreground">Actual Close:</label>
                      <input type="date" value={actualClosingDate} onChange={(e) => setActualClosingDate(e.target.value)}
                        className="px-2 py-1 rounded border border-border/50 text-xs focus:outline-none bg-muted text-foreground [color-scheme:dark]"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground">$0.75 per $1,000/day · 5-day grace after {deal.closing_date}</p>
                    <div className="flex gap-1.5">
                      <button onClick={handleChargeLateInterest} disabled={lateInterestSaving || !actualClosingDate}
                        className="px-2.5 py-1 rounded text-xs font-medium text-white disabled:opacity-50 bg-amber-600 hover:bg-amber-700 transition-colors">
                        {lateInterestSaving ? 'Calculating...' : 'Calculate & Charge'}
                      </button>
                      <button onClick={() => setShowLateInterest(false)}
                        className="px-2.5 py-1 rounded text-xs text-muted-foreground bg-muted hover:bg-muted/70 transition-colors">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ADMIN NOTES */}
        <div className="rounded-xl overflow-hidden mb-3 bg-card border border-border/50 ff-card-elevated">
          <div
            className="flex items-center justify-between px-5 py-3 cursor-pointer bg-primary/5 border-b border-primary/20 transition-colors hover:bg-primary/[0.07]"
            onClick={() => setNotesExpanded(!notesExpanded)}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-primary">
              <StickyNote className="w-4 h-4" />
              Admin Notes
              {notesTimeline.length > 0 && <span className="text-xs font-normal text-muted-foreground">({notesTimeline.length})</span>}
            </div>
            {notesExpanded ? <ChevronUp className="w-4 h-4 text-primary" /> : <ChevronDown className="w-4 h-4 text-primary" />}
          </div>
          {notesExpanded && (
            <div className="p-4">
              <div className="flex gap-1.5 mb-3">
                <input type="text" value={newNoteText} onChange={(e) => setNewNoteText(e.target.value)}
                  placeholder="Add a note... (Ctrl+Enter)"
                  className="flex-1 px-2.5 py-1.5 rounded border border-border/50 text-xs focus:outline-none bg-muted text-foreground focus:border-primary"
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAddNote() }}
                />
                <Button onClick={handleAddNote} disabled={addingNote || !newNoteText.trim()}
                  size="sm" className="bg-blue-700 hover:bg-blue-800">
                  <Plus className="w-3 h-3 mr-1" />{addingNote ? '...' : 'Add'}
                </Button>
              </div>
              {notesTimeline.length > 0 ? (
                <div className="space-y-1.5 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                  {[...notesTimeline].reverse().map((note) => (
                    <div key={note.id} className="rounded-lg px-3 py-2 bg-muted/20 border border-border/20 transition-colors hover:border-border/40">
                      <p className="text-xs whitespace-pre-wrap text-foreground leading-relaxed">{note.text}</p>
                      <p className="text-[10px] mt-1.5 text-muted-foreground/60">{note.author_name} · {formatDateTime(note.created_at)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-center py-1 text-muted-foreground">No notes yet</p>
              )}
              {adminNotes && (
                <div className="mt-3 pt-3 border-t border-border/20">
                  <p className="text-[10px] font-semibold mb-0.5 text-muted-foreground">Legacy Notes</p>
                  <p className="text-[10px] whitespace-pre-wrap text-muted-foreground/60">{adminNotes}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* AUDIT TRAIL */}
        {deal && (
          <div className="rounded-xl overflow-hidden bg-card border border-border/50 ff-card-elevated">
            <div
              className="flex items-center justify-between px-5 py-3 cursor-pointer bg-primary/5 border-b border-primary/20 transition-colors hover:bg-primary/[0.07]"
              onClick={() => setAuditExpanded(!auditExpanded)}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                <Shield className="w-4 h-4" />
                Audit Trail
              </div>
              {auditExpanded ? <ChevronUp className="w-4 h-4 text-primary" /> : <ChevronDown className="w-4 h-4 text-primary" />}
            </div>
            {auditExpanded && (
              <div className="p-4 max-h-[500px] overflow-y-auto">
                <AuditTimeline entityType="deal" entityId={deal.id} />
              </div>
            )}
          </div>
        )}

        {/* DELETE DEAL */}
        {deal && ['under_review', 'cancelled', 'denied'].includes(deal.status) && (
          <div className="mt-6 rounded-xl p-4 bg-card border border-destructive/30 ff-card-elevated">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-destructive">Delete This Deal</p>
                <p className="text-xs mt-0.5 text-muted-foreground">Permanently removes this deal and all associated documents and checklist items. This cannot be undone.</p>
              </div>
              <Button
                variant="destructive"
                size="sm"
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
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete Deal
              </Button>
            </div>
          </div>
        )}

      </main>
      </div>
    </div>
  )
}
