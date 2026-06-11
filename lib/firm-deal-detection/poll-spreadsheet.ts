/**
 * lib/firm-deal-detection/poll-spreadsheet.ts
 *
 * Single-pipe poll execution. Reads the configured tabs from a brokerage's
 * shared Google Sheet, diffs against the prior `last_poll_state` snapshot,
 * and inserts a `firm_deal_events` row (status='new') for each detected
 * trigger.
 *
 * Detection rules (in order):
 *   1. Row's identity hash appears in a MONTH tab now, did not appear in any
 *      tab on the previous poll  ->  firm deal (direct entry into month tab)
 *   2. Row's identity hash appears in a MONTH tab now, was in the Conditional
 *      tab on the previous poll  ->  firm deal (the canonical Choice Realty
 *      "moved out of Conditional" trigger)
 *   3. Row's identity hash appears in Conditional only                    ->  not firm
 *   4. Row's identity hash exists in the same month tab as before         ->  no-op
 *
 * First poll (last_poll_state is null) records state only, never fires any
 * events. That avoids dumping every historical firm deal into the queue.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readAllTabValues } from './sheets-client'
import {
  isDataRow,
  rowIdentityHash,
  type ColumnLetterMap,
} from './row-hash'
import { computeDealHash } from './deal-hash'
import { releaseCommissionHoldsForPipe } from './commission-hold'

export interface SpreadsheetPipeConfig {
  sheet_id: string
  sheet_url?: string
  trigger_type?: 'row_moved_from_conditional' | 'row_added_to_month_tab'
  conditional_tab: string
  /** Explicit list of month tab names to watch (the "firm" side of the move). */
  tabs_to_watch: string[]
  column_mapping: ColumnLetterMap & {
    deposit_amount?: string
    deposit_date?: string
    payment_method?: string
    listing_agent?: string
    selling_agent?: string
    /** Optional gross-commission columns (added 2026-05-28). When set, the
     *  parser extracts a dollar amount and the email/SMS shifts to the
     *  detailed variant with a calculated advance estimate. */
    listing_agent_commission?: string
    selling_agent_commission?: string
    notes?: string
  }
}

interface BrokeragePipeRow {
  id: string
  brokerage_id: string
  pipe_type: 'spreadsheet' | 'email'
  config: SpreadsheetPipeConfig
  last_poll_state: { tab_by_hash: Record<string, string> } | null
}

interface PollResult {
  pipe_id: string
  brokerage_id: string
  rows_seen: number
  rows_new_firm: number
  rows_carried_over: number
  /** Commission holds from a prior cycle released this poll (commission-hold.ts). */
  holds_released: number
  errors: string[]
  first_poll: boolean
}

/**
 * Poll one spreadsheet pipe. Writes detected firm-deal events to the DB and
 * updates the pipe's last_poll_state.
 */
