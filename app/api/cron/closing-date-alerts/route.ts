import { createClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { sendClosingDateAlertDigest, sendSettlementReminderClosingDay, sendSettlementReminderPaymentCheckIn } from '@/lib/email'
import { runMonthlyLatePaymentInterest, runMonthlyFailedDealInterest } from '@/lib/late-interest-jobs'
import { SETTLEMENT_PERIOD_DAYS } from '@/lib/constants'
import { logAuditEventServiceRole } from '@/lib/audit'
import { validateCronAuth } from '@/lib/cron-auth'

const JOB_NAME = 'closing_date_alerts'

// =============================================================================
// GET /api/cron/closing-date-alerts
//
// Daily cron job that handles:
// 1. Closing date alerts — approaching and overdue deals → admin digest email
// 2. Settlement period reminders — closing day + post-deadline payment check-in
//    → agent + brokerage
// 3. Mark payment_status='overdue' once deals pass the 30-day late-interest grace
// 4. Post monthly late-payment interest (24% p.a. compounded daily, starting
//    day 31 after closing)
// 5. Post monthly failed-deal interest (24% p.a. compounded daily, CPA 5.3)
//
// Protected by CRON_SECRET header.
// =============================================================================

const APPROACHING_DAYS_THRESHOLD = 7 // Alert for deals closing within 7 days

export async function GET(request: Request) {
  const unauth = validateCronAuth(request)
  if (unauth) return unauth

  // Use service role client to bypass RLS
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return Response.json({ error: 'Missing Supabase config' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Idempotency: claim (job_name, period) row. Period = TORONTO calendar date
  // so duplicate runs on the same business day no-op. Previously this used
  // the UTC date which ticks over at 7–8pm Toronto, causing the period to
  // advance ~5 hours before the rest of the date math in this handler did
  // (everything below uses Toronto-local `today`). At midnight UTC the
  // mismatched period would let an already-completed Toronto day re-fire all
  // its emails. See migration 074 for the cron_run_log shape.
  const serviceClient = createServiceRoleClient()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const period = today
  const { data: claimRow, error: claimErr } = await serviceClient
    .from('cron_run_log')
    .insert({ job_name: JOB_NAME, period })
    .select('id')
    .single()
  if (claimErr && (claimErr as { code?: string }).code === '23505') {
    return Response.json({ already_ran: true, period }, { status: 200 })
  }
  if (claimErr || !claimRow) {
    return Response.json({ error: 'Failed to claim cron run', detail: claimErr?.message }, { status: 500 })
  }
  const runId = claimRow.id

  try {

    // =======================================================================
    // 1. Closing Date Alerts (existing functionality)
    // =======================================================================

    const { data: activeDeals, error } = await supabase
      .from('deals')
      .select('id, property_address, closing_date, days_until_closing, advance_amount, status, agent_id, agents(first_name, last_name)')
      .in('status', ['funded', 'approved'])
      .order('closing_date', { ascending: true })

    if (error) {
      console.error('[cron] Failed to fetch deals:', error.message)
      await serviceClient
        .from('cron_run_log')
        .update({ completed_at: new Date().toISOString(), outcome: 'error', details: { error: error.message } })
        .eq('id', runId)
      return Response.json({ error: 'Failed to fetch deals' }, { status: 500 })
    }

    if (!activeDeals || activeDeals.length === 0) {
      await serviceClient
        .from('cron_run_log')
        .update({ completed_at: new Date().toISOString(), outcome: 'success', details: { approaching: 0, overdue: 0, note: 'no active deals' } })
        .eq('id', runId)
      return Response.json({ message: 'No active deals to check', approaching: 0, overdue: 0 })
    }

    const approachingDeals: {
      id: string; property_address: string; closing_date: string
      days_until_closing: number; advance_amount: number; agent_name: string; status: string
    }[] = []

    const overdueDeals: {
      id: string; property_address: string; closing_date: string
      days_overdue: number; advance_amount: number; agent_name: string; status: string
    }[] = []

    for (const deal of activeDeals) {
      // Supabase types the joined `deal.agents` as an array even for a 1:1 FK
      // join. At runtime it's a single object (or null when there's no match);
      // we read fields defensively below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = deal.agents as any
      const agentName = agent ? `${agent.first_name} ${agent.last_name}` : 'Unknown Agent'
      const closingDate = new Date(deal.closing_date + 'T00:00:00')
      const todayDate = new Date(today + 'T00:00:00')
      const diffMs = closingDate.getTime() - todayDate.getTime()
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

      if (diffDays < 0) {
        overdueDeals.push({
          id: deal.id,
          property_address: deal.property_address,
          closing_date: deal.closing_date,
          days_overdue: Math.abs(diffDays),
          advance_amount: deal.advance_amount,
          agent_name: agentName,
          status: deal.status,
        })
      } else if (diffDays <= APPROACHING_DAYS_THRESHOLD) {
        approachingDeals.push({
          id: deal.id,
          property_address: deal.property_address,
          closing_date: deal.closing_date,
          days_until_closing: diffDays,
          advance_amount: deal.advance_amount,
          agent_name: agentName,
          status: deal.status,
        })
      }
    }

    // Per-iteration error isolation: collect failures, never throw out of the
    // route. We still want late-interest posting to run even if some emails
    // fail.
    const failures: { stage: string; dealId?: string; error: string }[] = []

    // Send admin digest
    if (approachingDeals.length > 0 || overdueDeals.length > 0) {
      try {
        await sendClosingDateAlertDigest({ approachingDeals, overdueDeals })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'send failed'
        failures.push({ stage: 'digest', error: message })
      }
    }

    // Batched recompute: replaces a per-deal UPDATE loop with one set-based
    // UPDATE in the recompute_active_deal_days_until_closing RPC (migration
    // 057). Same GREATEST(0, ...) clamp; only rows whose computed value
    // actually changed get written.
    await supabase.rpc('recompute_active_deal_days_until_closing')

    // =======================================================================
    // 2. Settlement Period Reminders (new)
    // =======================================================================

    // Fetch funded deals with settlement info for reminders.
    // settlement_days_at_funding is the per-deal locked window (7 standard,
    // 14 for brokerages auto-bumped after the 5-strike threshold). Use the
    // snapshot, not the global constant, so reminders fire on the deal's
    // actual deadline.
    const { data: fundedDeals } = await supabase
      .from('deals')
      .select('id, deal_number, property_address, closing_date, due_date, advance_amount, amount_due_from_brokerage, settlement_period_fee, settlement_days_at_funding, agent_id, brokerage_id, agents(first_name, email), brokerages(name, email, broker_of_record_email)')
      .eq('status', 'funded')
      .not('due_date', 'is', null)

    let remindersSent = 0

    if (fundedDeals) {
      for (const deal of fundedDeals) {
        // Same Supabase 1:1 join shape mismatch as above.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agent = deal.agents as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const brokerage = deal.brokerages as any
        if (!agent?.email) continue

        // Skip pre-migration deals
        if (!deal.settlement_period_fee || deal.settlement_period_fee <= 0) continue

        // Per-deal settlement window: 7 days standard, 14 for bumped brokerages.
        // Fall back to the global constant for legacy deals with no snapshot.
        const dealSettlementDays = deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS

        const closingDate = new Date(deal.closing_date + 'T00:00:00')
        const todayDate = new Date(today + 'T00:00:00')
        const daysSinceClosing = Math.floor((todayDate.getTime() - closingDate.getTime()) / (1000 * 60 * 60 * 24))

        const reminderParams = {
          dealId: deal.id,
          dealNumber: deal.deal_number,
          propertyAddress: deal.property_address,
          agentEmail: agent.email,
          agentFirstName: agent.first_name,
          brokerageEmail: brokerage?.email || brokerage?.broker_of_record_email || null,
          brokerageName: brokerage?.name,
          advanceAmount: deal.advance_amount,
          dueDate: deal.due_date!,
          amountDueFromBrokerage: deal.amount_due_from_brokerage,
          daysRemaining: 0,
        }

        // Post-deadline check-in fires once the settlement window has lapsed.
        // For 7-day brokerages this triggers on day 12 (5 days past due); for
        // 14-day brokerages on day 15 (1 day past due). The
        // Math.max(12, ...) floor keeps fast windows from firing too eagerly
        // before the 30-day late-interest grace becomes a near-term concern.
        const checkInTriggerDay = Math.max(12, dealSettlementDays + 1)

        // Closing day (daysSinceClosing === 0): brokerage's settlement window starts today
        if (daysSinceClosing === 0) {
          reminderParams.daysRemaining = dealSettlementDays
          try {
            await sendSettlementReminderClosingDay(reminderParams)
            remindersSent++
            await logAuditEventServiceRole({
              action: 'deal.settlement_reminder_closing_day_sent',
              entityType: 'deal',
              entityId: deal.id,
              actorRole: 'system',
              metadata: {
                deal_id: deal.id,
                agent_id: deal.agent_id,
                brokerage_id: deal.brokerage_id,
                days_since_closing: daysSinceClosing,
                days_remaining: dealSettlementDays,
                settlement_days_at_funding: dealSettlementDays,
                due_date: deal.due_date,
                recipient_agent_email: agent.email,
                recipient_brokerage_email: reminderParams.brokerageEmail,
                cron_job: JOB_NAME,
              },
            })
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'send failed'
            failures.push({ stage: 'reminder_closing_day', dealId: deal.id, error: message })
          }
        }
        // Post-deadline payment check-in: deadline has lapsed but no payment
        // received yet. Toned-down "just checking in" wording (not urgent /
        // accusatory) — the brokerage is at most a few days past due here.
        else if (daysSinceClosing === checkInTriggerDay) {
          // dueDate is YYYY-MM-DD. Compute days elapsed since the deadline
          // (always positive on the trigger day by construction).
          const dueDateObj = new Date(deal.due_date! + 'T00:00:00')
          const daysSinceDue = Math.max(
            0,
            Math.floor((todayDate.getTime() - dueDateObj.getTime()) / (1000 * 60 * 60 * 24))
          )
          try {
            await sendSettlementReminderPaymentCheckIn({ ...reminderParams, daysSinceDue })
            remindersSent++
            await logAuditEventServiceRole({
              action: 'deal.settlement_reminder_payment_check_in_sent',
              entityType: 'deal',
              entityId: deal.id,
              actorRole: 'system',
              metadata: {
                deal_id: deal.id,
                agent_id: deal.agent_id,
                brokerage_id: deal.brokerage_id,
                days_since_closing: daysSinceClosing,
                days_since_due: daysSinceDue,
                settlement_days_at_funding: dealSettlementDays,
                due_date: deal.due_date,
                recipient_agent_email: agent.email,
                recipient_brokerage_email: reminderParams.brokerageEmail,
                cron_job: JOB_NAME,
              },
            })
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'send failed'
            failures.push({ stage: 'reminder_payment_check_in', dealId: deal.id, error: message })
          }
        }
      }
    }

    // =======================================================================
    // 3. Post monthly late-payment interest + flag overdue deals
    //
    // Interest is 24% p.a. compounded daily starting day 31 after closing.
    // Monthly posting cadence mirrors the failed-deal interest pattern: the
    // ledger only gets ONE agent_transactions row per month per deal, posted
    // on the first daily run after a month boundary crosses.
    // =======================================================================

    const lateInterestResult = await runMonthlyLatePaymentInterest()

    // Mark deals past the 30-day late-interest grace as overdue
    // (closing_date + 30 days < today). Earlier than the grace, they're still
    // technically late on settlement but no interest has accrued yet.
    const today30Ago = new Date(today + 'T00:00:00Z')
    today30Ago.setUTCDate(today30Ago.getUTCDate() - 30)
    const overdueThreshold = today30Ago.toISOString().slice(0, 10)

    await supabase
      .from('deals')
      .update({ payment_status: 'overdue' })
      .eq('status', 'funded')
      .eq('payment_status', 'pending')
      .lt('closing_date', overdueThreshold)

    // =======================================================================
    // 4. Post monthly failed-deal interest (CPA 5.3 — 24% p.a. compounded
    //    daily, posted to the ledger once per month on the first daily cron
    //    run after a month boundary crosses)
    // =======================================================================

    const failedDealInterestResult = await runMonthlyFailedDealInterest()

    const partialFailure = failures.length > 0
    const details = {
      approaching: approachingDeals.length,
      overdue: overdueDeals.length,
      total_active: activeDeals.length,
      reminders_sent: remindersSent,
      late_interest: lateInterestResult,
      failed_deal_interest: failedDealInterestResult,
      failures,
    }

    await serviceClient
      .from('cron_run_log')
      .update({
        completed_at: new Date().toISOString(),
        outcome: partialFailure ? 'partial_success' : 'success',
        details,
      })
      .eq('id', runId)

    return Response.json({
      message: 'Daily cron complete',
      approaching: approachingDeals.length,
      overdue: overdueDeals.length,
      total_active: activeDeals.length,
      reminders_sent: remindersSent,
      late_interest: {
        deals_posted: lateInterestResult.charged,
        errors: lateInterestResult.errors,
        details: lateInterestResult.details,
      },
      failed_deal_interest: {
        deals_posted: failedDealInterestResult.charged,
        errors: failedDealInterestResult.errors,
        details: failedDealInterestResult.details,
      },
      failures,
      partial_failure: partialFailure,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error('[cron] Closing date alert error:', message)
    await serviceClient
      .from('cron_run_log')
      .update({
        completed_at: new Date().toISOString(),
        outcome: 'error',
        details: { error: message },
      })
      .eq('id', runId)
    return Response.json({ error: 'Internal error' }, { status: 500 })
  }
}
