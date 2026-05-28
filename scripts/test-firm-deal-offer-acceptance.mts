/**
 * scripts/test-firm-deal-offer-acceptance.mts
 *
 * Smoke test for the brokerage-side post-acceptance flow (migration 081 +
 * dispatch-brokerage-offer.ts). Inserts a test firm_deal_events row matched
 * to Bud Jones (Choice Realty), then drives the acceptance path manually:
 *
 *   1. Insert an 'offered' deals row pointing at the test event.
 *      (Mirrors what acceptFirmDealOffer does, without needing a logged-in
 *      browser session — we're testing the dispatcher half here.)
 *   2. Fire sendBrokerageOfferNotification.
 *   3. Verify the email rendered + delivered.
 *   4. Optionally fire the 2h nudge + 4h escalation paths so we can eyeball
 *      both email templates.
 *
 * Leaves the test rows in place so Bud can verify the rendered email and
 * the brokerage dashboard banner. Cleanup mode (`--cleanup <deal-id>`)
 * removes the test deal + event + magic link.
 *
 * IMPORTANT: This script writes a real `deals` row in status='offered',
 * which means it will appear on the brokerage dashboard until cleanup.
 * Run --cleanup after you've eyeballed everything.
 *
 * Usage:
 *   npx tsx scripts/test-firm-deal-offer-acceptance.mts
 *   npx tsx scripts/test-firm-deal-offer-acceptance.mts --nudges
 *   npx tsx scripts/test-firm-deal-offer-acceptance.mts --cleanup <deal-id>
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

const { createClient } = await import('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)

const BUD_AGENT_ID = 'ef1bd077-b7c2-44f7-b46f-e5d9df688fd6'
const CHOICE_BROKERAGE_ID = 'd0d206a4-90e0-49b1-a472-18edd8f76f6c'
const TEST_CLOSING = '2026-09-15'
const TEST_ADDRESS = '742 Offer Acceptance Way (TEST)'

const args = process.argv.slice(2)
const cleanupIdx = args.indexOf('--cleanup')
const runNudges = args.includes('--nudges')

// --------------------------------------------------------------------------
// Cleanup mode
// --------------------------------------------------------------------------
if (cleanupIdx >= 0) {
  const dealId = args[cleanupIdx + 1]
  if (!dealId) {
    console.error('Pass a deal id: --cleanup <uuid>')
    process.exit(1)
  }
  const { data: deal } = await supabase
    .from('deals')
    .select('id, offered_event_id')
    .eq('id', dealId)
    .maybeSingle()
  if (!deal) {
    console.error('Deal not found:', dealId)
    process.exit(1)
  }
  console.log(`Deleting test deal ${dealId}…`)
  const { error: delDealErr } = await supabase.from('deals').delete().eq('id', dealId)
  if (delDealErr) console.warn('deal delete:', delDealErr.message)
  if (deal.offered_event_id) {
    await supabase.from('firm_deal_magic_links').delete().eq('firm_deal_event_id', deal.offered_event_id)
    const { error: delEvtErr } = await supabase.from('firm_deal_events').delete().eq('id', deal.offered_event_id)
    if (delEvtErr) console.warn('event delete:', delEvtErr.message)
  }
  console.log('Cleanup complete.')
  process.exit(0)
}

// --------------------------------------------------------------------------
// Run the test
// --------------------------------------------------------------------------
console.log('Step 1/5: Look up active Choice Realty spreadsheet pipe…')
const { data: pipe, error: pipeErr } = await supabase
  .from('brokerage_pipes')
  .select('id')
  .eq('brokerage_id', CHOICE_BROKERAGE_ID)
  .eq('pipe_type', 'spreadsheet')
  .eq('enabled', true)
  .single()
if (pipeErr || !pipe) throw new Error(`pipe lookup: ${pipeErr?.message ?? 'no pipe'}`)

console.log('Step 2/5: Insert test firm_deal_events row matched to Bud Jones, status=offer_sent…')
const { data: event, error: evtErr } = await supabase
  .from('firm_deal_events')
  .insert({
    brokerage_pipe_id: pipe.id,
    brokerage_id: CHOICE_BROKERAGE_ID,
    source: 'spreadsheet',
    raw_payload: { test_marker: 'offer-acceptance-smoke-test' },
    parsed: {
      address: TEST_ADDRESS,
      closing_date_iso: TEST_CLOSING,
      mls_number: 'TEST-OFFER-ACCEPT',
      listing_agent_raw: 'Bud Jones',
      confidence: 'high',
    },
    parser_confidence: 'high',
    deal_hash: `offer_accept_test_${Date.now()}`,
    status: 'offer_sent',
    matched_agent_id: BUD_AGENT_ID,
    email_sent_at: new Date().toISOString(),
  })
  .select('id')
  .single()
if (evtErr || !event) throw new Error(`event insert: ${evtErr?.message ?? 'no row'}`)
const eventId = event.id as string
console.log(`  → event ${eventId}`)

console.log('Step 3/5: Insert offered deals row (mimicking acceptFirmDealOffer)…')
const nowIso = new Date().toISOString()
const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) + 'T00:00:00Z').getTime()
const closingMs = new Date(TEST_CLOSING + 'T00:00:00Z').getTime()
const daysUntilClosing = Math.max(0, Math.ceil((closingMs - today) / (1000 * 60 * 60 * 24)))
const { data: deal, error: dealErr } = await supabase
  .from('deals')
  .insert({
    agent_id: BUD_AGENT_ID,
    brokerage_id: CHOICE_BROKERAGE_ID,
    status: 'offered',
    property_address: TEST_ADDRESS,
    closing_date: TEST_CLOSING,
    gross_commission: 0,
    brokerage_split_pct: 0,
    net_commission: 0,
    days_until_closing: daysUntilClosing,
    discount_fee: 0,
    advance_amount: 0,
    brokerage_referral_fee: 0,
    amount_due_from_brokerage: 0,
    source: 'firm_deal_offer',
    payment_status: 'not_applicable',
    offered_at: nowIso,
    offered_event_id: eventId,
  })
  .select('id')
  .single()
if (dealErr || !deal) throw new Error(`deal insert: ${dealErr?.message ?? 'no row'}`)
const dealId = deal.id as string
console.log(`  → deal ${dealId}`)

// Back-link the event so the agent banner's "already accepted" state
// works in case Bud refreshes the agent dashboard during testing.
await supabase
  .from('firm_deal_events')
  .update({ offer_deal_id: dealId })
  .eq('id', eventId)

console.log('Step 4/5: Fire the brokerage notification (initial)…')
const { sendBrokerageOfferNotification, sendBrokerageOfferNudge2h, sendInternalEscalation4h } = await import(
  '../lib/firm-deal-detection/dispatch-brokerage-offer'
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import drops the SupabaseClient generic; runtime shape matches the dispatcher's expectation.
const initial = await sendBrokerageOfferNotification(supabase as any, dealId)
console.log('  Initial outcome:', JSON.stringify(initial, null, 2))

if (runNudges) {
  console.log('Step 4b: Fire the 2-hour nudge…')
  // Temporarily back-date brokerage_notified_at so the nudge path doesn't
  // refuse to send; the actual cron checks elapsed time too, but the
  // function itself doesn't.
  await supabase
    .from('deals')
    .update({ brokerage_notified_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })
    .eq('id', dealId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import drops the SupabaseClient generic; runtime shape matches the dispatcher's expectation.
  const nudge = await sendBrokerageOfferNudge2h(supabase as any, dealId)
  console.log('  Nudge outcome:', JSON.stringify(nudge, null, 2))

  console.log('Step 4c: Fire the 4-hour internal escalation…')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import drops the SupabaseClient generic; runtime shape matches the dispatcher's expectation.
  const escalate = await sendInternalEscalation4h(supabase as any, dealId)
  console.log('  Escalation outcome:', JSON.stringify(escalate, null, 2))
}

console.log('Step 5/5: Verify the deal row stamps lined up…')
const { data: finalDeal } = await supabase
  .from('deals')
  .select('id, status, offered_at, brokerage_notified_at, brokerage_nudge_2h_at, internal_alert_4h_at')
  .eq('id', dealId)
  .single()
console.log('  Deal state:', JSON.stringify(finalDeal, null, 2))

console.log(`\nWhat to check now:`)
console.log(`  1. Brokerage's notification inbox for emails about "${TEST_ADDRESS}".`)
console.log(`  2. Log in as a brokerage admin (bud@firmfunds.ca won't work, that's super-admin).`)
console.log(`     The Choice Realty dashboard should show this deal in the "agents waiting" banner.`)
console.log(`  3. Log in as an agent on Bud Jones's seat — "Your Deals" should show "Offered" badge.`)
console.log(`\nCleanup when done:`)
console.log(`  npx tsx scripts/test-firm-deal-offer-acceptance.mts --cleanup ${dealId}`)
