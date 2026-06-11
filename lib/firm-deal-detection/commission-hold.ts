/**
 * lib/firm-deal-detection/commission-hold.ts
 *
 * "Wait one poll cycle for a missing commission."
 *
 * When the poller detects a firm deal that has a closing date and a matched
 * agent but NO commission amount yet, AND the pipe's column mapping carries
 * commission columns, we park the offer for exactly one poll cycle (status
 * 'commission_hold') instead of sending immediately. That gives the brokerage a
 * chance to type the commission into the sheet so the agent gets the richer
 * "detailed" (Tier C) offer with real dollar figures. If the commission still
 * is not there one cycle later, we release the hold and send anyway (sparse).
 *
 * The one-cycle wait is enforced two ways that agree:
 *   1. Structural: the poller runs Stage 1 (poll + releaseCommissionHoldsForPipe)
 *      BEFORE Stage 2 (process new events, where a fresh hold is created). So a
 *      hold made in run N is only seen by run N+1's release pass.
 *   2. Age floor: the release only touches holds at least HOLD_MIN_MINUTES old,
 *      so a manual re-trigger of the poller minutes later cannot cut the wait
 *      short.
 *
 * The release re-reads the SAME row from the fresh sheet snapshot the poller
 * already has in hand (the row identity hash is stable when only a commission
 * cell changes, see row-hash.ts), so it costs no extra Google Sheets call.
 *
 * Pure decision logic (shouldHoldForCommission / parseMoneyCell / ...) lives in
 * commission-hold-rules.ts and is re-exported here for existing import paths.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logAuditEventServiceRole } from '@/lib/audit'
import type { ParsedFirmDeal } from './parse-event'
import {
  HOLD_MIN_MINUTES,
  HOLD_STALE_MINUTES,
  cellByLetter,
  parseMoneyCell,
  type CommissionColumnMapping,
} from './commission-hold-rules'

export {
  HOLD_MIN_MINUTES,
  HOLD_STALE_MINUTES,
  mapsCommissionColumns,
  shouldHoldForCommission,
  parseMoneyCell,
  type CommissionColumnMapping,
} from './commission-hold-rules'

interface HeldEventRow {
  id: string
  brokerage_id: string
  brokerage_pipe_id: string
  parsed: ParsedFirmDeal
  raw_payload: {
    row?: string[]
    source_tab?: string
    column_mapping?: CommissionColumnMapping
    row_identity_hash?: string
  } | null
  commission_hold_since: string | null
}

const HELD_SELECT =
  'id, brokerage_id, brokerage_pipe_id, parsed, raw_payload, commission_hold_since'

async function loadAutoFire(supabase: SupabaseClient, pipeId: string): Promise<boolean> {
  const { data } = await supabase
    .from('brokerage_pipes')
    .select('auto_fire_enabled')
    .eq('id', pipeId)
    .single()
  return !!data?.auto_fire_enabled
}

/**
 * Release one held event: write any freshly-read commission into `parsed`, move
 * it on to approved (auto-fire pipe) or awaiting_approval (manual), and clear
 * the hold marker. `freshRow` is the current sheet row when we have it (happy
 * path) or null (stale sweep: release with whatever was already parsed).
 */
