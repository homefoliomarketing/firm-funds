// Seed a funded deal + an approved closing_date_amendments record for the CPA
// Amendment dress rehearsal. Reuses the tagged dress-rehearsal brokerage + Pat
// Testerson. Prints dealId + amendmentId for signwell-amend-send.mts.
//
// Usage: node scripts/signwell-amend-seed.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const TAG = '[SIGNWELL DRESS REHEARSAL]'
const ADMIN_ID = '056bc7d7-96a1-4fa5-9b6f-043bdd46d49a'

const conn = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '')
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } })
await client.connect()
const round2 = (n) => Math.round(n * 100) / 100
const dOnly = (ms) => new Date(ms).toISOString().slice(0, 10)

const brokerage = (await client.query(`SELECT * FROM brokerages WHERE notes = $1 ORDER BY created_at LIMIT 1`, [TAG])).rows[0]
if (!brokerage) { console.error('No dress-rehearsal brokerage found.'); process.exit(1) }
const agent = (await client.query(`SELECT * FROM agents WHERE brokerage_id = $1 ORDER BY created_at LIMIT 1`, [brokerage.id])).rows[0]

const insert = async (table, obj, returning = 'id') => {
  const cols = Object.keys(obj)
  const r = await client.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${returning}`,
    Object.values(obj))
  return r.rows[0]
}

// --- funded deal -------------------------------------------------------------
const gross = 16000, split = 12, settle = 7
const net = round2(gross * (1 - split / 100)) // 14080
const oldDays = 40
const oldDiscount = round2(net * 0.0008 * oldDays)
const settlementFee = round2(net * 0.0008 * settle)
const oldAdvance = round2(net - oldDiscount - settlementFee)
const fundingMs = Date.now() - 30 * 86400000
const oldClosingMs = Date.now() + 10 * 86400000
const newClosingMs = Date.now() + 30 * 86400000

const deal = await insert('deals', {
  agent_id: agent.id, brokerage_id: brokerage.id, status: 'funded',
  property_address: '[DRESS REHEARSAL] 5 Amendment Way, Sault Ste. Marie, Ontario, P6A 5E5',
  closing_date: dOnly(oldClosingMs), funding_date: dOnly(fundingMs), days_until_closing: oldDays,
  gross_commission: gross, brokerage_split_pct: split, net_commission: net,
  discount_fee: oldDiscount, settlement_period_fee: settlementFee, advance_amount: oldAdvance,
  brokerage_referral_fee: round2((oldDiscount + settlementFee) * 0.20), brokerage_referral_pct: 0.20,
  amount_due_from_brokerage: round2(net - (oldDiscount + settlementFee) * 0.20),
  settlement_days_at_funding: settle, due_date: dOnly(oldClosingMs + settle * 86400000),
  source: 'manual_portal', payment_status: 'pending', notes: TAG,
}, 'id, deal_number, property_address, funding_date')

// --- new (recalculated) figures for the later closing ------------------------
const newDays = 60
const newDiscount = round2(net * 0.0008 * newDays)
const newAdvance = round2(net - newDiscount - settlementFee)

const amendment = await insert('closing_date_amendments', {
  deal_id: deal.id, requested_by: ADMIN_ID, status: 'approved',
  old_closing_date: dOnly(oldClosingMs), new_closing_date: dOnly(newClosingMs),
  old_discount_fee: oldDiscount, new_discount_fee: newDiscount,
  old_settlement_period_fee: settlementFee, new_settlement_period_fee: settlementFee,
  old_advance_amount: oldAdvance, new_advance_amount: newAdvance,
  old_due_date: dOnly(oldClosingMs + settle * 86400000), new_due_date: dOnly(newClosingMs + settle * 86400000),
  reviewed_by: ADMIN_ID, reviewed_at: new Date(),
}, 'id, status, old_closing_date, new_closing_date')

console.log(JSON.stringify({
  deal, amendment,
  agent: { id: agent.id, name: `${agent.first_name} ${agent.last_name}`, email: agent.email },
  old_discount: oldDiscount, new_discount: newDiscount, old_advance: oldAdvance, new_advance: newAdvance,
}, null, 2))
await client.end()
