'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Shield,
  CreditCard,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  User,
  Mail,
  Phone,
  MapPin,
  Pencil,
  FileText,
  ExternalLink,
} from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { KycMediaPreview } from '@/components/admin/KycMediaPreview'
import {
  getAgentVerificationDetail,
  getAgentPreauthFormSignedUrl,
} from '@/lib/actions/admin-actions'
import {
  getAgentKycDocumentUrl,
  verifyAgentKyc,
  rejectAgentKyc,
} from '@/lib/actions/kyc-actions'
import {
  approveAgentBanking,
  rejectAgentBanking,
  updateAgentBanking,
} from '@/lib/actions/profile-actions'

type KycStatus = 'pending' | 'submitted' | 'verified' | 'rejected'
type BankingStatus = 'none' | 'pending' | 'approved' | 'rejected'

interface VerificationDetail {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  reco_number: string | null
  address_street: string | null
  address_city: string | null
  address_province: string | null
  address_postal_code: string | null
  brokerage_id: string | null
  brokerage_name: string | null
  kyc_status: KycStatus
  kyc_document_type: string | null
  has_kyc_document: boolean
  kyc_submitted_at: string | null
  kyc_verified_at: string | null
  kyc_verified_by: string | null
  kyc_rejection_reason: string | null
  banking_approval_status: BankingStatus
  banking_submitted_transit: string | null
  banking_submitted_institution: string | null
  banking_submitted_account: string | null
  banking_submitted_at: string | null
  bank_transit_number: string | null
  bank_institution_number: string | null
  bank_account_number: string | null
  banking_verified: boolean
  banking_verified_at: string | null
  banking_rejection_reason: string | null
  has_preauth_form: boolean
  preauth_form_uploaded_at: string | null
  deposit_authorized_at: string | null
}

