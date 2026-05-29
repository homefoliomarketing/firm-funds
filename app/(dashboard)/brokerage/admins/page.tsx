'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft, Users, UserPlus, Trash2, ShieldCheck, Mail, CheckCircle2,
  AlertTriangle, Loader2, Clock, Lock,
} from 'lucide-react'
import SignOutModal from '@/components/SignOutModal'
import BrokerageBrandLogo from '@/components/BrokerageBrandLogo'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import {
  inviteBrokerageAdmin,
  listBrokerageAdmins,
  removeBrokerageAdmin,
  getMyBrokerageAdminRole,
} from '@/lib/actions/brokerage-admin-actions'
import {
  canManageBrokerageTeam,
  BROKERAGE_ADMIN_ROLE_LABEL,
  type BrokerageAdmin,
  type BrokerageAdminRole,
} from '@/lib/brokerage-admin-roles'
import { BROKERAGE_PUBLIC_COLUMNS } from '@/lib/constants'
import type { Brokerage, UserProfile } from '@/types/database'

type BrokeragePublic = Pick<Brokerage, 'id' | 'name' | 'logo_url' | 'logo_includes_tagline' | 'email' | 'profit_share_pct' | 'is_white_label_partner'>

const ROLE_DESCRIPTION: Record<BrokerageAdminRole, string> = {
  broker_of_record:
    'Regulatory signatory. Can be changed only by Firm Funds.',
  brokerage_manager:
    'Day-to-day owner of the portal. Can invite and remove other admins.',
  brokerage_admin:
    'Submits deals and manages agents. No team-management rights.',
}

function formatDateOrDash(iso: string | null | undefined): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleDateString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
    })
  } catch {
    return '-'
  }
}

