/**
 * lib/firm-deal-detection/dispatch-notification.ts
 *
 * Send the email + SMS pair for one firm_deal_events row, then transition
 * status -> 'offer_sent' (or 'errored' if both channels failed).
 *
 * Idempotent. Only acts on rows where status='approved'. Already-sent rows
 * (where email_sent_at or sms_sent_at is set) get skipped with outcome
 * 'already_sent'.
 *
 * Channel policy:
 *   - Email is the primary channel. If the agent has no email, we still
 *     try SMS but flag the result.
 *   - SMS is the supporting channel. If the agent has no phone, we still
 *     send the email but flag the result.
 *   - Both channels failing escalates the event to status='errored' so the
 *     admin can investigate.
 *   - Either-or success counts as 'offer_sent'.
 *
 * Voice + visual rules live in the renderers; this module orchestrates
 * data loading + sending + status writing only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { renderTriggerEmail } from './render-email'
import { renderTriggerSms } from './render-sms'
import { sendSms } from './twilio-client'
import { mintFirmDealMagicLink } from './magic-link'
import { isValidFirmDealEventTransition } from './process-event'
import { logAuditEventServiceRole } from '@/lib/audit'
import type { ParsedFirmDeal } from './parse-event'
import {
  pickAgentVariant,
  estimateAdvanceFromGross,
  formatClosingDateHuman,
  type NotifyTier,
} from './offer-estimate'

// Re-export so existing callers (render-email, dispatch-brokerage-offer) keep
// importing these from here. Single source of truth lives in ./offer-estimate
// so the link-preview card can reuse the same math without pulling in Resend.
export { pickAgentVariant, estimateAdvanceFromGross }
export type { NotifyTier }

export interface DispatchResult {
  event_id: string
  outcome: 'offer_sent' | 'already_sent' | 'skipped' | 'errored'
  /** Top-level email outcome reflects the primary agent's send. Per-agent
   *  detail is in agent_results when the event fans out to multiple agents. */
  email: { status: string; provider_id?: string; error?: string }
  sms: { status: string; provider_id?: string; error?: string }
  /** Per-agent outcomes when the event reached multiple agents (co-agent
   *  split or dual-agency with distinct agents). The primary appears first. */
  agent_results?: Array<{
    agent_id: string
    email: { status: string; provider_id?: string; error?: string }
    sms: { status: string; provider_id?: string; error?: string }
  }>
  message?: string
}

interface AgentRecord {
  id: string
  first_name: string | null
  email: string | null
  phone: string | null
}

interface DispatchContext {
  event: {
    id: string
    brokerage_id: string
    brokerage_pipe_id: string
    parsed: ParsedFirmDeal | null
    matched_agent_id: string | null
    second_matched_agent_id: string | null
    listing_matched_agent_id: string | null
    selling_matched_agent_id: string | null
    co_agent_split: boolean
    status: string
    email_sent_at: string | null
    sms_sent_at: string | null
  }
  pipe: {
    brand_name: string
    brand_tagline: string
  }
  /** Brokerage white-label logo for the email header. Sourced from
   *  brokerages.logo_url / logo_includes_tagline (same column lib/email.ts
   *  renders). Null when the brokerage has no logo on file, in which case the
   *  email falls back to its green text banner. */
  branding: {
    logo_url: string | null
    logo_includes_tagline: boolean | null
  }
  /** Per-brokerage firm-deal channel toggles (migration 114). When a channel
   *  is disabled the matching send is skipped with status 'skipped_disabled'.
   *  Defaults to enabled when the brokerage row is missing so a lookup miss
   *  can never silently swallow an offer. */
  channels: {
    email_enabled: boolean
    sms_enabled: boolean
  }
  /** Recipients to fan out to. Always at least one (the primary). For
   *  co-agent splits and dual-agency-with-distinct-agents, two entries. */
  recipients: AgentRecord[]
}

// Advance estimator + date helpers moved to ./offer-estimate (imported above)
// so the firm-deal link-preview card quotes the same number as the SMS/email.

const APP_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca'
const FROM_ADDRESS = process.env.FIRM_DEAL_FROM_ADDRESS || 'Firm Funds <notifications@firmfunds.ca>'

