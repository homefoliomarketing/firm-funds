/**
 * lib/firm-deal-detection/dispatch-brokerage-offer.ts
 *
 * Sends the brokerage-targeted notification when an agent accepts a firm
 * deal offer. Three send paths:
 *
 *   1. sendBrokerageOfferNotification  — fired from acceptFirmDealOffer
 *      immediately after the offered deal row is created.
 *   2. sendBrokerageOfferNudge2h       — fired from the offer-nudges cron
 *      ~2 hours after the initial notification if status is still 'offered'.
 *   3. sendInternalEscalation4h        — fired from the same cron at ~4
 *      hours, to the Firm Funds inbox only. Tells us to call.
 *
 * Recipients:
 *   - The brokerage's primary email (brokerages.email) is the default
 *     recipient for the brokerage-facing emails (1, 2). Firm Funds is
 *     CC'd on every brokerage email so we have full visibility into the
 *     flow without needing to log in.
 *   - The internal escalation (3) ships only to the Firm Funds inbox.
 *   - The "Firm Funds inbox" address resolves in this order:
 *       1. notification_recipients.ff_inbox_override on the pipe (per
 *          brokerage, configured from the admin UI)
 *       2. FIRM_FUNDS_OFFER_INBOX env var
 *       3. Hard fallback to bud@firmfunds.ca
 *     This lets a white-label brokerage route copies to a dedicated
 *     mailbox without redeploying.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import {
  renderBrokerageOfferEmail,
  renderInternalEscalationEmail,
  type BrokerageOfferTier,
  type BrokerageOfferVariant,
} from './render-brokerage-offer-email'
import { renderAgentDeclineEmail } from './render-agent-decline-email'
import { estimateAdvanceFromGross } from './dispatch-notification'
import { logAuditEventServiceRole } from '@/lib/audit'

const APP_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca').replace(/\/$/, '')
const FROM_ADDRESS = process.env.FIRM_DEAL_FROM_ADDRESS || 'Firm Funds <notifications@firmfunds.ca>'
const FF_OFFER_INBOX_DEFAULT = process.env.FIRM_FUNDS_OFFER_INBOX || 'bud@firmfunds.ca'

/**
 * Resolve the Firm Funds inbox for a specific pipe. Per-pipe override wins;
 * otherwise we fall back to the env var (or the hard default if even that
 * is unset). Pulled into a function so the dispatcher, the gate-check, and
 * the 4h escalation all agree on the same precedence rules.
 */
export function resolveFFInbox(ffInboxOverride: string | null | undefined): string {
  const cleaned = (ffInboxOverride ?? '').trim().toLowerCase()
  if (cleaned) return cleaned
  return FF_OFFER_INBOX_DEFAULT.toLowerCase()
}

