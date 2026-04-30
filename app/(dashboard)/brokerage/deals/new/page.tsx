'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, Calculator, Send, DollarSign, MapPin, Calendar, Percent,
  Upload, FileText, X, CheckCircle2, AlertCircle, Loader2, User as UserIcon,
} from 'lucide-react'
import { calculateDealPreviewForBrokerage, submitDealAsBrokerage, uploadDocument } from '@/lib/actions/deal-actions'
import { resendAgentWelcomeEmail } from '@/lib/actions/admin-actions'
import { formatCurrency } from '@/lib/formatting'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import AddressAutocomplete, { type AddressParts } from '@/components/AddressAutocomplete'

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

export default function NewBrokerageDealPage() {
  const router = useRouter()
  const supabase = createClient()
  const [profile, setProfile] = useState<any>(null)
  const [brokerage, setBrokerage] = useState<any>(null)
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [loading, setLoading] = useState(true)

  const [agentId, setAgentId] = useState<string>('')
  const [address, setAddress] = useState<AddressParts>({ street: '', city: '', province: 'Ontario', postalCode: '' })
  const [closingDate, setClosingDate] = useState('')
  const [grossCommission, setGrossCommission] = useState('')
  const [brokerageSplitPct, setBrokerageSplitPct] = useState('')
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

  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadResults, setUploadResults] = useState<{ name: string; success: boolean; error?: string }[]>([])
  const [uploadingDocs, setUploadingDocs] = useState(false)

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
      const { data: brok } = await supabase.from('brokerages').select('*').eq('id', prof.brokerage_id).single()
      setBrokerage(brok)
      const { data: ags } = await supabase
        .from('agents')
        .select('id, first_name, last_name, email, status, account_activated_at, kyc_status, banking_approval_status')
        .eq('brokerage_id', prof.brokerage_id)
        .neq('status', 'archived')
        .order('last_name')
      setAgents((ags || []) as AgentRow[])
      setLoading(false)
    }
    load()
  }, [])

  // Recalculate preview on input change
  useEffect(() => {
    const gross = parseFloat(grossCommission)
    const splitPct = parseFloat(brokerageSplitPct)
    if (!agentId || !gross || !closingDate || gross <= 0 || isNaN(splitPct) || splitPct < 0 || splitPct > 100) {
      setPreview(null); setPreviewError(null); return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      const result = await calculateDealPreviewForBrokerage({
        grossCommission: gross,
        brokerageSplitPct: splitPct,
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
  }, [agentId, grossCommission, brokerageSplitPct, closingDate])

  const selectedAgent = agents.find(a => a.id === agentId) || null
  const agentActivated = !!selectedAgent?.account_activated_at

  const handleResendWelcome = async () => {
    if (!selectedAgent) return
    setResendBusy(true); setResendMsg(null)
    const result = await resendAgentWelcomeEmail({ agentId: selectedAgent.id })
    if (result.success) {
      setResendMsg('Welcome email sent — agent will receive setup link shortly.')
    } else {
      setResendMsg(result.error || 'Failed to send welcome email')
    }
    setResendBusy(false)
  }

  const handleFileAdd = (slotKey: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    setDocSlots(prev => ({ ...prev, [slotKey]: [...prev[slotKey], ...Array.from(files)] }))
    e.target.value = ''
  }

  const handleFileRemove = (slotKey: string, idx: number) => {
    setDocSlots(prev => ({ ...prev, [slotKey]: prev[slotKey].filter((_, i) => i !== idx) }))
  }

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
        transactionType,
        notes: notes.trim() || undefined,
      })
      if (!result.success) {
        setError(result.error || 'Failed to submit deal'); setSubmitting(false); return
      }
      dealId = result.data?.dealId || null

      // Upload documents
      const allFiles = Object.entries(docSlots).flatMap(([type, files]) => files.map(f => ({ file: f, docType: type })))
      if (allFiles.length > 0 && dealId) {
        setUploadingDocs(true)
        const results: { name: string; success: boolean; error?: string }[] = []
        for (const { file, docType } of allFiles) {
          try {
            const fd = new FormData()
            fd.append('file', file)
            fd.append('dealId', dealId)
            fd.append('documentType', docType)
            const r = await uploadDocument(fd)
            results.push({ name: file.name, success: r.success, error: r.error })
          } catch {
            results.push({ name: file.name, success: false, error: 'Upload failed' })
          }
        }
        setUploadResults(results)
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
            <img src="/brand/white.png" alt="Firm Funds" className="h-10 w-auto" />
            <div className="w-px h-8 bg-white/15" />
            <p className="text-sm font-medium text-white">Brokerage Portal{brokerage ? ` — ${brokerage.name}` : ''}</p>
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
              {uploadResults.length > 0 && (
                <div className="rounded-lg p-3 mb-6 text-left space-y-1.5 bg-muted border border-border">
                  <p className="text-xs font-semibold mb-1 text-muted-foreground">Document uploads:</p>
                  {uploadResults.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      {r.success ? <CheckCircle2 size={12} className="text-primary" /> : <AlertCircle size={12} className="text-destructive" />}
                      <span className="truncate">{r.name}</span>
                      {!r.success && r.error && <span className="text-destructive">— {r.error}</span>}
                    </div>
                  ))}
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
            <button onClick={() => router.push('/brokerage')} className="p-1.5 rounded-lg text-white/50 hover:text-primary" aria-label="Back">
              <ArrowLeft size={16} />
            </button>
            <img src="/brand/white.png" alt="Firm Funds" className="h-10 w-auto" />
            <div className="w-px h-8 bg-white/15 hidden sm:block" />
            <p className="text-sm font-medium text-white hidden sm:block">Submit Advance Request{brokerage ? ` — ${brokerage.name}` : ''}</p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">New advance request</h1>
          <p className="text-sm text-muted-foreground mt-1">Submitting on behalf of one of your agents.</p>
        </div>

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
                className="w-full px-4 py-2 rounded-lg text-sm bg-input border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
              >
                <option value="">Choose an agent…</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.last_name}, {a.first_name}{a.account_activated_at ? '' : ' — not activated'}
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

          {/* Property */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><MapPin size={16} /> Property</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <AddressAutocomplete value={address} onChange={setAddress} required />
              <div>
                <Label htmlFor="txtype">Transaction type</Label>
                <select id="txtype" value={transactionType} onChange={(e) => setTransactionType(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg text-sm bg-input border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary">
                  <option value="buy">Buy side</option>
                  <option value="sell">Sell side</option>
                  <option value="both">Both sides</option>
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
                <Input id="closing" type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="gross">Gross commission ($) <span className="text-destructive">*</span></Label>
                <Input id="gross" type="number" step="0.01" min="0" value={grossCommission} onChange={(e) => setGrossCommission(e.target.value)} placeholder="e.g. 25000" required />
              </div>
              <div>
                <Label htmlFor="split">Brokerage split % <span className="text-destructive">*</span></Label>
                <Input id="split" type="number" step="0.5" min="0" max="100" value={brokerageSplitPct} onChange={(e) => setBrokerageSplitPct(e.target.value)} placeholder="e.g. 5" required />
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
                      <input type="file" accept={slot.types} multiple className="hidden" onChange={(e) => handleFileAdd(slot.key, e)} />
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

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => router.push('/brokerage')}>Cancel</Button>
            <Button type="submit" disabled={submitting || uploadingDocs || !preview || !agentActivated || missing.length > 0} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {submitting ? 'Submitting…' : uploadingDocs ? 'Uploading docs…' : <>Submit deal <Send size={14} className="ml-1" /></>}
            </Button>
          </div>
        </form>
      </main>
    </div>
  )
}
