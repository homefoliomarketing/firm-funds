import { createServiceRoleClient } from '@/lib/supabase/server'

const JOB_NAME = 'webhook_dedup_cleanup'

// =============================================================================
// GET /api/cron/webhook-dedup-cleanup
//
// Daily housekeeping: prunes docusign_webhook_events rows older than 30 days.
// We use this table for HMAC-verified webhook dedup (see migration 067) so a
// few weeks of history is plenty — the dedup window is effectively "did we
// already see this event_id in the last few minutes" and we only need enough
// retention to absorb DocuSign's worst-case replay window plus a comfortable
// buffer for forensics.
//
// Idempotent: DELETE is a set-based op, safe to repeat. The cron_run_log
// guard makes it impossible to even run twice in the same daily period.
//
// Suggested cadence: once per day (e.g. 04:00 ET). Cheap regardless of row
// count — the processed_at index makes the predicate sargable.
//
// Protected by CRON_SECRET header. Returns 401 if missing/invalid.
// =============================================================================

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[webhook-dedup-cleanup] CRON_SECRET not configured')
    return Response.json({ error: 'Cron not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceRoleClient()

  // Claim the daily period in Toronto time. Avoids the same UTC-vs-ET bug
  // that bit closing-date-alerts before the fix.
  const period = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
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
    // Cutoff: 30 days ago in UTC. processed_at is a timestamptz so comparing
    // to an ISO string works regardless of session timezone.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Supabase JS doesn't return DELETE row counts unless we either select()
    // the deleted rows back or count first. SELECT-then-DELETE is a tiny race
    // but the dedup table has no FK constraints so we can also do a one-shot
    // delete and use the count() return via the head:true preflight trick.
    // Cleanest: use rpc-style raw delete by chaining .select('event_id') after
    // .delete() — Supabase will return the deleted rows so we can count them.
    const { data: deleted, error: delErr } = await supabase
      .from('docusign_webhook_events')
      .delete()
      .lt('processed_at', cutoff)
      .select('event_id')

    if (delErr) {
      await markRun(supabase, runId, 'error', { error: delErr.message })
      return Response.json({ error: 'Delete failed', detail: delErr.message }, { status: 500 })
    }

    const deletedCount = deleted?.length ?? 0
    await markRun(supabase, runId, 'success', { deleted: deletedCount, cutoff })

    return Response.json({
      message: 'webhook-dedup-cleanup complete',
      deleted: deletedCount,
      cutoff,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[webhook-dedup-cleanup] fatal:', msg)
    await markRun(supabase, runId, 'error', { error: msg })
    return Response.json({ error: 'Internal error', detail: msg }, { status: 500 })
  }
}

async function markRun(
  supabase: ReturnType<typeof createServiceRoleClient>,
  runId: string,
  outcome: 'success' | 'error',
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