export default function BrokerageAdminsPage() {
  const router = useRouter()
  const supabase = createClient()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [brokerage, setBrokerage] = useState<BrokeragePublic | null>(null)
  const [admins, setAdmins] = useState<BrokerageAdmin[]>([])
  const [myRole, setMyRole] = useState<BrokerageAdminRole | null>(null)
  const [loading, setLoading] = useState(true)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const [showInvite, setShowInvite] = useState(false)
  const [inviteFirstName, setInviteFirstName] = useState('')
  const [inviteLastName, setInviteLastName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<BrokerageAdminRole>('brokerage_admin')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const [removeTarget, setRemoveTarget] = useState<BrokerageAdmin | null>(null)
  const [removing, setRemoving] = useState(false)

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    if (kind === 'ok') { setOkMsg(text); setErrMsg(null) } else { setErrMsg(text); setOkMsg(null) }
    setTimeout(() => { setOkMsg(null); setErrMsg(null) }, 4500)
  }, [])

  const refreshAdmins = useCallback(async (brokerageId: string) => {
    const result = await listBrokerageAdmins(brokerageId)
    if (result.success && result.data) {
      setAdmins(result.data)
    } else if (result.error) {
      setErrMsg(result.error)
    }
  }, [])

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()
      if (!profileData || profileData.role !== 'brokerage_admin' || !profileData.brokerage_id) {
        router.push('/login'); return
      }
      setProfile(profileData)

      // Fetch the caller's sub-role inside this brokerage. Plain
      // brokerage_admins are bounced to the dashboard — only BoR and
      // Brokerage Manager can manage the team.
      const roleResult = await getMyBrokerageAdminRole()
      const subRole = roleResult.success && roleResult.data ? roleResult.data.role : null
      setMyRole(subRole)
      if (!canManageBrokerageTeam(subRole)) {
        router.push('/brokerage/settings')
        return
      }

      const { data: brokerageData } = await supabase
        .from('brokerages')
        .select(BROKERAGE_PUBLIC_COLUMNS)
        .eq('id', profileData.brokerage_id)
        .single<BrokeragePublic>()
      setBrokerage(brokerageData)

      await refreshAdmins(profileData.brokerage_id)
      setLoading(false)
    }
    load().catch(() => {
      setErrMsg('Failed to load brokerage admins.')
      setLoading(false)
    })
  }, [router, supabase, refreshAdmins])

  const handleInvite = async () => {
    if (!profile?.brokerage_id) return
    setInviteError(null)
    if (!inviteFirstName.trim() || !inviteLastName.trim() || !inviteEmail.trim()) {
      setInviteError('First name, last name, and email are all required.')
      return
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRe.test(inviteEmail.trim())) {
      setInviteError('Enter a valid email address.')
      return
    }
    setInviting(true)
    const result = await inviteBrokerageAdmin({
      brokerageId: profile.brokerage_id,
      email: inviteEmail.trim(),
      firstName: inviteFirstName.trim(),
      lastName: inviteLastName.trim(),
      role: inviteRole,
    })
    if (result.success) {
      flash('ok', `Invite sent to ${inviteEmail.trim()}`)
      setInviteFirstName(''); setInviteLastName(''); setInviteEmail('')
      setInviteRole('brokerage_admin')
      setShowInvite(false)
      await refreshAdmins(profile.brokerage_id)
    } else {
      setInviteError(result.error || 'Failed to send invite.')
    }
    setInviting(false)
  }

  const handleRemove = async () => {
    if (!removeTarget || !profile?.brokerage_id) return
    setRemoving(true)
    const result = await removeBrokerageAdmin({ brokerageAdminId: removeTarget.id })
    if (result.success) {
      flash('ok', 'Admin removed.')
      setRemoveTarget(null)
      await refreshAdmins(profile.brokerage_id)
    } else {
      flash('err', result.error || 'Failed to remove admin.')
    }
    setRemoving(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // Only the Broker of Record can promote to Brokerage Manager. Plain
  // managers and admins get only the brokerage_admin option in the dropdown.
  const canPromoteToManager = myRole === 'broker_of_record'

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
            <Skeleton className="h-6 w-48 rounded-md bg-white/10" />
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-4 py-8 space-y-3">
          {[1, 2, 3].map(i => (
            <Card key={i}><CardContent className="p-5"><Skeleton className="h-12 w-full" /></CardContent></Card>
          ))}
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-3">
            <div className="flex items-center gap-3">
              <BrokerageBrandLogo logoUrl={brokerage?.logo_url} brokerageName={brokerage?.name} logoIncludesTagline={brokerage?.logo_includes_tagline} size="md" />
              <div className="w-px h-8 bg-white/15" />
              <button
                onClick={() => router.push('/brokerage/settings')}
                className="text-white/60 hover:text-primary transition-colors"
                aria-label="Back to brokerage settings"
              >
                <ArrowLeft size={20} />
              </button>
              <p className="text-sm font-medium tracking-wide text-white">
                Team Admins{brokerage ? `, ${brokerage.name}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <SignOutModal onConfirm={handleLogout} />
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <h1 className="sr-only">Manage team admins</h1>

        {okMsg && (
          <Alert role="status">
            <CheckCircle2 size={16} className="text-status-green" aria-hidden="true" />
            <AlertDescription>{okMsg}</AlertDescription>
          </Alert>
        )}
        {errMsg && (
          <Alert variant="destructive" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <AlertDescription>{errMsg}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <Users size={18} />
              Team Admins ({admins.length})
            </CardTitle>
            <Button size="sm" onClick={() => setShowInvite(true)}>
              <UserPlus size={14} className="mr-1.5" aria-hidden="true" />
              Invite admin
            </Button>
          </CardHeader>
          <CardContent>
            {admins.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No admins yet"
                description="Invite a colleague so more than one person can sign in to your brokerage portal."
                compact
              />
            ) : (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border/40">
                      <th className="px-3 py-2 font-semibold">Name</th>
                      <th className="px-3 py-2 font-semibold">Email</th>
                      <th className="px-3 py-2 font-semibold">Role</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Date added</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Last sign-in</th>
                      <th className="px-3 py-2 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {admins.map((a) => {
                      const isYou = profile?.id === a.user_id
                      const isPending = !a.accepted_at
                      const isBor = a.role === 'broker_of_record'
                      // BoR can only be removed by Firm Funds. The button stays
                      // visible but disabled with a tooltip explaining why.
                      const removeBlocked = isYou || isBor
                      const removeReason = isYou
                        ? 'You cannot remove yourself.'
                        : isBor
                          ? 'The Broker of Record can only be changed by Firm Funds. Email bud@firmfunds.ca.'
                          : `Remove ${a.full_name || a.email || 'admin'}`
                      return (
                        <tr key={a.id} className="align-top">
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-medium text-foreground">
                                {a.full_name || 'Unknown'}
                              </span>
                              {isYou && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-semibold">
                                  You
                                </span>
                              )}
                              {isPending && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-amber-muted text-status-amber font-semibold inline-flex items-center gap-0.5">
                                  <Clock size={10} aria-hidden="true" />
                                  Invite pending
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Mail size={11} aria-hidden="true" className="text-muted-foreground/70" />
                              {a.email || 'No email on file'}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className={`text-[11px] px-2 py-1 rounded font-semibold inline-flex items-center gap-1 ${
                                isBor
                                  ? 'bg-status-green-muted text-status-green'
                                  : a.role === 'brokerage_manager'
                                    ? 'bg-primary/10 text-primary'
                                    : 'bg-muted text-muted-foreground'
                              }`}
                              title={ROLE_DESCRIPTION[a.role]}
                            >
                              {isBor && <ShieldCheck size={11} aria-hidden="true" />}
                              {BROKERAGE_ADMIN_ROLE_LABEL[a.role]}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                            {formatDateOrDash(a.invited_at)}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                            {a.last_login
                              ? formatDateOrDash(a.last_login)
                              : <span className="text-muted-foreground/60">Never</span>}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive border-destructive/30 hover:bg-destructive/10 disabled:opacity-50"
                              onClick={() => setRemoveTarget(a)}
                              disabled={removeBlocked}
                              title={removeReason}
                              aria-label={removeReason}
                            >
                              {isBor ? (
                                <Lock size={13} className="mr-1" aria-hidden="true" />
                              ) : (
                                <Trash2 size={13} className="mr-1" aria-hidden="true" />
                              )}
                              Remove
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground/70">
          The Broker of Record is the brokerage&apos;s regulatory contact and can only be changed by Firm Funds.
          Email <a className="underline underline-offset-2" href="mailto:bud@firmfunds.ca">bud@firmfunds.ca</a> if you need to swap who holds that role.
        </p>
      </main>

      {/* Invite modal */}
      <Dialog open={showInvite} onOpenChange={(open) => { if (!open) { setShowInvite(false); setInviteError(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite an admin</DialogTitle>
            <DialogDescription>
              They&apos;ll get an email invite to set their password and log in.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="invite-fn">First name</Label>
                <Input
                  id="invite-fn"
                  value={inviteFirstName}
                  onChange={(e) => setInviteFirstName(e.target.value)}
                  autoComplete="given-name"
                  required
                />
              </div>
              <div>
                <Label htmlFor="invite-ln">Last name</Label>
                <Input
                  id="invite-ln"
                  value={inviteLastName}
                  onChange={(e) => setInviteLastName(e.target.value)}
                  autoComplete="family-name"
                  required
                />
              </div>
            </div>
            <div>
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@brokerage.com"
                autoComplete="email"
                required
              />
            </div>
            <div>
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as BrokerageAdminRole)}
                className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-input border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="brokerage_admin">Brokerage Admin (submits deals, manages agents)</option>
                {canPromoteToManager && (
                  <option value="brokerage_manager">Brokerage Manager (also manages team admins)</option>
                )}
              </select>
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                {canPromoteToManager
                  ? 'Only you, the Broker of Record, can seat another Brokerage Manager.'
                  : 'Only the Broker of Record can promote to Brokerage Manager. Email bud@firmfunds.ca for BoR changes.'}
              </p>
            </div>
            {inviteError && (
              <Alert variant="destructive">
                <AlertTriangle size={14} aria-hidden="true" />
                <AlertDescription>{inviteError}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInvite(false)} disabled={inviting}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={inviting}>
              {inviting && <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" />}
              {inviting ? 'Sending invite...' : 'Send invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <Dialog open={!!removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove admin</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove{' '}
              <span className="font-semibold text-foreground">
                {removeTarget?.full_name || removeTarget?.email || 'this admin'}
              </span>
              ? They will lose access to your brokerage portal immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing && <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" />}
              {removing ? 'Removing...' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
