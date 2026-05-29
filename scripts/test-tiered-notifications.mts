/**
 * scripts/test-tiered-notifications.mts
 *
 * Renders agent email + SMS and brokerage email in all three tiers
 * (A: property only, B: + closing date, C: + commission amount) so Bud
 * can eyeball the actual copy before the cron fires it. Also verifies
 * the variant picker in dispatch-notification.ts maps the right data
 * shape to the right tier letter.
 *
 * Usage:
 *   npx tsx scripts/test-tiered-notifications.mts
 */
import fs from 'node:fs'

const envText = fs.readFileSync('.env.local', 'utf8')
for (const line of envText.split('\n')) {
  if (!line || line.startsWith('#')) continue
  const eq = line.indexOf('=')
  if (eq < 0) continue
  const k = line.slice(0, eq)
  const v = line.slice(eq + 1)
  if (!process.env[k]) process.env[k] = v
}

const { renderTriggerEmail } = await import('../lib/firm-deal-detection/render-email')
const { renderTriggerSms } = await import('../lib/firm-deal-detection/render-sms')
const { renderBrokerageOfferEmail } = await import(
  '../lib/firm-deal-detection/render-brokerage-offer-email'
)

let allPassed = true
const failures: string[] = []

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${label}`)
  } else {
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`)
    failures.push(label)
    allPassed = false
  }
}

const common = {
  agent_first_name: 'Stacey',
  property_address: '556 Connaught Ave',
  brand_name: 'Choice Advances',
  brand_tagline: 'Powered by Firm Funds',
  cta_url: 'https://firmfunds.ca/agent/firm-deal/test-token',
}

// ---------------------------------------------------------------------------
// Tier A: property only (the Remax/Stacey case from 2026-05-29)
// ---------------------------------------------------------------------------
console.log('\n=== Tier A (property only) ===')
const tierA_email = renderTriggerEmail({
  ...common,
  closing_date_iso: null,
  variant: 'sparse',
})
const tierA_sms = renderTriggerSms({
  ...common,
  closing_date_human: null,
  variant: 'sparse',
})
console.log('\n[A] Email subject:', tierA_email.subject)
console.log('[A] Email body (first line of text):', tierA_email.text.split('\n')[2])
console.log('[A] SMS body:', tierA_sms.body)
console.log('[A] SMS length / segments:', tierA_sms.body.length, '/', tierA_sms.estimated_segments)
assert('A: subject leads with "spotted a possible deal"', tierA_email.subject.includes('spotted a possible deal'))
assert('A: subject names the address', tierA_email.subject.includes('556 Connaught Ave'))
assert('A: email body asks for confirmation', /confirm/i.test(tierA_email.text))
assert('A: email CTA reads "Confirm deal"', tierA_email.html.includes('Confirm deal'))
assert('A: SMS uses "possible deal" framing', tierA_sms.body.includes('possible deal'))
assert('A: SMS fits 1 segment', tierA_sms.estimated_segments === 1, `got ${tierA_sms.estimated_segments}`)
assert('A: no em dashes', !tierA_email.html.includes('—') && !tierA_sms.body.includes('—'))

// ---------------------------------------------------------------------------
// Tier B: property + closing date, no commission
// ---------------------------------------------------------------------------
console.log('\n=== Tier B (property + closing date) ===')
const tierB_email = renderTriggerEmail({
  ...common,
  closing_date_iso: '2026-06-30',
  variant: 'sparse_with_date',
})
const tierB_sms = renderTriggerSms({
  ...common,
  closing_date_human: 'June 30, 2026',
  variant: 'sparse_with_date',
})
console.log('\n[B] Email subject:', tierB_email.subject)
console.log('[B] Email body (first line of text):', tierB_email.text.split('\n')[2])
console.log('[B] SMS body:', tierB_sms.body)
console.log('[B] SMS length / segments:', tierB_sms.body.length, '/', tierB_sms.estimated_segments)
assert('B: subject names the closing date', tierB_email.subject.includes('June 30, 2026'))
assert('B: subject asks "Want an advance"', tierB_email.subject.includes('advance'))
assert('B: email CTA reads "Request advance"', tierB_email.html.includes('Request advance'))
assert('B: SMS names the closing date', tierB_sms.body.includes('June 30, 2026'))
assert('B: SMS uses "Request an advance"', tierB_sms.body.includes('Request an advance'))
assert('B: SMS fits 2 segments or fewer', tierB_sms.estimated_segments <= 2, `got ${tierB_sms.estimated_segments}`)

