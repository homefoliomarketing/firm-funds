#!/usr/bin/env node
// Run a multi-statement SQL migration file against the Supabase Postgres
// instance. Used as a workaround because `npx supabase db query --file`
// rejects multi-statement files. Usage:
//   node scripts/run-migration.mjs supabase/migrations/081_foo.sql
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const file = process.argv[2]
if (!file) {
  console.error('Usage: node scripts/run-migration.mjs <path/to/migration.sql>')
  process.exit(1)
}

// Load DB URL from .env.local without pulling in dotenv as a dependency.
const env = readFileSync('.env.local', 'utf8')
const match = env.match(/^SUPABASE_DB_URL=(.+)$/m)
if (!match) {
  console.error('SUPABASE_DB_URL not found in .env.local')
  process.exit(1)
}
const connectionString = match[1].trim()

const sql = readFileSync(resolve(file), 'utf8')
const client = new pg.Client({ connectionString })

async function main() {
  await client.connect()
  console.log(`[migration] connected; running ${file}`)
  try {
    await client.query(sql)
    console.log('[migration] success')
  } catch (err) {
    console.error('[migration] FAILED:', err.message)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

main()
