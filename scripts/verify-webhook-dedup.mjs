import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('file:///c:/Users/randi/Dev/firm-funds/node_modules/');
const { Client } = require('pg');

const envText = fs.readFileSync('.env.local', 'utf8');
const url = envText.match(/^SUPABASE_DB_URL=(.+)/m)[1].replace(/["']/g, '');
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const testEventId = 'audit_probe_' + Date.now();

// 1. Confirm table exists with the right PK
const { rows: schema } = await client.query(`
  SELECT a.attname, t.typname, a.attnotnull
  FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE c.relname = 'docusign_webhook_events'
  ORDER BY a.attnum
`);
console.log('docusign_webhook_events columns:');
for (const r of schema) console.log(`  ${r.attname}: ${r.typname}${r.attnotnull ? ' NOT NULL' : ''}`);

// 2. First insert — should succeed
await client.query('BEGIN');
const ins1 = await client.query(
  `INSERT INTO docusign_webhook_events (event_id, envelope_id, event_type) VALUES ($1, 'probe-env-1', 'recipient-completed') RETURNING event_id, received_at`,
  [testEventId]
);
console.log(`\nfirst insert (event_id=${testEventId}): rowCount=${ins1.rowCount}`);

// 3. Duplicate insert — should fail with 23505
try {
  await client.query(
    `INSERT INTO docusign_webhook_events (event_id, envelope_id, event_type) VALUES ($1, 'probe-env-1', 'envelope-completed')`,
    [testEventId]
  );
  console.log('BAD: duplicate insert succeeded (PK is missing or wrong)');
} catch (err) {
  console.log(`GOOD: duplicate insert rejected, code=${err.code}, message=${err.message}`);
}

await client.query('ROLLBACK');
console.log('(rolled back)');

// 4. Check that the webhook RLS doesn't block service-role writes
const { rows: policies } = await client.query(`
  SELECT polname, polcmd, polroles::regrole[] AS roles
  FROM pg_policy WHERE polrelid = 'docusign_webhook_events'::regclass
`);
console.log('\nRLS policies:');
for (const p of policies) console.log(`  ${p.polname}: cmd=${p.polcmd}, roles=${p.roles}`);

await client.end();
