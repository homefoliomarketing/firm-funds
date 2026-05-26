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
 * Why price_bucket and not exact price: sale price is often not on the
 * spreadsheet (Choice Realty's sheet doesn't have one), so we bucket to $5k
 * when we have it and leave it blank otherwise. Same deal across two pipes
 * will agree on bucket within a $5k window.
 */
import { createHash } from 'node:crypto'

export interface DealHashInputs {
  address?: string | null
  closing_date?: string | null   // ISO yyyy-mm-dd or any consistent string
  sale_price?: number | null
}

function normalizeAddressForHash(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function priceBucket(price: number | null | undefined): string {
  if (!price || !Number.isFinite(price)) return ''
  return String(Math.floor(price / 5000) * 5000)
}

export function computeDealHash(inputs: DealHashInputs): string {
  const addr = normalizeAddressForHash(inputs.address || '')
  const closing = (inputs.closing_date || '').toString().trim().toLowerCase()
  const bucket = priceBucket(inputs.sale_price)
  return createHash('sha256').update(`${addr}|${closing}|${bucket}`).digest('hex')
}
