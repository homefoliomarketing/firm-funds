'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Lock, Mail, User, Bell, Eye, EyeOff, CheckCircle, AlertTriangle, ArrowLeft, FileSignature, ExternalLink } from 'lucide-react'
import SignOutModal from '@/components/SignOutModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  changePassword,
  updateDisplayName,
  updateEmail,
  getNotificationPreferences,
  updateNotificationPreferences,
} from '@/lib/actions/settings-actions'
import { getDocuSignStatus } from '@/lib/actions/esign-actions'

export default function AdminSettingsPage() {
  const [profile, setProfile] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPw, setShowCurrentPw] = useState(false)
  const [showNewPw, setShowNewPw] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)

  const [displayName, setDisplayName] = useState('')
  const [nameSaving, setNameSaving] = useState(false)

  const [email, setEmail] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)

  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({
    email_deal_updates: true,
    email_new_messages: true,
    email_status_changes: true,
    email_document_requests: true,
  })
  const [notifSaving, setNotifSaving] = useState(false)

  const [docuSignConnected, setDocuSignConnected] = useState(false)
  const [docuSignConsentUrl, setDocuSignConsentUrl] = useState<string | null>(null)
  const [docuSignLoading, setDocuSignLoading] = useState(true)

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      if (!profileData || !['super_admin', 'firm_funds_admin'].includes(profileData.role)) {
        router.push('/login'); return
      }

      setProfile(profileData)
      setDisplayName(profileData.full_name || '')
      setEmail(user.email || '')

      const prefsResult = await getNotificationPreferences()
      if (prefsResult.success && prefsResult.data) {
        setNotifPrefs(prefsResult.data as Record<string, boolean>)
      }

      const dsStatus = await getDocuSignStatus()
      setDocuSignConnected(dsStatus.connected)
      setDocuSignConsentUrl(dsStatus.consentUrl || null)
      setDocuSignLoading(false)

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
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-6 w-36 bg-white/10" />
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-4 py-8 space-y-4">
          {[1, 2, 3].map(i => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-4 w-36 mb-3" />
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </Card>
          ))}
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-3">
            <div className="flex items-center gap-3">
              <img src="/brand/white.png" alt="Firm Funds" className="h-10 sm:h-12 w-auto" />
              <div className="w-px h-8 bg-white/15" />
              <button
                onClick={() => router.push('/admin')}
                className="text-white/60 hover:text-primary transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
              <p className="text-sm font-medium tracking-wide text-white">Admin Settings</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-primary">{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <h1 className="sr-only">Admin Settings</h1>

        {/* Status message */}
        {message && (
          <div className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium border ${
            message.type === 'success'
              ? 'bg-green-950/50 border-green-800 text-green-400'
              : 'bg-red-950/50 border-red-800 text-red-400'
          }`}>
            {message.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            {message.text}
          </div>
        )}

        {/* CHANGE PASSWORD */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <Lock size={18} />
              Change Password
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs font-semibold text-muted-foreground mb-1">Current Password</Label>
              <div className="relative">
                <Input
                  type={showCurrentPw ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                  className="pr-10"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowCurrentPw(!showCurrentPw)}
                >
                  {showCurrentPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <Label className="text-xs font-semibold text-muted-foreground mb-1">New Password</Label>
              <div className="relative">
                <Input
                  type={showNewPw ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="pr-10"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowNewPw(!showNewPw)}
                >
                  {showNewPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <Label className="text-xs font-semibold text-muted-foreground mb-1">Confirm New Password</Label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
              />
              {newPassword && confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs mt-1 text-red-400">Passwords do not match</p>
              )}
            </div>
            <Button
              onClick={handlePasswordChange}
              disabled={pwSaving || !currentPassword || !newPassword || !confirmPassword}
              size="sm"
            >
              {pwSaving ? 'Updating...' : 'Update Password'}
            </Button>
          </CardContent>
        </Card>

        {/* DISPLAY NAME */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <User size={18} />
              Display Name
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="flex-1"
              />
              <Button
                onClick={handleNameUpdate}
                disabled={nameSaving || !displayName.trim() || displayName === profile?.full_name}
                size="sm"
              >
                {nameSaving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* EMAIL ADDRESS */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <Mail size={18} />
              Email Address
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1"
              />
              <Button
                onClick={handleEmailUpdate}
                disabled={emailSaving || !email.trim()}
                size="sm"
              >
                {emailSaving ? 'Saving...' : 'Update'}
              </Button>
            </div>
            <p className="text-xs mt-2 text-muted-foreground/70">
              Changing your email will require verification. A confirmation link will be sent to the new address.
            </p>
          </CardContent>
        </Card>

        {/* NOTIFICATION PREFERENCES */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <Bell size={18} />
              Email Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {[
              { key: 'email_deal_updates', label: 'Deal Updates', desc: 'New deal submissions, status changes, and funding events' },
              { key: 'email_new_messages', label: 'New Messages', desc: 'Messages from agents and brokerages' },
              { key: 'email_status_changes', label: 'Status Alerts', desc: 'Critical status changes requiring admin attention' },
              { key: 'email_document_requests', label: 'Document Uploads', desc: 'When agents upload new documents or respond to requests' },
            ].map(({ key, label, desc }) => (
              <div key={key} className="flex items-center justify-between py-2.5 border-b border-border/50 last:border-0">
                <div>
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">{desc}</p>
                </div>
                <Switch
                  checked={notifPrefs[key] ?? false}
                  onCheckedChange={() => togglePref(key)}
                  disabled={notifSaving}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* DOCUSIGN INTEGRATION */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <FileSignature size={18} />
              E-Signature (DocuSign)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {docuSignLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : docuSignConnected ? (
              <div className="flex items-center gap-3 py-2">
                <CheckCircle size={20} className="text-primary flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">DocuSign Connected</p>
                  <p className="text-xs text-muted-foreground">Commission Purchase Agreements and Irrevocable Directions to Pay will be sent through DocuSign for electronic signature.</p>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-sm mb-3 text-muted-foreground">
                  Connect your DocuSign account to enable electronic signatures on Commission Purchase Agreements and Irrevocable Directions to Pay.
                </p>
                {docuSignConsentUrl ? (
                  <a
                    href={docuSignConsentUrl}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <ExternalLink size={15} />
                    Connect DocuSign
                  </a>
                ) : (
                  <p className="text-xs text-muted-foreground/70">DocuSign configuration missing. Check environment variables.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
