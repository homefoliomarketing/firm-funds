'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Lock, Mail, User, Bell, Eye, EyeOff, CheckCircle, AlertTriangle, Settings } from 'lucide-react'
import AgentHeader from '@/components/AgentHeader'
import {
  changePassword,
  updateDisplayName,
  updateEmail,
  getNotificationPreferences,
  updateNotificationPreferences,
} from '@/lib/actions/settings-actions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

export default function AgentSettingsPage() {
  const [profile, setProfile] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
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

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      if (!profileData || profileData.role !== 'agent') { router.push('/login'); return }
      setProfile(profileData)
      setDisplayName(profileData.full_name || '')
      setEmail(user.email || '')

      if (profileData.agent_id) {
        const { data: agentData } = await supabase
          .from('agents')
          .select('*, brokerages(name, logo_url, brand_color)')
          .eq('id', profileData.agent_id)
          .single()
        setAgent(agentData)
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
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } else {
      showMsg('error', result.error || 'Failed to change password')
    }
    setPwSaving(false)
  }

  const handleNameUpdate = async () => {
    if (!displayName.trim()) { showMsg('error', 'Name cannot be empty'); return }
    setNameSaving(true)
    const result = await updateDisplayName(displayName)
    if (result.success) {
      showMsg('success', 'Display name updated')
    } else {
      showMsg('error', result.error || 'Failed to update name')
    }
    setNameSaving(false)
  }

  const handleEmailUpdate = async () => {
    if (!email.trim()) { showMsg('error', 'Email cannot be empty'); return }
    setEmailSaving(true)
    const result = await updateEmail(email)
    if (result.success) {
      showMsg('success', result.message || 'Email updated — check your inbox for confirmation')
    } else {
      showMsg('error', result.error || 'Failed to update email')
    }
    setEmailSaving(false)
  }

  const togglePref = async (key: string) => {
    const updated = { ...notifPrefs, [key]: !notifPrefs[key] }
    setNotifPrefs(updated)
    setNotifSaving(true)
    const result = await updateNotificationPreferences(updated)
    if (!result.success) {
      setNotifPrefs(notifPrefs)
      showMsg('error', 'Failed to save notification preference')
    }
    setNotifSaving(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto px-4 py-12">
          <div className="h-6 w-48 rounded-lg mb-4 animate-pulse bg-muted" />
          <div className="h-4 w-32 rounded mb-8 animate-pulse bg-muted" />
          {[1, 2, 3].map(i => (
            <div key={i} className="rounded-lg p-6 mb-4 animate-pulse bg-card border border-border">
              <div className="h-4 w-36 rounded mb-3 bg-muted" />
              <div className="h-10 w-full rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <AgentHeader
        agentName={profile?.full_name || ''}
        agentId={profile?.agent_id || ''}
        backHref="/agent"
        title="Settings"
        subtitle="Manage your account"
        brokerageLogo={agent?.brokerages?.logo_url}
        brokerageName={agent?.brokerages?.name}
      />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Status message */}
        {message && (
          <div className={`flex items-center gap-2 px-4 py-3 rounded-lg mb-4 text-sm font-medium border ${
            message.type === 'success'
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'bg-destructive/10 border-destructive/30 text-destructive'
          }`}>
            {message.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            {message.text}
          </div>
        )}

        {/* CHANGE PASSWORD */}
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-primary">
              <Lock size={18} />Change Password
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground">Current Password</Label>
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
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground">New Password</Label>
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
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground">Confirm New Password</Label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
              />
              {newPassword && confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs text-destructive">Passwords do not match</p>
              )}
            </div>
            <Button
              onClick={handlePasswordChange}
              disabled={pwSaving || !currentPassword || !newPassword || !confirmPassword}
            >
              {pwSaving ? 'Updating...' : 'Update Password'}
            </Button>
          </CardContent>
        </Card>

        {/* DISPLAY NAME */}
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-primary">
              <User size={18} />Display Name
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
              >
                {nameSaving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* EMAIL ADDRESS */}
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-primary">
              <Mail size={18} />Email Address
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
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
              >
                {emailSaving ? 'Saving...' : 'Update'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Changing your email will require verification. A confirmation link will be sent to the new address.
            </p>
          </CardContent>
        </Card>

        {/* NOTIFICATION PREFERENCES */}
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-primary">
              <Bell size={18} />Email Notifications
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              {[
                { key: 'email_deal_updates', label: 'Deal Updates', desc: 'Status changes on your deals (approved, funded, etc.)' },
                { key: 'email_new_messages', label: 'New Messages', desc: 'When an admin or brokerage sends you a message' },
                { key: 'email_status_changes', label: 'Status Alerts', desc: 'Important status changes requiring your attention' },
                { key: 'email_document_requests', label: 'Document Requests', desc: 'When documents are requested or returned' },
              ].map(({ key, label, desc }, idx, arr) => (
                <div key={key}>
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{label}</p>
                      <p className="text-xs text-muted-foreground">{desc}</p>
                    </div>
                    <button
                      onClick={() => togglePref(key)}
                      disabled={notifSaving}
                      className="relative w-11 h-6 rounded-full transition-colors disabled:opacity-50"
                      style={{ background: notifPrefs[key] ? 'hsl(var(--primary))' : 'hsl(var(--border))' }}
                    >
                      <span
                        className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                        style={{ left: notifPrefs[key] ? '22px' : '2px' }}
                      />
                    </button>
                  </div>
                  {idx < arr.length - 1 && <Separator />}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Link to Profile */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-primary">
              <Settings size={18} />Profile &amp; Banking
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Update your phone number, address, and banking information on your profile page.
            </p>
            <Button onClick={() => router.push('/agent/profile')}>
              Go to Profile →
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