let _resend: Resend | null = null

function getResend(): Resend | null {
  if (_resend) return _resend
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[dispatch] RESEND_API_KEY missing in production')
      return null
    }
    return null
  }
  _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

export async function dispatchFirmDealNotification(
  eventId: string,
  supabase: SupabaseClient,
  // When { resend: true }, the approved-status and already-sent guards are
  // skipped so an admin can re-fire the email + SMS for an offer that already
  // went out. A re-send never mutates the event's status or sent-at timestamps
  // (see dispatchWithContext), so a failed re-send can't downgrade an
  // offer_sent event back to errored.
  options: { resend?: boolean } = {}
): Promise<DispatchResult> {
  // Load full event with side-aware match fields and the co_agent_split flag
  // (added migration 097) so the variant picker can force generic for splits.
  const { data: event, error: eventErr } = await supabase
    .from('firm_deal_events')
    .select(`
      id, brokerage_id, brokerage_pipe_id, parsed,
      matched_agent_id, second_matched_agent_id,
      listing_matched_agent_id, selling_matched_agent_id,
      co_agent_split, status, email_sent_at, sms_sent_at
    `)
    .eq('id', eventId)
    .single()

  if (eventErr || !event) {
    return errorResult(eventId, `Event not found: ${eventErr?.message ?? 'missing'}`)
  }

  if (!options.resend && event.status !== 'approved') {
    return {
      event_id: eventId,
      outcome: 'skipped',
      email: { status: 'skipped' },
      sms: { status: 'skipped' },
      message: `Status is ${event.status}, dispatch only acts on 'approved'.`,
    }
  }

  if (!options.resend && (event.email_sent_at || event.sms_sent_at)) {
    return {
      event_id: eventId,
      outcome: 'already_sent',
      email: { status: event.email_sent_at ? 'already_sent' : 'skipped' },
      sms: { status: event.sms_sent_at ? 'already_sent' : 'skipped' },
      message: 'At least one channel was already sent. Refusing to double-send.',
    }
  }

  if (!event.matched_agent_id) {
    return errorResult(eventId, 'No matched_agent_id on event; cannot dispatch.', supabase)
  }

  // Load primary + (optional) secondary agent. We fetch the secondary when
  // it's set AND distinct from the primary; same-agent-both-sides (existing
  // dual-agency case where matched == second_matched) only emails once.
  const agentIds: string[] = [event.matched_agent_id]
  if (
    event.second_matched_agent_id &&
    event.second_matched_agent_id !== event.matched_agent_id
  ) {
    agentIds.push(event.second_matched_agent_id)
  }

  // Load pipe (brand text), agents, and brokerage branding (white-label logo
  // for the email header) in parallel. The logo comes from brokerages.logo_url
  // (same column lib/email.ts renders); a miss or error just leaves it null and
  // the email falls back to its text banner, so the branding read never blocks
  // the dispatch.
  const [
    { data: pipe, error: pipeErr },
    { data: agentRows, error: agentErr },
    { data: brokerageRow },
  ] = await Promise.all([
    supabase
      .from('brokerage_pipes')
      .select('brand_name, brand_tagline')
      .eq('id', event.brokerage_pipe_id)
      .single(),
    supabase
      .from('agents')
      .select('id, first_name, email, phone')
      .in('id', agentIds),
    supabase
      .from('brokerages')
      .select('logo_url, logo_includes_tagline, firm_deal_email_enabled, firm_deal_sms_enabled')
      .eq('id', event.brokerage_id)
      .maybeSingle(),
  ])

  if (pipeErr || !pipe) return errorResult(eventId, `Pipe load failed: ${pipeErr?.message}`, supabase)
  if (agentErr || !agentRows || agentRows.length === 0) {
    return errorResult(eventId, `Agent load failed: ${agentErr?.message ?? 'no rows'}`, supabase)
  }

  // Preserve order: primary first, then secondary. The supabase `.in()` call
  // doesn't guarantee result order, so we sort by the agentIds order.
  const agentById = new Map((agentRows as AgentRecord[]).map(a => [a.id, a]))
  const recipients: AgentRecord[] = agentIds
    .map(id => agentById.get(id))
    .filter((a): a is AgentRecord => !!a)

  if (recipients.length === 0) {
    return errorResult(eventId, 'No recipients resolved from matched_agent_id(s).', supabase)
  }

  const ctx: DispatchContext = {
    event: event as DispatchContext['event'],
    pipe: {
      brand_name: pipe.brand_name ?? 'Firm Funds',
      brand_tagline: pipe.brand_tagline ?? 'Powered by Firm Funds',
    },
    branding: {
      logo_url: brokerageRow?.logo_url ?? null,
      logo_includes_tagline: brokerageRow?.logo_includes_tagline ?? null,
    },
    channels: {
      // Only an explicit `false` suppresses a channel. A missing brokerage row
      // (lookup miss) leaves both enabled so we never silently swallow an offer.
      email_enabled: brokerageRow?.firm_deal_email_enabled !== false,
      sms_enabled: brokerageRow?.firm_deal_sms_enabled !== false,
    },
    recipients,
  }

  return await dispatchWithContext(ctx, supabase, options)
}

