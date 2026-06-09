/**
 * lib/firm-deal-detection/offer-launch.ts
 *
 * White-label link-preview ("unfurl") support for firm-deal offer links.
 *
 * The SMS / email sends https://firmfunds.ca/agent/firm-deal/<token>. When a
 * messaging app renders that link it fetches the URL and reads its Open Graph
 * <meta> tags to draw the preview card. The route handler serves the HTML this
 * module builds: the card shows the BROKERAGE's white-label brand (name +
 * their logo) plus the deal's dollar figure, instead of generic Firm Funds.
 *
 * Two audiences hit the same URL:
 *   - Preview crawlers (iMessage, Google Messages/RCS, WhatsApp, etc.) read the
 *     <meta> tags and stop. They never run the inline script, so they never
 *     consume the magic link.
 *   - Real humans run the nonce'd inline script and are forwarded to ?go=1,
 *     which is the existing sign-in + dashboard redirect. A "View my offer"
 *     button is the no-JS fallback.
 *
 * The magic-link token is intentionally multi-use (see magic-link.ts), so a
 * crawler fetching the URL is harmless either way.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  pickAgentVariant,
  formatClosingDateHuman,
  type FirmDealEventForVariant,
} from './offer-estimate'

export interface OfferBranding {
  /** White-label brand, e.g. "Choice Advances". Defaults to "Firm Funds". */
  brandName: string
  /** Public PNG card image (the brokerage logo). Null falls back to FF icon. */
  ogImageUrl: string | null
  /** Property address shorthand, e.g. "125 Pozzebon". */
  address: string
  variant: 'sparse' | 'sparse_with_date' | 'dual_agency' | 'detailed'
  /** Pre-split advance estimate, formatted (e.g. "$6,234"), or null. Matches
   *  the figure in the SMS/email for this same agent + event. */
  advanceMoney: string | null
  closingDateHuman: string | null
}

/** SMS-style money: no decimals, $-prefixed, comma-grouped. Mirrors
 *  render-sms.ts formatMoneyShort so the card matches the text message. */
function formatMoneyShort(amount: number | null | undefined): string | null {
  if (amount == null || !Number.isFinite(amount)) return null
  return '$' + Math.round(amount).toLocaleString('en-CA')
}

/**
 * Resolve the white-label branding + deal details for an offer token. Read-only
 * and best-effort: returns null on any miss so the route can still serve a
 * generic-but-valid preview (and the real validation happens on ?go=1). Does
 * NOT consume the token.
 */
export async function resolveFirmDealOfferBranding(
  supabase: SupabaseClient,
  token: string
): Promise<OfferBranding | null> {
  if (!token || typeof token !== 'string') return null

  const { data: link } = await supabase
    .from('firm_deal_magic_links')
    .select('firm_deal_event_id, agent_id')
    .eq('token', token)
    .maybeSingle()
  if (!link) return null

  const { data: event } = await supabase
    .from('firm_deal_events')
    .select(`
      id, brokerage_id, brokerage_pipe_id, parsed,
      matched_agent_id, second_matched_agent_id,
      listing_matched_agent_id, selling_matched_agent_id,
      co_agent_split
    `)
    .eq('id', link.firm_deal_event_id)
    .maybeSingle()
  if (!event) return null

  const [{ data: pipe }, { data: brokerage }] = await Promise.all([
    supabase.from('brokerage_pipes').select('brand_name').eq('id', event.brokerage_pipe_id).maybeSingle(),
    supabase.from('brokerages').select('og_image_url').eq('id', event.brokerage_id).maybeSingle(),
  ])

  const parsed = (event.parsed ?? null) as { address?: string | null; closing_date_iso?: string | null } | null
  const address = (parsed?.address && String(parsed.address).trim()) || 'your recent deal'

  const { variant, advance_estimate } = pickAgentVariant(
    link.agent_id,
    event as unknown as FirmDealEventForVariant
  )

  return {
    brandName: pipe?.brand_name || 'Firm Funds',
    ogImageUrl: brokerage?.og_image_url ?? null,
    address,
    variant,
    advanceMoney: formatMoneyShort(advance_estimate),
    closingDateHuman: formatClosingDateHuman(parsed?.closing_date_iso ?? null),
  }
}

/**
 * Card copy: title (bold line) carries the brand + property; description
 * carries the dollar figure + reassurance. Mirrors the SMS voice rules:
 * "went firm" (never "closed firm"), no em dashes, no DocuSign, no timing
 * promises beyond the approved "today" framing.
 */
