/**
 * lib/firm-deal-detection/offer-acceptance.ts
 *
 * Shared, server-only core for turning a firm-deal OFFER into an 'offered'
 * deal row and notifying the brokerage. This is NOT a 'use server' file: the
 * functions here take an explicit service-role Supabase client and an explicit
 * agent id, so they can run from three contexts without a user session:
 *
 *   1. The agent clicking "Notify my brokerage" on the dashboard
 *      (lib/actions/firm-deal-offer-actions.ts -> acceptFirmDealOffer wraps this).
 *   2. The agent pre-requesting during onboarding, then Firm Funds approving
 *      their account: the approval action calls fireQueuedFirmDealOffersForAgent,
 *      which calls performFirmDealOfferAcceptance on the agent's behalf.
 *   3. (Future) any internal/cron path that needs to accept on behalf of an agent.
 *
 * Keeping the body here (rather than in the 'use server' action file) means
 * none of this is exposed as a client-callable RPC endpoint — only the thin
 * authenticated wrappers in firm-deal-offer-actions.ts are.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  sendBrokerageOfferNotification,
  loadBrokerageOfferRecipients,
} from '@/lib/firm-deal-detection/dispatch-brokerage-offer'
import { logAuditEventServiceRole } from '@/lib/audit'

export interface AcceptFirmDealOfferResult {
  deal_id: string
  already_accepted: boolean
  /**
   * True when the brokerage notification didn't go out cleanly and was
   * enqueued in cron_email_failures for the retry sweeper. The UI surfaces a
   * "we'll keep trying" line so the agent isn't left wondering whether their
   * brokerage was told.
   */
  notification_queued_for_retry?: boolean
}

