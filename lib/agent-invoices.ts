import type { SupabaseClient } from '@supabase/supabase-js'
import { logAuditEvent } from '@/lib/audit'

/**
 * Shared agent-invoice plumbing.
 *
 * `generateInvoice` in lib/actions/account-actions.ts bills an agent's ENTIRE
 * outstanding `account_balance` and derives its line items from every unpaid
 * transaction. That is the right tool for a periodic account statement, but the
 * wrong tool for billing a single, known charge (e.g. the extra discount fee on
 * a closing-date extension), which needs an EXPLICIT amount + line item and a
 * link back to the deal.
 *
 * This helper inserts one `agent_invoices` row for an explicit amount. It is a
 * plain function (not a server action) so internal callers that have already
 * authorized (e.g. the amendment-approval path, gated on `deal.underwrite`) can
 * raise an invoice with the service-role client WITHOUT re-checking `money.write`
 * because managers can approve amendments but do not hold `money.write`.
 *
 * RECONCILIATION (single source of truth = agents.account_balance):
 * the invoice does NOT move money on its own. The caller is responsible for the
 * matching balance debit (via `apply_agent_balance_delta`). Paying the invoice
 * later (`markInvoicePaid` -> `mark_invoice_paid_atomic`) subtracts the paid
 * amount back off `account_balance`, clearing exactly the debt this invoice
 * bills. So: amendment debits the balance by `amount` -> this invoice bills
 * `amount` -> paying it credits the balance by `amount`. Net zero, no
 * double-count, as long as `amount` here equals the balance debit.
 */
export async function insertAgentInvoice(
  serviceClient: SupabaseClient,
  params: {
    agentId: string
    amount: number
    lineItems: { description: string; amount: number; date: string; type: string }[]
    dueDate: string // YYYY-MM-DD
    createdBy: string
    dealId?: string | null
    notes?: string | null
  },
): Promise<{ success: boolean; error?: string; invoice?: Record<string, unknown> }> {
  const amount = Math.round(params.amount * 100) / 100
  if (!(amount > 0)) {
    return { success: false, error: 'Invoice amount must be greater than zero' }
  }

  // Snapshot the agent's contact details onto the invoice (matches generateInvoice).
  const { data: agent } = await serviceClient
    .from('agents')
    .select('id, first_name, last_name, email, phone')
    .eq('id', params.agentId)
    .single()

  if (!agent) return { success: false, error: 'Agent not found' }

  // Invoice number FF-YYYY-NNNN via the shared sequence (same as generateInvoice).
  const year = new Date().getFullYear()
  const { data: seqData } = await serviceClient.rpc('nextval', { seq_name: 'invoice_number_seq' })
  const seqNum = seqData || Date.now()
  const invoiceNumber = `FF-${year}-${String(seqNum).padStart(4, '0')}`

  const { data: invoice, error: insertErr } = await serviceClient
    .from('agent_invoices')
    .insert({
      agent_id: agent.id,
      invoice_number: invoiceNumber,
      amount,
      status: 'pending',
      due_date: params.dueDate,
      deal_id: params.dealId ?? null,
      agent_name: `${agent.first_name} ${agent.last_name}`,
      agent_email: agent.email,
      agent_phone: agent.phone,
      line_items: params.lineItems,
      notes: params.notes ?? null,
      created_by: params.createdBy,
    })
    .select()
    .single()

  if (insertErr) {
    return { success: false, error: `Failed to create invoice: ${insertErr.message}` }
  }

  await logAuditEvent({
    action: 'invoice.create',
    entityType: 'agent',
    entityId: agent.id,
    metadata: {
      invoice_id: invoice.id,
      invoice_number: invoiceNumber,
      amount,
      deal_id: params.dealId ?? null,
    },
  })

  return { success: true, invoice }
}
