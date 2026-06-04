/**
 * lib/firm-deal-detection/process-event.ts
 *
 * One-event pipeline: parse → dedup → match → status transition.
 *
 * Idempotent. Skips rows that are not in status='new' or 'errored', so
 * calling it twice on the same event is safe. The error path moves the
 * row to status='errored' with an error_message, never throws back to
 * the caller — the caller can keep processing the next event.
 *
 * Status transitions written here:
 *   new -> errored                      (parser/match failure)
 *   new -> duplicate                    (deal_hash already exists)
 *   new -> unmatched                    (review queue: ambiguous or unknown)
 *   new -> rejected                     (both sides outside/empty: no offer)
 *   new -> awaiting_approval            (matched at least one enrolled agent)
 *   new -> offer_sent      [future]     (auto_fire_enabled + matched)
 *
 * The orchestrator never sends notifications. The notification engine
 * picks up status='approved' (manual flow) or status='matched-and-auto-
 * fire' (auto-fire flow, to be added later) and dispatches.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  parseFirmDealEvent,
  type RawSpreadsheetPayload,
  type ParsedFirmDeal,
} from './parse-event'
import {
  loadBrokerageMatchContext,
  matchEvent,
  type BrokerageMatchContext,
  type EventMatchResult,
} from './match-agents'

export interface ProcessEventOptions {
  /** Reuse a context across many events at the same brokerage. */
  match_context?: BrokerageMatchContext
  /** Pre-loaded auto_fire_enabled for the event's pipe, to skip an extra query. */
  auto_fire_enabled?: boolean
  /**
   * Opt-in: re-process an event that's already in 'unmatched'. The cron
   * pipeline never sets this (otherwise it would re-process the same
   * unresolved rows forever); the admin-triggered "Re-run match" button
   * sets it after the matcher gains new capability or new agents land
   * in the brokerage roster.
   */
  allow_rematch?: boolean
}

// ---------------------------------------------------------------------------
// State machine — transition map (Task 6, 2026-05-27)
// ---------------------------------------------------------------------------
// Documents the legal status transitions for firm_deal_events.status. This is
// declarative documentation + a soft runtime guard, not a hard constraint:
// invalid transitions log a console.warn but still execute. We want to observe
// production for ~1 week first to discover any legitimate transitions we
// forgot before failing them at the DB level.
//
// Edges:
//   new                -> parsed | unmatched | awaiting_approval | approved
//                        | duplicate | errored
//                        (process-event.ts orchestrator destinations)
//   parsed             -> unmatched | awaiting_approval | approved | errored
//                        (intermediate hook for future async parse step)
//   unmatched          -> awaiting_approval | approved | rejected | errored
//                        (admin resolves in review queue)
//   awaiting_approval  -> approved | rejected | errored
//                        (admin clicks Send or Reject)
//   approved           -> offer_sent | errored
//                        (dispatch-notification.ts)
//   offer_sent         -> errored
//                        (terminal happy path; only escalates back to errored
//                         if a deferred channel later fails)
//   rejected           -> []  terminal
//   duplicate          -> []  terminal
//   errored            -> []  terminal in normal flow; admin may manually
//                        re-process via process-event.ts which accepts
//                        status='errored' as a retry source.
//
// TODO(harden): after ~1 week of clean production telemetry on these warnings,
// change isValidFirmDealEventTransition into a thrown Error in every status
// write site (here, dispatch-notification.ts, firm-deal-review-actions.ts) so
// the DB never holds an invalid row.
const FIRM_DEAL_EVENT_TRANSITIONS: Record<string, string[]> = {
  new: ['parsed', 'errored', 'duplicate', 'unmatched', 'awaiting_approval', 'approved'],
  parsed: ['unmatched', 'awaiting_approval', 'approved', 'errored'],
  unmatched: ['awaiting_approval', 'approved', 'rejected', 'errored'],
  awaiting_approval: ['approved', 'rejected', 'errored'],
  approved: ['offer_sent', 'errored'],
  offer_sent: ['errored'], // terminal happy path
  rejected: [], // terminal
  duplicate: [], // terminal
  errored: [], // terminal but admin may manually retry via processFirmDealEvent
}

