'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Calculator, Send, DollarSign, MapPin, Calendar, Percent } from 'lucide-react'
import { submitDeal, calculateDealPreview } from '@/lib/actions/deal-actions'
import { useTheme } from '@/lib/theme'
import ThemeToggle from '@/components/ThemeToggle'

export default function NewDealPage() {
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { colors, isDark } = useTheme()

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

  const [preview, setPreview] = useState<{
    netCommission: number
    daysUntilClosing: number
    discountFee: number
    advanceAmount: number
    brokerageReferralFee: number
    amountDueFromBrokerage: number
  } | null>(null)

  // Combine address fields into a single string for storage and display
  const propertyAddress = [streetAddress.trim(), city.trim(), province.trim(), postalCode.trim().toUpperCase()].filter(Boolean).join(', ')

  const router = useRouter()
  const supabase = createClient()

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
    // cancelled flag prevents stale responses from overwriting newer ones
    let cancelled = false
    const timer = setTimeout(async () => {
      const result = await calculateDealPreview({ grossCommission: gross, brokerageSplitPct: splitPct, closingDate, agentId: agent.id })
      if (cancelled) return // discard stale response
      if (result.success && result.data) {
        setPreview({
          netCommission: result.data.netCommission, daysUntilClosing: result.data.daysUntilClosing,
          discountFee: result.data.discountFee, advanceAmount: result.data.advanceAmount,
          brokerageReferralFee: result.data.brokerageReferralFee, amountDueFromBrokerage: result.data.amountDueFromBrokerage,
        })
      } else { setPreview(null) }
    }, 400)
    return () => { clearTimeout(timer); cancelled = true }
  }, [grossCommission, brokerageSplitPct, closingDate, agent])

  // Compute which fields are still missing for the preview/submit
  const missingFields: string[] = []
  if (!streetAddress.trim()) missingFields.push('Address')
  if (!city.trim()) missingFields.push('City')
  if (!postalCode.trim()) missingFields.push('Postal Code')
  if (!closingDate) missingFields.push('Closing Date')
  if (!grossCommission || parseFloat(grossCommission) <= 0) missingFields.push('Gross Commission')
  if (brokerageSplitPct === '' || isNaN(parseFloat(brokerageSplitPct)) || parseFloat(brokerageSplitPct) < 0 || parseFloat(brokerageSplitPct) > 100) missingFields.push('Brokerage Split %')

  const handleSubmitClick = (e: React.FormEvent) => {
    e.preventDefault(); setError(null)
    if (!preview || !agent) { setError('Please fill in all required fields with valid values.'); return }
    setShowConfirmation(true)
  }

  const handleConfirmSubmit = async () => {
    setError(null); setSubmitting(true); setShowConfirmation(false)
    try {
      const result = await submitDeal({
        propertyAddress, closingDate, grossCommission: parseFloat(grossCommission),
        brokerageSplitPct: parseFloat(brokerageSplitPct), transactionType, notes: notes.trim() || undefined,
      })
      if (!result.success) { setError(result.error || 'Failed to submit deal. Please try again.'); setSubmitting(false); return }
      if (result.data) {
        setPreview({
          netCommission: result.data.netCommission, daysUntilClosing: result.data.daysUntilClosing,
          discountFee: result.data.discountFee, advanceAmount: result.data.advanceAmount,
          brokerageReferralFee: result.data.brokerageReferralFee, amountDueFromBrokerage: result.data.amountDueFromBrokerage,
        })
      }
      setSubmitted(true)
    } catch (err) { setError('An unexpected error occurred. Please try again.'); setSubmitting(false) }
  }

  const formatCurrency = (amount: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}>
        <div style={{ color: colors.textMuted }} className="text-lg">Loading...</div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}>
        <div className="rounded-2xl p-8 max-w-md mx-auto text-center" style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, boxShadow: `0 4px 24px ${colors.shadowColor}` }}>
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: colors.successBg }}>
            <Send size={28} style={{ color: colors.successText }} />
          </div>
          <h2 className="text-xl font-bold mb-2" style={{ color: colors.textPrimary }}>Deal Submitted!</h2>
          <p className="text-sm mb-2" style={{ color: colors.textSecondary }}>Your commission advance request has been submitted for review.</p>
          <p className="text-xs mb-6" style={{ color: colors.textMuted }}>You&apos;ll be notified when there&apos;s an update on your deal.</p>
          <div className="rounded-xl p-4 mb-6 text-left" style={{ background: colors.tableHeaderBg, border: `1px solid ${colors.divider}` }}>
            <div className="text-sm space-y-2">
              <div className="flex justify-between">
                <span style={{ color: colors.textMuted }}>Property</span>
                <span className="font-medium" style={{ color: colors.textPrimary }}>{propertyAddress}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: colors.textMuted }}>Advance Amount</span>
                <span className="font-bold" style={{ color: colors.successText }}>{preview && formatCurrency(preview.advanceAmount)}</span>
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => router.push('/agent')}
              className="flex-1 text-white py-2.5 px-4 rounded-lg font-medium text-sm transition-colors"
              style={{ background: colors.headerBgGradient }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'linear-gradient(135deg, #2D2D2D, #3D3D3D)'}
              onMouseLeave={(e) => e.currentTarget.style.background = colors.headerBgGradient}
            >
              Back to Dashboard
            </button>
            <button
              onClick={() => {
                setSubmitted(false); setStreetAddress(''); setCity(''); setProvince('Ontario'); setPostalCode('')
                setClosingDate(''); setGrossCommission(''); setBrokerageSplitPct(''); setTransactionType('buy'); setNotes(''); setPreview(null)
              }}
              className="flex-1 py-2.5 px-4 rounded-lg font-medium text-sm transition-colors"
              style={{ border: `1px solid ${colors.border}`, color: colors.textSecondary }}
              onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              Submit Another
            </button>
          </div>
        </div>
      </div>
    )
  }

  const inputStyle = { border: `1px solid ${colors.inputBorder}`, color: colors.inputText, background: colors.inputBg }
  const inputFocus = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.boxShadow = isDark ? '0 0 0 2px rgba(196,176,152,0.25)' : '0 0 0 2px #C4B098'
    e.currentTarget.style.borderColor = colors.gold
  }
  const inputBlur = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.boxShadow = 'none'
    e.currentTarget.style.borderColor = colors.inputBorder
  }

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 py-5">
            <img src="/brand/logo-white.png" alt="Firm Funds" className="h-28 w-auto" />
            <div className="w-px h-6" style={{ background: 'rgba(255,255,255,0.15)' }} />
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
              <h1 className="text-lg font-bold text-white">New Advance Request</h1>
              <p className="text-xs" style={{ color: colors.textMuted }}>Submit a commission advance for a firm deal</p>
            </div>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <form onSubmit={handleSubmitClick}>
          {error && (
            <div className="mb-6 p-4 rounded-xl text-sm font-medium" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText }}>
              {error}
            </div>
          )}

          {/* Deal Information */}
          <div className="rounded-xl overflow-hidden mb-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <div className="px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
              <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Deal Information</h3>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                  <span className="flex items-center gap-1.5"><MapPin size={12} style={{ color: colors.gold }} /> Street Address *</span>
                </label>
                <input
                  type="text" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)}
                  placeholder="123 Main Street"
                  className="w-full rounded-lg px-4 py-2.5 text-sm outline-none" style={inputStyle}
                  onFocus={inputFocus} onBlur={inputBlur} required
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>City *</label>
                  <input
                    type="text" value={city} onChange={(e) => setCity(e.target.value)}
                    placeholder="Toronto"
                    className="w-full rounded-lg px-4 py-2.5 text-sm outline-none" style={inputStyle}
                    onFocus={inputFocus} onBlur={inputBlur} required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Province</label>
                  <input
                    type="text" value={province} onChange={(e) => setProvince(e.target.value)}
                    placeholder="Ontario"
                    className="w-full rounded-lg px-4 py-2.5 text-sm outline-none" style={inputStyle}
                    onFocus={inputFocus} onBlur={inputBlur}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Postal Code *</label>
                  <input
                    type="text" value={postalCode} onChange={(e) => setPostalCode(e.target.value)}
                    placeholder="M5V 1A1"
                    className="w-full rounded-lg px-4 py-2.5 text-sm outline-none uppercase" style={inputStyle}
                    onFocus={inputFocus} onBlur={inputBlur} required maxLength={7}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                    <span className="flex items-center gap-1.5"><Calendar size={12} style={{ color: colors.gold }} /> Closing Date *</span>
                  </label>
                  <input
                    type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)}
                    min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                    className="w-full rounded-lg px-4 py-2.5 text-sm outline-none" style={inputStyle}
                    onFocus={inputFocus} onBlur={inputBlur} required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Your Representation *</label>
                  <select
                    value={transactionType} onChange={(e) => setTransactionType(e.target.value)}
                    className="w-full rounded-lg px-4 py-2.5 text-sm outline-none" style={inputStyle}
                    onFocus={inputFocus as any} onBlur={inputBlur as any} required
                  >
                    <option value="buy">Buyer Side</option>
                    <option value="sell">Seller / Listing Side</option>
                    <option value="both">Both Sides (Double-End)</option>
                  </select>
                  <p className="text-xs mt-1" style={{ color: colors.textFaint }}>Which side of the deal are you representing?</p>
                </div>
              </div>
            </div>
          </div>

          {/* Commission Details */}
          <div className="rounded-xl overflow-hidden mb-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
            <div className="px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
              <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Commission Details</h3>
            </div>
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                    <span className="flex items-center gap-1.5"><DollarSign size={12} style={{ color: colors.gold }} /> Gross Commission ($) *</span>
                  </label>
                  <input
                    type="number" value={grossCommission} onChange={(e) => setGrossCommission(e.target.value)}
                    placeholder="15000.00" min="0" step="0.01"
                    className="w-full rounded-lg px-4 py-2.5 text-sm outline-none" style={inputStyle}
                    onFocus={inputFocus} onBlur={inputBlur} required
                  />
                  <p className="text-xs mt-1" style={{ color: colors.textFaint }}>Your total commission on this deal before brokerage split</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                    <span className="flex items-center gap-1.5"><Percent size={12} style={{ color: colors.gold }} /> Brokerage Split (%) *</span>
                  </label>
                  <input
                    type="number" value={brokerageSplitPct} onChange={(e) => setBrokerageSplitPct(e.target.value)}
                    placeholder="20" min="0" max="100" step="0.1"
                    className="w-full rounded-lg px-4 py-2.5 text-sm outline-none" style={inputStyle}
                    onFocus={inputFocus} onBlur={inputBlur} required
                  />
                  <p className="text-xs mt-1" style={{ color: colors.textFaint }}>The percentage your brokerage takes from your gross commission</p>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Notes (optional)</label>
                <textarea
                  value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any additional details about this deal..."
                  rows={3}
                  className="w-full rounded-lg px-4 py-2.5 text-sm outline-none resize-none" style={inputStyle}
                  onFocus={inputFocus as any} onBlur={inputBlur as any}
                />
              </div>
            </div>
          </div>

          {/* Live Preview */}
          {preview && (
            <div className="rounded-xl overflow-hidden mb-6" style={{ background: colors.cardBg, border: `2px solid ${colors.successBorder}` }}>
              <div className="px-6 py-4 flex items-center gap-2" style={{ background: colors.successBg, borderBottom: `1px solid ${colors.successBorder}` }}>
                <Calculator size={16} style={{ color: colors.successText }} />
                <div>
                  <h3 className="text-base font-bold" style={{ color: colors.successText }}>Advance Preview</h3>
                  <p className="text-xs" style={{ color: colors.successText, opacity: 0.7 }}>This is an estimate. Final amounts confirmed after underwriting.</p>
                </div>
              </div>
              <div className="p-6">
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Gross Commission</span><span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(parseFloat(grossCommission))}</span></div>
                  <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Brokerage Split ({brokerageSplitPct}%)</span><span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(parseFloat(grossCommission) - preview.netCommission)}</span></div>
                  <div className="flex justify-between pt-2" style={{ borderTop: `1px solid ${colors.divider}` }}><span className="font-medium" style={{ color: colors.textPrimary }}>Your Net Commission</span><span className="font-semibold" style={{ color: colors.textPrimary }}>{formatCurrency(preview.netCommission)}</span></div>
                  <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Days Until Closing</span><span className="font-medium" style={{ color: colors.textPrimary }}>{preview.daysUntilClosing} days</span></div>
                  <div className="flex justify-between"><span style={{ color: colors.textMuted }}>Discount Fee ($0.75/$1,000/day × {preview.daysUntilClosing} days)</span><span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(preview.discountFee)}</span></div>
                  <div className="flex justify-between items-center rounded-xl px-5 py-4 -mx-1 mt-2" style={{ background: colors.successBg, border: `1px solid ${colors.successBorder}` }}>
                    <span className="font-bold text-base" style={{ color: colors.successText }}>Your Advance Amount</span>
                    <span className="font-black text-xl" style={{ color: colors.successText }}>{formatCurrency(preview.advanceAmount)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Validation Hints */}
          {!preview && missingFields.length > 0 && (
            <div className="rounded-xl p-4 mb-4 text-sm" style={{ background: colors.warningBg, border: `1px solid ${colors.warningBorder}`, color: colors.warningText }}>
              <p className="font-semibold mb-1">Complete these fields to see your advance preview:</p>
              <p>{missingFields.join(' · ')}</p>
            </div>
          )}
          {!preview && missingFields.length === 0 && (
            <div className="rounded-xl p-4 mb-4 text-sm" style={{ background: colors.infoBg, border: `1px solid ${colors.infoBorder}`, color: colors.infoText }}>
              Calculating your advance preview...
            </div>
          )}

          {/* Submit */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => router.push('/agent')}
              className="flex-1 py-3 px-4 rounded-lg font-medium text-sm transition-colors"
              style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, color: colors.textSecondary }}
              onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
              onMouseLeave={(e) => e.currentTarget.style.background = colors.cardBg}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!preview || submitting}
              className="flex-1 text-white py-3 px-4 rounded-lg font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
              style={{ background: colors.headerBgGradient }}
              onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = 'linear-gradient(135deg, #2D2D2D, #3D3D3D)' }}
              onMouseLeave={(e) => e.currentTarget.style.background = colors.headerBgGradient}
            >
              {submitting ? 'Submitting...' : (<><Send size={16} />Review &amp; Submit</>)}
            </button>
          </div>
        </form>

        {/* Confirmation Modal */}
        {showConfirmation && preview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: colors.overlayBg, backdropFilter: 'blur(4px)' }}>
            <div className="rounded-2xl max-w-lg w-full overflow-hidden" style={{ background: colors.cardBg, boxShadow: '0 25px 60px rgba(0,0,0,0.3)' }}>
              <div className="px-6 py-5" style={{ background: colors.headerBgGradient }}>
                <h3 className="text-lg font-bold text-white">Confirm Your Advance Request</h3>
                <p className="text-xs mt-1" style={{ color: colors.gold }}>Please review the details below before submitting.</p>
              </div>
              <div className="p-6">
                {/* Deal Summary */}
                <div className="space-y-3 text-sm mb-5">
                  <div className="flex justify-between">
                    <span style={{ color: colors.textMuted }}>Property</span>
                    <span className="font-medium text-right max-w-[60%]" style={{ color: colors.textPrimary }}>{propertyAddress}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: colors.textMuted }}>Closing Date</span>
                    <span className="font-medium" style={{ color: colors.textPrimary }}>{new Date(closingDate + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: colors.textMuted }}>Representation</span>
                    <span className="font-medium capitalize" style={{ color: colors.textPrimary }}>{transactionType === 'buy' ? 'Buyer Side' : transactionType === 'sell' ? 'Seller / Listing Side' : 'Both Sides (Double-End)'}</span>
                  </div>
                </div>

                {/* Financial Summary */}
                <div className="rounded-xl p-4 mb-5" style={{ background: colors.tableHeaderBg, border: `1px solid ${colors.divider}` }}>
                  <div className="space-y-2.5 text-sm">
                    <div className="flex justify-between">
                      <span style={{ color: colors.textMuted }}>Gross Commission</span>
                      <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(parseFloat(grossCommission))}</span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: colors.textMuted }}>Your Net Commission</span>
                      <span className="font-medium" style={{ color: colors.textPrimary }}>{formatCurrency(preview.netCommission)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: colors.textMuted }}>Discount Fee ({preview.daysUntilClosing} days)</span>
                      <span className="font-medium" style={{ color: colors.errorText }}>-{formatCurrency(preview.discountFee)}</span>
                    </div>
                    <div className="flex justify-between pt-2.5" style={{ borderTop: `1px solid ${colors.border}` }}>
                      <span className="font-bold" style={{ color: colors.successText }}>Your Advance Amount</span>
                      <span className="font-black text-lg" style={{ color: colors.successText }}>{formatCurrency(preview.advanceAmount)}</span>
                    </div>
                  </div>
                </div>

                <p className="text-xs mb-5" style={{ color: colors.textMuted }}>
                  By submitting, you confirm the above details are accurate. Final amounts are subject to underwriting review. You will need to upload supporting documents after submission.
                </p>

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setShowConfirmation(false)}
                    className="flex-1 py-3 px-4 rounded-lg font-medium text-sm transition-colors"
                    style={{ border: `1px solid ${colors.border}`, color: colors.textSecondary }}
                    onMouseEnter={(e) => e.currentTarget.style.background = colors.cardHoverBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Go Back
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmSubmit}
                    disabled={submitting}
                    className="flex-1 text-white py-3 px-4 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg, #1A7A2E, #15631F)' }}
                    onMouseEnter={(e) => { if (!submitting) e.currentTarget.style.background = 'linear-gradient(135deg, #15631F, #0F4D17)' }}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'linear-gradient(135deg, #1A7A2E, #15631F)'}
                  >
                    {submitting ? 'Submitting...' : (<><Send size={16} />Confirm &amp; Submit</>)}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
