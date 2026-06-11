'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser, getAuthenticatedWriter } from '@/lib/auth-helpers'
import {
  sendBrokerageOfferNudge2h,
  sendAgentDeclineNotification,
} from '@/lib/firm-deal-detection/dispatch-brokerage-offer'
import {
  performFirmDealOfferAcceptance,
  type AcceptFirmDealOfferResult,
} from '@/lib/firm-deal-detection/offer-acceptance'
import { logAuditEvent } from '@/lib/audit'

type ActionResult<T = unknown> = { success: boolean; error?: string; data?: T }

// UUID v4-ish sanity check — keep ill-formed strings out of DB queries.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ============================================================================
// Agent-facing — fetch the offer details for a firm_deal_events row, but only
// if the logged-in agent is the one the offer was sent to. Powers the offer
// banner that appears on /agent when the agent lands via the magic link with
// ?firm_deal=<id>.
//
// Security: the route /agent/firm-deal/[token] only ever redirects with an
// event id whose token already proved ownership, but a curious user could
// hand-craft the URL with someone else's id. So this action re-checks the
// caller's agent_id against the event's matched_agent_id /
// second_matched_agent_id before returning anything.
// ============================================================================

export interface FirmDealOfferSummary {
  event_id: string
  brokerage_id: string
  address: string | null
  closing_date_iso: string | null
  mls_number: string | null
  brand_name: string | null
  /** Set once a deal record has been linked to this offer; until then null. */
  offer_deal_id: string | null
  /**
   * True when this agent has pre-requested the advance (onboarding "All set"
   * page) but the offer hasn't been accepted yet. The brokerage notification
   * is held until Firm Funds activates the account; see preRequestFirmDealOffer
   * and fireQueuedFirmDealOffersForAgent.
   */
  pre_requested: boolean
  /** When the offer was sent (email or SMS). null if not yet sent. */
  sent_at: string | null
}

// Columns every offer-summary read needs. Keep in sync with OfferEventRow +
// buildOfferSummaryFromEvent.
const OFFER_EVENT_COLUMNS = `
  id, brokerage_id, brokerage_pipe_id,
  parsed, status, matched_agent_id, second_matched_agent_id,
  offer_deal_id, second_offer_deal_id,
  agent_pre_request_at, second_agent_pre_request_at,
  email_sent_at, sms_sent_at, received_at
`

interface OfferEventRow {
  id: string
  brokerage_id: string
  brokerage_pipe_id: string | null
  parsed: { address?: string | null; closing_date_iso?: string | null; mls_number?: string | null } | null
  status: string
  matched_agent_id: string | null
  second_matched_agent_id: string | null
  offer_deal_id: string | null
  second_offer_deal_id: string | null
  agent_pre_request_at: string | null
  second_agent_pre_request_at: string | null
  email_sent_at: string | null
  sms_sent_at: string | null
  received_at: string | null
}

// Assemble the agent-facing summary for one event row, picking the correct
// side (primary vs second matched agent). Returns null when the caller isn't
// matched to this offer at all — callers surface that as "no offer", which is
// also the leak-safe answer for a hand-crafted event id.
async function buildOfferSummaryFromEvent(
  supabase: ReturnType<typeof createServiceRoleClient>,
  row: OfferEventRow,
  myAgentId: string
): Promise<FirmDealOfferSummary | null> {
  const isPrimary = row.matched_agent_id === myAgentId
  const isSecondary = row.second_matched_agent_id === myAgentId
  if (!isPrimary && !isSecondary) return null

  // Pipe brand for the banner copy ("Choice Advances" reads better than "Firm
  // Funds" when the email came from the white-label).
  const { data: pipe } = await supabase
    .from('brokerage_pipes')
    .select('brand_name')
    .eq('id', row.brokerage_pipe_id)
    .maybeSingle()

  const parsed = (row.parsed ?? {}) as {
    address?: string | null
    closing_date_iso?: string | null
    mls_number?: string | null
  }
  // Pick whichever side this agent is on so the linked deal / pre-request flag
  // belong to them, not the co-agent on a dual-side deal.
  const offerDealId = isPrimary ? row.offer_deal_id : row.second_offer_deal_id
  const preReqAt = isPrimary ? row.agent_pre_request_at : row.second_agent_pre_request_at

  return {
    event_id: row.id,
    brokerage_id: row.brokerage_id,
    address: parsed.address ?? null,
    closing_date_iso: parsed.closing_date_iso ?? null,
    mls_number: parsed.mls_number ?? null,
    brand_name: pipe?.brand_name ?? null,
    offer_deal_id: (offerDealId as string | null) ?? null,
    pre_requested: !!preReqAt,
    sent_at: row.email_sent_at ?? row.sms_sent_at ?? null,
  }
}

