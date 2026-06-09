'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Lock, Mail, User, Bell, Eye, EyeOff, ArrowLeft, Building2, Users, UserPlus, Shield } from 'lucide-react'
import { StatusToast } from '@/components/StatusToast'
import SignOutModal from '@/components/SignOutModal'
import BrokerageBrandLogo from '@/components/BrokerageBrandLogo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { BROKERAGE_PUBLIC_COLUMNS } from '@/lib/constants'
import {
  changePassword,
  updateDisplayName,
  updateEmail,
  getNotificationPreferences,
  updateNotificationPreferences,
  updateBrokerageContactEmail,
} from '@/lib/actions/settings-actions'
import { getBrokerageStaff, inviteBrokerageStaff, updateStaffTitle } from '@/lib/actions/profile-actions'
import { getMyBrokerageAdminRole } from '@/lib/actions/brokerage-admin-actions'
import { canManageBrokerageTeam, BROKERAGE_ADMIN_ROLE_LABEL, type BrokerageAdminRole } from '@/lib/brokerage-admin-roles'
import type { Brokerage, UserProfile } from '@/types/database'

type BrokeragePublic = Pick<Brokerage,
  | 'id' | 'name' | 'logo_url' | 'logo_includes_tagline' | 'email' | 'profit_share_pct' | 'is_white_label_partner'
  | 'broker_of_record_name' | 'broker_of_record_email'
>

interface StaffMember {
  id: string
  full_name: string
  email: string
  staff_title?: string | null
  last_login?: string | null
}

