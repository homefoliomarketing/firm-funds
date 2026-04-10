'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft, FileText, DollarSign, MapPin, Clock,
  Upload, Download, ChevronDown, ChevronUp, Paperclip,
  CheckCircle2, AlertTriangle, Pencil, Save, X, Send
} from 'lucide-react'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'
import {
  MAX_UPLOAD_SIZE_BYTES,
  ALLOWED_UPLOAD_EXTENSIONS,
  DOCUMENT_TYPES as DOC_TYPES,
  getStatusBadgeClass,
  formatStatusLabel,
} from '@/lib/constants'
import { updateDealDetails, cancelDeal } from '@/lib/actions/deal-actions'
import { sendAgentReply, markDealMessagesRead } from '@/lib/actions/notification-actions'
import { submitClosingDateAmendment, getDealAmendments } from '@/lib/actions/amendment-actions'
import { CalendarClock } from 'lucide-react'
import { AlertCircle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

interface Deal {
  id: string; agent_id: string; brokerage_id: string; status: string
  property_address: string; closing_date: string; gross_commission: number
  brokerage_split_pct: number; net_commission: number; days_until_closing: number
  discount_fee: number; settlement_period_fee: number; advance_amount: number; brokerage_referral_fee: number
  amount_due_from_brokerage: number; balance_deducted: number; due_date: string | null
  payment_status: string; funding_date: string | null
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

interface DocumentReturnItem {
  id: string; document_id: string; reason: string; status: string; created_at: string
}

interface DealMessageItem {
  id: string; sender_role: string; sender_name: string | null; message: string
  is_email_reply: boolean; created_at: string
}

const DOCUMENT_TYPES = DOC_TYPES

export default function AgentDealDetailPage() {
  const [deal, setDeal] = useState<Deal | null>(null)
  const [documents, setDocuments] = useState<DealDocument[]>([])
  const [docRequests, setDocRequests] = useState<DocumentRequest[]>([])
  const [docReturns, setDocReturns] = useState<DocumentReturnItem[]>([])
  const [dealMessages, setDealMessages] = useState<DealMessageItem[]>([])
  const [replyText, setReplyText] = useState('')
  const [replySending, setReplySending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const initialMessageCountRef = useRef<number | null>(null)
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
  // Closing date amendment state
  const [showAmendmentModal, setShowAmendmentModal] = useState(false)
  const [amendNewClosingDate, setAmendNewClosingDate] = useState('')
  const [amendFile, setAmendFile] = useState<File | null>(null)
  const [amendSubmitting, setAmendSubmitting] = useState(false)
  const [amendError, setAmendError] = useState<string | null>(null)
  const [amendments, setAmendments] = useState<any[]>([])
  const router = useRouter()
  const params = useParams()
  const dealId = params.id as string
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  useEffect(() => { loadDealData() }, [dealId])

  // Scroll message container to bottom (not the page)
  const scrollMessagesToBottom = useCallback(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    if (!loading && window.location.hash) {
      const hash = window.location.hash.substring(1)
      setTimeout(() => {
        const target = document.getElementById(hash)
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' })
          if (hash === 'messages') {
            setTimeout(scrollMessagesToBottom, 400)
          }
        }
      }, 200)
    }
  }, [loading, scrollMessagesToBottom])

  useEffect(() => {
    if (dealMessages.length > 0) {
      if (initialMessageCountRef.current === null) {
        initialMessageCountRef.current = dealMessages.length
        // Scroll to bottom on initial load
        requestAnimationFrame(scrollMessagesToBottom)
        setTimeout(scrollMessagesToBottom, 200)
      } else if (dealMessages.length > initialMessageCountRef.current) {
        scrollMessagesToBottom()
        initialMessageCountRef.current = dealMessages.length
      }
    }
  }, [dealMessages.length, scrollMessagesToBottom])

  // Auto-mark messages as read when agent views this deal page
  useEffect(() => {
    if (dealMessages.length > 0 && dealMessages.some(m => m.sender_role === 'admin')) {
      const doMark = async () => {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return
        const { data: profile } = await supabase.from('user_profiles').select('agent_id').eq('id', user.id).single()
        if (profile?.agent_id) {
          void markDealMessagesRead({ agentId: profile.agent_id, dealId })
        }
      }
      doMark()
    }
  }, [dealMessages.length, dealId])

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
    const { data: returnsData } = await supabase.from('document_returns').select('*').eq('deal_id', dealId).eq('status', 'pending').order('created_at', { ascending: false })
    setDocReturns(returnsData || [])
    const { data: messagesData } = await supabase.from('deal_messages').select('*').eq('deal_id', dealId).order('created_at', { ascending: true })
    setDealMessages(messagesData || [])
    // Load amendments for this deal
    const amendResult = await getDealAmendments(dealId)
    if (amendResult.success) setAmendments(amendResult.data || [])
    setLoading(false)
  }

  const handleSubmitAmendment = async () => {
    if (!deal || !amendNewClosingDate || !amendFile) {
      setAmendError('Please fill in all fields and upload the executed amendment.')
      return
    }
    setAmendSubmitting(true)
    setAmendError(null)
    const formData = new FormData()
    formData.append('dealId', deal.id)
    formData.append('newClosingDate', amendNewClosingDate)
    formData.append('file', amendFile)
    const result = await submitClosingDateAmendment(formData)
    if (result.success) {
      setShowAmendmentModal(false)
      setAmendNewClosingDate('')
      setAmendFile(null)
      setStatusMessage({ type: 'success', text: 'Amendment request submitted. Admin will review and approve.' })
      // Reload amendments
      const amendResult = await getDealAmendments(deal.id)
      if (amendResult.success) setAmendments(amendResult.data || [])
    } else {
      setAmendError(result.error || 'Failed to submit amendment')
    }
    setAmendSubmitting(false)
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

  const handleSendReply = async () => {
    if (!deal || !replyText.trim()) return
    setReplySending(true)
    const result = await sendAgentReply({ dealId: deal.id, message: replyText.trim() })
    if (result.success && result.data) {
      setDealMessages(prev => [...prev, result.data])
      setReplyText('')
      setStatusMessage({ type: 'success', text: 'Message sent' })
    } else {
      setStatusMessage({ type: 'error', text: result.error || 'Failed to send message' })
    }
    setReplySending(false)
  }

  const handleDocumentDownload = async (doc: DealDocument) => {
    const { data, error } = await supabase.storage
      .from('deal-documents')
      .createSignedUrl(doc.file_path, 3600, { download: false })
    if (error || !data?.signedUrl) {
      setStatusMessage({ type: 'error', text: 'Failed to generate download link' }); return
    }
    window.open(data.signedUrl, '_blank')
  }

  const startEditing = () => {
    if (!deal) return
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

  const statusBadgeClass = getStatusBadgeClass

  if (loading) return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
          <Skeleton className="h-5 w-48 mb-2" />
          <Skeleton className="h-3 w-32" />
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Card className="mb-6 p-6">
          <Skeleton className="h-2 w-full rounded-full mb-4" />
          <div className="flex gap-1.5">
            {[1,2,3,4,5,6].map(i => (<Skeleton key={i} className="flex-1 h-2 rounded-full" />))}
          </div>
        </Card>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {[1,2].map(i => (
              <Card key={i} className="p-6">
                <Skeleton className="h-4 w-28 mb-4" />
                {[1,2,3].map(j => (<Skeleton key={j} className="h-3 w-full mb-3" />))}
              </Card>
            ))}
          </div>
          <div className="space-y-6">
            <Card className="p-6">
              <Skeleton className="h-3 w-20 mb-4" />
              {[1,2,3,4].map(j => (<Skeleton key={j} className="h-3 w-full mb-3" />))}
            </Card>
          </div>
        </div>
      </main>
    </div>
  )

  if (!deal) return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-lg text-muted-foreground">Deal not found</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm sticky top-0 z-40 border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-8 sm:h-10 w-auto" />
              <div className="w-px h-6 bg-border" />
              <button
                onClick={() => router.push('/agent')}
                className="flex items-center gap-1.5 text-sm transition-colors text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft size={16} />
                <span className="hidden sm:inline">Back</span>
              </button>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <span
                className={`inline-flex px-2.5 py-1 text-xs sm:text-sm font-semibold rounded-lg ${statusBadgeClass(deal.status)}`}
              >
                {formatStatusLabel(deal.status)}
              </span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-bold text-foreground leading-tight">{deal.property_address}</h1>
            <p className="text-xs mt-0.5 text-muted-foreground">Submitted {formatDateTime(deal.created_at)}</p>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Status Message */}
        {statusMessage && (
          <div className={`mb-6 p-4 rounded-xl text-sm font-medium border ${
            statusMessage.type === 'success'
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'bg-destructive/10 border-destructive/30 text-destructive'
          }`}>
            {statusMessage.text}
          </div>
        )}

        {/* Document Requests Banner */}
        {docRequests.length > 0 && (
          <Card className="mb-6 border-primary/30">
            <CardContent className="px-6 py-5 flex gap-4">
              <div className="flex-shrink-0 mt-0.5">
                <AlertCircle size={20} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-sm mb-3 text-foreground">
                  Firm Funds has requested the following documents for this deal:
                </h3>
                <div className="space-y-2">
                  {docRequests.map((request) => (
                    <div key={request.id} className="text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-foreground">{getDocTypeLabel(request.document_type)}</p>
                          {request.message && (
                            <p className="text-xs mt-1 text-muted-foreground">{request.message}</p>
                          )}
                          <p className="text-xs mt-1 text-muted-foreground/60">Requested {formatDate(request.created_at)}</p>
                        </div>
                        <Button
                          size="sm"
                          className="flex-shrink-0 whitespace-nowrap text-xs"
                          onClick={scrollToDocumentSection}
                        >
                          Upload
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Deal Pipeline */}
        <Card className="mb-6">
          <CardContent className="p-6">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider mb-4 text-muted-foreground/70">Deal Progress</h3>
            <div className="flex items-center gap-1.5">
              {['under_review', 'approved', 'funded', 'completed'].map((status, index) => {
                const isActive = status === deal.status
                const isPast = ['under_review', 'approved', 'funded', 'completed'].indexOf(deal.status) > index
                const isDenied = deal.status === 'denied'
                const barColor = isDenied ? 'var(--status-red)' : isActive ? 'var(--primary)' : isPast ? 'var(--action-green)' : 'hsl(var(--muted))'
                const labelColor = isDenied ? 'var(--action-red)' : isActive ? 'var(--primary)' : isPast ? 'var(--action-green)' : 'hsl(var(--muted-foreground))'
                return (
                  <div key={status} className="flex-1">
                    <div className="h-1.5 rounded-full" style={{ background: barColor }} />
                    <p className={`text-xs mt-1.5 text-center ${isActive ? 'font-bold' : isPast ? 'font-medium' : ''}`} style={{ color: labelColor }}>
                      {formatStatusLabel(status)}
                    </p>
                  </div>
                )
              })}
            </div>
            {deal.status === 'denied' && (
              <div className="mt-4 p-3 rounded-lg flex items-start gap-2 bg-destructive/10 border border-destructive/30">
                <AlertTriangle size={16} className="text-destructive mt-0.5 flex-shrink-0" />
                <p className="text-sm text-destructive"><strong>Denied:</strong> {deal.denial_reason || 'No reason provided'}</p>
              </div>
            )}
            {deal.status === 'cancelled' && (
              <div className="mt-4 p-3 rounded-lg flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30">
                <AlertTriangle size={16} className="text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-yellow-600 dark:text-yellow-400"><strong>Cancelled</strong> — This advance request was cancelled.</p>
              </div>
            )}
            {['under_review', 'approved'].includes(deal.status) && (
              <div className="mt-4 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
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
                  className="text-destructive border-destructive/30 hover:bg-destructive/10"
                >
                  <X size={14} />
                  {cancelling ? (deal.status === 'under_review' ? 'Withdrawing...' : 'Cancelling...') : (deal.status === 'under_review' ? 'Withdraw Request' : 'Cancel This Advance')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column */}
          <div className="lg:col-span-2 space-y-6">

            {/* Deal Details */}
            <Card>
              <CardHeader className="border-b border-border bg-card/80 flex flex-row items-center justify-between py-4">
                <CardTitle className="flex items-center gap-2 text-base">
                  <MapPin size={16} className="text-primary" />
                  Deal Details
                </CardTitle>
                {deal.status === 'under_review' && !editing && (
                  <button
                    onClick={startEditing}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors text-primary border border-border hover:bg-muted hover:border-primary"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                )}
              </CardHeader>
              <CardContent className="p-6">
                {editing ? (
                  <>
                    <div className="space-y-4 text-sm">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Street Address</Label>
                        <Input type="text" value={editStreetAddress} onChange={(e) => setEditStreetAddress(e.target.value)} placeholder="123 Main Street" />
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">City</Label>
                          <Input type="text" value={editCity} onChange={(e) => setEditCity(e.target.value)} placeholder="Toronto" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Province</Label>
                          <Input type="text" value={editProvince} onChange={(e) => setEditProvince(e.target.value)} placeholder="Ontario" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Postal Code</Label>
                          <Input type="text" value={editPostalCode} onChange={(e) => setEditPostalCode(e.target.value)} placeholder="M5V 1A1" maxLength={7} className="uppercase" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Closing Date</Label>
                          <Input type="date" value={editClosingDate} onChange={(e) => setEditClosingDate(e.target.value)} min={new Date(Date.now() + 86400000).toISOString().split('T')[0]} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Gross Commission ($)</Label>
                          <Input type="number" value={editGrossCommission} onChange={(e) => setEditGrossCommission(e.target.value)} min="0" step="0.01" />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Brokerage Split (%)</Label>
                        <Input type="number" value={editBrokerageSplitPct} onChange={(e) => setEditBrokerageSplitPct(e.target.value)} min="0" max="100" step="0.1" />
                      </div>
                    </div>
                    <div className="flex gap-3 mt-5">
                      <Button variant="outline" onClick={cancelEditing} disabled={saving} className="flex-1">
                        <X size={14} className="mr-1.5" /> Cancel
                      </Button>
                      <Button onClick={handleSaveEdit} disabled={saving} className="flex-1">
                        <Save size={14} className="mr-1.5" /> {saving ? 'Saving...' : 'Save Changes'}
                      </Button>
                    </div>
                    <p className="text-xs mt-3 text-muted-foreground">Saving will recalculate your advance amount based on the updated details.</p>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-5 text-sm">
                      <div><p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Property Address</p><p className="font-medium text-foreground">{deal.property_address}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Closing Date</p><p className="font-medium text-foreground">{formatDate(deal.closing_date)}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Days Until Closing</p><p className="font-medium text-foreground">{deal.days_until_closing} days</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Source</p><p className="font-medium text-foreground">{deal.source === 'manual_portal' ? 'Agent Portal' : deal.source === 'nexone_auto' ? 'Nexone Auto' : deal.source}</p></div>
                      {deal.funding_date && (<div><p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Funding Date</p><p className="font-medium text-foreground">{formatDate(deal.funding_date)}</p></div>)}
                      {deal.repayment_date && (<div><p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Repayment Date</p><p className="font-medium text-foreground">{formatDate(deal.repayment_date)}</p></div>)}
                    </div>
                    {deal.notes && (
                      <div className="mt-5 pt-4 border-t border-border">
                        <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Notes</p>
                        <p className="text-sm whitespace-pre-line text-foreground">{deal.notes.replace(/^Transaction type: \w+\n?/, '').trim() || 'No additional notes'}</p>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Documents Section */}
            <div className="rounded-xl overflow-hidden bg-card border border-border" data-section="documents">
              <div
                className="px-6 py-4 flex items-center justify-between cursor-pointer transition-colors border-b border-border hover:bg-muted/50"
                style={{ borderBottom: docsExpanded ? undefined : 'none' }}
                onClick={() => setDocsExpanded(!docsExpanded)}
              >
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Paperclip size={16} className="text-primary" />
                    <h3 className="text-base font-bold text-foreground">Documents</h3>
                  </div>
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-md bg-muted text-muted-foreground border border-border">
                    {documents.length} file{documents.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {docsExpanded
                  ? <ChevronUp size={16} className="text-muted-foreground" />
                  : <ChevronDown size={16} className="text-muted-foreground" />}
              </div>
              {docsExpanded && (
                <div className="p-6">
                  {/* Upload Area */}
                  <div className="rounded-xl p-6 mb-6 text-center transition-colors border-2 border-dashed border-border hover:border-primary">
                    <Upload className="mx-auto mb-2 text-primary" size={28} />
                    <p className="text-sm mb-3 text-muted-foreground">Upload documents for this deal</p>
                    <div className="flex items-center justify-center gap-3 mb-3">
                      <select
                        value={uploadDocType}
                        onChange={(e) => setUploadDocType(e.target.value)}
                        className="rounded-lg px-3 py-2 text-sm bg-background border border-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {DOCUMENT_TYPES.map(dt => (<option key={dt.value} value={dt.value}>{dt.label}</option>))}
                      </select>
                    </div>
                    <label className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg font-medium text-sm cursor-pointer transition-colors hover:bg-primary/90">
                      <Upload size={16} />{uploading ? 'Uploading...' : 'Choose Files'}
                      <input type="file" multiple onChange={handleFileUpload} disabled={uploading} className="hidden" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.xls,.xlsx,.csv,.txt" />
                    </label>
                    <p className="text-xs mt-2 text-muted-foreground/60">PDF, Word, Excel, Images up to 10MB each</p>
                  </div>

                  {/* Document List */}
                  {documents.length === 0 ? (
                    <div className="text-center py-6">
                      <FileText className="mx-auto mb-3 text-muted-foreground/40" size={32} />
                      <p className="text-sm text-muted-foreground">No documents uploaded yet</p>
                      <p className="text-xs mt-1 text-muted-foreground/60">Upload your APS, trade sheet, and other documents to speed up your advance.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {documents.map((doc) => (
                        <div
                          key={doc.id}
                          className="flex items-center justify-between p-3 rounded-lg transition-colors bg-muted/50 hover:bg-muted"
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <FileText size={18} className="text-primary flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate text-foreground">{doc.file_name}</p>
                              <p className="text-xs text-muted-foreground">{getDocTypeLabel(doc.document_type)} · {formatFileSize(doc.file_size)} · {formatDateTime(doc.created_at)}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => handleDocumentDownload(doc)}
                            className="p-2 rounded-lg transition-colors flex-shrink-0 ml-2 text-muted-foreground hover:text-primary hover:bg-primary/10"
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
            <Card>
              <CardHeader className="border-b border-border bg-card/80 py-4">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-primary">
                  <DollarSign size={14} />Financial Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Gross Commission</span><span className="font-medium text-foreground">{formatCurrency(deal.gross_commission)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Brokerage Split ({deal.brokerage_split_pct}%)</span><span className="font-medium text-destructive">-{formatCurrency(deal.gross_commission - deal.net_commission)}</span></div>
                <div className="flex justify-between pt-2 border-t border-border"><span className="font-medium text-foreground">Your Net Commission</span><span className="font-semibold text-foreground">{formatCurrency(deal.net_commission)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Discount Fee ({deal.days_until_closing}d)</span><span className="font-medium text-destructive">-{formatCurrency(deal.discount_fee)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Settlement Period Fee</span><span className="font-medium text-destructive">-{formatCurrency(deal.settlement_period_fee || 0)}</span></div>
                {(deal.balance_deducted || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Balance Deducted</span><span className="font-medium text-destructive">-{formatCurrency(deal.balance_deducted)}</span></div>
                )}
                <div className="flex justify-between items-center rounded-xl px-4 py-3 -mx-1 mt-2 bg-primary/8 border border-primary/20 shadow-sm shadow-primary/5">
                  <span className="font-bold text-primary">Advance Amount</span>
                  <span className="font-bold text-lg text-primary">{formatCurrency(deal.advance_amount)}</span>
                </div>
                {deal.due_date && (
                  <div className="flex justify-between pt-2 border-t border-border">
                    <span className="text-muted-foreground">Payment Due Date</span>
                    <span className={`font-medium ${deal.payment_status === 'overdue' ? 'text-destructive' : 'text-foreground'}`}>
                      {new Date(deal.due_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                )}
                {['approved', 'funded'].includes(deal.status) && (
                  <div className="pt-3 mt-1 border-t border-border">
                    {amendments.some(a => a.status === 'pending') ? (
                      <div className="rounded-lg px-3 py-2 bg-amber-500/10 border border-amber-500/30 text-xs">
                        <div className="flex items-center gap-1.5 font-semibold text-amber-500 mb-0.5">
                          <Clock size={12} />
                          Amendment Pending Review
                        </div>
                        <p className="text-muted-foreground">An admin is reviewing your closing date amendment request.</p>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setShowAmendmentModal(true)}
                      >
                        <CalendarClock size={14} className="mr-1.5" />
                        Amend Closing Date
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Timeline */}
            <Card>
              <CardHeader className="border-b border-border bg-card/80 py-4">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-primary">
                  <Clock size={14} />Deal Timeline
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {(() => {
                  const events: { label: string; date: string | null; color: string; active: boolean }[] = [
                    { label: 'Submitted', date: deal.created_at, color: 'var(--status-green)', active: true },
                    { label: 'Under Review', date: ['under_review', 'approved', 'funded', 'completed'].includes(deal.status) ? deal.created_at : null, color: 'var(--status-blue)', active: deal.status === 'under_review' },
                    { label: 'Approved', date: ['approved', 'funded', 'completed'].includes(deal.status) ? (deal.funding_date || deal.created_at) : null, color: 'var(--status-green)', active: deal.status === 'approved' },
                    { label: 'Funded', date: deal.funding_date, color: 'var(--status-purple)', active: deal.status === 'funded' },
                    { label: 'Completed', date: deal.repayment_date, color: 'var(--status-teal)', active: deal.status === 'completed' },
                  ]
                  if (deal.status === 'denied') {
                    events.push({ label: 'Denied', date: deal.updated_at, color: 'var(--destructive)', active: true })
                  }
                  if (deal.status === 'cancelled') {
                    events.push({ label: 'Cancelled', date: deal.updated_at, color: 'var(--warning)', active: true })
                  }

                  return (
                    <div className="space-y-0">
                      {events.map((event, idx) => {
                        const isCompleted = event.date !== null
                        const isLast = idx === events.length - 1 || !events[idx + 1]?.date
                        return (
                          <div key={event.label} className="flex items-start gap-3 relative">
                            {!isLast && isCompleted && (
                              <div style={{
                                position: 'absolute', left: '7px', top: '18px', bottom: '-4px',
                                width: '2px', background: 'hsl(var(--border))',
                              }} />
                            )}
                            <div className="flex-shrink-0 mt-1" style={{
                              width: '16px', height: '16px', borderRadius: '50%',
                              background: isCompleted ? event.color : 'hsl(var(--muted))',
                              border: isCompleted ? 'none' : '2px solid hsl(var(--border))',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              {isCompleted && <CheckCircle2 size={16} className="text-white" />}
                            </div>
                            <div className="pb-4">
                              <p className={`text-sm ${event.active ? 'font-bold' : 'font-medium'} ${isCompleted ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                                {event.label}
                              </p>
                              {isCompleted && event.date && (
                                <p className="text-xs text-muted-foreground">
                                  {event.label === 'Submitted' ? formatDateTime(event.date) : formatDate(event.date)}
                                </p>
                              )}
                              {!isCompleted && (
                                <p className="text-xs text-muted-foreground/50">Pending</p>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </CardContent>
            </Card>

            {/* RETURNED DOCUMENTS ALERT */}
            {docReturns.length > 0 && (
              <div id="returned-docs" className="rounded-xl p-4 bg-status-red-muted border border-status-red-border">
                <h4 className="text-xs font-bold uppercase tracking-wider mb-2 text-destructive">
                  Action Required — Returned Documents
                </h4>
                <div className="space-y-2">
                  {docReturns.map(ret => {
                    const doc = documents.find(d => d.id === ret.document_id)
                    return (
                      <div key={ret.id} className="px-3 py-2 rounded bg-status-red-muted border border-status-red-border">
                        <p className="text-xs font-semibold text-status-red">{doc?.file_name || 'Document'}</p>
                        <p className="text-xs mt-1 text-muted-foreground">Reason: {ret.reason}</p>
                        <p className="text-xs mt-1 text-muted-foreground/60">Please upload a corrected version below.</p>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* MESSAGES */}
            <div id="messages" className="rounded-xl overflow-hidden bg-card border border-border/40">
              <div className="px-4 py-3 border-b border-border/40">
                <h4 className="text-xs font-bold uppercase tracking-wider text-primary">Messages</h4>
              </div>
              <div className="p-4">
                {dealMessages.length > 0 ? (
                  <div ref={messagesContainerRef} className="space-y-2 max-h-56 overflow-y-auto mb-3 px-1" style={{ scrollbarWidth: 'thin' }}>
                    {dealMessages.map(msg => {
                      const isOwn = msg.sender_role === 'agent'
                      return (
                      <div key={msg.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[80%] rounded-xl px-3 py-2" style={{
                          background: isOwn ? 'hsl(var(--card))' : 'var(--status-green-muted)',
                          border: `1px solid ${isOwn ? 'hsl(var(--border))' : 'var(--status-green-border)'}`,
                        }}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-semibold" style={{ color: isOwn ? 'var(--status-blue)' : 'var(--status-green)' }}>
                              {isOwn ? 'You' : 'Firm Funds Agent'}
                            </span>
                            <span className="text-[10px] text-muted-foreground/60">
                              {new Date(msg.created_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          <p className="text-xs whitespace-pre-wrap text-foreground">{msg.message}</p>
                        </div>
                      </div>
                      )
                    })}
                    <div ref={messagesEndRef} />
                  </div>
                ) : (
                  <p className="text-xs mb-3 text-muted-foreground/60">No messages yet. Send a message to the Firm Funds team below.</p>
                )}
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder={dealMessages.length > 0 ? 'Type a reply...' : 'Type a message...'}
                    className="flex-1 text-xs"
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendReply() } }}
                  />
                  <Button
                    size="sm"
                    disabled={replySending || !replyText.trim()}
                    onClick={handleSendReply}
                  >
                    <Send size={12} />
                    {replySending ? '...' : 'Send'}
                  </Button>
                </div>
              </div>
            </div>

            {/* What Happens Next */}
            {(() => {
              const tips: Record<string, { title: string; message: string; color: string; bg: string; border: string }> = {
                under_review: { title: 'Under Review', message: 'Our team is reviewing your deal. Upload all required documents to speed up the process.', color: 'var(--status-blue)', bg: 'var(--status-blue-muted)', border: 'var(--status-blue-border)' },
                approved: { title: 'Approved!', message: 'Your advance has been approved. Funding will be processed shortly — typically within 24 hours.', color: 'var(--status-green)', bg: 'var(--status-green-muted)', border: 'var(--status-green-border)' },
                funded: { title: 'Funded', message: 'Your advance has been sent! The amount will be recovered from the proceeds at closing.', color: 'var(--status-purple)', bg: 'var(--status-purple-muted)', border: 'var(--status-purple-border)' },
                completed: { title: 'Completed', message: 'This advance is complete. The amount has been recovered from the closing proceeds. No further action needed.', color: 'var(--status-teal)', bg: 'var(--status-teal-muted)', border: 'var(--status-teal-border)' },
              }
              const tip = tips[deal.status]
              if (!tip) return null

              return (
                <div className="rounded-xl p-4" style={{ background: tip.bg, border: `1px solid ${tip.border}` }}>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-1.5" style={{ color: tip.color }}>{tip.title}</h4>
                  <p className="text-xs leading-relaxed" style={{ color: tip.color, opacity: 0.85 }}>{tip.message}</p>
                </div>
              )
            })()}

          </div>
        </div>
      </main>

      {/* Closing Date Amendment Modal */}
      {showAmendmentModal && deal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => !amendSubmitting && setShowAmendmentModal(false)}>
          <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="border-b border-border">
              <CardTitle className="flex items-center gap-2 text-primary">
                <CalendarClock size={18} />
                Amend Closing Date
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5 space-y-4">
              <div className="rounded-lg p-3 bg-muted/30 border border-border text-xs space-y-1">
                <p><span className="text-muted-foreground">Current closing date:</span> <span className="font-semibold text-foreground">{new Date(deal.closing_date + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}</span></p>
                <p><span className="text-muted-foreground">Current advance:</span> <span className="font-semibold text-foreground">{formatCurrency(deal.advance_amount)}</span></p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">New Closing Date</Label>
                <Input
                  type="date"
                  value={amendNewClosingDate}
                  onChange={(e) => setAmendNewClosingDate(e.target.value)}
                  disabled={amendSubmitting}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Executed Amendment Document</Label>
                <Input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                  onChange={(e) => setAmendFile(e.target.files?.[0] || null)}
                  disabled={amendSubmitting}
                />
                <p className="text-[11px] text-muted-foreground/70">Upload the fully executed amendment to the Agreement of Purchase and Sale. PDF preferred.</p>
              </div>

              <div className="rounded-lg px-3 py-2 bg-blue-500/10 border border-blue-500/20 text-xs">
                <p className="text-blue-400 leading-relaxed">
                  <strong>What happens next:</strong> Admin will review your request and the uploaded amendment. Once approved, you'll receive a new DocuSign email to sign the amended CPA.
                </p>
                {deal.status === 'funded' && (
                  <p className="text-blue-400 leading-relaxed mt-2">
                    <strong>Note:</strong> Because this deal has already been funded, your Purchase Price stays the same. If the new closing date is <em>later</em>, the additional discount fee will be charged to your Firm Funds account. If the new closing date is <em>earlier</em>, the unused discount fee will be credited to your account and refunded via EFT after closing. The Settlement Period Fee is non-refundable.
                  </p>
                )}
              </div>

              {amendError && (
                <div className="rounded-lg px-3 py-2 bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                  {amendError}
                </div>
              )}

              <div className="flex gap-2 justify-end pt-2">
                <Button
                  variant="outline"
                  onClick={() => setShowAmendmentModal(false)}
                  disabled={amendSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmitAmendment}
                  disabled={amendSubmitting || !amendNewClosingDate || !amendFile}
                >
                  {amendSubmitting ? 'Submitting...' : 'Submit Request'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