export async function getFirmDealOfferForCurrentAgent(
  eventId: string
): Promise<ActionResult<FirmDealOfferSummary | null>> {
  if (!eventId || typeof eventId !== 'string') {
    return { success: false, error: 'Missing event id.' }
  }
  if (!UUID_RE.test(eventId)) {
    return { success: false, error: 'Invalid event id.' }
  }

  const auth = await getAuthenticatedUser(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }

  const supabase = createServiceRoleClient()
  const { data, error } = await supabase
    .from('firm_deal_events')
    .select(OFFER_EVENT_COLUMNS)
    .eq('id', eventId)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!data) return { success: true, data: null }

  // buildOfferSummaryFromEvent returns null when the caller isn't the matched
  // agent, so a guessed id leaks nothing about other agents' offers.
  const summary = await buildOfferSummaryFromEvent(
    supabase,
    data as OfferEventRow,
    auth.profile.agent_id as string
  )
  return { success: true, data: summary }
}

// ============================================================================
// getLatestOutstandingFirmDealOfferForCurrentAgent
//
// Surfaces a firm-deal offer for the logged-in agent WITHOUT needing the
// ?firm_deal=<id> URL param. This is what makes an offer persist on the agent
// dashboard + setup page after the agent navigates away from (or never used)
// the email/SMS magic link. Before this, an offer the agent hadn't accepted
// was invisible once the magic-link param was gone — the deal that "brought
// them here" simply vanished.
//
// Returns the newest offer that is:
//   - matched to this agent (primary or second side),
//   - actually sent to them (email_sent_at or sms_sent_at set),
//   - NOT yet turned into a deal on their side (offer_deal_id null) — an
//     accepted offer already shows as an 'offered' row in their list, so
//     re-surfacing it as a banner on every visit would just be noise,
//   - not past its closing date (can't be accepted anyway).
//
// A pre-requested-but-not-yet-fired offer still qualifies (offer_deal_id is
// null until activation fires it); the summary's pre_requested flag lets the
// UI show "requested, waiting for approval" instead of the accept CTA.
// ============================================================================

export async function getLatestOutstandingFirmDealOfferForCurrentAgent(): Promise<
  ActionResult<FirmDealOfferSummary | null>
> {
  const auth = await getAuthenticatedUser(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }
  const myAgentId = auth.profile.agent_id as string
  const supabase = createServiceRoleClient()

  // Pull this agent's recent matched events (either side), newest first. The
  // agent id is a validated UUID from the session, so it's safe to interpolate
  // into the PostgREST .or() filter.
  const { data: rows, error } = await supabase
    .from('firm_deal_events')
    .select(OFFER_EVENT_COLUMNS)
    .or(`matched_agent_id.eq.${myAgentId},second_matched_agent_id.eq.${myAgentId}`)
    .order('received_at', { ascending: false })
    .limit(20)

  if (error) return { success: false, error: error.message }
  if (!rows || rows.length === 0) return { success: true, data: null }

  const todayInToronto = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

  for (const row of rows as OfferEventRow[]) {
    const isPrimary = row.matched_agent_id === myAgentId
    const offerDealId = isPrimary ? row.offer_deal_id : row.second_offer_deal_id
    if (offerDealId) continue // already a deal in their list
    const sentAt = row.email_sent_at ?? row.sms_sent_at ?? null
    if (!sentAt) continue // never actually sent to the agent
    const closing = (row.parsed ?? {}).closing_date_iso ?? null
    if (closing && /^\d{4}-\d{2}-\d{2}$/.test(closing) && closing < todayInToronto) continue // past closing

    const summary = await buildOfferSummaryFromEvent(supabase, row, myAgentId)
    if (summary) return { success: true, data: summary }
  }

  return { success: true, data: null }
}

