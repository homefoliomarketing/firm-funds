'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Shield, Upload, Camera, CheckCircle, XCircle, AlertCircle, FileText, Clock, Smartphone } from 'lucide-react'
import { KYC_DOCUMENT_TYPES, MAX_KYC_UPLOAD_SIZE_BYTES, ALLOWED_KYC_MIME_TYPES } from '@/lib/constants'

type PageStatus = 'loading' | 'valid' | 'used' | 'expired' | 'invalid' | 'uploading' | 'success'

export default function KycMobileUploadPage() {
  const params = useParams()
  const token = params.token as string

  const [status, setStatus] = useState<PageStatus>('loading')
  const [agentName, setAgentName] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [previewUrls, setPreviewUrls] = useState<string[]>([])
  const [documentType, setDocumentType] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function validate() {
      try {
        const response = await fetch('/api/kyc-validate-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const result = await response.json()
        if (result.success) {
          setStatus('valid')
          setAgentName(result.data?.agentName || 'Agent')
        } else {
          setStatus(result.error === 'used' ? 'used' : result.error === 'expired' ? 'expired' : 'invalid')
        }
      } catch {
        setStatus('invalid')
      }
    }
    validate()
  }, [token])

  const handleFileSelect = (file: File) => {
    setError(null)
    if (file.size > MAX_KYC_UPLOAD_SIZE_BYTES) {
      setError('File exceeds 10MB limit.')
      return
    }
    if (!(ALLOWED_KYC_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError('Please upload a JPEG, PNG, or PDF.')
      return
    }
    setSelectedFiles(prev => [...prev, file])
    if (file.type.startsWith('image/')) {
      setPreviewUrls(prev => [...prev, URL.createObjectURL(file)])
    } else {
      setPreviewUrls(prev => [...prev, ''])
    }
  }

  const removeFile = (index: number) => {
    if (previewUrls[index]) URL.revokeObjectURL(previewUrls[index])
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
    setPreviewUrls(prev => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async () => {
    if (selectedFiles.length === 0 || !documentType) {
      setError('Please select your ID type and upload a photo.')
      return
    }
    setStatus('uploading')
    setError(null)

    try {
      // === Step 1: Get signed upload URLs from our API (tiny JSON, no files) ===
      const urlResponse = await fetch('/api/kyc-mobile-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          fileNames: selectedFiles.map(f => f.name),
          documentType,
        }),
      })
      const urlResult = await urlResponse.json()

      if (!urlResult.success) {
        setStatus('valid')
        setError(urlResult.error || 'Upload failed. Please try again.')
        return
      }

      // === Step 2: Upload files DIRECTLY to Supabase Storage (bypasses Netlify) ===
      const { uploadUrls, agentId, tokenRecordId } = urlResult.data
      const filePaths: string[] = []

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i]
        const { signedUrl, token: uploadToken, path } = uploadUrls[i]

        const uploadResponse = await fetch(signedUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': file.type,
          },
          body: file,
        })

        if (!uploadResponse.ok) {
          setStatus('valid')
          setError(`Failed to upload file ${i + 1}. Please try again.`)
          return
        }
        filePaths.push(path)
      }

      // === Step 3: Update DB records via API (tiny JSON, no files) ===
      const finalizeResponse = await fetch('/api/kyc-mobile-upload', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          filePaths,
          documentType,
          tokenRecordId,
          agentId,
        }),
      })
      const finalizeResult = await finalizeResponse.json()

      if (finalizeResult.success) {
        setStatus('success')
      } else {
        setStatus('valid')
        setError(finalizeResult.error || 'Upload failed. Please try again.')
      }
    } catch {
      setStatus('valid')
      setError('Upload failed. Please check your connection and try again.')
    }
  }

  // ---- Styles ----
  const page: React.CSSProperties = {
    minHeight: '100dvh', background: '#121212', color: '#E8E4DF',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    display: 'flex', flexDirection: 'column',
  }
  const header: React.CSSProperties = {
    padding: '20px 24px', borderBottom: '2px solid #5FA873',
    background: '#1C1C1C', textAlign: 'center',
  }
  const card: React.CSSProperties = {
    background: '#1C1C1C', borderRadius: 16, padding: '28px 24px',
    margin: '20px 16px', border: '1px solid #2A2A2A',
  }
  const btn: React.CSSProperties = {
    width: '100%', padding: '16px 24px', borderRadius: 12,
    border: 'none', fontSize: 17, fontWeight: 700, cursor: 'pointer',
    transition: 'background 0.15s ease',
  }
  const inputStyle: React.CSSProperties = {
    background: '#252525', border: '1px solid #3A3A3A', color: '#E8E4DF',
    width: '100%', padding: '14px 16px', borderRadius: 10, fontSize: 16,
    appearance: 'auto',
  }

  // ---- Loading ----
  if (status === 'loading') {
    return (
      <div style={page}>
        <div style={{ ...header }}>
          <img src="/brand/white.png" alt="Firm Funds" style={{ height: 36 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div style={{
              width: 40, height: 40, border: '3px solid #333', borderTopColor: '#5FA873',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px',
            }} />
            <p style={{ color: '#888', fontSize: 15 }}>Verifying your link...</p>
          </div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  // ---- Invalid / Used / Expired ----
  if (status === 'invalid' || status === 'used' || status === 'expired') {
    const icons = { invalid: XCircle, used: CheckCircle, expired: Clock }
    const titles = {
      invalid: 'Invalid Link',
      used: 'Already Uploaded',
      expired: 'Link Expired',
    }
    const messages = {
      invalid: "This link isn't valid. Please go back to your desktop and request a new one.",
      used: "Your ID has already been uploaded using this link. You can close this page and check your desktop.",
      expired: 'This link has expired. Please go back to your desktop and request a new link.',
    }
    const Icon = icons[status]
    const iconColor = status === 'used' ? '#5FA873' : '#E07B7B'

    return (
      <div style={page}>
        <div style={header}>
          <img src="/brand/white.png" alt="Firm Funds" style={{ height: 36 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={card}>
            <div style={{ textAlign: 'center' }}>
              <Icon size={52} style={{ color: iconColor, marginBottom: 16 }} />
              <h2 style={{ color: '#fff', fontSize: 22, fontWeight: 700, margin: '0 0 12px' }}>
                {titles[status]}
              </h2>
              <p style={{ color: '#AAA', fontSize: 15, lineHeight: 1.6, margin: 0 }}>
                {messages[status]}
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---- Success ----
  if (status === 'success') {
    return (
      <div style={page}>
        <div style={header}>
          <img src="/brand/white.png" alt="Firm Funds" style={{ height: 36 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={card}>
            <div style={{ textAlign: 'center' }}>
              <CheckCircle size={56} style={{ color: '#5FA873', marginBottom: 16 }} />
              <h2 style={{ color: '#fff', fontSize: 24, fontWeight: 700, margin: '0 0 12px' }}>
                ID Uploaded Successfully
              </h2>
              <p style={{ color: '#AAA', fontSize: 15, lineHeight: 1.7, margin: '0 0 8px' }}>
                Your government-issued photo ID has been submitted for review.
              </p>
              <p style={{ color: '#888', fontSize: 14, margin: 0 }}>
                You can close this page and go back to your desktop — your status will update automatically once we&apos;ve reviewed your ID.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---- Uploading ----
  if (status === 'uploading') {
    return (
      <div style={page}>
        <div style={header}>
          <img src="/brand/white.png" alt="Firm Funds" style={{ height: 36 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div style={{
              width: 44, height: 44, border: '3px solid #333', borderTopColor: '#5FA873',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px',
            }} />
            <p style={{ color: '#E8E4DF', fontSize: 17, fontWeight: 600 }}>Uploading your ID...</p>
            <p style={{ color: '#888', fontSize: 14 }}>Please don&apos;t close this page</p>
          </div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  // ---- Valid — Upload Form ----
  return (
    <div style={page}>
      <div style={header}>
        <img src="/brand/white.png" alt="Firm Funds" style={{ height: 36 }} />
      </div>

      <div style={{ flex: 1, padding: '0 0 40px' }}>
        <div style={card}>
          {/* Greeting */}
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%', background: 'rgba(95,168,115,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
            }}>
              <Smartphone size={30} style={{ color: '#5FA873' }} />
            </div>
            <h2 style={{ color: '#fff', fontSize: 22, fontWeight: 700, margin: '0 0 8px' }}>
              Upload Your Photo ID
            </h2>
            <p style={{ color: '#AAA', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
              Hi {agentName} — take a clear photo of your government-issued ID below.
            </p>
          </div>

          {/* Document type selection */}
          <div style={{ marginBottom: 18 }}>
            <label style={{ display: 'block', color: '#AAA', fontSize: 13, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Type of ID
            </label>
            <select
              value={documentType}
              onChange={e => setDocumentType(e.target.value)}
              style={inputStyle}
            >
              <option value="">Select ID type...</option>
              {KYC_DOCUMENT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Camera / file upload */}
          <div style={{ marginBottom: 18 }}>
            <label style={{ display: 'block', color: '#AAA', fontSize: 13, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Photo of your ID {selectedFiles.length > 0 && `(${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''})`}
            </label>

            {/* Previews for all selected files */}
            {selectedFiles.map((file, i) => (
              <div key={i} style={{ marginBottom: 10, position: 'relative' }}>
                {previewUrls[i] ? (
                  <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid #3A3A3A' }}>
                    <img src={previewUrls[i]} alt={`ID photo ${i + 1}`} style={{ width: '100%', display: 'block' }} />
                  </div>
                ) : (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
                    background: '#252525', borderRadius: 10, border: '1px solid #3A3A3A',
                  }}>
                    <FileText size={20} style={{ color: '#5FA873' }} />
                    <span style={{ fontSize: 14, flex: 1 }}>{file.name}</span>
                    <span style={{ fontSize: 12, color: '#888' }}>
                      {(file.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                  </div>
                )}
                <button
                  onClick={() => removeFile(i)}
                  style={{
                    position: 'absolute', top: 8, right: 8,
                    background: 'rgba(0,0,0,0.7)', border: 'none', borderRadius: '50%',
                    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', color: '#E07B7B',
                  }}
                  title="Remove"
                >
                  <XCircle size={16} />
                </button>
                <div style={{
                  position: 'absolute', top: 8, left: 8,
                  background: 'rgba(0,0,0,0.7)', borderRadius: 6,
                  padding: '2px 8px', fontSize: 11, color: '#AAA', fontWeight: 600,
                }}>
                  {i === 0 ? 'Front' : i === 1 ? 'Back' : `Photo ${i + 1}`}
                </div>
              </div>
            ))}

            {/* Camera and File buttons */}
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: selectedFiles.length > 0 ? '12px 10px' : '16px 12px', borderRadius: 12, cursor: 'pointer',
                background: '#252525', border: '2px dashed #5FA873', color: '#5FA873',
                fontSize: selectedFiles.length > 0 ? 14 : 15, fontWeight: 600, textAlign: 'center',
              }}>
                <Camera size={selectedFiles.length > 0 ? 16 : 20} />
                {selectedFiles.length > 0 ? 'Add Photo' : 'Take Photo'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={e => { if (e.target.files?.[0]) { handleFileSelect(e.target.files[0]); e.target.value = '' } }}
                />
              </label>
              <label style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: selectedFiles.length > 0 ? '12px 10px' : '16px 12px', borderRadius: 12, cursor: 'pointer',
                background: '#252525', border: '1px solid #3A3A3A', color: '#AAA',
                fontSize: selectedFiles.length > 0 ? 14 : 15, fontWeight: 600, textAlign: 'center',
              }}>
                <Upload size={selectedFiles.length > 0 ? 16 : 20} />
                {selectedFiles.length > 0 ? 'Add File' : 'Choose File'}
                <input
                  type="file"
                  accept=".jpg,.jpeg,.png,.pdf"
                  style={{ display: 'none' }}
                  onChange={e => { if (e.target.files?.[0]) { handleFileSelect(e.target.files[0]); e.target.value = '' } }}
                />
              </label>
            </div>
            {selectedFiles.length === 1 && (
              <p style={{ color: '#5FA873', fontSize: 12, textAlign: 'center', margin: '8px 0 0', fontWeight: 500 }}>
                If your ID has two sides, add the back too
              </p>
            )}
          </div>

          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
              background: '#2A1212', border: '1px solid #4A2020', borderRadius: 10, marginBottom: 18,
            }}>
              <AlertCircle size={18} style={{ color: '#E07B7B', flexShrink: 0 }} />
              <span style={{ color: '#E07B7B', fontSize: 14 }}>{error}</span>
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={selectedFiles.length === 0 || !documentType}
            style={{
              ...btn,
              background: (selectedFiles.length === 0 || !documentType) ? '#333' : '#5FA873',
              color: (selectedFiles.length === 0 || !documentType) ? '#666' : '#fff',
              cursor: (selectedFiles.length === 0 || !documentType) ? 'not-allowed' : 'pointer',
            }}
          >
            Submit for Verification
          </button>

          {/* Note */}
          <p style={{ color: '#666', fontSize: 12, textAlign: 'center', margin: '16px 0 0', lineHeight: 1.5 }}>
            Your ID must be valid (not expired) and the name must match your Firm Funds account.
          </p>
        </div>
      </div>
    </div>
  )
}
