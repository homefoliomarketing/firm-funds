'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser, getAuthenticatedCapable } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import { liveFailedDealInterestOwed } from '@/lib/calculations'
import { isInternalAdminRole } from '@/lib/access'
import type { UserProfile, UserRole } from '@/types/database'
import type { SupabaseClient } from '@supabase/supabase-js'

type ActionResult = { success: boolean; error?: string; data?: unknown }

export interface RemediationDealInput {
  failedDealId: string
  propertyAddress: string
  mlsNumber?: string | null
  brokerageId?: string | null
  brokerageLegalName: string
  brokerageAddress?: string | null
  brokerOfRecordName?: string | null
  brokerOfRecordEmail?: string | null
  expectedCommission?: number | null
  expectedClosingDate?: string | null  // YYYY-MM-DD
  expectedPaymentDate?: string | null  // YYYY-MM-DD
  directedAmount: number
  notes?: string | null
}

// ============================================================================
// Tenancy gate — used by create / update / cancel / get to confirm the caller
// is allowed to act on a particular failed deal.
//
// Roles:
//   super_admin / firm_funds_admin → any failed deal
//   brokerage_admin                → failed deal's agent must belong to the
//                                    caller's brokerage_id
//   agent                          → failed deal's agent_id must match the
//                                    caller's linked agent_id
//
// Returns the failed-deal record (with the agent's brokerage_id joined in)
// on success so the caller doesn't refetch.
// ============================================================================

interface FailedDealForAccess {
  id: string
  agent_id: string
  status: string
  cure_election: string | null
  agent_brokerage_id: string | null
}

async function authorizeFailedDealAccess(
  serviceClient: SupabaseClient,
  profile: UserProfile,
  failedDealId: string,
): Promise<{ ok: true; deal: FailedDealForAccess } | { ok: false; error: string }> {
  const { data, error } = await serviceClient
    .from('deals')
    .select('id, agent_id, status, cure_election, agents:agents!deals_agent_id_fkey(id, brokerage_id)')
    .eq('id', failedDealId)
    .single()
  if (error || !data) return { ok: false, error: 'Failed deal not found' }

  // Supabase typings come back as a 1-to-1 array on the join; flatten via unknown.
  const raw = data as unknown as {
    id: string
    agent_id: string
    status: string
    cure_election: string | null
    agents: { id: string; brokerage_id: string | null } | Array<{ id: string; brokerage_id: string | null }> | null
  }
  const joinedAgent = Array.isArray(raw.agents) ? (raw.agents[0] ?? null) : raw.agents

  const deal: FailedDealForAccess = {
    id: raw.id,
    agent_id: raw.agent_id,
    status: raw.status,
    cure_election: raw.cure_election ?? null,
    agent_brokerage_id: joinedAgent?.brokerage_id ?? null,
  }

  if (isInternalAdminRole(profile.role)) {
    return { ok: true, deal }
  }
  if (profile.role === 'brokerage_admin') {
    if (!profile.brokerage_id) {
      return { ok: false, error: 'Your account is not linked to a brokerage' }
    }
    if (deal.agent_brokerage_id !== profile.brokerage_id) {
      return { ok: false, error: 'This failed deal is not in your brokerage' }
    }
    return { ok: true, deal }
  }
  if (profile.role === 'agent') {
    if (!profile.agent_id) {
      return { ok: false, error: 'Your account is not linked to an agent profile' }
    }
    if (deal.agent_id !== profile.agent_id) {
      return { ok: false, error: 'This failed deal does not belong to you' }
    }
    return { ok: true, deal }
  }
  return { ok: false, error: 'Insufficient permissions' }
}

const SUBMIT_ROLES: readonly UserRole[] = ['super_admin', 'firm_funds_admin', 'brokerage_admin', 'agent']

// ============================================================================
// Create a new remediation deal under a failed deal
// ============================================================================