// ============================================================================
// acceptFirmDealOffer — agent clicks the offer banner CTA.
//
// Creates a placeholder `deals` row in status='offered' carrying the address
// and closing date from the firm_deal_events row. The financial columns are
// inserted as 0 placeholders; the UI hides them on offered rows so the agent
// never sees fake numbers. When the brokerage admin later submits, the same
// row gets updated with the real numbers and flipped to 'under_review'.
//
// Then notifies the brokerage admin team. Side-effect ordering:
//   1. INSERT deal       — must succeed first or we have nothing to track.
//   2. UPDATE event link — back-link offer_deal_id so the banner won't
//                          re-prompt + the cron can find the row.
//   3. Send notification — best-effort. We swallow send failures because
//                          the offered deal exists either way and the
//                          nudge cron will pick it up at 2h.
//
// Idempotent: if offer_deal_id is already set for this agent's side of the
// event, we return the existing deal id rather than double-creating.
// ============================================================================

// AcceptFirmDealOfferResult is defined alongside the shared acceptance core in
// lib/firm-deal-detection/offer-acceptance.ts and re-exported via the import
// above, so both the agent-click path and the pre-request-on-activation path
// return the identical shape.

// ----------------------------------------------------------------------------
// Dual-agency behavior (Phase 1) — documented in one place
// ----------------------------------------------------------------------------
// When matchEvent resolves BOTH the listing-agent side and the selling-agent
// side to enrolled agents at the same brokerage (the canonical "dual agency"
// case where two of our agents represent each side of one transaction), both
// agents are wired to the same firm_deal_events row via matched_agent_id and
// second_matched_agent_id. The offer notification is delivered to each agent
// independently, and either one can accept independently of the other through
// the function below.
//
// Phase 1 behavior:
//   - Each side gets its own offered deal row in the `deals` table.
//   - The event's offer_deal_id (primary) and second_offer_deal_id (secondary)
//     are populated independently so neither side blocks the other.
//   - The brokerage receives a separate email per acceptance (one for each
//     side's offered deal). This is intentional — they need a distinct portal
//     URL per deal to submit each one.
//   - The brokerage submits each side as a separate advance request. Two
//     deals, two contracts, two settlements.
//
// This is deliberately NOT merged into a single dual-agency advance for Phase
// 1 because:
//   1. Each agent has their own commission, KYC, and bank info — the existing
//      single-agent deal model fits one side at a time.
//   2. Either agent may decline (or be declined) independently; merging would
//      force coupling that doesn't match how the brokerage handles them.
//   3. The brokerage admin already mentally treats each side as separate
//      payouts on their books.
//
// TODO (post-Phase 1, product decision): consider whether to merge dual-side
// accepts into a single deal row with two agent_ids and split disbursements.
// Requires schema changes (multi-agent payouts) and is not on the near-term
// roadmap. Until then the two-row pattern stays.
// ----------------------------------------------------------------------------

export async function acceptFirmDealOffer(
  eventId: string
): Promise<ActionResult<AcceptFirmDealOfferResult>> {
  if (!eventId || typeof eventId !== 'string') {
    return { success: false, error: 'Missing event id.' }
  }
  if (!UUID_RE.test(eventId)) {
    return { success: false, error: 'Invalid event id.' }
  }

  const auth = await getAuthenticatedWriter(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }

  // All the real work (ownership re-check, closing-date validation, recipient
  // gate, race-safe insert, brokerage notification + retry enqueue, audit)
  // lives in the shared core so the pre-request-on-activation path runs the
  // exact same logic without a user session.
  const supabase = createServiceRoleClient()
  return performFirmDealOfferAcceptance(supabase, {
    eventId,
    agentId: auth.profile.agent_id as string,
    actor: { kind: 'agent', userId: auth.user?.id ?? null },
  })
}

