/**
 * lib/firm-deal-detection/match-agents.ts
 *
 * Resolves the raw agent strings the parser extracted ("Sarah", "Mike R",
 * "Exit") into one of five outcomes:
 *
 *   - agent      : single enrolled agent at this brokerage
 *   - team       : multiple enrolled agents (team shorthand like JTeam)
 *   - outside    : known outside brokerage / shorthand; no offer
 *   - ambiguous  : matches multiple in-office agents (e.g. "Bill" matches
 *                  Bill Vanderleest, Bill Fraser, Bill Montague)
 *   - unresolved : doesn't match anyone or anything known
 *
 * Resolution order:
 *   1. Per-brokerage learned mapping (brokerage_name_mapping table). This
 *      is the source of truth — anything the admin has tagged via the
 *      review queue wins outright.
 *   2. Heuristic match against enrolled agents at the same brokerage:
 *      - "Sarah"   -> first_name = 'Sarah'
 *      - "Mike R"  -> first_name = 'Mike' AND last_name LIKE 'R%'
 *      - "Bill V." -> same pattern, period stripped
 *      Exact (unique) match wins; multiple matches return ambiguous.
 *   3. If nothing matches, unresolved -> review queue.
 *
 * Per the plan, we do NOT hardcode common outside-brokerage names. The
 * review queue trains the system over time.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type MatchKind = 'agent' | 'team' | 'outside' | 'ambiguous' | 'unresolved' | 'empty'

export interface AgentCandidate {
  id: string
  first_name: string | null
  last_name: string | null
}

export interface MatchResult {
  kind: MatchKind
  /** Set when kind === 'agent' */
  agent_id?: string
  /** Set when kind === 'team' */
  team_agent_ids?: string[]
  /** Set when kind === 'ambiguous' — surface to admin so they can disambiguate */
  ambiguous_candidate_ids?: string[]
  /** The raw string that produced this match */
  raw: string | null
  /** Where the resolution came from */
  source: 'mapping' | 'heuristic' | null
}

interface NameMappingRow {
  shorthand_lower: string
  resolution: 'agent' | 'team' | 'outside'
  agent_id: string | null
  team_agent_ids: string[] | null
}

/**
 * Cached lookup tables for one brokerage. Build once per
 * matching pass; the underlying tables don't change inside a single tick.
 */
export interface BrokerageMatchContext {
  brokerage_id: string
  mapping_by_shorthand: Map<string, NameMappingRow>
  agents: AgentCandidate[]
}

export async function loadBrokerageMatchContext(
  brokerageId: string,
  supabase: SupabaseClient
): Promise<BrokerageMatchContext> {
  const [{ data: mappingRows, error: mappingErr }, { data: agentRows, error: agentsErr }] = await Promise.all([
    supabase
      .from('brokerage_name_mapping')
      .select('shorthand_lower, resolution, agent_id, team_agent_ids')
      .eq('brokerage_id', brokerageId),
    supabase
      .from('agents')
      .select('id, first_name, last_name')
      .eq('brokerage_id', brokerageId)
      .eq('status', 'active')
      .is('deleted_at', null),
  ])
  if (mappingErr) throw new Error(`load brokerage_name_mapping: ${mappingErr.message}`)
  if (agentsErr) throw new Error(`load agents: ${agentsErr.message}`)

  const mapping_by_shorthand = new Map<string, NameMappingRow>()
  for (const r of mappingRows ?? []) {
    mapping_by_shorthand.set(r.shorthand_lower, r as NameMappingRow)
  }
  return {
    brokerage_id: brokerageId,
    mapping_by_shorthand,
    agents: (agentRows ?? []) as AgentCandidate[],
  }
}

// ---------------------------------------------------------------------------
// Match logic
// ---------------------------------------------------------------------------

/** Drop punctuation, collapse whitespace, lowercase. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse a raw name string into possible first-name and last-initial parts.
 * Examples:
 *   "Sarah"       -> { first: 'sarah' }
 *   "Mike R"      -> { first: 'mike', lastInitial: 'r' }
 *   "Bill M."     -> { first: 'bill', lastInitial: 'm' }
 *   "Mary-Anne"   -> { first: 'mary-anne' }
 *   ""            -> null
 */
function parseFirstAndInitial(raw: string): { first: string; lastInitial?: string } | null {
  const norm = normalize(raw)
  if (!norm) return null
  const tokens = norm.split(' ')
  if (tokens.length === 1) return { first: tokens[0] }
  if (tokens.length === 2 && tokens[1].length === 1) {
    return { first: tokens[0], lastInitial: tokens[1] }
  }
  // Two-or-more tokens but second is not a single letter — treat the
  // first token as the first name and the first letter of the second as
  // the last initial. "Mary Smith" -> first=mary, lastInitial=s.
  // (Not common in this dataset but reasonable.)
  return { first: tokens[0], lastInitial: tokens[1][0] }
}