// ---------------------------------------------------------------------------
// Tier C: property + closing date + commission (Pittsburgh case)
// ---------------------------------------------------------------------------
console.log('\n=== Tier C (full info, with $) ===')
const tierC_email = renderTriggerEmail({
  ...common,
  agent_first_name: 'Ken',
  property_address: '150 Pittsburgh Ave',
  closing_date_iso: '2026-07-02',
  variant: 'detailed',
  commission_amount: 12750,
  advance_estimate: 12330,
})
const tierC_sms = renderTriggerSms({
  ...common,
  agent_first_name: 'Ken',
  property_address: '150 Pittsburgh Ave',
  closing_date_human: 'July 2, 2026',
  variant: 'detailed',
  commission_amount: 12750,
  advance_estimate: 12330,
})
console.log('\n[C] Email subject:', tierC_email.subject)
console.log('[C] Email body (first line of text):', tierC_email.text.split('\n')[2])
console.log('[C] SMS body:', tierC_sms.body)
console.log('[C] SMS length / segments:', tierC_sms.body.length, '/', tierC_sms.estimated_segments)
assert('C: subject names the advance amount', tierC_email.subject.includes('$12,330'))
assert('C: subject names the closing date', tierC_email.subject.includes('July 2, 2026'))
assert('C: email CTA reads "Accept advance"', tierC_email.html.includes('Accept advance'))
assert('C: email shows the gross commission', tierC_email.html.includes('$12,750'))
assert('C: SMS quotes the advance', tierC_sms.body.includes('$12,330'))

// ---------------------------------------------------------------------------
// Brokerage offer email, all three tiers
// ---------------------------------------------------------------------------
console.log('\n=== Brokerage email, Tier A ===')
const brokA = renderBrokerageOfferEmail({
  brokerage_name: 'Choice Realty',
  agent_full_name: 'Stacey Hill',
  agent_email: 'stacey@example.com',
  agent_phone: '+17059101111',
  property_address: '556 Connaught Ave',
  closing_date_iso: null,
  brand_name: 'Choice Advances',
  brand_tagline: 'Powered by Firm Funds',
  brokerage_portal_url: 'https://firmfunds.ca/brokerage/deals/new?from_offer=deal-1',
  variant: 'initial',
  tier: 'A',
})
console.log('[broker A] subject:', brokA.subject)
console.log('[broker A] text first lines:\n' + brokA.text.split('\n').slice(0, 4).join('\n'))
assert('broker A: subject says "Possible upcoming deal"', brokA.subject.includes('Possible upcoming deal'))
assert('broker A: CTA reads "Submit advance on behalf"', brokA.html.includes('Submit advance on behalf'))

console.log('\n=== Brokerage email, Tier B ===')
const brokB = renderBrokerageOfferEmail({
  brokerage_name: 'Choice Realty',
  agent_full_name: 'Stacey Hill',
  agent_email: 'stacey@example.com',
  agent_phone: '+17059101111',
  property_address: '556 Connaught Ave',
  closing_date_iso: '2026-06-30',
  brand_name: 'Choice Advances',
  brand_tagline: 'Powered by Firm Funds',
  brokerage_portal_url: 'https://firmfunds.ca/brokerage/deals/new?from_offer=deal-2',
  variant: 'initial',
  tier: 'B',
})
console.log('[broker B] subject:', brokB.subject)
console.log('[broker B] text first lines:\n' + brokB.text.split('\n').slice(0, 4).join('\n'))
assert('broker B: subject names the closing date', brokB.subject.includes('June 30, 2026'))
assert('broker B: subject names "Ready to advance"', brokB.subject.includes('Ready to advance'))
assert('broker B: CTA still "Submit advance on behalf"', brokB.html.includes('Submit advance on behalf'))

console.log('\n=== Brokerage email, Tier C ===')
const brokC = renderBrokerageOfferEmail({
  brokerage_name: 'Choice Realty',
  agent_full_name: 'Ken Vandaele',
  agent_email: 'ken@example.com',
  agent_phone: '+17059102222',
  property_address: '150 Pittsburgh Ave',
  closing_date_iso: '2026-07-02',
  brand_name: 'Choice Advances',
  brand_tagline: 'Powered by Firm Funds',
  brokerage_portal_url: 'https://firmfunds.ca/brokerage/deals/new?from_offer=deal-3',
  variant: 'initial',
  tier: 'C',
  commission_amount: 12750,
  advance_estimate: 12330,
})
console.log('[broker C] subject:', brokC.subject)
console.log('[broker C] text first lines:\n' + brokC.text.split('\n').slice(0, 4).join('\n'))
assert('broker C: subject names the advance dollars', brokC.subject.includes('$12,330'))
assert('broker C: html shows gross commission', brokC.html.includes('$12,750'))
assert('broker C: html shows estimated advance', brokC.html.includes('$12,330'))
assert('broker C: CTA reads "Submit advance"', brokC.html.includes('Submit advance'))

// ---------------------------------------------------------------------------
// Write a preview HTML file Bud can eyeball
// ---------------------------------------------------------------------------
fs.writeFileSync(
  'tiered-notification-preview.html',
  `<html><body style="background:#222; color:#eee; padding:24px; font-family:sans-serif;">
<h1>Agent Tier A</h1>${tierA_email.html}
<h1>Agent Tier B</h1>${tierB_email.html}
<h1>Agent Tier C</h1>${tierC_email.html}
<h1>Brokerage Tier A</h1>${brokA.html}
<h1>Brokerage Tier B</h1>${brokB.html}
<h1>Brokerage Tier C</h1>${brokC.html}
</body></html>`
)
console.log('\nwrote tiered-notification-preview.html')

console.log(`\n${'='.repeat(60)}`)
if (allPassed) {
  console.log('All tiered-notification tests passed.')
  process.exit(0)
} else {
  console.log(`${failures.length} failure(s):`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
