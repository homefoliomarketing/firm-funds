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
 *   - FIRM_FUNDS_OFFER_INBOX env var overrides the default
 *     (bud@firmfunds.ca) once we have a dedicated address. A future
 *     settings UI will let each brokerage configure broker-of-record +
 *     extra admin recipients; for now the column-driven defaults are
 *     intentional, see HANDOFF-firm-deal-followups.md.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import {
  renderBrokerageOfferEmail,
  renderInternalEscalationEmail,
  type BrokerageOfferVariant,
} from './render-brokerage-offer-email'
import { renderAgentDeclineEmail } from './render-agent-decline-email'

const APP_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://firmfunds.ca').replace(/\/$/, '')
const FROM_ADDRESS = process.env.FIRM_DEAL_FROM_ADDRESS || 'Firm Funds <notifications@firmfunds.ca>'
const FF_OFFER_INBOX = process.env.FIRM_FUNDS_OFFER_INBOX || 'bud@firmfunds.ca'

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
      ? supabase.from('firm_deal_events').select('brokerage_pipe_id, parsed').eq('id', deal.offered_event_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (agentRes.error || !agentRes.data) return { error: `Agent load failed: ${agentRes.error?.message ?? 'not found'}` as const }
  if (brokerageRes.error || !brokerageRes.data) return { error: `Brokerage load failed: ${brokerageRes.error?.message ?? 'not found'}` as const }

  let brand_name = 'Firm Funds'
  let brand_tagline = 'Powered by Firm Funds'
  let closing_date_iso: string | null = (deal.closing_date as string | null) ?? null
  // Recipient config from migration 082. Defaults are safe-empty so a pipe
  // that pre-dates the migration still gets the always-included recipients.
  let pipe_recipients: { include_broker_of_record: boolean; extra_emails: string[] } = {
    include_broker_of_record: false,
    extra_emails: [],
  }
  if (eventRes.data) {
    const ev = eventRes.data as { brokerage_pipe_id: string; parsed: Record<string, unknown> | null }
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
      }
    }
    const parsedClose = (ev.parsed as { closing_date_iso?: string | null } | null)?.closing_date_iso
    if (parsedClose) closing_date_iso = parsedClose
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
    pipe_recipients,
  }
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
 *
 * Set semantics ensure no double-sends even if a recipient appears in
 * multiple sources (e.g. the brokerage's main email happens to be the
 * Broker of Record).
 */
function recipientsForBrokerage(
  brokerage: { email: string; broker_of_record_email: string | null },
  pipeRecipients: { include_broker_of_record: boolean; extra_emails: string[] }
): string[] {
  const list = new Set<string>()
  if (brokerage.email) list.add(brokerage.email.toLowerCase())
  if (FF_OFFER_INBOX) list.add(FF_OFFER_INBOX.toLowerCase())
  if (pipeRecipients.include_broker_of_record && brokerage.broker_of_record_email) {
    list.add(brokerage.broker_of_record_email.toLowerCase())
  }
  for (const email of pipeRecipients.extra_emails) {
    if (email) list.add(email.toLowerCase())
  }
  return Array.from(list)
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

  const send = await sendOne({
    to: [FF_OFFER_INBOX],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })

  if (!send.ok) {
    return { deal_id: dealId, outcome: 'errored', recipients: [FF_OFFER_INBOX], error: send.error }
  }

  await supabase
    .from('deals')
    .update({ internal_alert_4h_at: new Date().toISOString() })
    .eq('id', dealId)

  return { deal_id: dealId, outcome: 'sent', recipients: [FF_OFFER_INBOX], provider_id: send.provider_id }
}