export async function createRemediationDeal(input: RemediationDealInput): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(SUBMIT_ROLES)
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.propertyAddress?.trim()) return { success: false, error: 'Property address is required' }
  if (!input.brokerageLegalName?.trim()) return { success: false, error: 'Brokerage legal name is required' }
  if (!Number.isFinite(input.directedAmount) || input.directedAmount <= 0) {
    return { success: false, error: 'Directed amount must be greater than zero' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    const access = await authorizeFailedDealAccess(serviceClient, profile, input.failedDealId)
    if (!access.ok) return { success: false, error: access.error }
    const failedDeal = access.deal
    if (failedDeal.status !== 'failed_to_close') {
      return { success: false, error: 'Deal is not in failed-to-close state' }
    }

    const { data: inserted, error: insertErr } = await serviceClient
      .from('remediation_deals')
      .insert({
        failed_deal_id: input.failedDealId,
        agent_id: failedDeal.agent_id,
        property_address: input.propertyAddress.trim(),
        mls_number: input.mlsNumber?.trim() || null,
        brokerage_id: input.brokerageId || null,
        brokerage_legal_name: input.brokerageLegalName.trim(),
        brokerage_address: input.brokerageAddress?.trim() || null,
        broker_of_record_name: input.brokerOfRecordName?.trim() || null,
        broker_of_record_email: input.brokerOfRecordEmail?.trim() || null,
        expected_commission: input.expectedCommission ?? null,
        expected_closing_date: input.expectedClosingDate || null,
        expected_payment_date: input.expectedPaymentDate || null,
        directed_amount: input.directedAmount,
        notes: input.notes?.trim() || null,
        status: 'pending',
        created_by: user.id,
      })
      .select('id')
      .single()

    if (insertErr) {
      // Task 10: migration 090 adds a unique partial index on
      // (failed_deal_id, property_address) WHERE status<>'cancelled', so two
      // concurrent admins clicking "Add Remediation" for the same address
      // collide here with PostgreSQL error code 23505. Translate that to a
      // friendly message instead of leaking the raw constraint name.
      if ((insertErr as { code?: string }).code === '23505') {
        return {
          success: false,
          error: 'A remediation deal already exists for this property and failed deal. Check existing remediation list.',
        }
      }
      console.error('createRemediationDeal insert error:', insertErr.message)
      return { success: false, error: `Failed to save remediation deal: ${insertErr.message}` }
    }

    await logAuditEvent({
      action: 'remediation_deal.created',
      entityType: 'deal',
      entityId: input.failedDealId,
      metadata: {
        remediation_deal_id: inserted!.id,
        directed_amount: input.directedAmount,
        property_address: input.propertyAddress.trim(),
        brokerage: input.brokerageLegalName.trim(),
        submitter_role: profile.role,
      },
    })

    return { success: true, data: { id: inserted!.id } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    console.error('createRemediationDeal error:', message)
    return { success: false, error: message }
  }
}

// ============================================================================
// Update a pending remediation deal (admin can edit before sending the IDP)
// ============================================================================

export async function updateRemediationDeal(
  id: string,
  input: Partial<Omit<RemediationDealInput, 'failedDealId'>>,
): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(SUBMIT_ROLES)
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: existing, error: getErr } = await serviceClient
      .from('remediation_deals')
      .select('id, status, failed_deal_id')
      .eq('id', id)
      .single()

    if (getErr || !existing) return { success: false, error: 'Remediation deal not found' }
    if (existing.status !== 'pending') {
      return { success: false, error: `Cannot edit a remediation deal in status "${existing.status}". Cancel it and create a new one.` }
    }

    // Tenancy: caller must be allowed to act on the parent failed deal.
    const access = await authorizeFailedDealAccess(serviceClient, profile, existing.failed_deal_id)
    if (!access.ok) return { success: false, error: access.error }

    const patch: Record<string, unknown> = {}
    if (input.propertyAddress !== undefined) patch.property_address = input.propertyAddress.trim()
    if (input.mlsNumber !== undefined) patch.mls_number = input.mlsNumber?.trim() || null
    if (input.brokerageId !== undefined) patch.brokerage_id = input.brokerageId || null
    if (input.brokerageLegalName !== undefined) patch.brokerage_legal_name = input.brokerageLegalName.trim()
    if (input.brokerageAddress !== undefined) patch.brokerage_address = input.brokerageAddress?.trim() || null
    if (input.brokerOfRecordName !== undefined) patch.broker_of_record_name = input.brokerOfRecordName?.trim() || null
    if (input.brokerOfRecordEmail !== undefined) patch.broker_of_record_email = input.brokerOfRecordEmail?.trim() || null
    if (input.expectedCommission !== undefined) patch.expected_commission = input.expectedCommission ?? null
    if (input.expectedClosingDate !== undefined) patch.expected_closing_date = input.expectedClosingDate || null
    if (input.expectedPaymentDate !== undefined) patch.expected_payment_date = input.expectedPaymentDate || null
    if (input.directedAmount !== undefined) {
      if (!Number.isFinite(input.directedAmount) || input.directedAmount <= 0) {
        return { success: false, error: 'Directed amount must be greater than zero' }
      }
      patch.directed_amount = input.directedAmount
    }
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null

    if (Object.keys(patch).length === 0) return { success: true, data: { id } }

    const { error: updateErr } = await serviceClient
      .from('remediation_deals')
      .update(patch)
      .eq('id', id)
      .eq('status', 'pending')

    if (updateErr) {
      console.error('updateRemediationDeal error:', updateErr.message)
      return { success: false, error: updateErr.message }
    }

    await logAuditEvent({
      action: 'remediation_deal.updated',
      entityType: 'deal',
      entityId: existing.failed_deal_id,
      metadata: { remediation_deal_id: id, patch, submitter_role: profile.role },
    })

    return { success: true, data: { id } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    console.error('updateRemediationDeal error:', message)
    return { success: false, error: message }
  }
}

