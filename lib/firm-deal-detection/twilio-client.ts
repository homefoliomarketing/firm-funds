/**
 * lib/firm-deal-detection/twilio-client.ts
 *
 * Lazy singleton Twilio client authenticated via API Key + Secret
 * (firmfunds-sms) rather than the master Account SID + Auth Token, so the
 * key is independently revocable. The wrapper degrades gracefully when
 * credentials are absent (dev environments): sendSms() returns a no-op
 * result, log shows it was skipped.
 */
import twilio, { type Twilio } from 'twilio'

let _client: Twilio | null = null

interface TwilioConfig {
  client: Twilio
  fromNumber: string
}

function tryInit(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const keySid = process.env.TWILIO_API_KEY_SID
  const keySecret = process.env.TWILIO_API_KEY_SECRET
  const fromNumber = process.env.TWILIO_PHONE_NUMBER
  if (!accountSid || !keySid || !keySecret || !fromNumber) {
    return null
  }
  if (!_client) {
    _client = twilio(keySid, keySecret, { accountSid })
  }
  return { client: _client, fromNumber }
}

export interface SendSmsParams {
  to: string
  body: string
}

export interface SendSmsResult {
  status: 'sent' | 'skipped_no_credentials' | 'skipped_no_phone' | 'errored'
  message_sid?: string
  error?: string
}

/** Send one SMS via Twilio. Validates `to` is a Canadian/North American E.164 number. */
export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  if (!params.to) {
    return { status: 'skipped_no_phone' }
  }
  const config = tryInit()
  if (!config) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[twilio] credentials missing in production')
      return { status: 'errored', error: 'TWILIO credentials not configured' }
    }
    console.warn('[twilio] credentials missing - SMS skipped (dev only)')
    return { status: 'skipped_no_credentials' }
  }

  const to = normalizeE164(params.to)
  if (!to) {
    return { status: 'errored', error: `Invalid phone number: ${params.to}` }
  }

  try {
    const msg = await config.client.messages.create({
      from: config.fromNumber,
      to,
      body: params.body,
    })
    return { status: 'sent', message_sid: msg.sid }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown twilio error'
    return { status: 'errored', error: message }
  }
}

/**
 * Best-effort conversion to E.164. Accepts:
 *   "705-910-7171"          -> "+17059107171"
 *   "(705) 910-7171"        -> "+17059107171"
 *   "+17059107171"          -> "+17059107171"
 *   "17059107171"           -> "+17059107171"
 *   "7059107171"            -> "+17059107171"
 * Returns null when the input doesn't look like a Canadian/US 10-digit number.
 */
export function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '')
  if (digits.length === 10) return '+1' + digits
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits
  return null
}
