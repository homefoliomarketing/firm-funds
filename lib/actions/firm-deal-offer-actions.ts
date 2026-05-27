'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import {
  sendBrokerageOfferNotification,
  sendAgentDeclineNotification,
} from '@/lib/firm-deal-detection/dispatch-brokerage-offer'
import { logAuditEvent } from '@/lib/audit'

type ActionResult<T = unknown> = { success: boolean; error?: string; data?: T }

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
  /** When the offer was sent (email or SMS). null if not yet sent. */
  sent_at: string | null
}

export async function getFirmDealOfferForCurrentAgent(
  eventId: string
): Promise<ActionResult<FirmDealOfferSummary | null>> {
  if (!eventId || typeof eventId !== 'string') {
    return { success: false, error: 'Missing event id.' }
  }
  // UUID v4 sanity check — keep ill-formed strings out of the DB query.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
    return { success: false, error: 'Invalid event id.' }
  }

  const auth = await getAuthenticatedUser(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }

  const supabase = createServiceRoleClient()
  const { data, error } = await supabase
    .from('firm_deal_events')
    .select(`
      id, brokerage_id, brokerage_pipe_id,
      parsed, status, matched_agent_id, second_matched_agent_id,
      offer_deal_id, second_offer_deal_id,
      email_sent_at, sms_sent_at
    `)
    .eq('id', eventId)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!data) return { success: true, data: null }

  const myAgentId = auth.profile.agent_id as string
  const isPrimary = data.matched_agent_id === myAgentId
  const isSecondary = data.second_matched_agent_id === myAgentId
  if (!isPrimary && !isSecondary) {
    // Quietly return null so a guessed id leaks nothing about other agents'
    // offers. The dashboard treats null the same as "no offer to surface".
    return { success: true, data: null }
  }

  // Look up the pipe brand for the banner copy ("Choice Advances" reads
  // better than "Firm Funds" when the email came from the white-label).
  const { data: pipe } = await supabase
    .from('brokerage_pipes')
    .select('brand_name')
    .eq('id', data.brokerage_pipe_id)
    .maybeSingle()

  const parsed = (data.parsed ?? {}) as {
    address?: string | null
    closing_date_iso?: string | null
    mls_number?: string | null
  }

  // Pick whichever side this agent is on so the offer_deal_id is the one
  // that belongs to them, not the co-agent on a dual-side deal.
  const offerDealId = isPrimary ? data.offer_deal_id : data.second_offer_deal_id

  const sentAt = data.email_sent_at ?? data.sms_sent_at ?? null

  return {
    success: true,
    data: {
      event_id: data.id,
      brokerage_id: data.brokerage_id,
      address: parsed.address ?? null,
      closing_date_iso: parsed.closing_date_iso ?? null,
      mls_number: parsed.mls_number ?? null,
      brand_name: pipe?.brand_name ?? null,
      offer_deal_id: (offerDealId as string | null) ?? null,
      sent_at: sentAt,
    },
  }
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

export interface AcceptFirmDealOfferResult {
  deal_id: string
  already_accepted: boolean
}

