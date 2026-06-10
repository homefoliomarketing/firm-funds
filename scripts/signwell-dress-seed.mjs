// One clean, clearly-marked test deal for the SignWell full dress rehearsal.
// Creates a fake brokerage + agent + an APPROVED deal (deal_number assigned by
// the migration-108 trigger; underwriting checklist auto-created by trigger).
//
// Everything is tagged notes = '[SIGNWELL DRESS REHEARSAL]' so it can be wiped
// later with scripts/signwell-dress-cleanup.mjs.
//
// Usage:  node scripts/signwell-dress-seed.mjs
//
// Emails (override with env vars if you have a second inbox):
//   SIGNER_EMAIL  — the agent (who signs).        default homefoliomarketing@gmail.com
//   BROKER_EMAIL  — broker of record + brokerage.  default homefoliomarketing+broker@gmail.com
import fs from 'node:fs'
import pg from 'pg'

const TAG = '[SIGNWELL DRESS REHEARSAL]'
const SIGNER_EMAIL = process.env.SIGNER_EMAIL || 'homefoliomarketing@gmail.com'
const BROKER_EMAIL = process.env.BROKER_EMAIL || 'homefoliomarketing+broker@gmail.com'

const conn = fs.readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '')
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } })
await client.connect()

const round2 = (n) => Math.round(n * 100) / 100

// --- money (self-consistent, mirrors lib/calculations.ts shape) --------------
const gross = 14000
const split = 15                 // whole number, NOT decimal
const days = 35
const settle = 7
const refPct = 0.20
const net = round2(gross * (1 - split / 100))            // 11900
const discount_fee = round2(net * 0.0008 * days)         // 333.20
const settlement_period_fee = round2(net * 0.0008 * settle) // 66.64
const totalFees = round2(discount_fee + settlement_period_fee)
const advance_amount = round2(net - totalFees)
const brokerage_referral_fee = round2(totalFees * refPct)
const amount_due_from_brokerage = round2(net - brokerage_referral_fee)

const closing = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)

const insert = async (table, obj, returning = 'id') => {
  const cols = Object.keys(obj)
  const ph = cols.map((_, i) => `$${i + 1}`).join(',')
  const r = await client.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph}) RETURNING ${returning}`,
    Object.values(obj),
  )
  return r.rows[0]
}

// --- brokerage ---------------------------------------------------------------
const brokerage = await insert('brokerages', {
  name: 'Dress Rehearsal Test Realty',
  brand: 'Independent',
  email: BROKER_EMAIL,
  broker_of_record_email: BROKER_EMAIL,
  broker_of_record_name: 'Casey Broker',
  status: 'active',
  referral_fee_percentage: refPct,
  is_white_label_partner: false,
  profit_share_pct: 0,
  address: '100 Test Office Rd',
  city: 'Sault Ste. Marie',
  province: 'Ontario',
  postal_code: 'P6A 1A1',
  phone: '705-555-0100',
  reco_registration_number: 'RECO-DRESS01',
  transaction_system: 'manual',
  notes: TAG,
})

// --- agent (the signer) ------------------------------------------------------
const agent = await insert('agents', {
  brokerage_id: brokerage.id,
  first_name: 'Pat',
  last_name: 'Testerson',
  email: SIGNER_EMAIL,
  phone: '705-555-0142',
  reco_number: 'R9000001',
  status: 'active',
  flagged_by_brokerage: false,
  kyc_status: 'verified',
  banking_verified: true,
  banking_approval_status: 'approved',
  bank_transit_number: '12345',
  bank_institution_number: '003',
  bank_account_number: '7654321',
  account_balance: 0,
  outstanding_recovery: 0,
  address_street: '22 Agent Test Ave',
  address_city: 'Sault Ste. Marie',
  address_province: 'Ontario',
  address_postal_code: 'P6A 2B2',
})

// --- deal (APPROVED; deal_number + checklist assigned by triggers) -----------
const deal = await insert('deals', {
  agent_id: agent.id,
  brokerage_id: brokerage.id,
  status: 'approved',
  property_address: '[DRESS REHEARSAL] 7 Signature Test Way, Sault Ste. Marie, Ontario, P6A 1A1',
  closing_date: closing,
  gross_commission: gross,
  brokerage_split_pct: split,
  net_commission: net,
  days_until_closing: days,
  discount_fee,
  settlement_period_fee,
  advance_amount,
  brokerage_referral_fee,
  brokerage_referral_pct: refPct,
  amount_due_from_brokerage,
  settlement_days_at_funding: settle,
  source: 'manual_portal',
  payment_status: 'not_applicable',
  notes: TAG,
}, 'id, deal_number, status, closing_date')

const checklist = (await client.query(
  `SELECT count(*)::int AS n FROM underwriting_checklist WHERE deal_id = $1`, [deal.id],
)).rows[0].n

console.log(JSON.stringify({
  brokerage: { id: brokerage.id, name: 'Dress Rehearsal Test Realty', broker_of_record_email: BROKER_EMAIL, email: BROKER_EMAIL },
  agent: { id: agent.id, name: 'Pat Testerson', email: SIGNER_EMAIL },
  deal: { ...deal, advance_amount, net_commission: net, discount_fee, settlement_period_fee },
  underwriting_checklist_rows: checklist,
}, null, 2))

await client.end()
