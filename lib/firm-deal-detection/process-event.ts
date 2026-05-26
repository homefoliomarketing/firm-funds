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

  // Idempotency: only process 'new' or retry 'errored'
  if (e.status !== 'new' && e.status !== 'errored') {
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
