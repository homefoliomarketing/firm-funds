'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import { listTabs, readAllTabValues } from '@/lib/firm-deal-detection/sheets-client'

type ActionResult<T = unknown> = { success: boolean; error?: string; data?: T }

// ============================================================================
// Constants surfaced to the wizard UI
// ============================================================================

/**
 * Email the brokerage admin must share their Google Sheet with as Viewer.
 * Falls back to the well-known constant if the service-account JSON env var
 * is somehow unset (which would also break the actual poll, so this is
 * just defensive).
 */
function readServiceAccountEmail(): string {
  const fallback = 'firmfunds-sheets-poller@firm-funds-sheets.iam.gserviceaccount.com'
  const raw = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON
  if (!raw) return fallback
  try {
    let parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    const email = (parsed as Record<string, unknown> | null)?.client_email
    if (typeof email === 'string' && email.includes('@')) return email
  } catch {
    // fall through
  }
  return fallback
}

export async function getServiceAccountEmail(): Promise<ActionResult<{ email: string }>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  return { success: true, data: { email: readServiceAccountEmail() } }
}

// ============================================================================
// Step 1 — Sheet share check
// ============================================================================

/**
 * Accept a raw Sheets URL or bare ID and return just the ID (or null).
 * The Sheets URL pattern is `/spreadsheets/d/<id>/...`; the ID alphabet is
 * `[A-Za-z0-9_-]`. We require ≥20 chars for the bare-ID path to avoid
 * accepting obvious garbage like "test123".
 */
export async function parseSheetIdInput(input: string): Promise<ActionResult<{ sheetId: string }>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  const trimmed = input.trim()
  if (!trimmed) return { success: false, error: 'Paste a Google Sheets URL or ID.' }
  const urlMatch = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(trimmed)
  if (urlMatch) return { success: true, data: { sheetId: urlMatch[1] } }
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return { success: true, data: { sheetId: trimmed } }
  return { success: false, error: 'That does not look like a Google Sheets URL or ID.' }
}

/**
 * Confirm we can read the sheet, and return its tabs. Any failure (403 share
 * issue, 404 missing sheet, malformed ID) is surfaced as a typed reason so
 * the UI can pick the right help text.
 */
export async function testSheetAccess(input: {
  sheetId: string
}): Promise<ActionResult<{ tabs: string[]; serviceAccountEmail: string }>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  if (!input.sheetId) return { success: false, error: 'Missing sheet ID.' }

  try {
    const tabs = await listTabs(input.sheetId)
    if (tabs.length === 0) {
      return {
        success: false,
        error: 'Sheet opened but has no tabs. That should not be possible — double-check the URL.',
      }
    }
    return { success: true, data: { tabs, serviceAccountEmail: readServiceAccountEmail() } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // Google's googleapis SDK puts the HTTP status in `.code` on most errors.
    const status = (err as { code?: number; status?: number })?.code ??
      (err as { response?: { status?: number } })?.response?.status
    if (status === 403 || /permission|forbidden/i.test(message)) {
      return {
        success: false,
        error: `Firm Funds doesn't have read access to this sheet yet. Share it with ${readServiceAccountEmail()} as Viewer, then click Retry.`,
      }
    }
    if (status === 404 || /not found/i.test(message)) {
      return {
        success: false,
        error: 'Sheet not found. Double-check the URL or ID.',
      }
    }
    return { success: false, error: `Sheets API error: ${message}` }
  }
}

// ============================================================================
// Step 3 — Column-mapping preview
// ============================================================================

/**
 * Read the first ~6 rows of a single tab so the wizard can render a column
 * picker. Returns the raw values exactly as Sheets gave them, header row
 * first.
 */
export async function fetchTabPreview(input: {
  sheetId: string
  tab: string
  limit?: number
}): Promise<ActionResult<{ rows: string[][] }>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  if (!input.sheetId || !input.tab) return { success: false, error: 'Missing sheet ID or tab.' }
  const limit = Math.max(2, Math.min(20, input.limit ?? 6))

  try {
    const tabValues = await readAllTabValues(input.sheetId, [input.tab])
    const all = tabValues[input.tab] ?? []
    return { success: true, data: { rows: all.slice(0, limit) } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `Sheets API error: ${message}` }
  }
}

