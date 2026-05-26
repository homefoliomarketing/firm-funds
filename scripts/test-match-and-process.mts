/**
 * scripts/test-match-and-process.mts
 *
 * Plants synthetic firm_deal_events rows with status='new' representing
 * realistic Choice Realty patterns, then runs processFirmDealEvent on each
 * and asserts the recommended status + agent resolution.
 *
 * Cleans up after itself by deleting every event it created.
 *
 * Usage:
 *   npx tsx scripts/test-match-and-process.mts
 */
import fs from 'node:fs'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const envText = fs.readFileSync('.env.local', 'utf8')
for (const line of envText.split('\n')) {
  if (!line || line.startsWith('#')) continue
  const eq = line.indexOf('=')
  if (eq < 0) continue
  const k = line.slice(0, eq)
  const v = line.slice(eq + 1)
  if (!process.env[k]) process.env[k] = v
}

const { processFirmDealEvent } = await import('../lib/firm-deal-detection/process-event')

const supabase = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const CHOICE_REALTY_BROKERAGE_ID = 'd0d206a4-90e0-49b1-a472-18edd8f76f6c'

// Need the pipe id
const { data: pipes } = await supabase
  .from('brokerage_pipes')
  .select('id')
  .eq('brokerage_id', CHOICE_REALTY_BROKERAGE_ID)
  .eq('pipe_type', 'spreadsheet')
  .eq('enabled', true)
  .limit(1)
if (!pipes || pipes.length === 0) {
  console.error('No pipe found; run seed-choice-realty-pipe.mjs first')
  process.exit(1)
}
const PIPE_ID = pipes[0].id

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

interface TestCase {
  name: string
  listing: string
  selling: string
  expected_outcome: 'awaiting_approval' | 'unmatched' | 'rejected' | 'duplicate'
  expected_targets_min?: number   // minimum number of matched_agent_ids expected
  expected_first_agent_first_name?: string  // sanity check the first matched agent
  plant_duplicate_first?: boolean  // pre-insert another row with the same deal_hash to test dedup
}

const cases: TestCase[] = [
  {
    name: 'Clean in-office same-side (Carlo + Kyle) -> awaiting_approval',
    listing: 'Carlo',
    selling: 'Kyle',
    expected_outcome: 'awaiting_approval',
    expected_targets_min: 2,
  },
  {
    name: '"Bill M" unique-by-initial (Bill Montague) + Royal outside -> awaiting_approval',
    listing: 'Bill M',
    selling: 'Royal',
    expected_outcome: 'unmatched',  // Royal is unknown -> unresolved -> review queue
  },
  {
    name: 'Bare "Bill" ambiguous across 3 Bills -> unmatched',
    listing: 'Bill',
    selling: 'Carlo',
    expected_outcome: 'unmatched',
  },
  {
    name: 'Two unknowns (Exit listing + Patricia selling, no Patricia at brokerage) -> unmatched',
    listing: 'Exit',
    selling: 'Patricia',
    expected_outcome: 'unmatched',
  },
  {
    name: 'In-office agent + empty -> awaiting_approval',
    listing: 'Carlo',
    selling: '',
    expected_outcome: 'unmatched',  // empty side counts as cleared, but Carlo's there
    // wait, an empty side is 'empty' kind, not 'unresolved'. matchEvent says
    // hasUnclearSide is only for ambiguous/unresolved. So empty + matched
    // -> recommended_status = awaiting_approval. Let me re-read...
  },
  {
    name: 'Dedup case: same deal_hash already exists -> duplicate',
    listing: 'Carlo',
    selling: 'Kyle',
    expected_outcome: 'duplicate',
    plant_duplicate_first: true,
  },
]

// Re-check matchEvent semantics: an "empty" side is NOT in hasUnclearSide,
// so matched + empty -> awaiting_approval. Fix the expectation:
cases[4].expected_outcome = 'awaiting_approval'
cases[4].expected_targets_min = 1
cases[4].expected_first_agent_first_name = 'Carlo'

const plantedEventIds: string[] = []

function buildRow(listing: string, selling: string): string[] {
  // A B C D E F G H I J K L M N
  return [
    `${Math.floor(Math.random() * 9000) + 1000} Test Street`,
    `SM${Math.floor(Math.random() * 900000) + 100000}`,
    '1000',
    '15-May',
    'EFT',
    listing,
    selling,
    'Y',
    'Y',
    '',
    '15-Jun',
    '',
    '',
    '',
  ]
}

