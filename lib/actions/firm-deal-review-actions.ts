'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import { dispatchFirmDealNotification } from '@/lib/firm-deal-detection/dispatch-notification'
import type { ParsedFirmDeal } from '@/lib/firm-deal-detection/parse-event'
import { logAuditEvent } from '@/lib/audit'

type ActionResult<T = unknown> = { success: boolean; error?: string; data?: T }

// ============================================================================
// Types surfaced to the page
// ============================================================================

export type ReviewQueueRow = {
  id: string
  brokerage_id: string
  brokerage_name: string
  brokerage_pipe_id: string
  brand_name: string | null
  status: 'unmatched' | 'awaiting_approval' | 'errored' | 'offer_sent' | 'rejected' | 'duplicate'
  parser_confidence: 'high' | 'medium' | 'low' | null
  parsed: ParsedFirmDeal | null
  source_tab: string | null
  trigger: string | null
  received_at: string
  processed_at: string | null
  error_message: string | null
  matched_agent: { id: string; first_name: string | null; last_name: string | null } | null
  second_matched_agent: { id: string; first_name: string | null; last_name: string | null } | null
  listing_matched_agent: { id: string; first_name: string | null; last_name: string | null } | null
  selling_matched_agent: { id: string; first_name: string | null; last_name: string | null } | null
  // Brokerage's enrolled agents — passed once per brokerage so the UI can
  // build picker dropdowns without a second round-trip
  enrolled_agents: { id: string; first_name: string | null; last_name: string | null }[]
}

export type ReviewQueueResult = {
  pending: ReviewQueueRow[]
  recently_resolved: ReviewQueueRow[]
}

