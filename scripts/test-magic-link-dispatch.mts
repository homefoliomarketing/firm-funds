/**
 * scripts/test-magic-link-dispatch.mts
 *
 * One-shot smoke test that proves the firm-deal magic link path works
 * end-to-end in production: insert a test event matched to Bud Jones,
 * temporarily attach Bud's real email + phone to the agent record, run
 * the dispatcher, then check that a firm_deal_magic_links row landed and
 * the cta_url Bud receives contains /agent/firm-deal/<token>.
 *
 * Leaves the test event + magic-link row in place so Bud can actually
 * click the link in his inbox and verify the consume path. Restores the
 * agent's email + phone to NULL when finished (test-safe state).
 *
 * Usage:
 *   npx tsx scripts/test-magic-link-dispatch.mts
 *
 * Cleanup (after Bud confirms the click works):
 *   npx tsx scripts/test-magic-link-dispatch.mts --cleanup <event-id>
 */
import fs from 'node:fs'

// Load .env.local so Resend / Twilio / Supabase keys are available.
const envText = fs.readFileSync('.env.local', 'utf8')
for (const line of envText.split('\n')) {
  if (!line || line.startsWith('#')) continue
  const eq = line.indexOf('=')
  if (eq < 0) continue
  const k = line.slice(0, eq)
  const v = line.slice(eq + 1)
  if (!process.env[k]) process.env[k] = v
}

