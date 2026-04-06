'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  User, Phone, MapPin, Building2, CreditCard, Upload, CheckCircle, AlertCircle, FileText, Loader2,
} from 'lucide-react'
import { updateAgentProfile, submitAgentBanking } from '@/lib/actions/profile-actions'
import AgentHeader from '@/components/AgentHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

export default function AgentProfilePage() {
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [bankingSaving, setBankingSaving] = useState(false)
  const [bankingMessage, setBankingMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Banking form state
  const [bankTransit, setBankTransit] = useState('')
  const [bankInstitution, setBankInstitution] = useState('')
  const [bankAccount, setBankAccount] = useState('')

  // Form state
  const [phone, setPhone] = useState('')
  const [addressStreet, setAddressStreet] = useState('')
  const [addressCity, setAddressCity] = useState('')
  const [addressProvince, setAddressProvince] = useState('Ontario')
  const [addressPostalCode, setAddressPostalCode] = useState('')

  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()
      setProfile(prof)

      if (prof?.role !== 'agent' || !prof.agent_id) { router.push('/login'); return }

      const { data: agentData } = await supabase
        .from('agents')
        .select('*, brokerages(name)')
        .eq('id', prof.agent_id)
        .single()

      if (agentData) {
        setAgent(agentData)
        setPhone(agentData.phone || '')
        setAddressStreet(agentData.address_street || '')
        setAddressCity(agentData.address_city || '')
        setAddressProvince(agentData.address_province || 'Ontario')
        setAddressPostalCode(agentData.address_postal_code || '')
        // Pre-populate banking form with submitted values (so they can edit and resubmit)
        setBankTransit(agentData.banking_submitted_transit || '')
        setBankInstitution(agentData.banking_submitted_institution || '')
        setBankAccount(agentData.banking_submitted_account || '')
      }

      setLoading(false)
    }
    load()
  }, [])

  const handleSaveProfile = async () => {
    if (!agent) return
    setSaving(true)
    setSaveMessage(null)

    const result = await updateAgentProfile({
      agentId: agent.id,
      phone: phone.trim() || null,
      addressStreet: addressStreet.trim() || null,
      addressCity: addressCity.trim() || null,
      addressProvince: addressProvince.trim() || null,
      addressPostalCode: addressPostalCode.trim().toUpperCase() || null,
    })

    if (result.success) {
      setSaveMessage({ type: 'success', text: 'Profile updated successfully' })
      setAgent((prev: any) => ({
        ...prev,
        phone: phone.trim() || null,
        address_street: addressStreet.trim() || null,
        address_city: addressCity.trim() || null,
        address_province: addressProvince.trim() || null,
        address_postal_code: addressPostalCode.trim().toUpperCase() || null,
      }))
    } else {
      setSaveMessage({ type: 'error', text: result.error || 'Failed to update' })
    }
    setSaving(false)
    setTimeout(() => setSaveMessage(null), 4000)
  }

  const handlePreauthUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const allowed = ['application/pdf', 'image/jpeg', 'image/png']
    if (!allowed.includes(file.type)) {
      setUploadMessage({ type: 'error', text: 'Only PDF, JPEG, or PNG files are accepted' })
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
        setUploading(false)
        return
      }

      const uploadRes = await fetch(urlData.data.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })

      if (!uploadRes.ok) {
        setUploadMessage({ type: 'error', text: 'Upload failed. Please try again.' })
        setUploading(false)
        return
      }

      const finalRes = await fetch('/api/preauth-upload', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: urlData.data.path }),
      })
      const finalData = await finalRes.json()

      if (finalData.success) {
        setUploadMessage({ type: 'success', text: 'Pre-authorized form uploaded successfully' })
        setAgent((prev: any) => ({
          ...prev,
          preauth_form_path: urlData.data.path,
          preauth_form_uploaded_at: new Date().toISOString(),
        }))
      } else {
        setUploadMessage({ type: 'error', text: finalData.error || 'Failed to save upload' })
      }
    } catch (err) {
      setUploadMessage({ type: 'error', text: 'An unexpected error occurred' })
    }

    setUploading(false)
    e.target.value = ''
  }

  const handleSubmitBanking = async () => {
    if (!agent) return
    setBankingSaving(true)
    setBankingMessage(null)

    const result = await submitAgentBanking({
      agentId: agent.id,
      transitNumber: bankTransit.trim(),
      institutionNumber: bankInstitution.trim(),
      accountNumber: bankAccount.trim(),
    })

    if (result.success) {
      setBankingMessage({ type: 'success', text: 'Banking info submitted for review' })
      setAgent((prev: any) => ({
        ...prev,
        banking_submitted_transit: bankTransit.trim(),
        banking_submitted_institution: bankInstitution.trim(),
        banking_submitted_account: bankAccount.trim(),
        banking_approval_status: 'pending',
        banking_rejection_reason: null,
      }))
    } else {
      setBankingMessage({ type: 'error', text: result.error || 'Failed to submit' })
    }
    setBankingSaving(false)
    setTimeout(() => setBankingMessage(null), 5000)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-lg text-muted-foreground">Loading profile...</div>
      </div>
    )
  }

  const bankingComplete = agent?.banking_verified && agent?.bank_transit_number && agent?.bank_institution_number && agent?.bank_account_number

  return (
    <div className="min-h-screen bg-background">
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageName={agent?.brokerages?.name}
      />

      <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="sr-only">Agent Profile</h1>
        <h2 className="text-2xl font-bold mb-1 text-foreground">My Profile</h2>
        <p className="text-sm mb-8 text-muted-foreground">Manage your personal information and banking details.</p>

        {/* Personal Information */}
        <Card className="mb-6">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <User size={18} className="text-primary" />
              Personal Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Read-only fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Full Name</Label>
                <div className="rounded-lg px-3 py-2.5 text-sm bg-muted border border-border text-muted-foreground">
                  {agent?.first_name} {agent?.last_name}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email</Label>
                <div className="rounded-lg px-3 py-2.5 text-sm bg-muted border border-border text-muted-foreground">
                  {agent?.email}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Brokerage</Label>
                <div className="rounded-lg px-3 py-2.5 text-sm bg-muted border border-border text-muted-foreground">
                  {agent?.brokerages?.name || '—'}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">RECO Number</Label>
                <div className="rounded-lg px-3 py-2.5 text-sm bg-muted border border-border text-muted-foreground">
                  {agent?.reco_number || '—'}
                </div>
              </div>
            </div>

            {/* Editable fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <Phone size={12} />Phone
                </Label>
                <Input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(416) 555-1234"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <MapPin size={12} />Street Address
                </Label>
                <Input
                  type="text"
                  value={addressStreet}
                  onChange={(e) => setAddressStreet(e.target.value)}
                  placeholder="123 Main St, Unit 4"
                />
              </div>
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
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Postal Code</Label>
                <Input
                  type="text"
                  value={addressPostalCode}
                  onChange={(e) => setAddressPostalCode(e.target.value)}
                  placeholder="M5V 1A1"
                  maxLength={7}
                />
              </div>
            </div>

            {/* Save button */}
            <div className="flex items-center gap-3 pt-1">
              <Button onClick={handleSaveProfile} disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
              {saveMessage && (
                <span className={`text-sm font-medium flex items-center gap-1 ${saveMessage.type === 'success' ? 'text-primary' : 'text-destructive'}`}>
                  {saveMessage.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                  {saveMessage.text}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Banking Information */}
        <Card className="mb-6">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard size={18} className="text-primary" />
              Banking Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Status banner */}
            {bankingComplete ? (
              <div className="rounded-lg p-4 bg-primary/10 border border-primary/30">
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle size={16} className="text-primary" />
                  <span className="text-sm font-semibold text-primary">Banking verified</span>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Transit</p>
                    <p className="text-sm font-mono font-medium text-foreground">{agent.bank_transit_number}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Institution</p>
                    <p className="text-sm font-mono font-medium text-foreground">{agent.bank_institution_number}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-1 text-muted-foreground">Account</p>
                    <p className="text-sm font-mono font-medium text-foreground">{'•'.repeat(agent.bank_account_number.length - 4)}{agent.bank_account_number.slice(-4)}</p>
                  </div>
                </div>
              </div>
            ) : agent?.banking_approval_status === 'pending' ? (
              <div className="rounded-lg p-4 bg-status-blue-muted border border-status-blue-border">
                <div className="flex items-center gap-2 mb-1">
                  <Loader2 size={16} className="text-status-blue animate-spin" />
                  <span className="text-sm font-semibold text-status-blue">Pending approval</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Your banking info has been submitted and is being reviewed. You'll receive an email once it's approved.
                </p>
              </div>
            ) : agent?.banking_approval_status === 'rejected' ? (
              <div className="rounded-lg p-4 bg-destructive/10 border border-destructive/30">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle size={16} className="text-destructive" />
                  <span className="text-sm font-semibold text-destructive">Banking info not approved</span>
                </div>
                {agent.banking_rejection_reason && (
                  <p className="text-xs mt-1 text-destructive">Reason: {agent.banking_rejection_reason}</p>
                )}
                <p className="text-xs mt-1 text-muted-foreground">Please update your information below and resubmit.</p>
              </div>
            ) : (
              <div className="rounded-lg p-4 bg-yellow-500/10 border border-yellow-500/30">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle size={16} className="text-yellow-500" />
                  <span className="text-sm font-semibold text-yellow-500">Banking info required</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter your banking details below. Banking info must be verified before deals can be approved.
                </p>
              </div>
            )}

            {/* Banking input form — shown when NOT verified, or when rejected (can resubmit) */}
            {!bankingComplete && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transit Number</Label>
                    <Input
                      type="text"
                      value={bankTransit}
                      onChange={(e) => setBankTransit(e.target.value.replace(/\D/g, '').slice(0, 5))}
                      placeholder="12345"
                      maxLength={5}
                      disabled={agent?.banking_approval_status === 'pending'}
                      className="font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground">5 digits</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Institution Number</Label>
                    <Input
                      type="text"
                      value={bankInstitution}
                      onChange={(e) => setBankInstitution(e.target.value.replace(/\D/g, '').slice(0, 3))}
                      placeholder="001"
                      maxLength={3}
                      disabled={agent?.banking_approval_status === 'pending'}
                      className="font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground">3 digits</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Account Number</Label>
                    <Input
                      type="text"
                      value={bankAccount}
                      onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, '').slice(0, 12))}
                      placeholder="1234567"
                      maxLength={12}
                      disabled={agent?.banking_approval_status === 'pending'}
                      className="font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground">7-12 digits</p>
                  </div>
                </div>

                {agent?.banking_approval_status !== 'pending' && (
                  <div className="flex items-center gap-3">
                    <Button
                      onClick={handleSubmitBanking}
                      disabled={bankingSaving || !bankTransit || !bankInstitution || !bankAccount}
                    >
                      {bankingSaving ? 'Submitting...' : agent?.banking_approval_status === 'rejected' ? 'Resubmit Banking Info' : 'Submit Banking Info'}
                    </Button>
                    {bankingMessage && (
                      <span className={`text-sm font-medium flex items-center gap-1 ${bankingMessage.type === 'success' ? 'text-primary' : 'text-destructive'}`}>
                        {bankingMessage.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                        {bankingMessage.text}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Pre-Authorized Debit Form Upload */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText size={18} className="text-primary" />
              Pre-Authorized Debit Form
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {agent?.preauth_form_path ? (
              <div className="rounded-lg p-3 flex items-center gap-3 bg-primary/10 border border-primary/30">
                <CheckCircle size={16} className="text-primary" />
                <div>
                  <p className="text-sm font-medium text-primary">Form uploaded</p>
                  <p className="text-xs text-muted-foreground">
                    Uploaded {agent.preauth_form_uploaded_at ? new Date(agent.preauth_form_uploaded_at).toLocaleDateString('en-CA') : 'recently'}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Please upload your signed pre-authorized debit form. Accepted formats: PDF, JPEG, or PNG (max 10MB).
              </p>
            )}

            <label className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold cursor-pointer transition-colors ${uploading ? 'opacity-60 bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}>
              {uploading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload size={16} />
                  {agent?.preauth_form_path ? 'Upload New Form' : 'Upload Form'}
                </>
              )}
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={handlePreauthUpload}
                disabled={uploading}
                className="hidden"
              />
            </label>

            {uploadMessage && (
              <div className="flex items-center gap-1.5">
                {uploadMessage.type === 'success'
                  ? <CheckCircle size={14} className="text-primary" />
                  : <AlertCircle size={14} className="text-destructive" />}
                <span className={`text-sm ${uploadMessage.type === 'success' ? 'text-primary' : 'text-destructive'}`}>
                  {uploadMessage.text}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
