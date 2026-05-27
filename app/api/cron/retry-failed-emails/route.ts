import { createServiceRoleClient } from '@/lib/supabase/server'
import {
  sendSettlementReminderClosingDay,
  sendSettlementReminder3Day,
} from '@/lib/email'
import { sendAgentDeclineNotification } from '@/lib/firm-deal-detection/dispatch-brokerage-offer'

const JOB_NAME = 'retry_failed_emails'
const RETRY_INTERVAL_MINUTES = 15
const MAX_ATTEMPTS = 5

// =============================================================================
// GET /api/cron/retry-failed-emails
//
// Drains the cron_email_failures dead-letter queue (migration 088). Picks up
// rows where:
//   - succeeded_at IS NULL (not already retried successfully)
//   - gave_up_at IS NULL  (not permanently given up)
//   - attempt_count < MAX_ATTEMPTS
//   - last_attempted_at < NOW() - 15 minutes
//
// For each row, dispatches to the matching retry handler based on email_type.
// Currently supported types:
//   - 'settlement_reminder' — settlement reminders, both closing-day and 3-day variants
//   - 'offer_decline'       — brokerage decline notification to the agent
//
// Any other email_type is logged and skipped (the cron does NOT consume the
// attempt_count for unknown types; an operator must either add the case or
// manually mark gave_up_at).
//
// Suggested cadence: every 15 minutes.
// =============================================================================

interface FailureRow {
  id: string
  cron_job: string
  email_type: string
  recipient: string
  subject: string | null
  payload: Record<string, unknown> | null
  error: string
  attempt_count: number
  last_attempted_at: string
  created_at: string
}

interface RetryOutcome {
  id: string
  email_type: string
  outcome: 'sent' | 'retry_failed' | 'gave_up' | 'skipped_unknown_type'
  detail?: string
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('[retry-failed-emails] CRON_SECRET not configured')
    return Response.json({ error: 'Cron not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceRoleClient()

  // Minute-bucket period — same approach as the firm-deal-processor. Lets
  // the cron run as often as every minute without conflicting with itself,
  // but if the platform retries the same trigger within the minute it no-ops.
  const period = new Date().toISOString().slice(0, 16) // YYYY-MM-DDTHH:MM
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
    const cutoff = new Date(Date.now() - RETRY_INTERVAL_MINUTES * 60 * 1000).toISOString()

    const { data: rows, error: queryErr } = await supabase
      .from('cron_email_failures')
      .select('id, cron_job, email_type, recipient, subject, payload, error, attempt_count, last_attempted_at, created_at')
      .is('succeeded_at', null)
      .is('gave_up_at', null)
      .lt('attempt_count', MAX_ATTEMPTS)
      .lt('last_attempted_at', cutoff)
      .order('last_attempted_at', { ascending: true })
      .limit(50)
      .returns<FailureRow[]>()

    if (queryErr) {
      await markRun(supabase, runId, 'error', { error: queryErr.message })
      return Response.json({ error: 'Query failed', detail: queryErr.message }, { status: 500 })
    }

    const eligible = rows ?? []
    if (eligible.length === 0) {
      await markRun(supabase, runId, 'success', { processed: 0 })
      return Response.json({ message: 'No retryable failures', processed: 0 })
    }

    const outcomes: RetryOutcome[] = []
    let gaveUp = 0
    let sent = 0
    let unknown = 0

    for (const row of eligible) {
      try {
        await attemptRetry(row)
        await supabase
          .from('cron_email_failures')
          .update({
            succeeded_at: new Date().toISOString(),
            attempt_count: row.attempt_count + 1,
            last_attempted_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        outcomes.push({ id: row.id, email_type: row.email_type, outcome: 'sent' })
        sent++
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'unknown error'
        if (errMsg.startsWith('UNKNOWN_EMAIL_TYPE:')) {
          // Don't burn an attempt — type isn't wired up. Operator must add
          // a case below or mark gave_up_at by hand.
          outcomes.push({
            id: row.id,
            email_type: row.email_type,
            outcome: 'skipped_unknown_type',
            detail: errMsg,
          })
          unknown++
          continue
        }
        const nextAttempt = row.attempt_count + 1
        const updates: Record<string, unknown> = {
          attempt_count: nextAttempt,
          last_attempted_at: new Date().toISOString(),
          error: errMsg,
        }
        if (nextAttempt >= MAX_ATTEMPTS) {
          updates.gave_up_at = new Date().toISOString()
          gaveUp++
          // Critical alert: an email permanently failed. Log at error level
          // so it surfaces in Netlify function logs.
          console.error(
            `[retry-failed-emails] CRITICAL — permanent failure: ` +
            `id=${row.id} email_type=${row.email_type} ` +
            `recipient=${row.recipient} error="${errMsg}"`
          )
          outcomes.push({ id: row.id, email_type: row.email_type, outcome: 'gave_up', detail: errMsg })
        } else {
          outcomes.push({ id: row.id, email_type: row.email_type, outcome: 'retry_failed', detail: errMsg })
        }
        await supabase.from('cron_email_failures').update(updates).eq('id', row.id)
      }
    }

    await markRun(supabase, runId, 'success', {
      processed: eligible.length,
      sent,
      gave_up: gaveUp,
      unknown_type: unknown,
    })

    return Response.json({
      message: 'retry-failed-emails complete',
      processed: eligible.length,
      sent,
      gave_up: gaveUp,
      unknown_type: unknown,
      outcomes,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[retry-failed-emails] fatal:', msg)
    await markRun(supabase, runId, 'error', { error: msg })
    return Response.json({ error: 'Internal error', detail: msg }, { status: 500 })
  }
}

async function attemptRetry(row: FailureRow): Promise<void> {
  const payload = row.payload ?? {}
  switch (row.email_type) {
    case 'settlement_reminder': {
      // Distinguish closing-day vs 3-day by daysRemaining in the payload.
      // Both senders use the same SettlementReminderParams shape.
      const params = payload as {
        dealId: string
        propertyAddress: string
        agentEmail: string
        agentFirstName: string
        brokerageEmail?: string | null
        brokerageName?: string
        advanceAmount: number
        dueDate: string
        amountDueFromBrokerage: number
        daysRemaining: number
      }
      const variant = (payload as { variant?: string }).variant
      if (variant === 'closing_day' || params.daysRemaining > 3) {
        await sendSettlementReminderClosingDay(params)
      } else {
        await sendSettlementReminder3Day(params)
      }
      return
    }
    case 'offer_decline': {
      const { dealId, declineReason } = payload as {
        dealId: string
        declineReason: string
      }
      if (!dealId || !declineReason) {
        throw new Error('offer_decline payload missing dealId or declineReason')
      }
      const supabase = createServiceRoleClient()
      const result = await sendAgentDeclineNotification(supabase, dealId, declineReason)
      if (result.outcome !== 'sent') {
        throw new Error(result.error || `decline notification ${result.outcome}`)
      }
      return
    }
    default:
      // TODO: add cases for new email_types as they get added to dead-letter
      // inserts elsewhere in the codebase. See migration 088 for the table
      // shape and lib/email.ts for the available sender functions.
      throw new Error(`UNKNOWN_EMAIL_TYPE: no retry handler wired for "${row.email_type}"`)
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
