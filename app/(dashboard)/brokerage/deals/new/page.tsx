'use client'

import { Suspense, useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft, Calculator, Send, DollarSign, MapPin,
  Upload, FileText, X, Loader2, User as UserIcon,
} from 'lucide-react'
import { calculateDealPreviewForBrokerage, submitDealAsBrokerage, uploadDocument, createRevisedDealFromDenied, getDealSubmissionGate } from '@/lib/actions/deal-actions'
import { resendAgentWelcomeEmail } from '@/lib/actions/admin-actions'
import { formatCurrency } from '@/lib/formatting'
import { BROKERAGE_PUBLIC_COLUMNS } from '@/lib/constants'
import BrokerageBrandLogo from '@/components/BrokerageBrandLogo'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import AddressAutocomplete, { type AddressParts } from '@/components/AddressAutocomplete'
import {
  FileUploadProgress,
  buildUploadItems,
  type FileUploadItem,
} from '@/components/ui/file-upload-progress'
import type { Brokerage, UserProfile } from '@/types/database'

type BrokeragePublic = Pick<Brokerage, 'id' | 'name' | 'logo_url' | 'logo_includes_tagline' | 'email' | 'profit_share_pct' | 'is_white_label_partner'>

interface AgentRow {
  id: string
  first_name: string
  last_name: string
  email: string | null
  status: string
  account_activated_at: string | null
  kyc_status: string | null
  banking_approval_status: string | null
}

const DOC_SLOTS: { key: string; label: string; required: boolean; types: string }[] = [
  { key: 'trade_record', label: 'Trade record', required: true, types: 'application/pdf,image/jpeg,image/png' },
  { key: 'aps', label: 'Agreement of Purchase & Sale', required: true, types: 'application/pdf,image/jpeg,image/png' },
  { key: 'amendment', label: 'Amendments', required: false, types: 'application/pdf,image/jpeg,image/png' },
  { key: 'other', label: 'Waivers / other', required: false, types: 'application/pdf,image/jpeg,image/png' },
]

// useSearchParams() requires a Suspense boundary in Next.js 16. The inner
// component renders inside the wrapper below.
export default function NewBrokerageDealPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
      <NewBrokerageDealPageInner />
    </Suspense>
  )
}

function NewBrokerageDealPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const fromOfferId = searchParams.get('from_offer')
  const revisedFromId = searchParams.get('revisedFrom')
  const supabase = createClient()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_profile, setProfile] = useState<UserProfile | null>(null)
  const [brokerage, setBrokerage] = useState<BrokeragePublic | null>(null)
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [loading, setLoading] = useState(true)
  // Resubmit-from-denied banner state (mirrors the agent flow).
  const [revisedFromBanner, setRevisedFromBanner] = useState<{ dealId: string; reason: string | null } | null>(null)

  const [agentId, setAgentId] = useState<string>('')
  const [address, setAddress] = useState<AddressParts>({ street: '', city: '', province: 'Ontario', postalCode: '' })
  const [closingDate, setClosingDate] = useState('')
  const [grossCommission, setGrossCommission] = useState('')
  const [brokerageSplitPct, setBrokerageSplitPct] = useState('')
  // Optional flat dollar fee charged in addition to the split. String for the
  // input; treated as 0 when blank.
  const [brokerageFlatFee, setBrokerageFlatFee] = useState('')
  const [transactionType, setTransactionType] = useState('buy')
  const [notes, setNotes] = useState('')

  const [docSlots, setDocSlots] = useState<Record<string, File[]>>({
    trade_record: [], aps: [], amendment: [], other: [],
  })

  const [preview, setPreview] = useState<{
    netCommission: number
    daysUntilClosing: number
    discountFee: number
    settlementPeriodFee: number
    advanceAmount: number
    brokerageReferralFee: number
    amountDueFromBrokerage: number
    outstandingBalance: number
    estimatedBalanceDeduction: number
  } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // Set when the selected agent has an uncovered failed-to-close balance —
  // blocks submitting on their behalf (server-enforced in submitDealAsBrokerage).
  const [submissionBlock, setSubmissionBlock] = useState<{ owed: number; coverage: number } | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Per-file upload queue with status + progress. Updated as the orchestrator
   *  iterates through files; failures don't abort the batch. */
  const [uploadQueue, setUploadQueue] = useState<FileUploadItem[]>([])
  const [uploadingDocs, setUploadingDocs] = useState(false)
  /** Stable submitted-deal id so retry-after-failure can target the same deal */
  const [submittedDealId, setSubmittedDealId] = useState<string | null>(null)

  const [resendBusy, setResendBusy] = useState(false)
  const [resendMsg, setResendMsg] = useState<string | null>(null)

  const propertyAddress = [address.street.trim(), address.city.trim(), address.province.trim(), address.postalCode.trim().toUpperCase()].filter(Boolean).join(', ')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: prof } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
      if (!prof || prof.role !== 'brokerage_admin' || !prof.brokerage_id) { router.push('/login'); return }
      setProfile(prof)
      const { data: brok } = await supabase.from('brokerages').select(BROKERAGE_PUBLIC_COLUMNS).eq('id', prof.brokerage_id).single()
      setBrokerage(brok as BrokeragePublic | null)
      const { data: ags } = await supabase
        .from('agents')
        .select('id, first_name, last_name, email, status, account_activated_at, kyc_status, banking_approval_status')
        .eq('brokerage_id', prof.brokerage_id)
        .neq('status', 'archived')
        .order('last_name')
      setAgents((ags || []) as AgentRow[])

      // If we're converting a firm-deal offer, load the offered deal and
      // pre-fill agent + address + closing date. The brokerage admin only
      // needs to add the commission split + trade record, the rest carries
      // forward from what the agent accepted.
      if (fromOfferId) {
        const { data: offeredDeal } = await supabase
          .from('deals')
          .select('id, agent_id, property_address, closing_date, status, brokerage_id, agent_self_submit_at')
          .eq('id', fromOfferId)
          .maybeSingle()
        // Paused: the agent took this offer over to submit it themselves. Don't
        // prefill the form — block it with a clear message so the brokerage
        // can't submit a duplicate. (The submit action also refuses this.)
        if (offeredDeal && offeredDeal.brokerage_id === prof.brokerage_id && offeredDeal.agent_self_submit_at) {
          setError('This agent has chosen to submit this advance themselves.')
        } else if (offeredDeal && offeredDeal.brokerage_id === prof.brokerage_id && offeredDeal.status === 'offered') {
          setAgentId(offeredDeal.agent_id)
          if (offeredDeal.closing_date) setClosingDate(offeredDeal.closing_date)
          // Address pre-fill: try to split "street, city, province, postal"
          // back out of the joined string. Falls back to dumping the whole
          // thing into the street field if the shape doesn't match.
          const parts = (offeredDeal.property_address || '').split(',').map((p: string) => p.trim()).filter(Boolean)
          if (parts.length >= 4) {
            setAddress({ street: parts[0], city: parts[1], province: parts[2], postalCode: parts[3] })
          } else if (parts.length === 3) {
            setAddress({ street: parts[0], city: parts[1], province: 'Ontario', postalCode: parts[2] })
          } else {
            setAddress({ street: offeredDeal.property_address || '', city: '', province: 'Ontario', postalCode: '' })
          }
        }
      }

      setLoading(false)
    }
    load()
    // supabase/router are stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromOfferId])

  // Pre-fill the form from a denied deal when ?revisedFrom=<id> is set.
  // Runs separately from the main load() so we don't block the first paint
  // on this secondary fetch.
  useEffect(() => {
    if (!revisedFromId) return
    let cancelled = false
    ;(async () => {
      const result = await createRevisedDealFromDenied({ originalDealId: revisedFromId })
      if (cancelled || !result.success || !result.data) return
      const d = result.data
      // Only set the agent id if we don't already have one selected.
      if (!agentId) {
        // The original deal might have a different agent — we use the brokerage_id
        // check on the server. Pull the agent id from supabase here.
        const { data: origDeal } = await supabase
          .from('deals')
          .select('agent_id')
          .eq('id', d.originalDealId)
          .maybeSingle()
        if (origDeal?.agent_id) setAgentId(origDeal.agent_id)
      }
      const parts = (d.propertyAddress || '').split(',').map((p: string) => p.trim()).filter(Boolean)
      if (parts.length >= 4) {
        setAddress({ street: parts[0], city: parts[1], province: parts[2], postalCode: parts[3] })
      } else if (parts.length === 3) {
        setAddress({ street: parts[0], city: parts[1], province: 'Ontario', postalCode: parts[2] })
      } else {
        setAddress({ street: d.propertyAddress || '', city: '', province: 'Ontario', postalCode: '' })
      }
      setGrossCommission(d.grossCommission?.toString() || '')
      setBrokerageSplitPct(d.brokerageSplitPct?.toString() || '')
      if (d.brokerageFlatFee) setBrokerageFlatFee(d.brokerageFlatFee.toString())
      if (d.transactionType) setTransactionType(d.transactionType)
      if (d.notes) setNotes(d.notes)
      setRevisedFromBanner({ dealId: d.originalDealId, reason: d.denialReason || null })
    })()
    return () => { cancelled = true }
    // We intentionally exclude `agentId` so a later edit doesn't re-fire prefill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisedFromId])

  // Recalculate preview on input change
  useEffect(() => {
    const gross = parseFloat(grossCommission)
    const splitPct = parseFloat(brokerageSplitPct)
    // Optional flat fee: blank → 0. Bail (and clear the preview) if it's invalid
    // — negative, or >= the post-split commission — so we never call the server
    // with a value it would reject.
    const flatFee = brokerageFlatFee.trim() === '' ? 0 : parseFloat(brokerageFlatFee)
    const postSplit = gross * (1 - splitPct / 100)
    const flatFeeBad = brokerageFlatFee.trim() !== '' && (isNaN(flatFee) || flatFee < 0 || flatFee >= postSplit)
    if (!agentId || !gross || !closingDate || gross <= 0 || isNaN(splitPct) || splitPct < 0 || splitPct > 100 || flatFeeBad) {
      setPreview(null); setPreviewError(null); return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      const result = await calculateDealPreviewForBrokerage({
        grossCommission: gross,
        brokerageSplitPct: splitPct,
        brokerageFlatFee: flatFee,
        closingDate,
        agentId,
      })
      if (cancelled) return
      if (result.success && result.data) {
        setPreview({
          netCommission: result.data.netCommission,
          daysUntilClosing: result.data.daysUntilClosing,
          discountFee: result.data.discountFee,
          settlementPeriodFee: result.data.settlementPeriodFee,
          advanceAmount: result.data.advanceAmount,
          brokerageReferralFee: result.data.brokerageReferralFee,
          amountDueFromBrokerage: result.data.amountDueFromBrokerage,
          outstandingBalance: result.data.outstandingBalance || 0,
          estimatedBalanceDeduction: result.data.estimatedBalanceDeduction || 0,
        })
        setPreviewError(null)
      } else {
        setPreview(null)
        setPreviewError(result.error || 'Unable to preview deal')
      }
    }, 400)
    return () => { clearTimeout(t); cancelled = true }
  }, [agentId, grossCommission, brokerageSplitPct, brokerageFlatFee, closingDate])

  // Failed-deal gate: when an agent is selected, check whether they have an
  // uncovered failed-to-close balance and warn up front (submission is also
  // enforced server-side in submitDealAsBrokerage).
  useEffect(() => {
    if (!agentId) { setSubmissionBlock(null); return }
    let cancelled = false
    ;(async () => {
      const gate = await getDealSubmissionGate(agentId)
      if (cancelled) return
      if (gate.success && gate.data?.blocked) {
        setSubmissionBlock({ owed: gate.data.owed, coverage: gate.data.coverage })
      } else {
        setSubmissionBlock(null)
      }
    })()
    return () => { cancelled = true }
  }, [agentId])

  const selectedAgent = agents.find(a => a.id === agentId) || null
  const agentActivated = !!selectedAgent?.account_activated_at

  const handleResendWelcome = async () => {
    if (!selectedAgent) return
    setResendBusy(true); setResendMsg(null)
    const result = await resendAgentWelcomeEmail({ agentId: selectedAgent.id })
    if (result.success) {
      setResendMsg('Welcome email sent. Agent will receive setup link shortly.')
    } else {
      setResendMsg(result.error || 'Failed to send welcome email')
    }
    setResendBusy(false)
  }

  const handleFileAdd = (slotKey: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    setDocSlots(prev => ({ ...prev, [slotKey]: [...prev[slotKey], ...arr] }))
    e.target.value = ''
  }

  const handleFileRemove = (slotKey: string, idx: number) => {
    setDocSlots(prev => ({ ...prev, [slotKey]: prev[slotKey].filter((_, i) => i !== idx) }))
  }

  // Optional flat fee: blank/whitespace → 0 (no fee). Must be >= 0 and below the
  // commission left after the split (gross × (1 - split/100)); otherwise the
  // advance would go negative and the server rejects it. We block submit + skip
  // the preview while it's invalid so the admin gets immediate feedback.
  const flatFeeNum = brokerageFlatFee.trim() === '' ? 0 : parseFloat(brokerageFlatFee)
  const grossNum = parseFloat(grossCommission)
  const splitNum = parseFloat(brokerageSplitPct)
  const postSplitCommission = (!isNaN(grossNum) && !isNaN(splitNum)) ? grossNum * (1 - splitNum / 100) : NaN
  const flatFeeInvalid = brokerageFlatFee.trim() !== '' && (
    isNaN(flatFeeNum) || flatFeeNum < 0 || (!isNaN(postSplitCommission) && flatFeeNum >= postSplitCommission)
  )

  const missing: string[] = []
  if (!agentId) missing.push('Agent')
  if (!address.street.trim()) missing.push('Address')
  if (!address.city.trim()) missing.push('City')
  if (!address.postalCode.trim()) missing.push('Postal Code')
  if (!closingDate) missing.push('Closing Date')
  if (!grossCommission || parseFloat(grossCommission) <= 0) missing.push('Gross Commission')
  if (brokerageSplitPct === '' || isNaN(parseFloat(brokerageSplitPct))) missing.push('Brokerage Split %')
  for (const slot of DOC_SLOTS) {
    if (slot.required && (docSlots[slot.key]?.length ?? 0) === 0) missing.push(slot.label)
  }

  // Update a single queue item in place. We always work off the most recent
  // setUploadQueue snapshot so concurrent retries don't stomp each other.
  const updateQueueItem = useCallback((id: string, patch: Partial<FileUploadItem>) => {
    setUploadQueue(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  // Upload a single file to a deal. Sets status -> uploading -> success/failed.
  // We can't get real percent progress from a Next.js server action, so we
  // animate to 50% on start and 100% on success.
  const uploadSingleFile = useCallback(async (item: FileUploadItem, dealId: string) => {
    updateQueueItem(item.id, { status: 'uploading', progress: 50, error: undefined })
    try {
      const fd = new FormData()
      fd.append('file', item.file)
      fd.append('dealId', dealId)
      fd.append('documentType', item.category || 'other')
      const r = await uploadDocument(fd)
      if (r.success) {
        updateQueueItem(item.id, { status: 'success', progress: 100, error: undefined })
      } else {
        updateQueueItem(item.id, { status: 'failed', progress: 0, error: r.error || 'Upload failed' })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed unexpectedly'
      updateQueueItem(item.id, {
        status: 'failed',
        progress: 0,
        error: msg,
      })
    }
  }, [updateQueueItem])

  // Walk through every pending item sequentially. Sequential (not parallel)
  // so the user sees one moving spinner at a time and the storage backend
  // isn't hammered with concurrent multipart uploads.
  const runUploadQueue = useCallback(async (queue: FileUploadItem[], dealId: string) => {
    for (const item of queue) {
      if (item.status === 'success') continue
      await uploadSingleFile(item, dealId)
    }
  }, [uploadSingleFile])

  // Per-file retry — uses the stored deal id so the user doesn't have to
  // re-submit the whole form.
  const handleRetryUpload = useCallback(async (id: string) => {
    if (!submittedDealId) return
    const item = uploadQueue.find(i => i.id === id)
    if (!item) return
    await uploadSingleFile(item, submittedDealId)
  }, [submittedDealId, uploadQueue, uploadSingleFile])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!preview || !selectedAgent) {
      setError('Please complete all required fields with valid values.'); return
    }
    if (!agentActivated) {
      setError(`${selectedAgent.first_name} ${selectedAgent.last_name} hasn't activated their account yet. Trigger the welcome email above and have them complete setup before submitting.`); return
    }

    setSubmitting(true)
    let dealId: string | null = null
    try {
      const result = await submitDealAsBrokerage({
        agentId: selectedAgent.id,
        propertyAddress,
        closingDate,
        grossCommission: parseFloat(grossCommission),
        brokerageSplitPct: parseFloat(brokerageSplitPct),
        brokerageFlatFee: brokerageFlatFee.trim() === '' ? 0 : parseFloat(brokerageFlatFee),
        transactionType,
        notes: notes.trim() || undefined,
        fromOfferDealId: fromOfferId || undefined,
        revisedFromDealId: revisedFromBanner?.dealId,
      })
      if (!result.success) {
        setError(result.error || 'Failed to submit deal'); setSubmitting(false); return
      }
      dealId = result.data?.dealId || null
      setSubmittedDealId(dealId)

      // Upload documents — build a status queue first so the user can see
      // every file before anything starts, then walk through one at a time
      // updating progress per file. A failure on one file MUST NOT abort
      // the rest of the batch.
      const allFiles = Object.entries(docSlots).flatMap(([type, files]) =>
        files.map(f => ({ file: f, category: type }))
      )
      if (allFiles.length > 0 && dealId) {
        setUploadingDocs(true)
        const queue = buildUploadItems(allFiles)
        setUploadQueue(queue)
        await runUploadQueue(queue, dealId)
        setUploadingDocs(false)
      }

      setSubmitted(true)
    } catch {
      if (dealId) {
        setSubmitted(true)
      } else {
        setError('An unexpected error occurred. Please try again.')
        setSubmitting(false)
      }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <BrokerageBrandLogo logoUrl={brokerage?.logo_url} brokerageName={brokerage?.name} logoIncludesTagline={brokerage?.logo_includes_tagline} size="md" />
            <div className="w-px h-8 bg-border" />
            <p className="text-sm font-medium text-foreground">Brokerage Portal{brokerage ? `: ${brokerage.name}` : ''}</p>
          </div>
        </header>
        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-12">
          <Card className="border-primary/40 bg-primary/5">
            <CardContent className="p-8 text-center">
              <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-primary/15 flex items-center justify-center">
                <Send className="h-7 w-7 text-primary" />
              </div>
              <h2 className="text-xl font-bold text-foreground mb-2">Deal submitted</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Firm Funds underwriting has been notified. {selectedAgent?.first_name} will get an email when the status changes.
              </p>
              {uploadQueue.length > 0 && (
                <div className="text-left mb-6">
                  <p className="text-xs font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
                    Document uploads
                    {uploadQueue.some(i => i.status === 'failed') && (
                      <span className="ml-2 text-destructive normal-case font-normal">
                        ({uploadQueue.filter(i => i.status === 'failed').length} failed, retry below)
                      </span>
                    )}
                  </p>
                  <FileUploadProgress
                    items={uploadQueue}
                    onRetry={handleRetryUpload}
                    hideRemove
                  />
                </div>
              )}
              <div className="flex gap-2 justify-center">
                <Button variant="outline" onClick={() => router.push('/brokerage')}>Back to dashboard</Button>
                <Button onClick={() => window.location.reload()}>Submit another</Button>
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/brokerage')} className="p-1.5 rounded-lg text-muted-foreground hover:text-primary" aria-label="Back">
              <ArrowLeft size={16} />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <BrokerageBrandLogo logoUrl={brokerage?.logo_url} brokerageName={brokerage?.name} logoIncludesTagline={brokerage?.logo_includes_tagline} size="md" />
            <div className="w-px h-8 bg-border hidden sm:block" />
            <p className="text-sm font-medium text-foreground hidden sm:block">Submit Advance Request{brokerage ? `: ${brokerage.name}` : ''}</p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">New advance request</h1>
          <p className="text-sm text-muted-foreground mt-1">Submitting on behalf of one of your agents.</p>
        </div>

        {/* Resubmit-from-denied banner — mirrors agent-side messaging. */}
        {revisedFromBanner && (
          <div className="px-4 py-3 rounded-lg bg-status-blue-muted/40 border border-status-blue-border/40" role="status">
            <p className="text-sm font-semibold text-status-blue">
              Resubmitting from denied deal{' '}
              <span className="font-mono">#{revisedFromBanner.dealId.slice(0, 8).toUpperCase()}</span>
            </p>
            {revisedFromBanner.reason && (
              <p className="text-xs text-muted-foreground mt-1">
                <span className="font-semibold text-status-blue">Reason underwriting gave:</span> {revisedFromBanner.reason}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              We&apos;ve pre-filled the form. Pick a new closing date and adjust anything underwriting flagged.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Agent picker */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><UserIcon size={16} /> Agent</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Label htmlFor="agentId">Select an agent <span className="text-destructive">*</span></Label>
              <select
                id="agentId"
                required
                value={agentId}
                onChange={(e) => { setAgentId(e.target.value); setResendMsg(null) }}
                className="w-full px-4 py-2 rounded-lg text-base sm:text-sm bg-input border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
              >
                <option value="">Choose an agent…</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.last_name}, {a.first_name}{a.account_activated_at ? '' : ' (not activated)'}
                  </option>
                ))}
              </select>

              {selectedAgent && (
                <div className={`rounded-lg p-3 text-xs ${agentActivated ? 'bg-primary/5 border border-primary/20' : 'bg-status-amber-muted/40 border border-status-amber-border/40'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className={`text-sm font-semibold ${agentActivated ? 'text-foreground' : 'text-status-amber'}`}>
                        {agentActivated ? 'Account activated' : 'Account not activated yet'}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        KYC: <span className="font-medium">{selectedAgent.kyc_status || 'pending'}</span>
                        &nbsp;·&nbsp;
                        Banking: <span className="font-medium">{selectedAgent.banking_approval_status || 'none'}</span>
                      </p>
                      {!agentActivated && (
                        <p className="mt-1 text-status-amber/90">
                          Submission is locked until the agent completes setup (ID verification + banking).
                          {!selectedAgent.email && <span> Add an email on the agents page first.</span>}
                        </p>
                      )}
                    </div>
                    {!agentActivated && selectedAgent.email && (
                      <Button type="button" variant="outline" size="sm" disabled={resendBusy} onClick={handleResendWelcome}>
                        {resendBusy ? 'Sending…' : 'Send welcome email'}
                      </Button>
                    )}
                  </div>
                  {resendMsg && (
                    <p className="mt-2 text-xs text-muted-foreground">{resendMsg}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Failed-deal block — shown right under the agent picker so the
              admin knows before filling the form. Also enforced server-side. */}
          {submissionBlock && (
            <div role="alert" className="px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30">
              <p className="text-sm font-semibold text-destructive flex items-center gap-1.5">
                <UserIcon size={15} aria-hidden="true" /> Outstanding balance from a failed deal
              </p>
              <p className="text-xs text-foreground/80 mt-1">
                {selectedAgent ? `${selectedAgent.first_name} ${selectedAgent.last_name}` : 'This agent'} has an outstanding balance of <span className="font-semibold">{formatCurrency(submissionBlock.owed)}</span> from a deal that failed to close.
                You can&apos;t submit a new advance on their behalf until approved advances covering that balance are in place
                {submissionBlock.coverage > 0 ? <> (currently approved: {formatCurrency(submissionBlock.coverage)})</> : null}.
              </p>
            </div>
          )}

          {/* Property */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><MapPin size={16} /> Property</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <AddressAutocomplete value={address} onChange={setAddress} required />
              <div>
                <Label htmlFor="txtype">Transaction type</Label>
                <select id="txtype" value={transactionType} onChange={(e) => setTransactionType(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg text-base sm:text-sm bg-input border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary">
                  <option value="buy">Buying Side</option>
                  <option value="sell">Listing Side</option>
                  <option value="both">Both</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Commission + closing */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><DollarSign size={16} /> Commission &amp; closing</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label htmlFor="closing">Closing date <span className="text-destructive">*</span></Label>
                {(() => {
                  // Same inline-validation pattern as the agent form. Toronto
                  // tz keeps "today" stable for users west of UTC late at
                  // night.
                  const todayYmd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
                  const isInvalidClosing = !!closingDate && closingDate <= todayYmd
                  return (
                    <>
                      <Input
                        id="closing"
                        type="date"
                        value={closingDate}
                        onChange={(e) => setClosingDate(e.target.value)}
                        min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                        required
                        aria-invalid={isInvalidClosing || undefined}
                        aria-describedby={`brk-closing-hint${isInvalidClosing ? ' brk-closing-error' : ''}`}
                      />
                      <p id="brk-closing-hint" className="mt-1 text-xs text-muted-foreground">
                        Closing date must be at least 1 day from today.
                      </p>
                      {isInvalidClosing && (
                        <p id="brk-closing-error" className="mt-1 text-xs text-destructive font-medium">
                          Closing date must be tomorrow or later.
                        </p>
                      )}
                    </>
                  )
                })()}
              </div>
              <div>
                <Label htmlFor="gross">Gross commission ($) <span className="text-destructive">*</span></Label>
                <Input id="gross" type="number" step="0.01" min="0" value={grossCommission} onChange={(e) => setGrossCommission(e.target.value)} placeholder="e.g. 25000" required />
              </div>
              <div>
                <Label htmlFor="split">Brokerage split % <span className="text-destructive">*</span></Label>
                <Input id="split" type="number" step="0.5" min="0" max="100" value={brokerageSplitPct} onChange={(e) => setBrokerageSplitPct(e.target.value)} placeholder="e.g. 5" required />
              </div>
              <div className="sm:col-span-3">
                <Label htmlFor="flatfee">Brokerage flat fee (optional)</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                  <Input
                    id="flatfee"
                    type="number"
                    step="0.01"
                    min="0"
                    value={brokerageFlatFee}
                    onChange={(e) => setBrokerageFlatFee(e.target.value)}
                    placeholder="0.00"
                    className="pl-6"
                    aria-invalid={flatFeeInvalid || undefined}
                    aria-describedby={`flatfee-hint${flatFeeInvalid ? ' flatfee-error' : ''}`}
                  />
                </div>
                <p id="flatfee-hint" className="mt-1 text-xs text-muted-foreground">
                  A flat dollar fee some brokerages charge (e.g. a transaction fee), deducted in addition to the split. Leave blank or 0 if none.
                </p>
                {flatFeeInvalid && (
                  <p id="flatfee-error" className="mt-1 text-xs text-destructive font-medium">
                    {flatFeeNum < 0
                      ? 'Flat fee cannot be negative.'
                      : 'Flat fee must be less than the commission after the split.'}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Preview */}
          {(preview || previewError) && (
            <Card className={preview ? 'border-primary/30 bg-primary/5' : 'border-destructive/30 bg-destructive/5'}>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Calculator size={16} /> Advance preview</CardTitle></CardHeader>
              <CardContent className="text-sm">
                {previewError ? (
                  <p className="text-destructive">{previewError}</p>
                ) : preview ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">Net commission</p>
                      <p className="text-base font-bold text-foreground">{formatCurrency(preview.netCommission)}</p>
                    </div>
                    {flatFeeNum > 0 && (
                      <div>
                        <p className="text-muted-foreground">Brokerage flat fee</p>
                        <p className="text-base font-bold text-foreground">-{formatCurrency(flatFeeNum)}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-muted-foreground">Discount fee ({preview.daysUntilClosing} days)</p>
                      <p className="text-base font-bold text-foreground">{formatCurrency(preview.discountFee)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Settlement period fee</p>
                      <p className="text-base font-bold text-foreground">{formatCurrency(preview.settlementPeriodFee)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Brokerage referral</p>
                      <p className="text-base font-bold text-foreground">{formatCurrency(preview.brokerageReferralFee)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Outstanding balance</p>
                      <p className="text-base font-bold text-foreground">{formatCurrency(preview.outstandingBalance)}</p>
                    </div>
                    <div className="rounded-md bg-primary/15 px-3 py-2">
                      <p className="text-primary text-[11px] uppercase tracking-wide font-bold">Advance to agent</p>
                      <p className="text-lg font-bold text-foreground">{formatCurrency(Math.max(preview.advanceAmount - preview.estimatedBalanceDeduction, 0))}</p>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}

          {/* Documents */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileText size={16} /> Documents</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {DOC_SLOTS.map(slot => (
                <div key={slot.key} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {slot.label} {slot.required && <span className="text-destructive">*</span>}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">PDF, JPEG, PNG. Max 10 MB each.</p>
                    </div>
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-input border border-border text-foreground hover:bg-muted">
                      <Upload size={14} /> Add
                      {/* Off-screen instead of display:none — some browser/extension combos
                          drop the change event when a display:none file input is the picker
                          target. Keeping the element in the layout tree fixes that. */}
                      <input
                        type="file"
                        accept={slot.types}
                        multiple
                        onChange={(e) => handleFileAdd(slot.key, e)}
                        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', borderWidth: 0 }}
                      />
                    </label>
                  </div>
                  {docSlots[slot.key].length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {docSlots[slot.key].map((f, i) => (
                        <li key={i} className="flex items-center justify-between text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1">
                          <span className="truncate">{f.name} <span className="text-muted-foreground/60">({(f.size / 1024 / 1024).toFixed(2)} MB)</span></span>
                          <button type="button" onClick={() => handleFileRemove(slot.key, i)} className="ml-2 hover:text-destructive" aria-label="Remove">
                            <X size={12} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader><CardTitle className="text-base">Notes for underwriting</CardTitle></CardHeader>
            <CardContent>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Anything Firm Funds should know about this deal." />
            </CardContent>
          </Card>

          {/* Errors / submit */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {missing.length > 0 && (
            <Alert>
              <AlertDescription className="text-xs">
                Missing: {missing.join(', ')}
              </AlertDescription>
            </Alert>
          )}
          {flatFeeInvalid && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">
                The brokerage flat fee must be less than the commission after the split. Adjust it to submit.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => router.push('/brokerage')}>Cancel</Button>
            <Button type="submit" disabled={submitting || uploadingDocs || !preview || !agentActivated || missing.length > 0 || flatFeeInvalid || !!submissionBlock} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {submitting ? 'Submitting…' : uploadingDocs ? 'Uploading docs…' : <>Submit deal <Send size={14} className="ml-1" /></>}
            </Button>
          </div>
        </form>
      </main>
    </div>
  )
}
