'use server'

// ============================================================================
// Manual Agent Balance Adjustment
// ============================================================================
// Lets a Firm Funds admin apply an arbitrary credit or debit to an agent's
// account balance with an audit-logged reason. Backed by the atomic
// apply_agent_balance_delta RPC (migration 052) so the ledger row and balance
// move in a single transaction.
//
// Sign convention follows the rest of the codebase:
//   positive delta = balance goes UP (agent owes more) — debit
//   negative delta = balance goes DOWN (agent owes less / credit applied)
//
// The input field is named deltaCents and is expected as INTEGER CENTS so the
// caller doesn't have to round in JS. We convert to dollars before handing to
// the RPC (which works in NUMERIC dollars to match the rest of the ledger).
// ============================================================================

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedCapable } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'

interface ActionResult<T = unknown> {
  success: boolean
  error?: string
  data?: T
}

export type ManualAdjustmentReason =
  | 'refund'
  | 'correction'
  | 'write_off'
  | 'manual_charge'
  | 'other'

const VALID_REASONS: ManualAdjustmentReason[] = [
  'refund',
  'correction',
  'write_off',
  'manual_charge',
  'other',
]

// Sanity cap — prevents a UI typo from drilling a $1B hole in the ledger.
// Anything larger than this is a legitimate operational event and should be
// processed via a deal or the remediation flow, not the manual-adjustment UI.
const MAX_ABSOLUTE_DELTA_CENTS = 100_000_000 // $1,000,000

export async function adjustAgentBalance(input: {
  agentId: string
  deltaCents: number // positive = debit (agent owes more), negative = credit
  reason: ManualAdjustmentReason
  notes: string // required, ≥10 chars
  referenceId?: string
}): Promise<ActionResult<{ new_balance: number }>> {
  const { error: authErr, user } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  // Basic shape checks
  if (!input.agentId) return { success: false, error: 'agentId is required' }
  if (typeof input.deltaCents !== 'number' || !Number.isFinite(input.deltaCents)) {
    return { success: false, error: 'deltaCents must be a finite number' }
  }
  if (!Number.isInteger(input.deltaCents)) {
    return { success: false, error: 'deltaCents must be an integer (cents)' }
  }
  if (input.deltaCents === 0) {
    return { success: false, error: 'Adjustment cannot be zero' }
  }
  if (Math.abs(input.deltaCents) > MAX_ABSOLUTE_DELTA_CENTS) {
    return {
      success: false,
      error: 'Adjustment exceeds the $1,000,000 manual cap. Use the deal or remediation flow.',
    }
  }
  if (!input.reason || !VALID_REASONS.includes(input.reason)) {
    return {
      success: false,
      error: `reason must be one of: ${VALID_REASONS.join(', ')}`,
    }
  }
  const notes = (input.notes || '').trim()
  if (notes.length < 10) {
    return {
      success: false,
      error: 'A meaningful explanation (at least 10 characters) is required',
    }
  }
  if (notes.length > 1000) {
    return { success: false, error: 'Notes must be 1000 characters or fewer' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    // Verify the agent exists. The RPC also throws on missing FK but a
    // friendly error here saves a round-trip.
    const { data: agent, error: agentErr } = await serviceClient
      .from('agents')
      .select('id, first_name, last_name, status, deleted_at')
      .eq('id', input.agentId)
      .single()
    if (agentErr || !agent) return { success: false, error: 'Agent not found' }
    if (agent.deleted_at) {
      return { success: false, error: 'Cannot adjust the balance of a deleted agent' }
    }

    // RPC expects NUMERIC dollars, not cents. Round-trip through cents to
    // avoid float drift: 12345 cents -> 123.45.
    const deltaDollars = input.deltaCents / 100

    // Tag the type so the ledger row is greppable. Reads like
    // `manual_adjustment_refund` or `manual_adjustment_write_off`.
    const txnType = `manual_adjustment_${input.reason}`

    const { data: rpcRow, error: rpcErr } = await serviceClient.rpc(
      'apply_agent_balance_delta',
      {
        p_agent_id: input.agentId,
        p_delta: deltaDollars,
        p_type: txnType,
        p_description: `Manual ${input.reason} (${input.deltaCents > 0 ? 'debit' : 'credit'} ${formatCentsForDescription(input.deltaCents)}): ${notes}`,
        p_deal_id: null,
        p_created_by: user.id,
        p_reference_id: input.referenceId || null,
      },
    )

    if (rpcErr) {
      console.error('adjustAgentBalance RPC error:', rpcErr.message)
      return { success: false, error: `Failed to apply adjustment: ${rpcErr.message}` }
    }

    // apply_agent_balance_delta returns the full agent_transactions row. The
    // running_balance column is the post-update agent.account_balance.
    const newBalance = Number((rpcRow as { running_balance?: number } | null)?.running_balance ?? 0)

    await logAuditEvent({
      action: 'account.manual_adjustment',
      entityType: 'agent',
      entityId: input.agentId,
      severity: 'warning',
      metadata: {
        reason: input.reason,
        delta_cents: input.deltaCents,
        delta_dollars: deltaDollars,
        notes,
        reference_id: input.referenceId || null,
        applied_by_user_id: user.id,
        agent_name: `${agent.first_name} ${agent.last_name}`,
        new_balance: newBalance,
        transaction_type: txnType,
      },
    })

    return { success: true, data: { new_balance: newBalance } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('adjustAgentBalance error:', _msg)
    return { success: false, error: _msg || 'An unexpected error occurred' }
  }
}

function formatCentsForDescription(cents: number): string {
  const dollars = Math.abs(cents) / 100
  return `$${dollars.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
