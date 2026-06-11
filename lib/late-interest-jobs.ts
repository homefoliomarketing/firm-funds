// ============================================================================
// Late-payment + failed-deal monthly interest jobs (server-only)
// ============================================================================
// SECURITY (SEC-01): these two functions move money — they post interest to
// agent ledgers via the apply_late_payment_interest / apply_failed_deal_interest
// RPCs using the RLS-bypassing service-role client. They MUST only run from a
// trusted, already-authenticated context:
//
//   - the daily cron (app/api/cron/closing-date-alerts/route.ts), which gates
//     on CRON_SECRET before importing/calling these, and
//   - the money.write-gated server-action wrappers in lib/actions/account-actions.ts
//     (runMonthlyLatePaymentInterest / runMonthlyFailedDealInterest).
//
// This module deliberately does NOT carry the 'use server' directive, so none of
// its exports can be reached as a Server Action POST endpoint. Previously the
// job bodies lived directly in the 'use server' account-actions.ts module with
// no caller-auth check, which violated the project rule (and Next.js's own
// guidance) that every service-role mutation verify the caller first. Moving the
// logic here keeps the cron path working while removing the unauthenticated
// server-action surface.
//
// Both posters compound interest daily but write at most ONE agent_transactions
// row per month per deal (posted on the first daily cron run after a month
// boundary crosses). They are idempotent and self-healing across missed runs.
// ============================================================================

import { createServiceRoleClient } from '@/lib/supabase/server'
import {
  calculateCompoundDailyInterest,
  failedDealAccrualStartDate,
  lateInterestAccrualStartDate,
} from '@/lib/calculations'

export interface MonthlyInterestRunResult {
  charged: number
  errors: number
  details: { dealId: string; interest: number; postedFor: string }[]
}

// ---------------------------------------------------------------------------
// Shared date helpers (Toronto-anchored month math)
// ---------------------------------------------------------------------------

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
// Auto-post monthly late-payment interest (called by daily cron)
//
// Math compounds daily on the advance amount, but the agent's ledger only gets
// one agent_transactions row per month per overdue deal. Posting happens on the
// first daily cron run on or after the 1st of each new month. Accrual starts on
// day 31 after closing (LATE_INTEREST_GRACE_DAYS_FROM_CLOSING). Deals still in
// the 30-day grace are skipped entirely. Idempotent + self-healing.
// ============================================================================

