'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Mail, Plus, ShieldCheck, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDate } from '@/lib/formatting'
import { cn } from '@/lib/utils'

// ============================================================================
// Server-action call wrappers — lazily resolved
// ============================================================================

async function callListBrokerageAdmins(brokerageId: string): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@/lib/actions/brokerage-admin-actions' as any)
    if (typeof mod.listBrokerageAdmins === 'function') {
      return mod.listBrokerageAdmins(brokerageId)
    }
  } catch {
    // fall through to the legacy helper below
  }
  // Fallback to the existing getBrokerageUserProfiles helper in admin-actions
  // until the dedicated list module ships. Shape: { brokerageAdmins: [], agents: [] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy: any = await import('@/lib/actions/admin-actions')
  const result = await legacy.getBrokerageUserProfiles({ brokerageId })
  if (!result?.success) return result
  return {
    success: true,
    data: (result.data?.brokerageAdmins ?? []).map((u: any) => ({
      id: u.id,
      user_id: u.id,
      brokerage_id: brokerageId,
      role: u.role ?? 'admin',
      full_name: u.full_name,
      email: u.email,
      invited_at: u.created_at ?? null,
      accepted_at: u.last_login ?? null,
    })),
  }
}

async function callInviteBrokerageAdmin(payload: {
  brokerageId: string
  firstName: string
  lastName: string
  email: string
  role: 'admin' | 'primary_admin'
}): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@/lib/actions/brokerage-admin-actions' as any)
    if (typeof mod.inviteBrokerageAdmin === 'function') {
      return mod.inviteBrokerageAdmin(payload)
    }
  } catch {}
  // Fallback to the long-standing legacy helper that takes fullName + email.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy: any = await import('@/lib/actions/admin-actions')
  return legacy.inviteBrokerageAdmin({
    brokerageId: payload.brokerageId,
    fullName: `${payload.firstName} ${payload.lastName}`.trim(),
    email: payload.email,
  })
}

async function callRemoveBrokerageAdmin(payload: {
  brokerageId: string
  userId: string
}): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@/lib/actions/brokerage-admin-actions' as any)
    if (typeof mod.removeBrokerageAdmin === 'function') {
      return mod.removeBrokerageAdmin(payload)
    }
  } catch {}
  return {
    success: false,
    error:
      'removeBrokerageAdmin server action is not deployed yet. Ask Bud to ship the brokerage-admin-actions module.',
  }
}

// ============================================================================
// Types
// ============================================================================

export interface BrokerageAdminRow {
  id: string
  user_id: string
  brokerage_id: string
  role: 'admin' | 'primary_admin'
  full_name: string | null
  email: string | null
  invited_at: string | null
  accepted_at: string | null
}

// ============================================================================
// Component
// ============================================================================

