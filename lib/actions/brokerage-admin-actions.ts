'use server'

// ============================================================================
// Brokerage Admin pool (multi-admin support)
// ============================================================================
// Server actions for managing the brokerage_admins junction table introduced
// in migration 087. The junction table lets a single brokerage have multiple
// admin user accounts, each with a role of 'admin' or 'primary_admin'. Only
// primary_admins (and Firm Funds super_admin/firm_funds_admin) can invite or
// remove other admins.
//
// NAMING NOTE:
//   `inviteBrokerageAdmin` here is the NEW multi-admin path. The legacy
//   `inviteBrokerageAdmin` in lib/actions/admin-actions.ts predates the
//   junction table — it also creates an auth user + user_profile and seeds
//   the brokerage_admins row. The two functions share the same name across
//   different modules so callers should be explicit about which one they
//   import. New UI should prefer this file's export; legacy import sites in
//   the admin console are unchanged.
// ============================================================================

import crypto from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedAdmin, getAuthenticatedUser } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import { sendBrokerageInviteNotification } from '@/lib/email'

// ============================================================================
// Types
// ============================================================================

interface ActionResult<T = unknown> {
  success: boolean
  error?: string
  data?: T
}

export type BrokerageAdminRole = 'admin' | 'primary_admin'

export interface BrokerageAdmin {
  id: string
  brokerage_id: string
  user_id: string
  role: BrokerageAdminRole
  invited_at: string | null
  accepted_at: string | null
  created_by: string | null
  // Joined from user_profiles
  full_name?: string | null
  email?: string | null
}

// ============================================================================
// Internal: validate caller can manage admins for a brokerage. Firm Funds
// super_admin/firm_funds_admin can always manage; brokerage_admin can manage
// only if they are a primary_admin of the target brokerage in the pool.
// Returns { ok, callerUserId, viaFirmFunds } or { ok:false, error }.
// ============================================================================
async function authorizeAdminManager(
  brokerageId: string,
): Promise<
  | { ok: true; callerUserId: string; viaFirmFunds: boolean }
  | { ok: false; error: string }
> {
  // Try FF admin first — most common caller. If user is FF admin, no further
  // checks required.
  const ffAttempt = await getAuthenticatedAdmin()
  if (!ffAttempt.error && ffAttempt.user) {
    return { ok: true, callerUserId: ffAttempt.user.id, viaFirmFunds: true }
  }

  // Not a FF admin — check brokerage_admin path. authorizeAdminManager is
  // called from server actions, so we re-derive the caller via the broader
  // user helper.
  const callerAttempt = await getAuthenticatedUser([
    'brokerage_admin',
    'super_admin',
    'firm_funds_admin',
  ])
  if (callerAttempt.error || !callerAttempt.user || !callerAttempt.profile) {
    return { ok: false, error: callerAttempt.error || 'Authentication failed' }
  }

  const profile = callerAttempt.profile
  if (profile.role === 'super_admin' || profile.role === 'firm_funds_admin') {
    return { ok: true, callerUserId: callerAttempt.user.id, viaFirmFunds: true }
  }

  // brokerage_admin path: must be primary_admin of THIS brokerage.
  const serviceClient = createServiceRoleClient()
  const { data: poolRow, error: poolErr } = await serviceClient
    .from('brokerage_admins')
    .select('id, role')
    .eq('brokerage_id', brokerageId)
    .eq('user_id', callerAttempt.user.id)
    .maybeSingle()

  if (poolErr) {
    return { ok: false, error: `Failed to verify admin membership: ${poolErr.message}` }
  }
  if (!poolRow) {
    return { ok: false, error: 'You are not an admin of this brokerage' }
  }
  if (poolRow.role !== 'primary_admin') {
    return {
      ok: false,
      error: 'Only a primary admin can manage other brokerage admins',
    }
  }

  return { ok: true, callerUserId: callerAttempt.user.id, viaFirmFunds: false }
}

