'use client'

import { useState, useEffect, useRef } from 'react'
import { Shield, Upload, XCircle, Clock, AlertCircle, FileText, Smartphone, Mail, MapPin, Phone, ChevronRight, ChevronDown, Landmark } from 'lucide-react'
import { sendKycMobileLink } from '@/lib/actions/kyc-actions'
import { updateAgentProfile, submitAgentBanking } from '@/lib/actions/profile-actions'
import { createClient } from '@/lib/supabase/client'
import { KYC_DOCUMENT_TYPES, MAX_KYC_UPLOAD_SIZE_BYTES, ALLOWED_KYC_MIME_TYPES, getKycBadgeClass } from '@/lib/constants'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

interface AgentKycGateProps {
  agent: {
    id: string
    first_name: string
    last_name: string
    kyc_status: string
    kyc_rejection_reason: string | null
    phone: string | null
    address_street: string | null
    address_city: string | null
    address_province: string | null
    address_postal_code: string | null
  }
  onKycSubmitted: () => void
}

export default function AgentKycGate({ agent, onKycSubmitted }: AgentKycGateProps) {
  // Step tracking: 'address' (collect info) or 'kyc' (upload ID)
  const hasAddress = !!(agent.address_street && agent.address_city && agent.address_postal_code && agent.phone)
  const [step, setStep] = useState<'address' | 'kyc'>(hasAddress ? 'kyc' : 'address')

  // Address form state
  const [phone, setPhone] = useState(agent.phone || '')
  const [addressStreet, setAddressStreet] = useState(agent.address_street || '')
  const [addressCity, setAddressCity] = useState(agent.address_city || '')
  const [addressProvince, setAddressProvince] = useState(agent.address_province || 'Ontario')
  const [addressPostalCode, setAddressPostalCode] = useState(agent.address_postal_code || '')
  const [addressSaving, setAddressSaving] = useState(false)

  // Optional banking form state
  const [showBanking, setShowBanking] = useState(false)
  const [transitNumber, setTransitNumber] = useState('')
  const [institutionNumber, setInstitutionNumber] = useState('')
  const [accountNumber, setAccountNumber] = useState('')

  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [documentType, setDocumentType] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [sendingMobileLink, setSendingMobileLink] = useState(false)
  const [mobileLinkSent, setMobileLinkSent] = useState(false)
  const [mobileLinkEmail, setMobileLinkEmail] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elapsedTimeRef = useRef<number>(0)
  const currentDelayRef = useRef<number>(5000)

  // Poll for KYC status changes after mobile link is sent
  useEffect(() => {
    if (!mobileLinkSent) return

    const supabase = createClient()
    const MAX_ELAPSED_TIME = 30 * 60 * 1000 // 30 minutes
    const INTERVALS = [5000, 10000, 15000, 20000, 30000] // 5s → 10s → 15s → 20s → 30s

    const schedulePoll = async () => {
      // Check if we've exceeded 30 minutes
      if (elapsedTimeRef.current >= MAX_ELAPSED_TIME) {
        return // Give up — stop polling
      }

      try {
        const { data } = await supabase
          .from('agents')
          .select('kyc_status')
          .eq('id', agent.id)
          .single()

        if (data && data.kyc_status !== agent.kyc_status && data.kyc_status === 'submitted') {
          // Mobile upload completed — trigger refresh
          if (pollRef.current) clearTimeout(pollRef.current)
          onKycSubmitted()
          return
        }
      } catch (error) {
        console.error('KYC poll error:', error)
      }

      // Determine next delay: find current position in intervals, then cap at 30s
      const nextDelay = INTERVALS[Math.min(Math.floor(elapsedTimeRef.current / 5000), INTERVALS.length - 1)]
      currentDelayRef.current = nextDelay

      // Schedule next poll
      elapsedTimeRef.current += nextDelay
      pollRef.current = setTimeout(schedulePoll, nextDelay)
    }

    // Start polling with initial 5s delay
    elapsedTimeRef.current = 0
    currentDelayRef.current = 5000
    pollRef.current = setTimeout(schedulePoll, 5000)

    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
      elapsedTimeRef.current = 0
      currentDelayRef.current = 5000
    }
  }, [mobileLinkSent, agent.id, agent.kyc_status, onKycSubmitted])

  const handleFileSelect = (file: File) => {
    setError(null)
    if (file.size > MAX_KYC_UPLOAD_SIZE_BYTES) {
      setError('File size exceeds 10MB limit. Please upload a smaller file.')
      return
    }
    if (!(ALLOWED_KYC_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError('Invalid file type. Please upload a JPEG, PNG, or PDF.')
      return
    }
    setSelectedFiles(prev => [...prev, file])
  }

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) handleFileSelect(file)
  }

  const handleSubmit = async () => {
    if (selectedFiles.length === 0 || !documentType) {
      setError('Please select a document type and upload your ID.')
      return
    }
    setSubmitting(true)
    setError(null)

    try {
      // Step 1: Get signed upload URLs from lightweight API route
      const fileNames = selectedFiles.map(f => f.name)
      const urlRes = await fetch('/api/kyc-desktop-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileNames, documentType }),
      })
      const urlData = await urlRes.json()

      if (!urlData.success) {
        setError(urlData.error || 'Failed to prepare upload.')
        setSubmitting(false)
        return
      }

      // Step 2: Upload files directly to Supabase Storage (bypasses Netlify)
      const filePaths: string[] = []
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i]
        const { signedUrl, path } = urlData.data.uploadUrls[i]

        const uploadRes = await fetch(signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        })

        if (!uploadRes.ok) {
          setError(`Upload failed for file ${i + 1}. Please try again.`)
          setSubmitting(false)
          return
        }
        filePaths.push(path)
      }

      // Step 3: Finalize — update DB records via lightweight API route
      const finalRes = await fetch('/api/kyc-desktop-upload', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths, documentType }),
      })
      const finalData = await finalRes.json()

      if (finalData.success) {
        onKycSubmitted()
      } else {
        setError(finalData.error || 'Upload completed but status update failed. Please contact support.')
      }
    } catch (err) {
      console.error('Desktop KYC upload error:', err)
      setError('Upload failed. Please try again.')
    }
    setSubmitting(false)
  }

  // ---- Address form handler ----
  const handleSaveAddress = async () => {
    setError(null)
    if (!phone.trim()) { setError('Phone number is required.'); return }
    if (!addressStreet.trim()) { setError('Street address is required.'); return }
    if (!addressCity.trim()) { setError('City is required.'); return }
    if (!addressPostalCode.trim()) { setError('Postal code is required.'); return }

    // Validate banking if any field is filled
    const hasBankingInput = transitNumber.trim() || institutionNumber.trim() || accountNumber.trim()
    if (hasBankingInput) {
      if (!/^\d{5}$/.test(transitNumber.trim())) { setError('Transit number must be exactly 5 digits.'); return }
      if (!/^\d{3}$/.test(institutionNumber.trim())) { setError('Institution number must be exactly 3 digits.'); return }
      if (!/^\d{7,12}$/.test(accountNumber.trim())) { setError('Account number must be 7-12 digits.'); return }
    }

    setAddressSaving(true)
    const result = await updateAgentProfile({
      agentId: agent.id,
      phone: phone.trim(),
      addressStreet: addressStreet.trim(),
      addressCity: addressCity.trim(),
      addressProvince: addressProvince.trim() || 'Ontario',
      addressPostalCode: addressPostalCode.trim().toUpperCase(),
    })

    if (!result.success) {
      setError(result.error || 'Failed to save your information. Please try again.')
      setAddressSaving(false)
      return
    }

    // Submit banking if filled in
    if (hasBankingInput) {
      const bankResult = await submitAgentBanking({
        agentId: agent.id,
        transitNumber: transitNumber.trim(),
        institutionNumber: institutionNumber.trim(),
        accountNumber: accountNumber.trim(),
      })
      if (!bankResult.success) {
        // Address saved but banking failed — still proceed, just warn
        setError(`Address saved, but banking submission failed: ${bankResult.error}. You can add banking later from your profile.`)
        setAddressSaving(false)
        setStep('kyc')
        return
      }
    }

    setStep('kyc')
    setError(null)
    setAddressSaving(false)
  }

  // ---- Step 1: Address + Phone collection ----
  if (step === 'address') {
    return (
      <div className="max-w-[560px] mx-auto my-10 px-5">
        <Card className="p-8 border-border/50">
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-full mx-auto mb-3 bg-primary/10 border border-primary/30 flex items-center justify-center">
              <MapPin size={24} className="text-primary" />
            </div>
            <h2 className="text-[22px] font-semibold text-foreground mb-2">
              Welcome to Firm Funds
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Before we verify your identity, we need a few details. This information will be used to verify your ID.
            </p>
            <div className="flex items-center justify-center gap-3 mt-4">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">1</div>
                <span className="text-xs font-semibold text-primary">Your Info</span>
              </div>
              <div className="w-8 h-px bg-border" />
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-muted text-muted-foreground text-xs font-bold flex items-center justify-center">2</div>
                <span className="text-xs font-semibold text-muted-foreground">Upload ID</span>
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3.5 py-2.5 mb-4 rounded-lg bg-red-950/40 border border-red-800/50">
              <AlertCircle size={16} className="text-red-400 shrink-0" />
              <span className="text-red-400 text-[13px]">{error}</span>
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <Phone size={12} /> Phone Number
              </Label>
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(416) 555-1234"
              />
              <p className="text-[11px] text-muted-foreground/70">Required for future two-factor authentication</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <MapPin size={12} /> Street Address
              </Label>
              <Input
                type="text"
                value={addressStreet}
                onChange={(e) => setAddressStreet(e.target.value)}
                placeholder="123 Main St, Unit 4"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">City</Label>
                <Input
                  type="text"
                  value={addressCity}
                  onChange={(e) => setAddressCity(e.target.value)}
                  placeholder="Toronto"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Province</Label>
                <Input
                  type="text"
                  value={addressProvince}
                  onChange={(e) => setAddressProvince(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Postal Code</Label>
              <Input
                type="text"
                value={addressPostalCode}
                onChange={(e) => setAddressPostalCode(e.target.value)}
                placeholder="M5V 1A1"
                maxLength={7}
                className="max-w-[160px]"
              />
            </div>

            <Separator className="my-2" />

            {/* Optional Banking Section */}
            <div>
              <button
                type="button"
                onClick={() => setShowBanking(!showBanking)}
                className="flex items-center gap-2 w-full text-left py-2 transition-colors hover:text-primary"
              >
                <Landmark size={14} className="text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Banking Information</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium ml-1">Optional</span>
                {showBanking ? <ChevronDown size={14} className="ml-auto text-muted-foreground" /> : <ChevronRight size={14} className="ml-auto text-muted-foreground" />}
              </button>
              {showBanking && (
                <div className="space-y-3 mt-2 pl-1">
                  <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                    Add your banking details now to speed up your first advance, or add them later from your profile.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transit #</Label>
                      <Input
                        type="text"
                        value={transitNumber}
                        onChange={(e) => setTransitNumber(e.target.value.replace(/\D/g, '').slice(0, 5))}
                        placeholder="12345"
                        maxLength={5}
                      />
                      <p className="text-[10px] text-muted-foreground/60">5 digits</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Institution #</Label>
                      <Input
                        type="text"
                        value={institutionNumber}
                        onChange={(e) => setInstitutionNumber(e.target.value.replace(/\D/g, '').slice(0, 3))}
                        placeholder="001"
                        maxLength={3}
                      />
                      <p className="text-[10px] text-muted-foreground/60">3 digits</p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Account Number</Label>
                    <Input
                      type="text"
                      value={accountNumber}
                      onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
                      placeholder="1234567"
                      maxLength={12}
                    />
                    <p className="text-[10px] text-muted-foreground/60">7-12 digits</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <Button
            onClick={handleSaveAddress}
            disabled={addressSaving}
            className="w-full mt-6"
          >
            {addressSaving ? 'Saving...' : 'Continue to ID Upload'}
            {!addressSaving && <ChevronRight size={16} className="ml-1" />}
          </Button>
        </Card>
      </div>
    )
  }

  // ---- Status: Submitted (awaiting review) ----
  if (agent.kyc_status === 'submitted') {
    return (
      <div className="max-w-[560px] mx-auto my-15 px-5">
        <Card className="p-10 text-center border-border/50">
          <Clock size={48} className="text-blue-400 mx-auto mb-4" />
          <h2 className="text-[22px] font-semibold text-foreground mb-3">
            Identity Verification In Progress
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground mb-5">
            Your government-issued photo ID has been submitted and is under review.
            You&apos;ll be able to submit deals once your identity is verified.
          </p>
          <div
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${getKycBadgeClass('submitted')}`}
          >
            <Clock size={14} /> Submitted — Awaiting Review
          </div>
        </Card>
      </div>
    )
  }

  // ---- Status: Rejected (needs re-upload) ----
  const isRejected = agent.kyc_status === 'rejected'

  return (
    <div className="max-w-[560px] mx-auto my-10 px-5">
      <Card className="p-8 border-border/50">
        {/* Header */}
        <div className="text-center mb-6">
          <Shield size={44} className="text-primary mx-auto mb-3" />
          <h2 className="text-[22px] font-semibold text-foreground mb-2">
            {isRejected ? 'Identity Verification Required' : 'Upload Your ID'}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {isRejected
              ? 'Please re-upload a valid government-issued photo ID.'
              : 'Almost there! Upload a clear copy of a valid government-issued photo ID per FINTRAC requirements.'}
          </p>
          {!isRejected && (
            <div className="flex items-center justify-center gap-3 mt-4">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-primary/20 border border-primary/40 text-primary text-xs font-bold flex items-center justify-center">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                </div>
                <span className="text-xs font-semibold text-primary/70">Your Info</span>
              </div>
              <div className="w-8 h-px bg-primary/30" />
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">2</div>
                <span className="text-xs font-semibold text-primary">Upload ID</span>
              </div>
            </div>
          )}
        </div>

        {/* Step indicator */}
        {!isRejected && (
          <div className="flex items-center gap-2 mb-6 px-1">
            <div className="flex items-center gap-1.5 text-primary text-xs font-semibold">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[11px] font-bold">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              Address
            </div>
            <div className="flex-1 h-px bg-primary/30" />
            <div className="flex items-center gap-1.5 text-primary text-xs font-semibold">
              <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[11px] font-bold">2</div>
              Upload ID
            </div>
          </div>
        )}

        {/* Rejection notice */}
        {isRejected && agent.kyc_rejection_reason && (
          <div className="flex gap-2.5 items-start p-3 px-4 mb-5 rounded-lg bg-red-950/40 border border-red-800/50">
            <XCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-red-400 font-semibold text-[13px] mb-1">
                Previous submission was rejected
              </div>
              <div className="text-red-400/80 text-[13px] leading-relaxed">
                {agent.kyc_rejection_reason}
              </div>
            </div>
          </div>
        )}

        {/* Document type selection */}
        <div className="mb-4">
          <label className="block text-muted-foreground text-[13px] font-medium mb-1.5">
            Type of ID
          </label>
          <select
            value={documentType}
            onChange={e => setDocumentType(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg text-sm bg-input border border-border text-foreground cursor-pointer appearance-auto focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Select ID type...</option>
            {KYC_DOCUMENT_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {/* Selected files list */}
        {selectedFiles.length > 0 && (
          <div className="mb-3">
            {selectedFiles.map((file, i) => (
              <div
                key={i}
                className="flex items-center gap-2.5 px-3 py-2 bg-background rounded-lg mb-1.5 border border-border/50"
              >
                <FileText size={16} className="text-primary shrink-0" />
                <span className="text-foreground text-[13px] flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {file.name}
                </span>
                <span className="text-muted-foreground text-[11px] shrink-0">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <button
                  onClick={() => removeFile(i)}
                  className="text-red-400 hover:text-red-300 shrink-0 p-0.5 transition-colors"
                  title="Remove"
                >
                  <XCircle size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* File upload area */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => document.getElementById('kyc-file-input')?.click()}
          className={`border-2 border-dashed rounded-lg text-center cursor-pointer transition-all mb-4 ${
            dragOver
              ? 'border-primary bg-primary/8'
              : 'border-border hover:border-border/80'
          } ${selectedFiles.length > 0 ? 'p-4' : 'p-6'}`}
        >
          <input
            id="kyc-file-input"
            type="file"
            accept=".jpg,.jpeg,.png,.pdf"
            className="hidden"
            onChange={e => { if (e.target.files?.[0]) { handleFileSelect(e.target.files[0]); e.target.value = '' } }}
          />
          {/* Camera capture input for mobile */}
          <input
            id="kyc-camera-input"
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={e => { if (e.target.files?.[0]) { handleFileSelect(e.target.files[0]); e.target.value = '' } }}
          />
          {selectedFiles.length > 0 ? (
            <div className="flex items-center justify-center gap-2">
              <Upload size={16} className="text-primary" />
              <span className="text-primary text-[13px] font-medium">
                Tap to add another photo (e.g. back of ID)
              </span>
            </div>
          ) : (
            <>
              <Upload size={28} className="text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground text-sm mb-1">
                Drop your ID here or tap to browse files
              </p>
              <p className="text-muted-foreground/70 text-xs">
                JPEG, PNG, or PDF — max 10MB per file. Upload front &amp; back if needed.
              </p>
              <div
                onClick={(e) => { e.stopPropagation(); document.getElementById('kyc-camera-input')?.click() }}
                className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-lg bg-primary/10 border border-primary/30 text-primary text-[13px] font-semibold cursor-pointer hover:bg-primary/15 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                Take Photo
              </div>
            </>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div className="flex items-center gap-2 px-3.5 py-2.5 mb-4 rounded-lg bg-red-950/40 border border-red-800/50">
            <AlertCircle size={16} className="text-red-400 shrink-0" />
            <span className="text-red-400 text-[13px]">{error}</span>
          </div>
        )}

        {/* Submit button */}
        <Button
          onClick={handleSubmit}
          disabled={selectedFiles.length === 0 || !documentType || submitting}
          className="w-full"
        >
          {submitting ? 'Uploading...' : 'Submit for Verification'}
        </Button>

        {/* Divider */}
        <div className="flex items-center gap-3 my-5">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">or</span>
          <Separator className="flex-1" />
        </div>

        {/* Send to phone option */}
        {mobileLinkSent ? (
          <div className="flex items-center gap-2.5 px-4 py-3.5 bg-primary/8 border border-primary/25 rounded-lg">
            <Mail size={18} className="text-primary shrink-0" />
            <div>
              <div className="text-primary font-semibold text-[13px] mb-0.5">
                Link sent!
              </div>
              <div className="text-muted-foreground text-[13px]">
                Check your email{mobileLinkEmail ? ` at ${mobileLinkEmail}` : ''} and open the link on your phone to take a photo of your ID.
              </div>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={async () => {
              setSendingMobileLink(true)
              setError(null)
              const result = await sendKycMobileLink()
              if (result.success) {
                setMobileLinkSent(true)
                setMobileLinkEmail(result.data?.email || null)
              } else {
                setError(result.error || 'Failed to send link')
              }
              setSendingMobileLink(false)
            }}
            disabled={sendingMobileLink}
            className="w-full flex items-center justify-center gap-2"
          >
            <Smartphone size={16} />
            {sendingMobileLink ? 'Sending...' : 'Need to use your phone? Send a link to your email'}
          </Button>
        )}

        {/* Accepted IDs note */}
        <div className="mt-5 px-4 py-3 bg-background rounded-lg text-xs text-muted-foreground leading-relaxed border border-border/30">
          <strong className="text-muted-foreground/80">Accepted IDs:</strong> Ontario Driver&apos;s Licence,
          Canadian Passport, Ontario Photo Card, Permanent Resident Card, or Canadian Citizenship Card.
          Your ID must be valid (not expired) and the name must match your registered name.
        </div>
      </Card>
    </div>
  )
}