function dealHashFor(addr: string, closing: string): string {
  const normalizedAddr = addr.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return crypto.createHash('sha256').update(`${normalizedAddr}|${closing.toLowerCase()}|`).digest('hex')
}

async function plantEvent(row: string[]): Promise<string> {
  const addr = row[0]
  const closingCell = row[10]
  const closingIso = `2026-06-${closingCell.split('-')[0].padStart(2, '0')}`
  const dealHash = dealHashFor(addr, closingIso)

  const { data, error } = await supabase
    .from('firm_deal_events')
    .insert({
      brokerage_pipe_id: PIPE_ID,
      brokerage_id: CHOICE_REALTY_BROKERAGE_ID,
      source: 'spreadsheet',
      raw_payload: {
        row,
        source_tab: 'June 2026',
        column_mapping: COL_MAP,
        trigger: 'moved_from_conditional',
      },
      parsed: {},
      deal_hash: dealHash,
      status: 'new',
    })
    .select('id')
    .single()

  if (error || !data) throw new Error(`Failed to plant event: ${error?.message}`)
  plantedEventIds.push(data.id)
  return data.id
}

async function plantDuplicateAlreadyProcessed(row: string[]): Promise<void> {
  const addr = row[0]
  const closingCell = row[10]
  const closingIso = `2026-06-${closingCell.split('-')[0].padStart(2, '0')}`
  const dealHash = dealHashFor(addr, closingIso)

  const { data, error } = await supabase
    .from('firm_deal_events')
    .insert({
      brokerage_pipe_id: PIPE_ID,
      brokerage_id: CHOICE_REALTY_BROKERAGE_ID,
      source: 'spreadsheet',
      raw_payload: { row, source_tab: 'June 2026', column_mapping: COL_MAP },
      parsed: { confidence: 'high' },
      parser_confidence: 'high',
      deal_hash: dealHash,
      status: 'unmatched',  // already processed
      processed_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error || !data) throw new Error(`Failed to plant duplicate: ${error?.message}`)
  plantedEventIds.push(data.id)
}

try {
  let allPassed = true
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]
    console.log(`\n[Case ${i + 1}] ${tc.name}`)
    const row = buildRow(tc.listing, tc.selling)

    if (tc.plant_duplicate_first) {
      await plantDuplicateAlreadyProcessed(row)
    }
    const eventId = await plantEvent(row)

    const result = await processFirmDealEvent(eventId, supabase)

    console.log(`  outcome: ${result.outcome}`)
    if (result.match) {
      const summarize = (s: typeof result.match.listing) =>
        `${s.kind}${s.kind === 'agent' ? ` (id=${s.agent_id?.slice(0, 8)}...)` : ''}${s.source ? ` via ${s.source}` : ''}`
      console.log(`  listing: ${summarize(result.match.listing)}`)
      console.log(`  selling: ${summarize(result.match.selling)}`)
      console.log(`  target_agent_ids: ${result.match.target_agent_ids.length}`)
    }
    if (result.message) console.log(`  message: ${result.message}`)

    const errs: string[] = []
    if (result.outcome !== tc.expected_outcome) {
      errs.push(`outcome: expected "${tc.expected_outcome}", got "${result.outcome}"`)
    }
    if (tc.expected_targets_min != null && result.match) {
      if (result.match.target_agent_ids.length < tc.expected_targets_min) {
        errs.push(`expected at least ${tc.expected_targets_min} target agent(s), got ${result.match.target_agent_ids.length}`)
      }
    }
    if (tc.expected_first_agent_first_name && result.match?.target_agent_ids[0]) {
      const { data: agent } = await supabase
        .from('agents')
        .select('first_name')
        .eq('id', result.match.target_agent_ids[0])
        .single()
      if (agent?.first_name !== tc.expected_first_agent_first_name) {
        errs.push(`first matched agent: expected ${tc.expected_first_agent_first_name}, got ${agent?.first_name}`)
      }
    }

    if (errs.length === 0) {
      console.log(`  ✅ PASS`)
    } else {
      console.log(`  ❌ FAIL:`)
      for (const e of errs) console.log(`    - ${e}`)
      allPassed = false
    }
  }

  console.log(`\n${allPassed ? '✅ All cases passed.' : '❌ One or more cases failed.'}`)
  process.exit(allPassed ? 0 : 1)
} finally {
  // Cleanup
  if (plantedEventIds.length > 0) {
    await supabase.from('firm_deal_events').delete().in('id', plantedEventIds)
    console.log(`\nCleanup: deleted ${plantedEventIds.length} synthetic event(s).`)
  }
}