// ============================================================================
// Cancel a remediation deal (deal falls through, agent transfers, etc.)
// Does NOT affect the failed-deal balance — that stays in failed_to_close
// until another remediation clears it (or cash repayment).
// ============================================================================

export async function cancelRemediationDeal(id: string, reason: string): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(SUBMIT_ROLES)
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  if (!reason?.trim()) return { success: false, error: 'Cancellation reason is required' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: existing, error: getErr } = await serviceClient
      .from('remediation_deals')
      .select('id, status, failed_deal_id, notes')
      .eq('id', id)
      .single()

    if (getErr || !existing) return { success: false, error: 'Remediation deal not found' }
    if (existing.status === 'remitted') {
      return { success: false, error: 'Cannot cancel a remediation deal that has already been remitted' }
    }
    if (existing.status === 'cancelled') {
      return { success: false, error: 'Remediation deal is already cancelled' }
    }

    // Tenancy: caller must be allowed to act on the parent failed deal.
    const access = await authorizeFailedDealAccess(serviceClient, profile, existing.failed_deal_id)
    if (!access.ok) return { success: false, error: access.error }

    const stampedNote = `[Cancelled ${new Date().toISOString().slice(0, 10)}] ${reason.trim()}${existing.notes ? `\n\nPrior notes: ${existing.notes}` : ''}`

    const { error: updateErr } = await serviceClient
      .from('remediation_deals')
      .update({ status: 'cancelled', notes: stampedNote })
      .eq('id', id)

    if (updateErr) {
      console.error('cancelRemediationDeal error:', updateErr.message)
      return { success: false, error: updateErr.message }
    }

    await logAuditEvent({
      action: 'remediation_deal.cancelled',
      entityType: 'deal',
      entityId: existing.failed_deal_id,
      metadata: { remediation_deal_id: id, reason: reason.trim(), prior_status: existing.status, submitter_role: profile.role },
    })

    return { success: true, data: { id } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    console.error('cancelRemediationDeal error:', message)
    return { success: false, error: message }
  }
}

