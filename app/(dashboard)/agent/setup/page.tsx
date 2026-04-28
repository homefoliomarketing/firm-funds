'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, Circle, Landmark, Shield, User, ArrowRight, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import AgentHeader from '@/components/AgentHeader'
import AgentKycGate from '@/components/AgentKycGate'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { submitAgentBanking } from '@/lib/actions/profile-actions'

type StepKey = 'kyc' | 'banking' | 'done'

export default function AgentSetupPage() {
  const router = useRouter()
  const supabase = createClient()
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [brokerage, setBrokerage] = useState<{ name: string; logo_url: string | null; brand_color: string | null; is_white_label_partner: boolean } | null>(null)
  const [loading, setLoading] = useState(true)

  // Banking form state
  const [bankTransit, setBankTransit] = useState('')
  const [bankInstitution, setBankInstitution] = useState('')
  const [bankAccount, setBankAccount] = useState('')
  const [bankSubmitting, setBankSubmitting] = useState(false)
  const [bankError, setBankError] = useState<string | null>(null)

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
        .select('*, brokerages(name, logo_url, brand_color, is_white_label_partner)')
        .eq('id', prof.agent_id)
        .single()

      if (agentData) {
        setAgent(agentData)
        setBrokerage(agentData.brokerages || null)
        setBankTransit(agentData.banking_submitted_transit || '')
        setBankInstitution(agentData.banking_submitted_institution || '')
        setBankAccount(agentData.banking_submitted_account || '')
      }
      setLoading(false)
    }
    load()
  }, [])

  const refreshAgent = async () => {
    if (!profile?.agent_id) return
    const { data: agentData } = await supabase
      .from('agents')
      .select('*, brokerages(name, logo_url, brand_color, is_white_label_partner)')
      .eq('id', profile.agent_id)
      .single()
    if (agentData) {
      setAgent(agentData)
      setBrokerage(agentData.brokerages || null)
    }
  }

  const handleSubmitBanking = async () => {
    if (!agent) return
    setBankError(null)
    if (!bankTransit.trim() || !bankInstitution.trim() || !bankAccount.trim()) {
      setBankError('All banking fields are required.')
      return
    }
    setBankSubmitting(true)
    const result = await submitAgentBanking({
      agentId: agent.id,
      transitNumber: bankTransit.trim(),
      institutionNumber: bankInstitution.trim(),
      accountNumber: bankAccount.trim(),
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
        setUploadMessage({ type: 'success', text: 'Pre-authorized debit form uploaded' })
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

  // Determine current step
  const kycDone = agent?.kyc_status === 'verified'
  const bankingDone = agent?.banking_approval_status === 'approved'
  const bankingSubmitted = agent?.banking_approval_status === 'pending'
  const preauthUploaded = !!agent?.preauth_form_path

  const currentStep: StepKey = !kycDone ? 'kyc' : !bankingDone ? 'banking' : 'done'

  return (
    <div className="min-h-screen bg-background">
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={brokerage?.logo_url}
        brokerageName={brokerage?.name}
        brokerageBrandColor={brokerage?.brand_color}
        title="Account Setup"
      />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-6 text-center">
          {brokerage?.logo_url && (
            <div className="flex items-center justify-center gap-3 mb-4">
              <img src={brokerage.logo_url} alt={brokerage.name} className="h-10 w-auto rounded bg-muted/30 p-1" />
              <span className="text-xs text-muted-foreground">Powered by Firm Funds</span>
            </div>
          )}
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Activate your account</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Complete these two quick steps so {brokerage?.name || 'your brokerage'} can submit commission advances on your behalf.
          </p>
        </div>

        {/* Progress bar */}
        <div className="mb-8">
          <ol className="flex items-center justify-between gap-2" aria-label="Setup progress">
            <li className={`flex-1 flex items-center gap-2 ${currentStep === 'kyc' ? 'text-foreground' : 'text-muted-foreground'}`}>
              {kycDone ? <CheckCircle className="h-5 w-5 text-primary shrink-0" /> : <Circle className={`h-5 w-5 shrink-0 ${currentStep === 'kyc' ? 'text-primary' : ''}`} />}
              <span className="text-xs sm:text-sm font-semibold">1. ID Verification</span>
            </li>
            <div className="h-px flex-1 bg-border" aria-hidden="true" />
            <li className={`flex-1 flex items-center gap-2 ${currentStep === 'banking' ? 'text-foreground' : 'text-muted-foreground'}`}>
              {bankingDone ? <CheckCircle className="h-5 w-5 text-primary shrink-0" /> : <Circle className={`h-5 w-5 shrink-0 ${currentStep === 'banking' ? 'text-primary' : ''}`} />}
              <span className="text-xs sm:text-sm font-semibold">2. Banking</span>
            </li>
            <div className="h-px flex-1 bg-border" aria-hidden="true" />
            <li className={`flex-1 flex items-center gap-2 ${currentStep === 'done' ? 'text-foreground' : 'text-muted-foreground'}`}>
              {currentStep === 'done' ? <CheckCircle className="h-5 w-5 text-primary shrink-0" /> : <Circle className="h-5 w-5 shrink-0" />}
              <span className="text-xs sm:text-sm font-semibold">3. Done</span>
            </li>
          </ol>
        </div>

        {/* Step content */}
        {currentStep === 'kyc' && (
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
        )}

        {currentStep === 'banking' && (
          <div className="space-y-6">
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
                    <p className="text-sm font-medium text-status-amber">Submitted — pending review</p>
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

                {bankError && <p className="text-sm text-destructive">{bankError}</p>}

                <Button onClick={handleSubmitBanking} disabled={bankSubmitting || bankingSubmitted} className="w-full sm:w-auto">
                  {bankSubmitting ? 'Submitting...' : bankingSubmitted ? 'Submitted' : agent?.banking_approval_status === 'rejected' ? 'Resubmit Banking' : 'Submit Banking'}
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="text-base">Pre-authorized debit form</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Upload a signed pre-authorized debit form (your bank can provide one, or download a void cheque). PDF, JPEG, or PNG up to 10MB.
                </p>

                {preauthUploaded ? (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3">
                    <CheckCircle className="h-5 w-5 text-primary" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Pre-authorized debit form on file</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Uploaded {agent.preauth_form_uploaded_at ? new Date(agent.preauth_form_uploaded_at).toLocaleDateString('en-CA') : 'recently'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90 transition-colors ${uploading ? 'opacity-50' : ''}`}>
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    {uploading ? 'Uploading...' : 'Upload form'}
                    <input type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" disabled={uploading} onChange={handlePreauthUpload} />
                  </label>
                )}

                {uploadMessage && (
                  <p className={`text-sm ${uploadMessage.type === 'success' ? 'text-primary' : 'text-destructive'}`}>{uploadMessage.text}</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {currentStep === 'done' && (
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
        {currentStep !== 'done' && (
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
