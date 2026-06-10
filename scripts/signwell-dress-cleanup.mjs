// Wipe everything created across the SignWell dress rehearsals (tagged
// notes = '[SIGNWELL DRESS REHEARSAL]'): all deals (CPA/IDP, failed, amendment)
// + their envelopes/documents/checklists/amendments, the BCA envelope, the
// remediation_deals records + their envelopes, all signwell_webhook_events for
// those documents, audit rows, storage objects (deal-level, brokerage-bca/,
// remediation_idp/), then the agent(s) and brokerage(s).
//
// Mirrors seed-test-data.mjs's trigger bypass (session_replication_role=replica)
// to clear the hard-delete guards.
//
// Usage:
//   node scripts/signwell-dress-cleanup.mjs            (plan only)
//   node scripts/signwell-dress-cleanup.mjs --commit   (actually delete)
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const COMMIT = process.argv.includes('--commit')
const TAG = '[SIGNWELL DRESS REHEARSAL]'
const BUCKET = 'deal-documents'

const env = readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
  .reduce((a, l) => { const i = l.indexOf('='); if (i > 0) a[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ''); return a }, {})
const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await client.connect()

const SENTINEL = ['00000000-0000-0000-0000-000000000000']
const orSentinel = (arr) => (arr.length ? arr : SENTINEL)

const bIds = (await client.query(`SELECT id FROM brokerages WHERE notes = $1`, [TAG])).rows.map((r) => r.id)
if (!bIds.length) { console.log('No dress-rehearsal brokerage found — nothing to do.'); await client.end(); process.exit(0) }
const dIds = (await client.query(`SELECT id FROM deals WHERE brokerage_id = ANY($1)`, [bIds])).rows.map((r) => r.id)
const aIds = (await client.query(`SELECT id FROM agents WHERE brokerage_id = ANY($1)`, [bIds])).rows.map((r) => r.id)
const remIds = (await client.query(
  `SELECT id FROM remediation_deals WHERE failed_deal_id = ANY($1) OR agent_id = ANY($2) OR brokerage_id = ANY($3)`,
  [orSentinel(dIds), orSentinel(aIds), bIds])).rows.map((r) => r.id)
const docIds = (await client.query(
  `SELECT DISTINCT envelope_id FROM esignature_envelopes
     WHERE deal_id = ANY($1) OR brokerage_id = ANY($2) OR remediation_deal_id = ANY($3)`,
  [orSentinel(dIds), bIds, orSentinel(remIds)])).rows.map((r) => r.envelope_id)

console.log(`Found: ${bIds.length} brokerage(s), ${dIds.length} deal(s), ${aIds.length} agent(s), ${remIds.length} remediation(s), ${docIds.length} envelope doc id(s).`)
if (!COMMIT) { console.log('\n[PLAN ONLY] Re-run with --commit to delete.'); await client.end(); process.exit(0) }

// ---- storage objects --------------------------------------------------------
const removePrefix = async (prefix) => {
  const { data: objs } = await supa.storage.from(BUCKET).list(prefix, { limit: 1000 })
  if (objs && objs.length) await supa.storage.from(BUCKET).remove(objs.map((o) => `${prefix}/${o.name}`))
}
for (const id of dIds) await removePrefix(id)              // deal-level signed PDFs
for (const id of bIds) await removePrefix(`brokerage-bca/${id}`)
for (const id of remIds) await removePrefix(`remediation_idp/${id}`)

// ---- DB rows (triggers off) -------------------------------------------------
await client.query('BEGIN')
await client.query(`SET LOCAL session_replication_role = 'replica'`)
if (docIds.length) await client.query(`DELETE FROM signwell_webhook_events WHERE document_id = ANY($1)`, [docIds])
await client.query(`DELETE FROM esignature_envelopes WHERE deal_id = ANY($1) OR brokerage_id = ANY($2) OR remediation_deal_id = ANY($3)`,
  [orSentinel(dIds), bIds, orSentinel(remIds)])
if (remIds.length) await client.query(`DELETE FROM remediation_deals WHERE id = ANY($1)`, [remIds])
for (const [t, col] of [['notification_log', 'deal_id'], ['closing_date_amendments', 'deal_id'], ['deal_documents', 'deal_id'], ['underwriting_checklist', 'deal_id']]) {
  if (dIds.length) { try { await client.query(`DELETE FROM ${t} WHERE ${col} = ANY($1)`, [dIds]) } catch (e) { console.warn(`  (skip ${t}: ${e.message})`) } }
}
// audit rows reference deal/brokerage/remediation ids in entity_id
try { await client.query(`DELETE FROM audit_log WHERE entity_id = ANY($1)`, [[...dIds, ...bIds, ...remIds].length ? [...dIds, ...bIds, ...remIds] : SENTINEL]) } catch (e) { console.warn(`  (skip audit_log: ${e.message})`) }
if (dIds.length) await client.query(`DELETE FROM deals WHERE id = ANY($1)`, [dIds])
if (aIds.length) await client.query(`DELETE FROM agents WHERE id = ANY($1)`, [aIds])
await client.query(`DELETE FROM brokerages WHERE id = ANY($1)`, [bIds])
await client.query('COMMIT')

console.log(`Deleted: ${dIds.length} deal(s), ${aIds.length} agent(s), ${remIds.length} remediation(s), ${bIds.length} brokerage(s) + their envelopes/docs/webhook rows/storage.`)
await client.end()