async function releaseOneHold(
  supabase: SupabaseClient,
  event: HeldEventRow,
  freshRow: string[] | null,
  autoFire: boolean
): Promise<{ commission_found: boolean }> {
  const cols = event.raw_payload?.column_mapping ?? {}
  const parsed: ParsedFirmDeal = { ...(event.parsed as ParsedFirmDeal) }

  let commissionFound = false
  if (freshRow) {
    const listing = parseMoneyCell(cellByLetter(freshRow, cols.listing_agent_commission))
    const selling = parseMoneyCell(cellByLetter(freshRow, cols.selling_agent_commission))
    if (listing != null) {
      parsed.listing_agent_commission_amount = listing
      commissionFound = true
    }
    if (selling != null) {
      parsed.selling_agent_commission_amount = selling
      commissionFound = true
    }
  }

  const nextStatus = autoFire ? 'approved' : 'awaiting_approval'
  const rawPayload = freshRow
    ? { ...(event.raw_payload ?? {}), row: freshRow }
    : event.raw_payload

  const { error } = await supabase
    .from('firm_deal_events')
    .update({
      parsed: parsed as unknown as Record<string, unknown>,
      raw_payload: rawPayload as unknown as Record<string, unknown>,
      status: nextStatus,
      commission_hold_since: null,
      processed_at: new Date().toISOString(),
    })
    .eq('id', event.id)
    .eq('status', 'commission_hold') // guard against a concurrent release/change
  if (error) throw new Error(error.message)

  try {
    await logAuditEventServiceRole({
      action: 'firm_deal.commission_hold_released',
      entityType: 'firm_deal_event',
      entityId: event.id,
      severity: 'info',
      metadata: {
        event_id: event.id,
        commission_found: commissionFound,
        had_fresh_row: !!freshRow,
        next_status: nextStatus,
      },
    })
  } catch {
    /* audit is best-effort; never block a release on it */
  }
  return { commission_found: commissionFound }
}

/**
 * Happy-path release: called from inside pollSpreadsheetPipe with the fresh
 * snapshot in hand. For every commission_hold event on this pipe that is at
 * least HOLD_MIN_MINUTES old, look up the current row by its identity hash and
 * re-read the commission before releasing.
 */
export async function releaseCommissionHoldsForPipe(
  supabase: SupabaseClient,
  pipeId: string,
  currentRowByHash: Record<string, { tab: string; row: string[] }>
): Promise<{ released: number; commission_found: number; errors: string[] }> {
  const cutoff = new Date(Date.now() - HOLD_MIN_MINUTES * 60_000).toISOString()
  const { data, error } = await supabase
    .from('firm_deal_events')
    .select(HELD_SELECT)
    .eq('brokerage_pipe_id', pipeId)
    .eq('status', 'commission_hold')
    .lte('commission_hold_since', cutoff)
  if (error) return { released: 0, commission_found: 0, errors: [`load holds: ${error.message}`] }
  const holds = (data ?? []) as HeldEventRow[]
  if (holds.length === 0) return { released: 0, commission_found: 0, errors: [] }

  const autoFire = await loadAutoFire(supabase, pipeId)
  const errors: string[] = []
  let released = 0
  let commissionFound = 0
  for (const h of holds) {
    try {
      const hash = h.raw_payload?.row_identity_hash
      const fresh = hash ? currentRowByHash[hash]?.row ?? null : null
      const r = await releaseOneHold(supabase, h, fresh, autoFire)
      released++
      if (r.commission_found) commissionFound++
    } catch (err) {
      errors.push(`release ${h.id}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }
  return { released, commission_found: commissionFound, errors }
}

/**
 * Safety sweep: release any commission_hold older than HOLD_STALE_MINUTES
 * regardless of pipe. Covers a pipe disabled while holding events, whose
 * per-pipe release never runs. No fresh row here, so these go out with whatever
 * was already parsed (usually nothing -> sparse).
 */
export async function releaseStaleCommissionHolds(
  supabase: SupabaseClient
): Promise<{ released: number; errors: string[] }> {
  const cutoff = new Date(Date.now() - HOLD_STALE_MINUTES * 60_000).toISOString()
  const { data, error } = await supabase
    .from('firm_deal_events')
    .select(HELD_SELECT)
    .eq('status', 'commission_hold')
    .lt('commission_hold_since', cutoff)
  if (error) return { released: 0, errors: [`load stale holds: ${error.message}`] }
  const holds = (data ?? []) as HeldEventRow[]
  if (holds.length === 0) return { released: 0, errors: [] }

  const errors: string[] = []
  const autoFireCache = new Map<string, boolean>()
  let released = 0
  for (const h of holds) {
    try {
      let af = autoFireCache.get(h.brokerage_pipe_id)
      if (af === undefined) {
        af = await loadAutoFire(supabase, h.brokerage_pipe_id)
        autoFireCache.set(h.brokerage_pipe_id, af)
      }
      await releaseOneHold(supabase, h, null, af)
      released++
    } catch (err) {
      errors.push(`stale release ${h.id}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }
  return { released, errors }
}
