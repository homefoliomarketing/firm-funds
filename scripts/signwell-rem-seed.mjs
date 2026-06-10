// Seed a fake FAILED deal + a pending remediation_deals record for the
// Remediation IDP dress rehearsal. Reuses the tagged dress-rehearsal brokerage
// + Pat Testerson. Prints the remediation_deal_id to feed signwell-rem-send.mts.
//
// Usage: node scripts/signwell-rem-seed.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const TAG = '[SIGNWELL DRESS REHEARSAL]'
const BROKER_EMAIL = 'homefoliomarketing+broker@gmail.com'

const conn = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '')
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } })
await client.connect()
const round2 = (n) => Math.round(n * 100) / 100

const brokerage = (await client.query(`SELECT * FROM brokerages WHERE notes = $1 ORDER BY created_at LIMIT 1`, [TAG])).rows[0]
if (!brokerage) { console.error('No dress-rehearsal brokerage found. Run signwell-dress-seed.mjs first.'); process.exit(1) }
const agent = (await client.query(`SELECT * FROM agents WHERE brokerage_id = $1 ORDER BY created_at LIMIT 1`, [brokerage.id])).rows[0]
if (!agent) { console.error('No agent found for the test brokerage.'); process.exit(1) }

const insert = async (table, obj, returning = 'id') => {
  const cols = Object.keys(obj)
  const r = await client.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${returning}`,
    Object.values(obj))
  return r.rows[0]
}

// --- a FAILED deal (the original obligation the IDP is curing) ---------------
const gross = 12000, split = 15, days = 30, settle = 7
const net = round2(gross * 0.85)
const discount_fee = round2(net * 0.0008 * days)
const settlement_period_fee = round2(net * 0.0008 * settle)
const advance = round2(net - discount_fee - settlement_period_fee)
const fundingDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)
const closingDate = new Date(Date.now() - 25 * 86400000).toISOString().slice(0, 10)
const failedAt = new Date(Date.now() - 20 * 86400000)

const failed = await insert('deals', {
  agent_id: agent.id, brokerage_id: brokerage.id, status: 'failed_to_close',
  property_address: '[DRESS REHEARSAL] 14 Fell-Through Cres, Sault Ste. Marie, Ontario, P6A 3C3',
  closing_date: closingDate, funding_date: fundingDate, days_until_closing: days,
  gross_commission: gross, brokerage_split_pct: split, net_commission: net,
  discount_fee, settlement_period_fee, advance_amount: advance,
  brokerage_referral_fee: round2((discount_fee + settlement_period_fee) * 0.20),
  brokerage_referral_pct: 0.20, settlement_days_at_funding: settle,
  amount_due_from_brokerage: round2(net - (discount_fee + settlement_period_fee) * 0.20),
  source: 'manual_portal', payment_status: 'overdue', notes: TAG,
  failed_to_close_at: failedAt, failure_type: 'non_closing',
  failure_reason: 'Buyer financing fell through (dress rehearsal)',
  outstanding_balance: advance, cure_election_deadline: new Date(failedAt.getTime() + 15 * 86400000),
}, 'id, deal_number, property_address')

// --- a pending remediation_deals record --------------------------------------
const rem = await insert('remediation_deals', {
  failed_deal_id: failed.id, agent_id: agent.id,
  property_address: '[DRESS REHEARSAL] 88 Remedy Source Rd, Sault Ste. Marie, Ontario, P6B 4D4',
  mls_number: 'SSM-DRESS-001',
  brokerage_id: brokerage.id, brokerage_legal_name: brokerage.name,
  brokerage_address: [brokerage.address, brokerage.city, brokerage.province, brokerage.postal_code].filter(Boolean).join(', '),
  broker_of_record_name: brokerage.broker_of_record_name, broker_of_record_email: BROKER_EMAIL,
  expected_commission: 8500, expected_closing_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  directed_amount: advance, status: 'pending',
}, 'id, status, directed_amount')

console.log(JSON.stringify({
  failed_deal: failed,
  agent: { id: agent.id, name: `${agent.first_name} ${agent.last_name}`, email: agent.email },
  remediation_deal: rem,
  broker_of_record_email: BROKER_EMAIL,
}, null, 2))
await client.end()