interface PreviewMedia {
  url: string
  isPdf: boolean
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDocType(value: string | null): string {
  if (!value) return 'Government ID'
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Fetch a Supabase signed URL and hand back a local object URL plus whether it
 * is a PDF. We fetch-as-blob (rather than pointing an <img>/<iframe> straight at
 * the signed URL) for two reasons: Supabase serves storage objects with headers
 * that block inline rendering, and uploads can land as application/octet-stream
 * when the browser never reported a MIME type. Both made the old naive
 * "<iframe src={signedUrl}>" preview show nothing. We re-tag the blob from the
 * file extension so the browser renders it.
 */
async function loadSignedUrlAsBlob(signedUrl: string): Promise<PreviewMedia> {
  const res = await fetch(signedUrl)
  const buf = await res.arrayBuffer()
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  const ext = signedUrl.split('?')[0].split('.').pop()?.toLowerCase() || ''
  const isPdf = ct === 'application/pdf' || ext === 'pdf'
  const isImage =
    ct.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(ext)
  let type = ct
  if (!ct || ct === 'application/octet-stream') {
    if (isPdf) type = 'application/pdf'
    else if (isImage) type = `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}`
  }
  const blob = new Blob([buf], { type })
  return { url: URL.createObjectURL(blob), isPdf }
}

function StatusPill({ kind, status }: { kind: 'id' | 'banking'; status: KycStatus | BankingStatus }) {
  const verified = status === 'verified' || status === 'approved'
  const rejected = status === 'rejected'
  const pending = status === 'submitted' || status === 'pending'
  const label =
    kind === 'id'
      ? status === 'verified'
        ? 'ID verified'
        : status === 'submitted'
          ? 'ID needs review'
          : status === 'rejected'
            ? 'ID rejected'
            : 'No ID yet'
      : status === 'approved'
        ? 'Banking verified'
        : status === 'pending'
          ? 'Banking needs review'
          : status === 'rejected'
            ? 'Banking rejected'
            : 'No banking yet'
  const cls = verified
    ? 'bg-primary/15 text-primary border-primary/30'
    : rejected
      ? 'bg-red-500/15 text-red-400 border-red-500/30'
      : pending
        ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
        : 'bg-muted text-muted-foreground border-border'
  const Icon = verified ? CheckCircle2 : rejected ? XCircle : pending ? AlertCircle : null
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded font-semibold border ${cls}`}>
      {Icon ? <Icon size={11} /> : null}
      {label}
    </span>
  )
}

/**
 * Inner body — mounted fresh for each agent (the parent keys it by agentId), so
 * there is no manual state-reset effect and every setState happens after an
 * await rather than synchronously inside an effect body.
 */
function VerificationBody({ agentId, onChanged }: { agentId: string; onChanged?: () => void }) {
  const [detail, setDetail] = useState<VerificationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // ID preview state
  const idBlobsRef = useRef<PreviewMedia[]>([])
  const [idBlobs, setIdBlobs] = useState<PreviewMedia[]>([])
  const [idLoading, setIdLoading] = useState(false)
  const [kycChecks, setKycChecks] = useState({ nameMatch: false, addressMatch: false, idValid: false })
  const [kycRejecting, setKycRejecting] = useState(false)
  const [kycRejectReason, setKycRejectReason] = useState('')

  // Banking preview / reveal / manual-entry state
  const preauthBlobRef = useRef<string | null>(null)
  const [preauth, setPreauth] = useState<PreviewMedia | null>(null)
  const [preauthLoading, setPreauthLoading] = useState(false)
  const [revealBanking, setRevealBanking] = useState(false)
  const [bankRejecting, setBankRejecting] = useState(false)
  const [bankRejectReason, setBankRejectReason] = useState('')
  const [editingBank, setEditingBank] = useState(false)
  const [bankForm, setBankForm] = useState({ transit: '', institution: '', account: '' })

  const revokeBlobs = useCallback(() => {
    for (const b of idBlobsRef.current) URL.revokeObjectURL(b.url)
    idBlobsRef.current = []
    if (preauthBlobRef.current) {
      URL.revokeObjectURL(preauthBlobRef.current)
      preauthBlobRef.current = null
    }
  }, [])

  const loadIdDocs = useCallback(async (id: string) => {
    setIdLoading(true)
    const res = await getAgentKycDocumentUrl({ agentId: id })
    const urls = res.success && Array.isArray(res.data?.urls) ? (res.data.urls as string[]) : null
    if (urls) {
      try {
        const media = await Promise.all(urls.map(loadSignedUrlAsBlob))
        for (const b of idBlobsRef.current) URL.revokeObjectURL(b.url)
        idBlobsRef.current = media
        setIdBlobs(media)
      } catch {
        setMessage({ type: 'error', text: 'Could not load the ID preview.' })
      }
    } else {
      setMessage({ type: 'error', text: res.error || 'Could not load the ID document.' })
    }
    setIdLoading(false)
  }, [])

  const loadPreauth = useCallback(async (id: string) => {
    setPreauthLoading(true)
    const res = await getAgentPreauthFormSignedUrl({ agentId: id })
    if (res.success && typeof res.data?.signedUrl === 'string') {
      try {
        const media = await loadSignedUrlAsBlob(res.data.signedUrl)
        if (preauthBlobRef.current) URL.revokeObjectURL(preauthBlobRef.current)
        preauthBlobRef.current = media.url
        setPreauth(media)
      } catch {
        setMessage({ type: 'error', text: 'Could not load the void cheque / direct deposit form.' })
      }
    } else {
      setMessage({ type: 'error', text: res.error || 'Could not load the banking form.' })
    }
    setPreauthLoading(false)
  }, [])

  const refreshDetail = useCallback(async (id: string) => {
    const res = await getAgentVerificationDetail({ agentId: id })
    if (res.success && res.data) setDetail(res.data as VerificationDetail)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      const res = await getAgentVerificationDetail({ agentId })
      if (cancelled) return
      if (res.success && res.data) {
        const d = res.data as VerificationDetail
        setDetail(d)
        setLoading(false)
        if (d.has_kyc_document) void loadIdDocs(agentId)
        if (d.has_preauth_form) void loadPreauth(agentId)
      } else {
        setLoadError(res.error || 'Could not load this agent.')
        setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
      revokeBlobs()
    }
  }, [agentId, loadIdDocs, loadPreauth, revokeBlobs])

  const runAction = useCallback(
    async (
      fn: () => Promise<{ success: boolean; error?: string }>,
      okText: string,
      after?: () => void,
    ) => {
      setBusy(true)
      setMessage(null)
      const res = await fn()
      if (res.success) {
        setMessage({ type: 'success', text: okText })
        after?.()
        await refreshDetail(agentId)
        onChanged?.()
      } else {
        setMessage({ type: 'error', text: res.error || 'Something went wrong.' })
      }
      setBusy(false)
    },
    [agentId, refreshDetail, onChanged],
  )

  const fullName = detail ? `${detail.first_name ?? ''} ${detail.last_name ?? ''}`.trim() : ''
  const mailingAddress = detail
    ? [detail.address_street, detail.address_city, detail.address_province, detail.address_postal_code]
        .filter(Boolean)
        .join(', ')
    : ''
  const allKycChecked = kycChecks.nameMatch && kycChecks.addressMatch && kycChecks.idValid
  const bankFormValid =
    bankForm.transit.length === 5 && bankForm.institution.length === 3 && bankForm.account.length >= 7

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <User size={18} className="text-primary" />
          {loading && !detail ? 'Loading agent…' : `Verify ${fullName || 'agent'}`}
        </DialogTitle>
        <DialogDescription>
          Review and verify this agent&rsquo;s government ID and banking details in one place.
        </DialogDescription>
      </DialogHeader>

      {loadError ? (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          {loadError}
        </div>
      ) : loading && !detail ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : detail ? (
        <div className="space-y-5">
          {/* Account details — the context to cross-check ID + banking against */}
          <section aria-label="Account details" className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <p className="text-sm font-semibold text-foreground">
                {fullName || 'Unnamed agent'}
                {detail.brokerage_name ? (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{detail.brokerage_name}</span>
                ) : null}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <StatusPill kind="id" status={detail.kyc_status} />
                <StatusPill
                  kind="banking"
                  status={
                    detail.banking_approval_status === 'none' && detail.banking_verified
                      ? 'approved'
                      : detail.banking_approval_status
                  }
                />
              </div>
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Mail size={12} className="shrink-0" />
                <span className="text-foreground break-all">{detail.email || '—'}</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Phone size={12} className="shrink-0" />
                <span className="text-foreground">{detail.phone || '—'}</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Shield size={12} className="shrink-0" />
                <span className="text-foreground">RECO #: {detail.reco_number || '—'}</span>
              </div>
              <div className="flex items-start gap-1.5 text-muted-foreground sm:col-span-2">
                <MapPin size={12} className="shrink-0 mt-0.5" />
                <span className="text-foreground">{mailingAddress || 'No mailing address on file'}</span>
              </div>
            </dl>
          </section>

          {/* ----- Government ID ----- */}
          <section aria-label="Government ID" className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-foreground flex items-center gap-1.5">
                <Shield size={13} className="text-purple-400" />
                Government ID
              </h3>
              <span className="text-[11px] text-muted-foreground">{formatDocType(detail.kyc_document_type)}</span>
            </div>

            {detail.has_kyc_document ? (
              idLoading && idBlobs.length === 0 ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 size={18} className="animate-spin" />
                </div>
              ) : idBlobs.length > 0 ? (
                <div className="space-y-2">
                  {idBlobs.map((m, i) => (
                    <div key={m.url}>
                      <div className="flex items-center justify-between mb-1">
                        {idBlobs.length > 1 ? (
                          <p className="text-[11px] font-semibold text-muted-foreground">
                            {i === 0 ? 'Front' : i === 1 ? 'Back' : `Photo ${i + 1}`}
                          </p>
                        ) : <span />}
                        <a
                          href={m.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                        >
                          <ExternalLink size={11} /> Open in new tab
                        </a>
                      </div>
                      <KycMediaPreview src={m.url} alt={`${fullName} ID ${i + 1}`} isPdf={m.isPdf} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground py-2">Preview unavailable.</p>
              )
            ) : (
              <p className="text-xs text-muted-foreground py-2">Agent has not uploaded a government ID yet.</p>
            )}

            {/* ID verdict / actions */}
            <div className="mt-3 border-t border-border/60 pt-3">
              {detail.kyc_status === 'verified' ? (
                <p className="text-xs text-primary flex items-center gap-1.5">
                  <CheckCircle2 size={13} /> Verified{detail.kyc_verified_by ? ` by ${detail.kyc_verified_by}` : ''}
                  {detail.kyc_verified_at ? ` on ${formatDate(detail.kyc_verified_at)}` : ''}
                </p>
              ) : detail.kyc_status === 'rejected' ? (
                <p className="text-xs text-red-400 flex items-start gap-1.5">
                  <XCircle size={13} className="mt-0.5 shrink-0" />
                  <span>Rejected{detail.kyc_rejection_reason ? `: ${detail.kyc_rejection_reason}` : ''}</span>
                </p>
              ) : detail.kyc_status === 'submitted' ? (
                kycRejecting ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="text"
                      value={kycRejectReason}
                      onChange={(e) => setKycRejectReason(e.target.value)}
                      placeholder="Reason for rejection…"
                      aria-label="ID rejection reason"
                      autoFocus
                      className="flex-1 min-w-[200px] rounded-md px-2.5 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      disabled={busy || !kycRejectReason.trim()}
                      onClick={() =>
                        runAction(
                          () => rejectAgentKyc({ agentId, reason: kycRejectReason }),
                          'ID rejected',
                          () => {
                            setKycRejecting(false)
                            setKycRejectReason('')
                          },
                        )
                      }
                      className="px-3 py-1.5 rounded-md text-xs font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-40"
                    >
                      Confirm reject
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setKycRejecting(false)
                        setKycRejectReason('')
                      }}
                      className="px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <p className="text-[11px] text-muted-foreground">Confirm the ID against the account details above:</p>
                    <div className="flex flex-col gap-1.5">
                      {(
                        [
                          ['nameMatch', 'Name on ID matches the account name'],
                          ['addressMatch', 'Address on ID matches the mailing address'],
                          ['idValid', 'ID is government-issued and not expired'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                          <input
                            type="checkbox"
                            checked={kycChecks[key]}
                            onChange={(e) => setKycChecks((p) => ({ ...p, [key]: e.target.checked }))}
                            className="h-3.5 w-3.5 rounded border-border accent-primary"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy || !allKycChecked}
                        onClick={() => runAction(() => verifyAgentKyc({ agentId }), 'ID verified')}
                        title={allKycChecked ? undefined : 'Confirm all three checks first'}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                        Verify ID
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setKycRejecting(true)}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold text-red-400 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-40"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )
              ) : (
                <p className="text-xs text-muted-foreground">Nothing to review yet.</p>
              )}
            </div>
          </section>

          {/* ----- Banking ----- */}
          <section aria-label="Banking" className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-foreground flex items-center gap-1.5">
                <CreditCard size={13} className="text-blue-400" />
                Banking
              </h3>
              <span className="text-[11px] flex items-center gap-1.5">
                {detail.deposit_authorized_at ? (
                  <span className="inline-flex items-center gap-1 text-primary">
                    <CheckCircle2 size={11} /> Direct deposit authorized
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <AlertCircle size={11} /> Not yet authorized
                  </span>
                )}
              </span>
            </div>

            {/* Submitted / verified numbers */}
            {detail.banking_verified && detail.bank_transit_number ? (
              <p className="text-xs font-mono text-muted-foreground mb-2">
                Transit: {detail.bank_transit_number} · Inst: {detail.bank_institution_number} · Acct:{' '}
                {'•'.repeat(Math.max(0, (detail.bank_account_number?.length || 4) - 4))}
                {detail.bank_account_number?.slice(-4)}
              </p>
            ) : detail.banking_submitted_transit ? (
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs font-mono text-muted-foreground">
                  {revealBanking
                    ? `Transit: ${detail.banking_submitted_transit} · Inst: ${detail.banking_submitted_institution} · Acct: ${detail.banking_submitted_account}`
                    : 'Transit: ••••• · Inst: ••• · Acct: •••••••'}
                </p>
                <button
                  type="button"
                  aria-label={revealBanking ? 'Hide banking numbers' : 'Show banking numbers'}
                  onClick={() => setRevealBanking((v) => !v)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {revealBanking ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground mb-2">No banking submitted yet.</p>
            )}

            {detail.banking_submitted_at && detail.banking_approval_status === 'pending' ? (
              <p className="text-[10px] text-muted-foreground/60 mb-2">
                Submitted {formatDate(detail.banking_submitted_at)}
              </p>
            ) : null}

            {/* Void cheque / direct deposit form preview */}
            {detail.has_preauth_form ? (
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1.5">
                    <FileText size={12} /> Void cheque / direct deposit form
                  </p>
                  {preauth ? (
                    <a
                      href={preauth.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    >
                      <ExternalLink size={11} /> Open in new tab
                    </a>
                  ) : null}
                </div>
                {preauthLoading && !preauth ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 size={18} className="animate-spin" />
                  </div>
                ) : preauth ? (
                  <KycMediaPreview src={preauth.url} alt="Void cheque / direct deposit form" isPdf={preauth.isPdf} />
                ) : (
                  <p className="text-xs text-muted-foreground">Preview unavailable.</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground mb-3">No void cheque / direct deposit form uploaded.</p>
            )}

            {/* Banking verdict / actions */}
            <div className="border-t border-border/60 pt-3">
              {detail.banking_rejection_reason && detail.banking_approval_status === 'rejected' ? (
                <p className="text-xs text-red-400 flex items-start gap-1.5 mb-2">
                  <XCircle size={13} className="mt-0.5 shrink-0" />
                  <span>Rejected: {detail.banking_rejection_reason}</span>
                </p>
              ) : null}

              {detail.banking_verified ? (
                <p className="text-xs text-primary flex items-center gap-1.5 mb-2">
                  <CheckCircle2 size={13} /> Verified
                  {detail.banking_verified_at ? ` on ${formatDate(detail.banking_verified_at)}` : ''}
                </p>
              ) : null}

              {/* Approve / reject a pending self-submission */}
              {detail.banking_approval_status === 'pending' && detail.banking_submitted_transit ? (
                bankRejecting ? (
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <input
                      type="text"
                      value={bankRejectReason}
                      onChange={(e) => setBankRejectReason(e.target.value)}
                      placeholder="Reason for rejection…"
                      aria-label="Banking rejection reason"
                      autoFocus
                      className="flex-1 min-w-[200px] rounded-md px-2.5 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      disabled={busy || !bankRejectReason.trim()}
                      onClick={() =>
                        runAction(
                          () => rejectAgentBanking({ agentId, reason: bankRejectReason }),
                          'Banking rejected',
                          () => {
                            setBankRejecting(false)
                            setBankRejectReason('')
                          },
                        )
                      }
                      className="px-3 py-1.5 rounded-md text-xs font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-40"
                    >
                      Confirm reject
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBankRejecting(false)
                        setBankRejectReason('')
                      }}
                      className="px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => runAction(() => approveAgentBanking({ agentId }), 'Banking approved')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40"
                    >
                      {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                      Approve banking
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setBankRejecting(true)}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold text-red-400 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </div>
                )
              ) : null}

              {/* Manual entry / edit — for agents who handed banking in directly */}
              {editingBank ? (
                <div className="flex items-end gap-2 flex-wrap">
                  <div>
                    <label className="block text-[11px] font-semibold mb-1 text-muted-foreground">Transit (5)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      value={bankForm.transit}
                      onChange={(e) => setBankForm((f) => ({ ...f, transit: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                      placeholder="12345"
                      className="w-24 rounded-md px-2.5 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold mb-1 text-muted-foreground">Inst (3)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={3}
                      value={bankForm.institution}
                      onChange={(e) => setBankForm((f) => ({ ...f, institution: e.target.value.replace(/\D/g, '').slice(0, 3) }))}
                      placeholder="001"
                      className="w-16 rounded-md px-2.5 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold mb-1 text-muted-foreground">Account (7-12)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={12}
                      value={bankForm.account}
                      onChange={(e) => setBankForm((f) => ({ ...f, account: e.target.value.replace(/\D/g, '').slice(0, 12) }))}
                      placeholder="1234567"
                      className="w-36 rounded-md px-2.5 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={busy || !bankFormValid}
                    onClick={() =>
                      runAction(
                        () =>
                          updateAgentBanking({
                            agentId,
                            transitNumber: bankForm.transit,
                            institutionNumber: bankForm.institution,
                            accountNumber: bankForm.account,
                          }),
                        'Banking saved',
                        () => setEditingBank(false),
                      )
                    }
                    className="px-3 py-1.5 rounded-md text-xs font-semibold text-white bg-primary hover:bg-primary/90 disabled:opacity-40"
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingBank(false)}
                    className="px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditingBank(true)
                    setBankForm({
                      transit: detail.bank_transit_number || '',
                      institution: detail.bank_institution_number || '',
                      account: detail.bank_account_number || '',
                    })
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary"
                >
                  <Pencil size={12} />
                  {detail.banking_verified ? 'Edit banking manually' : 'Enter banking manually'}
                </button>
              )}
            </div>
          </section>

          {message ? (
            <p
              role="status"
              className={`text-xs font-medium ${message.type === 'success' ? 'text-primary' : 'text-red-400'}`}
            >
              {message.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

export function AgentVerificationDialog({
  agentId,
  onClose,
  onChanged,
}: {
  agentId: string | null
  onClose: () => void
  onChanged?: () => void
}) {
  return (
    <Dialog open={!!agentId} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {agentId ? <VerificationBody key={agentId} agentId={agentId} onChanged={onChanged} /> : null}
      </DialogContent>
    </Dialog>
  )
}
