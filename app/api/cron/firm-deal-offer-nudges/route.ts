import { createServiceRoleClient } from '@/lib/supabase/server'
import {
  sendBrokerageOfferNudge2h,
  sendInternalEscalation4h,
} from '@/lib/firm-deal-detection/dispatch-brokerage-offer'
import { validateCronAuth } from '@/lib/cron-auth'

const JOB_NAME = 'firm_deal_offer_nudges'

// =============================================================================
// GET /api/cron/firm-deal-offer-nudges
//
// Runs hourly. For each `deals` row in status='offered', does up to three
// time-based things:
//
//   1. 2h after brokerage_notified_at      → nudge the brokerage admin
//      (stamps brokerage_nudge_2h_at)
//   2. 4h after brokerage_notified_at      → aggressive internal email to
//      the Firm Funds inbox so we pick up the phone
//      (stamps internal_alert_4h_at)
//   3. 60 days after created_at            → soft-delete by flipping to
//      'cancelled' with a brokerage_declined_reason marker. The agent's
//      detail page surfaces this as "the offer expired".
//
// Bud's framing (session 36): "This is very time sensitive. We need action
// as soon as possible. We should send a nudge to whoever is selected after
// 2 hours including a new email." + "If we hit 4 hours, it should only
// send Firm Funds an aggressive 4-hour email telling us to get a hold of
// this brokerage asap to get docs."
//
// Protected by CRON_SECRET header. 1-hour idempotency via cron_run_log (we
// want at most one run per period; if the previous run is still in flight
// the next one becomes a no-op).
//
// Suggested cadence on cron-job.org: hourly.
// =============================================================================

const MAX_ROWS_PER_RUN = 200
const NUDGE_2H_MS = 2 * 60 * 60 * 1000
const ESCALATE_4H_MS = 4 * 60 * 60 * 1000
const EXPIRY_60D_MS = 60 * 24 * 60 * 60 * 1000

