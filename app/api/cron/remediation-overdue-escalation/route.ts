import { Resend } from 'resend'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { validateCronAuth } from '@/lib/cron-auth'

const JOB_NAME = 'remediation_overdue_escalation'
const OVERDUE_THRESHOLD_DAYS = 14
const FF_INBOX = process.env.FIRM_FUNDS_OFFER_INBOX || 'homefoliomarketing@gmail.com'
const FROM_ADDRESS = 'Firm Funds <notifications@firmfunds.ca>'

// =============================================================================
// GET /api/cron/remediation-overdue-escalation
//
// Daily sweep over remediation_deals that:
//   - are past their "we expected payment by now" window (status='idp_signed'
//     and created_at < NOW() - 14 days), AND
//   - are not yet remitted or cancelled.
//
// For every overdue row we bump escalation_level by 1 (see migration 093) so
// the digest can show "we've already chased this 3 times." Then we send ONE
// digest email to the Firm Funds inbox listing every overdue row — never
// one email per deal. Operator can act on the whole batch at once.
//
// Idempotent at the day granularity via cron_run_log unique(job_name, period).
//
// Suggested cadence: once per day, mid-morning Toronto time.
// =============================================================================

interface OverdueRow {
  id: string
  property_address: string
  brokerage_legal_name: string
  expected_commission: number | null
  directed_amount: number
  created_at: string
  status: string
  escalation_level: number
}

export async function GET(request: Request) {
  const unauth = validateCronAuth(request)
  if (unauth) return unauth

  const supabase = createServiceRoleClient()

  // Toronto-local daily period (matches the closing-date-alerts pattern).
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
    const cutoff = new Date(Date.now() - OVERDUE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString()

    // "Payment expected" status set. Today only 'idp_signed' counts but if
    // future statuses are added (e.g. 'idp_partially_remitted') extend here.
    const PAYMENT_EXPECTED_STATUSES = ['idp_signed']

    const { data: overdue, error: queryErr } = await supabase
      .from('remediation_deals')
      .select('id, property_address, brokerage_legal_name, expected_commission, directed_amount, created_at, status, escalation_level')
      .in('status', PAYMENT_EXPECTED_STATUSES)
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .returns<OverdueRow[]>()

    if (queryErr) {
      await markRun(supabase, runId, 'error', { error: queryErr.message })
      return Response.json({ error: 'Query failed', detail: queryErr.message }, { status: 500 })
    }

    const rows = overdue ?? []
    if (rows.length === 0) {
      await markRun(supabase, runId, 'success', { overdue: 0, emailed: false })
      return Response.json({ message: 'No overdue remediations', overdue: 0 })
    }

    // Bump escalation_level on each row. Doing this per-row keeps the count
    // honest for any new row that becomes overdue between the SELECT and the
    // UPDATE. A set-based UPDATE on the same predicate would also work and
    // would be faster at large scale, but at our volume the per-row update
    // is fine and gives clearer logs.
    const bumpFailures: { id: string; error: string }[] = []
    for (const row of rows) {
      const { error: updErr } = await supabase
        .from('remediation_deals')
        .update({ escalation_level: (row.escalation_level ?? 0) + 1 })
        .eq('id', row.id)
      if (updErr) {
        bumpFailures.push({ id: row.id, error: updErr.message })
      }
    }

    // Build and send the digest. One email per cron run — never per row.
    let emailSent = false
    let emailError: string | null = null
    try {
      const html = renderDigestHtml(rows)
      const subject = `[Firm Funds] ${rows.length} overdue remediation${rows.length === 1 ? '' : 's'} — action needed`
      await sendDigest(FF_INBOX, subject, html)
      emailSent = true
    } catch (err) {
      emailError = err instanceof Error ? err.message : 'unknown error'
      // Capture into the dead-letter queue so /api/cron/retry-failed-emails
      // picks it up. We never throw out of this handler — bump-update has
      // already side-effected.
      await supabase.from('cron_email_failures').insert({
        cron_job: JOB_NAME,
        email_type: 'remediation_overdue_digest',
        recipient: FF_INBOX,
        subject: `[Firm Funds] ${rows.length} overdue remediations`,
        payload: { rows },
        error: emailError ?? 'unknown',
      })
    }

    const outcome = emailError ? 'partial_success' : 'success'
    await markRun(supabase, runId, outcome, {
      overdue: rows.length,
      emailed: emailSent,
      email_error: emailError,
      bump_failures: bumpFailures,
    })

    return Response.json({
      message: 'remediation-overdue-escalation complete',
      overdue: rows.length,
      emailed: emailSent,
      bump_failures: bumpFailures,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[remediation-overdue-escalation] fatal:', msg)
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

function renderDigestHtml(rows: OverdueRow[]): string {
  const escape = (s: string | null | undefined): string =>
    String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c] || c
    )
  const fmtCurrency = (n: number | null): string =>
    n == null ? 'n/a' : `$${Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const rowsHtml = rows
    .map(r => {
      const daysOverdue = Math.floor((Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24))
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #2a2a2a;">${escape(r.property_address)}</td>
          <td style="padding:8px;border-bottom:1px solid #2a2a2a;">${escape(r.brokerage_legal_name)}</td>
          <td style="padding:8px;border-bottom:1px solid #2a2a2a;text-align:right;">${fmtCurrency(r.directed_amount)}</td>
          <td style="padding:8px;border-bottom:1px solid #2a2a2a;text-align:right;">${daysOverdue}d</td>
          <td style="padding:8px;border-bottom:1px solid #2a2a2a;text-align:right;">${(r.escalation_level ?? 0) + 1}</td>
        </tr>`
    })
    .join('')

  return `
<!doctype html>
<html><body style="font-family:system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;padding:24px;">
  <h2 style="color:#5FA873;margin:0 0 16px;">Overdue Remediation Digest</h2>
  <p>${rows.length} remediation${rows.length === 1 ? '' : 's'} have been waiting more than ${OVERDUE_THRESHOLD_DAYS} days since their IDP was signed without remittance. Action needed.</p>
  <table style="width:100%;border-collapse:collapse;background:#171717;border:1px solid #2a2a2a;margin-top:16px;">
    <thead>
      <tr style="background:#1f1f1f;">
        <th style="padding:8px;text-align:left;">Property</th>
        <th style="padding:8px;text-align:left;">Brokerage</th>
        <th style="padding:8px;text-align:right;">Directed</th>
        <th style="padding:8px;text-align:right;">Days Overdue</th>
        <th style="padding:8px;text-align:right;">Escalation</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="margin-top:16px;color:#a3a3a3;font-size:13px;">Escalation level is incremented on every daily run — the column above shows the level after this run.</p>
</body></html>`
}

async function sendDigest(to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured')
  }
  const resend = new Resend(apiKey)
  // Resend SDK returns { data, error } shape — surface a thrown error if the
  // call rejects, and treat a non-null .error payload as a failure too.
  const result = (await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject,
    html,
  })) as { error: { message?: string } | string | null } | null
  if (result && result.error) {
    const errVal = result.error
    const msg = typeof errVal === 'string' ? errVal : (errVal.message ?? 'Unknown resend error')
    throw new Error(msg)
  }
}
