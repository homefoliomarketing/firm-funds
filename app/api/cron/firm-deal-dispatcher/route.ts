import { createServiceRoleClient } from '@/lib/supabase/server'
import { dispatchFirmDealNotification } from '@/lib/firm-deal-detection/dispatch-notification'
import { validateCronAuth } from '@/lib/cron-auth'

const JOB_NAME = 'firm_deal_dispatcher'

// =============================================================================
// GET /api/cron/firm-deal-dispatcher
//
// Picks up firm_deal_events rows in status='approved' and sends the email +
// SMS pair. Two paths land in 'approved':
//   1. Manual review: admin clicked Send in the review queue UI.
//   2. Auto-fire: brokerage_pipes.auto_fire_enabled=true and matching
//      moved the row straight from 'new' to 'approved'.
//
// The dispatcher itself is mode-agnostic. For Phase 1 (manual review only)
// this cron is mostly idle - manual sends are also wired to call the
// dispatch function inline from the server action. The cron is a safety
// net for retries and the future auto-fire path.
//
// Protected by CRON_SECRET header. 1-minute idempotency via cron_run_log.
// Suggested cadence: every 1-2 minutes.
// =============================================================================

const MAX_ROWS_PER_RUN = 50

export async function GET(request: Request) {
  const unauth = validateCronAuth(request)
  if (unauth) return unauth

  const supabase = createServiceRoleClient()

  const now = new Date()
  const period = now.toISOString().slice(0, 16) // 'YYYY-MM-DDTHH:MM'
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
    const { data: pending, error: pendingErr } = await supabase
      .from('firm_deal_events')
      .select('id')
      .eq('status', 'approved')
      .order('received_at', { ascending: true })
      .limit(MAX_ROWS_PER_RUN)

    if (pendingErr) {
      await markRun(supabase, runId, 'error', { error: pendingErr.message })
      return Response.json({ error: 'Failed to load pending events' }, { status: 500 })
    }

    if (!pending || pending.length === 0) {
      await markRun(supabase, runId, 'success', { dispatched: 0, note: 'no approved events' })
      return Response.json({ message: 'No approved events to dispatch', dispatched: 0 })
    }

    let sent = 0
    let errored = 0
    let skipped = 0
    const errors: Array<{ id: string; message?: string }> = []

    for (const row of pending) {
      try {
        const r = await dispatchFirmDealNotification(row.id, supabase)
        if (r.outcome === 'offer_sent') sent++
        else if (r.outcome === 'errored') {
          errored++
          errors.push({ id: row.id, message: r.message })
        } else skipped++
      } catch (err) {
        errored++
        errors.push({ id: row.id, message: err instanceof Error ? err.message : 'unknown' })
      }
    }

    const outcome = errored === 0 ? 'success' : 'partial_success'
    await markRun(supabase, runId, outcome, {
      dispatched: sent,
      errored,
      skipped,
      errors: errors.slice(0, 10),
    })

    return Response.json({
      message: 'firm-deal-dispatcher complete',
      dispatched: sent,
      errored,
      skipped,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[firm-deal-dispatcher] fatal:', msg)
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
