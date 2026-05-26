import { createServiceRoleClient } from '@/lib/supabase/server'
import { pollSpreadsheetPipe, type SpreadsheetPipeConfig } from '@/lib/firm-deal-detection/poll-spreadsheet'

const JOB_NAME = 'firm_deal_poller'

// =============================================================================
// GET /api/cron/firm-deal-poller
//
// 15-minute cron that:
//   1. Loads every enabled brokerage_pipes row of pipe_type='spreadsheet'
//   2. For each pipe, reads the configured tabs from the brokerage's Google
//      Sheet (read-only) and diffs against last_poll_state
//   3. Inserts a firm_deal_events row (status='new') for each detected trigger
//   4. Updates last_polled_at + last_poll_state on the pipe
//
// Phase 1 scope: detection + persistence only. Parsing (Claude), matching,
// notification dispatch all happen downstream in separate jobs.
//
// Protected by CRON_SECRET header. Idempotent at the 15-minute granularity
// via cron_run_log (job_name + period where period = current UTC hour:quarter).
// =============================================================================

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[firm-deal-poller] CRON_SECRET not configured')
    return Response.json({ error: 'Cron not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceRoleClient()

  // Idempotency window: 15-minute bucket so overlapping cron pings on the
  // same quarter-hour no-op. cron_run_log unique(job_name, period).
  const now = new Date()
  const period = `${now.toISOString().slice(0, 13)}:${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, '0')}`
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
    const { data: pipes, error: pipesErr } = await supabase
      .from('brokerage_pipes')
      .select('id, brokerage_id, pipe_type, config, last_poll_state')
      .eq('pipe_type', 'spreadsheet')
      .eq('enabled', true)

    if (pipesErr) {
      await markRun(supabase, runId, 'error', { error: pipesErr.message })
      return Response.json({ error: 'Failed to load pipes', detail: pipesErr.message }, { status: 500 })
    }

    if (!pipes || pipes.length === 0) {
      await markRun(supabase, runId, 'success', { pipes: 0, note: 'no enabled spreadsheet pipes' })
      return Response.json({ message: 'No enabled spreadsheet pipes', pipes: 0 })
    }

    const results = []
    for (const pipe of pipes) {
      try {
        const result = await pollSpreadsheetPipe(
          {
            id: pipe.id,
            brokerage_id: pipe.brokerage_id,
            pipe_type: pipe.pipe_type,
            config: pipe.config as SpreadsheetPipeConfig,
            last_poll_state: pipe.last_poll_state as { tab_by_hash: Record<string, string> } | null,
          },
          supabase
        )
        results.push(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        results.push({
          pipe_id: pipe.id,
          brokerage_id: pipe.brokerage_id,
          errors: [msg],
          rows_seen: 0,
          rows_new_firm: 0,
          rows_carried_over: 0,
          first_poll: false,
        })
      }
    }

    const totalErrors = results.reduce((n, r) => n + (r.errors?.length || 0), 0)
    const outcome = totalErrors === 0 ? 'success' : 'partial_success'
    await markRun(supabase, runId, outcome, {
      pipes: pipes.length,
      results,
    })

    return Response.json({
      message: 'firm-deal-poller complete',
      pipes: pipes.length,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[firm-deal-poller] fatal:', msg)
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
