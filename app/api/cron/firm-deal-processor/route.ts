import { createServiceRoleClient } from '@/lib/supabase/server'
import { processNewEventsForBrokerage } from '@/lib/firm-deal-detection/process-event'
import { validateCronAuth } from '@/lib/cron-auth'

const JOB_NAME = 'firm_deal_processor'

// =============================================================================
// GET /api/cron/firm-deal-processor
//
// Picks up every firm_deal_events row in status='new' (or 'errored' for retry)
// and runs the full pipeline: parse (Claude Haiku 4.5) -> dedup -> match
// agents -> transition status. Idempotent at the row level; safe to run
// frequently.
//
// Deliberately separate from the poller so a stuck Anthropic call can't
// block the next sheet read, and so we can retry errored events without
// repolling.
//
// Suggested cron cadence: every 1-2 minutes. Cheap when no new events;
// every event costs <$0.003 (Haiku 4.5 with prompt caching).
//
// Protected by CRON_SECRET header. Idempotent at the minute granularity
// via cron_run_log unique(job_name, period).
// =============================================================================

export async function GET(request: Request) {
  const unauth = validateCronAuth(request)
  if (unauth) return unauth

  const supabase = createServiceRoleClient()

  // Idempotency window: 1-minute bucket. Multiple pings within the same
  // minute no-op via cron_run_log unique(job_name, period).
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
    // Find every brokerage that has at least one status='new' event waiting
    const { data: pending, error: pendingErr } = await supabase
      .from('firm_deal_events')
      .select('brokerage_id')
      .eq('status', 'new')
      .order('received_at', { ascending: true })

    if (pendingErr) {
      await markRun(supabase, runId, 'error', { error: pendingErr.message })
      return Response.json({ error: 'Failed to load pending events', detail: pendingErr.message }, { status: 500 })
    }

    const brokerageIds = Array.from(new Set((pending ?? []).map(r => r.brokerage_id as string)))
    if (brokerageIds.length === 0) {
      await markRun(supabase, runId, 'success', { processed: 0, note: 'no new events' })
      return Response.json({ message: 'No new events to process', processed: 0 })
    }

    const summaryByBrokerage: Record<string, Record<string, number>> = {}
    let totalProcessed = 0
    let totalErrored = 0

    for (const brokerageId of brokerageIds) {
      try {
        const results = await processNewEventsForBrokerage(brokerageId, supabase)
        const counts: Record<string, number> = {}
        for (const r of results) {
          counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
          totalProcessed++
          if (r.outcome === 'errored') totalErrored++
        }
        summaryByBrokerage[brokerageId] = counts
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        summaryByBrokerage[brokerageId] = { fatal_error: 1 }
        totalErrored++
        console.error(`[firm-deal-processor] brokerage ${brokerageId} fatal:`, msg)
      }
    }

    const outcome = totalErrored === 0 ? 'success' : 'partial_success'
    await markRun(supabase, runId, outcome, {
      processed: totalProcessed,
      brokerages: brokerageIds.length,
      summary: summaryByBrokerage,
    })

    return Response.json({
      message: 'firm-deal-processor complete',
      processed: totalProcessed,
      brokerages: brokerageIds.length,
      summary: summaryByBrokerage,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[firm-deal-processor] fatal:', msg)
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