export async function runMonthlyLatePaymentInterest(): Promise<MonthlyInterestRunResult> {
  const serviceClient = createServiceRoleClient()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

  // Pull brokerage_payments and amount_due_from_brokerage so we can skip
  // deals the brokerage has already paid (Finding 13 — late-payment cron was
  // charging interest on settled deals while admin paperwork lagged).
  const { data: overdueDeals } = await serviceClient
    .from('deals')
    .select('id, agent_id, advance_amount, closing_date, property_address, settlement_period_fee, late_interest_calculated_at, amount_due_from_brokerage, brokerage_payments(amount, status)')
    .eq('status', 'funded')
    .not('closing_date', 'is', null)

  const result: MonthlyInterestRunResult = { charged: 0, errors: 0, details: [] }
  if (!overdueDeals || overdueDeals.length === 0) return result

  const currentMonthBucket = monthBucket(today)
  const endOfLastMonth = endOfPreviousMonth(today)
  const lastMonthBucket = monthBucket(endOfLastMonth)
  const lastMonthName = formatMonthName(lastMonthBucket)

  for (const deal of overdueDeals) {
    // Skip pre-migration deals (no settlement period fee = old fee system)
    if (!deal.settlement_period_fee || deal.settlement_period_fee <= 0) continue
    if (!deal.closing_date) continue

    // Skip deals that the brokerage has already paid in full. Without this,
    // interest accrues on settled debt whenever admin is slow to flip status
    // from funded → completed. Cent-level tolerance to handle minor rounding.
    const amountDue = Number(deal.amount_due_from_brokerage) || 0
    if (amountDue > 0) {
      const payments = (deal.brokerage_payments as { amount: number; status: string }[] | null) || []
      const confirmedTotal = payments
        .filter((p) => p.status === 'confirmed')
        .reduce((s, p) => s + (Number(p.amount) || 0), 0)
      if (confirmedTotal >= amountDue - 0.01) continue
    }

    try {
      const closingStr = typeof deal.closing_date === 'string'
        ? deal.closing_date.slice(0, 10)
        : new Date(deal.closing_date as string | number | Date).toISOString().slice(0, 10)

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

      const { data: rpcResult, error: rpcErr } = await serviceClient
        .rpc('apply_late_payment_interest', {
          p_deal_id: deal.id,
          p_total_interest_owed_through: totalInterestThroughLastMonth,
          p_through_date: endOfLastMonth,
          p_agent_id: deal.agent_id,
          p_created_by: null,
        })
      if (rpcErr || !rpcResult) {
        console.error(`Auto-charge late interest RPC failed for deal ${deal.id}:`, rpcErr?.message)
        result.errors++
        continue
      }

      const rpcData = rpcResult as { delta_posted: number; already_charged: number; total_after: number; skipped: boolean }
      if (rpcData.skipped) continue

      // CAS on payment_status='pending' so a concurrent payment confirmation
      // can't be clobbered back to overdue.
      await serviceClient
        .from('deals')
        .update({ payment_status: 'overdue' })
        .eq('id', deal.id)
        .eq('payment_status', 'pending')

      result.charged++
      result.details.push({ dealId: deal.id, interest: rpcData.delta_posted, postedFor: lastMonthName })
    } catch (err) {
      console.error(`Auto-charge error for deal ${deal.id}:`, err)
      result.errors++
    }
  }

  return result
}

// ============================================================================
// Monthly failed-deal interest poster (called by daily cron)
//
// CPA Article 5.3: interest at 24% per annum accrues on the unpaid balance of a
// failed-to-close deal from the 31st day after the demand notice. Days 1-30 =
// grace; day 31+ = accruing. Compounds daily; posted to the ledger ONCE PER
// MONTH (first daily cron run after a month boundary). Idempotent + self-healing.
// Continues posting even after the agent elects commission_assignment (CPA 5.7).
// ============================================================================

export async function runMonthlyFailedDealInterest(): Promise<MonthlyInterestRunResult> {
  const serviceClient = createServiceRoleClient()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

  const { data: failedDeals } = await serviceClient
    .from('deals')
    .select('id, agent_id, outstanding_balance, failed_to_close_at, property_address, failed_deal_interest_calculated_at')
    .eq('status', 'failed_to_close')
    .gt('outstanding_balance', 0)

  const result: MonthlyInterestRunResult = { charged: 0, errors: 0, details: [] }
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
      const totalInterestThroughLastMonth = calculateCompoundDailyInterest(principal, accrualStart, endOfLastMonth)

      const { data: rpcResult, error: rpcErr } = await serviceClient
        .rpc('apply_failed_deal_interest', {
          p_deal_id: deal.id,
          p_total_interest_owed_through: totalInterestThroughLastMonth,
          p_through_date: endOfLastMonth,
          p_agent_id: deal.agent_id,
          p_created_by: null,
        })
      if (rpcErr || !rpcResult) {
        console.error(`Failed-deal monthly interest RPC failed for deal ${deal.id}:`, rpcErr?.message)
        result.errors++
        continue
      }

      const rpcData = rpcResult as { delta_posted: number; already_charged: number; total_after: number; skipped: boolean }
      if (rpcData.skipped) continue

      result.charged++
      result.details.push({ dealId: deal.id, interest: rpcData.delta_posted, postedFor: lastMonthName })
    } catch (err) {
      console.error(`Failed-deal monthly interest post error for deal ${deal.id}:`, err)
      result.errors++
    }
  }

  return result
}