// ============================================================================
// Existing-pipe lookup — wizard renders an "already configured" summary when
// a pipe is present rather than letting the admin overwrite it.
// ============================================================================

export interface ExistingPipeSummary {
  pipe_id: string
  brokerage_id: string
  brokerage_name: string
  brand_name: string | null
  brand_tagline: string | null
  auto_fire_enabled: boolean
  enabled: boolean
  last_polled_at: string | null
  sheet_id: string | null
  sheet_url: string | null
  conditional_tab: string | null
  tabs_to_watch: string[]
  column_mapping: Record<string, string>
}

export async function getBrokerageForPipeWizard(input: {
  brokerageId: string
}): Promise<ActionResult<{ brokerage: { id: string; name: string }; pipe: ExistingPipeSummary | null }>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  const supabase = createServiceRoleClient()

  const { data: brokerage, error: bErr } = await supabase
    .from('brokerages')
    .select('id, name')
    .eq('id', input.brokerageId)
    .is('deleted_at', null)
    .single()
  if (bErr || !brokerage) return { success: false, error: 'Brokerage not found.' }

  // We only consider enabled spreadsheet pipes "configured" — disabled rows
  // are tombstones and shouldn't block re-config.
  const { data: pipeRow, error: pErr } = await supabase
    .from('brokerage_pipes')
    .select('id, brokerage_id, config, brand_name, brand_tagline, auto_fire_enabled, enabled, last_polled_at')
    .eq('brokerage_id', input.brokerageId)
    .eq('pipe_type', 'spreadsheet')
    .eq('enabled', true)
    .maybeSingle()
  if (pErr) return { success: false, error: `Pipe lookup failed: ${pErr.message}` }

  let pipe: ExistingPipeSummary | null = null
  if (pipeRow) {
    const config = (pipeRow.config ?? {}) as {
      sheet_id?: string
      sheet_url?: string
      conditional_tab?: string
      tabs_to_watch?: string[]
      column_mapping?: Record<string, string>
    }
    pipe = {
      pipe_id: pipeRow.id,
      brokerage_id: pipeRow.brokerage_id,
      brokerage_name: brokerage.name,
      brand_name: pipeRow.brand_name,
      brand_tagline: pipeRow.brand_tagline,
      auto_fire_enabled: pipeRow.auto_fire_enabled,
      enabled: pipeRow.enabled,
      last_polled_at: pipeRow.last_polled_at,
      sheet_id: config.sheet_id ?? null,
      sheet_url: config.sheet_url ?? null,
      conditional_tab: config.conditional_tab ?? null,
      tabs_to_watch: Array.isArray(config.tabs_to_watch) ? config.tabs_to_watch : [],
      column_mapping: config.column_mapping ?? {},
    }
  }

  return { success: true, data: { brokerage, pipe } }
}

// ============================================================================
// Step 5 — Create the pipe row
// ============================================================================

export interface CreatePipeInput {
  brokerageId: string
  sheetId: string
  /** The Sheets URL the admin pasted (kept on the row for human reference) */
  sheetUrl: string
  conditionalTab: string
  tabsToWatch: string[]
  /** Whitelist enforced server-side: only address/mls/closing_date/listing_agent/selling_agent are accepted as keys. */
  columnMapping: Record<string, string>
  brandName: string
  brandTagline: string
}

const ALLOWED_COLUMN_KEYS = new Set([
  'address',
  'mls',
  'closing_date',
  'listing_agent',
  'selling_agent',
])

function isValidColumnLetter(letter: string): boolean {
  return /^[A-Z]{1,2}$/.test(letter)
}

// ============================================================================
// Pipe-level operations on an already-configured pipe.
// ============================================================================

export interface PipeStatistics {
  /** Lifetime count of events that were actually offered to an agent. The
   *  number Bud quotes back when deciding whether to flip auto-fire on. */
  validated_events_lifetime: number
  /** Counts in the last 30 days, broken down by terminal status. */
  total_30d: number
  sent_30d: number
  rejected_30d: number
  errored_30d: number
  awaiting_review_30d: number
  last_polled_at: string | null
  /** Most recent received_at across all events for this brokerage. */
  last_event_at: string | null
  /** Top unresolved shorthands by count — names from the sheet that hit a
   *  mapping table miss. Useful for proactive mapping training. */
  unresolved_shorthands: Array<{ shorthand: string; count: number }>
}

