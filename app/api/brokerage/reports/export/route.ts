// Brokerage-facing financial report export.
//   GET /api/brokerage/reports/export?format=pdf|xlsx&month=YYYY-MM|all
//        &start=YYYY-MM-DD&end=YYYY-MM-DD&status=<status>
//
// Returns the SAME report engine as the admin export, but locked to the
// caller's OWN brokerage (scope + id come from the session, never the query)
// and rendered with audience='brokerage', which strips every Firm Funds margin
// figure (the fee charged to the agent, total fee revenue, gross profit).
//
// Access mirrors /api/reports/referral-fees exactly: a brokerage_admin who is a
// senior contact (Broker of Record + Brokerage Manager) per
// canViewBrokerageReferralFees. NOT in proxy.ts PUBLIC_PATHS.

import { createClient } from '@/lib/supabase/server'
import { canViewBrokerageReferralFees } from '@/lib/access'
import { buildReportPackage } from '@/lib/reports/build'
import { reportToWorkbook } from '@/lib/reports/xlsx'
import { reportToPdf } from '@/lib/reports/pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sanitize(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120)
}

export async function GET(request: Request): Promise<Response> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return json(401, { error: 'Unauthorized' })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, brokerage_id, staff_title')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'brokerage_admin' || !profile.brokerage_id) {
    return json(403, { error: 'Forbidden' })
  }
  if (!canViewBrokerageReferralFees(profile.staff_title)) {
    return json(403, { error: 'Forbidden' })
  }

  const url = new URL(request.url)
  const format = (url.searchParams.get('format') || 'pdf').toLowerCase()
  const status = url.searchParams.get('status')
  if (!['pdf', 'xlsx'].includes(format)) return json(400, { error: 'Invalid format' })

  // Date scoping: explicit start/end win; otherwise a YYYY-MM month (unless
  // ?all=true). Validate month up front so a bad value can't reach Date().
  let startDate = url.searchParams.get('start')
  let endDate = url.searchParams.get('end')
  const monthParam = url.searchParams.get('month')
  const allTime = url.searchParams.get('all') === 'true' || monthParam === 'all'

  if (!startDate && !endDate && monthParam && !allTime) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
      return json(400, { error: 'month must be in YYYY-MM format (e.g. 2026-05)' })
    }
    const [year, month] = monthParam.split('-').map(Number)
    startDate = new Date(year, month - 1, 1).toISOString().slice(0, 10)
    endDate = new Date(year, month, 0).toISOString().slice(0, 10)
  }

  let pkg
  try {
    pkg = await buildReportPackage({
      scope: 'brokerage',
      scopeId: profile.brokerage_id,
      startDate,
      endDate,
      status,
      audience: 'brokerage',
    })
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : 'Report build failed' })
  }

  const base = sanitize(
    `${pkg.meta.scopeLabel}_report_${pkg.meta.startDate || 'all'}_${pkg.meta.endDate || 'time'}`,
  )

  try {
    if (format === 'xlsx') {
      const body = Buffer.from(reportToWorkbook(pkg))
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${base}.xlsx"`,
          'Cache-Control': 'no-store',
        },
      })
    }

    const bytes = await reportToPdf(pkg)
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${base}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : 'Export generation failed' })
  }
}
