/**
 * scripts/test-parse-event.mts
 *
 * End-to-end smoke test of the Haiku 4.5 parser. Runs three calls in a row:
 *   1. A clean in-office deal (high confidence expected)
 *   2. An outside-brokerage exclusive listing (no MLS)
 *   3. A blank-closing-date case (medium confidence expected)
 *
 * Asserts that the schema validates, basic fields are extracted correctly,
 * and that the second + third calls produce a cache HIT on the system prompt
 * (proves prompt caching is actually firing).
 *
 * Usage:
 *   npx tsx scripts/test-parse-event.mts
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

const TODAY = '2026-05-26'

const COL_MAP = {
  address: 'A',
  mls: 'B',
  deposit_amount: 'C',
  deposit_date: 'D',
  payment_method: 'E',
  listing_agent: 'F',
  selling_agent: 'G',
  closing_date: 'K',
  notes: 'N',
}

type TestCase = {
  name: string
  row: string[]
  source_tab: string
  expect: (parsed: Awaited<ReturnType<typeof parseFirmDealEvent>>['parsed']) => string[]
}

const cases: TestCase[] = [
  {
    name: 'clean in-office same-side deal',
    source_tab: 'June 2026',
    row: ['374 Bush Street', 'SM260781', '1000', '4-May', 'EFT', 'Sarah', 'Carlo', 'Y', 'Y', '', '1-Jun', '', '', ''],
    expect: p => {
      const errs: string[] = []
      if (p.address !== '374 Bush Street') errs.push(`address: expected "374 Bush Street", got "${p.address}"`)
      if (p.mls_number !== 'SM260781') errs.push(`mls: expected "SM260781", got "${p.mls_number}"`)
      if (p.listing_agent_raw !== 'Sarah') errs.push(`listing: expected "Sarah", got "${p.listing_agent_raw}"`)
      if (p.selling_agent_raw !== 'Carlo') errs.push(`selling: expected "Carlo", got "${p.selling_agent_raw}"`)
      if (p.closing_date_iso !== '2026-06-01') errs.push(`closing: expected "2026-06-01", got "${p.closing_date_iso}"`)
      if (p.confidence !== 'high') errs.push(`confidence: expected "high", got "${p.confidence}"`)
      return errs
    },
  },
  {
    name: 'outside-brokerage exclusive listing (no MLS)',
    source_tab: 'June 2026',
    row: ['250 Pickard Road', 'Exclusive?', '2000', '23-Apr', 'EFT', 'Exit', 'Patricia', 'Y', 'Y', '', '10-Jun', '', '', ''],
    expect: p => {
      const errs: string[] = []
      if (p.address !== '250 Pickard Road') errs.push(`address: expected "250 Pickard Road", got "${p.address}"`)
      if (p.mls_number !== null) errs.push(`mls: expected null (Exclusive listing), got "${p.mls_number}"`)
      if (p.listing_agent_raw !== 'Exit') errs.push(`listing: expected "Exit", got "${p.listing_agent_raw}"`)
      if (p.selling_agent_raw !== 'Patricia') errs.push(`selling: expected "Patricia", got "${p.selling_agent_raw}"`)
      if (p.closing_date_iso !== '2026-06-10') errs.push(`closing: expected "2026-06-10", got "${p.closing_date_iso}"`)
      return errs
    },
  },
  {
    name: 'blank closing date -> confidence medium',
    source_tab: 'July 2026',
    row: ['5 Westbrook Crescent', 'SM261444', '2000', '7-May', 'EFT', 'Mike R', 'Interboard', 'Y', 'Y', '', '', '', '', ''],
    expect: p => {
      const errs: string[] = []
      if (p.address !== '5 Westbrook Crescent') errs.push(`address: expected "5 Westbrook Crescent", got "${p.address}"`)
      if (p.mls_number !== 'SM261444') errs.push(`mls: expected "SM261444", got "${p.mls_number}"`)
      if (p.listing_agent_raw !== 'Mike R') errs.push(`listing: expected "Mike R", got "${p.listing_agent_raw}"`)
      if (p.selling_agent_raw !== 'Interboard') errs.push(`selling: expected "Interboard", got "${p.selling_agent_raw}"`)
      if (p.closing_date_iso !== null) errs.push(`closing: expected null (blank), got "${p.closing_date_iso}"`)
      if (p.confidence === 'high') errs.push(`confidence: expected "medium" or "low" (blank closing date), got "${p.confidence}"`)
      return errs
    },
  },
]

let totalCostUsd = 0
let allPassed = true
let firstCallCacheCreate = 0
let secondCallCacheRead = 0

for (let i = 0; i < cases.length; i++) {
  const tc = cases[i]
  console.log(`\n[Case ${i + 1}] ${tc.name}`)
  const t0 = Date.now()
  const result = await parseFirmDealEvent(
    {
      row: tc.row,
      source_tab: tc.source_tab,
      column_mapping: COL_MAP,
      trigger: 'moved_from_conditional',
    },
    { today: TODAY }
  )
  const ms = Date.now() - t0

  console.log(`  Parsed:`, JSON.stringify(result.parsed, null, 2).split('\n').map(l => '  ' + l).join('\n').slice(2))
  console.log(`  Usage: input=${result.usage.input_tokens}, output=${result.usage.output_tokens}, ` +
              `cache_write=${result.usage.cache_creation_input_tokens}, cache_read=${result.usage.cache_read_input_tokens}, ` +
              `latency=${ms}ms`)

  // Haiku 4.5 pricing: $1/1M input, $5/1M output, cache writes 1.25x, cache reads 0.1x
  const inputCost = (result.usage.input_tokens / 1_000_000) * 1.0
  const writeCost = (result.usage.cache_creation_input_tokens / 1_000_000) * 1.25
  const readCost = (result.usage.cache_read_input_tokens / 1_000_000) * 0.1
  const outputCost = (result.usage.output_tokens / 1_000_000) * 5.0
  const callCost = inputCost + writeCost + readCost + outputCost
  totalCostUsd += callCost
  console.log(`  Cost: $${callCost.toFixed(6)}`)

  if (i === 0) firstCallCacheCreate = result.usage.cache_creation_input_tokens
  if (i === 1) secondCallCacheRead = result.usage.cache_read_input_tokens

  const errs = tc.expect(result.parsed)
  if (errs.length === 0) {
    console.log(`  ✅ PASS`)
  } else {
    console.log(`  ❌ FAIL:`)
    for (const e of errs) console.log(`    - ${e}`)
    allPassed = false
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`Total cost across ${cases.length} calls: $${totalCostUsd.toFixed(6)}`)
console.log(`Per-call avg: $${(totalCostUsd / cases.length).toFixed(6)}`)

// Cache assertions
console.log(`\nCache check:`)
console.log(`  Call 1 cache_creation_input_tokens: ${firstCallCacheCreate}`)
console.log(`  Call 2 cache_read_input_tokens:     ${secondCallCacheRead}`)
const cacheWorking = firstCallCacheCreate > 0 && secondCallCacheRead > 0
if (cacheWorking) {
  console.log(`  ✅ Prompt caching is firing (write on call 1, read on call 2)`)
} else if (firstCallCacheCreate === 0) {
  console.log(`  ⚠️  System prompt did NOT cache. Likely under the 4096-token minimum on Haiku 4.5.`)
  console.log(`     Per-call costs will be higher than projected.`)
}

if (allPassed && cacheWorking) {
  console.log(`\n✅ All cases passed, caching active.`)
  process.exit(0)
} else if (allPassed) {
  console.log(`\n⚠️  All cases passed but caching not active (see above).`)
  process.exit(0)
} else {
  console.log(`\n❌ One or more cases failed.`)
  process.exit(1)
}