const { createClient } = await import('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)

const BUD_AGENT_ID = 'ef1bd077-b7c2-44f7-b46f-e5d9df688fd6' // Bud Jones (Choice Realty)
const RYAN_AGENT_ID = '4d73fbfa-34fa-4601-a277-2e07ca274af4' // Ryan Dodd (currently holds Bud's contact info)
const BUD_EMAIL = 'budj_12@hotmail.com'
const BUD_PHONE = '705-542-1016'
const CHOICE_BROKERAGE_ID = 'd0d206a4-90e0-49b1-a472-18edd8f76f6c'

// --------------------------------------------------------------------------
// Cleanup mode
// --------------------------------------------------------------------------
const args = process.argv.slice(2)
const cleanupIdx = args.indexOf('--cleanup')
if (cleanupIdx >= 0) {
  const eventId = args[cleanupIdx + 1]
  if (!eventId) {
    console.error('Pass an event id: --cleanup <uuid>')
    process.exit(1)
  }
  console.log(`Cleaning up test event ${eventId}…`)
  const { error: linkErr } = await supabase
    .from('firm_deal_magic_links')
    .delete()
    .eq('firm_deal_event_id', eventId)
  if (linkErr) console.warn('magic-link delete:', linkErr.message)
  const { error: evtErr } = await supabase
    .from('firm_deal_events')
    .delete()
    .eq('id', eventId)
  if (evtErr) {
    console.error('event delete failed:', evtErr.message)
    process.exit(1)
  }
  // Move Bud's email/phone back to Ryan Dodd (where they were before the test).
  const { error: budErr } = await supabase
    .from('agents')
    .update({ email: null, phone: null })
    .eq('id', BUD_AGENT_ID)
  if (budErr) console.warn('Bud Jones restore:', budErr.message)
  const { error: ryanErr } = await supabase
    .from('agents')
    .update({ email: BUD_EMAIL, phone: BUD_PHONE })
    .eq('id', RYAN_AGENT_ID)
  if (ryanErr) console.warn('Ryan Dodd restore:', ryanErr.message)
  console.log('Cleanup complete. Bud Jones nulled; Ryan Dodd holds the test contact info again.')
  process.exit(0)
}

// --------------------------------------------------------------------------
// Dispatch test
// --------------------------------------------------------------------------
console.log('Step 1/5: Move Bud\'s email + phone from Ryan Dodd → Bud Jones (unique constraint forces sequencing)…')
{
  // Clear Ryan Dodd first so the unique index on agents.email doesn't reject
  // the next update.
  const { error: ryanErr } = await supabase
    .from('agents')
    .update({ email: null, phone: null })
    .eq('id', RYAN_AGENT_ID)
  if (ryanErr) throw new Error(`Ryan Dodd clear: ${ryanErr.message}`)

  const { error: budErr } = await supabase
    .from('agents')
    .update({ email: BUD_EMAIL, phone: BUD_PHONE })
    .eq('id', BUD_AGENT_ID)
  if (budErr) throw new Error(`Bud Jones set: ${budErr.message}`)
}

console.log('Step 2/5: Look up the active Choice Realty spreadsheet pipe…')
const { data: pipe, error: pipeErr } = await supabase
  .from('brokerage_pipes')
  .select('id')
  .eq('brokerage_id', CHOICE_BROKERAGE_ID)
  .eq('pipe_type', 'spreadsheet')
  .eq('enabled', true)
  .single()
if (pipeErr || !pipe) throw new Error(`pipe lookup: ${pipeErr?.message ?? 'no pipe'}`)

console.log('Step 3/5: Insert a fresh test event matched to Bud Jones, status=approved…')
const { data: inserted, error: insErr } = await supabase
  .from('firm_deal_events')
  .insert({
    brokerage_pipe_id: pipe.id,
    brokerage_id: CHOICE_BROKERAGE_ID,
    source: 'spreadsheet',
    raw_payload: { test_marker: 'magic-link-smoke-test' },
    parsed: {
      address: '321 Magic Link Lane (TEST)',
      closing_date_iso: '2026-08-30',
      mls_number: 'TEST-MAGIC-001',
      listing_agent_raw: 'Bud Jones',
      confidence: 'high',
    },
    parser_confidence: 'high',
    deal_hash: `magic_link_test_${Date.now()}`,
    status: 'approved',
    matched_agent_id: BUD_AGENT_ID,
    listing_matched_agent_id: BUD_AGENT_ID,
  })
  .select('id')
  .single()
if (insErr || !inserted) throw new Error(`event insert: ${insErr?.message ?? 'no row'}`)
const eventId = inserted.id as string
console.log(`  → inserted event id ${eventId}`)

console.log('Step 4/5: Run the dispatcher (sends real email + SMS via Resend + Twilio)…')
const { dispatchFirmDealNotification } = await import(
  '../lib/firm-deal-detection/dispatch-notification'
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import drops the SupabaseClient generic; runtime shape matches the dispatcher's expectation.
const result = await dispatchFirmDealNotification(eventId, supabase as any)
console.log('  Dispatch outcome:', JSON.stringify(result, null, 2))

console.log('Step 5/5: Check that the magic-link table got a row for this event…')
const { data: link, error: linkErr } = await supabase
  .from('firm_deal_magic_links')
  .select('token, expires_at, used_at')
  .eq('firm_deal_event_id', eventId)
  .maybeSingle()
if (linkErr) console.warn('  magic-link read:', linkErr.message)
if (!link) {
  console.error('  ❌ NO magic-link row was inserted — dispatcher fell back to the plain deep link.')
  console.error('  Cleanup: npx tsx scripts/test-magic-link-dispatch.mts --cleanup ' + eventId)
  process.exit(1)
}
const url = `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://firmfunds.ca'}/agent/firm-deal/${link.token}`
console.log(`  ✅ Magic link minted. URL embedded in the email+SMS:\n     ${url}`)
console.log(`  Token expires ${link.expires_at}`)
console.log(`\nWhat to do now:`)
console.log(`  1. Check ${BUD_EMAIL} for a "321 Magic Link Lane (TEST)" email.`)
console.log(`  2. Click the CTA from your phone with no Firm Funds session.`)
console.log(`  3. Confirm you land signed in on /agent?firm_deal=${eventId}.`)
console.log(`  4. When done, run: npx tsx scripts/test-magic-link-dispatch.mts --cleanup ${eventId}`)
