'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import { calculateLateInterest } from '@/lib/calculations'
import { DISCOUNT_RATE_PER_1000_PER_DAY, LATE_CLOSING_GRACE_DAYS } from '@/lib/constants'
import {
  sendDocumentReturnNotification,
  sendDealMessageNotification,
  sendInvoiceNotification,
} from '@/lib/email'

// ============================================================================
// Types
// ============================================================================

interface ActionResult {
  success: boolean
  error?: string
  data?: any
}

// ============================================================================
// Late Closing Interest — Calculate and charge to agent account
// ============================================================================

export async function chargeLateClosingInterest(input: {
  dealId: string
  actualClosingDate: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Get deal info
    const { data: deal, error: dealErr } = await serviceClient
      .from('deals')
      .select('id, agent_id, advance_amount, closing_date, property_address, late_interest_charged')
      .eq('id', input.dealId)
      .single()

    if (dealErr || !deal) return { success: false, error: 'Deal not found' }

    // Calculate interest
    const interest = calculateLateInterest(
      deal.advance_amount,
      deal.closing_date,
      input.actualClosingDate,
    )

    if (interest <= 0) return { success: false, error: 'No late interest applicable (within grace period)' }

    // Get current agent balance
    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, account_balance, first_name, last_name')
      .eq('id', deal.agent_id)
      .single()

    if (!agent) return { success: false, error: 'Agent not found' }

    const newBalance = (agent.account_balance || 0) + interest

    // Update agent balance
    const { error: balErr } = await serviceClient
      .from('agents')
      .update({ account_balance: newBalance })
      .eq('id', agent.id)

    if (balErr) return { success: false, error: `Failed to update balance: ${balErr.message}` }

    // Record transaction
    const { error: txErr } = await serviceClient
      .from('agent_transactions')
      .insert({
        agent_id: agent.id,
        deal_id: deal.id,
        type: 'late_closing_interest',
        amount: interest,
        running_balance: newBalance,
        description: `Late closing interest for ${deal.property_address} — ${input.actualClosingDate} (expected ${deal.closing_date})`,
        created_by: user.id,
      })

    if (txErr) return { success: false, error: `Failed to record transaction: ${txErr.message}` }

    // Update deal
    await serviceClient
      .from('deals')
      .update({
        actual_closing_date: input.actualClosingDate,
        late_interest_charged: (deal.late_interest_charged || 0) + interest,
        late_interest_calculated_at: new Date().toISOString(),
      })
      .eq('id', deal.id)

    await logAuditEvent({
      action: 'account.late_interest',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        agent_id: agent.id,
        interest_amount: interest,
        expected_closing: deal.closing_date,
        actual_closing: input.actualClosingDate,
        new_balance: newBalance,
      },
    })

    return { success: true, data: { interest, newBalance } }
  } catch (err: any) {
    console.error('Late closing interest error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Deduct balance from next advance
// ============================================================================

export async function deductBalanceFromAdvance(input: {
  dealId: string
  agentId: string
  amount: number
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, account_balance, first_name, last_name')
      .eq('id', input.agentId)
      .single()

    if (!agent) return { success: false, error: 'Agent not found' }
    if ((agent.account_balance || 0) <= 0) return { success: false, error: 'No outstanding balance to deduct' }

    const deductAmount = Math.min(input.amount, agent.account_balance || 0)
    const newBalance = (agent.account_balance || 0) - deductAmount

    const { error: balErr } = await serviceClient
      .from('agents')
      .update({ account_balance: newBalance })
      .eq('id', agent.id)

    if (balErr) return { success: false, error: `Failed to update balance: ${balErr.message}` }

    const { error: txErr } = await serviceClient
      .from('agent_transactions')
      .insert({
        agent_id: agent.id,
        deal_id: input.dealId,
        type: 'balance_deduction',
        amount: -deductAmount,
        running_balance: newBalance,
        description: `Balance deduction from advance`,
        created_by: user.id,
      })

    if (txErr) return { success: false, error: `Failed to record transaction: ${txErr.message}` }

    await logAuditEvent({
      action: 'account.balance_deduction',
      entityType: 'agent',
      entityId: agent.id,
      metadata: { deal_id: input.dealId, deducted: deductAmount, new_balance: newBalance },
    })

    return { success: true, data: { deducted: deductAmount, newBalance } }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Manual balance adjustment (admin)
// ============================================================================

export async function adjustAgentBalance(input: {
  agentId: string
  amount: number
  description: string
  dealId?: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, account_balance')
      .eq('id', input.agentId)
      .single()

    if (!agent) return { success: false, error: 'Agent not found' }

    const newBalance = (agent.account_balance || 0) + input.amount

    const { error: balErr } = await serviceClient
      .from('agents')
      .update({ account_balance: newBalance })
      .eq('id', agent.id)

    if (balErr) return { success: false, error: `Failed to update balance: ${balErr.message}` }

    const { error: txErr } = await serviceClient
      .from('agent_transactions')
      .insert({
        agent_id: agent.id,
        deal_id: input.dealId || null,
        type: input.amount < 0 ? 'credit' : 'adjustment',
        amount: input.amount,
        running_balance: newBalance,
        description: input.description,
        created_by: user.id,
      })

    if (txErr) return { success: false, error: `Failed to record transaction: ${txErr.message}` }

    await logAuditEvent({
      action: 'account.adjustment',
      entityType: 'agent',
      entityId: agent.id,
      metadata: { amount: input.amount, description: input.description, new_balance: newBalance },
    })

    return { success: true, data: { newBalance } }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Generate Invoice
// ============================================================================

export async function generateInvoice(input: {
  agentId: string
  dueDate: string
  notes?: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, first_name, last_name, email, phone, account_balance')
      .eq('id', input.agentId)
      .single()

    if (!agent) return { success: false, error: 'Agent not found' }
    if ((agent.account_balance || 0) <= 0) return { success: false, error: 'Agent has no outstanding balance' }

    // Get unpaid transactions for line items
    const { data: transactions } = await serviceClient
      .from('agent_transactions')
      .select('*')
      .eq('agent_id', agent.id)
      .gt('amount', 0)
      .order('created_at', { ascending: true })

    const lineItems = (transactions || []).map(tx => ({
      description: tx.description,
      amount: tx.amount,
      date: tx.created_at,
      type: tx.type,
    }))

    // Generate invoice number: FF-YYYY-NNNN
    const year = new Date().getFullYear()
    const { data: seqData } = await serviceClient
      .rpc('nextval', { seq_name: 'invoice_number_seq' })

    const seqNum = seqData || Date.now()
    const invoiceNumber = `FF-${year}-${String(seqNum).padStart(4, '0')}`

    const { data: invoice, error: insertErr } = await serviceClient
      .from('agent_invoices')
      .insert({
        agent_id: agent.id,
        invoice_number: invoiceNumber,
        amount: agent.account_balance,
        status: 'pending',
        due_date: input.dueDate,
        agent_name: `${agent.first_name} ${agent.last_name}`,
        agent_email: agent.email,
        agent_phone: agent.phone,
        line_items: lineItems,
        notes: input.notes || null,
        created_by: user.id,
      })
      .select()
      .single()

    if (insertErr) return { success: false, error: `Failed to create invoice: ${insertErr.message}` }

    await logAuditEvent({
      action: 'invoice.create',
      entityType: 'agent',
      entityId: agent.id,
      metadata: { invoice_id: invoice.id, invoice_number: invoiceNumber, amount: agent.account_balance },
    })

    return { success: true, data: { invoice } }
  } catch (err: any) {
    console.error('Generate invoice error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Send Invoice Email
// ============================================================================

export async function sendInvoiceEmail(input: {
  invoiceId: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: invoice } = await serviceClient
      .from('agent_invoices')
      .select('*')
      .eq('id', input.invoiceId)
      .single()

    if (!invoice) return { success: false, error: 'Invoice not found' }

    await sendInvoiceNotification({
      invoiceNumber: invoice.invoice_number,
      agentName: invoice.agent_name,
      agentEmail: invoice.agent_email,
      amount: invoice.amount,
      dueDate: invoice.due_date,
      lineItems: invoice.line_items,
    })

    await serviceClient
      .from('agent_invoices')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', input.invoiceId)

    await logAuditEvent({
      action: 'invoice.sent',
      entityType: 'agent',
      entityId: invoice.agent_id,
      metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number },
    })

    return { success: true }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Mark Invoice as Paid
// ============================================================================

export async function markInvoicePaid(input: {
  invoiceId: string
  paidAmount?: number
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: invoice } = await serviceClient
      .from('agent_invoices')
      .select('*')
      .eq('id', input.invoiceId)
      .single()

    if (!invoice) return { success: false, error: 'Invoice not found' }

    const paidAmount = input.paidAmount || invoice.amount

    // Update invoice
    await serviceClient
      .from('agent_invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString(), paid_amount: paidAmount })
      .eq('id', input.invoiceId)

    // Update agent balance
    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, account_balance')
      .eq('id', invoice.agent_id)
      .single()

    if (agent) {
      const newBalance = Math.max(0, (agent.account_balance || 0) - paidAmount)

      await serviceClient
        .from('agents')
        .update({ account_balance: newBalance })
        .eq('id', agent.id)

      await serviceClient
        .from('agent_transactions')
        .insert({
          agent_id: agent.id,
          type: 'invoice_payment',
          amount: -paidAmount,
          running_balance: newBalance,
          description: `Invoice payment — ${invoice.invoice_number}`,
          reference_id: invoice.id,
          created_by: user.id,
        })
    }

    await logAuditEvent({
      action: 'invoice.paid',
      entityType: 'agent',
      entityId: invoice.agent_id,
      metadata: { invoice_id: invoice.id, paid_amount: paidAmount },
    })

    return { success: true }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Deal Messages — Send message to agent (triggers email)
// ============================================================================

export async function sendDealMessage(input: {
  dealId: string
  message: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: deal } = await serviceClient
      .from('deals')
      .select('id, property_address, agent_id')
      .eq('id', input.dealId)
      .single()

    if (!deal) return { success: false, error: 'Deal not found' }

    const { data: agent } = await serviceClient
      .from('agents')
      .select('first_name, email')
      .eq('id', deal.agent_id)
      .single()

    if (!agent?.email) return { success: false, error: 'Agent email not found' }

    // Insert message
    const { data: msg, error: insertErr } = await serviceClient
      .from('deal_messages')
      .insert({
        deal_id: deal.id,
        sender_id: user.id,
        sender_role: 'admin',
        sender_name: profile?.full_name || 'Firm Funds',
        message: input.message.trim(),
      })
      .select()
      .single()

    if (insertErr) return { success: false, error: `Failed to send message: ${insertErr.message}` }

    // Send email notification
    sendDealMessageNotification({
      dealId: deal.id,
      propertyAddress: deal.property_address,
      agentEmail: agent.email,
      agentFirstName: agent.first_name,
      message: input.message.trim(),
      senderName: profile?.full_name || 'Firm Funds',
    })

    await logAuditEvent({
      action: 'message.sent',
      entityType: 'deal',
      entityId: deal.id,
      metadata: { message_id: msg.id, agent_email: agent.email },
    })

    return { success: true, data: { message: msg } }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Document Return — return an incorrect/incomplete document to agent
// ============================================================================

export async function returnDocument(input: {
  dealId: string
  documentId: string
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Get deal and document info
    const { data: deal } = await serviceClient
      .from('deals')
      .select('id, property_address, agent_id')
      .eq('id', input.dealId)
      .single()

    if (!deal) return { success: false, error: 'Deal not found' }

    const { data: doc } = await serviceClient
      .from('deal_documents')
      .select('id, file_name, document_type')
      .eq('id', input.documentId)
      .single()

    if (!doc) return { success: false, error: 'Document not found' }

    const { data: agent } = await serviceClient
      .from('agents')
      .select('first_name, email')
      .eq('id', deal.agent_id)
      .single()

    if (!agent?.email) return { success: false, error: 'Agent email not found' }

    // Create return record
    const { data: returnRecord, error: insertErr } = await serviceClient
      .from('document_returns')
      .insert({
        deal_id: deal.id,
        document_id: input.documentId,
        returned_by: user.id,
        reason: input.reason.trim(),
        status: 'pending',
      })
      .select()
      .single()

    if (insertErr) return { success: false, error: `Failed to return document: ${insertErr.message}` }

    // Send email notification
    sendDocumentReturnNotification({
      dealId: deal.id,
      propertyAddress: deal.property_address,
      agentEmail: agent.email,
      agentFirstName: agent.first_name,
      documentName: doc.file_name,
      documentType: doc.document_type,
      reason: input.reason.trim(),
    })

    await logAuditEvent({
      action: 'document.returned',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        document_id: input.documentId,
        document_name: doc.file_name,
        reason: input.reason,
        return_id: returnRecord.id,
      },
    })

    return { success: true, data: { returnId: returnRecord.id } }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Resolve Document Return (when agent uploads replacement)
// ============================================================================

export async function resolveDocumentReturn(input: {
  returnId: string
  newDocumentId?: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin', 'agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { error: updateErr } = await serviceClient
      .from('document_returns')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_document_id: input.newDocumentId || null,
      })
      .eq('id', input.returnId)
      .eq('status', 'pending')

    if (updateErr) return { success: false, error: `Failed to resolve return: ${updateErr.message}` }

    await logAuditEvent({
      action: 'document.return_resolved',
      entityType: 'document',
      entityId: input.returnId,
      metadata: { new_document_id: input.newDocumentId },
    })

    return { success: true }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}