// ============================================================================
// Mark a remediation deal remitted — applies the credit to the agent's
// ledger, reduces the failed deal's outstanding balance, and if everything
// is cleared, moves the failed deal to status='cured'.
//
// Allocation: payment applies to accrued (unposted) interest first, then to
// posted interest from the ledger, then to principal. This matches the
// natural compounding semantic — clearing interest stops further compounding
// growth before paying down principal.
// ============================================================================

export async function markRemediationDealRemitted(input: {
  id: string
  remittedAmount: number
  remittedAt: string  // YYYY-MM-DD
  notes?: string
}): Promise<ActionResult> {
  // FF admin only. This records that money actually arrived at Firm Funds,
  // not a submission step. Brokerage admins and agents can create / update /
  // cancel remediation deals, but only FF marks them remitted.
  const { error: authErr, user } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!Number.isFinite(input.remittedAmount) || input.remittedAmount <= 0) {
    return { success: false, error: 'Remitted amount must be greater than zero' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: rem, error: getErr } = await serviceClient
      .from('remediation_deals')
      .select('id, failed_deal_id, agent_id, property_address, brokerage_legal_name, status, directed_amount')
      .eq('id', input.id)
      .single()

    if (getErr || !rem) return { success: false, error: 'Remediation deal not found' }
    if (rem.status === 'remitted') return { success: false, error: 'Remediation deal is already marked remitted' }
    if (rem.status === 'cancelled') return { success: false, error: 'Cannot remit a cancelled remediation deal' }

    // Capture prior status for CAS guard + revert path. The CHECK constraint
    // on remediation_deals.status (migration 046) only allows pending /
    // idp_sent / idp_signed / remitted / cancelled, so we cannot introduce
    // a true 'remitting' intermediate state without a schema change. Instead,
    // we atomically claim by flipping status directly to 'remitted' guarded
    // on the prior status. Only ONE concurrent caller can win the CAS; the
    // other gets zero rows and bails before touching the RPC. If the RPC
    // subsequently fails we revert status back to priorStatus.
    const priorStatus = rem.status as 'pending' | 'idp_sent' | 'idp_signed'

    const { data: failedDeal } = await serviceClient
      .from('deals')
      .select('id, status, outstanding_balance, failed_to_close_at, failed_deal_interest_charged, property_address')
      .eq('id', rem.failed_deal_id)
      .single()
    if (!failedDeal) return { success: false, error: 'Failed deal not found' }

    // Task 11: hard-stop if the failed deal isn't in failed_to_close anymore.
    // If it slipped to cured (someone else cleared it) or back to funded (mis-
    // mark reversal), applying a remittance against it would either re-cure a
    // cleared deal or post a credit against a deal that's no longer failed.
    // Force the admin to refresh and reconfirm intent.
    if (failedDeal.status !== 'failed_to_close') {
      return {
        success: false,
        error: `Deal is no longer in failed-to-close status (currently: ${failedDeal.status}). Refresh and verify before applying remittance.`,
      }
    }

    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, account_balance, first_name, last_name')
      .eq('id', rem.agent_id)
      .single()
    if (!agent) return { success: false, error: 'Agent not found' }

    const principal = Number(failedDeal.outstanding_balance) || 0
    const postedInterest = Number(failedDeal.failed_deal_interest_charged) || 0
    const liveInterestTotal = failedDeal.failed_to_close_at
      ? liveFailedDealInterestOwed(principal, failedDeal.failed_to_close_at as string)
      : 0
    const unpostedInterest = Math.max(0, Math.round((liveInterestTotal - postedInterest) * 100) / 100)
    const totalOwed = Math.round((principal + liveInterestTotal) * 100) / 100

    const remittedAmount = Math.round(input.remittedAmount * 100) / 100

    // Allocate: unposted interest first, then posted interest, then principal.
    let remaining = remittedAmount
    const applyToUnposted = Math.min(remaining, unpostedInterest)
    remaining = Math.round((remaining - applyToUnposted) * 100) / 100
    const applyToPostedInterest = Math.min(remaining, postedInterest)
    remaining = Math.round((remaining - applyToPostedInterest) * 100) / 100
    const applyToPrincipal = Math.min(remaining, principal)
    remaining = Math.round((remaining - applyToPrincipal) * 100) / 100
    const surplus = remaining

    const newPrincipal = Math.round((principal - applyToPrincipal) * 100) / 100
    const newPostedInterest = Math.round((postedInterest - applyToPostedInterest) * 100) / 100

    // The unposted interest portion is "swallowed" by the remittance — we
    // bring failed_deal_interest_charged up to the live total (so the unposted
    // portion is now considered accounted-for), then subtract what was paid
    // toward it. Net effect: failed_deal_interest_charged moves from
    // postedInterest -> (postedInterest + unpostedInterest - applyToUnposted - applyToPostedInterest).
    const newFailedDealInterestCharged = Math.round(
      (postedInterest + unpostedInterest - applyToUnposted - applyToPostedInterest) * 100,
    ) / 100

    const fullyCleared = newPrincipal < 0.005 && newFailedDealInterestCharged < 0.005

    const creditAmount = Math.round((remittedAmount - surplus) * 100) / 100  // what actually paid down the failed deal
    const surplusAmount = surplus
    const description = `Remediation IDP payment received - ${rem.property_address} (${rem.brokerage_legal_name}). Applied to ${failedDeal.property_address}.${surplusAmount > 0.005 ? ` Surplus ${formatMoney(surplusAmount)} to be refunded to agent.` : ''}`

    // -----------------------------------------------------------------------
    // STEP 1 — Atomically claim the remediation row via CAS on prior status.
    // Two simultaneous "Mark Remitted" clicks both pass the pre-check above,
    // but only one wins this CAS. The other gets zero rows and bails before
    // calling the RPC, preventing a double credit.
    // -----------------------------------------------------------------------
    const remittedAtIso = new Date(input.remittedAt + 'T12:00:00Z').toISOString()
    const { data: claimed, error: claimErr } = await serviceClient
      .from('remediation_deals')
      .update({
        status: 'remitted',
        remitted_amount: remittedAmount,
        remitted_at: remittedAtIso,
        notes: input.notes?.trim() || null,
      })
      .eq('id', rem.id)
      .eq('status', priorStatus)
      .select('id')
      .maybeSingle()

    if (claimErr) {
      console.error('markRemediationDealRemitted CAS error:', claimErr.message)
      return { success: false, error: 'Failed to claim remediation deal for remittance' }
    }
    if (!claimed) {
      return { success: false, error: 'Remediation deal status changed concurrently. Refresh and try again.' }
    }

    // -----------------------------------------------------------------------
    // STEP 2 — Apply the remittance via atomic RPC (migration 052). Posts
    // the unposted-interest catch-up (if any) AND the credit row in one
    // transaction. If this fails after the CAS, revert remediation status
    // back to its prior value so a retry is possible.
    // -----------------------------------------------------------------------
    const { data: remitResult, error: remitErr } = await serviceClient
      .rpc('apply_remediation_remittance', {
        p_agent_id: agent.id,
        p_credit_amount: creditAmount,
        p_unposted_interest_amount: applyToUnposted,
        p_failed_deal_id: failedDeal.id,
        p_credit_description: description,
        p_created_by: user.id,
      })
    if (remitErr) {
      console.error('applyFailedDealRemittance RPC error:', remitErr.message)
      await serviceClient
        .from('remediation_deals')
        .update({
          status: priorStatus,
          remitted_amount: null,
          remitted_at: null,
        })
        .eq('id', rem.id)
        .eq('status', 'remitted')
      return { success: false, error: `Failed to apply remittance: ${remitErr.message}` }
    }
    // The RPC returns the post-update agent balance in remitResult.new_balance;
    // we don't surface it to the caller here, but ignore the value explicitly
    // so the linter doesn't flag the unused destructure.
    void remitResult

    // -----------------------------------------------------------------------
    // STEP 3 — Update the failed deal: drop principal / interest charged,
    // set 'cured' if done. CAS-guarded on the exact prior values we read
    // above so a concurrent remittance against the same failed deal cannot
    // silently overwrite a fresher balance with our stale snapshot.
    // -----------------------------------------------------------------------
    const failedDealPatch: Record<string, unknown> = {
      outstanding_balance: newPrincipal,
      failed_deal_interest_charged: newFailedDealInterestCharged,
      failed_deal_interest_calculated_at: new Date().toISOString(),
    }
    if (fullyCleared) {
      failedDealPatch.status = 'cured'
    }

    const { data: updatedDeal, error: dealUpdateErr } = await serviceClient
      .from('deals')
      .update(failedDealPatch)
      .eq('id', failedDeal.id)
      .eq('outstanding_balance', principal)
      .eq('failed_deal_interest_charged', postedInterest)
      .select('id')
      .maybeSingle()

    if (dealUpdateErr || !updatedDeal) {
      // Task 9: the credit was already atomically posted to the agent's
      // balance via the RPC, but the failed deal's denormalized principal /
      // interest counters did NOT update because another remittance landed
      // between our read and write. Previously we swallowed this and returned
      // success, which left admins blind to the reconciliation gap. Now we
      // log a WARNING audit event AND return an explicit error so the user
      // refreshes and inspects the failed-deal totals. The credit on the
      // ledger remains valid; there is no double-post risk.
      console.error(
        'markRemediationDealRemitted failed-deal CAS lost',
        {
          failed_deal_id: failedDeal.id,
          remediation_deal_id: rem.id,
          expected_principal: principal,
          expected_posted_interest: postedInterest,
          err: dealUpdateErr?.message,
        },
      )
      await logAuditEvent({
        action: 'remediation_deal.failed_deal_cas_lost',
        entityType: 'deal',
        entityId: failedDeal.id,
        severity: 'warning',
        metadata: {
          remediation_deal_id: rem.id,
          expected_principal: principal,
          expected_posted_interest: postedInterest,
          credit_already_posted: creditAmount,
          unposted_interest_posted: applyToUnposted,
          surplus_amount: surplusAmount,
          error: dealUpdateErr?.message || 'CAS lost',
        },
      })
      return {
        success: false,
        error: 'Another payment was recorded for this deal while you were processing. The credit has been posted to the agent. Please refresh and verify the failed-deal balance reconciles.',
      }
    }

    // Overpayment surplus: the brokerage remitted more than this failed deal
    // owed. Post the excess as a credit on the agent's account (a negative
    // delta lowers the balance, so Firm Funds now owes the agent), to be
    // refunded manually. All balance writes go through apply_agent_balance_delta.
    let surplusCreditPosted = false
    if (surplusAmount > 0.005) {
      const { error: surplusErr } = await serviceClient.rpc('apply_agent_balance_delta', {
        p_agent_id: agent.id,
        p_delta: -surplusAmount,
        p_type: 'credit',
        p_description: `Overpayment surplus on Remediation IDP - ${rem.property_address} (${rem.brokerage_legal_name}). Refundable to agent.`,
        p_deal_id: failedDeal.id,
        p_created_by: user.id,
      })
      if (surplusErr) {
        // The remittance itself already succeeded; only the surplus credit
        // failed. Surface it loudly for manual follow-up rather than failing
        // the whole operation (which would imply the remittance did not land).
        console.error('markRemediationDealRemitted surplus credit failed:', surplusErr.message)
        await logAuditEvent({
          action: 'remediation_deal.surplus_credit_failed',
          entityType: 'deal',
          entityId: failedDeal.id,
          severity: 'warning',
          metadata: {
            remediation_deal_id: rem.id,
            surplus_amount: surplusAmount,
            error: surplusErr.message,
          },
        })
      } else {
        surplusCreditPosted = true
      }
    }

    await logAuditEvent({
      action: 'remediation_deal.remitted',
      entityType: 'deal',
      entityId: failedDeal.id,
      metadata: {
        remediation_deal_id: rem.id,
        remitted_amount: remittedAmount,
        remitted_at: input.remittedAt,
        allocation: {
          unposted_interest: applyToUnposted,
          posted_interest: applyToPostedInterest,
          principal: applyToPrincipal,
          surplus: surplusAmount,
        },
        surplus_credit_posted: surplusCreditPosted,
        failed_deal_cleared: fullyCleared,
        prior_principal: principal,
        new_principal: newPrincipal,
        prior_total_owed: totalOwed,
      },
    })

    return {
      success: true,
      data: {
        fullyCleared,
        newPrincipal,
        newPostedInterest,
        surplus: surplusAmount,
        surplusCreditPosted,
        creditApplied: creditAmount,
      },
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    console.error('markRemediationDealRemitted error:', message)
    return { success: false, error: message }
  }
}

