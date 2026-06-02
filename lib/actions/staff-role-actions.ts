'use server'

// ============================================================================
// Staff role management (least-privilege internal roles — migration 102).
// Owner-only: list internal staff, change a staffer's tier, invite new staff.
// Every export is gated by the 'roles.manage' capability (Owner only).
// ============================================================================

import crypto from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedCapable } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import { sendPasswordResetNotification } from '@/lib/email'
import { STAFF_ROLE_LABELS } from '@/lib/access'
import type { StaffRole } from '@/types/database'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionResult = { success: boolean; error?: string; data?: any }

const VALID_STAFF_ROLES: readonly StaffRole[] = ['owner', 'manager', 'staff']

function isValidStaffRole(value: string): value is StaffRole {
  return (VALID_STAFF_ROLES as readonly string[]).includes(value)
}

// ----------------------------------------------------------------------------
// List every internal staff account (super_admin + firm_funds_admin) + tier.
// ----------------------------------------------------------------------------
export async function listInternalStaff(): Promise<ActionResult> {
  const { error: authErr } = await getAuthenticatedCapable('roles.manage')
  if (authErr) return { success: false, error: authErr }

  const serviceClient = createServiceRoleClient()
  const { data, error } = await serviceClient
    .from('user_profiles')
    .select('id, email, full_name, role, staff_role, is_active, last_login')
    .in('role', ['super_admin', 'firm_funds_admin'])
    .order('full_name', { ascending: true })

  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
}

// ----------------------------------------------------------------------------
// Change a staffer's tier. staff_role is authoritative; super_admin always
// resolves to owner, so demoting a super_admin also drops their role to
// firm_funds_admin (still internal, still full dashboard read access).
// ----------------------------------------------------------------------------
export async function setStaffRole(input: {
  userId: string
  staffRole: StaffRole
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('roles.manage')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.userId || !isValidStaffRole(input.staffRole)) {
    return { success: false, error: 'Invalid request' }
  }

  const serviceClient = createServiceRoleClient()

  const { data: target, error: loadErr } = await serviceClient
    .from('user_profiles')
    .select('id, email, full_name, role, staff_role')
    .eq('id', input.userId)
    .single()
  if (loadErr || !target) return { success: false, error: 'User not found' }

  if (target.role !== 'super_admin' && target.role !== 'firm_funds_admin') {
    return { success: false, error: 'Only internal staff can be assigned a tier.' }
  }

  // Last-owner guard: never let the org be left with zero Owners.
  const currentTier: StaffRole =
    target.role === 'super_admin' ? 'owner' : ((target.staff_role as StaffRole | null) ?? 'manager')
  if (currentTier === 'owner' && input.staffRole !== 'owner') {
    const { data: owners } = await serviceClient
      .from('user_profiles')
      .select('id, role, staff_role')
      .in('role', ['super_admin', 'firm_funds_admin'])
    const ownerCount = (owners || []).filter(
      (o) => o.role === 'super_admin' || o.staff_role === 'owner',
    ).length
    if (ownerCount <= 1) {
      return {
        success: false,
        error: 'You cannot remove the last Owner. Promote someone else to Owner first.',
      }
    }
  }

  // Owner tier keeps the existing role (a super_admin stays super_admin). Manager
  // and General Staff are firm_funds_admin so super_admin can't override the tier.
  const newRole = input.staffRole === 'owner' ? target.role : 'firm_funds_admin'

  const { error: updateErr } = await serviceClient
    .from('user_profiles')
    .update({ role: newRole, staff_role: input.staffRole })
    .eq('id', input.userId)

  if (updateErr) return { success: false, error: `Failed to update tier: ${updateErr.message}` }

  await logAuditEvent({
    action: 'staff.set_role',
    entityType: 'user',
    entityId: input.userId,
    severity: 'critical',
    oldValue: { role: target.role, staff_role: target.staff_role },
    newValue: { role: newRole, staff_role: input.staffRole },
    metadata: {
      target_email: target.email,
      target_name: target.full_name,
      changed_by: user.id,
    },
  })

  return { success: true, data: { userId: input.userId, staffRole: input.staffRole } }
}

// ----------------------------------------------------------------------------
// Invite a brand-new internal staff member at a chosen tier. Mirrors the
// agent/brokerage invite flow: create the auth login, seed the profile, mint a
// single-use invite token, and email a set-password link.
// ----------------------------------------------------------------------------
export async function inviteStaffMember(input: {
  email: string
  fullName: string
  staffRole: StaffRole
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('roles.manage')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const email = input.email.trim().toLowerCase()
  const fullName = input.fullName.trim()
  if (!email || !fullName) return { success: false, error: 'Name and email are required' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, error: 'Enter a valid email' }
  if (!isValidStaffRole(input.staffRole)) return { success: false, error: 'Invalid tier' }

  const serviceClient = createServiceRoleClient()

  // Guard against inviting an email that already has a login.
  const { data: existing } = await serviceClient
    .from('user_profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle()
  if (existing) return { success: false, error: 'A user with this email already exists.' }

  // Random temp password (the invitee never sees it; they set their own via the
  // emailed link). Mixed character classes satisfy Supabase password policy.
  const tempPassword = crypto.randomBytes(24).toString('base64url') + 'Aa1!'

  const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  })
  if (signUpError) return { success: false, error: `Failed to create staff login: ${signUpError.message}` }
  if (!authData.user) return { success: false, error: 'User creation returned no user object' }

  const { error: profileError } = await serviceClient.from('user_profiles').insert({
    id: authData.user.id,
    email,
    role: 'firm_funds_admin',
    staff_role: input.staffRole,
    full_name: fullName,
    is_active: true,
    must_reset_password: true,
  })
  if (profileError) {
    // Roll back the orphaned auth user so a retry can reuse the email.
    await serviceClient.auth.admin.deleteUser(authData.user.id).catch(() => {})
    return { success: false, error: `Login created but profile failed: ${profileError.message}` }
  }

  await serviceClient.auth.admin.updateUserById(authData.user.id, {
    user_metadata: { password_changed: false },
  })

  const inviteToken = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
  await serviceClient.from('invite_tokens').insert({
    token: inviteToken,
    user_id: authData.user.id,
    email,
    expires_at: expiresAt,
  })

  await sendPasswordResetNotification({
    recipientName: fullName.split(' ')[0] || 'there',
    recipientEmail: email,
    inviteToken,
    roleName: STAFF_ROLE_LABELS[input.staffRole],
    brokerageId: null,
    agentId: null,
  })

  await logAuditEvent({
    action: 'staff.invite',
    entityType: 'user',
    entityId: authData.user.id,
    severity: 'critical',
    metadata: {
      email,
      full_name: fullName,
      staff_role: input.staffRole,
      invited_by: user.id,
    },
  })

  return { success: true, data: { userId: authData.user.id } }
}
