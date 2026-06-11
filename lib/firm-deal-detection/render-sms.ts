/**
 * lib/firm-deal-detection/render-sms.ts
 *
 * Short branded SMS for the firm-deal trigger.
 *
 * CASL + Twilio rules:
 *   - Brand prefix at the start of every message
 *   - "Reply STOP to opt out" at the end (CASL + carrier expectations).
 *     Twilio handles the actual STOP keyword automatically.
 *   - Keep under 160 characters when possible to stay in 1 segment
 *     (each segment is ~$0.013 on a Canadian long code).
 *
 * Voice constraints (from CLAUDE.md):
 *   - "went firm" never "closed firm"
 *   - No em dashes
 *   - No DocuSign references, no timing promises
 *   - White-label brand prefix
 */

export interface SmsRenderInput {
  agent_first_name: string
  property_address: string
  brand_name: string
  cta_url: string
  /** Optional human-readable closing date (e.g. "June 30, 2026"). Only used
   *  by variant='sparse_with_date'. */
  closing_date_human?: string | null
  /** Optional ISO closing date ("YYYY-MM-DD"). The 'detailed' two-option line
   *  formats this to a short "Aug 13" to keep the SMS tight. */
  closing_date_iso?: string | null
  variant: 'sparse' | 'sparse_with_date' | 'dual_agency' | 'detailed'
  /** Gross commission for this agent's side, pre-split. Only used by
   *  variant='detailed'. */
  commission_amount?: number | null
  /** Estimated pre-split advance. Same calculation as the email so both
   *  channels quote the same number. Only used by variant='detailed'. */
  advance_estimate?: number | null
}

export interface RenderedSms {
  body: string
  /** Estimated SMS segments (160 chars for plain GSM-7, 70 chars if Unicode). */
  estimated_segments: number
  /** True if message contains non-GSM-7 characters that force 70-char segments. */
  has_unicode: boolean
}

// GSM-7 default alphabet (basic). If any character falls outside this set,
// the message is encoded as UCS-2 and segments are 70 chars instead of 160.
// This is a conservative check; we don't include the GSM-7 extension table.
const GSM7 = new Set([
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r',
  'Å', 'å', 'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ',
  ' ', '!', '"', '#', '¤', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  ':', ';', '<', '=', '>', '?',
  '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'Ä', 'Ö', 'Ñ', 'Ü', '§',
  '¿',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'ä', 'ö', 'ñ', 'ü', 'à',
])

function isGsm7(body: string): boolean {
  for (const ch of body) {
    if (!GSM7.has(ch)) return false
  }
  return true
}

function estimateSegments(body: string): { segments: number; has_unicode: boolean } {
  const has_unicode = !isGsm7(body)
  // Multi-part SMS uses UDH and segments are 153 chars (GSM-7) or 67 chars (UCS-2)
  // but for our usage where we want to stay 1-segment, we treat the simple cap.
  if (has_unicode) {
    return { has_unicode: true, segments: Math.max(1, Math.ceil(body.length / 70)) }
  }
  return { has_unicode: false, segments: Math.max(1, Math.ceil(body.length / 160)) }
}

function formatMoneyShort(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return ''
  // SMS-friendly money formatter: no decimals, $-prefixed, comma-grouped.
  // Plain ASCII so we stay in GSM-7 (single segment).
  const rounded = Math.round(amount)
  return '$' + rounded.toLocaleString('en-CA')
}

// "2026-08-13" -> "Aug 13". Short on purpose: the detailed SMS already quotes
// two dollar figures + a URL, so we keep the date abbreviated to save segments.
function formatShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[parseInt(m[2], 10) - 1]
  if (!month) return null
  return `${month} ${parseInt(m[3], 10)}`
}

export function renderTriggerSms(input: SmsRenderInput): RenderedSms {
  const first = input.agent_first_name || 'there'
  const address = input.property_address || 'your recent deal'

  // Keep it under 160 chars; the CTA URL eats ~30 chars on its own.
  // Brand prefix is brokerage-specific; some brands are longer than others
  // so we don't pad excessively here.
  let intro: string
  if (input.variant === 'dual_agency') {
    intro = `Hi ${first}, your deal at ${address} went firm (both sides). Get paid today instead of waiting:`
  } else if (
    input.variant === 'detailed' &&
    input.commission_amount &&
    input.commission_amount > 0 &&
    input.advance_estimate &&
    input.advance_estimate > 0
  ) {
    // Tier C: outline BOTH money options so the agent sees the choice, the
    // same way the email does: the gross commission at closing vs the pre-split
    // advance today. Two figures + a short date push this past 160 chars (2
    // segments), which is fine for a firm-deal offer worth thousands.
    //
    // "about" instead of "~" because the tilde isn't in basic GSM-7 and forces
    // the message into UCS-2 (70-char segments instead of 160). "before splits"
    // is the required disclosure and covers both figures.
    const advance = formatMoneyShort(input.advance_estimate)
    const commission = formatMoneyShort(input.commission_amount)
    const shortDate = formatShortDate(input.closing_date_iso)
    intro = shortDate
      ? `Hi ${first}, your ${address} deal went firm. Take ${commission} at closing (${shortDate}) or about ${advance} today, before splits:`
      : `Hi ${first}, your ${address} deal went firm. Take ${commission} at closing or about ${advance} today, before splits:`
  } else if (input.variant === 'sparse_with_date' && input.closing_date_human) {
    // Tier B: timing is confirmed but no dollar figure. Frame the same choice
    // without numbers: wait for closing, or get paid today.
    intro = `Hi ${first}, your deal at ${address} closes ${input.closing_date_human}. Get paid then, or get paid today:`
  } else if (input.variant === 'sparse') {
    // Tier A: we may have only loosely matched. Ask the agent to confirm.
    // Kept short so the brand prefix + CTA URL still leave room for the
    // body to land in a single 160-char SMS segment.
    intro = `Hi ${first}, possible deal at ${address}. Confirm:`
  } else {
    intro = `Hi ${first}, your deal at ${address} went firm. Get paid today instead of waiting:`
  }

  const body = `${input.brand_name}: ${intro} ${input.cta_url}\nReply STOP to opt out.`
  const { segments, has_unicode } = estimateSegments(body)
  return { body, estimated_segments: segments, has_unicode }
}