export function isValidFirmDealEventTransition(from: string, to: string): boolean {
  return FIRM_DEAL_EVENT_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * Internal helper: assert a status transition is legal. Logs a console.warn
 * (not a throw) so production runs see it in logs but don't crash. After a
 * week of clean logs we'll harden this to a thrown error — see TODO above.
 *
 * `where` is a string tag for the call site so a noisy warning is easy to
 * trace back to the failing code path.
 */
function warnIfInvalidTransition(from: string, to: string, where: string): void {
  if (!isValidFirmDealEventTransition(from, to)) {
    console.warn(
      `[firm_deal_events] invalid status transition: ${from} -> ${to} (at ${where}). ` +
        'Allowed: ' +
        (FIRM_DEAL_EVENT_TRANSITIONS[from]?.join(', ') ||
          `(none — '${from}' is terminal)`)
    )
  }
}

export interface ProcessEventResult {
  event_id: string
  outcome: 'parsed_and_dispatched' | 'duplicate' | 'unmatched' | 'rejected' | 'awaiting_approval' | 'skipped' | 'errored'
  message?: string
  parsed?: ParsedFirmDeal
  match?: EventMatchResult
}

interface FirmDealEventRow {
  id: string
  brokerage_id: string
  brokerage_pipe_id: string
  source: 'spreadsheet' | 'email'
  raw_payload: unknown
  parsed: unknown
  deal_hash: string
  status: string
  matched_agent_id: string | null
  second_matched_agent_id: string | null
}

export async function processFirmDealEvent(
  eventId: string,
  supabase: SupabaseClient,
  options: ProcessEventOptions = {}
): Promise<ProcessEventResult> {
  // Load the event
  const { data: event, error: loadErr } = await supabase
    .from('firm_deal_events')
    .select('id, brokerage_id, brokerage_pipe_id, source, raw_payload, parsed, deal_hash, status, matched_agent_id, second_matched_agent_id')
    .eq('id', eventId)
    .single()

  if (loadErr || !event) {
    return { event_id: eventId, outcome: 'errored', message: `Failed to load event: ${loadErr?.message ?? 'not found'}` }
  }
  const e = event as FirmDealEventRow

  // Idempotency: only process 'new' or retry 'errored' by default. The
  // admin-triggered re-run match path opts in to 'unmatched' too (the
  // unmatched -> awaiting_approval transition is allowed by the state
  // machine; the gate is just to keep the cron pipeline from looping on
  // the same unresolved rows).
  const allowedStatuses: string[] = ['new', 'errored']
  if (options.allow_rematch) allowedStatuses.push('unmatched')
  if (!allowedStatuses.includes(e.status)) {
    return { event_id: eventId, outcome: 'skipped', message: `Status ${e.status} is terminal or in-flight; not reprocessing.` }
  }

  // Only the spreadsheet pipe is implemented in Phase 1
  if (e.source !== 'spreadsheet') {
    return await failEvent(supabase, eventId, `Unsupported source: ${e.source}`)
  }

  // -----------------------------------------------------------------
  // 1. Parse
  // -----------------------------------------------------------------
  let parsed: ParsedFirmDeal
  try {
    const result = await parseFirmDealEvent(e.raw_payload as RawSpreadsheetPayload)
    parsed = result.parsed
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown parser error'
    return await failEvent(supabase, eventId, `Parser failed: ${msg}`)
  }

  // -----------------------------------------------------------------
  // 2. Dedup — does another event share this deal_hash?
  //    Compare against events from the same brokerage that have already
  //    transitioned past 'new' (i.e. were genuinely processed). This
  //    keeps two simultaneous 'new' inserts of the same row from
  //    racing each other into both being marked duplicate.
  // -----------------------------------------------------------------
  const { data: dupes, error: dupErr } = await supabase
    .from('firm_deal_events')
    .select('id, status, received_at')
    .eq('brokerage_id', e.brokerage_id)
    .eq('deal_hash', e.deal_hash)
    .neq('id', eventId)
    .in('status', ['parsed', 'unmatched', 'awaiting_approval', 'approved', 'offer_sent', 'rejected'])
    .order('received_at', { ascending: true })
    .limit(1)
  if (dupErr) {
    return await failEvent(supabase, eventId, `Dedup query failed: ${dupErr.message}`)
  }

  if (dupes && dupes.length > 0) {
    warnIfInvalidTransition(e.status, 'duplicate', 'processFirmDealEvent:dedup')
    const { error: updErr } = await supabase
      .from('firm_deal_events')
      .update({
        parsed: parsed as unknown as Record<string, unknown>,
        parser_confidence: parsed.confidence,
        status: 'duplicate',
        processed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', eventId)
    if (updErr) return await failEvent(supabase, eventId, `Update to duplicate failed: ${updErr.message}`)
    return { event_id: eventId, outcome: 'duplicate', message: `Matches existing event ${dupes[0].id}`, parsed }
  }

  // -----------------------------------------------------------------
  // 3. Match agents
  // -----------------------------------------------------------------
  const ctx = options.match_context ?? (await loadBrokerageMatchContext(e.brokerage_id, supabase))
  const match = matchEvent(parsed.listing_agent_raw, parsed.selling_agent_raw, ctx)

  // -----------------------------------------------------------------
  // 4. Transition based on match outcome + pipe's auto-fire mode
  // -----------------------------------------------------------------
  // If the recommended status is 'awaiting_approval' AND this pipe has
  // auto_fire_enabled=true, skip the manual approval step and go straight
  // to 'approved' — the notification engine picks up approved rows and
  // dispatches. Manual review (auto_fire=false) is the Phase 1 default for
  // every brokerage; auto-fire flips on per brokerage after 20-30 validated
  // events.
  let finalStatus: string = match.recommended_status
  if (match.recommended_status === 'awaiting_approval') {
    const autoFire =
      options.auto_fire_enabled ??
      (await loadPipeAutoFire(supabase, e.brokerage_pipe_id))
    if (autoFire) finalStatus = 'approved'
  }

  // Side-aware writes. listing_matched_agent_id is set only when the
  // listing side resolved to a single enrolled agent (kind === 'agent');
  // same for selling. Teams (kind === 'team') don't fit a single column
  // so we leave the side column null and fall back to target_agent_ids
  // for the dispatch primary. matched_agent_id is the dispatch recipient,
  // derived as listing-first-then-selling so the existing dispatcher
  // (which only emails matched_agent_id) keeps working.
  //
  // Co-agent split case (Phase 1, 2026-05-28): one side returns kind='split'
  // with 2 enrolled agents. We populate matched_agent_id and
  // second_matched_agent_id with the two co-agents and stamp
  // co_agent_split=true so the dispatcher sends both agents the generic
  // variant (we don't know how the commission divides between them).
  const listingAgentId =
    match.listing.kind === 'agent' && match.listing.agent_id
      ? match.listing.agent_id
      : null
  const sellingAgentId =
    match.selling.kind === 'agent' && match.selling.agent_id
      ? match.selling.agent_id
      : null
  const primaryAgentId =
    listingAgentId ?? sellingAgentId ?? match.target_agent_ids[0] ?? null
  const secondaryAgentId =
    match.target_agent_ids.find(id => id !== primaryAgentId) ?? null

  warnIfInvalidTransition(e.status, finalStatus, 'processFirmDealEvent:match')

  const updateFields: Record<string, unknown> = {
    parsed: parsed as unknown as Record<string, unknown>,
    parser_confidence: parsed.confidence,
    status: finalStatus,
    processed_at: new Date().toISOString(),
    error_message: null,
    listing_matched_agent_id: listingAgentId,
    selling_matched_agent_id: sellingAgentId,
    matched_agent_id: primaryAgentId,
    second_matched_agent_id: secondaryAgentId,
    co_agent_split: match.co_agent_split,
  }

  const { error: updErr } = await supabase
    .from('firm_deal_events')
    .update(updateFields)
    .eq('id', eventId)
  if (updErr) {
    return await failEvent(supabase, eventId, `Status transition failed: ${updErr.message}`)
  }

  let outcome: ProcessEventResult['outcome']
  if (finalStatus === 'approved') outcome = 'parsed_and_dispatched'
  else if (match.recommended_status === 'awaiting_approval') outcome = 'awaiting_approval'
  else if (match.recommended_status === 'unmatched') outcome = 'unmatched'
  else outcome = 'rejected'

  return { event_id: eventId, outcome, parsed, match }
}

async function loadPipeAutoFire(supabase: SupabaseClient, pipeId: string): Promise<boolean> {
  const { data } = await supabase
    .from('brokerage_pipes')
    .select('auto_fire_enabled')
    .eq('id', pipeId)
    .single()
  return !!data?.auto_fire_enabled
}

async function failEvent(
  supabase: SupabaseClient,
  eventId: string,
  message: string
): Promise<ProcessEventResult> {
  // Best-effort transition validation: read the current status so the warn can
  // include from-state context. If the read fails we still update — the error
  // path must not depend on extra DB hits succeeding.
  const { data: cur } = await supabase
    .from('firm_deal_events')
    .select('status')
    .eq('id', eventId)
    .maybeSingle()
  if (cur?.status) {
    warnIfInvalidTransition(cur.status as string, 'errored', 'failEvent')
  }
  await supabase
    .from('firm_deal_events')
    .update({
      status: 'errored',
      error_message: message,
      processed_at: new Date().toISOString(),
    })
    .eq('id', eventId)
  return { event_id: eventId, outcome: 'errored', message }
}

/**
 * Convenience: process every status='new' event for a brokerage. Reuses
 * one match context and one auto-fire flag per pipe. Use after a poll batch.
 */
export async function processNewEventsForBrokerage(
  brokerageId: string,
  supabase: SupabaseClient
): Promise<ProcessEventResult[]> {
  const { data: newEvents, error } = await supabase
    .from('firm_deal_events')
    .select('id, brokerage_pipe_id')
    .eq('brokerage_id', brokerageId)
    .eq('status', 'new')
    .order('received_at', { ascending: true })
  if (error) throw new Error(`Load new events: ${error.message}`)
  if (!newEvents || newEvents.length === 0) return []

  const ctx = await loadBrokerageMatchContext(brokerageId, supabase)

  // Preload auto_fire_enabled for every pipe referenced in this batch
  const pipeIds = Array.from(new Set(newEvents.map(r => r.brokerage_pipe_id)))
  const { data: pipeRows } = await supabase
    .from('brokerage_pipes')
    .select('id, auto_fire_enabled')
    .in('id', pipeIds)
  const autoFireByPipe = new Map<string, boolean>()
  for (const p of pipeRows ?? []) autoFireByPipe.set(p.id, !!p.auto_fire_enabled)

  const results: ProcessEventResult[] = []
  for (const row of newEvents) {
    const result = await processFirmDealEvent(row.id, supabase, {
      match_context: ctx,
      auto_fire_enabled: autoFireByPipe.get(row.brokerage_pipe_id) ?? false,
    })
    results.push(result)
  }
  return results
}

/**
 * Process every brokerage that has status='new' events waiting: parse, match,
 * and transition each, aggregating per-brokerage outcome counts. A fatal error
 * for one brokerage is recorded in the summary and counted (errored++) so the
 * remaining brokerages still process. Used by the firm-deal-poller (inline,
 * right after polling) and by the standalone firm-deal-processor route.
 */
export async function processAllNewEvents(
  supabase: SupabaseClient
): Promise<{ processed: number; errored: number; brokerages: number; summary: Record<string, Record<string, number>> }> {
  const { data: pending, error } = await supabase
    .from('firm_deal_events')
    .select('brokerage_id')
    .eq('status', 'new')
    .order('received_at', { ascending: true })
  if (error) throw new Error(`Load pending events: ${error.message}`)

  const brokerageIds = Array.from(new Set((pending ?? []).map(r => r.brokerage_id as string)))
  const summary: Record<string, Record<string, number>> = {}
  let processed = 0
  let errored = 0

  for (const brokerageId of brokerageIds) {
    try {
      const results = await processNewEventsForBrokerage(brokerageId, supabase)
      const counts: Record<string, number> = {}
      for (const r of results) {
        counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
        processed++
        if (r.outcome === 'errored') errored++
      }
      summary[brokerageId] = counts
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      summary[brokerageId] = { fatal_error: 1 }
      errored++
      console.error(`[process-event] brokerage ${brokerageId} fatal:`, msg)
    }
  }

  return { processed, errored, brokerages: brokerageIds.length, summary }
}