// pickAgentVariant + NotifyTier moved to ./offer-estimate (imported +
// re-exported above) so both the notification dispatch and the firm-deal
// link-preview card select the same variant and quote the same advance.

interface PerAgentSend {
  agent_id: string
  email: ChannelResult
  sms: ChannelResult
  tier: NotifyTier
  variant: 'sparse' | 'sparse_with_date' | 'dual_agency' | 'detailed'
}

async function sendForOneAgent(
  agent: AgentRecord,
  ctx: DispatchContext,
  supabase: SupabaseClient
): Promise<PerAgentSend> {
  const parsed = ctx.event.parsed
  const propertyAddress = parsed?.address || 'your recent deal'

  const { variant, tier, commission_amount, advance_estimate } = pickAgentVariant(agent.id, ctx.event)

  // Mint a per-agent magic-link token so each co-agent or dual-agency
  // recipient lands on /agent/firm-deal/<token> bound to THEIR agent id.
  // If minting fails for any one recipient we degrade to a plain deep
  // link for that recipient only (they'll just hit /login if their
  // session is gone).
  let cta_url = `${APP_URL.replace(/\/$/, '')}/agent?firm_deal=${encodeURIComponent(ctx.event.id)}`
  try {
    const { token } = await mintFirmDealMagicLink(supabase, {
      firm_deal_event_id: ctx.event.id,
      agent_id: agent.id,
    })
    cta_url = `${APP_URL.replace(/\/$/, '')}/agent/firm-deal/${token}`
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    console.warn(
      `[dispatch] mintFirmDealMagicLink failed for agent ${agent.id}, falling back to deep link:`,
      errMessage
    )
    try {
      await logAuditEventServiceRole({
        action: 'firm_deal.magic_link_mint_failed',
        entityType: 'firm_deal_event',
        entityId: ctx.event.id,
        severity: 'warning',
        metadata: {
          event_id: ctx.event.id,
          agent_id: agent.id,
          error: errMessage,
        },
      })
    } catch (auditErr) {
      console.warn(
        '[dispatch] audit log of magic-link mint failure also failed:',
        auditErr instanceof Error ? auditErr.message : auditErr
      )
    }
  }

  const email = renderTriggerEmail({
    agent_first_name: agent.first_name ?? '',
    property_address: propertyAddress,
    closing_date_iso: parsed?.closing_date_iso ?? null,
    brand_name: ctx.pipe.brand_name,
    brand_tagline: ctx.pipe.brand_tagline,
    brand_logo_url: ctx.branding.logo_url,
    brand_logo_includes_tagline: ctx.branding.logo_includes_tagline,
    cta_url,
    variant,
    commission_amount,
    advance_estimate,
  })
  const sms = renderTriggerSms({
    agent_first_name: agent.first_name ?? '',
    property_address: propertyAddress,
    brand_name: ctx.pipe.brand_name,
    cta_url,
    closing_date_human: formatClosingDateHuman(parsed?.closing_date_iso ?? null),
    closing_date_iso: parsed?.closing_date_iso ?? null,
    variant,
    commission_amount,
    advance_estimate,
  })

  // Per-brokerage channel toggles (migration 114). A disabled channel is
  // skipped with status 'skipped_disabled' so the aggregate + audit log show
  // WHY it didn't send (vs. a missing address/phone). If a brokerage disables
  // both channels the event still resolves to 'errored' with a clear
  // per-channel summary, surfacing the misconfiguration to the admin.
  const emailPromise: Promise<ChannelResult> = ctx.channels.email_enabled
    ? sendEmail(agent.email, email)
    : Promise.resolve({ status: 'skipped_disabled' })
  const smsPromise: Promise<ChannelResult> = !ctx.channels.sms_enabled
    ? Promise.resolve({ status: 'skipped_disabled' })
    : agent.phone
      ? sendSms({ to: agent.phone, body: sms.body })
      : Promise.resolve({ status: 'skipped_no_phone' })
  const [emailResult, smsResult] = await Promise.all([emailPromise, smsPromise])

  // Audit log: capture which tier (A/B/C) we picked and how each channel
  // resolved. Best-effort; failures here don't block the actual send result.
  try {
    await logAuditEventServiceRole({
      action: 'firm_deal.notify_dispatched',
      entityType: 'firm_deal_event',
      entityId: ctx.event.id,
      severity: 'info',
      metadata: {
        event_id: ctx.event.id,
        agent_id: agent.id,
        notify_tier: tier,
        variant,
        email_status: emailResult.status,
        sms_status: smsResult.status,
        commission_amount,
        advance_estimate,
      },
    })
  } catch (auditErr) {
    console.warn(
      '[dispatch] notify audit log failed (non-fatal):',
      auditErr instanceof Error ? auditErr.message : auditErr
    )
  }

  return { agent_id: agent.id, email: emailResult, sms: smsResult, tier, variant }
}