export function BrokerageAdminsPanel({
  brokerageId,
  brokerageName,
}: {
  brokerageId: string
  brokerageName: string
}) {
  const router = useRouter()
  const [admins, setAdmins] = useState<BrokerageAdminRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const [inviting, setInviting] = useState(false)
  const [removingUserId, setRemovingUserId] = useState<string | null>(null)

  // Invite modal state
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteFirst, setInviteFirst] = useState('')
  const [inviteLast, setInviteLast] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'primary_admin'>('admin')
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Remove confirmation state
  const [removeTarget, setRemoveTarget] = useState<BrokerageAdminRow | null>(null)

  const loadAdmins = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await callListBrokerageAdmins(brokerageId)
      if (!result?.success) {
        setError(result?.error || 'Could not load admins.')
        setAdmins([])
        return
      }
      setAdmins((result.data ?? []) as BrokerageAdminRow[])
    } catch (err: any) {
      setError(err?.message || 'Unexpected error loading admins.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAdmins()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerageId])

  const primaryCount = admins.filter(a => a.role === 'primary_admin').length

  const submitInvite = async () => {
    if (!inviteFirst.trim() || !inviteLast.trim() || !inviteEmail.trim()) {
      setInviteError('First name, last name, and email are all required.')
      return
    }
    const emailOk = /\S+@\S+\.\S+/.test(inviteEmail)
    if (!emailOk) {
      setInviteError('Enter a valid email address.')
      return
    }

    setInviting(true)
    setInviteError(null)
    try {
      const result = await callInviteBrokerageAdmin({
        brokerageId,
        firstName: inviteFirst.trim(),
        lastName: inviteLast.trim(),
        email: inviteEmail.trim(),
        role: inviteRole,
      })
      if (!result?.success) {
        setInviteError(result?.error || 'Could not invite admin.')
        return
      }
      toast.success('Invite sent', {
        description: `Magic-link invite emailed to ${inviteEmail}.`,
      })
      setInviteOpen(false)
      setInviteFirst('')
      setInviteLast('')
      setInviteEmail('')
      setInviteRole('admin')
      startTransition(() => loadAdmins())
      router.refresh()
    } catch (err: any) {
      setInviteError(err?.message || 'Unexpected error')
    } finally {
      setInviting(false)
    }
  }

  const submitRemove = async () => {
    if (!removeTarget) return
    setRemovingUserId(removeTarget.user_id)
    try {
      const result = await callRemoveBrokerageAdmin({
        brokerageId,
        userId: removeTarget.user_id,
      })
      if (!result?.success) {
        toast.error(result?.error || 'Could not remove admin')
        return
      }
      toast.success('Admin removed', {
        description: `${removeTarget.full_name ?? removeTarget.email} no longer has access.`,
      })
      setRemoveTarget(null)
      await loadAdmins()
    } finally {
      setRemovingUserId(null)
    }
  }

  // Warning when removing the LAST primary admin — surfaced in the confirm
  // dialog so the operator has a chance to bail or promote someone else first.
  const isRemovingLastPrimary =
    removeTarget?.role === 'primary_admin' && primaryCount <= 1

  return (
    <Card className="border-border/40 bg-card">
      <CardHeader className="py-4 px-5 border-b border-border/40 flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Users size={16} className="text-primary" />
          Brokerage Admins
          <span className="text-xs font-normal text-muted-foreground/60 tabular-nums">
            {admins.length}
          </span>
        </CardTitle>
        <Button
          size="sm"
          onClick={() => setInviteOpen(true)}
          className="gap-1.5"
        >
          <Plus size={14} aria-hidden="true" />
          Invite admin
        </Button>
      </CardHeader>

      <CardContent className="p-0">
        {loading ? (
          <div className="p-6">
            <p className="text-sm text-muted-foreground">Loading admins...</p>
          </div>
        ) : error ? (
          <div
            role="alert"
            className="m-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        ) : admins.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No admins yet"
            description="This brokerage doesn&apos;t have any admins on file. Invite the BoR or office manager so they can submit advance requests on behalf of agents."
            action={
              <Button onClick={() => setInviteOpen(true)} size="sm" className="gap-1.5">
                <Plus size={14} aria-hidden="true" />
                Invite admin
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border/40">
            {admins.map(admin => (
              <li
                key={admin.id}
                className="flex items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {admin.full_name || admin.email || 'Unknown'}
                    </p>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px] uppercase tracking-wider',
                        admin.role === 'primary_admin'
                          ? 'border-primary/40 text-primary bg-primary/5'
                          : 'border-border/40 text-muted-foreground',
                      )}
                    >
                      {admin.role === 'primary_admin' ? (
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck size={10} aria-hidden="true" />
                          Primary
                        </span>
                      ) : (
                        'Admin'
                      )}
                    </Badge>
                    {!admin.accepted_at ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase tracking-wider border-amber-500/40 text-amber-300 bg-amber-500/5"
                      >
                        Invite pending
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {admin.email || 'No email on file'}
                  </p>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    {admin.invited_at
                      ? `Invited ${formatDate(admin.invited_at)}`
                      : ''}
                    {admin.invited_at && admin.accepted_at ? ' · ' : ''}
                    {admin.accepted_at
                      ? `Accepted ${formatDate(admin.accepted_at)}`
                      : admin.invited_at
                        ? ' · awaiting acceptance'
                        : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRemoveTarget(admin)}
                  disabled={removingUserId === admin.user_id}
                  className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                  aria-label={`Remove ${admin.full_name ?? admin.email ?? 'admin'}`}
                >
                  {removingUserId === admin.user_id ? (
                    <>
                      <LoadingSpinner label="" />
                      Removing...
                    </>
                  ) : (
                    <>
                      <Trash2 size={14} aria-hidden="true" />
                      Remove
                    </>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Invite dialog */}
      <Dialog
        open={inviteOpen}
        onOpenChange={o => {
          if (!inviting) setInviteOpen(o)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail size={16} aria-hidden="true" />
              Invite admin to {brokerageName}
            </DialogTitle>
            <DialogDescription>
              They&apos;ll receive a magic-link email and can set their own password
              when they first sign in.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="invite-first" className="text-xs">
                  First name
                </Label>
                <Input
                  id="invite-first"
                  value={inviteFirst}
                  onChange={e => setInviteFirst(e.target.value)}
                  autoComplete="given-name"
                  className="mt-1.5"
                  required
                  aria-required="true"
                />
              </div>
              <div>
                <Label htmlFor="invite-last" className="text-xs">
                  Last name
                </Label>
                <Input
                  id="invite-last"
                  value={inviteLast}
                  onChange={e => setInviteLast(e.target.value)}
                  autoComplete="family-name"
                  className="mt-1.5"
                  required
                  aria-required="true"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="invite-email" className="text-xs">
                Email
              </Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                autoComplete="email"
                placeholder="admin@brokerage.ca"
                className="mt-1.5"
                required
                aria-required="true"
              />
            </div>
            <div>
              <Label htmlFor="invite-role" className="text-xs">
                Role
              </Label>
              <Select
                value={inviteRole}
                onValueChange={v => setInviteRole(v as typeof inviteRole)}
              >
                <SelectTrigger id="invite-role" className="w-full mt-1.5">
                  <SelectValue placeholder="Pick a role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="primary_admin">Primary admin</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Primary admins are the brokerage&apos;s designated point of
                contact and can manage the rest of the pool.
              </p>
            </div>

            {inviteError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {inviteError}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInviteOpen(false)}
              disabled={inviting}
            >
              Cancel
            </Button>
            <Button
              onClick={submitInvite}
              disabled={inviting}
              className="gap-1.5"
            >
              {inviting ? (
                <>
                  <LoadingSpinner label="" />
                  Sending invite...
                </>
              ) : (
                <>
                  <Mail size={14} aria-hidden="true" />
                  Send invite
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <Dialog
        open={!!removeTarget}
        onOpenChange={o => {
          if (!removingUserId) {
            if (!o) setRemoveTarget(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Remove {removeTarget?.full_name ?? removeTarget?.email ?? 'admin'}?
            </DialogTitle>
            <DialogDescription>
              They&apos;ll lose access to {brokerageName} immediately. You can re-invite
              them later if needed.
            </DialogDescription>
          </DialogHeader>

          {isRemovingLastPrimary ? (
            <div
              role="alert"
              className="rounded-lg border-2 border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-start gap-2"
            >
              <X size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">
                  This is the only primary admin.
                </p>
                <p className="mt-0.5">
                  Removing them leaves the brokerage with no primary contact. Promote another admin to primary first.
                </p>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={!!removingUserId}
            >
              Cancel
            </Button>
            <Button
              onClick={submitRemove}
              disabled={!!removingUserId || isRemovingLastPrimary}
              className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removingUserId ? (
                <>
                  <LoadingSpinner label="" />
                  Removing...
                </>
              ) : (
                <>
                  <Trash2 size={14} aria-hidden="true" />
                  Confirm remove
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
