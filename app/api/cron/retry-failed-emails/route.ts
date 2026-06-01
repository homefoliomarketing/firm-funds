import { createServiceRoleClient } from '@/lib/supabase/server'
import {
  sendSettlementReminderClosingDay,
  sendSettlementReminderPaymentCheckIn,
  sendDeadLetterGiveUpAlert,
  sendRemediationOverdueDigest,
  type RemediationOverdueDigestRow,
} from '@/lib/email'
import {
  sendAgentDeclineNotification,
  sendBrokerageOfferNotification,
} from '@/lib/firm-deal-detection/dispatch-brokerage-offer'

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
//   - 'settlement_reminder'           — settlement reminders, both closing-day
//                                        and payment-check-in variants
//   - 'offer_decline' /
//     'firm_deal_decline_notification' — brokerage decline notification to the
//                                        agent (two type strings map to the
//                                        same resend path; the latter is what
//                                        the decline action actually enqueues)
//   - 'firm_deal_offer_notification'  — brokerage "an agent accepted, please
//                                        submit" notification, resent only if
//                                        the deal is still in 'offered' status
//   - 'remediation_overdue_digest'    — daily overdue-remediation digest to the
//                                        Firm Funds inbox
//
// Any other email_type is logged and skipped (the cron does NOT consume the
// attempt_count for unknown types; an operator must either add the case or
// manually mark gave_up_at).
//
// When a row exhausts MAX_ATTEMPTS it is marked gave_up_at AND a loud internal
// alert is emailed to the Firm Funds ops inbox so a permanently-stuck email
// surfaces somewhere a human looks.
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
          // Make the failure LOUD: email the Firm Funds ops inbox so a stuck
          // notification surfaces somewhere a human looks, not just in logs.
          // Best-effort — a failure to send the alert must not break the sweep
          // or re-enter the queue, so we await it and swallow any error.
          try {
            await sendDeadLetterGiveUpAlert({
              failureId: row.id,
              emailType: row.email_type,
              recipient: row.recipient,
              subject: row.subject,
              error: errMsg,
              attemptCount: nextAttempt,
            })
          } catch (alertErr) {
            console.error(
              `[retry-failed-emails] failed to send give-up alert for id=${row.id}:`,
              alertErr instanceof Error ? alertErr.message : alertErr
            )
          }
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
      // Distinguish closing-day vs payment-check-in by the explicit `variant`
      // tag in the payload (preferred — set by the producer when enqueuing).
      // For legacy payloads without `variant`, fall back to a heuristic:
      // payment-check-in payloads carry `daysSinceDue`; closing-day payloads
      // carry `daysRemaining > 0`. Both senders accept the same
      // SettlementReminderParams shape.
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
        daysSinceDue?: number
      }
      const variant = (payload as { variant?: string }).variant
      const isCheckIn =
        variant === 'payment_check_in' ||
        (variant === undefined && typeof params.daysSinceDue === 'number')
      if (isCheckIn) {
        await sendSettlementReminderPaymentCheckIn(params)
      } else {
        await sendSettlementReminderClosingDay(params)
      }
      return
    }
    // Two type strings reach this case. The legacy 'offer_decline' label used
    // camelCase payload keys (dealId/declineReason); the type the decline
    // action actually enqueues today is 'firm_deal_decline_notification' with
    // snake_case keys (deal_id/decline_reason). Accept either shape so neither
    // is dropped into the default branch and retried forever.
    case 'offer_decline':
    case 'firm_deal_decline_notification': {
      const p = payload as {
        dealId?: string
        deal_id?: string
        declineReason?: string
        decline_reason?: string
      }
      const dealId = p.dealId ?? p.deal_id
      const declineReason = p.declineReason ?? p.decline_reason
      if (!dealId || !declineReason) {
        throw new Error('decline notification payload missing deal id or reason')
      }
      const supabase = createServiceRoleClient()
      const result = await sendAgentDeclineNotification(supabase, dealId, declineReason)
      // 'skipped' means the agent has no email on file (intentionally nullable
      // in our schema). There is no recipient to ever retry to, so treat it as
      // resolved rather than burning attempts forever.
      if (result.outcome === 'skipped') return
      if (result.outcome !== 'sent') {
        throw new Error(result.error || `decline notification ${result.outcome}`)
      }
      return
    }
    case 'firm_deal_offer_notification': {
      // Enqueued by acceptFirmDealOffer when the initial brokerage "an agent
      // accepted, please submit" email fails. Payload: { deal_id, event_id,
      // agent_id }. We only need deal_id to resend.
      const { deal_id: dealId } = payload as {
        deal_id?: string
        event_id?: string
        agent_id?: string
      }
      if (!dealId) {
        throw new Error('firm_deal_offer_notification payload missing deal_id')
      }
      const supabase = createServiceRoleClient()
      // Guard against resending a stale offer: if the brokerage already
      // submitted (deal left 'offered'), there is nothing to chase. Mark the
      // row resolved instead of re-sending a misleading "please submit" email.
      const { data: deal } = await supabase
        .from('deals')
        .select('status')
        .eq('id', dealId)
        .maybeSingle()
      if (!deal) {
        // The deal vanished (deleted/cancelled hard). Nothing to resend; stop
        // retrying by treating this as resolved.
        return
      }
      if (deal.status !== 'offered') return
      const result = await sendBrokerageOfferNotification(supabase, dealId)
      // 'skipped' means no recipients configured for the brokerage — no
      // channel to ever deliver to, so stop retrying.
      if (result.outcome === 'skipped') return
      if (result.outcome !== 'sent') {
        throw new Error(result.error || `offer notification ${result.outcome}`)
      }
      return
    }
    case 'remediation_overdue_digest': {
      // Enqueued by /api/cron/remediation-overdue-escalation with the full row
      // set captured at send time: payload = { rows: OverdueRow[] }. Rebuild
      // and resend the digest from that snapshot.
      const { rows } = payload as { rows?: unknown }
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('remediation_overdue_digest payload missing rows')
      }
      await sendRemediationOverdueDigest(rows as RemediationOverdueDigestRow[])
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
