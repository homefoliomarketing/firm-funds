'use server'

// ============================================================================
// Underwriter Assignment
// ============================================================================
// Queue-style underwriter ownership for the admin deal pipeline. Backed by
// the migration 083 columns:
//   deals.assigned_to_user_id (nullable, references auth.users.id)
//   deals.version             (bumped by trg_deals_bump_version on every UPDATE)
//
// All actions here require a Firm Funds admin role. Assignment writes are
// optimistic-locked on deals.version so two admins clicking "Assign" at the
// same time don't silently overwrite each other.
//
// Overdue tracking uses the dedicated `deals.assigned_at` column (migration
// 100): assignDealToUnderwriter stamps it on assign and clears it on unassign,
// so an unrelated edit to the deal no longer resets the "how long has this been
// sitting" clock.
// ============================================================================

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedAdmin, getAuthenticatedCapable } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import type { Deal } from '@/types/database'

interface ActionResult<T = unknown> {
  success: boolean
  error?: string
  data?: T
}

// Select set used by all assignment queries. Keep this DRY — page components
// can rely on the same shape coming back.
const ASSIGNMENT_DEAL_SELECT = `
  id,
  status,
  property_address,
  closing_date,
  due_date,
  gross_commission,
  advance_amount,
  agent_id,
  brokerage_id,
  assigned_to_user_id,
  assigned_at,
  version,
  created_at,
  updated_at,
  agents:agent_id ( first_name, last_name ),
  brokerages:brokerage_id ( id, name )
`

// ============================================================================
// assignDealToUnderwriter — set or clear deals.assigned_to_user_id.
//
// Pass underwriterUserId = null to unassign. Pass expectedVersion (the
// deals.version value the caller READ) to optimistic-lock the write — if
// another admin has touched the deal in between, the CAS misses and we
// surface a conflict instead of silently clobbering their edit.
// ============================================================================
export async function assignDealToUnderwriter(input: {
  dealId: string
  underwriterUserId: string | null // null to unassign
  expectedVersion?: number
}): Promise<ActionResult<{ assigned_to_user_id: string | null; version: number }>> {
  const { error: authErr, user } = await getAuthenticatedCapable('deal.underwrite')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.dealId) return { success: false, error: 'dealId is required' }

  const serviceClient = createServiceRoleClient()

  try {
    // Load deal to verify it exists and capture prior assignee for audit.
    const { data: existing, error: loadErr } = await serviceClient
      .from('deals')
      .select('id, status, assigned_to_user_id, version, property_address')
      .eq('id', input.dealId)
      .single()

    if (loadErr || !existing) return { success: false, error: 'Deal not found' }

    // If unassigning, no further user lookup needed. Otherwise verify the
    // target user is a Firm Funds admin (only FF admins should appear in the
    // queue dropdown — agents/brokerage admins can't underwrite).
    if (input.underwriterUserId) {
      const { data: targetProfile } = await serviceClient
        .from('user_profiles')
        .select('id, role, is_active, full_name')
        .eq('id', input.underwriterUserId)
        .single()
      if (!targetProfile) {
        return { success: false, error: 'Underwriter user not found' }
      }
      if (!targetProfile.is_active) {
        return { success: false, error: 'Underwriter account is deactivated' }
      }
      if (!['super_admin', 'firm_funds_admin'].includes(targetProfile.role)) {
        return {
          success: false,
          error: 'Only Firm Funds admins can be assigned as underwriters',
        }
      }
    }

    // CAS update — pin to the expected version if provided. Without
    // expectedVersion we still write atomically but skip the conflict check.
    let updateQ = serviceClient
      .from('deals')
      .update({
        assigned_to_user_id: input.underwriterUserId,
        // Stamp the assignment time so overdue tracking is not reset by an
        // unrelated edit. Cleared on unassign.
        assigned_at: input.underwriterUserId ? new Date().toISOString() : null,
      })
      .eq('id', input.dealId)

    if (typeof input.expectedVersion === 'number') {
      updateQ = updateQ.eq('version', input.expectedVersion)
    }

    const { data: updated, error: updateErr } = await updateQ
      .select('id, assigned_to_user_id, version')
      .maybeSingle()

    if (updateErr) {
      console.error('assignDealToUnderwriter update error:', updateErr.message)
      return { success: false, error: `Failed to assign: ${updateErr.message}` }
    }
    if (!updated) {
      return {
        success: false,
        error: 'Deal was modified by another session. Refresh and try again.',
      }
    }

    await logAuditEvent({
      action: input.underwriterUserId === null
        ? 'deal.unassigned'
        : 'deal.assigned',
      entityType: 'deal',
      entityId: input.dealId,
      severity: 'info',
      metadata: {
        property_address: existing.property_address,
        prior_assigned_to_user_id: existing.assigned_to_user_id,
        new_assigned_to_user_id: input.underwriterUserId,
        changed_by_user_id: user.id,
        from_version: existing.version,
        to_version: updated.version,
      },
    })

    return {
      success: true,
      data: {
        assigned_to_user_id: updated.assigned_to_user_id ?? null,
        version: updated.version,
      },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('assignDealToUnderwriter error:', _msg)
    return { success: false, error: _msg || 'An unexpected error occurred' }
  }
}

