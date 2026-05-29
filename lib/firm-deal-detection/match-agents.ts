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

export type MatchKind = 'agent' | 'team' | 'outside' | 'ambiguous' | 'unresolved' | 'empty' | 'split'

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
  /** Set when kind === 'split' — multiple co-agents share this side of the
   *  deal. We don't know each agent's share of the commission, so the
   *  dispatcher uses the generic variant for both. */
  split_agent_ids?: string[]
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

// Delimiters we recognise as separating co-agents on the same side of a deal.
// Order matters: longer / more specific tokens first so they win on splits
// like "Kyle and Tricia / Jane" (rare but plausible).
//
// Conservatively requires the delimiter NOT to be inside a known shorthand —
// e.g. "Re/Max" is a brokerage shorthand, not a split. We exempt mapped
// shorthands BEFORE attempting to split; if the whole raw value already
// resolves via the brokerage_name_mapping table the split layer never runs.
const SPLIT_DELIMITERS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\s+and\s+/i, name: 'and' },
  { pattern: /\s*&\s*/, name: 'ampersand' },
  { pattern: /\s*\/\s*/, name: 'slash' },
  { pattern: /\s*,\s*/, name: 'comma' },
  { pattern: /\s*\+\s*/, name: 'plus' },
  { pattern: /\n+/, name: 'newline' },
]

/**
 * Try every supported delimiter against `raw` and return the first split
 * that yields 2+ non-empty pieces. Returns null when no delimiter applies
 * (the cell is a single shorthand or a single name).
 */
function trySplit(raw: string): string[] | null {
  for (const { pattern } of SPLIT_DELIMITERS) {
    const parts = raw.split(pattern).map(p => p.trim()).filter(Boolean)
    if (parts.length >= 2) return parts
  }
  return null
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
  //    Runs FIRST so a brokerage shorthand like "Re/Max" or "Coldwell Banker"
  //    that contains a delimiter character resolves cleanly without the
  //    splitter mis-parsing it.
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

  // 2. Co-agent split detection — when the cell looks like "Kyle/Tricia",
  //    "Sarah & Bill V", "Mike R, Carlo" etc, try to resolve each piece
  //    independently. If 2+ pieces resolve to distinct enrolled agents we
  //    return kind='split' and the dispatcher knows to use the generic
  //    variant (we don't know how the commission splits between them).
  //
  //    If exactly one piece resolves cleanly and the others are
  //    unresolved/outside, we surface the lone match (still better than
  //    failing the whole side). If zero pieces resolve, fall through to
  //    the single-cell heuristic — the user may just have unusual
  //    punctuation in a single agent's name.
  const splitParts = trySplit(raw)
  if (splitParts) {
    const partResults = splitParts.map(part => matchOneSidePart(part, ctx))
    const enrolledIds = new Set<string>()
    for (const r of partResults) {
      if (r.kind === 'agent' && r.agent_id) enrolledIds.add(r.agent_id)
      if (r.kind === 'team' && r.team_agent_ids) {
        for (const id of r.team_agent_ids) enrolledIds.add(id)
      }
    }
    if (enrolledIds.size >= 2) {
      return {
        kind: 'split',
        split_agent_ids: Array.from(enrolledIds),
        raw,
        source: partResults[0].source ?? 'heuristic',
      }
    }
    if (enrolledIds.size === 1) {
      const lone = Array.from(enrolledIds)[0]
      return { kind: 'agent', agent_id: lone, raw, source: 'heuristic' }
    }
    // Zero enrolled agents resolved from the split — fall through to the
    // single-cell heuristic on the whole raw value. Worst case it stays
    // unresolved and the admin gets it in the review queue, same as before.
  }

  // 3. Heuristic match against enrolled agents (single-cell path)
  return matchSingleHeuristic(raw, ctx)
}

/**
 * Same single-cell heuristic as matchOneSide but skips the split step.
 * Used by the split path to resolve each delimiter-separated piece without
 * recursing into another split attempt.
 */
function matchOneSidePart(
  rawPart: string,
  ctx: BrokerageMatchContext
): MatchResult {
  if (!rawPart) return { kind: 'empty', raw: null, source: null }
  const norm = normalize(rawPart)
  const mapped = ctx.mapping_by_shorthand.get(norm)
  if (mapped) {
    if (mapped.resolution === 'agent' && mapped.agent_id) {
      return { kind: 'agent', agent_id: mapped.agent_id, raw: rawPart, source: 'mapping' }
    }
    if (mapped.resolution === 'team' && mapped.team_agent_ids?.length) {
      return { kind: 'team', team_agent_ids: mapped.team_agent_ids, raw: rawPart, source: 'mapping' }
    }
    if (mapped.resolution === 'outside') {
      return { kind: 'outside', raw: rawPart, source: 'mapping' }
    }
  }
  return matchSingleHeuristic(rawPart, ctx)
}

function matchSingleHeuristic(
  raw: string,
  ctx: BrokerageMatchContext
): MatchResult {
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
   *                           Also used when the total enrolled-agent count
   *                           exceeds what the matched/second slots can hold
   *                           (3+ agents across sides — admin sorts it out).
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
  /**
   * True when one side of the deal is a co-agent split (2+ enrolled agents
   * sharing the same side). Bubbled up to firm_deal_events so the
   * dispatcher uses the generic email/SMS variant for both agents (we
   * don't know each agent's share of the commission).
   */
  co_agent_split: boolean
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
    if (s.kind === 'split' && s.split_agent_ids) {
      for (const id of s.split_agent_ids) enrolledAgentIds.add(id)
    }
  }
  const hasEnrolledAgent = enrolledAgentIds.size > 0
  const hasUnclearSide = sides.some(s => s.kind === 'ambiguous' || s.kind === 'unresolved')
  const co_agent_split = sides.some(s => s.kind === 'split')

  // The matched_agent_id + second_matched_agent_id columns can hold at most
  // two distinct agents. When a split puts 3+ enrolled agents on the event
  // (e.g. listing-side split of 2 PLUS a single selling-side agent), route
  // to manual review rather than silently dropping one — the admin decides
  // which agents get the offer.
  const exceedsCapacity = enrolledAgentIds.size > 2

  let recommended_status: EventMatchResult['recommended_status']
  if (exceedsCapacity) {
    recommended_status = 'unmatched'
  } else if (hasEnrolledAgent && !hasUnclearSide) {
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
    co_agent_split,
  }
}
