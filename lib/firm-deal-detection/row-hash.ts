/**
 * lib/firm-deal-detection/row-hash.ts
 *
 * Computes a stable per-row identity hash so we can detect:
 *   1. Rows that newly appeared in a Month tab (Conditional -> Month migration)
 *   2. Rows that newly appeared anywhere (direct entry into a Month tab)
 *
 * The hash is intentionally *content-based* (not row-position-based) because
 * Sheets users reorder, insert, and delete rows constantly. A row that moved
 * from Conditional to "May 2026" must hash to the same value in both tabs.
 *
 * Identity is derived from the most-stable columns: MLS number first (it is
 * unique per listing in Canada), falling back to a normalized address +
 * closing date when MLS is blank.
 */
import { createHash } from 'node:crypto'

export interface ColumnLetterMap {
  address?: string         // e.g. 'A'
  mls?: string             // e.g. 'B'
  closing_date?: string    // e.g. 'K'
  // other columns not used for identity, but listed in the brokerage_pipes
  // column_mapping config for the parser
}

function letterToIndex(letter: string): number {
  // A -> 0, B -> 1, ..., Z -> 25, AA -> 26
  let n = 0
  for (const c of letter.toUpperCase()) {
    if (c < 'A' || c > 'Z') throw new Error(`Invalid column letter: ${letter}`)
    n = n * 26 + (c.charCodeAt(0) - 64)
  }
  return n - 1
}

function cellAt(row: string[], colLetter: string | undefined): string {
  if (!colLetter) return ''
  const idx = letterToIndex(colLetter)
  return (row[idx] ?? '').toString().trim()
}

function normalizeAddress(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')   // strip punctuation
    .replace(/\s+/g, ' ')       // collapse whitespace
    .trim()
}

/**
 * Cheap dirty-row filter: if all key columns are blank, this isn't a deal row
 * (it's a section divider like ["June"] or a stray label).
 */
export function isDataRow(row: string[], cols: ColumnLetterMap): boolean {
  const addr = cellAt(row, cols.address)
  const mls = cellAt(row, cols.mls)
  if (!addr && !mls) return false
  // also exclude rows where only the address column has a short month-like
  // value (e.g. just "June" as a divider)
  if (!mls && /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(addr) && addr.length < 12) {
    return false
  }
  return true
}

/**
 * Stable content hash for one row. Identical row content (anywhere on the
 * sheet, any tab) hashes the same.
 */
export function rowIdentityHash(row: string[], cols: ColumnLetterMap): string {
  const mls = cellAt(row, cols.mls).toUpperCase()
  if (mls) {
    return 'mls:' + sha256Short(mls)
  }
  const addr = normalizeAddress(cellAt(row, cols.address))
  const closing = cellAt(row, cols.closing_date).toUpperCase()
  return 'addr:' + sha256Short(addr + '|' + closing)
}

function sha256Short(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}
