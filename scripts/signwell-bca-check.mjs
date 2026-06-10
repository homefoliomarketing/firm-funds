// Verification snapshot for the BCA dress rehearsal.
// Usage: node scripts/signwell-bca-check.mjs <brokerageId>
import { readFileSync } from 'node:fs'
import pg from 'pg'

const brokerageId = process.argv[2]
if (!brokerageId) { console.error('Usage: node scripts/signwell-bca-check.mjs <brokerageId>'); process.exit(1) }

const conn = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '')
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } })
await client.connect()

const show = (label, rows) => { console.log(`\n=== ${label} (${rows.length}) ===`); if (rows.length) console.table(rows) }

const b = (await client.query(`SELECT name, bca_signed_at, bca_signed_pdf_path FROM brokerages WHERE id = $1`, [brokerageId])).rows[0]
console.log(`\nBROKERAGE ${b?.name}`)
console.log(`  bca_signed_at      : ${b?.bca_signed_at ?? '(null)'}`)
console.log(`  bca_signed_pdf_path: ${b?.bca_signed_pdf_path ?? '(null)'}`)

show('esignature_envelopes (bca)', (await client.query(
  `SELECT document_type, status, agent_signer_status, agent_signed_at, completed_at, left(envelope_id,8) AS doc
     FROM esignature_envelopes WHERE brokerage_id = $1 AND document_type = 'bca' ORDER BY created_at DESC`, [brokerageId])).rows)

show('signwell_webhook_events (recent 5)', (await client.query(
  `SELECT event_type, processing_result, received_at, left(document_id,8) AS doc
     FROM signwell_webhook_events ORDER BY received_at DESC LIMIT 5`)).rows)

await client.end()