async function dispatchWithContext(
  ctx: DispatchContext,
  supabase: SupabaseClient,
  options: { resend?: boolean } = {}
): Promise<DispatchResult> {
  // Fan out: each recipient gets their own variant pick, magic link,
  // rendered content, and parallel email + SMS send.
  const perAgent = await Promise.all(
    ctx.recipients.map(agent => sendForOneAgent(agent, ctx, supabase))
  )

  // Aggregate across agents. If ANY agent's email or SMS sent, we mark
  // the event as offer_sent. The per-agent breakdown is returned in
  // agent_results so the caller can see who failed if anyone did.
  const anyEmailSent = perAgent.some(r => r.email.status === 'sent')
  const anySmsSent = perAgent.some(r => r.sms.status === 'sent')
  const anySent = anyEmailSent || anySmsSent

  // On a re-send we deliberately leave the event's status and sent-at
  // timestamps untouched: the offer was already recorded as sent, so we just
  // re-fire the channels and report the per-channel outcome. This also means a
  // failed re-send can never downgrade an offer_sent event to errored.
  if (!options.resend) {
    const updateFields: Record<string, unknown> = {}
    if (anyEmailSent) updateFields.email_sent_at = new Date().toISOString()
    if (anySmsSent) updateFields.sms_sent_at = new Date().toISOString()
    const newStatus = anySent ? 'offer_sent' : 'errored'
    updateFields.status = newStatus
    if (!anySent) {
      const summary = perAgent
        .map(r => `agent ${r.agent_id.slice(0, 8)}: email=${r.email.status} ${r.email.error ?? ''}; sms=${r.sms.status} ${r.sms.error ?? ''}`)
        .join(' | ')
      updateFields.error_message = `All channels failed across ${perAgent.length} recipient(s). ${summary}`
    }
    // Soft transition guard — see process-event.ts FIRM_DEAL_EVENT_TRANSITIONS.
    if (!isValidFirmDealEventTransition(ctx.event.status, newStatus)) {
      console.warn(
        `[firm_deal_events] invalid status transition: ${ctx.event.status} -> ${newStatus} ` +
          `(at dispatchWithContext). This is allowed for now but will become an error.`
      )
    }
    await supabase.from('firm_deal_events').update(updateFields).eq('id', ctx.event.id)
  }

  // Top-level email/sms mirror the PRIMARY recipient so callers that
  // pre-date multi-agent dispatch still see the existing shape. The
  // per-agent breakdown is in agent_results.
  const primary = perAgent[0]

  return {
    event_id: ctx.event.id,
    outcome: anySent ? 'offer_sent' : 'errored',
    email: {
      status: primary.email.status,
      provider_id: primary.email.message_sid,
      error: primary.email.error,
    },
    sms: {
      status: primary.sms.status,
      provider_id: primary.sms.message_sid,
      error: primary.sms.error,
    },
    agent_results: perAgent.length > 1
      ? perAgent.map(r => ({
          agent_id: r.agent_id,
          email: { status: r.email.status, provider_id: r.email.message_sid, error: r.email.error },
          sms: { status: r.sms.status, provider_id: r.sms.message_sid, error: r.sms.error },
        }))
      : undefined,
  }
}