// ============================================================================
// preRequestFirmDealOffer — agent opts in to the advance from the onboarding
// "You're all set" page, BEFORE Firm Funds has activated their account.
//
// We don't notify the brokerage yet (the agent isn't approved). Instead we
// stamp agent_pre_request_at on the event. When Firm Funds approves the
// account (KYC verified AND banking approved -> account_activated_at set), the
// approval action calls fireQueuedFirmDealOffersForAgent, which runs the normal
// acceptance on the agent's behalf — creating the offered deal and notifying
// the brokerage. The agent never has to log back in to kick it off.
//
// Edge case: if the agent is somehow ALREADY activated when they pre-request
// (e.g. an admin approved them in the same minute), we skip the queue and
// accept immediately so the request never gets stranded.
// ============================================================================

export async function preRequestFirmDealOffer(
  eventId: string
): Promise<ActionResult<{ pre_requested: boolean; accepted_now: boolean; deal_id?: string }>> {
  if (!eventId || typeof eventId !== 'string') {
    return { success: false, error: 'Missing event id.' }
  }
  if (!UUID_RE.test(eventId)) {
    return { success: false, error: 'Invalid event id.' }
  }

  const auth = await getAuthenticatedWriter(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }
  const myAgentId = auth.profile.agent_id as string

  const supabase = createServiceRoleClient()

  const { data: event, error: eventErr } = await supabase
    .from('firm_deal_events')
    .select(
      'id, matched_agent_id, second_matched_agent_id, offer_deal_id, second_offer_deal_id, agent_pre_request_at, second_agent_pre_request_at'
    )
    .eq('id', eventId)
    .maybeSingle()
  if (eventErr) return { success: false, error: eventErr.message }
  if (!event) return { success: false, error: 'Offer not found.' }

  const isPrimary = event.matched_agent_id === myAgentId
  const isSecondary = event.second_matched_agent_id === myAgentId
  if (!isPrimary && !isSecondary) {
    return { success: false, error: 'This offer is not yours to request.' }
  }

  // Already accepted on this side — the offered deal exists; nothing to queue.
  const existingDealId = isPrimary ? event.offer_deal_id : event.second_offer_deal_id
  if (existingDealId) {
    return {
      success: true,
      data: { pre_requested: true, accepted_now: false, deal_id: existingDealId as string },
    }
  }

  // If the account is already activated, accept immediately rather than queue.
  const { data: agent } = await supabase
    .from('agents')
    .select('account_activated_at')
    .eq('id', myAgentId)
    .maybeSingle()
  if (agent?.account_activated_at) {
    const res = await performFirmDealOfferAcceptance(supabase, {
      eventId,
      agentId: myAgentId,
      actor: { kind: 'agent', userId: auth.user?.id ?? null },
    })
    if (!res.success || !res.data) {
      return { success: false, error: res.error || 'We could not submit your request. Please try again.' }
    }
    return {
      success: true,
      data: { pre_requested: true, accepted_now: true, deal_id: res.data.deal_id },
    }
  }

  // Otherwise record the pre-request intent on this agent's side of the event.
  const col = isPrimary ? 'agent_pre_request_at' : 'second_agent_pre_request_at'
  const alreadyPre = isPrimary ? event.agent_pre_request_at : event.second_agent_pre_request_at
  if (!alreadyPre) {
    const { error: updErr } = await supabase
      .from('firm_deal_events')
      .update({ [col]: new Date().toISOString() })
      .eq('id', eventId)
    if (updErr) {
      return { success: false, error: `We could not record your request: ${updErr.message}` }
    }
  }

  await logAuditEvent({
    action: 'deal.firm_deal_offer_pre_requested',
    entityType: 'firm_deal_event',
    entityId: eventId,
    metadata: {
      agent_id: myAgentId,
      side: isPrimary ? 'primary' : 'secondary',
      triggered_by_user_id: auth.user?.id ?? null,
    },
  })

  return { success: true, data: { pre_requested: true, accepted_now: false } }
}

