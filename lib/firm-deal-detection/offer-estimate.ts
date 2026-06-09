/**
 * lib/firm-deal-detection/offer-estimate.ts
 *
 * Pure, side-effect-free helpers for quoting a firm-deal advance and picking
 * the notification variant for one agent on one event. Extracted from
 * dispatch-notification.ts so BOTH the outbound SMS/email AND the link-preview
 * card (app/agent/firm-deal/[token]) can quote the exact same number and tier
 * without pulling Resend / Twilio into a public route bundle.
 *
 * dispatch-notification.ts re-exports `estimateAdvanceFromGross`,
 * `pickAgentVariant`, and `NotifyTier` so existing import paths keep working.
 */
import type { ParsedFirmDeal } from './parse-event'

// ============================================================================
// Advance estimator — shared by email + SMS + preview card so all quote the
// same number
// ============================================================================
const RATE_PER_1000_PER_DAY = 0.80
const DEFAULT_SETTLEMENT_DAYS = 7

/**
 * Estimate the pre-split advance against a gross commission, given days
 * until closing. Mirrors lib/calculations.ts but treats the gross as the
 * net (brokerageSplitPct = 0) because at offer time we don't know the
 * agent's office split. The email + SMS both label the figure as
 * "before brokerage splits" so the inflation vs the real advance is
 * disclosed.
 */
export function estimateAdvanceFromGross(
  grossCommission: number,
  daysUntilClosing: number
): number {
  if (!Number.isFinite(grossCommission) || grossCommission <= 0) return 0
  // Funding day not charged (funds arrive next day); closing day IS charged.
  // Mirrors getChargeDays in lib/calculations.ts.
  const effectiveDays = Math.max(1, Math.floor(daysUntilClosing))
  const discountFee = grossCommission * (RATE_PER_1000_PER_DAY / 1000) * effectiveDays
  const settlementFee = grossCommission * (RATE_PER_1000_PER_DAY / 1000) * DEFAULT_SETTLEMENT_DAYS
  return Math.max(0, Math.round(grossCommission - discountFee - settlementFee))
}

// "2026-06-30" -> "June 30, 2026". Returns null for invalid/null input so
// the SMS renderer can detect "no date" and fall through to Tier A copy.
export function formatClosingDateHuman(iso: string | null): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December']
  const month = months[parseInt(m[2], 10) - 1]
  const day = parseInt(m[3], 10)
  return `${month} ${day}, ${m[1]}`
}

export function daysFromTodayToISO(iso: string | null): number {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 0
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const today = new Date(todayStr + 'T00:00:00Z').getTime()
  const closing = new Date(iso + 'T00:00:00Z').getTime()
  return Math.max(0, Math.ceil((closing - today) / (1000 * 60 * 60 * 24)))
}

// ============================================================================
// Per-agent variant selection (tiered by info available)
// ============================================================================
// Tier mapping (Bud's sensible defaults, 2026-05-29):
//   Tier A: property only                        — sparse, lowest confidence.
//   Tier B: property + closing date              — sparse_with_date.
//   Tier C: property + closing date + commission — detailed, quote the advance.
//
// Decision order (special-case picks beat tier picks):
//   1. Co-agent split event    -> sparse (generic, no numbers).
//   2. Same agent on both sides -> dual_agency.
//   3. Tier C                   -> detailed.
//   4. Tier B                   -> sparse_with_date.
//   5. Tier A                   -> sparse.
// ============================================================================
export type NotifyTier = 'A' | 'B' | 'C'

/** The subset of a firm_deal_events row that variant selection reads. */
export interface FirmDealEventForVariant {
  parsed: ParsedFirmDeal | null
  matched_agent_id: string | null
  second_matched_agent_id: string | null
  listing_matched_agent_id: string | null
  selling_matched_agent_id: string | null
  co_agent_split: boolean
}

export function pickAgentVariant(
  agentId: string,
  event: FirmDealEventForVariant
): {
  variant: 'sparse' | 'sparse_with_date' | 'dual_agency' | 'detailed'
  tier: NotifyTier
  commission_amount: number | null
  advance_estimate: number | null
} {
  const parsed = event.parsed
  const hasClosingDate = !!parsed?.closing_date_iso

  // Per-side commission lookup. We use listing_matched_agent_id /
  // selling_matched_agent_id (written by processFirmDealEvent) to decide
  // which side this agent is on; that wins over matched_agent_id which is
  // a flattened "first agent to dispatch to" slot.
  let commission: number | null = null
  if (parsed?.listing_agent_commission_amount && event.listing_matched_agent_id === agentId) {
    commission = parsed.listing_agent_commission_amount
  } else if (parsed?.selling_agent_commission_amount && event.selling_matched_agent_id === agentId) {
    commission = parsed.selling_agent_commission_amount
  }

  // Compute the tier letter independent of the visual variant pick so the
  // audit log always reflects what data was available, even when a special
  // case (split, dual agency) forced a generic visual variant.
  let tier: NotifyTier = 'A'
  if (commission && commission > 0 && hasClosingDate) tier = 'C'
  else if (hasClosingDate) tier = 'B'

  if (event.co_agent_split) {
    return { variant: 'sparse', tier, commission_amount: null, advance_estimate: null }
  }

  // Existing dual-agency: same agent matched on both sides.
  if (
    event.second_matched_agent_id &&
    event.second_matched_agent_id === event.matched_agent_id &&
    agentId === event.matched_agent_id
  ) {
    return { variant: 'dual_agency', tier, commission_amount: null, advance_estimate: null }
  }

  if (tier === 'C' && commission) {
    const days = daysFromTodayToISO(parsed!.closing_date_iso!)
    const advance = estimateAdvanceFromGross(commission, days)
    if (advance > 0) {
      return { variant: 'detailed', tier: 'C', commission_amount: commission, advance_estimate: advance }
    }
    // Advance came out non-positive (closing already past, etc.). Fall back
    // to the next tier down so the agent still gets something useful.
    return { variant: 'sparse_with_date', tier: 'B', commission_amount: null, advance_estimate: null }
  }

  if (tier === 'B') {
    return { variant: 'sparse_with_date', tier: 'B', commission_amount: null, advance_estimate: null }
  }

  return { variant: 'sparse', tier: 'A', commission_amount: null, advance_estimate: null }
}