/**
 * One-shot stats summary for the brokerage's pipe page. Used both by the
 * auto-fire confirmation modal (validated_events_lifetime) and by the
 * statistics card on the same page (everything else).
 */
export async function getPipeStatistics(input: {
  brokerageId: string
}): Promise<ActionResult<PipeStatistics>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  const supabase = createServiceRoleClient()

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // We avoid five separate count queries by pulling status + received_at for
  // recent events in one shot and bucketing client-side. Lifetime sent is the
  // one number that needs a separate count (otherwise we'd risk truncating it
  // at the .limit() cap).
  const [lifetimeSentRes, recentRes, pipeRes, mostRecentEventRes] = await Promise.all([
    supabase
      .from('firm_deal_events')
      .select('id', { count: 'exact', head: true })
      .eq('brokerage_id', input.brokerageId)
      .eq('status', 'offer_sent'),
    supabase
      .from('firm_deal_events')
      .select('id, status, parsed, received_at')
      .eq('brokerage_id', input.brokerageId)
      .gte('received_at', thirtyDaysAgo)
      .order('received_at', { ascending: false })
      .limit(2000),
    supabase
      .from('brokerage_pipes')
      .select('last_polled_at')
      .eq('brokerage_id', input.brokerageId)
      .eq('pipe_type', 'spreadsheet')
      .eq('enabled', true)
      .maybeSingle(),
    supabase
      .from('firm_deal_events')
      .select('received_at')
      .eq('brokerage_id', input.brokerageId)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (lifetimeSentRes.error) return { success: false, error: lifetimeSentRes.error.message }
  if (recentRes.error) return { success: false, error: recentRes.error.message }
  // pipeRes / mostRecentEventRes returning .error on missing rows is fine —
  // maybeSingle() doesn't error on zero rows.

  const recent = (recentRes.data ?? []) as Array<{
    id: string
    status: string
    parsed: { listing_agent_raw?: string | null; selling_agent_raw?: string | null } | null
    received_at: string
  }>

  let sent_30d = 0
  let rejected_30d = 0
  let errored_30d = 0
  let awaiting_review_30d = 0
  for (const e of recent) {
    if (e.status === 'offer_sent') sent_30d++
    else if (e.status === 'rejected') rejected_30d++
    else if (e.status === 'errored') errored_30d++
    else if (e.status === 'unmatched' || e.status === 'awaiting_approval') awaiting_review_30d++
  }

  // Unresolved shorthands — listing or selling agent text from rows whose
  // status is 'unmatched'. We bucket by lowercased shorthand and keep the
  // original casing of the first one we see.
  const shorthandCounts = new Map<string, { display: string; count: number }>()
  for (const e of recent) {
    if (e.status !== 'unmatched') continue
    const candidates = [e.parsed?.listing_agent_raw, e.parsed?.selling_agent_raw]
    for (const raw of candidates) {
      if (!raw) continue
      const trimmed = raw.trim()
      if (!trimmed) continue
      const key = trimmed.toLowerCase()
      const prev = shorthandCounts.get(key)
      if (prev) {
        prev.count += 1
      } else {
        shorthandCounts.set(key, { display: trimmed, count: 1 })
      }
    }
  }
  const unresolved_shorthands = Array.from(shorthandCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(s => ({ shorthand: s.display, count: s.count }))

  return {
    success: true,
    data: {
      validated_events_lifetime: lifetimeSentRes.count ?? 0,
      total_30d: recent.length,
      sent_30d,
      rejected_30d,
      errored_30d,
      awaiting_review_30d,
      last_polled_at: pipeRes.data?.last_polled_at ?? null,
      last_event_at: mostRecentEventRes.data?.received_at ?? null,
      unresolved_shorthands,
    },
  }
}

/**
 * Flip a pipe's auto_fire_enabled flag. The wizard always creates a pipe
 * with auto-fire OFF; this is the only path to turn it on or back off.
 */
export async function setPipeAutoFire(input: {
  pipeId: string
  enabled: boolean
}): Promise<ActionResult<{ auto_fire_enabled: boolean }>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  if (!input.pipeId) return { success: false, error: 'Missing pipe id.' }

  const supabase = createServiceRoleClient()
  const { data, error } = await supabase
    .from('brokerage_pipes')
    .update({ auto_fire_enabled: input.enabled })
    .eq('id', input.pipeId)
    .select('auto_fire_enabled')
    .single()
  if (error || !data) {
    return { success: false, error: error?.message ?? 'Failed to update pipe.' }
  }
  return { success: true, data: { auto_fire_enabled: data.auto_fire_enabled } }
}

export async function createBrokeragePipe(
  input: CreatePipeInput
): Promise<ActionResult<{ pipeId: string }>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  const supabase = createServiceRoleClient()

  // -- Validate inputs --
  if (!input.brokerageId) return { success: false, error: 'Missing brokerage.' }
  if (!input.sheetId) return { success: false, error: 'Missing sheet ID.' }
  if (!input.conditionalTab) return { success: false, error: 'Pick the Conditional tab on step 2.' }
  if (!Array.isArray(input.tabsToWatch) || input.tabsToWatch.length === 0) {
    return { success: false, error: 'Pick at least one month tab to watch on step 2.' }
  }
  if (input.tabsToWatch.includes(input.conditionalTab)) {
    return { success: false, error: 'The Conditional tab cannot also be a watched tab.' }
  }

  const cleanedMapping: Record<string, string> = {}
  for (const [key, letter] of Object.entries(input.columnMapping)) {
    if (!ALLOWED_COLUMN_KEYS.has(key)) continue
    const upper = String(letter ?? '').trim().toUpperCase()
    if (!upper || !isValidColumnLetter(upper)) {
      return { success: false, error: `Column "${key}" needs a single letter (A–Z) or two-letter code.` }
    }
    cleanedMapping[key] = upper
  }
  if (!cleanedMapping.address) {
    return { success: false, error: 'Map the Address column on step 3 — that is required for matching.' }
  }
  if (!cleanedMapping.listing_agent && !cleanedMapping.selling_agent) {
    return {
      success: false,
      error: 'Map at least one of Listing Agent or Selling Agent on step 3 so we know who to offer the advance to.',
    }
  }

  const brandName = input.brandName.trim() || null
  const brandTagline = input.brandTagline.trim() || 'Powered by Firm Funds'

  // -- Re-check brokerage exists --
  const { data: brokerage, error: bErr } = await supabase
    .from('brokerages')
    .select('id, name')
    .eq('id', input.brokerageId)
    .is('deleted_at', null)
    .single()
  if (bErr || !brokerage) return { success: false, error: 'Brokerage not found.' }

  // -- Block if an enabled pipe already exists. The unique constraint on
  //    (brokerage_id, pipe_type, enabled) would also catch this, but a
  //    clean preflight gives a friendlier error. --
  const { data: existing } = await supabase
    .from('brokerage_pipes')
    .select('id')
    .eq('brokerage_id', input.brokerageId)
    .eq('pipe_type', 'spreadsheet')
    .eq('enabled', true)
    .maybeSingle()
  if (existing) {
    return {
      success: false,
      error: 'This brokerage already has an enabled spreadsheet pipe. Disable it first if you want to re-onboard.',
    }
  }

  const config = {
    sheet_id: input.sheetId,
    sheet_url: input.sheetUrl || `https://docs.google.com/spreadsheets/d/${input.sheetId}/edit`,
    trigger_type: 'row_moved_from_conditional' as const,
    conditional_tab: input.conditionalTab,
    tabs_to_watch: input.tabsToWatch,
    column_mapping: cleanedMapping,
  }

  // Manual review mode is the universal default per the handoff. The first
  // poll captures a baseline because last_poll_state is null on insert; the
  // poll *after* that is when changes start firing events.
  const { data: inserted, error: insErr } = await supabase
    .from('brokerage_pipes')
    .insert({
      brokerage_id: input.brokerageId,
      pipe_type: 'spreadsheet',
      config,
      brand_name: brandName,
      brand_tagline: brandTagline,
      auto_fire_enabled: false,
      enabled: true,
    })
    .select('id')
    .single()
  if (insErr || !inserted) {
    return { success: false, error: `Failed to create pipe: ${insErr?.message ?? 'unknown error'}` }
  }

  return { success: true, data: { pipeId: inserted.id } }
}
