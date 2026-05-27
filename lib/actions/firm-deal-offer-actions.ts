'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'

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
