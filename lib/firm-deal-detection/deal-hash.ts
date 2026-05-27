/**
 * lib/firm-deal-detection/deal-hash.ts
 *
 * The schema-mandated dedup hash used by `firm_deal_events.deal_hash` so
 * that the SAME firm deal arriving through multiple pipes (e.g. spreadsheet
 * AND Postmark email in Phase 2) collapses into a duplicate event rather
 * than firing two offers.
 *
 * Schema comment from migration 078:
 *   sha256(normalized_address + closing_date + price_bucket_5k)
 *
 * Robustness upgrade (Task 5, 2026-05-27):
 *   The original recipe could collide for adjacent units in the same building
 *   (e.g. 220 Lake Ave Unit 1101 vs Unit 1102) when only the address column
 *   is filled, the closing dates land on the same day, and the brokerage
 *   doesn't track sale price. The MLS number is the strongest natural
 *   discriminator on the spreadsheet pipe — every real listing has one, and
 *   they're unique board-wide — so we now prefer it.
 *
 *   New recipe (in priority order):
 *     1. If MLS is present, hash on `mls:<MLS>` as the PRIMARY discriminator.
 *        Address + closing date come along as SECONDARY signal so a future
 *        pipe-2 event that has the same MLS but doesn't quite match on address
 *        still collapses. (Two different MLS numbers => two different deals,
 *        period.)
 *     2. If MLS is absent (exclusive listings, blank rows on Phase-2 email
 *        intake before AI parsing pulls one), fall back to the original
 *        address + closing + price-bucket trio, BUT also include the listing
 *        agent's name when available. Distinct listing agents on distinct
 *        units in the same building are by far the most common collision
 *        cause, and listing-agent identity is the next-strongest signal.
 *
 *   This change is backwards-compatible for one-pipe-only deployments (Phase
 *   1 only runs the spreadsheet pipe today, so there are no pre-existing
 *   cross-pipe collisions to worry about), and it tightens the hash for
 *   the typical Choice Realty row where MLS is always filled.
 */
import { createHash } from 'node:crypto'

export interface DealHashInputs {
  address?: string | null
  closing_date?: string | null   // ISO yyyy-mm-dd or any consistent string
  sale_price?: number | null
  /**
   * Optional MLS number. When present this becomes the primary discriminator
   * (two deals with different MLS numbers never share a hash, no matter how
   * similar the rest of their fields look).
   */
  mls_number?: string | null
  /**
   * Optional raw listing-agent cell value. Only consulted as a tie-breaker
   * when MLS is absent — provides extra separation between same-building
   * adjacent units that happen to share address + closing day.
   */
  listing_agent_raw?: string | null
}

function normalizeAddressForHash(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeMls(mls: string): string {
  return mls.toUpperCase().replace(/\s+/g, '').trim()
}

function normalizeAgent(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim()
}

function priceBucket(price: number | null | undefined): string {
  if (!price || !Number.isFinite(price)) return ''
  return String(Math.floor(price / 5000) * 5000)
}

export function computeDealHash(inputs: DealHashInputs): string {
  const addr = normalizeAddressForHash(inputs.address || '')
  const closing = (inputs.closing_date || '').toString().trim().toLowerCase()
  const bucket = priceBucket(inputs.sale_price)
  const mls = inputs.mls_number ? normalizeMls(inputs.mls_number) : ''

  // Primary path: MLS-anchored. Address + closing are kept in the digest so
  // pipes that surface the same MLS with a slightly different address (e.g.
  // "12 Main St" vs "12 Main Street") still collapse via the MLS token, while
  // pipes that share the address but emit different MLS numbers (legitimate
  // re-list scenarios) get distinct hashes.
  if (mls) {
    return createHash('sha256')
      .update(`mls:${mls}|addr:${addr}|close:${closing}|bucket:${bucket}`)
      .digest('hex')
  }

  // Fallback path: no MLS available. Same shape as the original recipe plus
  // the listing-agent cell as a tie-breaker. The literal `noMls:` prefix
  // prevents an accidental collision with the MLS-anchored branch above
  // (e.g. an empty MLS plus an address that just happens to start with
  // "mls:" wouldn't ever hash the same).
  const agent = inputs.listing_agent_raw ? normalizeAgent(inputs.listing_agent_raw) : ''
  return createHash('sha256')
    .update(`noMls:|addr:${addr}|close:${closing}|bucket:${bucket}|agent:${agent}`)
    .digest('hex')
}