// ============================================================================
// getUnassignedDeals — under_review deals with no underwriter claimed yet.
// Drives the "queue" tab on the admin dashboard.
// ============================================================================
export async function getUnassignedDeals(): Promise<ActionResult<Deal[]>> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()
  try {
    const { data, error } = await serviceClient
      .from('deals')
      .select(ASSIGNMENT_DEAL_SELECT)
      .eq('status', 'under_review')
      .is('assigned_to_user_id', null)
      .order('created_at', { ascending: true })

    if (error) return { success: false, error: error.message }
    return { success: true, data: (data || []) as unknown as Deal[] }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('getUnassignedDeals error:', _msg)
    return { success: false, error: _msg || 'An unexpected error occurred' }
  }
}

// ============================================================================
// getMyAssignedDeals — deals assigned to the CURRENT logged-in FF admin.
// Status filter is broad on purpose: an underwriter owns the deal end-to-end
// from under_review through funded/completed, so all in-flight statuses count.
// ============================================================================
export async function getMyAssignedDeals(): Promise<ActionResult<Deal[]>> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()
  try {
    const { data, error } = await serviceClient
      .from('deals')
      .select(ASSIGNMENT_DEAL_SELECT)
      .eq('assigned_to_user_id', user.id)
      .in('status', ['under_review', 'approved', 'funded', 'failed_to_close', 'funding_failed', 'offered'])
      .order('closing_date', { ascending: true })

    if (error) return { success: false, error: error.message }
    return { success: true, data: (data || []) as unknown as Deal[] }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('getMyAssignedDeals error:', _msg)
    return { success: false, error: _msg || 'An unexpected error occurred' }
  }
}

// ============================================================================
// getOverdueAssignments — deals stuck in under_review for too long.
//
// Two cases, surfaced together as one combined "needs attention" list:
//   (a) assigned_to_user_id IS NULL and the deal has been in under_review
//       since submission (created_at) for > thresholdDays — nobody picked it up.
//   (b) assigned_to_user_id IS NOT NULL and assigned_at is older than
//       thresholdDays — the assignee has owned it for more than N days and the
//       status hasn't progressed past under_review.
//
// Case (b) uses the dedicated assigned_at column (migration 100), so an
// unrelated edit to the deal no longer resets the overdue clock.
// ============================================================================
export async function getOverdueAssignments(
  thresholdDays = 7,
): Promise<ActionResult<Deal[]>> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (typeof thresholdDays !== 'number' || thresholdDays <= 0 || thresholdDays > 365) {
    return { success: false, error: 'thresholdDays must be between 1 and 365' }
  }

  const serviceClient = createServiceRoleClient()
  try {
    const cutoffMs = Date.now() - thresholdDays * 24 * 60 * 60 * 1000
    const cutoffIso = new Date(cutoffMs).toISOString()

    // (a) Unassigned and sitting since submission.
    const { data: unassigned, error: unassignedErr } = await serviceClient
      .from('deals')
      .select(ASSIGNMENT_DEAL_SELECT)
      .eq('status', 'under_review')
      .is('assigned_to_user_id', null)
      .lt('created_at', cutoffIso)

    if (unassignedErr) return { success: false, error: unassignedErr.message }

    // (b) Assigned more than thresholdDays ago and still under review.
    const { data: assignedStale, error: assignedErr } = await serviceClient
      .from('deals')
      .select(ASSIGNMENT_DEAL_SELECT)
      .eq('status', 'under_review')
      .not('assigned_to_user_id', 'is', null)
      .lt('assigned_at', cutoffIso)

    if (assignedErr) return { success: false, error: assignedErr.message }

    const merged = [
      ...((unassigned || []) as unknown as Deal[]),
      ...((assignedStale || []) as unknown as Deal[]),
    ].sort(
      (a, b) =>
        new Date(a.created_at as string).getTime() -
        new Date(b.created_at as string).getTime(),
    )

    return { success: true, data: merged }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('getOverdueAssignments error:', _msg)
    return { success: false, error: _msg || 'An unexpected error occurred' }
  }
}