// ============================================================================
// Get all remediation deals for a failed deal (admin display)
// ============================================================================

export async function getRemediationDealsForFailedDeal(failedDealId: string): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(SUBMIT_ROLES)
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const access = await authorizeFailedDealAccess(serviceClient, profile, failedDealId)
    if (!access.ok) return { success: false, error: access.error }

    const { data, error } = await serviceClient
      .from('remediation_deals')
      .select('*, esignature_envelopes:esignature_envelopes(envelope_id, status, agent_signed_at)')
      .eq('failed_deal_id', failedDealId)
      .order('created_at', { ascending: false })

    if (error) return { success: false, error: error.message }
    return { success: true, data: data || [] }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    console.error('getRemediationDealsForFailedDeal error:', message)
    return { success: false, error: message }
  }
}

// ============================================================================
// List failed deals visible to the current caller. Used by the brokerage and
// agent failed-deals pages. Returns rows pre-scoped by tenancy:
//   super_admin / firm_funds_admin → all failed-to-close deals
//   brokerage_admin                → only failed deals at the caller's brokerage
//   agent                          → only the caller's own failed deals
// ============================================================================

export interface FailedDealForCaller {
  id: string
  deal_number: string | null
  property_address: string
  closing_date: string | null
  failed_to_close_at: string | null
  outstanding_balance: number
  failed_deal_interest_charged: number
  live_balance_owed: number
  cure_election: string | null
  cure_election_deadline: string | null
  agent: {
    id: string
    first_name: string
    last_name: string
    email: string | null
    brokerage_id: string | null
    brokerage_name: string | null
    brokerage_address: string | null
    broker_of_record_name: string | null
    broker_of_record_email: string | null
  }
  remediation_count: number
  remediation_active_count: number
}

