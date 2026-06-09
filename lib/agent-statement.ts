import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================================
// Informational agent-ledger entries (migration 106)
//
// These post "statement" rows to agent_transactions via the balance-neutral
// record_agent_statement_entry RPC. They make an agent's ledger read like a
// bank statement (advance issued -> repayment received) WITHOUT moving
// agents.account_balance, so they never trigger late-payment interest accrual
// or get netted against a future advance. A funded advance the brokerage repays
// is not agent debt.
//
// Every helper here is best-effort: it NEVER throws. The underlying money path
// (funding, payment confirmation) has already committed by the time we post the
// cosmetic ledger line, so a failure here must not unwind it. Failures are
// logged loudly so an admin can reconcile manually.
//
// Sign convention matches the rest of the ledger: positive amount = charge
// (shown amber with a "+"), negative = payment/credit (shown teal).
// ============================================================================

// The RPC requires the service role. Callers must pass a service-role client.
type ServiceClient = SupabaseClient

async function postStatementEntry(
  supabase: ServiceClient,
  params: {
    agentId: string
    type: 'deal_advance' | 'deal_repayment'
    amount: number
    description: string
    dealId: string
    createdBy?: string | null
    referenceId?: string | null
  },
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('record_agent_statement_entry', {
      p_agent_id: params.agentId,
      p_type: params.type,
      p_amount: params.amount,
      p_description: params.description,
      p_deal_id: params.dealId,
      p_created_by: params.createdBy ?? null,
      p_reference_id: params.referenceId ?? null,
    })
    if (error) {
      console.error(
        `[agent-statement] failed to post ${params.type} for agent ${params.agentId} deal ${params.dealId}: ${error.message}`,
      )
      return false
    }
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error(`[agent-statement] unexpected error posting ${params.type}: ${msg}`)
    return false
  }
}

// Charge posted when a deal is funded. Amount = the outstanding balance the
// brokerage will repay (amount_due_from_brokerage). Positive = charge.
export async function postDealAdvanceEntry(
  supabase: ServiceClient,
  params: { agentId: string; dealId: string; amount: number; propertyAddress?: string | null; createdBy?: string | null },
): Promise<boolean> {
  if (!(params.amount > 0)) return false
  const where = params.propertyAddress ? ` for ${params.propertyAddress}` : ''
  return postStatementEntry(supabase, {
    agentId: params.agentId,
    type: 'deal_advance',
    amount: params.amount,
    description: `Advance issued${where}`,
    dealId: params.dealId,
    createdBy: params.createdBy,
  })
}

// Reversal of the advance charge when a funded deal is unwound (reverted to
// approved or funding marked failed). Negative = it cancels the earlier charge.
export async function reverseDealAdvanceEntry(
  supabase: ServiceClient,
  params: { agentId: string; dealId: string; amount: number; propertyAddress?: string | null; reason: string; createdBy?: string | null },
): Promise<boolean> {
  if (!(params.amount > 0)) return false
  const where = params.propertyAddress ? ` for ${params.propertyAddress}` : ''
  return postStatementEntry(supabase, {
    agentId: params.agentId,
    type: 'deal_advance',
    amount: -params.amount,
    description: `Advance charge reversed${where} (${params.reason})`,
    dealId: params.dealId,
    createdBy: params.createdBy,
  })
}

// Payment posted when a brokerage payment is confirmed received. Amount is the
// confirmed payment amount. Negative = payment received (reduces what is owed
// against the advance on the statement).
export async function postDealRepaymentEntry(
  supabase: ServiceClient,
  params: { agentId: string; dealId: string; amount: number; propertyAddress?: string | null; paymentId?: string | null; createdBy?: string | null },
): Promise<boolean> {
  if (!(params.amount > 0)) return false
  const where = params.propertyAddress ? ` for ${params.propertyAddress}` : ''
  return postStatementEntry(supabase, {
    agentId: params.agentId,
    type: 'deal_repayment',
    amount: -params.amount,
    description: `Repayment received${where}`,
    dealId: params.dealId,
    createdBy: params.createdBy,
    referenceId: params.paymentId ?? null,
  })
}