// ============================================================================
// inviteBrokerageAdmin — add a new admin to a brokerage's pool.
//
// Caller must be a Firm Funds admin OR a primary_admin of the target
// brokerage. Creates the auth user + user_profile (mirroring the legacy flow
// in admin-actions.ts) and inserts the brokerage_admins junction row.
// Sends the standard branded magic-link invite email.
// ============================================================================
export async function inviteBrokerageAdmin(input: {
  brokerageId: string
  email: string
  firstName: string
  lastName: string
  role?: BrokerageAdminRole
}): Promise<ActionResult<{ admin_id: string }>> {
  if (!input.brokerageId) return { success: false, error: 'Brokerage ID is required' }
  if (!input.email?.trim()) return { success: false, error: 'Email is required' }
  if (!input.firstName?.trim()) return { success: false, error: 'First name is required' }
  if (!input.lastName?.trim()) return { success: false, error: 'Last name is required' }

  const auth = await authorizeAdminManager(input.brokerageId)
  if (!auth.ok) return { success: false, error: auth.error }

  const role: BrokerageAdminRole = input.role || 'admin'
  if (role !== 'admin' && role !== 'primary_admin') {
    return { success: false, error: 'Invalid role — must be admin or primary_admin' }
  }

  const email = input.email.trim().toLowerCase()
  const firstName = input.firstName.trim()
  const lastName = input.lastName.trim()
  const fullName = `${firstName} ${lastName}`

  const serviceClient = createServiceRoleClient()

  try {
    // Verify brokerage exists
    const { data: brokerage } = await serviceClient
      .from('brokerages')
      .select('id, name')
      .eq('id', input.brokerageId)
      .single()
    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    // Check if this email already has a user_profile that's a brokerage_admin
    // for THIS brokerage — duplicate prevention.
    const { data: existingProfile } = await serviceClient
      .from('user_profiles')
      .select('id, role, brokerage_id')
      .eq('email', email)
      .maybeSingle()

    let authUserId: string

    if (existingProfile) {
      // Profile exists. If they're already an admin of this brokerage in the
      // pool, reject. Otherwise reuse the auth user and add to the pool.
      if (existingProfile.role !== 'brokerage_admin') {
        return {
          success: false,
          error: 'A user with this email exists but is not a brokerage admin role',
        }
      }
      const { data: poolRow } = await serviceClient
        .from('brokerage_admins')
        .select('id')
        .eq('brokerage_id', input.brokerageId)
        .eq('user_id', existingProfile.id)
        .maybeSingle()
      if (poolRow) {
        return { success: false, error: 'This user is already an admin of this brokerage' }
      }
      authUserId = existingProfile.id
    } else {
      // No profile yet — create auth user + profile (mirrors the legacy
      // pattern in admin-actions.ts inviteBrokerageAdmin).
      const tempPassword = crypto.randomBytes(18).toString('base64').slice(0, 18) + 'A1!'

      let { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
      })

      if (signUpError && signUpError.message?.includes('already been registered')) {
        // Orphaned auth user from a prior cleanup — list and delete by email.
        const { data: { users = [] } = {} } =
          await serviceClient.auth.admin.listUsers({ page: 1, perPage: 1000 })
        const match = users.find((u: { id: string; email?: string }) => u.email === email)
        if (match) {
          try {
            await serviceClient.auth.admin.deleteUser(match.id)
          } catch (delErr: unknown) {
            const _msg = delErr instanceof Error ? delErr.message : "Unknown error"
            console.error('[inviteBrokerageAdmin] orphan delete failed:', _msg)
          }
        }
        const retry = await serviceClient.auth.admin.createUser({
          email,
          password: tempPassword,
          email_confirm: true,
        })
        if (retry.error || !retry.data?.user) {
          return {
            success: false,
            error: `Failed to create login on retry: ${retry.error?.message || 'Unknown error'}`,
          }
        }
        authData = retry.data
        signUpError = retry.error
      }

      if (signUpError || !authData?.user) {
        return {
          success: false,
          error: `Failed to create login: ${signUpError?.message || 'Unknown error'}`,
        }
      }

      authUserId = authData.user.id

      const { error: profileError } = await serviceClient
        .from('user_profiles')
        .insert({
          id: authUserId,
          email,
          role: 'brokerage_admin',
          full_name: fullName,
          brokerage_id: input.brokerageId,
          is_active: true,
          must_reset_password: true,
        })

      if (profileError) {
        console.error('[inviteBrokerageAdmin] profile insert error:', profileError.message)
        return {
          success: false,
          error: `Login created but profile failed: ${profileError.message}`,
        }
      }
    }

    // Insert the junction row. If this is the first admin in the pool,
    // promote them to primary_admin regardless of the requested role.
    const { count: existingPoolCount } = await serviceClient
      .from('brokerage_admins')
      .select('*', { count: 'exact', head: true })
      .eq('brokerage_id', input.brokerageId)

    const finalRole: BrokerageAdminRole =
      existingPoolCount && existingPoolCount > 0 ? role : 'primary_admin'

    const { data: junction, error: junctionErr } = await serviceClient
      .from('brokerage_admins')
      .insert({
        brokerage_id: input.brokerageId,
        user_id: authUserId,
        role: finalRole,
        invited_at: new Date().toISOString(),
        created_by: auth.callerUserId,
      })
      .select('id')
      .single()

    if (junctionErr || !junction) {
      console.error('[inviteBrokerageAdmin] junction insert error:', junctionErr?.message)
      return {
        success: false,
        error: `Login created but junction insert failed: ${junctionErr?.message || 'unknown'}`,
      }
    }

    // Magic-link invite token (72h)
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
    await serviceClient
      .from('invite_tokens')
      .insert({
        token: inviteToken,
        user_id: authUserId,
        email,
        expires_at: expiresAt,
      })

    // Branded invite email — reuse the existing brokerage admin template.
    await sendBrokerageInviteNotification({
      adminName: firstName,
      adminEmail: email,
      brokerageName: brokerage.name,
      inviteToken,
    })

    await logAuditEvent({
      action: 'brokerage_admin.pool_invite',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: {
        brokerage_name: brokerage.name,
        invited_email: email,
        invited_name: fullName,
        role: finalRole,
        invited_by_user_id: auth.callerUserId,
        invited_via: auth.viaFirmFunds ? 'firm_funds_admin' : 'primary_admin',
        admin_id: junction.id,
      },
    })

    return { success: true, data: { admin_id: junction.id } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('inviteBrokerageAdmin error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// removeBrokerageAdmin — remove an admin from a brokerage's pool.
//
// Cannot remove the last primary_admin (there must always be at least one).
// If the user is on no other brokerages after removal, also delete the auth
// user + user_profile to free the email. Otherwise leave the auth user in
// place so they can keep their other brokerage memberships.
// ============================================================================
export async function removeBrokerageAdmin(input: {
  brokerageAdminId: string
}): Promise<ActionResult> {
  if (!input.brokerageAdminId) {
    return { success: false, error: 'brokerageAdminId is required' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    // Load the row first so we know which brokerage to authorize against.
    const { data: row, error: rowErr } = await serviceClient
      .from('brokerage_admins')
      .select('id, brokerage_id, user_id, role')
      .eq('id', input.brokerageAdminId)
      .single()

    if (rowErr || !row) return { success: false, error: 'Brokerage admin row not found' }

    const auth = await authorizeAdminManager(row.brokerage_id)
    if (!auth.ok) return { success: false, error: auth.error }

    // If this is a primary_admin, ensure another primary_admin exists.
    if (row.role === 'primary_admin') {
      const { count: primaryCount } = await serviceClient
        .from('brokerage_admins')
        .select('*', { count: 'exact', head: true })
        .eq('brokerage_id', row.brokerage_id)
        .eq('role', 'primary_admin')

      if (!primaryCount || primaryCount <= 1) {
        return {
          success: false,
          error: 'Cannot remove the last primary admin. Promote another admin first.',
        }
      }
    }

    // Delete the junction row.
    const { error: delErr } = await serviceClient
      .from('brokerage_admins')
      .delete()
      .eq('id', row.id)

    if (delErr) {
      return { success: false, error: `Failed to remove admin: ${delErr.message}` }
    }

    // Check if the user is on any other brokerage. If not, deactivate their
    // user_profile + delete the auth user so the email is freed. Non-fatal:
    // if any of these fail we still report success because the junction row
    // is already gone.
    const { count: remainingMemberships } = await serviceClient
      .from('brokerage_admins')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', row.user_id)

    let authDeleted = false
    let profileDeactivated = false
    if (!remainingMemberships || remainingMemberships === 0) {
      await serviceClient
        .from('user_profiles')
        .update({ is_active: false })
        .eq('id', row.user_id)
      profileDeactivated = true

      try {
        await serviceClient.auth.admin.deleteUser(row.user_id)
        authDeleted = true
      } catch (authErr: unknown) {
        const authMessage = authErr instanceof Error ? authErr.message : 'Unknown error'
        console.warn('[removeBrokerageAdmin] auth delete non-fatal:', authMessage)
      }
    }

    await logAuditEvent({
      action: 'brokerage_admin.pool_remove',
      entityType: 'brokerage',
      entityId: row.brokerage_id,
      severity: 'warning',
      metadata: {
        brokerage_admin_id: row.id,
        removed_user_id: row.user_id,
        removed_role: row.role,
        removed_by_user_id: auth.callerUserId,
        removed_via: auth.viaFirmFunds ? 'firm_funds_admin' : 'primary_admin',
        remaining_memberships: remainingMemberships || 0,
        profile_deactivated: profileDeactivated,
        auth_deleted: authDeleted,
      },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('removeBrokerageAdmin error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// listBrokerageAdmins — return the pool for a brokerage with joined profile
// fields. Any FF admin or any admin in the pool can read the list.
// ============================================================================
export async function listBrokerageAdmins(
  brokerageId: string,
): Promise<ActionResult<BrokerageAdmin[]>> {
  if (!brokerageId) return { success: false, error: 'brokerageId is required' }

  // Read-side authorization: FF admin OR any admin in this pool.
  const callerAttempt = await getAuthenticatedUser([
    'brokerage_admin',
    'super_admin',
    'firm_funds_admin',
  ])
  if (callerAttempt.error || !callerAttempt.user || !callerAttempt.profile) {
    return { success: false, error: callerAttempt.error || 'Authentication failed' }
  }

  const serviceClient = createServiceRoleClient()
  const profile = callerAttempt.profile
  const isFf = profile.role === 'super_admin' || profile.role === 'firm_funds_admin'

  if (!isFf) {
    // Brokerage admin must be in the pool for THIS brokerage to read it.
    const { data: poolRow } = await serviceClient
      .from('brokerage_admins')
      .select('id')
      .eq('brokerage_id', brokerageId)
      .eq('user_id', callerAttempt.user.id)
      .maybeSingle()
    if (!poolRow) return { success: false, error: 'You are not an admin of this brokerage' }
  }

  try {
    const { data, error } = await serviceClient
      .from('brokerage_admins')
      .select('id, brokerage_id, user_id, role, invited_at, accepted_at, created_by')
      .eq('brokerage_id', brokerageId)
      .order('invited_at', { ascending: true, nullsFirst: false })

    if (error) return { success: false, error: error.message }

    // Resolve user_profiles for each row in a single query
    const userIds = (data || []).map((r) => r.user_id)
    if (userIds.length === 0) return { success: true, data: [] }

    const { data: profiles } = await serviceClient
      .from('user_profiles')
      .select('id, full_name, email')
      .in('id', userIds)

    const profilesById = new Map((profiles || []).map((p) => [p.id, p]))

    const rows: BrokerageAdmin[] = (data || []).map((r) => {
      const p = profilesById.get(r.user_id)
      return {
        id: r.id,
        brokerage_id: r.brokerage_id,
        user_id: r.user_id,
        role: r.role as BrokerageAdminRole,
        invited_at: r.invited_at,
        accepted_at: r.accepted_at,
        created_by: r.created_by,
        full_name: p?.full_name ?? null,
        email: p?.email ?? null,
      }
    })

    return { success: true, data: rows }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('listBrokerageAdmins error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// acceptBrokerageAdminInvite — validate a magic-link token, set the admin's
// password, and stamp accepted_at on their brokerage_admins row.
//
// Mirrors the security model in app/api/magic-link/route.ts PUT: same
// password rules, same atomic CAS on used_at to prevent token replay.
// ============================================================================
export async function acceptBrokerageAdminInvite(input: {
  token: string
  password: string
}): Promise<ActionResult> {
  if (!input.token) return { success: false, error: 'Token is required' }
  if (!input.password) return { success: false, error: 'Password is required' }

  // Password strength check — match the magic-link PUT route.
  const password = input.password
  const hasUpper = /[A-Z]/.test(password)
  const hasLower = /[a-z]/.test(password)
  const hasNumber = /\d/.test(password)
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)
  if (password.length < 12 || !hasUpper || !hasLower || !hasNumber || !hasSpecial) {
    return {
      success: false,
      error: 'Password must be at least 12 characters with uppercase, lowercase, number, and special character.',
    }
  }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: tokenRecord, error: tokenError } = await serviceClient
      .from('invite_tokens')
      .select('id, user_id, email, expires_at, used_at')
      .eq('token', input.token)
      .single()

    if (tokenError || !tokenRecord) {
      return { success: false, error: 'Invalid or expired invite link.' }
    }
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return { success: false, error: 'This invite link has expired.' }
    }

    // Atomic CAS on used_at — prevent replay if two tabs submit at once.
    const { data: claimed } = await serviceClient
      .from('invite_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', tokenRecord.id)
      .is('used_at', null)
      .select()
      .maybeSingle()
    if (!claimed) {
      return { success: false, error: 'This invite link has already been used.' }
    }

    // Set password via admin API.
    const { error: pwError } = await serviceClient.auth.admin.updateUserById(
      tokenRecord.user_id,
      {
        password,
        user_metadata: { password_changed: true },
      },
    )
    if (pwError) {
      return { success: false, error: `Failed to set password: ${pwError.message}` }
    }

    // Clear must_reset_password and stamp accepted_at on every pool row for
    // this user (an admin may sit in more than one brokerage's pool).
    await serviceClient
      .from('user_profiles')
      .update({ must_reset_password: false })
      .eq('id', tokenRecord.user_id)

    await serviceClient
      .from('brokerage_admins')
      .update({ accepted_at: new Date().toISOString() })
      .eq('user_id', tokenRecord.user_id)
      .is('accepted_at', null)

    await logAuditEvent({
      action: 'brokerage_admin.invite_accepted',
      entityType: 'user',
      entityId: tokenRecord.user_id,
      metadata: {
        email: tokenRecord.email,
        accepted_via: 'magic_link',
      },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('acceptBrokerageAdminInvite error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}