// ============================================================================
// List queue
// ============================================================================
export async function getFirmDealReviewQueue(): Promise<ActionResult<ReviewQueueResult>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  const supabase = createServiceRoleClient()

  // Pending: anything needing admin action.
  // We join the side-specific agent columns (added in migration 079) so
  // the UI knows which agent is on the listing vs selling side.
  // matched_agent / second_matched_agent are kept for back-compat but the
  // UI prefers the side-specific joins.
  const { data: pendingRows, error: pendingErr } = await supabase
    .from('firm_deal_events')
    .select(`
      id, brokerage_id, brokerage_pipe_id, status, parser_confidence,
      parsed, raw_payload, received_at, processed_at, error_message,
      matched_agent_id, second_matched_agent_id,
      listing_matched_agent_id, selling_matched_agent_id,
      matched_agent:agents!firm_deal_events_matched_agent_id_fkey(id, first_name, last_name),
      second_matched_agent:agents!firm_deal_events_second_matched_agent_id_fkey(id, first_name, last_name),
      listing_matched_agent:agents!firm_deal_events_listing_matched_agent_id_fkey(id, first_name, last_name),
      selling_matched_agent:agents!firm_deal_events_selling_matched_agent_id_fkey(id, first_name, last_name)
    `)
    .in('status', ['unmatched', 'awaiting_approval', 'errored'])
    .order('received_at', { ascending: false })
    .limit(200)

  if (pendingErr) return { success: false, error: pendingErr.message }

  // Recently resolved (last 7 days) — useful for review and undo confidence
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: resolvedRows, error: resolvedErr } = await supabase
    .from('firm_deal_events')
    .select(`
      id, brokerage_id, brokerage_pipe_id, status, parser_confidence,
      parsed, raw_payload, received_at, processed_at, error_message,
      matched_agent_id, second_matched_agent_id,
      listing_matched_agent_id, selling_matched_agent_id,
      matched_agent:agents!firm_deal_events_matched_agent_id_fkey(id, first_name, last_name),
      second_matched_agent:agents!firm_deal_events_second_matched_agent_id_fkey(id, first_name, last_name),
      listing_matched_agent:agents!firm_deal_events_listing_matched_agent_id_fkey(id, first_name, last_name),
      selling_matched_agent:agents!firm_deal_events_selling_matched_agent_id_fkey(id, first_name, last_name)
    `)
    .in('status', ['offer_sent', 'rejected', 'duplicate'])
    .gte('processed_at', sevenDaysAgo)
    .order('processed_at', { ascending: false })
    .limit(50)

  if (resolvedErr) return { success: false, error: resolvedErr.message }

  type Row = NonNullable<typeof pendingRows>[number]
  const allRows = [...(pendingRows ?? []), ...(resolvedRows ?? [])] as Row[]
  const brokerageIds = Array.from(new Set(allRows.map(r => r.brokerage_id)))
  const pipeIds = Array.from(new Set(allRows.map(r => r.brokerage_pipe_id)))

  // Bulk-load brokerages, pipes, and enrolled agents
  const [{ data: brokerages }, { data: pipes }, { data: agents }] = await Promise.all([
    supabase.from('brokerages').select('id, name').in('id', brokerageIds.length ? brokerageIds : ['00000000-0000-0000-0000-000000000000']),
    supabase.from('brokerage_pipes').select('id, brand_name').in('id', pipeIds.length ? pipeIds : ['00000000-0000-0000-0000-000000000000']),
    brokerageIds.length
      ? supabase
          .from('agents')
          .select('id, first_name, last_name, brokerage_id')
          .in('brokerage_id', brokerageIds)
          .eq('status', 'active')
          .is('deleted_at', null)
      : Promise.resolve({ data: [] as { id: string; first_name: string | null; last_name: string | null; brokerage_id: string }[] }),
  ])

  const brokerageNameById = new Map<string, string>()
  for (const b of brokerages ?? []) brokerageNameById.set(b.id, b.name)
  const brandByPipe = new Map<string, string | null>()
  for (const p of pipes ?? []) brandByPipe.set(p.id, p.brand_name ?? null)
  const agentsByBrokerage = new Map<string, { id: string; first_name: string | null; last_name: string | null }[]>()
  for (const a of agents ?? []) {
    const list = agentsByBrokerage.get(a.brokerage_id) ?? []
    list.push({ id: a.id, first_name: a.first_name, last_name: a.last_name })
    agentsByBrokerage.set(a.brokerage_id, list)
  }
  // Sort each brokerage's agents alphabetically by first_name
  for (const [k, list] of agentsByBrokerage.entries()) {
    list.sort((a, b) => (a.first_name ?? '').localeCompare(b.first_name ?? ''))
    agentsByBrokerage.set(k, list)
  }

  function toReviewRow(r: Row): ReviewQueueRow {
    const raw = (r.raw_payload as { source_tab?: string; trigger?: string } | null) ?? null
    return {
      id: r.id,
      brokerage_id: r.brokerage_id,
      brokerage_name: brokerageNameById.get(r.brokerage_id) ?? 'Unknown',
      brokerage_pipe_id: r.brokerage_pipe_id,
      brand_name: brandByPipe.get(r.brokerage_pipe_id) ?? null,
      status: r.status as ReviewQueueRow['status'],
      parser_confidence: r.parser_confidence as ReviewQueueRow['parser_confidence'],
      parsed: r.parsed as ParsedFirmDeal | null,
      source_tab: raw?.source_tab ?? null,
      trigger: raw?.trigger ?? null,
      received_at: r.received_at,
      processed_at: r.processed_at,
      error_message: r.error_message,
      // Supabase types these joins as arrays even when the FK is 1:1; pick first.
      matched_agent: Array.isArray(r.matched_agent)
        ? (r.matched_agent[0] as ReviewQueueRow['matched_agent']) ?? null
        : (r.matched_agent as ReviewQueueRow['matched_agent']),
      second_matched_agent: Array.isArray(r.second_matched_agent)
        ? (r.second_matched_agent[0] as ReviewQueueRow['second_matched_agent']) ?? null
        : (r.second_matched_agent as ReviewQueueRow['second_matched_agent']),
      listing_matched_agent: Array.isArray(r.listing_matched_agent)
        ? (r.listing_matched_agent[0] as ReviewQueueRow['listing_matched_agent']) ?? null
        : (r.listing_matched_agent as ReviewQueueRow['listing_matched_agent']),
      selling_matched_agent: Array.isArray(r.selling_matched_agent)
        ? (r.selling_matched_agent[0] as ReviewQueueRow['selling_matched_agent']) ?? null
        : (r.selling_matched_agent as ReviewQueueRow['selling_matched_agent']),
      enrolled_agents: agentsByBrokerage.get(r.brokerage_id) ?? [],
    }
  }

  return {
    success: true,
    data: {
      pending: (pendingRows ?? []).map(r => toReviewRow(r as Row)),
      recently_resolved: (resolvedRows ?? []).map(r => toReviewRow(r as Row)),
    },
  }
}

