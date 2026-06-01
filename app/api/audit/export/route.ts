import { createClient } from '@/lib/supabase/server'
import { validateOrigin } from '@/lib/csrf'
import { checkApiRateLimit } from '@/lib/rate-limit'

// ============================================================================
// GET /api/audit/export — Export audit logs as CSV
// ============================================================================
// Query params: entityType, entityId, action, severity, actorEmail,
//               search, dateFrom, dateTo, format (csv|json)
// Auth: admin only (super_admin, firm_funds_admin)
// ============================================================================

export async function GET(request: Request) {
  // Rate limit check
  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
  const rl = await checkApiRateLimit(ip)
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
  }

  // CSRF check. Middleware enforces this for POST/PUT/PATCH/DELETE; GET is
  // exempt there because GETs are normally idempotent. We re-enforce here
  // because this GET serves a CSV export of the entire audit log — sensitive
  // enough that even cross-origin script-driven downloads should be rejected.
  const originError = validateOrigin(request)
  if (originError) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  }

  // Auth check
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['super_admin', 'firm_funds_admin'].includes(profile.role)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  }

  // Parse query params
  const url = new URL(request.url)
  const entityType = url.searchParams.get('entityType')
  const entityId = url.searchParams.get('entityId')
  const action = url.searchParams.get('action')
  // Repeated actionIn params -> match any one of an explicit action set.
  // Mirrors the "Money & compliance" preset's filters.actionIn path.
  const actionIn = url.searchParams.getAll('actionIn')
  const severity = url.searchParams.get('severity')
  const actorEmail = url.searchParams.get('actorEmail')
  const search = url.searchParams.get('search')
  const dateFrom = url.searchParams.get('dateFrom')
  const dateTo = url.searchParams.get('dateTo')
  const format = url.searchParams.get('format') || 'csv'

  // Build query
  let query = supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10000)

  if (entityType) query = query.eq('entity_type', entityType)
  if (entityId) query = query.eq('entity_id', entityId)
  if (action) query = query.eq('action', action)
  if (actionIn.length > 0) query = query.in('action', actionIn)
  if (severity) query = query.eq('severity', severity)
  if (actorEmail) query = query.ilike('actor_email', `%${actorEmail}%`)
  if (dateFrom) query = query.gte('created_at', dateFrom)
  if (dateTo) {
    const endDate = new Date(dateTo)
    endDate.setDate(endDate.getDate() + 1)
    query = query.lt('created_at', endDate.toISOString())
  }
  if (search) {
    // Sanitize: strip characters that have special meaning to PostgREST's
    // or() mini-DSL (comma, parens, period, percent, asterisk, colon).
    // Without this, a search term like `x),id.eq.<other>` could broaden
    // the filter. Admin-only route so the blast radius is limited, but
    // defense in depth.
    const safe = search.replace(/[,()%.*:]/g, '')
    if (safe.length > 0) {
      const searchTerm = `%${safe}%`
      query = query.or(`action.ilike.${searchTerm},entity_type.ilike.${searchTerm},actor_email.ilike.${searchTerm}`)
    }
  }

  const { data, error } = await query
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  const rows = data || []

  if (format === 'json') {
    const filename = `audit-export-${new Date().toISOString().slice(0, 10)}.json`
    return new Response(JSON.stringify(rows, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  // CSV format
  const csvHeaders = [
    'Timestamp', 'Severity', 'Action', 'Entity Type', 'Entity ID',
    'Actor Email', 'Actor Role', 'IP Address', 'User Agent',
    'Old Value', 'New Value', 'Metadata', 'ID'
  ]

  const escapeCSV = (val: string | null | undefined): string => {
    if (val === null || val === undefined) return ''
    let str = String(val)
    // Formula-injection guard: a cell that opens with =, +, -, @, tab, or
    // carriage return can be executed as a formula when the CSV is opened in
    // Excel / Sheets. Prefix with a single quote so the spreadsheet treats it
    // as literal text. Done before quoting so the leading quote is preserved.
    if (/^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  const csvRows = rows.map(row => [
    escapeCSV(row.created_at),
    escapeCSV(row.severity),
    escapeCSV(row.action),
    escapeCSV(row.entity_type),
    escapeCSV(row.entity_id),
    escapeCSV(row.actor_email),
    escapeCSV(row.actor_role),
    escapeCSV(row.ip_address),
    escapeCSV(row.user_agent),
    escapeCSV(row.old_value ? JSON.stringify(row.old_value) : ''),
    escapeCSV(row.new_value ? JSON.stringify(row.new_value) : ''),
    escapeCSV(row.metadata ? JSON.stringify(row.metadata) : ''),
    escapeCSV(row.id),
  ].join(','))

  const csv = [csvHeaders.join(','), ...csvRows].join('\n')
  const filename = `audit-export-${new Date().toISOString().slice(0, 10)}.csv`

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