// ============================================================================
// agentTakeOverOffer — the agent decides to submit the offered deal themselves
// instead of waiting on their brokerage.
//
// Sets deals.agent_self_submit_at = now() (migration 105). That flag PAUSES the
// brokerage on this offer: it drops out of the submit-on-behalf queue, the
// brokerage convert/decline actions refuse it, and the nudge crons skip it.
// This is the guard that prevents a duplicate submission (agent + brokerage
// both submitting the same offer). The agent then continues to the new-deal
// form via ?fromOffer=<dealId>, which converts this same row in place.
//
// Ownership + status are re-checked server-side; agent_self_submit_at must be
// NULL so a double-click can't thrash the flag.
// ============================================================================

export async function agentTakeOverOffer(
  dealId: string
): Promise<ActionResult<{ deal_id: string }>> {
  if (!dealId || typeof dealId !== 'string') {
    return { success: false, error: 'Missing deal id.' }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dealId)) {
    return { success: false, error: 'Invalid deal id.' }
  }

  const auth = await getAuthenticatedWriter(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }
  const myAgentId = auth.profile.agent_id as string

  const supabase = createServiceRoleClient()
  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .select('id, agent_id, brokerage_id, status, agent_self_submit_at')
    .eq('id', dealId)
    .maybeSingle()
  if (dealErr) return { success: false, error: dealErr.message }
  if (!deal) return { success: false, error: 'Deal not found.' }
  if (deal.agent_id !== myAgentId) {
    return { success: false, error: 'This deal does not belong to you.' }
  }
  if (deal.status !== 'offered') {
    return {
      success: false,
      error: 'This offer can no longer be taken over (it is no longer awaiting submission).',
    }
  }
  if (deal.agent_self_submit_at) {
    // Already flagged — treat as success so a double-click is idempotent.
    return { success: true, data: { deal_id: dealId } }
  }

  const nowIso = new Date().toISOString()
  // CAS-style guard: only flip while still offered AND not already taken over,
  // so we never reopen the brokerage's path out from under a concurrent action.
  const { data: updated, error: updateErr } = await supabase
    .from('deals')
    .update({ agent_self_submit_at: nowIso })
    .eq('id', dealId)
    .eq('status', 'offered')
    .is('agent_self_submit_at', null)
    .select('id')
    .maybeSingle()
  if (updateErr) {
    return { success: false, error: `Failed to take over this offer: ${updateErr.message}` }
  }
  if (!updated) {
    return {
      success: false,
      error: 'This offer was just updated. Please reload and try again.',
    }
  }

  await logAuditEvent({
    action: 'deal.firm_deal_offer_agent_takeover',
    entityType: 'deal',
    entityId: dealId,
    metadata: {
      brokerage_id: deal.brokerage_id,
      agent_id: myAgentId,
      triggered_by_user_id: auth.user?.id ?? null,
      taken_over_at: nowIso,
    },
  })

  return { success: true, data: { deal_id: dealId } }
}

// ============================================================================
// agentHandBackOffer — the agent changes their mind and hands the offer back
// to their brokerage. Clears deals.agent_self_submit_at, which RESUMES the
// brokerage flow (the offer reappears in their queue and the nudge crons pick
// it back up). Prevents an offer from being stranded if the agent took it over
// but never finished submitting.
// ============================================================================