export function matchOneSide(
  rawValue: string | null | undefined,
  ctx: BrokerageMatchContext
): MatchResult {
  if (!rawValue || !rawValue.trim()) {
    return { kind: 'empty', raw: null, source: null }
  }

  const raw = rawValue.trim()
  const norm = normalize(raw)

  // 1. Per-brokerage learned mapping (case-insensitive exact match)
  const mapped = ctx.mapping_by_shorthand.get(norm)
  if (mapped) {
    if (mapped.resolution === 'agent' && mapped.agent_id) {
      return { kind: 'agent', agent_id: mapped.agent_id, raw, source: 'mapping' }
    }
    if (mapped.resolution === 'team' && mapped.team_agent_ids?.length) {
      return { kind: 'team', team_agent_ids: mapped.team_agent_ids, raw, source: 'mapping' }
    }
    if (mapped.resolution === 'outside') {
      return { kind: 'outside', raw, source: 'mapping' }
    }
    // Misconfigured row in name_mapping — fall through to heuristic.
  }

  // 2. Heuristic match against enrolled agents
  const parsed = parseFirstAndInitial(raw)
  if (!parsed) {
    return { kind: 'unresolved', raw, source: null }
  }

  const candidates = ctx.agents.filter(a => {
    if (!a.first_name) return false
    if (a.first_name.toLowerCase() !== parsed.first) return false
    if (parsed.lastInitial) {
      const ln = (a.last_name ?? '').toLowerCase()
      if (!ln.startsWith(parsed.lastInitial)) return false
    }
    return true
  })

  if (candidates.length === 1) {
    return { kind: 'agent', agent_id: candidates[0].id, raw, source: 'heuristic' }
  }
  if (candidates.length > 1) {
    return {
      kind: 'ambiguous',
      ambiguous_candidate_ids: candidates.map(c => c.id),
      raw,
      source: 'heuristic',
    }
  }
  return { kind: 'unresolved', raw, source: null }
}

// ---------------------------------------------------------------------------
// Event-level: resolve both sides + recommend an event status
// ---------------------------------------------------------------------------
export interface EventMatchResult {
  listing: MatchResult
  selling: MatchResult
  /**
   * The recommended firm_deal_events.status for this event. The orchestrator
   * may override (e.g. if a downstream send fails, status becomes 'errored').
   *
   *   - 'unmatched'         : at least one side is ambiguous or unresolved
   *                           and no other side fired clean — admin reviews.
   *   - 'awaiting_approval' : at least one side resolves to an enrolled
   *                           agent. Default while auto_fire_enabled=false.
   *   - 'rejected'          : both sides resolved to outside or empty — no
   *                           offer to make.
   *
   * Auto-fire vs manual approval is decided by the orchestrator based on
   * brokerage_pipes.auto_fire_enabled. This function recommends the
   * matching outcome only.
   */
  recommended_status: 'unmatched' | 'awaiting_approval' | 'rejected'
  /** Agents to ultimately offer to (deduplicated; same agent on both sides only counted once). */
  target_agent_ids: string[]
}

export function matchEvent(
  listingRaw: string | null | undefined,
  sellingRaw: string | null | undefined,
  ctx: BrokerageMatchContext
): EventMatchResult {
  const listing = matchOneSide(listingRaw, ctx)
  const selling = matchOneSide(sellingRaw, ctx)

  const sides = [listing, selling]
  const enrolledAgentIds = new Set<string>()
  for (const s of sides) {
    if (s.kind === 'agent' && s.agent_id) enrolledAgentIds.add(s.agent_id)
    if (s.kind === 'team' && s.team_agent_ids) {
      for (const id of s.team_agent_ids) enrolledAgentIds.add(id)
    }
  }
  const hasEnrolledAgent = enrolledAgentIds.size > 0
  const hasUnclearSide = sides.some(s => s.kind === 'ambiguous' || s.kind === 'unresolved')

  let recommended_status: EventMatchResult['recommended_status']
  if (hasEnrolledAgent && !hasUnclearSide) {
    recommended_status = 'awaiting_approval'
  } else if (hasUnclearSide) {
    recommended_status = 'unmatched'
  } else {
    // Both sides are outside or empty. No offer to make, no review needed.
    recommended_status = 'rejected'
  }

  return {
    listing,
    selling,
    recommended_status,
    target_agent_ids: Array.from(enrolledAgentIds),
  }
}
