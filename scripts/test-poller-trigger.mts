/**
 * scripts/test-poller-trigger.mts
 *
 * Synthetic verification of the "moved from Conditional" trigger. Takes one
 * row currently in a month tab, rewrites last_poll_state.tab_by_hash so that
 * row's prior tab is "Conditional", re-runs the poll, and asserts exactly
 * one firm_deal_events row is inserted for the rewired hash.
 *
 * Rolls the last_poll_state back to baseline after the test so subsequent
 * polls see a clean state.
 *
 * Usage:
 *   npx tsx scripts/test-poller-trigger.mts
 */
import fs from 'node:fs'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

const envText = fs.readFileSync('.env.local', 'utf8')
for (const line of envText.split('\n')) {
  if (!line || line.startsWith('#')) continue
  const eq = line.indexOf('=')
  if (eq < 0) continue
  const k = line.slice(0, eq)
  const v = line.slice(eq + 1)
  if (!process.env[k]) process.env[k] = v
}

const { pollSpreadsheetPipe } = await import('../lib/firm-deal-detection/poll-spreadsheet')

const supabase = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const { data: pipes } = await supabase
  .from('brokerage_pipes')
  .select('id, brokerage_id, pipe_type, config, last_poll_state')
  .eq('pipe_type', 'spreadsheet')
  .eq('enabled', true)
  .limit(1)

if (!pipes || pipes.length === 0) {
  console.error('No enabled pipes')
  process.exit(1)
}
const pipe = pipes[0]
const baseline = pipe.last_poll_state as { tab_by_hash: Record<string, string> } | null
if (!baseline?.tab_by_hash) {
  console.error('Pipe has no baseline state; run test-firm-deal-poller.mts first')
  process.exit(1)
}

// Pick the first hash that is currently in a month tab (not Conditional)
const conditionalTab = (pipe.config as { conditional_tab: string }).conditional_tab
const candidate = Object.entries(baseline.tab_by_hash).find(
  ([, tab]) => tab !== conditionalTab
)
if (!candidate) {
  console.error('No row found in a month tab to rewire')
  process.exit(1)
}
const [hashToRewire, originalTab] = candidate
console.log(`Rewiring ${hashToRewire}: pretending it was in "${conditionalTab}" before (actually in "${originalTab}" now)`)

// Patch state in the DB so the next poll thinks this row "moved out of Conditional"
const patchedState = {
  ...baseline,
  tab_by_hash: { ...baseline.tab_by_hash, [hashToRewire]: conditionalTab },
}
await supabase.from('brokerage_pipes').update({ last_poll_state: patchedState }).eq('id', pipe.id)

// Reload pipe with patched state
const { data: reloaded } = await supabase
  .from('brokerage_pipes')
  .select('id, brokerage_id, pipe_type, config, last_poll_state')
  .eq('id', pipe.id)
  .single()

// Snapshot existing event count for this pipe so we can diff after
const { count: countBefore } = await supabase
  .from('firm_deal_events')
  .select('*', { count: 'exact', head: true })
  .eq('brokerage_pipe_id', pipe.id)

console.log(`Events before poll: ${countBefore}`)

const result = await pollSpreadsheetPipe(
  {
    id: reloaded!.id,
    brokerage_id: reloaded!.brokerage_id,
    pipe_type: reloaded!.pipe_type as 'spreadsheet',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: reloaded!.config as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    last_poll_state: reloaded!.last_poll_state as any,
  },
  supabase
)
console.log('Poll result:', JSON.stringify(result, null, 2))

const { data: newEvents, count: countAfter } = await supabase
  .from('firm_deal_events')
  .select('*', { count: 'exact' })
  .eq('brokerage_pipe_id', pipe.id)
  .order('received_at', { ascending: false })
  .limit(3)

console.log(`Events after poll: ${countAfter}`)
console.log('Most recent event raw_payload:')
console.log(JSON.stringify(newEvents?.[0]?.raw_payload, null, 2))

// Cleanup: rollback the synthetic event so we don't leave junk in firm_deal_events
if (newEvents?.[0]) {
  await supabase.from('firm_deal_events').delete().eq('id', newEvents[0].id)
  console.log(`Cleanup: deleted synthetic event ${newEvents[0].id}`)
}

// Re-poll to restore a clean baseline (current state without the rewire)
const result2 = await pollSpreadsheetPipe(
  {
    id: reloaded!.id,
    brokerage_id: reloaded!.brokerage_id,
    pipe_type: reloaded!.pipe_type as 'spreadsheet',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: reloaded!.config as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    last_poll_state: null as any, // force first_poll behavior to wipe to a clean baseline
  },
  supabase
)
console.log(`Cleanup poll restored baseline (first_poll=${result2.first_poll}, errors=${result2.errors.length})`)

// Assertions
const expectedNewEvents = 1
const actualNewEvents = (countAfter ?? 0) - (countBefore ?? 0)
if (actualNewEvents === expectedNewEvents && result.rows_new_firm === expectedNewEvents) {
  console.log('\n✅ PASS: trigger fired exactly once for the rewired row')
  process.exit(0)
} else {
  console.error(`\n❌ FAIL: expected ${expectedNewEvents} new event, got ${actualNewEvents} (rows_new_firm=${result.rows_new_firm})`)
  process.exit(1)
}
