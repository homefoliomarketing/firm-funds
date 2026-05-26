import { createClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { sendMonthlyBrokerStatement } from '@/lib/email'

// =============================================================================
// GET /api/cron/monthly-broker-statements
//
// Sends profit-share statements to white-label partner brokerages.
// Schedule externally (e.g. Netlify scheduled function, GitHub Actions, cron-job.org)
// to fire on the LAST day of each month at ~18:00 ET.
//
// Idempotency: claims a (job_name, period) row in cron_run_log at start.
// Duplicate runs for the same period return { already_ran: true } without
// re-sending. See migration 074.
//
// Period replay safety: ?period=YYYY-MM is restricted to the current month or
// the previous 2 months. Older backfills require header
// X-Admin-Backfill-Approved: <CRON_BACKFILL_SECRET>.
//
// Protected by CRON_SECRET header (Bearer).
// Optional ?period=YYYY-MM query param overrides the default (current month).
// =============================================================================

const JOB_NAME = 'monthly_broker_statements'
const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/

export async function GET(request: Request) {
  // Auth via CRON_SECRET — fail closed if not configured
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    console.error('[cron/monthly-broker-statements] CRON_SECRET env var not configured')
    return Response.json({ error: 'Cron not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return Response.json({ error: 'Missing Supabase config' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Determine period (default: current calendar month). Strict YYYY-MM format
  // — any other value is rejected so brokerage statements can't be replayed
  // for an arbitrary past month.
  const url = new URL(request.url)
  const periodParam = url.searchParams.get('period')
  const now = new Date()
  let year: number, month: number
  let periodKey: string

  if (periodParam) {
    if (!PERIOD_REGEX.test(periodParam)) {
      return Response.json({ error: 'Invalid period format. Expected YYYY-MM (months 01-12).' }, { status: 400 })
    }
    year = parseInt(periodParam.slice(0, 4), 10)
    month = parseInt(periodParam.slice(5, 7), 10) - 1
    periodKey = periodParam
  } else {
    year = now.getFullYear()
    month = now.getMonth()
    periodKey = `${year}-${String(month + 1).padStart(2, '0')}`
  }

  // Restrict replay window: only current month or the previous 2 months.
  // Older backfills require X-Admin-Backfill-Approved header matching
  // CRON_BACKFILL_SECRET env var.
  const currentMonthIdx = now.getFullYear() * 12 + now.getMonth()
  const requestedMonthIdx = year * 12 + month
  const monthsBack = currentMonthIdx - requestedMonthIdx
  if (monthsBack < 0 || monthsBack > 2) {
    const backfillSecret = process.env.CRON_BACKFILL_SECRET
    const backfillHeader = request.headers.get('x-admin-backfill-approved')
    if (!backfillSecret) {
      return Response.json({ error: 'Period outside allowed window. CRON_BACKFILL_SECRET not configured.' }, { status: 400 })
    }
    if (backfillHeader !== backfillSecret) {
      return Response.json({ error: 'Period outside allowed window (current month or previous 2 only). Admin backfill header required.' }, { status: 403 })
    }
  }

  const periodStart = new Date(Date.UTC(year, month, 1))
  const periodEnd = new Date(Date.UTC(year, month + 1, 1))
  const periodLabel = periodStart.toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', timeZone: 'America/Toronto',
  })

  // Idempotency claim: insert (job_name, period). 23505 means another run
  // already handled this period — no-op.
  const serviceClient = createServiceRoleClient()
  const { data: claimRow, error: claimErr } = await serviceClient
    .from('cron_run_log')
    .insert({ job_name: JOB_NAME, period: periodKey })
    .select('id')
    .single()
  if (claimErr && (claimErr as any).code === '23505') {
    return Response.json({ already_ran: true, period: periodKey }, { status: 200 })
  }
  if (claimErr || !claimRow) {
    return Response.json({ error: 'Failed to claim cron run', detail: claimErr?.message }, { status: 500 })
  }
  const runId = claimRow.id

  // 1. Fetch all brokerages with a profit-share arrangement
  const { data: brokerages, error: brokErr } = await supabase
    .from('brokerages')
    .select('id, name, email, broker_of_record_email, logo_url, profit_share_pct')
    .gt('profit_share_pct', 0)
    .neq('status', 'archived')

  if (brokErr) {
    console.error('[cron/monthly-broker-statements] Failed to fetch brokerages:', brokErr.message)
    await serviceClient
      .from('cron_run_log')
      .update({ completed_at: new Date().toISOString(), outcome: 'error', details: { error: brokErr.message } })
      .eq('id', runId)
    return Response.json({ error: 'Failed to fetch brokerages' }, { status: 500 })
  }
  if (!brokerages || brokerages.length === 0) {
    await serviceClient
      .from('cron_run_log')
      .update({ completed_at: new Date().toISOString(), outcome: 'success', details: { brokeragesProcessed: 0 } })
      .eq('id', runId)
    return Response.json({ ok: true, period: periodLabel, brokeragesProcessed: 0 })
  }

  let totalSent = 0
  let totalSkipped = 0
  const errors: string[] = []

  for (const brokerage of brokerages) {
    // Resolve recipient: prefer broker_of_record_email, fall back to brokerage.email
    const toEmail = brokerage.broker_of_record_email || brokerage.email
    if (!toEmail) {
      totalSkipped++
      errors.push(`${brokerage.name}: no recipient email on file`)
      continue
    }

    // Pull deals funded or completed in the period that have a snapshotted broker share.
    const { data: deals, error: dealsErr } = await supabase
      .from('deals')
      .select(`
        id, property_address, funding_date, discount_fee, settlement_period_fee,
        broker_share_pct_at_funding, broker_share_amount, broker_share_remitted,
        agents(first_name, last_name)
      `)
      .eq('brokerage_id', brokerage.id)
      .in('status', ['funded', 'completed'])
      .gte('funding_date', periodStart.toISOString().split('T')[0])
      .lt('funding_date', periodEnd.toISOString().split('T')[0])
      .not('broker_share_pct_at_funding', 'is', null)
      .order('funding_date', { ascending: true })

    if (dealsErr) {
      errors.push(`${brokerage.name}: ${dealsErr.message}`)
      totalSkipped++
      continue
    }

    const rows = (deals || []).map((d: any) => {
      const pct = Number(d.broker_share_pct_at_funding ?? 0)
      // Match the brokerage_referral_fee formula: pct applies to discount + settlement.
      const fee = Number(d.discount_fee ?? 0) + Number(d.settlement_period_fee ?? 0)
      // If broker_share_amount is set (deal is completed), use it; else estimate from fee × pct
      const share = d.broker_share_amount != null
        ? Number(d.broker_share_amount)
        : Math.round(fee * pct) / 100
      return {
        propertyAddress: d.property_address,
        agentName: d.agents
          ? `${d.agents.first_name} ${d.agents.last_name}`
          : 'Unknown',
        fundingDate: d.funding_date,
        discountFee: fee,
        pct,
        brokerShare: share,
        remitted: !!d.broker_share_remitted,
      }
    })

    const totalEarned = rows.reduce((s, r) => s + r.brokerShare, 0)
    const totalUnremitted = rows.filter(r => !r.remitted).reduce((s, r) => s + r.brokerShare, 0)

    try {
      await sendMonthlyBrokerStatement({
        toEmail,
        brokerageName: brokerage.name,
        brokerageLogoUrl: brokerage.logo_url,
        periodLabel,
        rows,
        totalEarned,
        totalUnremitted,
      })
      totalSent++
    } catch (err: any) {
      errors.push(`${brokerage.name}: ${err?.message || 'send failed'}`)
      totalSkipped++
    }
  }

  const outcome = errors.length === 0 ? 'success' : 'partial_success'
  await serviceClient
    .from('cron_run_log')
    .update({
      completed_at: new Date().toISOString(),
      outcome,
      details: {
        period: periodKey,
        brokeragesProcessed: brokerages.length,
        sent: totalSent,
        skipped: totalSkipped,
        errors,
      },
    })
    .eq('id', runId)

  return Response.json({
    ok: true,
    period: periodLabel,
    brokeragesProcessed: brokerages.length,
    sent: totalSent,
    skipped: totalSkipped,
    errors,
  })
}
