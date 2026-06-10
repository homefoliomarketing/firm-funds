/**
 * scripts/apply-sql-file.mjs
 * Runs a .sql file against SUPABASE_DB_URL (read from .env.local) via node-pg.
 * Passing the file PATH (not its contents) means the SQL never hits the shell,
 * so ${...} / quotes inside the migration are safe.
 *   node scripts/apply-sql-file.mjs supabase/migrations/109_signwell_webhook_events.sql
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'

function envLocal(key) {
  const raw = readFileSync('.env.local', 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '').trim()
  }
  return undefined
}

const file = process.argv[2]
if (!file) { console.error('Usage: node scripts/apply-sql-file.mjs <path.sql>'); process.exit(1) }
const url = envLocal('SUPABASE_DB_URL')
if (!url) { console.error('Missing SUPABASE_DB_URL in .env.local'); process.exit(1) }

const sql = readFileSync(file, 'utf8')
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })

await client.connect()
try {
  await client.query(sql)
  console.log(`Applied: ${file}`)
} finally {
  await client.end()
}
