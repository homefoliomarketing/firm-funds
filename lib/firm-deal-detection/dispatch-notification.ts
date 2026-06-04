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
  /** Recipients to fan out to. Always at least one (the primary). For
   *  co-agent splits and dual-agency-with-distinct-agents, two entries. */
  recipients: AgentRecord[]
}

// ============================================================================
// Advance estimator — shared by email + SMS so both quote the same number
// ============================================================================
const RATE_PER_1000_PER_DAY = 0.80
const DEFAULT_SETTLEMENT_DAYS = 7

/**
 * Estimate the pre-split advance against a gross commission, given days
 * until closing. Mirrors lib/calculations.ts but treats the gross as the
 * net (brokerageSplitPct = 0) because at offer time we don't know the
 * agent's office split. The email + SMS both label the figure as
 * "before brokerage splits" so the inflation vs the real advance is
 * disclosed.
 */
export function estimateAdvanceFromGross(
  grossCommission: number,
  daysUntilClosing: number
): number {
  if (!Number.isFinite(grossCommission) || grossCommission <= 0) return 0
  // Funding day not charged (funds arrive next day); closing day IS charged.
  // Mirrors getChargeDays in lib/calculations.ts.
  const effectiveDays = Math.max(1, Math.floor(daysUntilClosing))
  const discountFee = grossCommission * (RATE_PER_1000_PER_DAY / 1000) * effectiveDays
  const settlementFee = grossCommission * (RATE_PER_1000_PER_DAY / 1000) * DEFAULT_SETTLEMENT_DAYS
  return Math.max(0, Math.round(grossCommission - discountFee - settlementFee))
}

// "2026-06-30" -> "June 30, 2026". Returns null for invalid/null input so
// the SMS renderer can detect "no date" and fall through to Tier A copy.
function formatClosingDateHuman(iso: string | null): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December']
  const month = months[parseInt(m[2], 10) - 1]
  const day = parseInt(m[3], 10)
  return `${month} ${day}, ${m[1]}`
}

function daysFromTodayToISO(iso: string | null): number {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 0
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const today = new Date(todayStr + 'T00:00:00Z').getTime()
  const closing = new Date(iso + 'T00:00:00Z').getTime()
  return Math.max(0, Math.ceil((closing - today) / (1000 * 60 * 60 * 24)))
}

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
  supabase: SupabaseClient
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

  if (event.status !== 'approved') {
    return {
      event_id: eventId,
      outcome: 'skipped',
      email: { status: 'skipped' },
      sms: { status: 'skipped' },
      message: `Status is ${event.status}, dispatch only acts on 'approved'.`,
    }
  }

  if (event.email_sent_at || event.sms_sent_at) {
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

  const [{ data: pipe, error: pipeErr }, { data: agentRows, error: agentErr }] = await Promise.all([
    supabase
      .from('brokerage_pipes')
      .select('brand_name, brand_tagline')
      .eq('id', event.brokerage_pipe_id)
      .single(),
    supabase
      .from('agents')
      .select('id, first_name, email, phone')
      .in('id', agentIds),
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
    recipients,
  }

  return await dispatchWithContext(ctx, supabase)
}

// ============================================================================
// Per-agent variant selection (tiered by info available)
// ============================================================================
// Returns the variant + commission amount the renderer should use for one
// agent on one event.
//
// Tier mapping (Bud's sensible defaults, 2026-05-29):
//   Tier A: property only (no closing date, no commission) — sparse, lowest
//           confidence. Copy: "we spotted a possible deal, confirm details".
//   Tier B: property + closing date, no commission         — sparse_with_date,
//           timing confirmed, ask the agent (or brokerage) to submit so we
//           can fund as soon as the commission number is in.
//   Tier C: property + closing date + commission           — detailed,
//           fully ready, quote the gross + estimated advance.
//
// Decision order (special-case picks beat tier picks):
//   1. Co-agent split event              -> sparse (generic, no numbers).
//      We don't know each co-agent's share so any quote would misinform.
//      Tier letter is still informative for the audit log — use date
//      presence (B if a date is known, A otherwise).
//   2. Same agent on both sides          -> dual_agency
//      Existing behavior. Detailed-with-numbers across dual-agency is a
//      future iteration once we have UI for showing both sides' commission.
//   3. Tier C (commission + closing date) -> detailed
//   4. Tier B (closing date only)         -> sparse_with_date
//   5. Tier A (property only)             -> sparse
// ============================================================================
export type NotifyTier = 'A' | 'B' | 'C'

export function pickAgentVariant(
  agentId: string,
  event: DispatchContext['event']
): {
  variant: 'sparse' | 'sparse_with_date' | 'dual_agency' | 'detailed'
  tier: NotifyTier
  commission_amount: number | null
  advance_estimate: number | null
} {
  const parsed = event.parsed
  const hasClosingDate = !!parsed?.closing_date_iso

  // Per-side commission lookup. We use listing_matched_agent_id /
  // selling_matched_agent_id (written by processFirmDealEvent) to decide
  // which side this agent is on; that wins over matched_agent_id which is
  // a flattened "first agent to dispatch to" slot.
  let commission: number | null = null
  if (parsed?.listing_agent_commission_amount && event.listing_matched_agent_id === agentId) {
    commission = parsed.listing_agent_commission_amount
  } else if (parsed?.selling_agent_commission_amount && event.selling_matched_agent_id === agentId) {
    commission = parsed.selling_agent_commission_amount
  }

  // Compute the tier letter independent of the visual variant pick so the
  // audit log always reflects what data was available, even when a special
  // case (split, dual agency) forced a generic visual variant.
  let tier: NotifyTier = 'A'
  if (commission && commission > 0 && hasClosingDate) tier = 'C'
  else if (hasClosingDate) tier = 'B'

  if (event.co_agent_split) {
    return { variant: 'sparse', tier, commission_amount: null, advance_estimate: null }
  }

  // Existing dual-agency: same agent matched on both sides.
  if (
    event.second_matched_agent_id &&
    event.second_matched_agent_id === event.matched_agent_id &&
    agentId === event.matched_agent_id
  ) {
    return { variant: 'dual_agency', tier, commission_amount: null, advance_estimate: null }
  }

  if (tier === 'C' && commission) {
    const days = daysFromTodayToISO(parsed!.closing_date_iso!)
    const advance = estimateAdvanceFromGross(commission, days)
    if (advance > 0) {
      return { variant: 'detailed', tier: 'C', commission_amount: commission, advance_estimate: advance }
    }
    // Advance came out non-positive (closing already past, etc.). Fall back
    // to the next tier down so the agent still gets something useful.
    return { variant: 'sparse_with_date', tier: 'B', commission_amount: null, advance_estimate: null }
  }

  if (tier === 'B') {
    return { variant: 'sparse_with_date', tier: 'B', commission_amount: null, advance_estimate: null }
  }

  return { variant: 'sparse', tier: 'A', commission_amount: null, advance_estimate: null }
}

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
    variant,
    commission_amount,
    advance_estimate,
  })

  const [emailResult, smsResult] = await Promise.all([
    sendEmail(agent.email, email),
    agent.phone
      ? sendSms({ to: agent.phone, body: sms.body })
      : Promise.resolve({ status: 'skipped_no_phone' as const, message_sid: undefined, error: undefined }),
  ])

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
  supabase: SupabaseClient
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
