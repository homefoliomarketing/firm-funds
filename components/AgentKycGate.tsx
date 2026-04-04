'use client'

import { useState, useEffect, useRef } from 'react'
import { Shield, Upload, CheckCircle, XCircle, Clock, AlertCircle, FileText, Smartphone, Mail } from 'lucide-react'
import { sendKycMobileLink } from '@/lib/actions/kyc-actions'
import { createClient } from '@/lib/supabase/client'
import { useTheme } from '@/lib/theme'
import { KYC_DOCUMENT_TYPES, MAX_KYC_UPLOAD_SIZE_BYTES, ALLOWED_KYC_MIME_TYPES, getKycBadgeStyle } from '@/lib/constants'

interface AgentKycGateProps {
  agent: {
    id: string
    first_name: string
    last_name: string
    kyc_status: string
    kyc_rejection_reason: string | null
  }
  onKycSubmitted: () => void
}

export default function AgentKycGate({ agent, onKycSubmitted }: AgentKycGateProps) {
  const { colors, isDark } = useTheme()
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [documentType, setDocumentType] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [sendingMobileLink, setSendingMobileLink] = useState(false)
  const [mobileLinkSent, setMobileLinkSent] = useState(false)
  const [mobileLinkEmail, setMobileLinkEmail] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll for KYC status changes after mobile link is sent
  useEffect(() => {
    if (!mobileLinkSent) return

    const supabase = createClient()

    pollRef.current = setInterval(async () => {
      const { data } = await supabase
        .from('agents')
        .select('kyc_status')
        .eq('id', agent.id)
        .single()

      if (data && data.kyc_status !== agent.kyc_status && data.kyc_status === 'submitted') {
        // Mobile upload completed — trigger refresh
        if (pollRef.current) clearInterval(pollRef.current)
        onKycSubmitted()
      }
    }, 5000) // Check every 5 seconds

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [mobileLinkSent, agent.id, agent.kyc_status, onKycSubmitted])

  const inputStyle = { background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }

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

  // ---- Status: Submitted (awaiting review) ----
  if (agent.kyc_status === 'submitted') {
    return (
      <div style={{ maxWidth: 560, margin: '60px auto', padding: '0 20px' }}>
        <div style={{
          background: colors.cardBg, border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12, padding: 40, textAlign: 'center',
        }}>
          <Clock size={48} style={{ color: '#7B9FE0', marginBottom: 16 }} />
          <h2 style={{ color: colors.textPrimary, fontSize: 22, fontWeight: 600, margin: '0 0 12px' }}>
            Identity Verification In Progress
          </h2>
          <p style={{ color: colors.textSecondary, fontSize: 15, lineHeight: 1.6, margin: '0 0 20px' }}>
            Your government-issued photo ID has been submitted and is under review.
            You&apos;ll be able to submit deals once your identity is verified.
          </p>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px',
            borderRadius: 8, ...getKycBadgeStyle('submitted'), fontSize: 14, fontWeight: 500,
          }}>
            <Clock size={14} /> Submitted — Awaiting Review
          </div>
        </div>
      </div>
    )
  }

  // ---- Status: Rejected (needs re-upload) ----
  const isRejected = agent.kyc_status === 'rejected'

  return (
    <div style={{ maxWidth: 560, margin: '40px auto', padding: '0 20px' }}>
      <div style={{
        background: colors.cardBg, border: `1px solid ${colors.cardBorder}`,
        borderRadius: 12, padding: 32,
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Shield size={44} style={{ color: '#5FA873', marginBottom: 12 }} />
          <h2 style={{ color: colors.textPrimary, fontSize: 22, fontWeight: 600, margin: '0 0 8px' }}>
            {isRejected ? 'Identity Verification Required' : 'Welcome to Firm Funds'}
          </h2>
          <p style={{ color: colors.textSecondary, fontSize: 14, lineHeight: 1.6, margin: 0 }}>
            Before you can submit deals, we need to verify your identity per FINTRAC requirements.
            Please upload a clear copy of a valid government-issued photo ID.
          </p>
        </div>

        {/* Rejection notice */}
        {isRejected && agent.kyc_rejection_reason && (
          <div style={{
            background: '#2A1212', border: '1px solid #4A2020', borderRadius: 8,
            padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'flex-start',
          }}>
            <XCircle size={18} style={{ color: '#E07B7B', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ color: '#E07B7B', fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                Previous submission was rejected
              </div>
              <div style={{ color: '#D49999', fontSize: 13, lineHeight: 1.5 }}>
                {agent.kyc_rejection_reason}
              </div>
            </div>
          </div>
        )}

        {/* Document type selection */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', color: colors.textSecondary, fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
            Type of ID
          </label>
          <select
            value={documentType}
            onChange={e => setDocumentType(e.target.value)}
            style={{
              ...inputStyle, width: '100%', padding: '10px 12px', borderRadius: 8,
              fontSize: 14, cursor: 'pointer', appearance: 'auto',
            }}
          >
            <option value="">Select ID type...</option>
            {KYC_DOCUMENT_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {/* Selected files list */}
        {selectedFiles.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {selectedFiles.map((file, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                background: colors.pageBg, borderRadius: 8, marginBottom: 6,
                border: `1px solid ${colors.border}`,
              }}>
                <FileText size={16} style={{ color: '#5FA873', flexShrink: 0 }} />
                <span style={{ color: colors.textPrimary, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file.name}
                </span>
                <span style={{ color: colors.textMuted, fontSize: 11, flexShrink: 0 }}>
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <button
                  onClick={() => removeFile(i)}
                  style={{ color: '#E07B7B', background: 'none', border: 'none', cursor: 'pointer', padding: 2, flexShrink: 0 }}
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
          style={{
            border: `2px dashed ${dragOver ? '#5FA873' : colors.inputBorder}`,
            borderRadius: 8, padding: selectedFiles.length > 0 ? 16 : 24, textAlign: 'center', cursor: 'pointer',
            background: dragOver ? 'rgba(95,168,115,0.08)' : 'transparent',
            transition: 'all 0.15s ease', marginBottom: 16,
          }}
          onClick={() => document.getElementById('kyc-file-input')?.click()}
        >
          <input
            id="kyc-file-input"
            type="file"
            accept=".jpg,.jpeg,.png,.pdf"
            style={{ display: 'none' }}
            onChange={e => { if (e.target.files?.[0]) { handleFileSelect(e.target.files[0]); e.target.value = '' } }}
          />
          {selectedFiles.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Upload size={16} style={{ color: '#5FA873' }} />
              <span style={{ color: '#5FA873', fontSize: 13, fontWeight: 500 }}>
                Add another photo (e.g. back of ID)
              </span>
            </div>
          ) : (
            <>
              <Upload size={28} style={{ color: colors.textMuted, marginBottom: 8 }} />
              <p style={{ color: colors.textSecondary, fontSize: 14, margin: '0 0 4px' }}>
                Drop your ID here or click to browse
              </p>
              <p style={{ color: colors.textMuted, fontSize: 12, margin: 0 }}>
                JPEG, PNG, or PDF — max 10MB per file. Upload front &amp; back if needed.
              </p>
            </>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
            background: '#2A1212', border: '1px solid #4A2020', borderRadius: 8,
            marginBottom: 16,
          }}>
            <AlertCircle size={16} style={{ color: '#E07B7B', flexShrink: 0 }} />
            <span style={{ color: '#E07B7B', fontSize: 13 }}>{error}</span>
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={selectedFiles.length === 0 || !documentType || submitting}
          style={{
            width: '100%', padding: '12px 20px', borderRadius: 8,
            background: (selectedFiles.length === 0 || !documentType || submitting) ? '#333' : '#5FA873',
            color: (selectedFiles.length === 0 || !documentType || submitting) ? '#666' : '#fff',
            border: 'none', fontSize: 15, fontWeight: 600, cursor: (selectedFiles.length === 0 || !documentType || submitting) ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s ease',
          }}
        >
          {submitting ? 'Uploading...' : 'Submit for Verification'}
        </button>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0' }}>
          <div style={{ flex: 1, height: 1, background: colors.border }} />
          <span style={{ color: colors.textMuted, fontSize: 12, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>or</span>
          <div style={{ flex: 1, height: 1, background: colors.border }} />
        </div>

        {/* Send to phone option */}
        {mobileLinkSent ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
            background: 'rgba(95,168,115,0.08)', border: '1px solid rgba(95,168,115,0.25)',
            borderRadius: 8,
          }}>
            <Mail size={18} style={{ color: '#5FA873', flexShrink: 0 }} />
            <div>
              <div style={{ color: '#5FA873', fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
                Link sent!
              </div>
              <div style={{ color: colors.textSecondary, fontSize: 13 }}>
                Check your email{mobileLinkEmail ? ` at ${mobileLinkEmail}` : ''} and open the link on your phone to take a photo of your ID.
              </div>
            </div>
          </div>
        ) : (
          <button
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
            style={{
              width: '100%', padding: '12px 20px', borderRadius: 8,
              background: 'transparent', border: `1px solid ${colors.border}`,
              color: colors.textSecondary, fontSize: 14, fontWeight: 500,
              cursor: sendingMobileLink ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.15s ease',
            }}
          >
            <Smartphone size={16} />
            {sendingMobileLink ? 'Sending...' : 'Need to use your phone? Send a link to your email'}
          </button>
        )}

        {/* Accepted IDs note */}
        <div style={{
          marginTop: 20, padding: '12px 16px', background: colors.pageBg,
          borderRadius: 8, fontSize: 12, color: colors.textMuted, lineHeight: 1.6,
        }}>
          <strong style={{ color: colors.textSecondary }}>Accepted IDs:</strong> Ontario Driver&apos;s Licence,
          Canadian Passport, Ontario Photo Card, Permanent Resident Card, or Canadian Citizenship Card.
          Your ID must be valid (not expired) and the name must match your registered name.
        </div>
      </div>
    </div>
  )
}
