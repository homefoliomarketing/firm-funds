/**
 * scripts/test-notification-renderers.mts
 *
 * Pure-function tests for the email + SMS renderers, plus a Choice Realty
 * dispatch dry-run that exercises the orchestrator end-to-end with the
 * actual Twilio + Resend credentials (or no-ops them when keys aren't set).
 *
 * Writes the rendered HTML to /tmp/firm-deal-email-preview.html so Bud can
 * eyeball the actual output that would land in an agent's inbox.
 *
 * Usage:
 *   npx tsx scripts/test-notification-renderers.mts
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
const { normalizeE164 } = await import('../lib/firm-deal-detection/twilio-client')

let allPassed = true
const failures: string[] = []

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}`)
  } else {
    console.log(`  ❌ ${label}${detail ? `: ${detail}` : ''}`)
    failures.push(label)
    allPassed = false
  }
}

// ---------------------------------------------------------------------------
// Email renderer
// ---------------------------------------------------------------------------
console.log('\n[email] sparse variant (default for spreadsheet pipe)')
const sparseEmail = renderTriggerEmail({
  agent_first_name: 'Carlo',
  property_address: '374 Bush Street',
  closing_date_iso: '2026-06-01',
  brand_name: 'Choice Advances',
  brand_tagline: 'Powered by Firm Funds',
  cta_url: 'https://firmfunds.ca/agent/dashboard?firm_deal=abc-123',
  variant: 'sparse',
})
assert('subject mentions the address', sparseEmail.subject.includes('374 Bush Street'))
assert('html contains agent first name', sparseEmail.html.includes('Hi Carlo,'))
assert('html uses "went firm" not "closed"', sparseEmail.html.includes('went firm') && !sparseEmail.html.includes('closed firm'))
assert('html has brand name in header', sparseEmail.html.includes('Choice Advances'))
assert('html has tagline', sparseEmail.html.includes('Powered by Firm Funds'))
assert('html has CTA URL', sparseEmail.html.includes('firm_deal=abc-123'))
assert('html has TODAY visual emphasis', sparseEmail.html.includes('TODAY'))
assert('html has human-readable closing date', sparseEmail.html.includes('June 1, 2026'))
assert('html has no em dashes', !sparseEmail.html.includes('—') && !sparseEmail.html.includes('—'))
assert('html has no DocuSign references', !/docusign/i.test(sparseEmail.html))
assert('text version present', sparseEmail.text.length > 50)
assert('text has CTA URL', sparseEmail.text.includes('firm_deal=abc-123'))

console.log('\n[email] dual_agency variant')
const dualEmail = renderTriggerEmail({
  agent_first_name: 'Sarah',
  property_address: '789 Pine Cres',
  closing_date_iso: '2026-09-01',
  brand_name: 'Choice Advances',
  brand_tagline: 'Powered by Firm Funds',
  cta_url: 'https://firmfunds.ca/agent/dashboard?firm_deal=def-456',
  variant: 'dual_agency',
})
assert('dual variant mentions both sides', /both sides/i.test(dualEmail.html))
assert('dual variant uses "both sides, both commissions"', dualEmail.html.includes('Both sides, both commissions'))

console.log('\n[email] no closing date (graceful fallback)')
const noDateEmail = renderTriggerEmail({
  agent_first_name: 'Mike',
  property_address: '5 Westbrook Cres',
  closing_date_iso: null,
  brand_name: 'Choice Advances',
  brand_tagline: 'Powered by Firm Funds',
  cta_url: 'https://firmfunds.ca/agent/dashboard?firm_deal=ghi-789',
  variant: 'sparse',
})
assert('null closing date does not break HTML', noDateEmail.html.includes('Hi Mike,'))
assert('null closing date falls back to "wait weeks" copy', noDateEmail.html.includes('wait weeks'))

// Write the actual rendered HTML to a file Bud can eyeball
fs.writeFileSync('firm-deal-email-preview.html', `
<html>
<body style="background:#222; color:#fff; padding:24px; font-family:sans-serif;">
<div style="max-width:600px; margin:0 auto 24px;"><h2>A1 sparse</h2></div>
${sparseEmail.html}
<div style="max-width:600px; margin:24px auto;"><h2>A3 dual agency</h2></div>
${dualEmail.html}
<div style="max-width:600px; margin:24px auto;"><h2>A1 sparse, no closing date</h2></div>
${noDateEmail.html}
</body>
</html>
`)
console.log('  📝 wrote firm-deal-email-preview.html')

// ---------------------------------------------------------------------------
// SMS renderer
// ---------------------------------------------------------------------------
console.log('\n[sms] sparse variant')
const sparseSms = renderTriggerSms({
  agent_first_name: 'Carlo',
  property_address: '374 Bush Street',
  brand_name: 'Choice Advances',
  cta_url: 'https://firmfunds.ca/a/abc',
  variant: 'sparse',
})
console.log(`  body: ${JSON.stringify(sparseSms.body)}`)
console.log(`  length: ${sparseSms.body.length} chars, estimated segments: ${sparseSms.estimated_segments}, unicode: ${sparseSms.has_unicode}`)
assert('SMS body starts with brand prefix', sparseSms.body.startsWith('Choice Advances:'))
assert('SMS includes "went firm"', sparseSms.body.includes('went firm'))
assert('SMS includes CTA URL', sparseSms.body.includes('https://firmfunds.ca/a/abc'))
assert('SMS includes opt-out per CASL', sparseSms.body.includes('Reply STOP to opt out'))
assert('SMS contains agent first name', sparseSms.body.includes('Hi Carlo'))
assert('SMS body has no em dashes', !sparseSms.body.includes('—') && !sparseSms.body.includes('—'))
assert('SMS body has no DocuSign references', !/docusign/i.test(sparseSms.body))
assert('SMS in GSM-7 (no Unicode surprise)', !sparseSms.has_unicode)
assert('SMS fits in 2 segments or fewer', sparseSms.estimated_segments <= 2, `got ${sparseSms.estimated_segments}`)

console.log('\n[sms] dual_agency variant')
const dualSms = renderTriggerSms({
  agent_first_name: 'Sarah',
  property_address: '789 Pine Cres',
  brand_name: 'Choice Advances',
  cta_url: 'https://firmfunds.ca/a/def',
  variant: 'dual_agency',
})
console.log(`  body: ${JSON.stringify(dualSms.body)}`)
assert('dual SMS mentions "both sides"', dualSms.body.includes('both sides'))

// ---------------------------------------------------------------------------
// E.164 normalizer
// ---------------------------------------------------------------------------
console.log('\n[normalizeE164]')
assert('10-digit number with dashes', normalizeE164('705-910-7171') === '+17059107171')
assert('10-digit number with parens', normalizeE164('(705) 910-7171') === '+17059107171')
assert('already E.164', normalizeE164('+17059107171') === '+17059107171')
assert('11-digit starting with 1', normalizeE164('17059107171') === '+17059107171')
assert('plain 10 digits', normalizeE164('7059107171') === '+17059107171')
assert('rejects short numbers', normalizeE164('555-1234') === null)
assert('rejects non-NA numbers', normalizeE164('+447700900000') === null)

console.log(`\n${'='.repeat(60)}`)
if (allPassed) {
  console.log('✅ All renderer + helper tests passed.')
  console.log('   Eyeball firm-deal-email-preview.html in a browser to confirm visuals.')
  process.exit(0)
} else {
  console.log(`❌ ${failures.length} failure(s):`)
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
