'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Lock, Mail, User, Bell, Eye, EyeOff, CheckCircle, AlertTriangle, ArrowLeft, Building2 } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import SignOutModal from '@/components/SignOutModal'
import {
  changePassword,
  updateDisplayName,
  updateEmail,
  getNotificationPreferences,
  updateNotificationPreferences,
  updateBrokerageContactEmail,
} from '@/lib/actions/settings-actions'

export default function BrokerageSettingsPage() {
  const [profile, setProfile] = useState<any>(null)
  const [brokerage, setBrokerage] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  // Password state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPw, setShowCurrentPw] = useState(false)
  const [showNewPw, setShowNewPw] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)

  // Display name state
  const [displayName, setDisplayName] = useState('')
  const [nameSaving, setNameSaving] = useState(false)

  // Email state
  const [email, setEmail] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)

  // Brokerage contact email
  const [contactEmail, setContactEmail] = useState('')
  const [contactEmailSaving, setContactEmailSaving] = useState(false)

  // Notification prefs state
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({
    email_deal_updates: true,
    email_new_messages: true,
    email_status_changes: true,
    email_document_requests: true,
  })
  const [notifSaving, setNotifSaving] = useState(false)

  // Messages
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const router = useRouter()
  const supabase = createClient()
  const { colors } = useTheme()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      if (!profileData || profileData.role !== 'brokerage_admin') { router.push('/login'); return }
      setProfile(profileData)
      setDisplayName(profileData.full_name || '')
      setEmail(user.email || '')

      if (profileData.brokerage_id) {
        const { data: brokerageData } = await supabase
          .from('brokerages')
          .select('*')
          .eq('id', profileData.brokerage_id)
          .single()
        setBrokerage(brokerageData)
        setContactEmail(brokerageData?.contact_email || '')
      }

      const prefsResult = await getNotificationPreferences()
      if (prefsResult.success && prefsResult.data) {
        setNotifPrefs(prefsResult.data as Record<string, boolean>)
      }

      setLoading(false)
    }
    load()
  }, [])

  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 4000)
  }

  const handlePasswordChange = async () => {
    if (!currentPassword) { showMsg('error', 'Enter your current password'); return }
    if (!newPassword) { showMsg('error', 'Enter a new password'); return }
    if (newPassword.length < 8) { showMsg('error', 'New password must be at least 8 characters'); return }
    if (newPassword !== confirmPassword) { showMsg('error', 'Passwords do not match'); return }
    setPwSaving(true)
    const result = await changePassword({ currentPassword, newPassword })
    if (result.success) {
      showMsg('success', 'Password updated successfully')
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
    } else {
      showMsg('error', result.error || 'Failed to change password')
    }
    setPwSaving(false)
  }

  const handleNameUpdate = async () => {
    if (!displayName.trim()) { showMsg('error', 'Name cannot be empty'); return }
    setNameSaving(true)
    const result = await updateDisplayName(displayName)
    if (result.success) showMsg('success', 'Display name updated')
    else showMsg('error', result.error || 'Failed to update name')
    setNameSaving(false)
  }

  const handleEmailUpdate = async () => {
    if (!email.trim()) { showMsg('error', 'Email cannot be empty'); return }
    setEmailSaving(true)
    const result = await updateEmail(email)
    if (result.success) showMsg('success', result.message || 'Email updated — check your inbox')
    else showMsg('error', result.error || 'Failed to update email')
    setEmailSaving(false)
  }

  const handleContactEmailUpdate = async () => {
    if (!contactEmail.trim()) { showMsg('error', 'Contact email cannot be empty'); return }
    setContactEmailSaving(true)
    const result = await updateBrokerageContactEmail(contactEmail)
    if (result.success) showMsg('success', 'Brokerage contact email updated')
    else showMsg('error', result.error || 'Failed to update contact email')
    setContactEmailSaving(false)
  }

  const togglePref = async (key: string) => {
    const updated = { ...notifPrefs, [key]: !notifPrefs[key] }
    setNotifPrefs(updated)
    setNotifSaving(true)
    const result = await updateNotificationPreferences(updated)
    if (!result.success) { setNotifPrefs(notifPrefs); showMsg('error', 'Failed to save preference') }
    setNotifSaving(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: colors.pageBg }}>
        <header style={{ background: colors.headerBgGradient }}>
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <div className="h-6 w-36 rounded-md animate-pulse" style={{ background: 'rgba(255,255,255,0.1)' }} />
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-4 py-8">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="rounded-lg p-6 mb-4 animate-pulse" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
              <div className="h-4 w-36 rounded mb-3" style={{ background: colors.skeletonHighlight }} />
              <div className="h-10 w-full rounded" style={{ background: colors.skeletonBase }} />
            </div>
          ))}
        </main>
      </div>
    )
  }

  const inputStyle = {
    background: colors.inputBg,
    border: `1px solid ${colors.inputBorder}`,
    color: colors.inputText,
  }

  return (
    <div className="min-h-screen" style={{ background: colors.pageBg }}>
      {/* Header */}
      <header style={{ background: colors.headerBgGradient }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-3">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-10 sm:h-12 w-auto" />
              <div className="w-px h-8" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <button
                onClick={() => router.push('/brokerage')}
                className="transition-colors"
                style={{ color: 'rgba(255,255,255,0.6)' }}
                onMouseEnter={(e) => e.currentTarget.style.color = colors.gold}
                onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.6)'}
              >
                <ArrowLeft size={20} />
              </button>
              <p className="text-sm font-medium tracking-wide text-white">Brokerage Settings</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs" style={{ color: '#5FA873' }}>{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Status message */}
        {message && (
          <div
            className="flex items-center gap-2 px-4 py-3 rounded-lg mb-4 text-sm font-medium"
            style={{
              background: message.type === 'success' ? colors.successBg : colors.errorBg,
              border: `1px solid ${message.type === 'success' ? colors.successBorder : colors.errorBorder}`,
              color: message.type === 'success' ? colors.successText : colors.errorText,
            }}
          >
            {message.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            {message.text}
          </div>
        )}

        {/* CHANGE PASSWORD */}
        <div className="rounded-lg p-5 mb-4" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div className="flex items-center gap-2 mb-4">
            <Lock size={18} style={{ color: colors.gold }} />
            <h3 className="text-sm font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Change Password</h3>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Current Password</label>
              <div className="relative">
                <input type={showCurrentPw ? 'text' : 'password'} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="w-full rounded-lg px-3 py-2.5 text-sm pr-10" style={inputStyle} placeholder="Enter current password" />
                <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2" onClick={() => setShowCurrentPw(!showCurrentPw)} style={{ color: colors.textMuted }}>
                  {showCurrentPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>New Password</label>
              <div className="relative">
                <input type={showNewPw ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full rounded-lg px-3 py-2.5 text-sm pr-10" style={inputStyle} placeholder="At least 8 characters" />
                <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2" onClick={() => setShowNewPw(!showNewPw)} style={{ color: colors.textMuted }}>
                  {showNewPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: colors.textMuted }}>Confirm New Password</label>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="w-full rounded-lg px-3 py-2.5 text-sm" style={inputStyle} placeholder="Re-enter new password" />
              {newPassword && confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs mt-1" style={{ color: colors.errorText }}>Passwords do not match</p>
              )}
            </div>
            <button onClick={handlePasswordChange} disabled={pwSaving || !currentPassword || !newPassword || !confirmPassword} className="px-4 py-2 rounded-lg text-sm font-semibold" style={{ background: colors.gold, color: '#fff', opacity: pwSaving || !currentPassword || !newPassword || !confirmPassword ? 0.5 : 1 }}>
              {pwSaving ? 'Updating...' : 'Update Password'}
            </button>
          </div>
        </div>

        {/* DISPLAY NAME */}
        <div className="rounded-lg p-5 mb-4" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div className="flex items-center gap-2 mb-4">
            <User size={18} style={{ color: colors.gold }} />
            <h3 className="text-sm font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Display Name</h3>
          </div>
          <div className="flex gap-3">
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="flex-1 rounded-lg px-3 py-2.5 text-sm" style={inputStyle} />
            <button onClick={handleNameUpdate} disabled={nameSaving || !displayName.trim() || displayName === profile?.full_name} className="px-4 py-2 rounded-lg text-sm font-semibold" style={{ background: colors.gold, color: '#fff', opacity: nameSaving || !displayName.trim() || displayName === profile?.full_name ? 0.5 : 1 }}>
              {nameSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {/* EMAIL ADDRESS */}
        <div className="rounded-lg p-5 mb-4" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div className="flex items-center gap-2 mb-4">
            <Mail size={18} style={{ color: colors.gold }} />
            <h3 className="text-sm font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Login Email</h3>
          </div>
          <div className="flex gap-3">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1 rounded-lg px-3 py-2.5 text-sm" style={inputStyle} />
            <button onClick={handleEmailUpdate} disabled={emailSaving || !email.trim()} className="px-4 py-2 rounded-lg text-sm font-semibold" style={{ background: colors.gold, color: '#fff', opacity: emailSaving || !email.trim() ? 0.5 : 1 }}>
              {emailSaving ? 'Saving...' : 'Update'}
            </button>
          </div>
          <p className="text-xs mt-2" style={{ color: colors.textFaint }}>
            This is the email you use to log in. Changing it requires verification.
          </p>
        </div>

        {/* BROKERAGE CONTACT EMAIL */}
        <div className="rounded-lg p-5 mb-4" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div className="flex items-center gap-2 mb-4">
            <Building2 size={18} style={{ color: colors.gold }} />
            <h3 className="text-sm font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Brokerage Contact Email</h3>
          </div>
          <div className="flex gap-3">
            <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className="flex-1 rounded-lg px-3 py-2.5 text-sm" style={inputStyle} />
            <button onClick={handleContactEmailUpdate} disabled={contactEmailSaving || !contactEmail.trim() || contactEmail === brokerage?.contact_email} className="px-4 py-2 rounded-lg text-sm font-semibold" style={{ background: colors.gold, color: '#fff', opacity: contactEmailSaving || !contactEmail.trim() || contactEmail === brokerage?.contact_email ? 0.5 : 1 }}>
              {contactEmailSaving ? 'Saving...' : 'Update'}
            </button>
          </div>
          <p className="text-xs mt-2" style={{ color: colors.textFaint }}>
            This is the email address that receives deal notifications from Firm Funds. It can be different from your login email.
          </p>
        </div>

        {/* NOTIFICATION PREFERENCES */}
        <div className="rounded-lg p-5" style={{ background: colors.cardBg, border: `1px solid ${colors.cardBorder}` }}>
          <div className="flex items-center gap-2 mb-4">
            <Bell size={18} style={{ color: colors.gold }} />
            <h3 className="text-sm font-bold uppercase tracking-wider" style={{ color: colors.gold }}>Email Notifications</h3>
          </div>
          <div className="space-y-3">
            {[
              { key: 'email_deal_updates', label: 'Deal Updates', desc: 'New deal submissions and status changes for your agents' },
              { key: 'email_new_messages', label: 'New Messages', desc: 'Messages from Firm Funds admin regarding your deals' },
              { key: 'email_status_changes', label: 'Status Alerts', desc: 'When deals are approved, funded, or denied' },
              { key: 'email_document_requests', label: 'Document Notifications', desc: 'Trade record requests and document updates' },
            ].map(({ key, label, desc }) => (
              <div key={key} className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${colors.divider}` }}>
                <div>
                  <p className="text-sm font-medium" style={{ color: colors.textPrimary }}>{label}</p>
                  <p className="text-xs" style={{ color: colors.textMuted }}>{desc}</p>
                </div>
                <button
                  onClick={() => togglePref(key)}
                  disabled={notifSaving}
                  className="relative w-11 h-6 rounded-full transition-colors"
                  style={{ background: notifPrefs[key] ? colors.gold : colors.inputBorder }}
                >
                  <span className="absolute top-0.5 w-5 h-5 rounded-full transition-transform" style={{ background: '#fff', left: notifPrefs[key] ? '22px' : '2px' }} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  )
}
