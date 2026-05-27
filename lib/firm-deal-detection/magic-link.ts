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
  reason: 'not_found' | 'expired'
}

/**
 * Validate a token and (idempotently) stamp first-use time. The token is
 * intentionally *not* single-use: Android Messages, Chrome's link prefetch,
 * Gmail Safe Links and similar agents fetch the URL automatically before the
 * recipient ever taps it. A strict CAS that burns the token on the first GET
 * means the real user always lands on an "already used" error. We accept the
 * multi-use trade-off because:
 *
 *   - The token is 128 bits of random + URL-scoped (`/agent/firm-deal/<t>`),
 *     unguessable.
 *   - It is bound to exactly one agent_id and one firm_deal_event_id.
 *   - It expires in 7 days.
 *   - It is delivered over the agent's own email + SMS, both verified during
 *     onboarding. Anyone capable of replaying the link already has the
 *     authenticated channel they were sent through.
 *
 * `used_at` is still set on first successful consume so we keep an audit
 * trail of when the link was first hit, but subsequent calls within the
 * TTL succeed without rewriting it.
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

  const { data: row } = await supabase
    .from('firm_deal_magic_links')
    .select('id, firm_deal_event_id, agent_id, expires_at, used_at')
    .eq('token', token)
    .maybeSingle()

  if (!row) return { ok: false, reason: 'not_found' }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  // Stamp the first-use timestamp once. We don't gate validity on this; it's
  // only a forensic marker so we can see in the DB when a link was first hit
  // by *something* (scanner or human).
  if (!row.used_at) {
    await supabase
      .from('firm_deal_magic_links')
      .update({ used_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('used_at', null)
  }

  return {
    ok: true,
    firm_deal_event_id: row.firm_deal_event_id,
    agent_id: row.agent_id,
  }
}
