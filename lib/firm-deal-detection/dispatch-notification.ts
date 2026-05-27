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
  email: { status: string; provider_id?: string; error?: string }
  sms: { status: string; provider_id?: string; error?: string }
  message?: string
}

interface DispatchContext {
  event: {
    id: string
    brokerage_id: string
    brokerage_pipe_id: string
    parsed: ParsedFirmDeal | null
    matched_agent_id: string | null
    second_matched_agent_id: string | null
    status: string
    email_sent_at: string | null
    sms_sent_at: string | null
  }
  pipe: {
    brand_name: string
    brand_tagline: string
  }
  primary_agent: {
    id: string
    first_name: string | null
    email: string | null
    phone: string | null
  }
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
  // Load full event with joined pipe + agent
  const { data: event, error: eventErr } = await supabase
    .from('firm_deal_events')
    .select('id, brokerage_id, brokerage_pipe_id, parsed, matched_agent_id, second_matched_agent_id, status, email_sent_at, sms_sent_at')
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

  const [{ data: pipe, error: pipeErr }, { data: agent, error: agentErr }] = await Promise.all([
    supabase
      .from('brokerage_pipes')
      .select('brand_name, brand_tagline')
      .eq('id', event.brokerage_pipe_id)
      .single(),
    supabase
      .from('agents')
      .select('id, first_name, email, phone')
      .eq('id', event.matched_agent_id)
      .single(),
  ])

  if (pipeErr || !pipe) return errorResult(eventId, `Pipe load failed: ${pipeErr?.message}`, supabase)
  if (agentErr || !agent) return errorResult(eventId, `Agent load failed: ${agentErr?.message}`, supabase)

  const ctx: DispatchContext = {
    event: event as DispatchContext['event'],
    pipe: {
      brand_name: pipe.brand_name ?? 'Firm Funds',
      brand_tagline: pipe.brand_tagline ?? 'Powered by Firm Funds',
    },
    primary_agent: agent,
  }

  return await dispatchWithContext(ctx, supabase)
}

async function dispatchWithContext(
  ctx: DispatchContext,
  supabase: SupabaseClient
): Promise<DispatchResult> {
  const parsed = ctx.event.parsed
  const variant: 'sparse' | 'dual_agency' =
    ctx.event.second_matched_agent_id && ctx.event.second_matched_agent_id === ctx.event.matched_agent_id
      ? 'dual_agency'
      : 'sparse'

  const propertyAddress = parsed?.address || 'your recent deal'

  // Mint a one-shot magic-link token so the agent does not hit the login
  // wall on a phone they haven't logged in to in months. The token carries
  // the firm_deal_event_id forward and expires in 7 days. If minting fails
  // (DB hiccup), we fall back to a plain deep link so dispatch still sends.
  // The agent will just hit /login if their session is gone.
  //
  // Observability: a single mint failure is benign (the deep-link fallback
  // works for already-signed-in agents on desktop). A FLOOD of mint
  // failures means firm_deal_magic_links is broken — RLS misconfigured
  // (migration 091 hardens this), unique-index conflict, the magic_link
  // module throwing on Supabase admin API errors, etc. We log to console
  // AND write an audit_log row with severity='warning' so the admin audit
  // feed flags repeated failures during ops review. A future metrics
  // integration (Sentry, Datadog) should also bump a counter here so a
  // dashboard alert can fire before the audit log fills up.
  let cta_url = `${APP_URL.replace(/\/$/, '')}/agent?firm_deal=${encodeURIComponent(ctx.event.id)}`
  try {
    const { token } = await mintFirmDealMagicLink(supabase, {
      firm_deal_event_id: ctx.event.id,
      agent_id: ctx.primary_agent.id,
    })
    cta_url = `${APP_URL.replace(/\/$/, '')}/agent/firm-deal/${token}`
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    console.warn(
      '[dispatch] mintFirmDealMagicLink failed, falling back to deep link:',
      errMessage
    )
    // Best-effort audit log. logAuditEventServiceRole already swallows its
    // own errors so it can't disrupt the dispatch path. We still wrap in
    // try/catch to be defensive — a flood of failures here mustn't poison
    // every dispatch.
    try {
      await logAuditEventServiceRole({
        action: 'firm_deal.magic_link_mint_failed',
        entityType: 'firm_deal_event',
        entityId: ctx.event.id,
        severity: 'warning',
        metadata: {
          event_id: ctx.event.id,
          agent_id: ctx.primary_agent.id,
          error: errMessage,
        },
      })
    } catch (auditErr) {
      console.warn(
        '[dispatch] audit log of magic-link mint failure also failed:',
        auditErr instanceof Error ? auditErr.message : auditErr
      )
    }
    // TODO(metrics): bump a counter like
    //   metrics.increment('firm_deal.magic_link_mint_failures', 1, { error: errMessage })
    // once Sentry / Datadog / OTel is wired up. A spike here should page.
  }

  // Render both
  const email = renderTriggerEmail({
    agent_first_name: ctx.primary_agent.first_name ?? '',
    property_address: propertyAddress,
    closing_date_iso: parsed?.closing_date_iso ?? null,
    brand_name: ctx.pipe.brand_name,
    brand_tagline: ctx.pipe.brand_tagline,
    cta_url,
    variant,
  })
  const sms = renderTriggerSms({
    agent_first_name: ctx.primary_agent.first_name ?? '',
    property_address: propertyAddress,
    brand_name: ctx.pipe.brand_name,
    cta_url,
    variant,
  })

  // Dispatch in parallel
  const [emailResult, smsResult] = await Promise.all([
    sendEmail(ctx.primary_agent.email, email),
    ctx.primary_agent.phone
      ? sendSms({ to: ctx.primary_agent.phone, body: sms.body })
      : Promise.resolve({ status: 'skipped_no_phone' as const, message_sid: undefined, error: undefined }),
  ])

  const emailSent = emailResult.status === 'sent'
  const smsSent = smsResult.status === 'sent'
  const anySent = emailSent || smsSent

  // Persist outcome
  const updateFields: Record<string, unknown> = {}
  if (emailSent) updateFields.email_sent_at = new Date().toISOString()
  if (smsSent) updateFields.sms_sent_at = new Date().toISOString()
  const newStatus = anySent ? 'offer_sent' : 'errored'
  updateFields.status = newStatus
  if (!anySent) {
    updateFields.error_message =
      `Both channels failed. email=${emailResult.status} ${emailResult.error ?? ''}; ` +
      `sms=${smsResult.status} ${smsResult.error ?? ''}`
  }
  // Soft transition guard — see process-event.ts FIRM_DEAL_EVENT_TRANSITIONS.
  if (!isValidFirmDealEventTransition(ctx.event.status, newStatus)) {
    console.warn(
      `[firm_deal_events] invalid status transition: ${ctx.event.status} -> ${newStatus} ` +
        `(at dispatchWithContext). This is allowed for now but will become an error.`
    )
  }
  await supabase.from('firm_deal_events').update(updateFields).eq('id', ctx.event.id)

  return {
    event_id: ctx.event.id,
    outcome: anySent ? 'offer_sent' : 'errored',
    email: {
      status: emailResult.status,
      provider_id: emailResult.message_sid,
      error: emailResult.error,
    },
    sms: {
      status: smsResult.status,
      provider_id: smsResult.message_sid,
      error: smsResult.error,
    },
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
