#!/usr/bin/env node
/**
 * scripts/seed-choice-realty-pipe.mjs
 *
 * One-off insert of Bud's own brokerage (Century 21 Choice Realty) into
 * brokerage_pipes so the firm-deal-poller has something to poll on. Column
 * mapping was verified by reading the live sheet on 2026-05-26; if the sheet
 * layout changes, update the SQL below and re-run.
 *
 * Idempotent: uses ON CONFLICT DO UPDATE on (brokerage_id, pipe_type, enabled).
 *
 * Usage:
 *   node scripts/seed-choice-realty-pipe.mjs
 */
import fs from 'node:fs'
import { Client } from 'pg'

const envText = fs.readFileSync('.env.local', 'utf8')
const envMap = Object.fromEntries(
  envText.split('\n').filter(Boolean).filter(l => !l.startsWith('#')).map(l => {
    const eq = l.indexOf('=')
    return [l.slice(0, eq), l.slice(eq + 1)]
  })
)

const DB_URL = envMap.SUPABASE_DB_URL
if (!DB_URL) {
  console.error('Missing SUPABASE_DB_URL in .env.local')
  process.exit(1)
}

// Live config verified against the sheet on 2026-05-26
const CHOICE_REALTY_BROKERAGE_NAME = 'Century 21 Choice Realty'
const SHEET_ID = '1nCyMpWh6l4HsDKarGJMCa9Q417GOvc944NGfkTfhUF0'
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`

const CONFIG = {
  sheet_id: SHEET_ID,
  sheet_url: SHEET_URL,
  trigger_type: 'row_moved_from_conditional',
  conditional_tab: 'Conditional',
  // Month tabs as they appear on the live sheet on 2026-05-26. Some have
  // year suffixes, some do not, and Aug 2026 is abbreviated. Tracking the
  // literal tab names so the poller doesn't need to guess.
  tabs_to_watch: [
    'January 2026',
    'February 2026',
    'March 2026',
    'April 2026',
    'May 2026',
    'June 2026',
    'July 2026',
    'Aug 2026',
    'September',
    'October',
    'November',
    'December',
  ],
  column_mapping: {
    address: 'A',
    mls: 'B',
    deposit_amount: 'C',
    deposit_date: 'D',
    payment_method: 'E',
    listing_agent: 'F',
    selling_agent: 'G',
    closing_date: 'K',
    notes: 'N',
  },
}

// ssl required: Supabase enforces SSL on direct Postgres connections.
const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

try {
  const brokerageRes = await client.query(
    'SELECT id, name FROM brokerages WHERE name = $1 LIMIT 1',
    [CHOICE_REALTY_BROKERAGE_NAME]
  )
  if (brokerageRes.rowCount === 0) {
    console.error(`Brokerage "${CHOICE_REALTY_BROKERAGE_NAME}" not found.`)
    process.exit(1)
  }
  const brokerage = brokerageRes.rows[0]
  console.log(`Brokerage: ${brokerage.name} (${brokerage.id})`)

  // ON CONFLICT on the unique (brokerage_id, pipe_type, enabled) constraint
  // so re-running this script just refreshes the config.
  const upsert = await client.query(
    `
    INSERT INTO brokerage_pipes
      (brokerage_id, pipe_type, config, brand_name, brand_tagline,
       auto_fire_enabled, enabled)
    VALUES ($1, 'spreadsheet', $2::jsonb, $3, $4, false, true)
    ON CONFLICT (brokerage_id, pipe_type, enabled)
    DO UPDATE SET
      config = EXCLUDED.config,
      brand_name = EXCLUDED.brand_name,
      brand_tagline = EXCLUDED.brand_tagline
    RETURNING id, brand_name, auto_fire_enabled, enabled
    `,
    [
      brokerage.id,
      JSON.stringify(CONFIG),
      'Choice Advances',
      'Powered by Firm Funds',
    ]
  )

  console.log('brokerage_pipes row:', upsert.rows[0])
  console.log('Config tabs_to_watch:', CONFIG.tabs_to_watch.join(', '))
  console.log('auto_fire_enabled: false (manual review mode)')
} finally {
  await client.end()
}