export async function acceptFirmDealOffer(
  eventId: string
): Promise<ActionResult<AcceptFirmDealOfferResult>> {
  if (!eventId || typeof eventId !== 'string') {
    return { success: false, error: 'Missing event id.' }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
    return { success: false, error: 'Invalid event id.' }
  }

  const auth = await getAuthenticatedUser(['agent'])
  if (auth.error || !auth.profile?.agent_id) {
    return { success: false, error: auth.error ?? 'Not an agent.' }
  }
  const myAgentId = auth.profile.agent_id as string

  const supabase = createServiceRoleClient()

  // Load the event with its parsed payload + matched-agent fields. We re-check
  // ownership server-side so a hostile caller can't accept someone else's
  // offer just by knowing the event id.
  const { data: event, error: eventErr } = await supabase
    .from('firm_deal_events')
    .select(`
      id, brokerage_id, parsed, matched_agent_id, second_matched_agent_id,
      offer_deal_id, second_offer_deal_id
    `)
    .eq('id', eventId)
    .maybeSingle()
  if (eventErr) return { success: false, error: eventErr.message }
  if (!event) return { success: false, error: 'Offer not found.' }

  const isPrimary = event.matched_agent_id === myAgentId
  const isSecondary = event.second_matched_agent_id === myAgentId
  if (!isPrimary && !isSecondary) {
    return { success: false, error: 'This offer is not yours to accept.' }
  }

  // Idempotency: if this side already has a deal linked, surface it instead
  // of creating a duplicate. The banner uses this same field to render the
  // "We've already started a request" state.
  const existingDealId = isPrimary ? event.offer_deal_id : event.second_offer_deal_id
  if (existingDealId) {
    return {
      success: true,
      data: { deal_id: existingDealId as string, already_accepted: true },
    }
  }

  const parsed = (event.parsed ?? {}) as {
    address?: string | null
    closing_date_iso?: string | null
    mls_number?: string | null
  }
  const propertyAddress = (parsed.address ?? '').trim() || 'Address pending'
  const closingDate = parsed.closing_date_iso ?? null

  if (!closingDate) {
    // Without a closing date we can't compute days_until_closing or hold a
    // valid `closing_date` NOT NULL row. This shouldn't happen because the
    // dispatcher refuses to send offers for events without parsed closing
    // dates, but we surface a clear error instead of inserting garbage.
    return {
      success: false,
      error: 'This offer is missing a closing date. Please contact Firm Funds support.',
    }
  }

  // Days until closing — used downstream for stat displays; for offered rows
  // the real days will be recomputed when the brokerage submits.
  const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) + 'T00:00:00Z').getTime()
  const closingMs = new Date(closingDate + 'T00:00:00Z').getTime()
  const daysUntilClosing = Math.max(0, Math.ceil((closingMs - today) / (1000 * 60 * 60 * 24)))

  const nowIso = new Date().toISOString()

  const { data: inserted, error: insertErr } = await supabase
    .from('deals')
    .insert({
      agent_id: myAgentId,
      brokerage_id: event.brokerage_id,
      status: 'offered',
      property_address: propertyAddress,
      closing_date: closingDate,
      // Financial placeholders. UI hides these on 'offered' rows; the
      // brokerage submission flow overwrites them with the real numbers.
      gross_commission: 0,
      brokerage_split_pct: 0,
      net_commission: 0,
      days_until_closing: daysUntilClosing,
      discount_fee: 0,
      advance_amount: 0,
      brokerage_referral_fee: 0,
      amount_due_from_brokerage: 0,
      source: 'firm_deal_offer',
      payment_status: 'not_applicable',
      // New tracking columns from migration 081.
      offered_at: nowIso,
      offered_event_id: event.id,
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    return {
      success: false,
      error: `Failed to record offer acceptance: ${insertErr?.message ?? 'unknown'}`,
    }
  }

  // Back-link the event so the banner stops prompting and the cron can find
  // the row. Pick the right side (primary vs second) so dual-side offers
  // don't clobber each other.
  const linkUpdate: Record<string, string> = {}
  if (isPrimary) linkUpdate.offer_deal_id = inserted.id
  else linkUpdate.second_offer_deal_id = inserted.id
  const { error: linkErr } = await supabase
    .from('firm_deal_events')
    .update(linkUpdate)
    .eq('id', event.id)
  if (linkErr) {
    // Not fatal for the user-facing flow; the deal exists and we'll log it.
    // The cron uses the deal row's offered_event_id back-link anyway.
    console.warn('[acceptFirmDealOffer] event link update failed:', linkErr.message)
  }

  // Fire the brokerage notification. Best-effort: a Resend hiccup shouldn't
  // strand the acceptance, the 2h nudge cron will retry the channel.
  try {
    const dispatch = await sendBrokerageOfferNotification(supabase, inserted.id)
    if (dispatch.outcome !== 'sent') {
      console.warn('[acceptFirmDealOffer] brokerage notification not sent:', dispatch.error ?? dispatch.outcome)
    }
  } catch (err) {
    console.warn(
      '[acceptFirmDealOffer] brokerage notification threw:',
      err instanceof Error ? err.message : err
    )
  }

  await logAuditEvent({
    action: 'deal.firm_deal_offer_accepted',
    entityType: 'deal',
    entityId: inserted.id,
    metadata: {
      firm_deal_event_id: event.id,
      brokerage_id: event.brokerage_id,
      agent_id: myAgentId,
      property_address: propertyAddress,
      closing_date: closingDate,
      side: isPrimary ? 'primary' : 'secondary',
    },
  })

  return {
    success: true,
    data: { deal_id: inserted.id, already_accepted: false },
  }
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

  const auth = await getAuthenticatedUser(['brokerage_admin'])
  if (auth.error || !auth.profile?.brokerage_id) {
    return { success: false, error: auth.error ?? 'Not a brokerage admin.' }
  }

  const supabase = createServiceRoleClient()
  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .select('id, brokerage_id, status, agent_id')
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
  try {
    const dispatch = await sendAgentDeclineNotification(supabase, dealId, trimmed)
    if (dispatch.outcome === 'errored') {
      console.warn('[declineFirmDealOffer] agent notification failed:', dispatch.error)
    }
  } catch (err) {
    console.warn(
      '[declineFirmDealOffer] agent notification threw:',
      err instanceof Error ? err.message : err
    )
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
    },
  })

  return { success: true, data: { deal_id: dealId } }
}