// ============================================================================
// Approve + dispatch (in-line, no cron wait)
// ============================================================================
export async function approveAndSendFirmDealOffer(eventId: string): Promise<ActionResult<{ sent: boolean }>> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  const supabase = createServiceRoleClient()

  // First transition to 'approved' so the dispatcher's idempotency check is happy
  const { data: existing, error: loadErr } = await supabase
    .from('firm_deal_events')
    .select('status, matched_agent_id')
    .eq('id', eventId)
    .single()
  if (loadErr || !existing) return { success: false, error: `Event not found: ${loadErr?.message}` }
  if (existing.status !== 'awaiting_approval') {
    return { success: false, error: `Status is ${existing.status}, expected awaiting_approval.` }
  }
  if (!existing.matched_agent_id) {
    return { success: false, error: 'No matched agent on event; cannot dispatch.' }
  }

  const { error: updErr } = await supabase
    .from('firm_deal_events')
    .update({ status: 'approved', reviewed_by: auth.user?.id, reviewed_at: new Date().toISOString() })
    .eq('id', eventId)
  if (updErr) return { success: false, error: updErr.message }

  await logAuditEvent({
    action: 'firm_deal_review.approved',
    entityType: 'firm_deal_event',
    entityId: eventId,
    oldValue: { status: existing.status },
    newValue: { status: 'approved' },
    metadata: {
      event_id: eventId,
      matched_agent_id: existing.matched_agent_id,
      reviewed_by_user_id: auth.user?.id,
    },
  })

  // Dispatch inline
  const result = await dispatchFirmDealNotification(eventId, supabase)

  await logAuditEvent({
    action: 'firm_deal_review.dispatch_completed',
    entityType: 'firm_deal_event',
    entityId: eventId,
    severity: result.outcome === 'offer_sent' ? 'info' : 'warning',
    metadata: {
      event_id: eventId,
      dispatch_outcome: result.outcome,
      dispatch_message: result.message ?? null,
      matched_agent_id: existing.matched_agent_id,
      reviewed_by_user_id: auth.user?.id,
    },
  })

  return {
    success: result.outcome === 'offer_sent',
    error: result.outcome !== 'offer_sent' ? result.message ?? `Dispatch outcome: ${result.outcome}` : undefined,
    data: { sent: result.outcome === 'offer_sent' },
  }
}