export default function BrokerageSettingsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [brokerage, setBrokerage] = useState<BrokeragePublic | null>(null)
  const [myBrokerageRole, setMyBrokerageRole] = useState<BrokerageAdminRole | null>(null)
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

  const [contactEmail, setContactEmail] = useState('')
  const [contactEmailSaving, setContactEmailSaving] = useState(false)

  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({
    email_deal_updates: true,
    email_new_messages: true,
    email_status_changes: true,
    email_document_requests: true,
  })
  const [notifSaving, setNotifSaving] = useState(false)

  // Staff management
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [showInviteStaff, setShowInviteStaff] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteTitle, setInviteTitle] = useState('')
  const [inviting, setInviting] = useState(false)
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [editTitleValue, setEditTitleValue] = useState('')

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

      if (!profileData || profileData.role !== 'brokerage_admin') { router.push('/login'); return }
      setProfile(profileData)
      setDisplayName(profileData.full_name || '')
      setEmail(user.email || '')

      if (profileData.brokerage_id) {
        const { data: brokerageData } = await supabase
          .from('brokerages')
          .select(BROKERAGE_PUBLIC_COLUMNS)
          .eq('id', profileData.brokerage_id)
          .single<BrokeragePublic>()
        setBrokerage(brokerageData)
        setContactEmail(brokerageData?.email || '')
      }

      const prefsResult = await getNotificationPreferences()
      if (prefsResult.success && prefsResult.data) {
        setNotifPrefs(prefsResult.data as Record<string, boolean>)
      }

      // Load staff
      const staffResult = await getBrokerageStaff()
      if (staffResult.success && staffResult.data) {
        setStaff(staffResult.data)
      }

      // Resolve the caller's brokerage sub-role so we can show/hide the
      // Team Admins card. Plain Brokerage Admins should not see it.
      const roleResult = await getMyBrokerageAdminRole()
      if (roleResult.success && roleResult.data) {
        setMyBrokerageRole(roleResult.data.role)
      }

      setLoading(false)
    }
    load()
    // supabase/router are stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
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
    if (result.success) showMsg('success', result.message || 'Email updated. Check your inbox')
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
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-6 w-36 rounded-md bg-white/10" />
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-4 py-8 space-y-4">
          {[1, 2, 3, 4].map(i => (
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
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-3">
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <BrokerageBrandLogo logoUrl={brokerage?.logo_url} brokerageName={brokerage?.name} logoIncludesTagline={brokerage?.logo_includes_tagline} size="md" />
              <div className="w-px h-8 bg-white/15" />
              <button
                onClick={() => router.push('/brokerage')}
                className="text-white/60 hover:text-primary transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
              <p className="text-sm font-medium tracking-wide text-white">Brokerage Settings</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-primary">{profile?.full_name}</span>
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <h1 className="sr-only">Brokerage Settings</h1>

        {/* Status message */}
        <StatusToast message={message} onDismiss={() => setMessage(null)} />

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

        {/* LOGIN EMAIL */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <Mail size={18} />
              Login Email <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              {(() => {
                const trimmed = email.trim()
                const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
                const isInvalid = trimmed.length > 0 && !emailRe.test(trimmed)
                return (
                  <>
                    <Input
                      id="login-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="flex-1"
                      required
                      aria-invalid={isInvalid || undefined}
                      aria-describedby={`login-email-hint${isInvalid ? ' login-email-error' : ''}`}
                    />
                    <Button
                      onClick={handleEmailUpdate}
                      disabled={emailSaving || !trimmed || isInvalid}
                      size="sm"
                    >
                      {emailSaving ? 'Saving...' : 'Update'}
                    </Button>
                  </>
                )
              })()}
            </div>
            <p id="login-email-hint" className="text-xs mt-2 text-muted-foreground/70">
              This is the email you use to log in. Changing it requires verification.
            </p>
            {email.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && (
              <p id="login-email-error" className="text-xs mt-1 text-destructive font-medium">
                Enter a valid email address.
              </p>
            )}
          </CardContent>
        </Card>

        {/* BROKERAGE CONTACT EMAIL */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <Building2 size={18} />
              Brokerage Contact Email <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              {(() => {
                const trimmed = contactEmail.trim()
                const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
                const isInvalidShape = trimmed.length > 0 && !emailRe.test(trimmed)
                return (
                  <>
                    <Input
                      id="brokerage-contact-email"
                      type="email"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      className="flex-1"
                      required
                      aria-invalid={isInvalidShape || undefined}
                      aria-describedby={`contact-email-hint${isInvalidShape ? ' contact-email-error' : ''}`}
                    />
                    <Button
                      onClick={handleContactEmailUpdate}
                      disabled={contactEmailSaving || !trimmed || isInvalidShape || contactEmail === brokerage?.email}
                      size="sm"
                    >
                      {contactEmailSaving ? 'Saving...' : 'Update'}
                    </Button>
                  </>
                )
              })()}
            </div>
            <p id="contact-email-hint" className="text-xs mt-2 text-muted-foreground/70">
              This is the email address that receives deal notifications from Firm Funds. Required. It can be different from your login email.
            </p>
            {contactEmail.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim()) && (
              <p id="contact-email-error" className="text-xs mt-1 text-destructive font-medium">
                Enter a valid email address (e.g. you@brokerage.com).
              </p>
            )}
          </CardContent>
        </Card>

        {/* BROKER OF RECORD EMAIL — read-only here because mutating BOR
            requires Firm Funds approval and a re-signed BCA. Surfacing it
            still beats the audit finding where brokerages didn't know
            what we had on file. */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <Shield size={18} />
              Broker of Record
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold text-muted-foreground mb-1">Name</Label>
                <Input
                  type="text"
                  value={brokerage?.broker_of_record_name || ''}
                  readOnly
                  disabled
                  aria-readonly="true"
                  placeholder="Not on file"
                />
              </div>
              <div>
                <Label className="text-xs font-semibold text-muted-foreground mb-1">Email</Label>
                <Input
                  type="email"
                  value={brokerage?.broker_of_record_email || ''}
                  readOnly
                  disabled
                  aria-readonly="true"
                  placeholder="Not on file"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground/70">
              Broker of Record is a regulatory contact and only Firm Funds can change it.
              Contact <a href="mailto:bud@firmfunds.ca" className="underline underline-offset-2">bud@firmfunds.ca</a> to update.
              {!brokerage?.broker_of_record_email && (
                <span className="block mt-1 text-status-amber">
                  No Broker of Record email on file. Please reach out so we can fix this for FINTRAC compliance.
                </span>
              )}
            </p>
          </CardContent>
        </Card>

        {/* TEAM ADMINS — only visible to Broker of Record and Brokerage
            Manager. Plain Brokerage Admins shouldn't see the link because
            they can't manage other admins anyway. */}
        {canManageBrokerageTeam(myBrokerageRole) && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                <Shield size={18} />
                Team Admins
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-1">
                Add or remove other people from your brokerage who should be able to sign in to the Firm Funds portal,
                manage agents, and submit deals.
              </p>
              {myBrokerageRole && (
                <p className="text-[11px] text-muted-foreground/70 mb-3">
                  You are signed in as <span className="font-semibold text-foreground">{BROKERAGE_ADMIN_ROLE_LABEL[myBrokerageRole]}</span>.
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/brokerage/admins')}
              >
                <Users size={14} className="mr-1.5" aria-hidden="true" />
                Manage team admins
              </Button>
            </CardContent>
          </Card>
        )}

        {/* STAFF / TEAM */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                <Users size={18} />
                Team Members
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowInviteStaff(!showInviteStaff)}
                className="text-xs gap-1"
              >
                <UserPlus size={14} />
                Add Staff
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Invite form */}
            {showInviteStaff && (
              <div className="p-4 rounded-lg bg-muted/50 border border-border/50 space-y-3">
                <p className="text-xs font-semibold text-foreground">Invite a team member</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Full Name</Label>
                    <Input
                      value={inviteName}
                      onChange={(e) => setInviteName(e.target.value)}
                      placeholder="Jane Smith"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Email</Label>
                    <Input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="jane@brokerage.com"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Title / Role (optional)</Label>
                  <Input
                    value={inviteTitle}
                    onChange={(e) => setInviteTitle(e.target.value)}
                    placeholder="e.g. Office Manager, Broker of Record"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={inviting || !inviteName.trim() || !inviteEmail.trim()}
                    onClick={async () => {
                      setInviting(true)
                      const result = await inviteBrokerageStaff({
                        fullName: inviteName,
                        email: inviteEmail,
                        staffTitle: inviteTitle || undefined,
                      })
                      if (result.success) {
                        showMsg('success', `Invite sent to ${inviteEmail}`)
                        setInviteName(''); setInviteEmail(''); setInviteTitle('')
                        setShowInviteStaff(false)
                        // Refresh staff list
                        const refresh = await getBrokerageStaff()
                        if (refresh.success && refresh.data) setStaff(refresh.data)
                      } else {
                        showMsg('error', result.error || 'Failed to send invite')
                      }
                      setInviting(false)
                    }}
                  >
                    {inviting ? 'Sending...' : 'Send Invite'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowInviteStaff(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Staff list */}
            {staff.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No team members yet. Add staff to give them access to the brokerage portal.</p>
            ) : (
              <div className="divide-y divide-border/50">
                {staff.map((member) => (
                  <div key={member.id} className="flex items-center justify-between py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-foreground truncate">{member.full_name}</p>
                        {member.id === profile?.id && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-semibold">You</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                      {editingTitleId === member.id ? (
                        <div className="flex items-center gap-1.5 mt-1">
                          <Input
                            value={editTitleValue}
                            onChange={(e) => setEditTitleValue(e.target.value)}
                            placeholder="e.g. Office Manager"
                            className="h-7 text-xs max-w-[200px]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs px-2"
                            onClick={async () => {
                              await updateStaffTitle(member.id, editTitleValue)
                              setEditingTitleId(null)
                              const refresh = await getBrokerageStaff()
                              if (refresh.success && refresh.data) setStaff(refresh.data)
                            }}
                          >
                            Save
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs px-2"
                            onClick={() => setEditingTitleId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <p
                          className="text-xs text-primary/80 mt-0.5 cursor-pointer hover:underline"
                          onClick={() => { setEditingTitleId(member.id); setEditTitleValue(member.staff_title || '') }}
                        >
                          {member.staff_title || 'Add title...'}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      {member.last_login ? (
                        <p className="text-[11px] text-muted-foreground">
                          Last login {new Date(member.last_login).toLocaleDateString('en-CA')}
                        </p>
                      ) : (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-status-amber-muted text-status-amber font-medium">
                          Invite pending
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
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
              { key: 'email_deal_updates', label: 'Deal Updates', desc: 'New deal submissions and status changes for your agents' },
              { key: 'email_new_messages', label: 'New Messages', desc: 'Messages from Firm Funds admin regarding your deals' },
              { key: 'email_status_changes', label: 'Status Alerts', desc: 'When deals are approved, funded, or denied' },
              { key: 'email_document_requests', label: 'Document Notifications', desc: 'Trade record requests and document updates' },
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
      </main>
    </div>
  )
}