export function buildOfferCard(branding: OfferBranding): { title: string; description: string } {
  const brand = branding.brandName
  const addr = branding.address
  const money = branding.advanceMoney

  if (branding.variant === 'detailed' && money) {
    return {
      title: `${brand}: get paid on your ${addr} deal`,
      description: `Your deal went firm. About ${money} could be yours today, before brokerage splits. Tap to view your offer.`,
    }
  }
  if (branding.variant === 'dual_agency') {
    return {
      title: `${brand}: get paid on your ${addr} deal`,
      description: `Your deal went firm (both sides). Get paid today instead of waiting for closing. Tap to view your offer.`,
    }
  }
  if (branding.variant === 'sparse_with_date' && branding.closingDateHuman) {
    return {
      title: `${brand}: get paid on your ${addr} deal`,
      description: `Your deal closes ${branding.closingDateHuman}. Request an advance and get paid before closing. Tap to view your offer.`,
    }
  }
  if (branding.variant === 'sparse') {
    return {
      title: `${brand}: a possible deal for you`,
      description: `We spotted a possible deal at ${addr}. Tap to confirm the details and see what you could get today.`,
    }
  }
  return {
    title: `${brand}: your commission advance offer`,
    description: `Your deal went firm. Tap to view your offer and get paid before closing.`,
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface OfferLaunchHtmlArgs {
  branding: OfferBranding | null
  /** App origin, e.g. https://firmfunds.ca (used for the og:image fallback). */
  appUrl: string
  /** Where humans are forwarded to finish sign-in (the existing ?go=1 path). */
  goUrl: string
  /** Canonical public URL of this offer link (og:url). */
  canonicalUrl: string
  /** Per-request CSP nonce from proxy.ts (x-nonce header). */
  nonce: string
}

/**
 * Build the full HTML document served on a bare GET of the offer link.
 */
export function renderOfferLaunchHtml(args: OfferLaunchHtmlArgs): string {
  const { branding, appUrl, goUrl, canonicalUrl, nonce } = args
  const brand = branding?.brandName || 'Firm Funds'
  const card = branding
    ? buildOfferCard(branding)
    : {
        title: `${brand}: your commission advance offer`,
        description: 'Tap to view your offer and get paid before closing.',
      }
  const ogImageRaw = branding?.ogImageUrl || `${appUrl.replace(/\/$/, '')}/apple-touch-icon.png`

  const title = escapeHtml(card.title)
  const desc = escapeHtml(card.description)
  const img = escapeHtml(ogImageRaw)
  const canon = escapeHtml(canonicalUrl)
  const goAttr = escapeHtml(goUrl)
  const brandEsc = escapeHtml(brand)
  const moneyLine = branding?.advanceMoney
    ? escapeHtml(`About ${branding.advanceMoney} could be yours today.`)
    : ''
  const logoTag = branding?.ogImageUrl
    ? `<img class="logo" src="${img}" alt="${brandEsc}">`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${brandEsc}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${img}">
<meta property="og:url" content="${canon}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${img}">
<style>
  html,body{margin:0;height:100%}
  body{background:#0b1220;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100%}
  .card{max-width:420px;padding:40px 28px;text-align:center}
  .logo{max-width:280px;max-height:150px;width:auto;height:auto;margin:0 auto 28px;display:block}
  h1{font-size:18px;font-weight:600;color:#fff;margin:0 0 8px}
  p{font-size:15px;line-height:1.5;color:#9ca3af;margin:0 0 24px}
  .money{color:#5FA873;font-weight:600}
  .btn{display:inline-block;background:#5FA873;color:#04210f;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px}
  .spin{margin:22px auto 0;width:22px;height:22px;border:3px solid rgba(255,255,255,.18);border-top-color:#5FA873;border-radius:50%;animation:s 0.8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
  <main class="card">
    ${logoTag}
    <h1>Opening your offer&hellip;</h1>
    <p>${moneyLine ? `<span class="money">${moneyLine}</span> ` : ''}Hang tight, we are signing you in.</p>
    <a class="btn" href="${goAttr}">View my offer</a>
    <div class="spin" aria-hidden="true"></div>
  </main>
  <script nonce="${escapeHtml(nonce)}">
    // Humans run this and get forwarded to the real sign-in + dashboard
    // redirect. Link-preview crawlers do not execute JS, so they only read the
    // Open Graph tags above and never consume the one-time login link.
    window.location.replace(${JSON.stringify(goUrl)});
  </script>
</body>
</html>`
}
