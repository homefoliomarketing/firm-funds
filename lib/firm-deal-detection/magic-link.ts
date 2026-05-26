/**
 * lib/firm-deal-detection/magic-link.ts
 *
 * Mint and consume one-shot login tokens that ship inside firm-deal offer
 * emails and SMS. The agent clicks the link, the route handler at
 * /agent/firm-deal/[token] consumes it via consumeFirmDealMagicLink(),
 * then redirects the browser through a Supabase magic link so the agent
 * lands on the dashboard already authenticated.
 *
 * Why a custom token (not Supabase magic link directly in the SMS):
 *   - Supabase magic link URLs are long and ugly (bad in 1-segment SMS).
 *   - They expire fast (1 hour default). We want 7 days.
 *   - They do not carry the firm_deal_event_id so the dashboard could not
 *     know which offer to surface.
 *
 * Our token is the short stable identifier; the Supabase magic link is
 * minted on demand when the agent actually clicks.
 */
import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/** 7 days in milliseconds. Matches the handoff spec. */
export const FIRM_DEAL_MAGIC_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface MintResult {
  token: string
  expires_at: string
}

/**
 * Mint a new one-shot token tying an agent to a firm_deal_events row.
 * Uses cryptographically random URL-safe bytes (32 char hex).
 */
export async function mintFirmDealMagicLink(
  supabase: SupabaseClient,
  args: { firm_deal_event_id: string; agent_id: string }
): Promise<MintResult> {
  // 16 bytes = 32 hex chars. Same character class as Supabase's own
  // verifier tokens; URL-safe without encoding.
  const token = randomBytes(16).toString('hex')
  const expires_at = new Date(Date.now() + FIRM_DEAL_MAGIC_LINK_TTL_MS).toISOString()

  const { error } = await supabase.from('firm_deal_magic_links').insert({
    token,
    firm_deal_event_id: args.firm_deal_event_id,
    agent_id: args.agent_id,
    expires_at,
  })
  if (error) {
    throw new Error(`mintFirmDealMagicLink failed: ${error.message}`)
  }
  return { token, expires_at }
}

export interface ConsumeResult {
  ok: true
  firm_deal_event_id: string
  agent_id: string
}
export interface ConsumeFail {
  ok: false
  reason: 'not_found' | 'expired' | 'already_used'
}

/**
 * Validate and atomically mark a token as used. Uses a single UPDATE with
 * a WHERE used_at IS NULL AND expires_at > now() so two concurrent clicks
 * cannot both consume the same token. The verb is the CAS itself: only the
 * winner gets a row back.
 *
 * Returns the linked event_id + agent_id so the caller can mint the
 * Supabase magic link without a second round-trip.
 */
export async function consumeFirmDealMagicLink(
  supabase: SupabaseClient,
  token: string
): Promise<ConsumeResult | ConsumeFail> {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'not_found' }
  }

  // Peek first so we can give a precise failure reason. The peek itself is
  // not the source of truth; the CAS below is.
  const { data: peek } = await supabase
    .from('firm_deal_magic_links')
    .select('id, firm_deal_event_id, agent_id, expires_at, used_at')
    .eq('token', token)
    .maybeSingle()

  if (!peek) return { ok: false, reason: 'not_found' }
  if (peek.used_at) return { ok: false, reason: 'already_used' }
  if (new Date(peek.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  // Atomic CAS: only succeeds if used_at is still NULL. Same pattern as
  // /api/magic-link PUT (Finding 24).
  const { data: claimed } = await supabase
    .from('firm_deal_magic_links')
    .update({ used_at: new Date().toISOString() })
    .eq('id', peek.id)
    .is('used_at', null)
    .select('firm_deal_event_id, agent_id')
    .maybeSingle()

  if (!claimed) {
    return { ok: false, reason: 'already_used' }
  }
  return {
    ok: true,
    firm_deal_event_id: claimed.firm_deal_event_id,
    agent_id: claimed.agent_id,
  }
}