export async function agentHandBackOffer(
  dealId: string
): Promise<ActionResult<{ deal_id: string }>> {
  if (!dealId || typeof dealId !== 'string') {
    return { success: false, error: 'Missing deal id.' }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dealId)) {
    return { success: false, error: 'Invalid deal id.' }
  }

  const auth = await getAuthenticatedWriter(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }
  const myAgentId = auth.profile.agent_id as string

  const supabase = createServiceRoleClient()
  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .select('id, agent_id, brokerage_id, status, agent_self_submit_at')
    .eq('id', dealId)
    .maybeSingle()
  if (dealErr) return { success: false, error: dealErr.message }
  if (!deal) return { success: false, error: 'Deal not found.' }
  if (deal.agent_id !== myAgentId) {
    return { success: false, error: 'This deal does not belong to you.' }
  }
  if (deal.status !== 'offered') {
    return {
      success: false,
      error: 'This offer can no longer be handed back (it is no longer awaiting submission).',
    }
  }
  if (!deal.agent_self_submit_at) {
    // Not currently taken over — nothing to hand back. Idempotent success.
    return { success: true, data: { deal_id: dealId } }
  }

  const { error: updateErr } = await supabase
    .from('deals')
    .update({ agent_self_submit_at: null })
    .eq('id', dealId)
    .eq('status', 'offered')
  if (updateErr) {
    return { success: false, error: `Failed to hand this offer back: ${updateErr.message}` }
  }

  await logAuditEvent({
    action: 'deal.firm_deal_offer_agent_handed_back',
    entityType: 'deal',
    entityId: dealId,
    metadata: {
      brokerage_id: deal.brokerage_id,
      agent_id: myAgentId,
      triggered_by_user_id: auth.user?.id ?? null,
    },
  })

  return { success: true, data: { deal_id: dealId } }
}

// ============================================================================
// declineFirmDealOffer — brokerage admin marks the offer as not qualifying.
// Sets status='cancelled' + records the reason. Agent dashboard shows the
// outcome on the offered-deal detail page.
// ============================================================================

export async function declineFirmDealOffer(
  dealId: string,
  reason: string
): Promise<ActionResult<{ deal_id: string }>> {
  if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) {
    return { success: false, error: 'Invalid deal id.' }
  }
  const trimmed = (reason ?? '').trim()
  if (trimmed.length < 3) {
    return { success: false, error: 'Please add a short reason so the agent understands.' }
  }
  if (trimmed.length > 500) {
    return { success: false, error: 'Reason is too long (max 500 chars).' }
  }

  const auth = await getAuthenticatedWriter(['brokerage_admin'])
  if (auth.error || !auth.profile?.brokerage_id) {
    return { success: false, error: auth.error ?? 'Not a brokerage admin.' }
  }

  const supabase = createServiceRoleClient()
  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .select('id, brokerage_id, status, agent_id, agent_self_submit_at')
    .eq('id', dealId)
    .maybeSingle()
  if (dealErr) return { success: false, error: dealErr.message }
  if (!deal) return { success: false, error: 'Offer not found.' }
  if (deal.brokerage_id !== auth.profile.brokerage_id) {
    return { success: false, error: 'This offer belongs to another brokerage.' }
  }
  if (deal.status !== 'offered') {
    return { success: false, error: `Can only decline offers in 'offered' status. This one is '${deal.status}'.` }
  }
  // Brokerage is paused on offers the agent took over to submit themselves.
  if (deal.agent_self_submit_at) {
    return { success: false, error: 'This agent has chosen to submit this advance themselves.' }
  }

  const nowIso = new Date().toISOString()
  const { error: updateErr } = await supabase
    .from('deals')
    .update({
      status: 'cancelled',
      brokerage_declined_at: nowIso,
      brokerage_declined_reason: trimmed,
    })
    .eq('id', dealId)

  if (updateErr) {
    return { success: false, error: `Failed to decline offer: ${updateErr.message}` }
  }

  // Notify the agent that their brokerage said no. Best-effort: a Resend
  // hiccup shouldn't roll back the decline. The agent still sees the
  // decision + reason on the offered-deal detail page.
  //
  // On 'errored' outcome we enqueue a retry in cron_email_failures
  // (migration 088) so the sweep cron picks it up — same pattern as the
  // brokerage notification path in acceptFirmDealOffer. 'skipped' means
  // the agent simply has no email on file (intentionally nullable in our
  // schema), so we don't enqueue — there's no recipient to retry to.
  let notificationQueuedForRetry = false
  try {
    const dispatch = await sendAgentDeclineNotification(supabase, dealId, trimmed)
    if (dispatch.outcome === 'errored') {
      console.warn('[declineFirmDealOffer] agent notification failed:', dispatch.error)
      const { error: retryErr } = await supabase.from('cron_email_failures').insert({
        cron_job: 'firm-deal-offer-decline',
        email_type: 'firm_deal_decline_notification',
        recipient: dispatch.recipients?.join(', ') ?? 'unknown',
        subject: 'Firm Deal Offer Declined (retry)',
        payload: {
          deal_id: dealId,
          agent_id: deal.agent_id,
          decline_reason: trimmed,
        },
        error: dispatch.error ?? 'unknown',
      })
      if (retryErr) {
        console.error(
          '[declineFirmDealOffer] failed to enqueue decline notification retry:',
          retryErr.message
        )
      } else {
        notificationQueuedForRetry = true
      }
    }
  } catch (err) {
    console.warn(
      '[declineFirmDealOffer] agent notification threw:',
      err instanceof Error ? err.message : err
    )
    try {
      await supabase.from('cron_email_failures').insert({
        cron_job: 'firm-deal-offer-decline',
        email_type: 'firm_deal_decline_notification',
        recipient: 'unknown',
        subject: 'Firm Deal Offer Declined (retry)',
        payload: {
          deal_id: dealId,
          agent_id: deal.agent_id,
          decline_reason: trimmed,
        },
        error: err instanceof Error ? err.message : 'unknown throw',
      })
      notificationQueuedForRetry = true
    } catch (enqueueErr) {
      console.error(
        '[declineFirmDealOffer] failed to enqueue decline retry after throw:',
        enqueueErr instanceof Error ? enqueueErr.message : enqueueErr
      )
    }
  }

  await logAuditEvent({
    action: 'deal.firm_deal_offer_declined',
    entityType: 'deal',
    entityId: dealId,
    metadata: {
      brokerage_id: auth.profile.brokerage_id,
      agent_id: deal.agent_id,
      reason: trimmed,
      declined_by_user_id: auth.user?.id,
      notification_queued_for_retry: notificationQueuedForRetry,
    },
  })

  return { success: true, data: { deal_id: dealId } }
}