export async function pollSpreadsheetPipe(
  pipe: BrokeragePipeRow,
  supabase: SupabaseClient
): Promise<PollResult> {
  const cfg = pipe.config
  const cols = cfg.column_mapping

  if (!cfg.sheet_id || !cfg.conditional_tab || !Array.isArray(cfg.tabs_to_watch)) {
    return {
      pipe_id: pipe.id,
      brokerage_id: pipe.brokerage_id,
      rows_seen: 0,
      rows_new_firm: 0,
      rows_carried_over: 0,
      holds_released: 0,
      errors: ['Invalid pipe config: needs sheet_id, conditional_tab, tabs_to_watch'],
      first_poll: false,
    }
  }

  const allTabs = [cfg.conditional_tab, ...cfg.tabs_to_watch]
  const tabValues = await readAllTabValues(cfg.sheet_id, allTabs)

  // Build current state: { rowIdentityHash -> tabName }.
  //
  // Tie-breaker when the same row appears in BOTH Conditional AND a watched
  // month tab: prefer the month tab. Bud's flow is "copy the row to the
  // month tab when it firms up", and admins sometimes leave the original
  // Conditional row in place rather than deleting it. Without this
  // tie-breaker the poller treated the Conditional placement as authoritative
  // (first-seen wins, Conditional is first in allTabs), so the row never
  // looked like it had moved and no firm-deal event fired. 150 Pittsburgh
  // hit exactly this case 2026-05-28.
  const currentTabByHash: Record<string, string> = {}
  // Also keep the row itself so we can reuse it for the raw_payload when we
  // detect a firm event.
  const currentRowByHash: Record<string, { tab: string; row: string[] }> = {}
  let rowsSeen = 0

  for (const tab of allTabs) {
    const rows = tabValues[tab] || []
    // skip the header row (index 0)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row || !isDataRow(row, cols)) continue
      rowsSeen++
      const h = rowIdentityHash(row, cols)
      const seenTab = currentTabByHash[h]
      if (seenTab === undefined) {
        // First sighting — record it.
        currentTabByHash[h] = tab
        currentRowByHash[h] = { tab, row }
      } else if (seenTab === cfg.conditional_tab && cfg.tabs_to_watch.includes(tab)) {
        // Duplicate: prior sighting was Conditional, new sighting is a
        // watched month tab. Month tab wins because it represents the
        // "firmed" state of the deal. The Conditional copy is stale.
        currentTabByHash[h] = tab
        currentRowByHash[h] = { tab, row }
      }
      // Other duplicates (both in month tabs, or Conditional-then-Conditional)
      // keep the first sighting.
    }
  }

  const prior = pipe.last_poll_state?.tab_by_hash || null
  const isFirstPoll = prior == null

  const detected: { hash: string; row: string[]; tab: string; trigger: 'direct_to_month' | 'moved_from_conditional' }[] = []

  if (!isFirstPoll) {
    for (const [hash, tab] of Object.entries(currentTabByHash)) {
      if (tab === cfg.conditional_tab) continue
      if (!cfg.tabs_to_watch.includes(tab)) continue

      const before = prior![hash]
      if (before == null) {
        // Brand new row that appeared directly in a month tab
        detected.push({
          hash,
          row: currentRowByHash[hash].row,
          tab,
          trigger: 'direct_to_month',
        })
      } else if (before === cfg.conditional_tab) {
        // The canonical Choice Realty trigger: row was in Conditional, is
        // now in a month tab. Firm deal.
        detected.push({
          hash,
          row: currentRowByHash[hash].row,
          tab,
          trigger: 'moved_from_conditional',
        })
      }
      // If before === current tab: no-op (carried over from last poll)
    }
  }

  // Insert detected events
  const errors: string[] = []
  if (detected.length > 0) {
    const eventRows = detected.map(d => {
      // Feed MLS + listing-agent cells too — they tighten the dedup hash
      // against same-building collisions (see deal-hash.ts header). Both are
      // pulled raw; deal-hash normalizes (uppercase + trim for MLS, lower +
      // collapse whitespace for the agent cell).
      const dealHash = computeDealHash({
        address: cellByLetter(d.row, cols.address),
        closing_date: cellByLetter(d.row, cols.closing_date),
        sale_price: null,
        mls_number: cellByLetter(d.row, cols.mls),
        listing_agent_raw: cols.listing_agent
          ? cellByLetter(d.row, cols.listing_agent)
          : null,
      })
      return {
        brokerage_pipe_id: pipe.id,
        brokerage_id: pipe.brokerage_id,
        source: 'spreadsheet',
        raw_payload: {
          row: d.row,
          source_tab: d.tab,
          column_mapping: cols,
          trigger: d.trigger,
          row_identity_hash: d.hash,
        },
        parsed: {},
        deal_hash: dealHash,
        status: 'new',
      }
    })
    const { error } = await supabase.from('firm_deal_events').insert(eventRows)
    if (error) errors.push(`insert firm_deal_events: ${error.message}`)
  }

  // Persist updated state
  const newState = { tab_by_hash: currentTabByHash, polled_at: new Date().toISOString() }
  const { error: stateErr } = await supabase
    .from('brokerage_pipes')
    .update({
      last_polled_at: new Date().toISOString(),
      last_poll_state: newState,
    })
    .eq('id', pipe.id)
  if (stateErr) errors.push(`update brokerage_pipes: ${stateErr.message}`)

  // Release commission holds parked on a PRIOR cycle, re-reading each held row's
  // commission from the fresh snapshot we already have in hand. A hold created
  // later in THIS run (Stage 2 of the poller) is untouched: it is younger than
  // HOLD_MIN_MINUTES and Stage 1 runs before Stage 2, so it waits for the next
  // run. See commission-hold.ts.
  let holdsReleased = 0
  try {
    const rel = await releaseCommissionHoldsForPipe(supabase, pipe.id, currentRowByHash)
    holdsReleased = rel.released
    for (const e of rel.errors) errors.push(e)
  } catch (err) {
    errors.push(`release commission holds: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  return {
    pipe_id: pipe.id,
    brokerage_id: pipe.brokerage_id,
    rows_seen: rowsSeen,
    rows_new_firm: isFirstPoll ? 0 : detected.length,
    rows_carried_over: prior ? Object.keys(prior).length : 0,
    holds_released: holdsReleased,
    errors,
    first_poll: isFirstPoll,
  }
}

function cellByLetter(row: string[], letter: string | undefined): string {
  if (!letter) return ''
  let n = 0
  for (const c of letter.toUpperCase()) {
    n = n * 26 + (c.charCodeAt(0) - 64)
  }
  return (row[n - 1] ?? '').toString().trim()
}