interface ChannelResult {
  status: string
  message_sid?: string
  error?: string
}

async function sendEmail(
  toEmail: string | null,
  rendered: { subject: string; html: string; text: string }
): Promise<ChannelResult> {
  if (!toEmail) {
    return { status: 'skipped_no_email' }
  }
  const resend = getResend()
  if (!resend) {
    if (process.env.NODE_ENV === 'production') {
      return { status: 'errored', error: 'RESEND_API_KEY not configured' }
    }
    console.warn('[dispatch] RESEND_API_KEY missing - email skipped (dev only)')
    return { status: 'skipped_no_credentials' }
  }
  try {
    const { data, error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: toEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    })
    if (error) {
      return { status: 'errored', error: error.message ?? 'unknown resend error' }
    }
    return { status: 'sent', message_sid: data?.id }
  } catch (err) {
    return {
      status: 'errored',
      error: err instanceof Error ? err.message : 'unknown email error',
    }
  }
}

async function errorResult(
  eventId: string,
  message: string,
  supabase?: SupabaseClient
): Promise<DispatchResult> {
  if (supabase) {
    // Cheap read so the transition warning has from-state context. The error
    // path must not depend on it succeeding.
    const { data: cur } = await supabase
      .from('firm_deal_events')
      .select('status')
      .eq('id', eventId)
      .maybeSingle()
    if (cur?.status && !isValidFirmDealEventTransition(cur.status as string, 'errored')) {
      console.warn(
        `[firm_deal_events] invalid status transition: ${cur.status} -> errored ` +
          `(at dispatch.errorResult).`
      )
    }
    await supabase
      .from('firm_deal_events')
      .update({ status: 'errored', error_message: message })
      .eq('id', eventId)
  }
  return {
    event_id: eventId,
    outcome: 'errored',
    email: { status: 'skipped' },
    sms: { status: 'skipped' },
    message,
  }
}

/**
 * Dispatch every status='approved' firm-deal event (safety-net sweep). The
 * primary send path is inline from the admin "Send" server action; this catches
 * retries and the auto-fire path. Used by the firm-deal-poller (inline, after
 * processing) and by the standalone firm-deal-dispatcher route. Never throws on
 * a single event — per-event errors are collected and counted.
 */
export async function dispatchApprovedEvents(
  supabase: SupabaseClient,
  limit = 50
): Promise<{ dispatched: number; errored: number; skipped: number; errors: Array<{ id: string; message?: string }> }> {
  const { data: pending, error } = await supabase
    .from('firm_deal_events')
    .select('id')
    .eq('status', 'approved')
    .order('received_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`Load approved events: ${error.message}`)

  let dispatched = 0
  let errored = 0
  let skipped = 0
  const errors: Array<{ id: string; message?: string }> = []

  for (const row of pending ?? []) {
    try {
      const r = await dispatchFirmDealNotification(row.id, supabase)
      if (r.outcome === 'offer_sent') dispatched++
      else if (r.outcome === 'errored') { errored++; errors.push({ id: row.id, message: r.message }) }
      else skipped++
    } catch (err) {
      errored++
      errors.push({ id: row.id, message: err instanceof Error ? err.message : 'unknown error' })
    }
  }

  return { dispatched, errored, skipped, errors }
}