let _resend: Resend | null = null
function getResend(): Resend | null {
  if (_resend) return _resend
  if (!process.env.RESEND_API_KEY) return null
  _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

export interface BrokerageDispatchResult {
  deal_id: string
  outcome: 'sent' | 'errored' | 'skipped'
  recipients: string[]
  provider_id?: string
  error?: string
}

/**
 * Internal helper. Pulls the offered deal + brokerage + agent + pipe brand
 * and renders the right email template, then sends through Resend.
 */
async function loadContext(supabase: SupabaseClient, dealId: string) {
  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .select(`
      id, status, agent_id, brokerage_id, property_address, closing_date,
      offered_at, offered_event_id, brokerage_notified_at, brokerage_nudge_2h_at,
      internal_alert_4h_at
    `)
    .eq('id', dealId)
    .maybeSingle()

  if (dealErr || !deal) {
    return { error: `Deal load failed: ${dealErr?.message ?? 'not found'}` as const }
  }

  // Agent + brokerage + (optional) pipe brand for the white-label header.
  const [agentRes, brokerageRes, eventRes] = await Promise.all([
    supabase.from('agents').select('id, first_name, last_name, email, phone').eq('id', deal.agent_id).maybeSingle(),
    supabase.from('brokerages').select('id, name, email, phone, broker_of_record_email').eq('id', deal.brokerage_id).maybeSingle(),
    deal.offered_event_id
      ? supabase.from('firm_deal_events').select('brokerage_pipe_id, parsed, listing_matched_agent_id, selling_matched_agent_id, matched_agent_id, second_matched_agent_id, co_agent_split').eq('id', deal.offered_event_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (agentRes.error || !agentRes.data) return { error: `Agent load failed: ${agentRes.error?.message ?? 'not found'}` as const }
  if (brokerageRes.error || !brokerageRes.data) return { error: `Brokerage load failed: ${brokerageRes.error?.message ?? 'not found'}` as const }

  let brand_name = 'Firm Funds'
  let brand_tagline = 'Powered by Firm Funds'
  let closing_date_iso: string | null = (deal.closing_date as string | null) ?? null
  // Side-of-deal commission for the accepting agent. Populated below from
  // the firm_deal_events.parsed payload when the event row exists.
  let commission_amount: number | null = null
  // Recipient config from migration 082. Defaults are safe-empty so a pipe
  // that pre-dates the migration still gets the always-included recipients.
  // ff_inbox_override added later (no migration — JSONB shape) lets each
  // pipe route the FF inbox copy elsewhere; null means "use the env var".
  let pipe_recipients: {
    include_broker_of_record: boolean
    extra_emails: string[]
    ff_inbox_override: string | null
  } = {
    include_broker_of_record: false,
    extra_emails: [],
    ff_inbox_override: null,
  }
  if (eventRes.data) {
    const ev = eventRes.data as {
      brokerage_pipe_id: string
      parsed: Record<string, unknown> | null
      listing_matched_agent_id: string | null
      selling_matched_agent_id: string | null
      matched_agent_id: string | null
      co_agent_split: boolean | null
    }
    const { data: pipe } = await supabase
      .from('brokerage_pipes')
      .select('brand_name, brand_tagline, notification_recipients')
      .eq('id', ev.brokerage_pipe_id)
      .maybeSingle()
    if (pipe?.brand_name) brand_name = pipe.brand_name
    if (pipe?.brand_tagline) brand_tagline = pipe.brand_tagline
    if (pipe?.notification_recipients) {
      const r = pipe.notification_recipients as Record<string, unknown>
      pipe_recipients = {
        include_broker_of_record: r.include_broker_of_record === true,
        extra_emails: Array.isArray(r.extra_emails)
          ? (r.extra_emails as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
        ff_inbox_override: typeof r.ff_inbox_override === 'string' && r.ff_inbox_override.trim()
          ? r.ff_inbox_override.trim().toLowerCase()
          : null,
      }
    }
    const parsedClose = (ev.parsed as { closing_date_iso?: string | null } | null)?.closing_date_iso
    if (parsedClose) closing_date_iso = parsedClose
    // Pull side-of-deal commission for the accepting agent. If we don't know
    // which side they were on (no listing/selling match resolved), leave the
    // commission null so the brokerage email lands on Tier B (no number) rather
    // than misquoting a co-agent's number.
    const parsed = ev.parsed as {
      listing_agent_commission_amount?: number | null
      selling_agent_commission_amount?: number | null
    } | null
    if (parsed && !ev.co_agent_split) {
      if (ev.listing_matched_agent_id && ev.listing_matched_agent_id === deal.agent_id && typeof parsed.listing_agent_commission_amount === 'number') {
        commission_amount = parsed.listing_agent_commission_amount
      } else if (ev.selling_matched_agent_id && ev.selling_matched_agent_id === deal.agent_id && typeof parsed.selling_agent_commission_amount === 'number') {
        commission_amount = parsed.selling_agent_commission_amount
      }
    }
  }

  const agent = agentRes.data as { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }
  const brokerage = brokerageRes.data as { id: string; name: string; email: string; phone: string | null; broker_of_record_email: string | null }

  return {
    deal: deal as {
      id: string; status: string; agent_id: string; brokerage_id: string
      property_address: string; closing_date: string | null
      offered_at: string | null; brokerage_notified_at: string | null
    },
    agent,
    brokerage,
    brand_name,
    brand_tagline,
    closing_date_iso,
    commission_amount,
    pipe_recipients,
  }
}

// Days from today (Toronto local) to a given closing ISO date. Mirrors the
// agent-side helper in dispatch-notification.ts; duplicated here to keep
// this file standalone for the brokerage advance estimate.
function daysFromTodayToISO(iso: string | null): number {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 0
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const today = new Date(todayStr + 'T00:00:00Z').getTime()
  const closing = new Date(iso + 'T00:00:00Z').getTime()
  return Math.max(0, Math.ceil((closing - today) / (1000 * 60 * 60 * 24)))
}

function resolveTier(
  closingDateIso: string | null,
  commissionAmount: number | null
): { tier: BrokerageOfferTier; advance: number | null } {
  if (closingDateIso && commissionAmount && commissionAmount > 0) {
    const days = daysFromTodayToISO(closingDateIso)
    const advance = estimateAdvanceFromGross(commissionAmount, days)
    if (advance > 0) return { tier: 'C', advance }
    // Closing already past or non-positive advance: fall back to Tier B
    return { tier: 'B', advance: null }
  }
  if (closingDateIso) return { tier: 'B', advance: null }
  return { tier: 'A', advance: null }
}

function buildBrokeragePortalUrl(dealId: string): string {
  return `${APP_URL}/brokerage/deals/new?from_offer=${encodeURIComponent(dealId)}`
}

function buildAgentDashboardUrl(dealId: string): string {
  return `${APP_URL}/agent/deals/${encodeURIComponent(dealId)}`
}

async function sendOne(opts: {
  to: string[]
  subject: string
  html: string
  text: string
}): Promise<{ ok: true; provider_id?: string } | { ok: false; error: string }> {
  const resend = getResend()
  if (!resend) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, error: 'RESEND_API_KEY not configured' }
    }
    console.warn('[brokerage-dispatch] RESEND_API_KEY missing - skipped (dev)')
    return { ok: false, error: 'no_credentials_dev' }
  }
  try {
    const { data, error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    })
    if (error) return { ok: false, error: error.message ?? 'unknown resend error' }
    return { ok: true, provider_id: data?.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown email error' }
  }
}

/**
 * Build the recipient list for a brokerage-facing email. Always includes
 * the brokerage's main email and the Firm Funds inbox so we have visibility.
 * The pipe's `notification_recipients` config (migration 082) layers on:
 *   - Broker of Record (if the toggle is on AND the brokerage has a
 *     broker_of_record_email on file)
 *   - Each free-form extra email the admin added on the settings page
 *   - ff_inbox_override on the pipe, if set, replaces the default FF inbox
 *     for this brokerage's emails (per-pipe override of the env var)
 *
 * Set semantics ensure no double-sends even if a recipient appears in
 * multiple sources (e.g. the brokerage's main email happens to be the
 * Broker of Record).
 *
 * Exported so the acceptance flow can run the same validation upfront and
 * refuse to create an offered deal that nobody at the brokerage would ever
 * see. Keeping a single source of truth here prevents drift between the
 * gate-check and the actual send.
 */
export function recipientsForBrokerage(
  brokerage: { email: string | null; broker_of_record_email: string | null },
  pipeRecipients: {
    include_broker_of_record: boolean
    extra_emails: string[]
    ff_inbox_override?: string | null
  }
): string[] {
  const list = new Set<string>()
  if (brokerage.email) list.add(brokerage.email.toLowerCase())
  const ffInbox = resolveFFInbox(pipeRecipients.ff_inbox_override)
  if (ffInbox) list.add(ffInbox)
  if (pipeRecipients.include_broker_of_record && brokerage.broker_of_record_email) {
    list.add(brokerage.broker_of_record_email.toLowerCase())
  }
  for (const email of pipeRecipients.extra_emails) {
    if (email) list.add(email.toLowerCase())
  }
  return Array.from(list)
}

/**
 * Pre-flight check for the acceptance flow. Loads the brokerage + the (optional)
 * pipe's notification_recipients config and returns the same recipient set the
 * notification dispatcher will use. Returns an empty array if nothing valid
 * is configured — the caller decides whether to refuse acceptance or proceed
 * with degraded delivery (today: refuse, see acceptFirmDealOffer).
 *
 * `pipeId` is optional because the event may have been resolved manually with
 * no upstream pipe (e.g. backfill scenarios in future). With no pipe, defaults
 * are: include_broker_of_record=false, extra_emails=[].
 */
export async function loadBrokerageOfferRecipients(
  supabase: SupabaseClient,
  brokerageId: string,
  pipeId: string | null
): Promise<{ recipients: string[]; brokerage_loaded: boolean }> {
  const { data: brokerage } = await supabase
    .from('brokerages')
    .select('email, broker_of_record_email')
    .eq('id', brokerageId)
    .maybeSingle()

  if (!brokerage) {
    return { recipients: [], brokerage_loaded: false }
  }

  let pipeRecipients: {
    include_broker_of_record: boolean
    extra_emails: string[]
    ff_inbox_override: string | null
  } = {
    include_broker_of_record: false,
    extra_emails: [],
    ff_inbox_override: null,
  }
  if (pipeId) {
    const { data: pipe } = await supabase
      .from('brokerage_pipes')
      .select('notification_recipients')
      .eq('id', pipeId)
      .maybeSingle()
    if (pipe?.notification_recipients) {
      const r = pipe.notification_recipients as Record<string, unknown>
      pipeRecipients = {
        include_broker_of_record: r.include_broker_of_record === true,
        extra_emails: Array.isArray(r.extra_emails)
          ? (r.extra_emails as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
        ff_inbox_override: typeof r.ff_inbox_override === 'string' && r.ff_inbox_override.trim()
          ? r.ff_inbox_override.trim().toLowerCase()
          : null,
      }
    }
  }

  return {
    recipients: recipientsForBrokerage(
      brokerage as { email: string | null; broker_of_record_email: string | null },
      pipeRecipients
    ),
    brokerage_loaded: true,
  }
}

async function dispatchBrokerageVariant(
  supabase: SupabaseClient,
  dealId: string,
  variant: BrokerageOfferVariant
): Promise<BrokerageDispatchResult> {
  const ctx = await loadContext(supabase, dealId)
  if ('error' in ctx) {
    return { deal_id: dealId, outcome: 'errored', recipients: [], error: ctx.error }
  }

  const recipients = recipientsForBrokerage(ctx.brokerage, ctx.pipe_recipients)
  if (recipients.length === 0) {
    return { deal_id: dealId, outcome: 'skipped', recipients: [], error: 'No recipients on brokerage record.' }
  }

  const { tier, advance } = resolveTier(ctx.closing_date_iso, ctx.commission_amount)
  const rendered = renderBrokerageOfferEmail({
    brokerage_name: ctx.brokerage.name,
    agent_full_name: `${ctx.agent.first_name ?? ''} ${ctx.agent.last_name ?? ''}`.trim() || 'an agent',
    agent_email: ctx.agent.email,
    agent_phone: ctx.agent.phone,
    property_address: ctx.deal.property_address,
    closing_date_iso: ctx.closing_date_iso,
    brand_name: ctx.brand_name,
    brand_tagline: ctx.brand_tagline,
    brokerage_portal_url: buildBrokeragePortalUrl(dealId),
    variant,
    tier,
    commission_amount: ctx.commission_amount,
    advance_estimate: advance,
  })

  const send = await sendOne({
    to: recipients,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })

  if (!send.ok) {
    return { deal_id: dealId, outcome: 'errored', recipients, error: send.error }
  }

  // Stamp the appropriate timestamp so the cron and the dashboard know
  // which channel has already fired. Both stamps use service-role on the
  // calling side; this update inherits that.
  const updates: Record<string, string> = {}
  if (variant === 'initial') updates.brokerage_notified_at = new Date().toISOString()
  if (variant === 'nudge_2h') updates.brokerage_nudge_2h_at = new Date().toISOString()
  if (Object.keys(updates).length > 0) {
    await supabase.from('deals').update(updates).eq('id', dealId)
  }

  // Audit log the brokerage-side notification with the tier so we can
  // measure how often each tier fires and tune the copy.
  try {
    await logAuditEventServiceRole({
      action: 'firm_deal.notify_brokerage_dispatched',
      entityType: 'deal',
      entityId: dealId,
      severity: 'info',
      metadata: {
        deal_id: dealId,
        brokerage_id: ctx.brokerage.id,
        variant,
        notify_tier: tier,
        recipients,
        commission_amount: ctx.commission_amount,
        advance_estimate: advance,
      },
    })
  } catch (auditErr) {
    console.warn(
      '[brokerage-dispatch] notify audit log failed (non-fatal):',
      auditErr instanceof Error ? auditErr.message : auditErr
    )
  }

  return { deal_id: dealId, outcome: 'sent', recipients, provider_id: send.provider_id }
}

export function sendBrokerageOfferNotification(supabase: SupabaseClient, dealId: string) {
  return dispatchBrokerageVariant(supabase, dealId, 'initial')
}

export function sendBrokerageOfferNudge2h(supabase: SupabaseClient, dealId: string) {
  return dispatchBrokerageVariant(supabase, dealId, 'nudge_2h')
}

/**
 * Email the agent when a brokerage declines their offered deal. Best-effort
 * fire from declineFirmDealOffer; the deal row already carries the decision
 * even if email delivery fails, and the agent sees the same info inline on
 * the offered-deal detail page.
 */
export async function sendAgentDeclineNotification(
  supabase: SupabaseClient,
  dealId: string,
  declineReason: string
): Promise<BrokerageDispatchResult> {
  const ctx = await loadContext(supabase, dealId)
  if ('error' in ctx) {
    return { deal_id: dealId, outcome: 'errored', recipients: [], error: ctx.error }
  }

  if (!ctx.agent.email) {
    // No email on file means no channel — degrade gracefully. Bud will
    // eventually surface this via the brokerage settings UI; until then
    // the agent will only see the decline on the dashboard.
    return {
      deal_id: dealId,
      outcome: 'skipped',
      recipients: [],
      error: 'Agent has no email on file; decline notification not sent.',
    }
  }

  const rendered = renderAgentDeclineEmail({
    agent_first_name: ctx.agent.first_name ?? '',
    brokerage_name: ctx.brokerage.name,
    property_address: ctx.deal.property_address,
    decline_reason: declineReason,
    brand_name: ctx.brand_name,
    brand_tagline: ctx.brand_tagline,
    agent_dashboard_url: buildAgentDashboardUrl(dealId),
  })

  const send = await sendOne({
    to: [ctx.agent.email],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })

  if (!send.ok) {
    return { deal_id: dealId, outcome: 'errored', recipients: [ctx.agent.email], error: send.error }
  }
  return { deal_id: dealId, outcome: 'sent', recipients: [ctx.agent.email], provider_id: send.provider_id }
}

export async function sendInternalEscalation4h(
  supabase: SupabaseClient,
  dealId: string
): Promise<BrokerageDispatchResult> {
  const ctx = await loadContext(supabase, dealId)
  if ('error' in ctx) {
    return { deal_id: dealId, outcome: 'errored', recipients: [], error: ctx.error }
  }

  const rendered = renderInternalEscalationEmail({
    brokerage_name: ctx.brokerage.name,
    brokerage_email: ctx.brokerage.email,
    brokerage_phone: ctx.brokerage.phone,
    agent_full_name: `${ctx.agent.first_name ?? ''} ${ctx.agent.last_name ?? ''}`.trim() || 'an agent',
    agent_email: ctx.agent.email,
    agent_phone: ctx.agent.phone,
    property_address: ctx.deal.property_address,
    closing_date_iso: ctx.closing_date_iso,
    offered_at_iso: ctx.deal.offered_at ?? new Date().toISOString(),
    brokerage_notified_at_iso: ctx.deal.brokerage_notified_at ?? new Date().toISOString(),
    brokerage_portal_url: buildBrokeragePortalUrl(dealId),
    agent_dashboard_url: buildAgentDashboardUrl(dealId),
  })

  // 4h escalation routes to the per-pipe FF inbox (override wins, env var
  // is the fallback). Same precedence as the brokerage-facing emails so a
  // white-label brokerage with a dedicated mailbox gets consistent routing.
  const ffInbox = resolveFFInbox(ctx.pipe_recipients.ff_inbox_override)

  const send = await sendOne({
    to: [ffInbox],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })

  if (!send.ok) {
    return { deal_id: dealId, outcome: 'errored', recipients: [ffInbox], error: send.error }
  }

  await supabase
    .from('deals')
    .update({ internal_alert_4h_at: new Date().toISOString() })
    .eq('id', dealId)

  return { deal_id: dealId, outcome: 'sent', recipients: [ffInbox], provider_id: send.provider_id }
}