export async function GET(request: Request) {
  const unauth = validateCronAuth(request)
  if (unauth) return unauth

  const supabase = createServiceRoleClient()
  // Period bucket is the hour (YYYY-MM-DDTHH). One cron firing per hour wins
  // the row; subsequent retries within the same hour become idempotent no-ops.
  const now = new Date()
  const period = now.toISOString().slice(0, 13)
  const { data: claimRow, error: claimErr } = await supabase
    .from('cron_run_log')
    .insert({ job_name: JOB_NAME, period })
    .select('id')
    .single()
  if (claimErr && (claimErr as { code?: string }).code === '23505') {
    return Response.json({ already_ran: true, period }, { status: 200 })
  }
  if (claimErr || !claimRow) {
    return Response.json(
      { error: 'Failed to claim cron run', detail: claimErr?.message },
      { status: 500 }
    )
  }
  const runId = claimRow.id

  try {
    // Pull every offered deal in one shot; the row count for offered will
    // be small (capped by the 60-day window). Sort oldest first so partial
    // runs prioritize the most-overdue rows.
    //
    // Skip rows the agent took over to submit themselves (agent_self_submit_at
    // set, migration 105): the brokerage is paused on those, so we must not
    // nudge/escalate them, and they shouldn't auto-expire while the agent is
    // actively working on submitting. They re-enter this query if the agent
    // hands the offer back (which clears the flag).
    const { data: offered, error: offeredErr } = await supabase
      .from('deals')
      .select(`
        id, created_at, offered_at, brokerage_notified_at,
        brokerage_nudge_2h_at, internal_alert_4h_at
      `)
      .eq('status', 'offered')
      .is('agent_self_submit_at', null)
      .order('offered_at', { ascending: true })
      .limit(MAX_ROWS_PER_RUN)

    if (offeredErr) {
      await markRun(supabase, runId, 'error', { error: offeredErr.message })
      return Response.json({ error: 'Failed to load offered deals' }, { status: 500 })
    }

    if (!offered || offered.length === 0) {
      await markRun(supabase, runId, 'success', { processed: 0, note: 'no offered deals' })
      return Response.json({ message: 'No offered deals to process', processed: 0 })
    }

    const nowMs = Date.now()
    const expired: string[] = []
    const neverNotified: string[] = []
    let nudged2h = 0
    let escalated4h = 0
    // Intentional non-sends (e.g. a brokerage with firm-deal email toggled off,
    // migration 114, or no recipients on file). Tracked apart from `errored` so
    // a deliberately-muted brokerage never marks the run partial_success.
    let skipped = 0
    let errored = 0
    const errors: Array<{ id: string; message?: string }> = []

    for (const row of offered) {
      try {
        const notifiedMs = row.brokerage_notified_at
          ? new Date(row.brokerage_notified_at).getTime()
          : null

        // An offer that was never actually delivered to the brokerage must NOT
        // be auto-expired — that would silently cancel a request that never
        // reached anyone. These rows are stuck because the initial
        // notification failed and is being retried via cron_email_failures.
        // Surface them so they can be re-sent rather than quietly cancelling.
        if (!notifiedMs) {
          neverNotified.push(row.id)
          console.error(
            `[offer-nudges] offered deal ${row.id} has no brokerage_notified_at — ` +
            `never delivered, skipping expiry. Check cron_email_failures for a stuck ` +
            `firm_deal_offer_notification and re-send.`
          )
          continue
        }

        // 60-day expiry takes priority over nudges. The clock runs from the
        // delivery timestamp (brokerage_notified_at), NOT created_at, so an
        // offer only ages out once the brokerage has actually been told about
        // it and had the full window to act. If we're past the window, mark
        // cancelled and skip the rest.
        if (nowMs - notifiedMs >= EXPIRY_60D_MS) {
          await supabase
            .from('deals')
            .update({
              status: 'cancelled',
              brokerage_declined_at: new Date().toISOString(),
              brokerage_declined_reason: 'Offer expired automatically after 60 days without brokerage submission.',
            })
            .eq('id', row.id)
            .eq('status', 'offered')
          expired.push(row.id)
          continue
        }

        // 4h escalation — only fires once, gated by internal_alert_4h_at.
        if (
          nowMs - notifiedMs >= ESCALATE_4H_MS &&
          !row.internal_alert_4h_at
        ) {
          const r = await sendInternalEscalation4h(supabase, row.id)
          if (r.outcome === 'sent') escalated4h++
          else if (r.outcome === 'skipped') skipped++
          else {
            errored++
            errors.push({ id: row.id, message: `escalate_4h: ${r.error}` })
          }
        }

        // 2h nudge — fires once, gated by brokerage_nudge_2h_at. Sent even
        // if the 4h fire above also went, because they target different
        // audiences (brokerage vs Firm Funds inbox).
        if (
          nowMs - notifiedMs >= NUDGE_2H_MS &&
          !row.brokerage_nudge_2h_at
        ) {
          const r = await sendBrokerageOfferNudge2h(supabase, row.id)
          if (r.outcome === 'sent') nudged2h++
          // 'skipped' = brokerage muted firm-deal email (migration 114) or has
          // no recipients on file. Not an error, and we deliberately leave
          // brokerage_nudge_2h_at unstamped so re-enabling email still nudges.
          else if (r.outcome === 'skipped') skipped++
          else {
            errored++
            errors.push({ id: row.id, message: `nudge_2h: ${r.error}` })
          }
        }
      } catch (err) {
        errored++
        errors.push({ id: row.id, message: err instanceof Error ? err.message : 'unknown' })
      }
    }

    const outcome = errored === 0 ? 'success' : 'partial_success'
    await markRun(supabase, runId, outcome, {
      processed: offered.length,
      nudged_2h: nudged2h,
      escalated_4h: escalated4h,
      expired_60d: expired.length,
      never_notified: neverNotified.length,
      never_notified_ids: neverNotified.slice(0, 25),
      skipped,
      errored,
      errors: errors.slice(0, 10),
    })

    return Response.json({
      message: 'firm-deal-offer-nudges complete',
      processed: offered.length,
      nudged_2h: nudged2h,
      escalated_4h: escalated4h,
      expired_60d: expired.length,
      never_notified: neverNotified.length,
      skipped,
      errored,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[offer-nudges] fatal:', msg)
    await markRun(supabase, runId, 'error', { error: msg })
    return Response.json({ error: 'Internal error', detail: msg }, { status: 500 })
  }
}

async function markRun(
  supabase: ReturnType<typeof createServiceRoleClient>,
  runId: string,
  outcome: 'success' | 'partial_success' | 'error',
  details: Record<string, unknown>
) {
  await supabase
    .from('cron_run_log')
    .update({
      completed_at: new Date().toISOString(),
      outcome,
      details,
    })
    .eq('id', runId)
}
