/**
 * scripts/preview-firm-deal-email.mts
 *
 * Renders the firm-deal trigger email (render-email.ts) to static HTML files so
 * the payment-choice redesign can be eyeballed in a browser, and dumps every
 * SMS variant + its segment count to the console.
 *
 * Run:  NEXT_PUBLIC_SITE_URL=http://localhost:8770 npx tsx scripts/preview-firm-deal-email.mts
 * Out:  public/firm-deal-<slug>.html  (+ public/firm-deal-index.html)
 *
 * renderTriggerEmail / renderTriggerSms are pure string builders (no Resend, no
 * DB, no server-only imports), so they load fine under plain tsx.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderTriggerEmail } from '../lib/firm-deal-detection/render-email'
import { renderTriggerSms } from '../lib/firm-deal-detection/render-sms'

// Exact production formula (offer-estimate.ts). Inlined to keep this script's
// import graph free of server-only modules.
const RATE_PER_1000_PER_DAY = 0.8
const DEFAULT_SETTLEMENT_DAYS = 7
function estimateAdvanceFromGross(gross: number, daysUntilClosing: number): number {
  if (!Number.isFinite(gross) || gross <= 0) return 0
  const effectiveDays = Math.max(1, Math.floor(daysUntilClosing))
  const discountFee = gross * (RATE_PER_1000_PER_DAY / 1000) * effectiveDays
  const settlementFee = gross * (RATE_PER_1000_PER_DAY / 1000) * DEFAULT_SETTLEMENT_DAYS
  return Math.max(0, Math.round(gross - discountFee - settlementFee))
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'public')
const ORIGIN = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:8770'

const GENERATED_LOGO = {
  brand_logo_url: `${ORIGIN}/sample-choice-logo.svg`,
  brand_logo_includes_tagline: true,
}

const common = {
  agent_first_name: 'Ken',
  property_address: '150 Pittsburgh Ave, Toronto',
  brand_name: 'Choice Advances',
  brand_tagline: 'Powered by Firm Funds',
  cta_url: `${ORIGIN}/agent/firm-deal/sample-token-7f3a91c4e0`,
}

const commission = 12750
const closingIso = '2026-08-13'
const days = 63 // ~Jun 11 -> Aug 13
const advance = estimateAdvanceFromGross(commission, days)

console.log(`commission=$${commission}  days=${days}  advance(today)=$${advance}  gap=$${commission - advance}`)
console.log()

type Preview = { slug: string; title: string; html: string }
const previews: Preview[] = [
  {
    slug: 'detailed-logo',
    title: 'Tier C / detailed — payment chooser (generated logo header)',
    html: renderTriggerEmail({
      ...common,
      ...GENERATED_LOGO,
      closing_date_iso: closingIso,
      variant: 'detailed',
      commission_amount: commission,
      advance_estimate: advance,
    }).html,
  },
  {
    slug: 'detailed-textbanner',
    title: 'Tier C / detailed — payment chooser (no logo, green text banner)',
    html: renderTriggerEmail({
      ...common,
      closing_date_iso: closingIso,
      variant: 'detailed',
      commission_amount: commission,
      advance_estimate: advance,
    }).html,
  },
  {
    slug: 'sparse-with-date',
    title: 'Tier B / sparse_with_date — closing date, no commission',
    html: renderTriggerEmail({
      ...common,
      ...GENERATED_LOGO,
      closing_date_iso: closingIso,
      variant: 'sparse_with_date',
    }).html,
  },
  {
    slug: 'dual-agency',
    title: 'Dual agency — both sides',
    html: renderTriggerEmail({
      ...common,
      ...GENERATED_LOGO,
      closing_date_iso: closingIso,
      variant: 'dual_agency',
    }).html,
  },
  {
    slug: 'sparse',
    title: 'Tier A / sparse — address only',
    html: renderTriggerEmail({
      ...common,
      ...GENERATED_LOGO,
      closing_date_iso: null,
      variant: 'sparse',
    }).html,
  },
]

for (const p of previews) {
  writeFileSync(join(outDir, `firm-deal-${p.slug}.html`), p.html, 'utf8')
}

const index = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Firm-deal email previews</title>
<style>
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background:#0A0A0A; color:#D6D6D4; padding:48px 32px; max-width:720px; margin:0 auto; }
  h1 { color:#F5F5F4; font-size:24px; letter-spacing:-0.02em; }
  a { color:#D6D6D4; display:block; padding:10px 14px; font-size:15px; text-decoration:none; border:1px solid #2A2A2A; border-radius:10px; margin:8px 0; background:#161616; }
  a:hover { border-color:#5FA873; color:#F5F5F4; }
</style></head><body>
<h1>Firm-deal email previews</h1>
${previews.map((p) => `<a href="firm-deal-${p.slug}.html">${p.title}</a>`).join('\n')}
</body></html>`
writeFileSync(join(outDir, 'firm-deal-index.html'), index, 'utf8')

// ---- SMS dump ----
const smsCases: { label: string; input: Parameters<typeof renderTriggerSms>[0] }[] = [
  {
    label: 'detailed (Tier C)',
    input: {
      ...common,
      closing_date_iso: closingIso,
      closing_date_human: 'August 13, 2026',
      variant: 'detailed',
      commission_amount: commission,
      advance_estimate: advance,
    },
  },
  {
    label: 'sparse_with_date (Tier B)',
    input: { ...common, closing_date_human: 'August 13, 2026', variant: 'sparse_with_date' },
  },
  {
    label: 'dual_agency',
    input: { ...common, variant: 'dual_agency' },
  },
  {
    label: 'sparse (Tier A)',
    input: { ...common, variant: 'sparse' },
  },
]

console.log('================ SMS ================')
for (const c of smsCases) {
  const r = renderTriggerSms(c.input)
  console.log(`\n--- ${c.label} ---  (${r.body.length} chars, ${r.estimated_segments} segment(s), unicode=${r.has_unicode})`)
  console.log(r.body)
}
console.log(`\nWrote ${previews.length} email previews + index to ${outDir}`)