// ============================================================================
// Reject — admin says "don't send"
// ============================================================================
export async function rejectFirmDealOffer(eventId: string): Promise<ActionResult> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  const supabase = createServiceRoleClient()

  // Load the prior status for the audit trail. A maybeSingle keeps the
  // reject path resilient if the event was deleted out from under us — we
  // still try the update (and surface the error) but log the audit with a
  // null previous status rather than blowing up the whole call.
  const { data: prior } = await supabase
    .from('firm_deal_events')
    .select('status, brokerage_id, brokerage_pipe_id, matched_agent_id')
    .eq('id', eventId)
    .maybeSingle()

  const { error } = await supabase
    .from('firm_deal_events')
    .update({
      status: 'rejected',
      reviewed_by: auth.user?.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', eventId)
  if (error) return { success: false, error: error.message }

  await logAuditEvent({
    action: 'firm_deal_review.rejected',
    entityType: 'firm_deal_event',
    entityId: eventId,
    oldValue: prior ? { status: prior.status } : undefined,
    newValue: { status: 'rejected' },
    metadata: {
      event_id: eventId,
      brokerage_id: prior?.brokerage_id ?? null,
      brokerage_pipe_id: prior?.brokerage_pipe_id ?? null,
      matched_agent_id: prior?.matched_agent_id ?? null,
      reviewed_by_user_id: auth.user?.id,
    },
  })

  return { success: true }
}

// ============================================================================
// Resolve an unmatched event — admin picks the agent(s) and optionally
// remembers the mapping forever.
// ============================================================================
export interface ResolveUnmatchedInput {
  event_id: string
  /** What to do with the listing-agent side. */
  listing_action:
    | { kind: 'leave_as_parsed' }                                                // existing matched_agent stays
    | { kind: 'assign_agent'; agent_id: string; remember_shorthand?: string }    // single agent
    | { kind: 'assign_team'; agent_ids: string[]; remember_shorthand?: string }
    | { kind: 'mark_outside'; remember_shorthand?: string }
  selling_action:
    | { kind: 'leave_as_parsed' }
    | { kind: 'assign_agent'; agent_id: string; remember_shorthand?: string }
    | { kind: 'assign_team'; agent_ids: string[]; remember_shorthand?: string }
    | { kind: 'mark_outside'; remember_shorthand?: string }
  /** If true, after resolving, transition to awaiting_approval so the
   *  admin can immediately click Send (otherwise it stays in review).  */
  ready_to_approve: boolean
}

export async function resolveUnmatchedFirmDealEvent(
  input: ResolveUnmatchedInput
): Promise<ActionResult> {
  const auth = await getAuthenticatedAdmin()
  if (auth.error) return { success: false, error: auth.error }
  const supabase = createServiceRoleClient()

  // Load event
  const loaded = await supabase
    .from('firm_deal_events')
    .select('id, brokerage_id, status, parsed, matched_agent_id, second_matched_agent_id')
    .eq('id', input.event_id)
    .single()
  if (loaded.error || !loaded.data) return { success: false, error: `Event not found: ${loaded.error?.message}` }
  const event = loaded.data
  if (event.status !== 'unmatched' && event.status !== 'errored') {
    return { success: false, error: `Status is ${event.status}, cannot re-resolve.` }
  }

  type Side = ResolveUnmatchedInput['listing_action']

  // Side-aware resolution. Each action maps to exactly one side's column.
  // 'assign_agent' -> set side column to the picked agent.
  // 'assign_team'  -> use the first agent (schema only has one side column);
  //                   the existing target_agent_ids carries the full team for
  //                   dispatch (a Phase-2 enhancement).
  // 'mark_outside' / unresolved -> side column stays null.
  // 'leave_as_parsed' -> reuse whatever was already on that side.
  const fullEvent = await supabase
    .from('firm_deal_events')
    .select('listing_matched_agent_id, selling_matched_agent_id')
    .eq('id', input.event_id)
    .single()
  const prevListing = (fullEvent.data?.listing_matched_agent_id as string | null) ?? null
  const prevSelling = (fullEvent.data?.selling_matched_agent_id as string | null) ?? null

  function resolveSide(action: Side, prev: string | null): string | null {
    if (action.kind === 'assign_agent') return action.agent_id
    if (action.kind === 'assign_team') return action.agent_ids[0] ?? null
    if (action.kind === 'mark_outside') return null
    return prev // leave_as_parsed
  }

  const listingAgentId = resolveSide(input.listing_action, prevListing)
  const sellingAgentId = resolveSide(input.selling_action, prevSelling)

  // Dispatch primary: listing wins if present, else selling.
  const primaryAgentId = listingAgentId ?? sellingAgentId ?? null
  const secondaryAgentId =
    primaryAgentId === null
      ? null
      : primaryAgentId === listingAgentId
        ? sellingAgentId
        : listingAgentId

  const targetList: string[] = []
  if (primaryAgentId) targetList.push(primaryAgentId)
  if (secondaryAgentId && secondaryAgentId !== primaryAgentId) {
    targetList.push(secondaryAgentId)
  }
  // Teams may contribute extra IDs beyond the two side columns. Preserve
  // them in target_agent_ids semantics by appending uniques (used by
  // future multi-recipient dispatcher work).
  for (const action of [input.listing_action, input.selling_action]) {
    if (action.kind === 'assign_team') {
      for (const id of action.agent_ids) {
        if (!targetList.includes(id)) targetList.push(id)
      }
    }
  }

  // Insert any "remember" mappings
  const mappingRows: Array<{
    brokerage_id: string
    shorthand: string
    resolution: 'agent' | 'team' | 'outside'
    agent_id: string | null
    team_agent_ids: string[] | null
    created_by: string | null
  }> = []
  function maybeAddMapping(action: Side) {
    if ('remember_shorthand' in action && action.remember_shorthand) {
      const shorthand = action.remember_shorthand.trim()
      if (!shorthand) return
      if (action.kind === 'assign_agent') {
        mappingRows.push({
          brokerage_id: event.brokerage_id,
          shorthand,
          resolution: 'agent',
          agent_id: action.agent_id,
          team_agent_ids: null,
          created_by: auth.user?.id ?? null,
        })
      } else if (action.kind === 'assign_team') {
        if (action.agent_ids.length >= 2) {
          mappingRows.push({
            brokerage_id: event.brokerage_id,
            shorthand,
            resolution: 'team',
            agent_id: null,
            team_agent_ids: action.agent_ids,
            created_by: auth.user?.id ?? null,
          })
        }
      } else if (action.kind === 'mark_outside') {
        mappingRows.push({
          brokerage_id: event.brokerage_id,
          shorthand,
          resolution: 'outside',
          agent_id: null,
          team_agent_ids: null,
          created_by: auth.user?.id ?? null,
        })
      }
    }
  }
  maybeAddMapping(input.listing_action)
  maybeAddMapping(input.selling_action)

  if (mappingRows.length > 0) {
    // Use upsert so existing mappings get refreshed
    const { error: mappingErr } = await supabase
      .from('brokerage_name_mapping')
      .upsert(mappingRows, { onConflict: 'brokerage_id,shorthand_lower' })
    if (mappingErr) return { success: false, error: `Mapping insert failed: ${mappingErr.message}` }
  }

  // Decide new status
  let newStatus: 'unmatched' | 'awaiting_approval' | 'rejected'
  if (targetList.length === 0) {
    // Both sides resolved to outside or no agent assignment: no offer to make
    newStatus = 'rejected'
  } else if (input.ready_to_approve) {
    newStatus = 'awaiting_approval'
  } else {
    // Resolution captured, but admin not ready to send yet — leave queued
    // Use 'awaiting_approval' even without ready_to_approve so it leaves
    // the unmatched bucket and shows up under "ready to send".
    newStatus = 'awaiting_approval'
  }

  const updateFields: Record<string, unknown> = {
    status: newStatus,
    listing_matched_agent_id: listingAgentId,
    selling_matched_agent_id: sellingAgentId,
    matched_agent_id: primaryAgentId,
    second_matched_agent_id: secondaryAgentId,
    reviewed_by: auth.user?.id ?? null,
    reviewed_at: new Date().toISOString(),
    error_message: null,
  }
  const { error: updErr } = await supabase
    .from('firm_deal_events')
    .update(updateFields)
    .eq('id', input.event_id)
  if (updErr) return { success: false, error: updErr.message }

  await logAuditEvent({
    action: 'firm_deal_review.event_resolved',
    entityType: 'firm_deal_event',
    entityId: input.event_id,
    oldValue: {
      status: event.status,
      listing_matched_agent_id: prevListing,
      selling_matched_agent_id: prevSelling,
      matched_agent_id: event.matched_agent_id,
      second_matched_agent_id: event.second_matched_agent_id,
    },
    newValue: {
      status: newStatus,
      listing_matched_agent_id: listingAgentId,
      selling_matched_agent_id: sellingAgentId,
      matched_agent_id: primaryAgentId,
      second_matched_agent_id: secondaryAgentId,
    },
    metadata: {
      event_id: input.event_id,
      brokerage_id: event.brokerage_id,
      listing_action_kind: input.listing_action.kind,
      selling_action_kind: input.selling_action.kind,
      ready_to_approve: input.ready_to_approve,
      target_agent_ids: targetList,
      mappings_remembered: mappingRows.length,
      mapping_shorthands: mappingRows.map(m => m.shorthand),
      reviewed_by_user_id: auth.user?.id ?? null,
    },
  })

  return { success: true }
}
