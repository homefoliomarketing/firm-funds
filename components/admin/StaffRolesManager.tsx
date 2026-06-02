'use client'

import { useState, useTransition } from 'react'
import { Plus, ShieldCheck, UserCog } from 'lucide-react'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDate } from '@/lib/formatting'
import {
  ASSIGNABLE_STAFF_ROLES,
  STAFF_ROLE_LABELS,
  resolveStaffRole,
} from '@/lib/access'
import { setStaffRole, inviteStaffMember } from '@/lib/actions/staff-role-actions'
import type { StaffRole, UserRole } from '@/types/database'

export interface StaffRow {
  id: string
  email: string | null
  full_name: string | null
  role: UserRole
  staff_role: StaffRole | null
  is_active: boolean
  last_login: string | null
}

const TIER_BLURB: Record<StaffRole, string> = {
  owner: 'Everything: money, brokerage onboarding, deletes, password resets, role assignment, view-as.',
  manager: 'Runs deals, KYC, audit, agent invites, and paperwork. No money, deletes, or brokerage onboarding.',
  staff: 'Read dashboards, message users, and handle document requests. Nothing sensitive.',
}

export function StaffRolesManager({
  initialStaff,
  currentUserId,
}: {
  initialStaff: StaffRow[]
  currentUserId: string
}) {
  const [staff, setStaff] = useState<StaffRow[]>(initialStaff)
  const [pending, startTransition] = useTransition()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteTier, setInviteTier] = useState<StaffRole>('staff')

  function handleTierChange(row: StaffRow, nextTier: StaffRole) {
    const currentTier = resolveStaffRole(row) ?? 'manager'
    if (nextTier === currentTier) return

    startTransition(async () => {
      const result = await setStaffRole({ userId: row.id, staffRole: nextTier })
      if (!result.success) {
        toast.error(result.error || 'Could not change tier')
        return
      }
      setStaff((prev) =>
        prev.map((s) =>
          s.id === row.id
            ? {
                ...s,
                staff_role: nextTier,
                // Owner keeps its role; Manager/Staff are firm_funds_admin.
                role: nextTier === 'owner' ? s.role : 'firm_funds_admin',
              }
            : s,
        ),
      )
      toast.success(`${row.full_name || 'User'} is now ${STAFF_ROLE_LABELS[nextTier]}`)
    })
  }

  function handleInvite() {
    const name = inviteName.trim()
    const email = inviteEmail.trim()
    if (!name || !email) {
      toast.error('Name and email are required')
      return
    }
    startTransition(async () => {
      const result = await inviteStaffMember({ email, fullName: name, staffRole: inviteTier })
      if (!result.success) {
        toast.error(result.error || 'Could not send invite')
        return
      }
      const newId = (result.data as { userId?: string } | undefined)?.userId
      setStaff((prev) => [
        ...prev,
        {
          id: newId || `pending-${email}`,
          email,
          full_name: name,
          role: 'firm_funds_admin',
          staff_role: inviteTier,
          is_active: true,
          last_login: null,
        },
      ])
      toast.success(`Invite sent to ${email} as ${STAFF_ROLE_LABELS[inviteTier]}`)
      setInviteName('')
      setInviteEmail('')
      setInviteTier('staff')
      setInviteOpen(false)
    })
  }

  return (
    <div className="space-y-6">
      {/* What each tier can do */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck size={16} className="text-primary" />
            What each tier can do
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          {ASSIGNABLE_STAFF_ROLES.map((tier) => (
            <div key={tier} className="rounded-lg border border-border/40 bg-background/40 p-3">
              <div className="text-sm font-semibold text-foreground mb-1">{STAFF_ROLE_LABELS[tier]}</div>
              <p className="text-xs text-muted-foreground leading-relaxed">{TIER_BLURB[tier]}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Staff table */}
      <Card className="border-border/40 bg-card/60">
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <UserCog size={16} className="text-primary" />
            Internal staff ({staff.length})
          </CardTitle>
          <Button size="sm" className="gap-1.5" onClick={() => setInviteOpen(true)}>
            <Plus size={14} />
            Invite staff
          </Button>
        </CardHeader>
        <CardContent>
          {staff.length === 0 ? (
            <EmptyState title="No staff yet" description="Invite your first staff member to get started." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Last login</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((row) => {
                  const tier = resolveStaffRole(row) ?? 'manager'
                  const isSelf = row.id === currentUserId
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium text-foreground">
                        {row.full_name || 'Unnamed'}
                        {isSelf && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            You
                          </Badge>
                        )}
                        {!row.is_active && (
                          <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground">
                            Inactive
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.email || 'No email'}</TableCell>
                      <TableCell>
                        <Select
                          value={tier}
                          onValueChange={(v) => handleTierChange(row, v as StaffRole)}
                          disabled={pending}
                        >
                          <SelectTrigger
                            className="w-[150px]"
                            aria-label={`Tier for ${row.full_name || row.email || 'user'}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ASSIGNABLE_STAFF_ROLES.map((t) => (
                              <SelectItem key={t} value={t}>
                                {STAFF_ROLE_LABELS[t]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {row.last_login ? formatDate(row.last_login) : 'Never'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Invite dialog (portaled; open controlled by state) */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a staff member</DialogTitle>
            <DialogDescription>
              They get an email to set their own password. You choose what they can do.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="invite-name">Full name</Label>
              <Input
                id="invite-name"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="Jane Bookkeeper"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="jane@example.com"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-tier">Tier</Label>
              <Select value={inviteTier} onValueChange={(v) => setInviteTier(v as StaffRole)}>
                <SelectTrigger id="invite-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_STAFF_ROLES.map((tier) => (
                    <SelectItem key={tier} value={tier}>
                      {STAFF_ROLE_LABELS[tier]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{TIER_BLURB[inviteTier]}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={pending}>
              {pending ? 'Sending...' : 'Send invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
