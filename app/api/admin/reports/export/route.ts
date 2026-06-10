// Unified financial report export endpoint.
//   GET /api/admin/reports/export?format=pdf|xlsx&scope=company|brokerage|agent
//        &id=<uuid>&start=YYYY-MM-DD&end=YYYY-MM-DD&status=<status>
//
// Authenticated, internal-staff only (any tier may view per project policy).
// Returns a downloadable .pdf (branded) or .xlsx (multi-sheet) attachment.
// NOT added to proxy.ts PUBLIC_PATHS — it relies on the session cookie.

import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import { buildReportPackage } from '@/lib/reports/build'
import { reportToWorkbook } from '@/lib/reports/xlsx'
import { reportToPdf } from '@/lib/reports/pdf'
import type { ReportScope } from '@/lib/reports/types'

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
  const { error: authErr } = await getAuthenticatedAdmin()
  if (authErr) return json(401, { error: authErr })

  const url = new URL(request.url)
  const format = (url.searchParams.get('format') || 'pdf').toLowerCase()
  const scope = (url.searchParams.get('scope') || 'company') as ReportScope
  const scopeId = url.searchParams.get('id')
  const startDate = url.searchParams.get('start')
  const endDate = url.searchParams.get('end')
  const status = url.searchParams.get('status')

  if (!['company', 'brokerage', 'agent'].includes(scope)) return json(400, { error: 'Invalid scope' })
  if ((scope === 'brokerage' || scope === 'agent') && !scopeId)
    return json(400, { error: 'A brokerage or agent must be selected for this report.' })
  if (!['pdf', 'xlsx'].includes(format)) return json(400, { error: 'Invalid format' })

  let pkg
  try {
    pkg = await buildReportPackage({ scope, scopeId, startDate, endDate, status })
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : 'Report build failed' })
  }

  const base = sanitize(
    `Firm_Funds_${pkg.meta.scopeLabel}_${pkg.meta.startDate || 'all'}_${pkg.meta.endDate || 'time'}`,
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
