'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  User, Phone, MapPin, Building2, CreditCard, Upload, CheckCircle, AlertCircle, FileText, Loader2,
} from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { updateAgentProfile, submitAgentBanking } from '@/lib/actions/profile-actions'
import AgentHeader from '@/components/AgentHeader'

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
  const { colors } = useTheme()

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
      // Update local state
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

    // Validate file type
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
      // Step 1: Get signed upload URL
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

      // Step 2: Upload directly to Supabase storage via signed URL
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

      // Step 3: Finalize — update agent record
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
    // Clear the input so they can re-upload
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
      <div className="min-h-screen flex items-center justify-center" style={{ background: colors.pageBg }}>
        <div style={{ color: colors.textMuted }} className="text-lg">Loading profile...</div>
      </div>
    )
  }

  const bankingComplete = agent?.banking_verified && agent?.bank_transit_number && agent?.bank_institution_number && agent?.bank_account_number

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={agent?.id || ''}
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageName={agent?.brokerages?.name}
      />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h2 className="text-2xl font-bold mb-1" style={{ color: colors.textPrimary }}>
          My Profile
        </h2>
        <p className="text-sm mb-8" style={{ color: colors.textMuted }}>
          Manage your personal information and banking details.
        </p>

        {/* Personal Information */}
        <section className="rounded-xl p-6 mb-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          <div className="flex items-center gap-2 mb-5">
            <User size={18} style={{ color: colors.gold }} />
            <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Personal Information</h3>
          </div>

          {/* Read-only fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Full Name</label>
              <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.textSecondary }}>
                {agent?.first_name} {agent?.last_name}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Email</label>
              <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.textSecondary }}>
                {agent?.email}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Brokerage</label>
              <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.textSecondary }}>
                {agent?.brokerages?.name || '—'}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>RECO Number</label>
              <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.textSecondary }}>
                {agent?.reco_number || '—'}
              </div>
            </div>
          </div>

          {/* Editable fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                <Phone size={12} className="inline mr-1" />Phone
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(416) 555-1234"
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
                style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                <MapPin size={12} className="inline mr-1" />Street Address
              </label>
              <input
                type="text"
                value={addressStreet}
                onChange={(e) => setAddressStreet(e.target.value)}
                placeholder="123 Main St, Unit 4"
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
                style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>City</label>
              <input
                type="text"
                value={addressCity}
                onChange={(e) => setAddressCity(e.target.value)}
                placeholder="Toronto"
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
                style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Province</label>
              <input
                type="text"
                value={addressProvince}
                onChange={(e) => setAddressProvince(e.target.value)}
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
                style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>Postal Code</label>
              <input
                type="text"
                value={addressPostalCode}
                onChange={(e) => setAddressPostalCode(e.target.value)}
                placeholder="M5V 1A1"
                maxLength={7}
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
                style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
              />
            </div>
          </div>

          {/* Save button */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveProfile}
              disabled={saving}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-50"
              style={{ background: colors.gold }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85' }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            {saveMessage && (
              <span className="text-sm font-medium flex items-center gap-1" style={{ color: saveMessage.type === 'success' ? colors.successText : colors.errorText }}>
                {saveMessage.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                {saveMessage.text}
              </span>
            )}
          </div>
        </section>

        {/* Banking Information */}
        <section className="rounded-xl p-6 mb-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          <div className="flex items-center gap-2 mb-5">
            <CreditCard size={18} style={{ color: colors.gold }} />
            <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Banking Information</h3>
          </div>

          {/* Status banner */}
          {bankingComplete ? (
            <div className="rounded-lg p-4 mb-5" style={{ background: `${colors.successText}10`, border: `1px solid ${colors.successText}30` }}>
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle size={16} style={{ color: colors.successText }} />
                <span className="text-sm font-semibold" style={{ color: colors.successText }}>Banking verified</span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Transit</p>
                  <p className="text-sm font-mono font-medium" style={{ color: colors.textPrimary }}>{agent.bank_transit_number}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Institution</p>
                  <p className="text-sm font-mono font-medium" style={{ color: colors.textPrimary }}>{agent.bank_institution_number}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: colors.textMuted }}>Account</p>
                  <p className="text-sm font-mono font-medium" style={{ color: colors.textPrimary }}>{'•'.repeat(agent.bank_account_number.length - 4)}{agent.bank_account_number.slice(-4)}</p>
                </div>
              </div>
            </div>
          ) : agent?.banking_approval_status === 'pending' ? (
            <div className="rounded-lg p-4 mb-5" style={{ background: '#1A2240', border: '1px solid #2D3A5C' }}>
              <div className="flex items-center gap-2 mb-1">
                <Loader2 size={16} style={{ color: '#7B9FE0' }} className="animate-spin" />
                <span className="text-sm font-semibold" style={{ color: '#7B9FE0' }}>Pending approval</span>
              </div>
              <p className="text-xs" style={{ color: colors.textMuted }}>
                Your banking info has been submitted and is being reviewed. You'll receive an email once it's approved.
              </p>
            </div>
          ) : agent?.banking_approval_status === 'rejected' ? (
            <div className="rounded-lg p-4 mb-5" style={{ background: '#2A1212', border: '1px solid #4A2020' }}>
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={16} style={{ color: '#E07B7B' }} />
                <span className="text-sm font-semibold" style={{ color: '#E07B7B' }}>Banking info not approved</span>
              </div>
              {agent.banking_rejection_reason && (
                <p className="text-xs mt-1" style={{ color: '#E07B7B' }}>
                  Reason: {agent.banking_rejection_reason}
                </p>
              )}
              <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                Please update your information below and resubmit.
              </p>
            </div>
          ) : (
            <div className="rounded-lg p-4 mb-5" style={{ background: `${colors.warningText}10`, border: `1px solid ${colors.warningText}30` }}>
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={16} style={{ color: colors.warningText }} />
                <span className="text-sm font-semibold" style={{ color: colors.warningText }}>Banking info required</span>
              </div>
              <p className="text-xs" style={{ color: colors.textMuted }}>
                Enter your banking details below. Banking info must be verified before deals can be approved.
              </p>
            </div>
          )}

          {/* Banking input form — shown when NOT verified, or when rejected (can resubmit) */}
          {!bankingComplete && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                    Transit Number
                  </label>
                  <input
                    type="text"
                    value={bankTransit}
                    onChange={(e) => setBankTransit(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    placeholder="12345"
                    maxLength={5}
                    disabled={agent?.banking_approval_status === 'pending'}
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none transition-colors disabled:opacity-50"
                    style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
                  />
                  <p className="text-[10px] mt-1" style={{ color: colors.textFaint }}>5 digits</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                    Institution Number
                  </label>
                  <input
                    type="text"
                    value={bankInstitution}
                    onChange={(e) => setBankInstitution(e.target.value.replace(/\D/g, '').slice(0, 3))}
                    placeholder="001"
                    maxLength={3}
                    disabled={agent?.banking_approval_status === 'pending'}
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none transition-colors disabled:opacity-50"
                    style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
                  />
                  <p className="text-[10px] mt-1" style={{ color: colors.textFaint }}>3 digits</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: colors.textMuted }}>
                    Account Number
                  </label>
                  <input
                    type="text"
                    value={bankAccount}
                    onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, '').slice(0, 12))}
                    placeholder="1234567"
                    maxLength={12}
                    disabled={agent?.banking_approval_status === 'pending'}
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none transition-colors disabled:opacity-50"
                    style={{ background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, color: colors.inputText }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = colors.gold }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = colors.inputBorder }}
                  />
                  <p className="text-[10px] mt-1" style={{ color: colors.textFaint }}>7-12 digits</p>
                </div>
              </div>

              {agent?.banking_approval_status !== 'pending' && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSubmitBanking}
                    disabled={bankingSaving || !bankTransit || !bankInstitution || !bankAccount}
                    className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-50"
                    style={{ background: colors.gold }}
                    onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.opacity = '0.85' }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
                  >
                    {bankingSaving ? 'Submitting...' : agent?.banking_approval_status === 'rejected' ? 'Resubmit Banking Info' : 'Submit Banking Info'}
                  </button>
                  {bankingMessage && (
                    <span className="text-sm font-medium flex items-center gap-1" style={{ color: bankingMessage.type === 'success' ? colors.successText : colors.errorText }}>
                      {bankingMessage.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                      {bankingMessage.text}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* Pre-Authorized Debit Form Upload */}
        <section className="rounded-xl p-6" style={{ background: colors.cardBg, border: `1px solid ${colors.border}` }}>
          <div className="flex items-center gap-2 mb-5">
            <FileText size={18} style={{ color: colors.gold }} />
            <h3 className="text-base font-bold" style={{ color: colors.textPrimary }}>Pre-Authorized Debit Form</h3>
          </div>

          {agent?.preauth_form_path ? (
            <div className="mb-4 rounded-lg p-3 flex items-center gap-3" style={{ background: `${colors.successText}10`, border: `1px solid ${colors.successText}30` }}>
              <CheckCircle size={16} style={{ color: colors.successText }} />
              <div>
                <p className="text-sm font-medium" style={{ color: colors.successText }}>Form uploaded</p>
                <p className="text-xs" style={{ color: colors.textMuted }}>
                  Uploaded {agent.preauth_form_uploaded_at ? new Date(agent.preauth_form_uploaded_at).toLocaleDateString('en-CA') : 'recently'}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm mb-4" style={{ color: colors.textMuted }}>
              Please upload your signed pre-authorized debit form. Accepted formats: PDF, JPEG, or PNG (max 10MB).
            </p>
          )}

          <label
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold cursor-pointer transition-colors"
            style={{
              background: uploading ? colors.cardBg : colors.gold,
              color: uploading ? colors.textMuted : '#FFFFFF',
              opacity: uploading ? 0.6 : 1,
            }}
          >
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
            <div className="mt-3 flex items-center gap-1.5">
              {uploadMessage.type === 'success' ? <CheckCircle size={14} style={{ color: colors.successText }} /> : <AlertCircle size={14} style={{ color: colors.errorText }} />}
              <span className="text-sm" style={{ color: uploadMessage.type === 'success' ? colors.successText : colors.errorText }}>{uploadMessage.text}</span>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
