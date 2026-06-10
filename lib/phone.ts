/**
 * Phone number helpers — one canonical home for normalization and display.
 *
 * We store phone numbers in E.164 (`+1XXXXXXXXXX`) so the SMS path
 * (`lib/firm-deal-detection/twilio-client.ts`) and the rest of the app agree on
 * a single format. Users, however, should be able to type a number however they
 * like — "(416) 555-1234", "416-555-1234", "4165551234" all work. Normalize on
 * the way in, format on the way out.
 */

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

/**
 * Format a stored phone number for display, e.g. "+17059107171" -> "(705) 910-7171".
 * Falls back to returning the input unchanged if it can't be parsed (so legacy
 * rows in odd formats still render something rather than blanking out).
 */
export function formatPhoneForDisplay(value: string | null | undefined): string {
  if (!value) return ''
  const digits = value.replace(/[^\d]/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (ten.length === 10) {
    return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
  }
  return value
}

/** Friendly, consistent validation message used everywhere a phone is rejected. */
export const PHONE_VALIDATION_MESSAGE =
  'Enter a valid 10-digit phone number, e.g. (416) 555-1234.'
