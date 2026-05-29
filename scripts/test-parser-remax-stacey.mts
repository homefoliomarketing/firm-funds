/**
 * scripts/test-parser-remax-stacey.mts
 *
 * Repro the EXACT raw_payload from the live Remax/Stacey firm_deal_events
 * row (id 226cf461-fbd3-4507-96db-d3be4e773449) that triggered Bud's report
 * on 2026-05-29: "the system did not pull any commission info into our list
 * and the email that was fired out had no commission information".
 *
 * Investigation conclusion:
 *   - The row only has 11 cells (indices 0 to 10). Columns O (14) and P (15)
 *     are unmapped because Google Sheets trimmed trailing empty cells.
 *   - The pipe DOES map listing_agent_commission and selling_agent_commission
 *     so the parser tries to extract from O / P; both come back empty so
 *     both _amount fields are null.
 *   - Nothing in the parser is broken. The row genuinely has no commission
 *     data yet.
 *   - The fix is on the NOTIFICATION side (tier the copy by what's known),
 *     covered in scripts/test-tiered-notifications.mts. This script just
 *     pins the parser behavior so a future regression in the parser can't
 *     silently start fabricating values for this kind of row.
 *
 * Usage:
 *   npx tsx scripts/test-parser-remax-stacey.mts
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

const { parseFirmDealEvent } = await import('../lib/firm-deal-detection/parse-event')

// EXACT raw_payload from the live event in production
const payload = {
  row: [
    '556 Connaught Ave',
    'SM261139',
    5000,
    '',
    '',
    'Remax',
    'Stacey',
    '',
    '',
    '23-June',
    '30-June',
  ] as unknown as string[],
  source_tab: 'June 2026',
  trigger: 'direct_to_month',
  column_mapping: {
    mls: 'B',
    notes: 'N',
    address: 'A',
    closing_date: 'K',
    deposit_date: 'D',
    listing_agent: 'F',
    selling_agent: 'G',
    deposit_amount: 'C',
    payment_method: 'E',
    // The pipe DOES configure these columns. They just happen to be empty
    // on this particular row (Sheets trims trailing empty cells).
    listing_agent_commission: 'O',
    selling_agent_commission: 'P',
  },
}

const result = await parseFirmDealEvent(payload, { today: '2026-05-29' })
console.log('parsed:', JSON.stringify(result.parsed, null, 2))

const checks: [string, boolean][] = [
  ['address resolves', result.parsed.address === '556 Connaught Ave'],
  ['mls resolves', result.parsed.mls_number === 'SM261139'],
  ['listing agent kept verbatim', result.parsed.listing_agent_raw === 'Remax'],
  ['selling agent kept verbatim', result.parsed.selling_agent_raw === 'Stacey'],
  ['closing date resolves to 2026-06-30', result.parsed.closing_date_iso === '2026-06-30'],
  ['no fabricated listing commission', result.parsed.listing_agent_commission_amount === null],
  ['no fabricated selling commission', result.parsed.selling_agent_commission_amount === null],
]

let allOk = true
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) allOk = false
}
console.log(allOk ? '\nPARSER OK on Remax/Stacey row' : '\nFAIL')
process.exit(allOk ? 0 : 1)
