'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, Circle, Landmark, Shield, User, ArrowRight, Loader2, Clock, Sparkles, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import AgentHeader from '@/components/AgentHeader'
import AgentKycGate from '@/components/AgentKycGate'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { submitAgentBanking } from '@/lib/actions/profile-actions'
import {
  getLatestOutstandingFirmDealOfferForCurrentAgent,
  preRequestFirmDealOffer,
  type FirmDealOfferSummary,
} from '@/lib/actions/firm-deal-offer-actions'
import type { UserProfile } from '@/types/database'

interface AgentForSetup {
  id: string
  first_name: string
  last_name: string
  kyc_status: string
  kyc_rejection_reason: string | null
  banking_approval_status: 'none' | 'pending' | 'approved' | 'rejected' | null
  banking_rejection_reason: string | null
  banking_submitted_transit: string | null
  banking_submitted_institution: string | null
  banking_submitted_account: string | null
  preauth_form_path: string | null
  preauth_form_uploaded_at: string | null
  deposit_authorized_at: string | null
  phone: string | null
  address_street: string | null
  address_city: string | null
  address_province: string | null
  address_postal_code: string | null
  brokerages?: { name: string; logo_url: string | null;  logo_includes_tagline?: boolean | null; brand_color: string | null; is_white_label_partner: boolean } | null
}

type SetupState = 'filling' | 'pending' | 'activated'

/**
 * Format a bare YYYY-MM-DD date without timezone drift (parsing as UTC midnight
 * shifts to the previous day in ET). Matches the offer banner on /agent.
 */
function formatCalendarDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso)
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function AgentSetupPage() {
  const router = useRouter()
  const supabase = createClient()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [agent, setAgent] = useState<AgentForSetup | null>(null)
  const [brokerage, setBrokerage] = useState<{ name: string; logo_url: string | null;  logo_includes_tagline?: boolean | null; brand_color: string | null; is_white_label_partner: boolean } | null>(null)
  const [loading, setLoading] = useState(true)

  // Banking form state
  const [bankTransit, setBankTransit] = useState('')
  const [bankInstitution, setBankInstitution] = useState('')
  const [bankAccount, setBankAccount] = useState('')
  const [bankSubmitting, setBankSubmitting] = useState(false)
  const [bankError, setBankError] = useState<string | null>(null)
  const [depositConsent, setDepositConsent] = useState(false)

  // Firm-deal offer — the deal that brought a brand-new agent here via the
  // offer link. Surfaced on the "All set" page so they can pre-request the
  // advance now and have it fire automatically the moment Firm Funds approves
  // their account, instead of having to log back in to find it.
  const [offer, setOffer] = useState<FirmDealOfferSummary | null>(null)
  const [preRequesting, setPreRequesting] = useState(false)
  const [preRequestMsg, setPreRequestMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  // Preauth upload state
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      if (!prof || prof.role !== 'agent' || !prof.agent_id) { router.push('/login'); return }
      setProfile(prof)

      const { data: agentData } = await supabase
        .from('agents')
        .select('*, brokerages(name, logo_url, logo_includes_tagline, brand_color, is_white_label_partner)')
        .eq('id', prof.agent_id)
        .single()

      if (agentData) {
        setAgent(agentData as AgentForSetup)
        setBrokerage(((agentData as AgentForSetup).brokerages) || null)
        const a = agentData as AgentForSetup
        setBankTransit(a.banking_submitted_transit || '')
        setBankInstitution(a.banking_submitted_institution || '')
        setBankAccount(a.banking_submitted_account || '')
        setDepositConsent(!!a.deposit_authorized_at)
      }

      // Pull any outstanding firm-deal offer for this agent so the "All set"
      // page can let them pre-request it. Best-effort — a failure here just
      // means no offer card shows.
      const offerRes = await getLatestOutstandingFirmDealOfferForCurrentAgent()
      if (offerRes.success && offerRes.data) setOffer(offerRes.data)

      setLoading(false)
    }
    load()
    // supabase/router are stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshAgent = async () => {
    if (!profile?.agent_id) return
    const { data: agentData } = await supabase
      .from('agents')
      .select('*, brokerages(name, logo_url, logo_includes_tagline, brand_color, is_white_label_partner)')
      .eq('id', profile.agent_id)
      .single()
    if (agentData) {
      setAgent(agentData as AgentForSetup)
      setBrokerage(((agentData as AgentForSetup).brokerages) || null)
    }
  }

  // Agent opts in to the advance from the "All set" page. We don't notify the
  // brokerage yet (the account isn't approved); the request fires automatically
  // when Firm Funds activates the account.
  const handlePreRequest = async () => {
    if (!offer || preRequesting) return
    setPreRequesting(true)
    setPreRequestMsg(null)
    const res = await preRequestFirmDealOffer(offer.event_id)
    if (res.success && res.data) {
      setOffer({
        ...offer,
        pre_requested: true,
        offer_deal_id: res.data.deal_id ?? offer.offer_deal_id,
      })
      setPreRequestMsg({
        kind: 'success',
        text: res.data.accepted_now
          ? `Done. We've notified ${brokerage?.name || 'your brokerage'} to send us the paperwork.`
          : `Got it. We'll notify ${brokerage?.name || 'your brokerage'} the moment your account is approved.`,
      })
    } else {
      setPreRequestMsg({ kind: 'error', text: res.error || 'Could not submit your request. Please try again.' })
    }
    setPreRequesting(false)
  }

  const handleSubmitBanking = async () => {
    if (!agent) return
    setBankError(null)
    if (!bankTransit.trim() || !bankInstitution.trim() || !bankAccount.trim()) {
      setBankError('All banking fields are required.')
      return
    }
    if (!agent.preauth_form_path) {
      setBankError('Please upload your void cheque or direct deposit authorization form.')
      return
    }
    if (!depositConsent) {
      setBankError('Please check the authorization box to continue.')
      return
    }
    setBankSubmitting(true)
    const result = await submitAgentBanking({
      agentId: agent.id,
      transitNumber: bankTransit.trim(),
      institutionNumber: bankInstitution.trim(),
      accountNumber: bankAccount.trim(),
      authorizeDeposit: true,
    })
    if (result.success) {
      await refreshAgent()
    } else {
      setBankError(result.error || 'Failed to submit banking info')
    }
    setBankSubmitting(false)
  }

  const handlePreauthUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const allowed = ['application/pdf', 'image/jpeg', 'image/png']
    if (!allowed.includes(file.type)) {
      setUploadMessage({ type: 'error', text: 'Only PDF, JPEG, or PNG accepted' })
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadMessage({ type: 'error', text: 'File must be under 10MB' })
      return
    }
    setUploading(true)
    setUploadMessage(null)
    try {
      const urlRes = await fetch('/api/preauth-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name }),
      })
      const urlData = await urlRes.json()
      if (!urlData.success) {
        setUploadMessage({ type: 'error', text: urlData.error || 'Failed to prepare upload' })
        setUploading(false); return
      }
      const uploadRes = await fetch(urlData.data.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!uploadRes.ok) {
        setUploadMessage({ type: 'error', text: 'Upload failed' })
        setUploading(false); return
      }
      const finalRes = await fetch('/api/preauth-upload', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: urlData.data.path }),
      })
      const finalData = await finalRes.json()
      if (finalData.success) {
        setUploadMessage({ type: 'success', text: 'Void cheque / direct deposit form uploaded' })
        await refreshAgent()
      } else {
        setUploadMessage({ type: 'error', text: finalData.error || 'Failed to save' })
      }
    } catch {
      setUploadMessage({ type: 'error', text: 'An unexpected error occurred' })
    }
    setUploading(false)
    e.target.value = ''
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Setup happens in a single sitting: the agent can complete ID verification
  // AND banking at the same time, then waits for one approval pass. Three
  // top-level states drive the page:
  //   'filling'   — at least one of ID / banking still needs the agent's action
  //   'pending'   — both submitted, nothing left to do, awaiting approval
  //   'activated' — fully approved (kyc verified AND banking approved)
  const kycVerified = agent?.kyc_status === 'verified'
  const kycInReview = agent?.kyc_status === 'submitted'
  const kycNeedsAction = !kycVerified && !kycInReview // pending / rejected
  const bankingApproved = agent?.banking_approval_status === 'approved'
  const bankingSubmitted = agent?.banking_approval_status === 'pending'
  const bankingNeedsAction = !bankingApproved && !bankingSubmitted // none / rejected
  const preauthUploaded = !!agent?.preauth_form_path

  const setupState: SetupState =
    kycVerified && bankingApproved
      ? 'activated'
      : !kycNeedsAction && !bankingNeedsAction
        ? 'pending'
        : 'filling'

  return (
    <div className="min-h-screen bg-background">
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={brokerage?.logo_url}
        brokerageLogoIncludesTagline={brokerage?.logo_includes_tagline}
        brokerageName={brokerage?.name}
        brokerageBrandColor={brokerage?.brand_color}
        title="Account Setup"
      />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-6 text-center">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Activate your account</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Complete these two quick steps so {brokerage?.name || 'your brokerage'} can submit commission advances on your behalf.
          </p>
        </div>

        {/* Progress bar — ID and Banking are both live in one sitting */}
        <div className="mb-8">
          <ol className="flex items-center justify-between gap-2" aria-label="Setup progress">
            <li className="flex-1 flex items-center gap-2 text-foreground">
              {kycVerified ? <CheckCircle className="h-5 w-5 text-primary shrink-0" /> : <Circle className="h-5 w-5 shrink-0 text-primary" />}
              <span className="text-xs sm:text-sm font-semibold">1. ID Verification</span>
            </li>
            <div className="h-px flex-1 bg-border" aria-hidden="true" />
            <li className="flex-1 flex items-center gap-2 text-foreground">
              {bankingApproved ? <CheckCircle className="h-5 w-5 text-primary shrink-0" /> : <Circle className="h-5 w-5 shrink-0 text-primary" />}
              <span className="text-xs sm:text-sm font-semibold">2. Banking</span>
            </li>
            <div className="h-px flex-1 bg-border" aria-hidden="true" />
            <li className={`flex-1 flex items-center gap-2 ${setupState !== 'filling' ? 'text-foreground' : 'text-muted-foreground'}`}>
              {setupState === 'activated' ? <CheckCircle className="h-5 w-5 text-primary shrink-0" /> : <Circle className={`h-5 w-5 shrink-0 ${setupState === 'pending' ? 'text-primary' : ''}`} />}
              <span className="text-xs sm:text-sm font-semibold">3. Done</span>
            </li>
          </ol>
        </div>

        {/* Step content — ID and banking are both available in one sitting */}
        {setupState === 'filling' && (
          <div className="space-y-6">
            {/* 1. Identity verification */}
            {kycVerified ? (
              <Card className="border-primary/30 bg-primary/5">
                <CardContent className="p-5 flex items-center gap-3">
                  <CheckCircle className="h-6 w-6 text-primary shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">Identity verified</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Your government-issued ID has been approved.</p>
                  </div>
                </CardContent>
              </Card>
            ) : agent ? (
              <Card className="border-border/50">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <Shield className="h-5 w-5 text-primary" />
                    <CardTitle className="text-lg">Verify your identity</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <AgentKycGate agent={agent} onKycSubmitted={() => refreshAgent()} />
                </CardContent>
              </Card>
            ) : null}

            {/* 2. Banking */}
            {bankingApproved ? (
              <Card className="border-primary/30 bg-primary/5">
                <CardContent className="p-5 flex items-center gap-3">
                  <CheckCircle className="h-6 w-6 text-primary shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">Banking approved</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Your direct deposit details are on file.</p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-border/50">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <Landmark className="h-5 w-5 text-primary" />
                    <CardTitle className="text-lg">Banking details</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  We need your direct deposit info to send funded advances and your pre-authorized debit form for repayments.
                </p>

                {bankingSubmitted && (
                  <div className="rounded-lg border border-status-amber/30 bg-status-amber/10 px-4 py-3">
                    <p className="text-sm font-medium text-status-amber">Submitted, pending review</p>
                    <p className="text-xs text-status-amber/80 mt-0.5">Your brokerage admin or Firm Funds will approve this shortly. You&apos;ll get an email when it&apos;s done.</p>
                  </div>
                )}
                {agent?.banking_approval_status === 'rejected' && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
                    <p className="text-sm font-medium text-destructive">Banking info needs correction</p>
                    {agent?.banking_rejection_reason && (
                      <p className="text-xs text-destructive/80 mt-0.5">{agent.banking_rejection_reason}</p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <Label htmlFor="transit">Transit # (5 digits)</Label>
                    <Input id="transit" inputMode="numeric" maxLength={5} value={bankTransit} onChange={(e) => setBankTransit(e.target.value.replace(/\D/g, ''))} placeholder="12345" />
                  </div>
                  <div>
                    <Label htmlFor="institution">Institution # (3 digits)</Label>
                    <Input id="institution" inputMode="numeric" maxLength={3} value={bankInstitution} onChange={(e) => setBankInstitution(e.target.value.replace(/\D/g, ''))} placeholder="003" />
                  </div>
                  <div>
                    <Label htmlFor="account">Account #</Label>
                    <Input id="account" inputMode="numeric" maxLength={20} value={bankAccount} onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, ''))} placeholder="1234567" />
                  </div>
                </div>

                {/* Void cheque / direct deposit authorization upload (required) */}
                <div className="space-y-2 pt-1">
                  <Label>
                    Void cheque or direct deposit authorization <span className="text-destructive">*</span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Upload a void cheque or your bank&apos;s direct deposit authorization form. A clear photo is fine. PDF, JPEG, or PNG up to 10MB.
                  </p>
                  {preauthUploaded ? (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3">
                      <CheckCircle className="h-5 w-5 text-primary" />
                      <div>
                        <p className="text-sm font-medium text-foreground">Void cheque / direct deposit form on file</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Uploaded {agent.preauth_form_uploaded_at ? new Date(agent.preauth_form_uploaded_at).toLocaleDateString('en-CA') : 'recently'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90 transition-colors ${uploading ? 'opacity-50' : ''}`}>
                      {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                      {uploading ? 'Uploading...' : 'Upload void cheque / form'}
                      <input type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" disabled={uploading} onChange={handlePreauthUpload} />
                    </label>
                  )}
                  {uploadMessage && (
                    <p className={`text-sm ${uploadMessage.type === 'success' ? 'text-primary' : 'text-destructive'}`}>{uploadMessage.text}</p>
                  )}
                </div>

                {/* Mandatory deposit authorization consent */}
                <label className="flex items-start gap-2.5 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={depositConsent}
                    onChange={(e) => setDepositConsent(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary focus:ring-2"
                  />
                  <span className="text-sm text-foreground">
                    I authorize Firm Funds Inc. to deposit payments into this account.
                  </span>
                </label>

                {bankError && <p className="text-sm text-destructive">{bankError}</p>}

                <Button
                  onClick={handleSubmitBanking}
                  disabled={bankSubmitting || bankingSubmitted || !preauthUploaded || !depositConsent}
                  className="w-full sm:w-auto"
                >
                  {bankSubmitting ? 'Submitting...' : bankingSubmitted ? 'Submitted' : agent?.banking_approval_status === 'rejected' ? 'Resubmit Banking' : 'Submit Banking'}
                </Button>
                {!bankingSubmitted && (!preauthUploaded || !depositConsent) && (
                  <p className="text-xs text-muted-foreground">
                    Upload your void cheque / direct deposit form and check the authorization box to continue.
                  </p>
                )}
              </CardContent>
            </Card>
            )}
          </div>
        )}

        {setupState === 'pending' && (
          <Card className="border-primary/40 bg-primary/5">
            <CardContent className="p-8">
              <div className="text-center">
                <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-primary/15 flex items-center justify-center">
                  <Clock className="h-7 w-7 text-primary" />
                </div>
                <h2 className="text-xl font-bold text-foreground mb-2">You&apos;re all set</h2>
                <p className="text-sm text-muted-foreground">
                  We&apos;re reviewing your ID and banking details and will email you once your account is approved.
                </p>
              </div>

              {offer ? (
                <div className="mt-6 rounded-xl border border-primary/30 bg-primary/5 p-5 text-left">
                  <div className="flex items-start gap-3">
                    <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground">
                        {offer.brand_name ? `${offer.brand_name}: ` : ''}Your advance is ready to request
                      </p>
                      <p className="text-xs mt-1 text-muted-foreground">
                        {offer.address
                          ? <span className="font-medium text-foreground">{offer.address}</span>
                          : 'Your firm deal'}
                        {offer.closing_date_iso && (
                          <>
                            <span aria-hidden="true"> · </span>
                            Closing {formatCalendarDate(offer.closing_date_iso)}
                          </>
                        )}
                      </p>

                      {(offer.pre_requested || offer.offer_deal_id) ? (
                        <div className="mt-3 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
                          <CheckCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                          <p className="text-xs text-foreground">
                            Requested. As soon as Firm Funds approves your account, we&apos;ll notify {brokerage?.name || 'your brokerage'} to send us the paperwork. Nothing else to do.
                          </p>
                        </div>
                      ) : (
                        <>
                          <p className="text-xs mt-2 text-muted-foreground">
                            Want to get a jump on it? Request your advance now and we&apos;ll send it to {brokerage?.name || 'your brokerage'}{' '}automatically the moment your account is approved, so you don&apos;t have to log back in.
                          </p>
                          <Button
                            onClick={handlePreRequest}
                            disabled={preRequesting}
                            className="mt-3 bg-primary text-primary-foreground hover:bg-primary/90"
                            size="sm"
                          >
                            {preRequesting ? 'Submitting…' : 'Request my advance now'}
                            <ChevronRight className="ml-1 h-4 w-4" />
                          </Button>
                        </>
                      )}

                      {preRequestMsg && (
                        <p
                          className={`text-xs mt-2 ${preRequestMsg.kind === 'success' ? 'text-primary' : 'text-destructive'}`}
                          role="status"
                        >
                          {preRequestMsg.text}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Nothing else is needed from you right now. You can close this page.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {setupState === 'activated' && (
          <Card className="border-primary/40 bg-primary/5">
            <CardContent className="p-8 text-center">
              <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-primary/15 flex items-center justify-center">
                <CheckCircle className="h-7 w-7 text-primary" />
              </div>
              <h2 className="text-xl font-bold text-foreground mb-2">You&apos;re activated</h2>
              <p className="text-sm text-muted-foreground mb-6">
                {brokerage?.name || 'Your brokerage'} can now submit commission advance requests on your behalf. You&apos;ll get an email any time a deal is submitted, approved, or funded.
              </p>
              <Button onClick={() => router.push('/agent')} className="bg-primary text-primary-foreground hover:bg-primary/90">
                Go to dashboard <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Activation status footnote */}
        {setupState !== 'activated' && (
          <p className="text-xs text-muted-foreground text-center mt-6">
            Status:&nbsp;
            <span className="inline-flex items-center gap-1">
              <User className="h-3 w-3" /> KYC: {agent?.kyc_status || 'pending'}
            </span>
            &nbsp;·&nbsp;
            <span className="inline-flex items-center gap-1">
              <Landmark className="h-3 w-3" /> Banking: {agent?.banking_approval_status || 'none'}
            </span>
          </p>
        )}
      </main>
    </div>
  )
}
