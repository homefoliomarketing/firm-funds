'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import {
  sendBrokerageOfferNotification,
  sendAgentDeclineNotification,
  loadBrokerageOfferRecipients,
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
  /**
   * Set to true when the brokerage notification didn't go out cleanly and was
   * enqueued in cron_email_failures for the retry sweeper. The UI surfaces a
   * "we'll keep trying" line so the agent isn't left wondering whether their
   * brokerage was told.
   */
  notification_queued_for_retry?: boolean
}

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
  // offer just by knowing the event id. brokerage_pipe_id is loaded so the
  // recipient gate-check below can read the pipe's notification_recipients
  // config without a second round-trip.
  const { data: event, error: eventErr } = await supabase
    .from('firm_deal_events')
    .select(`
      id, brokerage_id, brokerage_pipe_id, parsed, matched_agent_id, second_matched_agent_id,
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

  // Fast-path idempotency: if this side already has a deal linked, surface it
  // instead of creating a duplicate. The banner uses this same field to render
  // the "We've already started a request" state. This is a hot read — the
  // real race protection lives in the unique-constraint catch below (the back
  // -link write isn't transactionally tied to the deal insert, so two near-
  // simultaneous clicks can both find offer_deal_id null on this read).
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

  // ------------------------------------------------------------------------
  // Closing-date validation (Task 7)
  // ------------------------------------------------------------------------
  // We need a real, parseable, future-or-today ISO date. The dispatcher
  // already refuses to send offers without one, but a hostile or stale
  // payload could still reach here, and we'd rather reject cleanly than
  // create a malformed `deals` row.
  const closingDate = parsed.closing_date_iso ?? null
  if (!closingDate) {
    return {
      success: false,
      error: 'This offer is missing a closing date. Please contact Firm Funds support.',
    }
  }
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!isoDateRegex.test(closingDate)) {
    return {
      success: false,
      error: 'Invalid closing date format on this offer. Please contact Firm Funds support.',
    }
  }
  // Construct with noon UTC so timezone math never tips us into the previous
  // day in eastern time. Used for sanity-checking the date is real (not
  // 2026-02-30 etc.); the actual closing_date column is stored as ISO date
  // and rendered in local time downstream.
  const parsedClosingDate = new Date(closingDate + 'T12:00:00Z')
  if (isNaN(parsedClosingDate.getTime())) {
    return {
      success: false,
      error: 'Invalid closing date on this offer. Please contact Firm Funds support.',
    }
  }
  // Reject offers whose closing has already happened in Toronto local time.
  // String comparison is safe because both sides are YYYY-MM-DD ISO format.
  const todayInToronto = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  if (closingDate < todayInToronto) {
    return {
      success: false,
      error: 'This offer has a closing date in the past and can no longer be accepted.',
    }
  }

  // ------------------------------------------------------------------------
  // Brokerage recipient gate (Task 2)
  // ------------------------------------------------------------------------
  // If the brokerage has no email on file AND the pipe has no notification
  // recipients configured AND FIRM_FUNDS_OFFER_INBOX is not set, creating
  // this offered deal would lead to a silent black hole — the brokerage
  // never gets told. Refuse acceptance with a clear human message so the
  // agent can call support and we surface the configuration gap.
  //
  // Uses the SAME helper the dispatcher uses, so the gate and the actual
  // send agree byte-for-byte on recipient resolution. FIRM_FUNDS_OFFER_INBOX
  // (default bud@firmfunds.ca) is always added when set, so this gate only
  // really fires in test/dev or in pathological prod misconfigurations.
  const recipientsCheck = await loadBrokerageOfferRecipients(
    supabase,
    event.brokerage_id,
    event.brokerage_pipe_id as string | null
  )
  if (!recipientsCheck.brokerage_loaded) {
    return {
      success: false,
      error: 'Brokerage record missing for this offer. Please contact Firm Funds support at support@firmfunds.ca.',
    }
  }
  if (recipientsCheck.recipients.length === 0) {
    return {
      success: false,
      error:
        'Your brokerage is not set up to receive advance offers. Please contact Firm Funds support at support@firmfunds.ca to configure notification recipients.',
    }
  }

  // Days until closing — used downstream for stat displays; for offered rows
  // the real days will be recomputed when the brokerage submits.
  const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) + 'T00:00:00Z').getTime()
  const closingMs = new Date(closingDate + 'T00:00:00Z').getTime()
  const daysUntilClosing = Math.max(0, Math.ceil((closingMs - today) / (1000 * 60 * 60 * 24)))

  const nowIso = new Date().toISOString()

  // ------------------------------------------------------------------------
  // Race-safe insert (Task 1)
  // ------------------------------------------------------------------------
  // Migration 089 added a partial unique index on
  // (offered_event_id, agent_id) WHERE status='offered' so two simultaneous
  // clicks from the same agent on the same offer can't both create a deal.
  // The fast-path check above handles the common case; this catches the
  // narrow race window where both calls saw offer_deal_id=null.
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

  if (insertErr) {
    // Postgres unique_violation. The constraint name comes from migration 089;
    // we match on both code and constraint name so an unrelated 23505 (e.g.
    // some other future unique index) doesn't silently fall into the lookup
    // branch and return a misleading "already accepted" result.
    const isUniqueViolation =
      insertErr.code === '23505' &&
      (insertErr.message?.includes('deals_unique_offered_per_event_and_agent') ||
        // PostgREST sometimes surfaces the message in details instead.
        (insertErr.details ?? '').includes('deals_unique_offered_per_event_and_agent'))
    if (isUniqueViolation) {
      const { data: existing } = await supabase
        .from('deals')
        .select('id')
        .eq('offered_event_id', event.id)
        .eq('agent_id', myAgentId)
        .eq('status', 'offered')
        .maybeSingle()
      if (existing) {
        return {
          success: true,
          data: { deal_id: existing.id as string, already_accepted: true },
        }
      }
      // Index says a row exists, but we can't find it — most likely a
      // concurrent transaction hasn't committed yet. Surface a soft error
      // and let the agent retry; the second attempt will see the committed
      // row via the fast-path.
      return {
        success: false,
        error: 'Acceptance is being processed. Please refresh in a moment.',
      }
    }
    return {
      success: false,
      error: `Failed to record offer acceptance: ${insertErr.message ?? 'unknown'}`,
    }
  }

  if (!inserted) {
    return {
      success: false,
      error: 'Failed to record offer acceptance: insert returned no row.',
    }
  }
  // From this point on the deal exists with id of type `string`. Pin it to a
  // const so downstream code (back-link write, dispatcher call, audit log)
  // gets a non-nullable type without per-call assertions.
  const insertedDealId: string = inserted.id as string

  // Back-link the event so the banner stops prompting and the cron can find
  // the row. Pick the right side (primary vs second) so dual-side offers
  // don't clobber each other.
  const linkUpdate: Record<string, string> = {}
  if (isPrimary) linkUpdate.offer_deal_id = insertedDealId
  else linkUpdate.second_offer_deal_id = insertedDealId
  const { error: linkErr } = await supabase
    .from('firm_deal_events')
    .update(linkUpdate)
    .eq('id', event.id)
  if (linkErr) {
    // Not fatal for the user-facing flow; the deal exists and we'll log it.
    // The cron uses the deal row's offered_event_id back-link anyway.
    console.warn('[acceptFirmDealOffer] event link update failed:', linkErr.message)
  }

  // ------------------------------------------------------------------------
  // Brokerage notification + retry enqueue (Task 3)
  // ------------------------------------------------------------------------
  // sendBrokerageOfferNotification returns one of:
  //   - sent     : email accepted by Resend, timestamps written
  //   - skipped  : truly no recipients (Task 2's gate above should have
  //                prevented this; a 'skipped' result here means recipient
  //                config changed between gate and send, treat as no-op)
  //   - errored  : recipients exist but Resend rejected, threw, or env var
  //                missing in prod — enqueue retry in cron_email_failures
  //                (table from migration 088) and tell the user we'll keep
  //                trying. We never roll back the offered deal: it's real,
  //                we just need the brokerage notified soon.
  let notificationQueuedForRetry = false
  try {
    const dispatch = await sendBrokerageOfferNotification(supabase, insertedDealId)
    if (dispatch.outcome === 'errored') {
      console.warn(
        '[acceptFirmDealOffer] brokerage notification errored, enqueuing retry:',
        dispatch.error
      )
      const { error: retryErr } = await supabase.from('cron_email_failures').insert({
        cron_job: 'firm-deal-offer-acceptance',
        email_type: 'firm_deal_offer_notification',
        recipient: dispatch.recipients?.join(', ') ?? 'unknown',
        subject: 'Firm Deal Offer (retry)',
        payload: {
          deal_id: insertedDealId,
          event_id: event.id,
          agent_id: myAgentId,
        },
        error: dispatch.error ?? 'unknown',
      })
      if (retryErr) {
        // Failed to enqueue the retry — we lose the automated recovery path,
        // but the offered deal still exists and the nudge crons (2h/4h/60d)
        // will eventually surface it. Log loudly.
        console.error(
          '[acceptFirmDealOffer] failed to enqueue notification retry:',
          retryErr.message
        )
      } else {
        notificationQueuedForRetry = true
      }
    } else if (dispatch.outcome !== 'sent') {
      console.warn(
        '[acceptFirmDealOffer] brokerage notification not sent:',
        dispatch.error ?? dispatch.outcome
      )
    }
  } catch (err) {
    console.warn(
      '[acceptFirmDealOffer] brokerage notification threw:',
      err instanceof Error ? err.message : err
    )
    // Also enqueue when the dispatcher throws — same recovery path.
    try {
      await supabase.from('cron_email_failures').insert({
        cron_job: 'firm-deal-offer-acceptance',
        email_type: 'firm_deal_offer_notification',
        recipient: 'unknown',
        subject: 'Firm Deal Offer (retry)',
        payload: {
          deal_id: insertedDealId,
          event_id: event.id,
          agent_id: myAgentId,
        },
        error: err instanceof Error ? err.message : 'unknown throw',
      })
      notificationQueuedForRetry = true
    } catch (enqueueErr) {
      console.error(
        '[acceptFirmDealOffer] failed to enqueue notification retry after throw:',
        enqueueErr instanceof Error ? enqueueErr.message : enqueueErr
      )
    }
  }

  await logAuditEvent({
    action: 'deal.firm_deal_offer_accepted',
    entityType: 'deal',
    entityId: insertedDealId,
    metadata: {
      firm_deal_event_id: event.id,
      brokerage_id: event.brokerage_id,
      agent_id: myAgentId,
      property_address: propertyAddress,
      closing_date: closingDate,
      side: isPrimary ? 'primary' : 'secondary',
      notification_queued_for_retry: notificationQueuedForRetry,
    },
  })

  return {
    success: true,
    data: {
      deal_id: insertedDealId,
      already_accepted: false,
      notification_queued_for_retry: notificationQueuedForRetry,
    },
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
