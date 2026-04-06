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

  // ---- Loading ----
  if (status === 'loading') {
    return (
      <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
        <div className="px-6 py-5 border-b-2 border-primary bg-card text-center">
          <img src="/brand/white.png" alt="Firm Funds" className="h-9 inline-block" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center p-10">
            <div className="w-10 h-10 border-[3px] border-white/15 border-t-primary rounded-full animate-spin mx-auto mb-4" />
            <p className="text-muted-foreground/70 text-[15px]">Verifying your link...</p>
          </div>
        </div>
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
    const iconColor = status === 'used' ? 'var(--primary)' : 'var(--status-red)'

    return (
      <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
        <div className="px-6 py-5 border-b-2 border-primary bg-card text-center">
          <img src="/brand/white.png" alt="Firm Funds" className="h-9 inline-block" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-card rounded-2xl p-7 mx-4 border border-border text-center">
            <Icon size={52} style={{ color: iconColor }} className="mx-auto mb-4" />
            <h2 className="text-white text-[22px] font-bold mb-3">{titles[status]}</h2>
            <p className="text-muted-foreground text-[15px] leading-relaxed">{messages[status]}</p>
          </div>
        </div>
      </div>
    )
  }

  // ---- Success ----
  if (status === 'success') {
    return (
      <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
        <div className="px-6 py-5 border-b-2 border-primary bg-card text-center">
          <img src="/brand/white.png" alt="Firm Funds" className="h-9 inline-block" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-card rounded-2xl p-7 mx-4 border border-border text-center">
            <CheckCircle size={56} className="text-primary mx-auto mb-4" />
            <h2 className="text-white text-2xl font-bold mb-3">ID Uploaded Successfully</h2>
            <p className="text-muted-foreground text-[15px] leading-[1.7] mb-2">
              Your government-issued photo ID has been submitted for review.
            </p>
            <p className="text-muted-foreground/70 text-sm">
              You can close this page and go back to your desktop — your status will update automatically once we&apos;ve reviewed your ID.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ---- Uploading ----
  if (status === 'uploading') {
    return (
      <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
        <div className="px-6 py-5 border-b-2 border-primary bg-card text-center">
          <img src="/brand/white.png" alt="Firm Funds" className="h-9 inline-block" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center p-10">
            <div className="w-11 h-11 border-[3px] border-white/15 border-t-primary rounded-full animate-spin mx-auto mb-4" />
            <p className="text-foreground text-[17px] font-semibold">Uploading your ID...</p>
            <p className="text-muted-foreground/70 text-sm mt-1">Please don&apos;t close this page</p>
          </div>
        </div>
      </div>
    )
  }

  // ---- Valid — Upload Form ----
  const canSubmit = selectedFiles.length > 0 && !!documentType

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col">
      <div className="px-6 py-5 border-b-2 border-primary bg-card text-center">
        <img src="/brand/white.png" alt="Firm Funds" className="h-9 inline-block" />
      </div>

      <div className="flex-1 pb-10">
        <div className="bg-card rounded-2xl p-7 mx-4 mt-5 border border-border">
          {/* Greeting */}
          <div className="text-center mb-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Smartphone size={30} className="text-primary" />
            </div>
            <h2 className="text-white text-[22px] font-bold mb-2">Upload Your Photo ID</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Hi {agentName} — take a clear photo of your government-issued ID below.
            </p>
          </div>

          {/* Document type selection */}
          <div className="mb-[18px]">
            <label className="block text-muted-foreground text-[13px] font-semibold mb-2 uppercase tracking-[0.5px]">
              Type of ID
            </label>
            <select
              value={documentType}
              onChange={e => setDocumentType(e.target.value)}
              className="bg-secondary border border-white/10 text-foreground w-full px-4 py-[14px] rounded-[10px] text-base"
            >
              <option value="">Select ID type...</option>
              {KYC_DOCUMENT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Camera / file upload */}
          <div className="mb-[18px]">
            <label className="block text-muted-foreground text-[13px] font-semibold mb-2 uppercase tracking-[0.5px]">
              Photo of your ID {selectedFiles.length > 0 && `(${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''})`}
            </label>

            {/* Previews for all selected files */}
            {selectedFiles.map((file, i) => (
              <div key={i} className="mb-[10px] relative">
                {previewUrls[i] ? (
                  <div className="rounded-[10px] overflow-hidden border border-white/10">
                    <img src={previewUrls[i]} alt={`ID photo ${i + 1}`} className="w-full block" />
                  </div>
                ) : (
                  <div className="flex items-center gap-[10px] px-4 py-[14px] bg-secondary rounded-[10px] border border-white/10">
                    <FileText size={20} className="text-primary" />
                    <span className="text-sm flex-1">{file.name}</span>
                    <span className="text-xs text-muted-foreground/70">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                  </div>
                )}
                <button
                  onClick={() => removeFile(i)}
                  className="absolute top-2 right-2 bg-black/70 rounded-full w-7 h-7 flex items-center justify-center text-status-red border-0 cursor-pointer"
                  title="Remove"
                >
                  <XCircle size={16} />
                </button>
                <div className="absolute top-2 left-2 bg-black/70 rounded-md px-2 py-[2px] text-[11px] text-muted-foreground font-semibold">
                  {i === 0 ? 'Front' : i === 1 ? 'Back' : `Photo ${i + 1}`}
                </div>
              </div>
            ))}

            {/* Camera and File buttons */}
            <div className="flex gap-[10px]">
              <label className={`flex-1 flex items-center justify-center gap-2 ${selectedFiles.length > 0 ? 'py-3 px-[10px] text-sm' : 'py-4 px-3 text-[15px]'} rounded-xl cursor-pointer bg-secondary border-2 border-dashed border-primary text-primary font-semibold text-center`}>
                <Camera size={selectedFiles.length > 0 ? 16 : 20} />
                {selectedFiles.length > 0 ? 'Add Photo' : 'Take Photo'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={e => { if (e.target.files?.[0]) { handleFileSelect(e.target.files[0]); e.target.value = '' } }}
                />
              </label>
              <label className={`flex-1 flex items-center justify-center gap-2 ${selectedFiles.length > 0 ? 'py-3 px-[10px] text-sm' : 'py-4 px-3 text-[15px]'} rounded-xl cursor-pointer bg-secondary border border-white/10 text-muted-foreground font-semibold text-center`}>
                <Upload size={selectedFiles.length > 0 ? 16 : 20} />
                {selectedFiles.length > 0 ? 'Add File' : 'Choose File'}
                <input
                  type="file"
                  accept=".jpg,.jpeg,.png,.pdf"
                  className="hidden"
                  onChange={e => { if (e.target.files?.[0]) { handleFileSelect(e.target.files[0]); e.target.value = '' } }}
                />
              </label>
            </div>
            {selectedFiles.length === 1 && (
              <p className="text-primary text-xs text-center mt-2 font-medium">
                If your ID has two sides, add the back too
              </p>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-[10px] px-4 py-3 bg-status-red-muted border border-status-red-border rounded-[10px] mb-[18px]">
              <AlertCircle size={18} className="text-status-red flex-shrink-0" />
              <span className="text-status-red text-sm">{error}</span>
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`w-full py-4 px-6 rounded-xl border-none text-[17px] font-bold transition-colors ${canSubmit ? 'bg-primary text-white cursor-pointer' : 'bg-white/15 text-muted-foreground/50 cursor-not-allowed'}`}
          >
            Submit for Verification
          </button>

          {/* Note */}
          <p className="text-muted-foreground/50 text-xs text-center mt-4 leading-relaxed">
            Your ID must be valid (not expired) and the name must match your Firm Funds account.
          </p>
        </div>
      </div>
    </div>
  )
}
