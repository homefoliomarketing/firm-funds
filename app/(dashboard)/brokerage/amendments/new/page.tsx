'use client'

import { useEffect, useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import {
  ArrowLeft, CalendarClock, Send, Upload, AlertCircle, FileText, X,
} from 'lucide-react'
import {
  submitClosingDateAmendmentAsBrokerage,
  getDealAmendments,
} from '@/lib/actions/amendment-actions'
import { calculateDeal } from '@/lib/calculations'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  MIN_DAYS_UNTIL_CLOSING,
  MAX_DAYS_UNTIL_CLOSING,
  calcDaysUntilClosing,
  formatStatusLabel,
  getStatusBadgeClass,
} from '@/lib/constants'
import { formatCurrency, formatDate } from '@/lib/formatting'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import SignOutModal from '@/components/SignOutModal'
import BrokerageBrandLogo from '@/components/BrokerageBrandLogo'
import { DealNumber } from '@/components/DealNumber'

interface DealRow {
  id: string
  status: string
  deal_number: string | null
  property_address: string
  closing_date: string
  gross_commission: number
  brokerage_split_pct: number
  brokerage_referral_pct: number | null
  days_until_closing: number
  discount_fee: number
  settlement_period_fee: number | null
  advance_amount: number
  due_date: string | null
  agent: { first_name: string; last_name: string } | null
}

function AmendmentNewInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [deals, setDeals] = useState<DealRow[]>([])
  // Brokerage (for header branding — generated logo or FF default)
  const [brokerage, setBrokerage] = useState<{ name: string; logo_url: string | null; logo_includes_tagline: boolean } | null>(null)
  const [pendingDealIds, setPendingDealIds] = useState<Set<string>>(new Set())

  const [selectedDealId, setSelectedDealId] = useState<string>('')
  const [newClosingDate, setNewClosingDate] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()
      if (!profile || profile.role !== 'brokerage_admin' || !profile.brokerage_id) {
        router.push('/login')
        return
      }

      // Load brokerage row for header branding
      const { data: brokerageData } = await supabase
        .from('brokerages')
        .select('name, logo_url, logo_includes_tagline')
        .eq('id', profile.brokerage_id)
        .single()
      if (brokerageData) setBrokerage(brokerageData as { name: string; logo_url: string | null; logo_includes_tagline: boolean })

      const { data: dealData } = await supabase
        .from('deals')
        .select('id, status, deal_number, property_address, closing_date, gross_commission, brokerage_split_pct, brokerage_referral_pct, days_until_closing, discount_fee, settlement_period_fee, advance_amount, due_date, agent:agents(first_name, last_name)')
        .eq('brokerage_id', profile.brokerage_id)
        .in('status', ['approved', 'funded'])
        .order('closing_date', { ascending: true })

      const dealsList = (dealData as unknown as DealRow[]) || []
      setDeals(dealsList)

      // Identify which of these deals already have a pending amendment
      const pendingChecks = await Promise.all(
        dealsList.map(d => getDealAmendments(d.id))
      )
      const pendingSet = new Set<string>()
      pendingChecks.forEach((res, i) => {
        if (res.success && Array.isArray(res.data) && res.data.some((a: { status?: string }) => a.status === 'pending')) {
          pendingSet.add(dealsList[i].id)
        }
      })
      setPendingDealIds(pendingSet)

      // Preselect deal from ?dealId= query param if eligible
      const qpDealId = searchParams?.get('dealId')
      if (qpDealId && dealsList.some(d => d.id === qpDealId) && !pendingSet.has(qpDealId)) {
        setSelectedDealId(qpDealId)
      }

      setLoading(false)
    }
    load()
    // supabase/router/searchParams are stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const eligibleDeals = useMemo(
    () => deals.filter(d => !pendingDealIds.has(d.id)),
    [deals, pendingDealIds]
  )

  const selectedDeal = useMemo(
    () => deals.find(d => d.id === selectedDealId) || null,
    [deals, selectedDealId]
  )

  // Live preview — recompute fees with the new closing date
  const preview = useMemo(() => {
    if (!selectedDeal || !newClosingDate) return null
    try {
      const newDays = calcDaysUntilClosing(newClosingDate)
      if (newDays < MIN_DAYS_UNTIL_CLOSING || newDays > MAX_DAYS_UNTIL_CLOSING) return null
      const referralPct = selectedDeal.brokerage_referral_pct ?? 0.20
      const calc = calculateDeal({
        grossCommission: selectedDeal.gross_commission,
        brokerageSplitPct: selectedDeal.brokerage_split_pct,
        daysUntilClosing: newDays,
        discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
        brokerageReferralPct: referralPct,
      })
      const isFunded = selectedDeal.status === 'funded'
      const oldDiscountFee = selectedDeal.discount_fee || 0
      const feeAdjustment = isFunded ? calc.discountFee - oldDiscountFee : 0
      return {
        newDays,
        newDiscountFee: calc.discountFee,
        newSettlementPeriodFee: calc.settlementPeriodFee,
        newBrokerageReferralFee: calc.brokerageReferralFee,
        newAdvanceAmount: calc.advanceAmount,
        isFunded,
        feeAdjustment,
      }
    } catch {
      return null
    }
  }, [selectedDeal, newClosingDate])

  const dateInvalid = useMemo(() => {
    if (!newClosingDate) return null
    if (!selectedDeal) return null
    if (newClosingDate === selectedDeal.closing_date) {
      return 'New closing date is the same as the current closing date.'
    }
    const newDays = calcDaysUntilClosing(newClosingDate)
    if (newDays < MIN_DAYS_UNTIL_CLOSING || newDays > MAX_DAYS_UNTIL_CLOSING) {
      return `New closing date must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING} days from today.`
    }
    return null
  }, [newClosingDate, selectedDeal])

  const canSubmit = !!(selectedDealId && newClosingDate && file && !dateInvalid && !submitting)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || !selectedDeal || !file) return
    setSubmitting(true)
    setError(null)
    const formData = new FormData()
    formData.append('dealId', selectedDeal.id)
    formData.append('newClosingDate', newClosingDate)
    formData.append('file', file)
    const result = await submitClosingDateAmendmentAsBrokerage(formData)
    if (result.success) {
      setSuccess(true)
      setTimeout(() => router.push('/brokerage'), 1500)
    } else {
      setError(result.error || 'Failed to submit amendment request')
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-card border-b border-border">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-5 w-48 mb-2" />
            <Skeleton className="h-3 w-32" />
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card className="p-6 space-y-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card/80 backdrop-blur-sm sticky top-0 z-40 border-b border-border">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <BrokerageBrandLogo logoUrl={brokerage?.logo_url} brokerageName={brokerage?.name} logoIncludesTagline={brokerage?.logo_includes_tagline} size="sm" />
            <div className="w-px h-6 bg-border" />
            <button
              onClick={() => router.push('/brokerage')}
              className="flex items-center gap-1.5 text-sm transition-colors text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft size={16} />
              <span className="hidden sm:inline">Back</span>
            </button>
          </div>
          <SignOutModal onConfirm={handleLogout} />
        </div>
      </header>

      <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <CalendarClock size={22} className="text-primary" />
            Request a Deal Change
          </h1>
          <p className="text-sm mt-1 text-muted-foreground">
            Submit a closing-date amendment for one of your brokerage&apos;s deals. Admin will review the request and the executed amendment, then send the updated CPA for signature.
          </p>
        </div>

        {success && (
          <Alert className="mb-6 border-primary/30 bg-primary/10">
            <AlertDescription className="text-primary">
              Amendment request submitted. Redirecting to your dashboard…
            </AlertDescription>
          </Alert>
        )}

        {!success && eligibleDeals.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center">
              <CalendarClock size={28} className="mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm font-medium text-foreground">No deals are currently eligible for amendment.</p>
              <p className="text-xs mt-1.5 text-muted-foreground">
                Closing-date amendments can be requested on deals that are <strong>approved</strong> or <strong>funded</strong> and don&apos;t already have a pending amendment under review.
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => router.push('/brokerage')}>
                Back to dashboard
              </Button>
            </CardContent>
          </Card>
        )}

        {!success && eligibleDeals.length > 0 && (
          <form onSubmit={handleSubmit} className="space-y-5">
            <Card>
              <CardHeader className="border-b border-border py-4">
                <CardTitle className="text-base">Deal</CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Choose deal</Label>
                <select
                  value={selectedDealId}
                  onChange={(e) => setSelectedDealId(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-base sm:text-sm bg-background border border-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
                  disabled={submitting}
                >
                  <option value="">Select a deal</option>
                  {eligibleDeals.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.property_address} · {d.agent ? `${d.agent.first_name} ${d.agent.last_name}` : 'Agent'} · closes {formatDate(d.closing_date)} ({formatStatusLabel(d.status)})
                    </option>
                  ))}
                </select>
                {pendingDealIds.size > 0 && (
                  <p className="text-[11px] text-muted-foreground/80 mt-2">
                    {pendingDealIds.size} deal{pendingDealIds.size === 1 ? ' is' : 's are'} hidden from this list because {pendingDealIds.size === 1 ? 'it already has' : 'they already have'} a pending amendment under admin review.
                  </p>
                )}

                {selectedDeal && (
                  <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    {selectedDeal.deal_number && (
                      <div>
                        <p className="text-muted-foreground">Deal number</p>
                        <div className="mt-0.5">
                          <DealNumber value={selectedDeal.deal_number} />
                        </div>
                      </div>
                    )}
                    <div>
                      <p className="text-muted-foreground">Status</p>
                      <p>
                        <span className={`inline-flex px-2 py-0.5 mt-0.5 text-[10px] font-semibold rounded ${getStatusBadgeClass(selectedDeal.status)}`}>
                          {formatStatusLabel(selectedDeal.status)}
                        </span>
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Current closing date</p>
                      <p className="font-medium text-foreground">{formatDate(selectedDeal.closing_date)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Current advance</p>
                      <p className="font-medium text-foreground">{formatCurrency(selectedDeal.advance_amount)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Agent</p>
                      <p className="font-medium text-foreground">{selectedDeal.agent ? `${selectedDeal.agent.first_name} ${selectedDeal.agent.last_name}` : '-'}</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {selectedDeal && (
              <>
                <Card>
                  <CardHeader className="border-b border-border py-4">
                    <CardTitle className="text-base">New closing date</CardTitle>
                  </CardHeader>
                  <CardContent className="p-5 space-y-2">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Closing date</Label>
                    <Input
                      type="date"
                      value={newClosingDate}
                      onChange={(e) => setNewClosingDate(e.target.value)}
                      min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                      disabled={submitting}
                    />
                    {dateInvalid && (
                      <p className="text-xs text-destructive">{dateInvalid}</p>
                    )}
                  </CardContent>
                </Card>

                {preview && (
                  <Card className="border-primary/30 bg-primary/[0.04]">
                    <CardHeader className="border-b border-primary/20 py-4">
                      <CardTitle className="text-base text-primary">Financial impact preview</CardTitle>
                    </CardHeader>
                    <CardContent className="p-5">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                        <div className="font-semibold text-muted-foreground"></div>
                        <div className="font-semibold text-muted-foreground text-right">Current</div>
                        <div className="font-semibold text-primary text-right">After amendment</div>

                        <div className="text-muted-foreground">Days until closing</div>
                        <div className="text-right text-foreground tabular-nums">{selectedDeal.days_until_closing}</div>
                        <div className="text-right text-primary font-semibold tabular-nums">{preview.newDays}</div>

                        <div className="text-muted-foreground">Discount fee</div>
                        <div className="text-right text-foreground tabular-nums">{formatCurrency(selectedDeal.discount_fee)}</div>
                        <div className="text-right text-primary font-semibold tabular-nums">{formatCurrency(preview.newDiscountFee)}</div>

                        <div className="text-muted-foreground">Settlement period fee</div>
                        <div className="text-right text-foreground tabular-nums">{formatCurrency(selectedDeal.settlement_period_fee || 0)}</div>
                        <div className="text-right text-primary font-semibold tabular-nums">
                          {preview.isFunded ? formatCurrency(selectedDeal.settlement_period_fee || 0) : formatCurrency(preview.newSettlementPeriodFee)}
                          {preview.isFunded && <span className="ml-1 text-[10px] text-muted-foreground">(locked)</span>}
                        </div>

                        <div className="text-muted-foreground">Brokerage profit share</div>
                        <div className="text-right text-foreground tabular-nums">-</div>
                        <div className="text-right text-primary font-semibold tabular-nums">
                          {preview.isFunded ? '-' : formatCurrency(preview.newBrokerageReferralFee)}
                          {preview.isFunded && <span className="ml-1 text-[10px] text-muted-foreground">(locked)</span>}
                        </div>

                        <div className="text-muted-foreground pt-2 border-t border-border/40 mt-1">Agent advance</div>
                        <div className="text-right text-foreground tabular-nums pt-2 border-t border-border/40 mt-1">{formatCurrency(selectedDeal.advance_amount)}</div>
                        <div className="text-right text-primary font-bold tabular-nums pt-2 border-t border-border/40 mt-1">
                          {preview.isFunded ? formatCurrency(selectedDeal.advance_amount) : formatCurrency(preview.newAdvanceAmount)}
                          {preview.isFunded && <span className="ml-1 text-[10px] text-muted-foreground">(locked)</span>}
                        </div>
                      </div>

                      {preview.isFunded && Math.abs(preview.feeAdjustment) > 0.005 && (
                        <div className="mt-4 rounded-lg px-3 py-2 bg-blue-500/10 border border-blue-500/20 text-xs leading-relaxed text-blue-400">
                          <strong>Funded deal note:</strong>{' '}
                          {preview.feeAdjustment > 0 ? (
                            <>This deal is already funded, so the agent advance and Settlement Period Fee stay the same. Because the new closing date is <strong>later</strong>, the additional discount fee of <strong>{formatCurrency(preview.feeAdjustment)}</strong> will be charged to the agent&apos;s Firm Funds account.</>
                          ) : (
                            <>This deal is already funded, so the agent advance and Settlement Period Fee stay the same. Because the new closing date is <strong>earlier</strong>, the unused discount fee of <strong>{formatCurrency(Math.abs(preview.feeAdjustment))}</strong> will be credited to the agent&apos;s Firm Funds account and refunded after closing.</>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="border-b border-border py-4">
                    <CardTitle className="text-base flex items-center gap-2">
                      <FileText size={16} /> Executed amendment document
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-5 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Upload the fully executed Closing Date Amendment to the Agreement of Purchase &amp; Sale (signed by all parties). PDF preferred.
                    </p>
                    <div className="rounded-lg border border-border p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        {file ? (
                          <p className="text-sm font-medium text-foreground truncate">{file.name} <span className="text-muted-foreground/60">({(file.size / 1024 / 1024).toFixed(2)} MB)</span></p>
                        ) : (
                          <p className="text-sm text-muted-foreground">No file selected</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {file && (
                          <button type="button" onClick={() => setFile(null)} className="text-muted-foreground hover:text-destructive" aria-label="Remove file">
                            <X size={16} />
                          </button>
                        )}
                        <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-input border border-border text-foreground hover:bg-muted">
                          <Upload size={14} /> {file ? 'Replace' : 'Choose file'}
                          {/* Off-screen instead of display:none — some browser/extension combos
                              drop the change event on display:none file inputs (see commit 69c80d9). */}
                          <input
                            type="file"
                            accept="application/pdf,image/jpeg,image/png,.doc,.docx"
                            onChange={(e) => setFile(e.target.files?.[0] || null)}
                            disabled={submitting}
                            style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', borderWidth: 0 }}
                          />
                        </label>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => router.push('/brokerage')} disabled={submitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {submitting ? 'Submitting…' : <>Submit request <Send size={14} className="ml-1" /></>}
              </Button>
            </div>

            <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
              <AlertCircle size={11} className="inline align-text-bottom mr-1" />
              An admin will review your request and the uploaded amendment. Once approved, the agent will receive a new DocuSign email to sign the amended CPA.
            </p>
          </form>
        )}
      </main>
    </div>
  )
}

export default function BrokerageAmendmentNewPage() {
  return (
    <Suspense fallback={null}>
      <AmendmentNewInner />
    </Suspense>
  )
}
