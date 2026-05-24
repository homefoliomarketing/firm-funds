'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import { liveFailedDealInterestOwed } from '@/lib/calculations'

type ActionResult = { success: boolean; error?: string; data?: any }

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
// Create a new remediation deal under a failed deal
// ============================================================================

export async function createRemediationDeal(input: RemediationDealInput): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.propertyAddress?.trim()) return { success: false, error: 'Property address is required' }
  if (!input.brokerageLegalName?.trim()) return { success: false, error: 'Brokerage legal name is required' }
  if (!Number.isFinite(input.directedAmount) || input.directedAmount <= 0) {
    return { success: false, error: 'Directed amount must be greater than zero' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: failedDeal, error: fdErr } = await serviceClient
      .from('deals')
      .select('id, agent_id, status, cure_election')
      .eq('id', input.failedDealId)
      .single()

    if (fdErr || !failedDeal) return { success: false, error: 'Failed deal not found' }
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
      },
    })

    return { success: true, data: { id: inserted!.id } }
  } catch (err: any) {
    console.error('createRemediationDeal error:', err?.message)
    return { success: false, error: err?.message || 'An unexpected error occurred' }
  }
}

// ============================================================================
// Update a pending remediation deal (admin can edit before sending the IDP)
// ============================================================================

export async function updateRemediationDeal(
  id: string,
  input: Partial<Omit<RemediationDealInput, 'failedDealId'>>,
): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

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

    const patch: Record<string, any> = {}
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
      metadata: { remediation_deal_id: id, patch },
    })

    return { success: true, data: { id } }
  } catch (err: any) {
    console.error('updateRemediationDeal error:', err?.message)
    return { success: false, error: err?.message || 'An unexpected error occurred' }
  }
}

// ============================================================================
// Cancel a remediation deal (deal falls through, agent transfers, etc.)
// Does NOT affect the failed-deal balance — that stays in failed_to_close
// until another remediation clears it (or cash repayment).
// ============================================================================

export async function cancelRemediationDeal(id: string, reason: string): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

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
      metadata: { remediation_deal_id: id, reason: reason.trim(), prior_status: existing.status },
    })

    return { success: true, data: { id } }
  } catch (err: any) {
    console.error('cancelRemediationDeal error:', err?.message)
    return { success: false, error: err?.message || 'An unexpected error occurred' }
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
  const { error: authErr, user } = await getAuthenticatedAdmin()
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

    const { data: failedDeal } = await serviceClient
      .from('deals')
      .select('id, outstanding_balance, failed_to_close_at, failed_deal_interest_charged, property_address')
      .eq('id', rem.failed_deal_id)
      .single()
    if (!failedDeal) return { success: false, error: 'Failed deal not found' }

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

    // -----------------------------------------------------------------------
    // Apply the remittance: atomically post the unposted-interest catch-up
    // (if any) AND the credit row in one transaction (RPC from migration 052).
    // Replaces the prior two-step pattern that would leave a phantom credit
    // when applyToUnposted > 0 — the original code debited the full credit
    // amount but never recorded the matching interest row, so the agent's
    // balance ended up understated by applyToUnposted permanently.
    // -----------------------------------------------------------------------
    const creditAmount = Math.round((remittedAmount - surplus) * 100) / 100  // what actually paid down the failed deal
    const surplusAmount = surplus
    const description = `Remediation IDP payment received — ${rem.property_address} (${rem.brokerage_legal_name}). Applied to ${failedDeal.property_address}.${surplusAmount > 0.005 ? ` Surplus ${formatMoney(surplusAmount)} to be refunded to agent.` : ''}`

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
      return { success: false, error: `Failed to apply remittance: ${remitErr.message}` }
    }
    const newAgentBalance = Number((remitResult as any)?.new_balance) || 0

    // -----------------------------------------------------------------------
    // Update the failed deal: drop principal/interest charged, set 'cured' if done
    // -----------------------------------------------------------------------
    const failedDealPatch: Record<string, any> = {
      outstanding_balance: newPrincipal,
      failed_deal_interest_charged: newFailedDealInterestCharged,
      failed_deal_interest_calculated_at: new Date().toISOString(),
    }
    if (fullyCleared) {
      failedDealPatch.status = 'cured'
    }

    await serviceClient
      .from('deals')
      .update(failedDealPatch)
      .eq('id', failedDeal.id)

    // -----------------------------------------------------------------------
    // Update the remediation deal record
    // -----------------------------------------------------------------------
    await serviceClient
      .from('remediation_deals')
      .update({
        status: 'remitted',
        remitted_amount: remittedAmount,
        remitted_at: new Date(input.remittedAt + 'T12:00:00Z').toISOString(),
        notes: input.notes?.trim() || null,
      })
      .eq('id', rem.id)

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
        creditApplied: creditAmount,
      },
    }
  } catch (err: any) {
    console.error('markRemediationDealRemitted error:', err?.message)
    return { success: false, error: err?.message || 'An unexpected error occurred' }
  }
}

// ============================================================================
// Get all remediation deals for a failed deal (admin display)
// ============================================================================

export async function getRemediationDealsForFailedDeal(failedDealId: string): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data, error } = await serviceClient
      .from('remediation_deals')
      .select('*, esignature_envelopes:esignature_envelopes(envelope_id, status, agent_signed_at)')
      .eq('failed_deal_id', failedDealId)
      .order('created_at', { ascending: false })

    if (error) return { success: false, error: error.message }
    return { success: true, data: data || [] }
  } catch (err: any) {
    console.error('getRemediationDealsForFailedDeal error:', err?.message)
    return { success: false, error: err?.message || 'An unexpected error occurred' }
  }
}

// ============================================================================
// Helper
// ============================================================================

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}