export interface PerformAcceptanceResult {
  success: boolean
  error?: string
  data?: AcceptFirmDealOfferResult
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Core of acceptFirmDealOffer, parameterized by agentId so it can run on behalf
 * of an agent who pre-requested (no session). Creates the 'offered' deal, links
 * the event back, notifies the brokerage (best-effort + retry enqueue), audits.
 *
 * Idempotent: if this agent's side of the event already has a linked deal, the
 * existing deal id is returned rather than double-creating.
 *
 * `actor` describes who triggered this for the audit trail:
 *   - { kind: 'agent', userId } when the agent themselves clicked.
 *   - { kind: 'system' }        when fired by the activation hook.
 */
export async function performFirmDealOfferAcceptance(
  supabase: SupabaseClient,
  params: {
    eventId: string
    agentId: string
    actor?: { kind: 'agent'; userId: string | null } | { kind: 'system' }
  }
): Promise<PerformAcceptanceResult> {
  const { eventId, agentId } = params
  const actor = params.actor ?? { kind: 'system' as const }

  if (!eventId || !UUID_RE.test(eventId)) {
    return { success: false, error: 'Invalid event id.' }
  }
  if (!agentId || !UUID_RE.test(agentId)) {
    return { success: false, error: 'Invalid agent id.' }
  }

  // Load the event with its parsed payload + matched-agent fields.
  // brokerage_pipe_id is loaded so the recipient gate-check below can read the
  // pipe's notification_recipients config without a second round-trip.
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

  const isPrimary = event.matched_agent_id === agentId
  const isSecondary = event.second_matched_agent_id === agentId
  if (!isPrimary && !isSecondary) {
    return { success: false, error: 'This offer is not yours to accept.' }
  }

  // Fast-path idempotency: if this side already has a deal linked, surface it
  // instead of creating a duplicate.
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

  // Closing-date validation — need a real, parseable, future-or-today ISO date.
  const closingDate = parsed.closing_date_iso ?? null
  if (!closingDate) {
    return {
      success: false,
      error: 'This offer is missing a closing date. Please contact Firm Funds support.',
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closingDate)) {
    return {
      success: false,
      error: 'Invalid closing date format on this offer. Please contact Firm Funds support.',
    }
  }
  const parsedClosingDate = new Date(closingDate + 'T12:00:00Z')
  if (isNaN(parsedClosingDate.getTime())) {
    return {
      success: false,
      error: 'Invalid closing date on this offer. Please contact Firm Funds support.',
    }
  }
  const todayInToronto = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  if (closingDate < todayInToronto) {
    return {
      success: false,
      error: 'This offer has a closing date in the past and can no longer be accepted.',
    }
  }

  // Brokerage recipient gate — refuse to create an offered deal that would
  // silently black-hole (no one to notify). Uses the SAME helper the
  // dispatcher uses so the gate and the send agree on recipient resolution.
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

  const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) + 'T00:00:00Z').getTime()
  const closingMs = new Date(closingDate + 'T00:00:00Z').getTime()
  const daysUntilClosing = Math.max(0, Math.ceil((closingMs - today) / (1000 * 60 * 60 * 24)))

  const nowIso = new Date().toISOString()

  // Race-safe insert (migration 089 partial unique index on
  // (offered_event_id, agent_id) WHERE status='offered').
  const { data: inserted, error: insertErr } = await supabase
    .from('deals')
    .insert({
      agent_id: agentId,
      brokerage_id: event.brokerage_id,
      status: 'offered',
      property_address: propertyAddress,
      closing_date: closingDate,
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
      offered_at: nowIso,
      offered_event_id: event.id,
    })
    .select('id')
    .single()

  if (insertErr) {
    const isUniqueViolation =
      insertErr.code === '23505' &&
      (insertErr.message?.includes('deals_unique_offered_per_event_and_agent') ||
        (insertErr.details ?? '').includes('deals_unique_offered_per_event_and_agent'))
    if (isUniqueViolation) {
      const { data: existing } = await supabase
        .from('deals')
        .select('id')
        .eq('offered_event_id', event.id)
        .eq('agent_id', agentId)
        .eq('status', 'offered')
        .maybeSingle()
      if (existing) {
        return {
          success: true,
          data: { deal_id: existing.id as string, already_accepted: true },
        }
      }
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
  const insertedDealId: string = inserted.id as string

  // Back-link the event (pick the right side for dual-side offers).
  const linkUpdate: Record<string, string> = {}
  if (isPrimary) linkUpdate.offer_deal_id = insertedDealId
  else linkUpdate.second_offer_deal_id = insertedDealId
  const { error: linkErr } = await supabase
    .from('firm_deal_events')
    .update(linkUpdate)
    .eq('id', event.id)
  if (linkErr) {
    console.warn('[performFirmDealOfferAcceptance] event link update failed:', linkErr.message)
  }

  // Brokerage notification + retry enqueue.
  let notificationQueuedForRetry = false
  try {
    const dispatch = await sendBrokerageOfferNotification(supabase, insertedDealId)
    if (dispatch.outcome === 'errored') {
      console.warn(
        '[performFirmDealOfferAcceptance] brokerage notification errored, enqueuing retry:',
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
          agent_id: agentId,
        },
        error: dispatch.error ?? 'unknown',
      })
      if (retryErr) {
        console.error(
          '[performFirmDealOfferAcceptance] failed to enqueue notification retry:',
          retryErr.message
        )
      } else {
        notificationQueuedForRetry = true
      }
    } else if (dispatch.outcome !== 'sent') {
      console.warn(
        '[performFirmDealOfferAcceptance] brokerage notification not sent:',
        dispatch.error ?? dispatch.outcome
      )
    }
  } catch (err) {
    console.warn(
      '[performFirmDealOfferAcceptance] brokerage notification threw:',
      err instanceof Error ? err.message : err
    )
    try {
      await supabase.from('cron_email_failures').insert({
        cron_job: 'firm-deal-offer-acceptance',
        email_type: 'firm_deal_offer_notification',
        recipient: 'unknown',
        subject: 'Firm Deal Offer (retry)',
        payload: {
          deal_id: insertedDealId,
          event_id: event.id,
          agent_id: agentId,
        },
        error: err instanceof Error ? err.message : 'unknown throw',
      })
      notificationQueuedForRetry = true
    } catch (enqueueErr) {
      console.error(
        '[performFirmDealOfferAcceptance] failed to enqueue notification retry after throw:',
        enqueueErr instanceof Error ? enqueueErr.message : enqueueErr
      )
    }
  }

  await logAuditEventServiceRole({
    action: 'deal.firm_deal_offer_accepted',
    entityType: 'deal',
    entityId: insertedDealId,
    userId: actor.kind === 'agent' ? actor.userId ?? undefined : undefined,
    actorRole: actor.kind === 'agent' ? 'agent' : 'system',
    metadata: {
      firm_deal_event_id: event.id,
      brokerage_id: event.brokerage_id,
      agent_id: agentId,
      property_address: propertyAddress,
      closing_date: closingDate,
      side: isPrimary ? 'primary' : 'secondary',
      accepted_via: actor.kind === 'agent' ? 'agent_click' : 'pre_request_on_activation',
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

/**
 * Activation hook. Called from every action that can flip an agent to activated
 * (KYC verify + banking approve). If the agent is now activated AND has any
 * pre-requested-but-not-yet-accepted firm-deal offers, fire the acceptance for
 * each — creating the offered deal and notifying the brokerage on their behalf.
 *
 * Safe to call after any single gate approval: it no-ops when the account isn't
 * activated yet (account_activated_at still NULL), and performFirmDealOfferAcceptance
 * is idempotent, so calling it from both the KYC and banking paths can't
 * double-create. Best-effort — never throws into the approval flow.
 */
export async function fireQueuedFirmDealOffersForAgent(
  supabase: SupabaseClient,
  agentId: string
): Promise<void> {
  try {
    if (!agentId || !UUID_RE.test(agentId)) return

    // Only fire once the account is fully activated. account_activated_at is
    // set by the DB trigger (migration 043) when BOTH gates pass.
    const { data: agent } = await supabase
      .from('agents')
      .select('id, account_activated_at')
      .eq('id', agentId)
      .maybeSingle()
    if (!agent?.account_activated_at) return

    // Find this agent's pre-requested offers that haven't been turned into a
    // deal yet, on either side of the (rare) dual-agency pairing.
    const { data: primaryEvents } = await supabase
      .from('firm_deal_events')
      .select('id')
      .eq('matched_agent_id', agentId)
      .not('agent_pre_request_at', 'is', null)
      .is('offer_deal_id', null)

    const { data: secondEvents } = await supabase
      .from('firm_deal_events')
      .select('id')
      .eq('second_matched_agent_id', agentId)
      .not('second_agent_pre_request_at', 'is', null)
      .is('second_offer_deal_id', null)

    const eventIds = Array.from(
      new Set([
        ...((primaryEvents ?? []).map((e) => e.id as string)),
        ...((secondEvents ?? []).map((e) => e.id as string)),
      ])
    )
    if (eventIds.length === 0) return

    for (const eventId of eventIds) {
      try {
        const res = await performFirmDealOfferAcceptance(supabase, {
          eventId,
          agentId,
          actor: { kind: 'system' },
        })
        if (!res.success) {
          console.warn(
            `[fireQueuedFirmDealOffersForAgent] event ${eventId} for agent ${agentId} not fired:`,
            res.error
          )
        }
      } catch (err) {
        console.warn(
          `[fireQueuedFirmDealOffersForAgent] event ${eventId} threw:`,
          err instanceof Error ? err.message : err
        )
      }
    }
  } catch (err) {
    // Never let a queued-offer failure break account approval.
    console.warn(
      '[fireQueuedFirmDealOffersForAgent] unexpected error:',
      err instanceof Error ? err.message : err
    )
  }
}