// ============================================================================
// remindBrokerageOfPendingOffer
//
// Agent-triggered manual nudge from the offered-deal detail page. Fires the
// same email the 2h cron would send (sendBrokerageOfferNudge2h), letting an
// anxious agent ping their brokerage earlier than the automated cadence.
//
// Rate limit: at most one manual nudge per 6 hours per deal. Recorded in
// deals.last_manual_nudge_at (migration 096). This is per-deal rather than
// per-agent so an agent juggling several offered deals can nudge each
// brokerage once, but can't spam any one brokerage.
//
// Interaction with the automated 2h cron:
//   - The dispatcher always stamps brokerage_nudge_2h_at when this variant
//     sends. So firing manually before the 2h cron means the cron's
//     `!brokerage_nudge_2h_at` gate will be false and the cron skips that
//     row. That's by design: manual nudge supersedes automated 2h nudge.
//   - Firing manually after the 2h cron already sent is allowed (subject to
//     the 6h rate limit) and re-stamps brokerage_nudge_2h_at, which is
//     harmless — the cron's gate stays closed regardless.
//   - The 4h internal escalation tracks internal_alert_4h_at independently
//     and is not affected.
// ============================================================================

const MANUAL_NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000

export interface RemindBrokerageResult {
  deal_id: string
  /** Recipients the nudge was sent to. Surfaced so the agent UI can hint
   *  that the brokerage admin team really did get an email. */
  recipients: string[]
  /** When the rate-limit window expires, so the UI can render a "you can
   *  nudge again at HH:MM" hint instead of just "rate limited". */
  next_allowed_at: string
}