export async function getFailedDealsForCaller(): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(SUBMIT_ROLES)
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    let query = serviceClient
      .from('deals')
      .select(`
        id, deal_number, property_address, closing_date, failed_to_close_at,
        outstanding_balance, failed_deal_interest_charged,
        cure_election, cure_election_deadline,
        agents:agents!deals_agent_id_fkey(
          id, first_name, last_name, email, brokerage_id,
          brokerages:brokerages!agents_brokerage_id_fkey(
            id, name, address, broker_of_record_name, broker_of_record_email
          )
        ),
        remediation_deals(id, status)
      `)
      .eq('status', 'failed_to_close')
      .order('failed_to_close_at', { ascending: false })

    if (profile.role === 'brokerage_admin') {
      if (!profile.brokerage_id) {
        return { success: false, error: 'Your account is not linked to a brokerage' }
      }
      // Filter by the agent's brokerage. PostgREST supports foreign-table eq.
      query = query.eq('agents.brokerage_id', profile.brokerage_id)
    } else if (profile.role === 'agent') {
      if (!profile.agent_id) {
        return { success: false, error: 'Your account is not linked to an agent profile' }
      }
      query = query.eq('agent_id', profile.agent_id)
    }

    const { data, error } = await query
    if (error) return { success: false, error: error.message }

    // Shape each row, compute live balance, and drop any rows the join filter
    // didn't actually scope (agent.brokerage_id mismatch returns the row but
    // with agents=null on PostgREST, so filter those out for brokerage_admin).
    const rows: FailedDealForCaller[] = []
    for (const raw of (data as unknown as Array<{
      id: string
      deal_number: string | null
      property_address: string
      closing_date: string | null
      failed_to_close_at: string | null
      outstanding_balance: number | null
      failed_deal_interest_charged: number | null
      cure_election: string | null
      cure_election_deadline: string | null
      agents: {
        id: string
        first_name: string
        last_name: string
        email: string | null
        brokerage_id: string | null
        brokerages: {
          id: string
          name: string | null
          address: string | null
          broker_of_record_name: string | null
          broker_of_record_email: string | null
        } | Array<{
          id: string
          name: string | null
          address: string | null
          broker_of_record_name: string | null
          broker_of_record_email: string | null
        }> | null
      } | Array<{
        id: string
        first_name: string
        last_name: string
        email: string | null
        brokerage_id: string | null
        brokerages: {
          id: string
          name: string | null
          address: string | null
          broker_of_record_name: string | null
          broker_of_record_email: string | null
        } | Array<{
          id: string
          name: string | null
          address: string | null
          broker_of_record_name: string | null
          broker_of_record_email: string | null
        }> | null
      }> | null
      remediation_deals: Array<{ id: string; status: string }> | null
    }>) || []) {
      const agent = Array.isArray(raw.agents) ? (raw.agents[0] ?? null) : raw.agents
      if (!agent) continue
      if (profile.role === 'brokerage_admin' && agent.brokerage_id !== profile.brokerage_id) continue
      const brokerage = Array.isArray(agent.brokerages) ? (agent.brokerages[0] ?? null) : agent.brokerages
      const principal = Number(raw.outstanding_balance) || 0
      const postedInterest = Number(raw.failed_deal_interest_charged) || 0
      const liveInterestTotal = raw.failed_to_close_at
        ? liveFailedDealInterestOwed(principal, raw.failed_to_close_at)
        : 0
      const liveBalanceOwed = Math.round((principal + Math.max(postedInterest, liveInterestTotal)) * 100) / 100
      const remediations = raw.remediation_deals || []
      rows.push({
        id: raw.id,
        deal_number: raw.deal_number,
        property_address: raw.property_address,
        closing_date: raw.closing_date,
        failed_to_close_at: raw.failed_to_close_at,
        outstanding_balance: principal,
        failed_deal_interest_charged: postedInterest,
        live_balance_owed: liveBalanceOwed,
        cure_election: raw.cure_election,
        cure_election_deadline: raw.cure_election_deadline,
        agent: {
          id: agent.id,
          first_name: agent.first_name,
          last_name: agent.last_name,
          email: agent.email,
          brokerage_id: agent.brokerage_id,
          brokerage_name: brokerage?.name ?? null,
          brokerage_address: brokerage?.address ?? null,
          broker_of_record_name: brokerage?.broker_of_record_name ?? null,
          broker_of_record_email: brokerage?.broker_of_record_email ?? null,
        },
        remediation_count: remediations.length,
        remediation_active_count: remediations.filter(r => r.status !== 'cancelled' && r.status !== 'remitted').length,
      })
    }

    return { success: true, data: rows }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    console.error('getFailedDealsForCaller error:', message)
    return { success: false, error: message }
  }
}

// ============================================================================
// Helper
// ============================================================================

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}
