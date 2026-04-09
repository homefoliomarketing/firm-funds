'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Calculator, Send, DollarSign, MapPin, Calendar, Percent, Upload, FileText, X, CheckCircle2, AlertCircle, Shield, Save } from 'lucide-react'
import { submitDeal, calculateDealPreview, uploadDocument } from '@/lib/actions/deal-actions'
import { formatCurrency } from '@/lib/formatting'
import SignOutModal from '@/components/SignOutModal'
import { KYC_STATUSES } from '@/lib/constants'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'

export default function NewDealPage() {
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [streetAddress, setStreetAddress] = useState('')
  const [city, setCity] = useState('')
  const [province, setProvince] = useState('Ontario')
  const [postalCode, setPostalCode] = useState('')
  const [closingDate, setClosingDate] = useState('')
  const [grossCommission, setGrossCommission] = useState('')
  const [brokerageSplitPct, setBrokerageSplitPct] = useState('')
  const [transactionType, setTransactionType] = useState('buy')
  const [notes, setNotes] = useState('')
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [isFirm, setIsFirm] = useState(false)

  // Document upload state — slot-based with specific categories
  const [docSlots, setDocSlots] = useState<Record<string, File[]>>({
    aps: [],
    notice_of_fulfillment: [],
    amendment: [],
    banking_info: [],
  })
  const [uploadingDocs, setUploadingDocs] = useState(false)
  const [uploadResults, setUploadResults] = useState<{ name: string; success: boolean; error?: string }[]>([])
  const [isFirstAdvance, setIsFirstAdvance] = useState(true)

  // Autosave draft state
  const DRAFT_KEY = 'firm_funds_deal_draft'
  const [draftRestored, setDraftRestored] = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Restore draft on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY)
      if (saved) {
        const draft = JSON.parse(saved)
        if (draft.streetAddress) setStreetAddress(draft.streetAddress)
        if (draft.city) setCity(draft.city)
        if (draft.province) setProvince(draft.province)
        if (draft.postalCode) setPostalCode(draft.postalCode)
        if (draft.closingDate) setClosingDate(draft.closingDate)
        if (draft.grossCommission) setGrossCommission(draft.grossCommission)
        if (draft.brokerageSplitPct) setBrokerageSplitPct(draft.brokerageSplitPct)
        if (draft.transactionType) setTransactionType(draft.transactionType)
        if (draft.notes) setNotes(draft.notes)
        if (draft.isFirm) setIsFirm(draft.isFirm)
        setDraftRestored(true)
        setDraftSavedAt(draft.savedAt || null)
      }
    } catch { /* ignore corrupted localStorage */ }
  }, [])

  // Save draft on field changes (debounced 1s)
  const saveDraft = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      try {
        const draft = {
          streetAddress, city, province, postalCode, closingDate,
          grossCommission, brokerageSplitPct, transactionType, notes, isFirm,
          savedAt: new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }),
        }
        if (streetAddress || city || closingDate || grossCommission || brokerageSplitPct || notes) {
          localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
          setDraftSavedAt(draft.savedAt)
        }
      } catch { /* localStorage full or unavailable */ }
    }, 1000)
  }, [streetAddress, city, province, postalCode, closingDate, grossCommission, brokerageSplitPct, transactionType, notes, isFirm])

  useEffect(() => {
    saveDraft()
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [saveDraft])

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(DRAFT_KEY) } catch {}
    setDraftSavedAt(null)
    setDraftRestored(false)
  }, [])

  // Flatten for backward compat
  const selectedFiles = Object.entries(docSlots).flatMap(([docType, files]) => files.map(file => ({ file, docType })))

  const [preview, setPreview] = useState<{
    netCommission: number
    daysUntilClosing: number
    discountFee: number
    settlementPeriodFee: number
    totalFees: number
    advanceAmount: number
    brokerageReferralFee: number
    amountDueFromBrokerage: number
    outstandingBalance: number
    estimatedBalanceDeduction: number
  } | null>(null)

  const propertyAddress = [streetAddress.trim(), city.trim(), province.trim(), postalCode.trim().toUpperCase()].filter(Boolean).join(', ')

  const router = useRouter()
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  useEffect(() => {
    async function loadAgent() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: profileData } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
      setProfile(profileData)
      if (profileData?.role !== 'agent') { router.push('/login'); return }
      if (profileData?.agent_id) {
        const { data: agentData } = await supabase.from('agents').select('*, brokerages(*)').eq('id', profileData.agent_id).single()
        setAgent(agentData)
        const { count } = await supabase.from('deals').select('*', { count: 'exact', head: true }).eq('agent_id', profileData.agent_id).in('status', ['funded', 'completed'])
        setIsFirstAdvance(!count || count === 0)
      }
      setLoading(false)
    }
    loadAgent()
  }, [])

  useEffect(() => {
    const gross = parseFloat(grossCommission)
    const splitPct = parseFloat(brokerageSplitPct)
    if (!gross || !closingDate || gross <= 0 || isNaN(splitPct) || splitPct < 0 || splitPct > 100 || !agent?.id) {
      setPreview(null); return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const result = await calculateDealPreview({ grossCommission: gross, brokerageSplitPct: splitPct, closingDate, agentId: agent.id })
      if (cancelled) return
      if (result.success && result.data) {
        setPreview({
          netCommission: result.data.netCommission, daysUntilClosing: result.data.daysUntilClosing,
          discountFee: result.data.discountFee, settlementPeriodFee: result.data.settlementPeriodFee,
          totalFees: result.data.totalFees, advanceAmount: result.data.advanceAmount,
          brokerageReferralFee: result.data.brokerageReferralFee, amountDueFromBrokerage: result.data.amountDueFromBrokerage,
          outstandingBalance: result.data.outstandingBalance || 0,
          estimatedBalanceDeduction: result.data.estimatedBalanceDeduction || 0,
        })
      } else { setPreview(null) }
    }, 400)
    return () => { clearTimeout(timer); cancelled = true }
  }, [grossCommission, brokerageSplitPct, closingDate, agent])

  const missingFields: string[] = []
  if (!streetAddress.trim()) missingFields.push('Address')
  if (!city.trim()) missingFields.push('City')
  if (!postalCode.trim()) missingFields.push('Postal Code')
  if (!closingDate) missingFields.push('Closing Date')
  if (!grossCommission || parseFloat(grossCommission) <= 0) missingFields.push('Gross Commission')
  if (brokerageSplitPct === '' || isNaN(parseFloat(brokerageSplitPct)) || parseFloat(brokerageSplitPct) < 0 || parseFloat(brokerageSplitPct) > 100) missingFields.push('Brokerage Split %')

  const handleSlotFileAdd = (slotKey: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    setDocSlots(prev => ({ ...prev, [slotKey]: [...prev[slotKey], ...Array.from(files)] }))
    e.target.value = ''
  }

  const handleSlotFileRemove = (slotKey: string, fileIndex: number) => {
    setDocSlots(prev => ({ ...prev, [slotKey]: prev[slotKey].filter((_, i) => i !== fileIndex) }))
  }

  const handleSubmitClick = (e: React.FormEvent) => {
    e.preventDefault(); setError(null)
    if (!preview || !agent) { setError('Please fill in all required fields with valid values.'); return }
    if (!isFirm) { setError('You must confirm this deal is firm before submitting.'); return }
    setShowConfirmation(true)
  }

  const handleConfirmSubmit = async () => {
    setError(null); setSubmitting(true); setShowConfirmation(false)
    let dealSubmitted = false
    try {
      const result = await submitDeal({
        propertyAddress, closingDate, grossCommission: parseFloat(grossCommission),
        brokerageSplitPct: parseFloat(brokerageSplitPct), transactionType, notes: notes.trim() || undefined,
      })
      if (!result.success) { setError(result.error || 'Failed to submit deal. Please try again.'); setSubmitting(false); return }
      dealSubmitted = true
      if (result.data) {
        setPreview({
          netCommission: result.data.netCommission, daysUntilClosing: result.data.daysUntilClosing,
          discountFee: result.data.discountFee, settlementPeriodFee: result.data.settlementPeriodFee,
          totalFees: result.data.totalFees, advanceAmount: result.data.advanceAmount,
          brokerageReferralFee: result.data.brokerageReferralFee, amountDueFromBrokerage: result.data.amountDueFromBrokerage,
          outstandingBalance: result.data.outstandingBalance || 0,
          estimatedBalanceDeduction: result.data.estimatedBalanceDeduction || 0,
        })
      }

      if (selectedFiles.length > 0 && result.data?.dealId) {
        setUploadingDocs(true)
        const results: { name: string; success: boolean; error?: string }[] = []
        for (const { file, docType } of selectedFiles) {
          try {
            const fd = new FormData()
            fd.append('file', file)
            fd.append('dealId', result.data.dealId)
            fd.append('documentType', docType)
            const uploadResult = await uploadDocument(fd)
            results.push({ name: file.name, success: uploadResult.success, error: uploadResult.error })
          } catch {
            results.push({ name: file.name, success: false, error: 'Upload failed — you can upload this from your dashboard' })
          }
        }
        setUploadResults(results)
        setUploadingDocs(false)
      }

      clearDraft()
      setSubmitted(true)
    } catch (err) {
      if (dealSubmitted) {
        clearDraft()
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
        <div className="text-lg text-muted-foreground">Loading...</div>
      </div>
    )
  }

  // KYC Gate
  if (agent && agent.kyc_status !== KYC_STATUSES.VERIFIED) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="rounded-2xl p-8 max-w-md mx-auto text-center bg-card border border-border">
          <Shield size={44} className="text-yellow-500 mx-auto mb-3" />
          <h2 className="text-xl font-bold mb-2 text-foreground">Identity Verification Required</h2>
          <p className="text-sm mb-6 text-muted-foreground">
            You need to complete identity verification before you can submit deals. Please go to your dashboard to upload your government-issued photo ID.
          </p>
          <Button onClick={() => router.push('/agent')} className="w-full">
            Go to Dashboard
          </Button>
        </div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="rounded-2xl p-8 max-w-md mx-auto text-center bg-card border border-border shadow-lg">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 bg-primary/10">
            <Send size={28} className="text-primary" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground">Deal Submitted!</h2>
          <p className="text-sm mb-2 text-muted-foreground">Your commission advance request has been submitted for review.</p>
          <p className="text-xs mb-4 text-muted-foreground/70">You&apos;ll be notified when there&apos;s an update on your deal.</p>
          {uploadResults.length > 0 && (
            <div className="rounded-lg p-3 mb-4 text-left space-y-1.5 bg-muted border border-border">
              <p className="text-xs font-semibold mb-1 text-muted-foreground">Document Uploads:</p>
              {uploadResults.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {r.success
                    ? <CheckCircle2 size={12} className="text-primary" />
                    : <AlertCircle size={12} className="text-destructive" />}
                  <span className={r.success ? 'text-muted-foreground' : 'text-destructive'}>{r.name}{r.error ? ` — ${r.error}` : ''}</span>
                </div>
              ))}
            </div>
          )}
          <div className="rounded-xl p-4 mb-6 text-left bg-muted border border-border">
            <div className="text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Property</span>
                <span className="font-medium text-foreground">{propertyAddress}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Advance Amount</span>
                <span className="font-bold text-primary">{preview && formatCurrency(preview.advanceAmount)}</span>
              </div>
            </div>
          </div>
          <Button onClick={() => router.push('/agent')} className="w-full">
            Back to Dashboard
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm sticky top-0 z-40 border-b border-border/50">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4 py-4">
            <img src="/brand/white.png" alt="Firm Funds" className="h-8 sm:h-10 w-auto" />
            <div className="w-px h-10 bg-border" />
            <button
              onClick={() => router.push('/agent')}
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
            <div>
              <h1 className="text-lg font-bold text-foreground">New Advance Request</h1>
              <p className="text-xs text-muted-foreground">Submit a commission advance for a firm deal</p>
            </div>
            <div className="ml-auto">
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Draft restored banner */}
        {draftRestored && (
          <div className="mb-4 px-4 py-3 rounded-lg flex items-center justify-between bg-status-blue-muted/40 border border-status-blue-border/40">
            <div className="flex items-center gap-2">
              <Save size={14} className="text-status-blue" />
              <span className="text-xs font-medium text-status-blue">Draft restored from your last session</span>
            </div>
            <button
              type="button"
              onClick={() => {
                clearDraft()
                setStreetAddress(''); setCity(''); setProvince('Ontario'); setPostalCode('')
                setClosingDate(''); setGrossCommission(''); setBrokerageSplitPct('')
                setTransactionType('buy'); setNotes(''); setIsFirm(false)
                setDocSlots({ aps: [], notice_of_fulfillment: [], amendment: [], banking_info: [] })
              }}
              className="text-xs font-semibold px-2.5 py-1 rounded-md transition-colors text-status-blue bg-status-blue-border hover:bg-status-blue-border/80"
            >
              Clear &amp; Start Fresh
            </button>
          </div>
        )}

        {/* Autosave indicator */}
        {draftSavedAt && !draftRestored && (
          <div className="mb-4 flex items-center gap-1.5">
            <Save size={11} className="text-muted-foreground/50" />
            <span className="text-[10px] text-muted-foreground/50">Draft saved at {draftSavedAt}</span>
          </div>
        )}

        <form onSubmit={handleSubmitClick}>
          {error && (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle size={16} />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Deal Information */}
          <Card className="mb-6">
            <CardHeader className="border-b border-border">
              <CardTitle className="text-base">Deal Information</CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-5">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <MapPin size={12} className="text-primary" /> Street Address *
                </Label>
                <Input
                  type="text"
                  value={streetAddress}
                  onChange={(e) => setStreetAddress(e.target.value)}
                  placeholder="123 Main Street"
                  required
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">City *</Label>
                  <Input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Toronto"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Province</Label>
                  <Input
                    type="text"
                    value={province}
                    onChange={(e) => setProvince(e.target.value)}
                    placeholder="Ontario"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Postal Code *</Label>
                  <Input
                    type="text"
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                    placeholder="M5V 1A1"
                    required
                    maxLength={7}
                    className="uppercase"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Calendar size={12} className="text-primary" /> Closing Date *
                  </Label>
                  <Input
                    type="date"
                    value={closingDate}
                    onChange={(e) => setClosingDate(e.target.value)}
                    min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your Representation *</Label>
                  <select
                    value={transactionType}
                    onChange={(e) => setTransactionType(e.target.value)}
                    className="w-full rounded-lg px-4 py-2.5 text-sm bg-background border border-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary"
                    required
                  >
                    <option value="buy">Buyer Side</option>
                    <option value="sell">Seller / Listing Side</option>
                    <option value="both">Both Sides (Double-End)</option>
                  </select>
                  <p className="text-xs text-muted-foreground">Which side of the deal are you representing?</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Commission Details */}
          <Card className="mb-6">
            <CardHeader className="border-b border-border">
              <CardTitle className="text-base">Commission Details</CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <DollarSign size={12} className="text-primary" /> Gross Commission ($) *
                  </Label>
                  <Input
                    type="number"
                    value={grossCommission}
                    onChange={(e) => setGrossCommission(e.target.value)}
                    placeholder="15000.00"
                    min="0"
                    step="0.01"
                    required
                  />
                  <p className="text-xs text-muted-foreground">Your total commission on this deal before brokerage split</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Percent size={12} className="text-primary" /> Brokerage Split (%) *
                  </Label>
                  <Input
                    type="number"
                    value={brokerageSplitPct}
                    onChange={(e) => setBrokerageSplitPct(e.target.value)}
                    placeholder="20"
                    min="0"
                    max="100"
                    step="0.1"
                    required
                  />
                  <p className="text-xs text-muted-foreground">The percentage your brokerage takes from your gross commission</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes (optional)</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any additional details about this deal..."
                  rows={3}
                  className="resize-none"
                />
              </div>
            </CardContent>
          </Card>

          {/* Live Preview */}
          {preview && (
            <Card className="mb-6 border-2 border-primary/40">
              <CardHeader className="bg-primary/10 border-b border-primary/30">
                <CardTitle className="flex items-center gap-2 text-primary">
                  <Calculator size={16} />
                  <div>
                    <div className="text-base">Advance Preview</div>
                    <p className="text-xs font-normal text-primary/70">This is an estimate. Final amounts confirmed after underwriting.</p>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gross Commission</span>
                    <span className="font-medium text-foreground">{formatCurrency(parseFloat(grossCommission))}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Brokerage Split ({brokerageSplitPct}%)</span>
                    <span className="font-medium text-destructive">-{formatCurrency(parseFloat(grossCommission) - preview.netCommission)}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-border">
                    <span className="font-medium text-foreground">Your Net Commission</span>
                    <span className="font-semibold text-foreground">{formatCurrency(preview.netCommission)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Days Until Closing</span>
                    <span className="font-medium text-foreground">{preview.daysUntilClosing} days</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Discount Fee ($0.75/$1,000/day × {preview.daysUntilClosing}d)</span>
                    <span className="font-medium text-destructive">-{formatCurrency(preview.discountFee)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Settlement Period Fee ($0.75/$1,000/day × 14d)</span>
                    <span className="font-medium text-destructive">-{formatCurrency(preview.settlementPeriodFee)}</span>
                  </div>
                  {preview.outstandingBalance > 0 && (
                    <div className="rounded-lg px-3 py-2 mt-1 bg-destructive/10 border border-destructive/20 text-xs">
                      <p className="font-semibold text-destructive">Outstanding Balance: {formatCurrency(preview.outstandingBalance)}</p>
                      <p className="text-destructive/80 mt-0.5">
                        {formatCurrency(preview.estimatedBalanceDeduction)} will be deducted from your advance at funding.
                      </p>
                    </div>
                  )}
                  <div className="flex justify-between items-center rounded-xl px-5 py-4 -mx-1 mt-2 bg-primary/8 border border-primary/20">
                    <span className="font-bold text-base text-primary">Your Advance Amount</span>
                    <span className="text-2xl font-bold text-primary tabular-nums">{formatCurrency(preview.advanceAmount)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Validation Hints */}
          {!preview && missingFields.length > 0 && (
            <div className="rounded-xl p-4 mb-4 text-sm bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 dark:text-yellow-400">
              <p className="font-semibold mb-1">Complete these fields to see your advance preview:</p>
              <p>{missingFields.join(' · ')}</p>
            </div>
          )}
          {!preview && missingFields.length === 0 && (
            <div className="rounded-xl p-4 mb-4 text-sm bg-blue-500/10 border border-blue-500/30 text-blue-600 dark:text-blue-400">
              Calculating your advance preview...
            </div>
          )}

          {/* Document Upload — Specific Slots */}
          <Card className="mb-6">
            <CardHeader className="border-b border-border">
              <CardTitle className="text-base">Deal Documents</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">Upload ALL documents associated with this trade (Agreement of Purchase and Sale, Schedules, Amendments, NOFs/Waivers).</p>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              {[
                { key: 'aps', label: 'Agreement of Purchase & Sale', required: true, hint: 'Including schedules and confirmation of co-op' },
                { key: 'notice_of_fulfillment', label: 'Notice of Fulfillment / Waiver', required: false, hint: 'If applicable' },
                { key: 'amendment', label: 'Amendments', required: false, hint: 'Any amendments to the APS' },
                ...(isFirstAdvance ? [{ key: 'banking_info', label: 'Banking Information', required: true, hint: 'Void cheque or direct deposit form — required for your first advance' }] : []),
              ].map(slot => (
                <div key={slot.key} className="rounded-xl p-4 bg-secondary/30 border border-border/30">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-semibold text-foreground">{slot.label}</span>
                    {slot.required ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/30">Required</span>
                    ) : (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-card text-muted-foreground border border-border">Optional</span>
                    )}
                  </div>
                  {slot.hint && <p className="text-xs mb-2 text-muted-foreground">{slot.hint}</p>}

                  {docSlots[slot.key]?.length > 0 && (
                    <div className="space-y-1.5 mb-2">
                      {docSlots[slot.key].map((file, idx) => (
                        <div key={idx} className="flex items-center gap-2 rounded-md px-3 py-1.5 bg-card border border-border">
                          <FileText size={13} className="text-primary" />
                          <span className="text-xs flex-1 truncate text-foreground">{file.name}</span>
                          <button
                            type="button"
                            onClick={() => handleSlotFileRemove(slot.key, idx)}
                            className="p-0.5 rounded transition-colors text-muted-foreground hover:text-destructive"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const input = document.createElement('input')
                      input.type = 'file'
                      input.multiple = true
                      input.accept = '.pdf,.jpg,.jpeg,.png,.doc,.docx'
                      input.onchange = (ev) => {
                        const target = ev.target as HTMLInputElement
                        if (target.files) {
                          setDocSlots(prev => ({ ...prev, [slot.key]: [...prev[slot.key], ...Array.from(target.files!)] }))
                        }
                      }
                      input.click()
                    }}
                    className="w-full border-dashed border-border hover:border-primary hover:text-primary"
                  >
                    <Upload size={13} />
                    {docSlots[slot.key]?.length > 0 ? 'Add more files' : 'Choose files'}
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Firmness Confirmation */}
          <div className={`rounded-xl overflow-hidden mb-6 border ${isFirm ? 'bg-primary/10 border-primary/40' : 'bg-yellow-500/10 border-yellow-500/30'}`}>
            <label className="flex items-start gap-3 p-5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isFirm}
                onChange={(e) => setIsFirm(e.target.checked)}
                className="mt-0.5 w-5 h-5 rounded accent-green-600 shrink-0"
              />
              <div>
                <span className={`text-sm font-bold block ${isFirm ? 'text-primary' : 'text-yellow-600 dark:text-yellow-400'}`}>
                  I confirm this deal is firm with no outstanding conditions
                </span>
                <span className={`text-xs mt-1 block opacity-80 ${isFirm ? 'text-primary' : 'text-yellow-600 dark:text-yellow-400'}`}>
                  By checking this box, you confirm the Agreement of Purchase &amp; Sale is firm and unconditional, with all conditions having been fulfilled or waived.
                </span>
              </div>
            </label>
          </div>

          {/* Document validation hints */}
          {docSlots.aps.length === 0 && (
            <div className="rounded-xl p-3 mb-4 text-xs bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 dark:text-yellow-400">
              Please upload your Agreement of Purchase &amp; Sale to submit this advance request.
            </div>
          )}
          {isFirstAdvance && docSlots.banking_info.length === 0 && docSlots.aps.length > 0 && (
            <div className="rounded-xl p-3 mb-4 text-xs bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 dark:text-yellow-400">
              Since this is your first advance, please upload your banking information (void cheque or direct deposit form).
            </div>
          )}

          {/* Submit */}
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              className="flex-1 py-3"
              onClick={() => router.push('/agent')}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!preview || submitting || !isFirm || docSlots.aps.length === 0 || (isFirstAdvance && docSlots.banking_info.length === 0)}
              className="flex-1 h-10 text-sm font-semibold flex items-center justify-center gap-2"
            >
              {submitting ? 'Submitting...' : (<><Send size={16} />Review &amp; Submit</>)}
            </Button>
          </div>
        </form>

        {/* Confirmation Modal */}
        {showConfirmation && preview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
            <div className="rounded-2xl max-w-lg w-full overflow-hidden bg-card border border-border/40 shadow-2xl">
              <div className="px-6 py-5 bg-card border-b border-border/40">
                <h3 className="text-lg font-bold text-foreground">Confirm Your Advance Request</h3>
                <p className="text-xs mt-1 text-primary">Please review the details below before submitting.</p>
              </div>
              <div className="p-6">
                <div className="space-y-3 text-sm mb-5">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Property</span>
                    <span className="font-medium text-right max-w-[60%] text-foreground">{propertyAddress}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Closing Date</span>
                    <span className="font-medium text-foreground">{new Date(closingDate + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Representation</span>
                    <span className="font-medium capitalize text-foreground">{transactionType === 'buy' ? 'Buyer Side' : transactionType === 'sell' ? 'Seller / Listing Side' : 'Both Sides (Double-End)'}</span>
                  </div>
                </div>

                <div className="rounded-xl p-4 mb-5 bg-muted border border-border">
                  <div className="space-y-2.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Gross Commission</span>
                      <span className="font-medium text-foreground">{formatCurrency(parseFloat(grossCommission))}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Your Net Commission</span>
                      <span className="font-medium text-foreground">{formatCurrency(preview.netCommission)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Discount Fee ({preview.daysUntilClosing} days)</span>
                      <span className="font-medium text-destructive">-{formatCurrency(preview.discountFee)}</span>
                    </div>
                    <div className="flex justify-between pt-2.5 border-t border-border">
                      <span className="font-bold text-primary">Your Advance Amount</span>
                      <span className="font-black text-lg text-primary">{formatCurrency(preview.advanceAmount)}</span>
                    </div>
                  </div>
                </div>

                <p className="text-xs mb-3 text-muted-foreground">
                  By submitting, you confirm the above details are accurate and that this deal is firm with no outstanding conditions. Final amounts are subject to underwriting review.
                </p>
                {selectedFiles.length > 0 && (
                  <p className="text-xs mb-3 text-blue-500">
                    {selectedFiles.length} document{selectedFiles.length !== 1 ? 's' : ''} will be uploaded with your submission.
                  </p>
                )}
                {selectedFiles.length === 0 && (
                  <p className="text-xs mb-3 text-yellow-600 dark:text-yellow-400">
                    No documents attached. You can upload your APS and supporting documents after submission from your dashboard.
                  </p>
                )}

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 py-3"
                    onClick={() => setShowConfirmation(false)}
                  >
                    Go Back
                  </Button>
                  <Button
                    type="button"
                    onClick={handleConfirmSubmit}
                    disabled={submitting}
                    className="flex-1 h-10 text-sm font-semibold flex items-center justify-center gap-2 bg-primary hover:bg-primary/90"
                  >
                    {submitting ? 'Submitting...' : (<><Send size={16} />Confirm &amp; Submit</>)}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
