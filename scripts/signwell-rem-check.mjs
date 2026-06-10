// Verification snapshot for the Remediation IDP dress rehearsal.
// Usage: node scripts/signwell-rem-check.mjs <remediationDealId>
import { readFileSync } from 'node:fs'
import pg from 'pg'

const remId = process.argv[2]
if (!remId) { console.error('Usage: node scripts/signwell-rem-check.mjs <remediationDealId>'); process.exit(1) }

const conn = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '')
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } })
await client.connect()

const show = (label, rows) => { console.log(`\n=== ${label} (${rows.length}) ===`); if (rows.length) console.table(rows) }

const rem = (await client.query(`SELECT status, signed_at, directed_amount FROM remediation_deals WHERE id = $1`, [remId])).rows[0]
console.log(`\nREMEDIATION DEAL ${remId}`)
console.log(`  status    : ${rem?.status}`)
console.log(`  signed_at : ${rem?.signed_at ?? '(null)'}`)

show('esignature_envelopes (remediation_idp)', (await client.query(
  `SELECT document_type, status, agent_signer_status, agent_signed_at, completed_at, left(envelope_id,8) AS doc
     FROM esignature_envelopes WHERE remediation_deal_id = $1 ORDER BY created_at DESC`, [remId])).rows)

show('signwell_webhook_events (recent 5)', (await client.query(
  `SELECT event_type, processing_result, received_at, left(document_id,8) AS doc
     FROM signwell_webhook_events ORDER BY received_at DESC LIMIT 5`)).rows)

show('audit_log (remediation_deal.signed)', (await client.query(
  `SELECT action, created_at, metadata->>'pdf_stored' AS pdf_stored, metadata->>'storage_path' AS storage_path
     FROM audit_log WHERE action = 'remediation_deal.signed' AND metadata->>'remediation_deal_id' = $1 ORDER BY created_at DESC`, [remId])).rows)

await client.end()
