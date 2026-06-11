/**
 * lib/firm-deal-detection/commission-hold-rules.ts
 *
 * PURE decision logic for the "wait one poll cycle for a missing commission"
 * feature. No DB, no audit, no server-only imports, so it loads under plain tsx
 * and is unit-testable in isolation. The side-effecting release machinery lives
 * in commission-hold.ts and imports from here.
 *
 * See commission-hold.ts for the full feature narrative.
 */
import type { ParsedFirmDeal } from './parse-event'

/** A poll only releases holds at least this old (minutes), so a quick manual
 *  re-run of the cron can't release a hold before a real cycle has passed. */
export const HOLD_MIN_MINUTES = 10
/** The poller's per-pipe release only runs for ENABLED pipes. If a pipe is
 *  disabled while it has holds, a global sweep releases them after this long so
 *  an offer is never stuck forever. */
export const HOLD_STALE_MINUTES = 25

export interface CommissionColumnMapping {
  listing_agent_commission?: string
  selling_agent_commission?: string
  [k: string]: string | undefined
}

/** Does this pipe's column mapping carry any commission column at all? If not,
 *  a commission can never appear later, so there is nothing to wait for. */
export function mapsCommissionColumns(
  cols: CommissionColumnMapping | null | undefined
): boolean {
  return !!(cols && (cols.listing_agent_commission || cols.selling_agent_commission))
}

/** True when BOTH sides' parsed commission is missing (null / non-positive). */
function commissionAmountsMissing(parsed: ParsedFirmDeal): boolean {
  const l = parsed.listing_agent_commission_amount
  const s = parsed.selling_agent_commission_amount
  const lMissing = l == null || !(l > 0)
  const sMissing = s == null || !(s > 0)
  return lMissing && sMissing
}

/**
 * Decide whether a freshly-matched event should be held one cycle for a
 * commission to appear. Held only when ALL of:
 *   - it would otherwise SEND (matched -> awaiting_approval / approved),
 *   - it has a closing date (a Tier C offer needs one; with no date there is
 *     no richer offer to wait for),
 *   - the pipe maps commission columns (so a commission CAN still appear),
 *   - no commission amount parsed on either side yet,
 *   - it is not a co-agent split (those always send the generic variant, so a
 *     commission would not change what the agents see).
 */
export function shouldHoldForCommission(input: {
  parsed: ParsedFirmDeal
  columnMapping: CommissionColumnMapping | null | undefined
  coAgentSplit: boolean
}): boolean {
  if (input.coAgentSplit) return false
  if (!input.parsed?.closing_date_iso) return false
  if (!mapsCommissionColumns(input.columnMapping)) return false
  return commissionAmountsMissing(input.parsed)
}

/** Read a cell by spreadsheet column letter ('A', 'B', ... 'AA'). */
export function cellByLetter(row: string[], letter: string | undefined): string {
  if (!letter) return ''
  let n = 0
  for (const c of letter.toUpperCase()) {
    if (c < 'A' || c > 'Z') return ''
    n = n * 26 + (c.charCodeAt(0) - 64)
  }
  return (row[n - 1] ?? '').toString().trim()
}

/**
 * Parse a commission AMOUNT cell to whole dollars. Returns null when the cell
 * is blank, a percentage (the amount column is dollars; percentages live in a
 * separate column), or otherwise non-numeric. Mirrors what the AI parser writes
 * into *_commission_amount for a clean dollar column.
 */
export function parseMoneyCell(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const s = raw.toString().trim()
  if (!s || s.includes('%')) return null
  const cleaned = s.replace(/[^0-9.]/g, '')
  if (!cleaned || cleaned === '.') return null
  const n = Number.parseFloat(cleaned)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}
