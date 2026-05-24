'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import { logAuditEvent } from '@/lib/audit'
import {
  calculateLateInterest,
  calculateCompoundDailyInterest,
  failedDealAccrualStartDate,
  lateInterestAccrualStartDate,
} from '@/lib/calculations'
import { formatCurrency } from '@/lib/formatting'
import { LATE_INTEREST_RATE_PER_ANNUM } from '@/lib/constants'
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
// Late Payment Interest — Manual charge (admin triggers for a specific deal)
//
// 24% per annum, COMPOUNDED daily on the advance amount, starting day 31 after
// the closing date (LATE_INTEREST_GRACE_DAYS_FROM_CLOSING). Days 0-30 after
// closing are penalty-free regardless of when the brokerage actually pays.
// Used when an admin wants to manually post interest mid-month (the daily
// cron auto-posts monthly, but admins can preempt that for a specific deal).
// ============================================================================

export async function chargeLatePaymentInterest(input: {
  dealId: string
  throughDate: string // calculate interest through this date
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: deal, error: dealErr } = await serviceClient
      .from('deals')
      .select('id, agent_id, advance_amount, closing_date, property_address, late_interest_charged')
      .eq('id', input.dealId)
      .single()

    if (dealErr || !deal) return { success: false, error: 'Deal not found' }
    if (!deal.closing_date) return { success: false, error: 'Deal has no closing date set' }

    // Calculate total compound interest owed from day 31 after closing through throughDate
    const closingStr = typeof deal.closing_date === 'string'
      ? deal.closing_date.slice(0, 10)
      : new Date(deal.closing_date as any).toISOString().slice(0, 10)

    const totalInterestOwed = calculateLateInterest(deal.advance_amount, closingStr, input.throughDate)
    const alreadyCharged = Number(deal.late_interest_charged) || 0
    const interest = Math.round((totalInterestOwed - alreadyCharged) * 100) / 100

    if (interest < 0.005) return { success: false, error: 'No additional late interest accrued (still in 30-day grace or already posted)' }

    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, account_balance, first_name, last_name')
      .eq('id', deal.agent_id)
      .single()

    if (!agent) return { success: false, error: 'Agent not found' }

    const newBalance = (agent.account_balance || 0) + interest

    const { error: balErr } = await serviceClient
      .from('agents')
      .update({ account_balance: newBalance })
      .eq('id', agent.id)

    if (balErr) return { success: false, error: `Failed to update balance: ${balErr.message}` }

    const accrualStart = lateInterestAccrualStartDate(closingStr)

    const { error: txErr } = await serviceClient
      .from('agent_transactions')
      .insert({
        agent_id: agent.id,
        deal_id: deal.id,
        type: 'late_payment_interest',
        amount: interest,
        running_balance: newBalance,
        description: `Late payment interest — ${deal.property_address} (${(LATE_INTEREST_RATE_PER_ANNUM * 100).toFixed(0)}% p.a. compounded daily, accruing from ${accrualStart})`,
        created_by: user.id,
      })

    if (txErr) return { success: false, error: `Failed to record transaction: ${txErr.message}` }

    await serviceClient
      .from('deals')
      .update({
        late_interest_charged: totalInterestOwed,
        late_interest_calculated_at: new Date().toISOString(),
      })
      .eq('id', deal.id)

    await logAuditEvent({
      action: 'account.late_payment_interest',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        agent_id: agent.id,
        interest_amount: interest,
        closing_date: closingStr,
        accrual_start: accrualStart,
        through_date: input.throughDate,
        rate: `${(LATE_INTEREST_RATE_PER_ANNUM * 100).toFixed(0)}% p.a. compounded daily`,
        new_balance: newBalance,
      },
    })

    return { success: true, data: { interest, newBalance } }
  } catch (err: any) {
    console.error('Late payment interest error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Auto-post monthly late-payment interest (called by daily cron)
//
// Mirrors the failed-deal monthly poster pattern: math compounds daily on the
// advance amount, but the agent's ledger only gets one agent_transactions row
// per month per overdue deal. Posting happens on the first daily cron run on
// or after the 1st of each new month. Between postings, the "live" liability
// is computed via liveLateInterestOwed() so admins see what's accruing.
//
// Accrual starts on day 31 after closing (LATE_INTEREST_GRACE_DAYS_FROM_CLOSING).
// Deals that are still within the 30-day grace are skipped entirely (they
// don't owe any interest yet).
//
// Idempotent: re-running the same day is a no-op. Self-healing across missed
// runs: the next run still posts whatever's owed through end-of-last-month.
// ============================================================================

export async function autoChargeMonthlyLatePaymentInterest(): Promise<{
  charged: number
  errors: number
  details: { dealId: string; interest: number; postedFor: string }[]
}> {
  const serviceClient = createServiceRoleClient()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

  const { data: overdueDeals } = await serviceClient
    .from('deals')
    .select('id, agent_id, advance_amount, closing_date, property_address, settlement_period_fee, late_interest_charged, late_interest_calculated_at')
    .eq('status', 'funded')
    .not('closing_date', 'is', null)

  const result = { charged: 0, errors: 0, details: [] as { dealId: string; interest: number; postedFor: string }[] }
  if (!overdueDeals || overdueDeals.length === 0) return result

  const currentMonthBucket = monthBucket(today)
  const endOfLastMonth = endOfPreviousMonth(today)
  const lastMonthBucket = monthBucket(endOfLastMonth)
  const lastMonthName = formatMonthName(lastMonthBucket)

  for (const deal of overdueDeals) {
    // Skip pre-migration deals (no settlement period fee = old fee system)
    if (!deal.settlement_period_fee || deal.settlement_period_fee <= 0) continue
    if (!deal.closing_date) continue

    try {
      const closingStr = typeof deal.closing_date === 'string'
        ? deal.closing_date.slice(0, 10)
        : new Date(deal.closing_date as any).toISOString().slice(0, 10)

      const accrualStart = lateInterestAccrualStartDate(closingStr)

      // Skip deals still inside the 30-day grace as of end-of-last-month
      if (accrualStart > endOfLastMonth) continue

      // Skip if we've already posted FOR last month (calc'd_at is in current month)
      const lastCalc = deal.late_interest_calculated_at as string | null
      if (lastCalc) {
        const lastCalcDate = new Date(lastCalc).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
        if (monthBucket(lastCalcDate) === currentMonthBucket) continue
      }

      const advance = Number(deal.advance_amount) || 0
      const totalInterestThroughLastMonth = calculateCompoundDailyInterest(advance, accrualStart, endOfLastMonth)
      const alreadyCharged = Number(deal.late_interest_charged) || 0
      const interestToCharge = Math.round((totalInterestThroughLastMonth - alreadyCharged) * 100) / 100

      if (interestToCharge < 0.005) continue

      const { data: agent } = await serviceClient
        .from('agents')
        .select('id, account_balance')
        .eq('id', deal.agent_id)
        .single()
      if (!agent) continue

      const newBalance = (agent.account_balance || 0) + interestToCharge

      await serviceClient
        .from('agents')
        .update({ account_balance: newBalance })
        .eq('id', agent.id)

      await serviceClient
        .from('agent_transactions')
        .insert({
          agent_id: agent.id,
          deal_id: deal.id,
          type: 'late_payment_interest',
          amount: interestToCharge,
          running_balance: newBalance,
          description: `Late payment interest — ${lastMonthName} — ${deal.property_address} (${(LATE_INTEREST_RATE_PER_ANNUM * 100).toFixed(0)}% p.a. compounded daily on ${formatCurrency(advance)})`,
        })

      await serviceClient
        .from('deals')
        .update({
          late_interest_charged: totalInterestThroughLastMonth,
          late_interest_calculated_at: new Date().toISOString(),
          payment_status: 'overdue',
        })
        .eq('id', deal.id)

      result.charged++
      result.details.push({ dealId: deal.id, interest: interestToCharge, postedFor: lastMonthName })
    } catch (err) {
      console.error(`Auto-charge error for deal ${deal.id}:`, err)
      result.errors++
    }
  }

  return result
}

// ============================================================================
// Failed-deal interest — pure helpers used by both the monthly poster
// (autoChargeMonthlyFailedDealInterest) and the live-balance UI/IDP code.
//
// CPA Article 5.3: interest at 24% per annum accrues on the unpaid balance of
// a failed-to-close deal "from the thirty-first (31st) day" after the demand
// notice (the demand notice is sent when the deal is marked failed_to_close).
// Days 1-30 = grace; day 31+ = accruing.
//
// Math compounds daily — interest accrues on prior accrued interest, not just
// on the principal. Posted to the ledger ONCE PER MONTH (on the first daily
// cron run after a month boundary crosses). Between postings the live
// liability grows daily but the ledger doesn't change.
// ============================================================================

/** Last day of the previous calendar month (Toronto) as YYYY-MM-DD. */
function endOfPreviousMonth(today: string): string {
  const [y, m] = today.split('-').map(Number)
  // First of current month minus one day = last of previous month
  const firstOfCurrent = new Date(Date.UTC(y, m - 1, 1))
  const lastOfPrev = new Date(firstOfCurrent.getTime() - 24 * 60 * 60 * 1000)
  return lastOfPrev.toISOString().slice(0, 10)
}

/** Calendar month bucket for a date string, YYYY-MM. */
function monthBucket(dateStr: string): string {
  return dateStr.slice(0, 7)
}

/** Pretty month name + year, e.g. "April 2026". */
function formatMonthName(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-CA', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// ============================================================================
// Monthly failed-deal interest poster (called by daily cron)
//
// The cron runs every day, but this function only POSTS to the ledger when a
// month boundary has been crossed since the last posting on a given deal.
// Between postings:
//   - The agent's "live" liability still grows daily (computed via
//     liveFailedDealInterestOwed when needed for IDP signing or UI display)
//   - account_balance and failed_deal_interest_charged are NOT touched daily
//
// At month boundary (the first daily run on or after the 1st of a new month):
//   - Compute total compound interest owed through end of LAST month
//   - Post the delta (since the last posting) as a single agent_transactions
//     row, type='failed_deal_interest', description tagged with the month
//   - Update failed_deal_interest_charged + account_balance
//
// Idempotent: re-running the same day is a no-op (failed_deal_interest_charged
// already at the end-of-last-month figure). Self-healing across missed runs:
// the next run still posts whatever's owed through end-of-last-month.
//
// Continues posting even after the agent elects commission_assignment (CPA
// 5.7 — interest continues until the balance is satisfied in full).
// ============================================================================

export async function autoChargeMonthlyFailedDealInterest(): Promise<{
  charged: number
  errors: number
  details: { dealId: string; interest: number; postedFor: string }[]
}> {
  const serviceClient = createServiceRoleClient()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

  const { data: failedDeals } = await serviceClient
    .from('deals')
    .select('id, agent_id, outstanding_balance, failed_to_close_at, property_address, failed_deal_interest_charged, failed_deal_interest_calculated_at')
    .eq('status', 'failed_to_close')
    .gt('outstanding_balance', 0)

  const result = { charged: 0, errors: 0, details: [] as { dealId: string; interest: number; postedFor: string }[] }
  if (!failedDeals || failedDeals.length === 0) return result

  const currentMonthBucket = monthBucket(today)
  const endOfLastMonth = endOfPreviousMonth(today)
  const lastMonthBucket = monthBucket(endOfLastMonth)
  const lastMonthName = formatMonthName(lastMonthBucket)

  for (const deal of failedDeals) {
    if (!deal.failed_to_close_at) continue

    try {
      const accrualStart = failedDealAccrualStartDate(deal.failed_to_close_at as string)

      // Nothing to post if the grace period hasn't ended by end-of-last-month
      // (i.e. the failed deal is too new to have any "last month" accrual).
      if (accrualStart > endOfLastMonth) continue

      // Skip if we've already posted FOR last month (calc'd_at falls within
      // current month → we already booked last month's interest this month).
      const lastCalc = deal.failed_deal_interest_calculated_at as string | null
      if (lastCalc) {
        const lastCalcDate = new Date(lastCalc).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
        if (monthBucket(lastCalcDate) === currentMonthBucket) continue
      }

      const principal = Number(deal.outstanding_balance) || 0
      // Total compound interest owed THROUGH END OF LAST MONTH (not through today).
      const totalInterestThroughLastMonth = calculateCompoundDailyInterest(principal, accrualStart, endOfLastMonth)
      const alreadyCharged = Number(deal.failed_deal_interest_charged) || 0
      const interestToCharge = Math.round((totalInterestThroughLastMonth - alreadyCharged) * 100) / 100

      // Nothing to charge: already at-or-above the through-last-month figure
      // (e.g. cron run twice the same month, or a prior overshoot).
      if (interestToCharge < 0.005) continue

      const { data: agent } = await serviceClient
        .from('agents')
        .select('id, account_balance')
        .eq('id', deal.agent_id)
        .single()
      if (!agent) continue

      const newBalance = (agent.account_balance || 0) + interestToCharge

      await serviceClient
        .from('agents')
        .update({ account_balance: newBalance })
        .eq('id', agent.id)

      await serviceClient
        .from('agent_transactions')
        .insert({
          agent_id: agent.id,
          deal_id: deal.id,
          type: 'failed_deal_interest',
          amount: interestToCharge,
          running_balance: newBalance,
          description: `Failed-deal interest — ${lastMonthName} — ${deal.property_address} (${(LATE_INTEREST_RATE_PER_ANNUM * 100).toFixed(0)}% p.a. compounded daily on ${formatCurrency(principal)})`,
        })

      await serviceClient
        .from('deals')
        .update({
          failed_deal_interest_charged: totalInterestThroughLastMonth,
          failed_deal_interest_calculated_at: new Date().toISOString(),
        })
        .eq('id', deal.id)

      result.charged++
      result.details.push({ dealId: deal.id, interest: interestToCharge, postedFor: lastMonthName })
    } catch (err) {
      console.error(`Failed-deal monthly interest post error for deal ${deal.id}:`, err)
      result.errors++
    }
  }

  return result
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

    // Send email notification — throttled to 1 per deal per 15 min to avoid spam during back-and-forth
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { data: recentAdminMsgs } = await serviceClient
      .from('deal_messages')
      .select('id')
      .eq('deal_id', deal.id)
      .eq('sender_role', 'admin')
      .neq('id', msg.id) // exclude the message we just inserted
      .gte('created_at', fifteenMinsAgo)
      .limit(1)

    const shouldSendEmail = !recentAdminMsgs || recentAdminMsgs.length === 0

    if (shouldSendEmail) {
      sendDealMessageNotification({
        dealId: deal.id,
        propertyAddress: deal.property_address,
        agentEmail: agent.email,
        agentFirstName: agent.first_name,
        message: input.message.trim(),
        senderName: profile?.full_name || 'Firm Funds',
      })
    }

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
// Fetch Agent Transactions — used by both agent portal (own) and admin portal
// ============================================================================

export async function getAgentTransactions(agentId: string): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin', 'agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  // If agent role, verify they can only access their own transactions
  if (profile?.role === 'agent' && profile?.agent_id !== agentId) {
    return { success: false, error: 'Access denied' }
  }

  try {
    const { data: transactions, error } = await serviceClient
      .from('agent_transactions')
      .select('id, agent_id, deal_id, type, amount, running_balance, description, reference_id, created_by, created_at')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })

    if (error) return { success: false, error: error.message }

    // Also fetch the agent's current balance
    const { data: agent } = await serviceClient
      .from('agents')
      .select('account_balance')
      .eq('id', agentId)
      .single()

    return {
      success: true,
      data: {
        transactions: transactions || [],
        currentBalance: agent?.account_balance ?? 0,
      },
    }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Fetch Agent Balance Summary — lightweight call for dashboard widgets
// ============================================================================

export async function getAgentBalanceSummary(agentId: string): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin', 'agent'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (profile?.role === 'agent' && profile?.agent_id !== agentId) {
    return { success: false, error: 'Access denied' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: agent } = await serviceClient
      .from('agents')
      .select('account_balance')
      .eq('id', agentId)
      .single()

    const { count } = await serviceClient
      .from('agent_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)

    return {
      success: true,
      data: {
        balance: agent?.account_balance ?? 0,
        transactionCount: count ?? 0,
      },
    }
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
