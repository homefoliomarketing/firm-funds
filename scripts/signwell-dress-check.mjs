// Verification snapshot for the SignWell dress rehearsal.
// Usage: node scripts/signwell-dress-check.mjs <dealId>
import { readFileSync } from 'node:fs'
import pg from 'pg'

const dealId = process.argv[2]
if (!dealId) { console.error('Usage: node scripts/signwell-dress-check.mjs <dealId>'); process.exit(1) }

const conn = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '')
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } })
await client.connect()

const show = (label, rows) => {
  console.log(`\n=== ${label} (${rows.length}) ===`)
  if (rows.length) console.table(rows)
}

const dealRow = (await client.query(`SELECT deal_number, status FROM deals WHERE id = $1`, [dealId])).rows[0]
console.log(`\nDEAL ${dealRow?.deal_number} — status: ${dealRow?.status}`)

show('esignature_envelopes', (await client.query(
  `SELECT document_type, status, agent_signer_status, agent_signed_at, completed_at, left(envelope_id,8) AS doc
     FROM esignature_envelopes WHERE deal_id = $1 ORDER BY document_type`, [dealId])).rows)

show('signwell_webhook_events (recent 5)', (await client.query(
  `SELECT event_type, processing_result, received_at, processed_at, left(document_id,8) AS doc
     FROM signwell_webhook_events ORDER BY received_at DESC LIMIT 5`)).rows)

show('deal_documents', (await client.query(
  `SELECT document_type, file_name, upload_source, created_at FROM deal_documents WHERE deal_id = $1 ORDER BY created_at`, [dealId])).rows)

show('underwriting_checklist (CPA/IDP items)', (await client.query(
  `SELECT checklist_item, is_checked, checked_at FROM underwriting_checklist
     WHERE deal_id = $1 AND (checklist_item ILIKE '%Commission Purchase Agreement%' OR checklist_item ILIKE '%Irrevocable Direction to Pay%')
     ORDER BY checklist_item`, [dealId])).rows)

await client.end()