export async function remindBrokerageOfPendingOffer(
  dealId: string
): Promise<ActionResult<RemindBrokerageResult>> {
  if (!dealId || typeof dealId !== 'string') {
    return { success: false, error: 'Missing deal id.' }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dealId)) {
    return { success: false, error: 'Invalid deal id.' }
  }

  const auth = await getAuthenticatedWriter(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }
  const myAgentId = auth.profile.agent_id as string

  const supabase = createServiceRoleClient()

  // Load just enough of the deal to verify ownership, status, and rate-limit
  // window. The dispatcher re-loads the full context (brokerage, agent, pipe
  // brand) so we don't need to fetch those columns here.
  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .select('id, agent_id, brokerage_id, status, last_manual_nudge_at, agent_self_submit_at')
    .eq('id', dealId)
    .maybeSingle()
  if (dealErr) return { success: false, error: dealErr.message }
  if (!deal) return { success: false, error: 'Deal not found.' }

  if (deal.agent_id !== myAgentId) {
    return { success: false, error: 'This deal does not belong to you.' }
  }
  if (deal.status !== 'offered') {
    return {
      success: false,
      error: 'Reminders are only available while the offer is waiting for your brokerage to submit.',
    }
  }
  // Defense-in-depth: once the agent has taken the offer over to submit it
  // themselves, the brokerage is paused, so a reminder would be wrong. The
  // offered-view UI hides this button in that state, but guard it anyway.
  if (deal.agent_self_submit_at) {
    return {
      success: false,
      error: "You're submitting this advance yourself, so there's nothing for your brokerage to do.",
    }
  }

  const nowMs = Date.now()
  if (deal.last_manual_nudge_at) {
    const lastMs = new Date(deal.last_manual_nudge_at as string).getTime()
    if (!isNaN(lastMs) && nowMs - lastMs < MANUAL_NUDGE_COOLDOWN_MS) {
      const nextAllowedMs = lastMs + MANUAL_NUDGE_COOLDOWN_MS
      const minutesLeft = Math.ceil((nextAllowedMs - nowMs) / 60_000)
      const hoursLeft = Math.floor(minutesLeft / 60)
      const wait = hoursLeft >= 1
        ? `${hoursLeft}h ${minutesLeft - hoursLeft * 60}m`
        : `${minutesLeft}m`
      return {
        success: false,
        error: `You already sent a reminder recently. You can send another in ${wait}.`,
      }
    }
  }

  // Fire the same email the 2h cron would send. This also stamps
  // brokerage_nudge_2h_at via the dispatcher's update block.
  const dispatch = await sendBrokerageOfferNudge2h(supabase, dealId)
  if (dispatch.outcome === 'errored') {
    return {
      success: false,
      error: `We couldn't send the reminder right now: ${dispatch.error ?? 'unknown error'}. Try again in a moment.`,
    }
  }
  if (dispatch.outcome === 'skipped') {
    // No recipients on file — same gate the acceptance flow uses. Tell the
    // agent to contact support rather than leaving them clicking forever.
    return {
      success: false,
      error: 'Your brokerage is not set up to receive reminders. Please contact Firm Funds support at support@firmfunds.ca.',
    }
  }

  const nowIso = new Date(nowMs).toISOString()
  const { error: stampErr } = await supabase
    .from('deals')
    .update({ last_manual_nudge_at: nowIso })
    .eq('id', dealId)
  if (stampErr) {
    // The email already went out; failing to record the timestamp would just
    // let the agent re-fire immediately. Log loudly and surface a soft warning
    // so support can investigate, but don't roll back the send.
    console.warn(
      '[remindBrokerageOfPendingOffer] failed to stamp last_manual_nudge_at:',
      stampErr.message
    )
  }

  await logAuditEvent({
    action: 'deal.firm_deal_offer_manually_nudged',
    entityType: 'deal',
    entityId: dealId,
    metadata: {
      brokerage_id: deal.brokerage_id,
      agent_id: myAgentId,
      triggered_by_user_id: auth.user?.id ?? null,
      recipients: dispatch.recipients,
      provider_id: dispatch.provider_id ?? null,
      sent_at: nowIso,
    },
  })

  return {
    success: true,
    data: {
      deal_id: dealId,
      recipients: dispatch.recipients,
      next_allowed_at: new Date(nowMs + MANUAL_NUDGE_COOLDOWN_MS).toISOString(),
    },
  }
}
