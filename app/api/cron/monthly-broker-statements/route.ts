import { createClient } from '@supabase/supabase-js'
import { sendMonthlyBrokerStatement } from '@/lib/email'

// =============================================================================
// GET /api/cron/monthly-broker-statements
//
// Sends profit-share statements to white-label partner brokerages.
// Schedule externally (e.g. Netlify scheduled function, GitHub Actions, cron-job.org)
// to fire on the LAST day of each month at ~18:00 ET.
//
// Idempotency: safe to call multiple times within the same period — emails will
// re-send the same numbers. (Simple by design; can add a "last_statement_sent_at"
// column later if Bud needs hard idempotency.)
//
// Protected by CRON_SECRET header (Bearer).
// Optional ?period=YYYY-MM query param overrides the default (current month).
// =============================================================================

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

  // Determine period (default: current calendar month, ET)
  const url = new URL(request.url)
  const periodParam = url.searchParams.get('period')
  const now = new Date()
  let year: number, month: number
  if (periodParam && /^\d{4}-\d{2}$/.test(periodParam)) {
    year = parseInt(periodParam.slice(0, 4), 10)
    month = parseInt(periodParam.slice(5, 7), 10) - 1
  } else {
    year = now.getFullYear()
    month = now.getMonth()
  }
  const periodStart = new Date(Date.UTC(year, month, 1))
  const periodEnd = new Date(Date.UTC(year, month + 1, 1))
  const periodLabel = periodStart.toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', timeZone: 'America/Toronto',
  })

  // 1. Fetch all brokerages with a profit-share arrangement
  const { data: brokerages, error: brokErr } = await supabase
    .from('brokerages')
    .select('id, name, email, broker_of_record_email, logo_url, profit_share_pct')
    .gt('profit_share_pct', 0)
    .neq('status', 'archived')

  if (brokErr) {
    console.error('[cron/monthly-broker-statements] Failed to fetch brokerages:', brokErr.message)
    return Response.json({ error: 'Failed to fetch brokerages' }, { status: 500 })
  }
  if (!brokerages || brokerages.length === 0) {
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
        id, property_address, funding_date, discount_fee,
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
      const fee = Number(d.discount_fee ?? 0)
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

  return Response.json({
    ok: true,
    period: periodLabel,
    brokeragesProcessed: brokerages.length,
    sent: totalSent,
    skipped: totalSkipped,
    errors,
  })
}
