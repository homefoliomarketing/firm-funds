// scripts/replay-remediation-webhook.mjs
//
// Replays a synthetic DocuSign Connect "envelope-completed" payload against
// the local /api/docusign/webhook handler so we can verify the Remediation IDP
// signed-flow end-to-end without waiting for a real DocuSign delivery.
//
// How to run (PowerShell):
//   1. In one terminal:
//        $env:DOCUSIGN_HMAC_DEV_BYPASS = "1"
//        npm run dev
//      (DOCUSIGN_HMAC_DEV_BYPASS skips HMAC verification — never set in prod.)
//
//   2. In another terminal:
//        node scripts/replay-remediation-webhook.mjs
//
// What the script does:
//   1. Looks up the most recently sent Remediation IDP envelope from the DB
//      (esignature_envelopes.document_type = 'remediation_idp', status =
//      'signed' is fine — we just need the envelope_id and the linked
//      remediation_deal_id).
//   2. Resets the linked remediation_deals row back to 'idp_sent' so the
//      webhook has work to do (CAS-guard requires idp_sent for the flip).
//   3. Clears any prior dedup row for that envelope so we don't get short-
//      circuited by Finding 10's idempotency guard.
//   4. POSTs a synthetic Connect aggregate-mode "envelope-completed" payload
//      to http://localhost:3000/api/docusign/webhook.
//   5. Reports the response code and prints the post-replay state of the
//      remediation row + storage path + audit log so we can eyeball it.

import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

// ----------------------------------------------------------------------------
// 1. DB connection
// ----------------------------------------------------------------------------

const envText = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envText.match(/^SUPABASE_DB_URL=(.+)/m)[1].replace(/["']/g, '');
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

// ----------------------------------------------------------------------------
// 2. Find a Remediation IDP envelope to replay
// ----------------------------------------------------------------------------

const { rows: envelopes } = await client.query(`
  SELECT
    ee.envelope_id,
    ee.remediation_deal_id::text AS remediation_deal_id,
    rd.status                    AS remediation_status,
    rd.property_address          AS source_property_address
  FROM esignature_envelopes ee
  JOIN remediation_deals rd ON rd.id = ee.remediation_deal_id
  WHERE ee.document_type = 'remediation_idp'
  ORDER BY ee.created_at DESC
  LIMIT 1
`);

if (envelopes.length === 0) {
  console.error('No Remediation IDP envelopes in the database. Send one first via the admin UI, then re-run.');
  await client.end();
  process.exit(1);
}

const { envelope_id, remediation_deal_id, source_property_address } = envelopes[0];
console.log(`Replaying envelope ${envelope_id}`);
console.log(`  remediation_deal_id: ${remediation_deal_id}`);
console.log(`  source property:     ${source_property_address}`);

// ----------------------------------------------------------------------------
// 3. Reset remediation row to idp_sent + clear dedup row + clear signed_at
// ----------------------------------------------------------------------------

await client.query(
  `UPDATE remediation_deals SET status = 'idp_sent', signed_at = NULL WHERE id = $1`,
  [remediation_deal_id]
);
console.log(`  Reset remediation_deals.status -> idp_sent, signed_at -> NULL`);

const dedupResult = await client.query(
  `DELETE FROM docusign_webhook_events WHERE envelope_id = $1 RETURNING event_id`,
  [envelope_id]
);
console.log(`  Cleared ${dedupResult.rowCount} dedup rows for this envelope`);

// ----------------------------------------------------------------------------
// 4. Build synthetic Connect aggregate-mode "envelope-completed" payload
// ----------------------------------------------------------------------------

const generatedDateTime = new Date().toISOString();
const payload = {
  event: 'envelope-completed',
  envelopeId: envelope_id,
  generatedDateTime,
  data: {
    envelopeId: envelope_id,
    envelopeSummary: {
      status: 'completed',
      recipients: {
        signers: [
          {
            recipientId: '1',
            status: 'completed',
            signedDateTime: generatedDateTime,
          },
        ],
      },
    },
  },
};

const body = JSON.stringify(payload);

// ----------------------------------------------------------------------------
// 5. POST against the local dev server
// ----------------------------------------------------------------------------

const url = process.env.WEBHOOK_URL || 'http://localhost:3000/api/docusign/webhook';
console.log(`\nPOSTing to ${url} ...`);

let response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
} catch (err) {
  console.error(`Fetch failed: ${err.message}`);
  console.error('Is the dev server running? Did you set $env:DOCUSIGN_HMAC_DEV_BYPASS = "1" before "npm run dev"?');
  await client.end();
  process.exit(1);
}

const responseText = await response.text();
console.log(`  Response: ${response.status} ${responseText}`);

if (response.status === 401) {
  console.error('\nHMAC rejection — set $env:DOCUSIGN_HMAC_DEV_BYPASS = "1" in the same terminal as "npm run dev" and try again.');
  await client.end();
  process.exit(1);
}

// ----------------------------------------------------------------------------
// 6. Inspect post-replay state
// ----------------------------------------------------------------------------

console.log(`\n--- Post-replay state ---`);

const { rows: remRows } = await client.query(
  `SELECT status, signed_at FROM remediation_deals WHERE id = $1`,
  [remediation_deal_id]
);
console.log(`remediation_deals: status=${remRows[0].status}, signed_at=${remRows[0].signed_at}`);

const { rows: storageRows } = await client.query(
  `SELECT name FROM storage.objects
   WHERE bucket_id = 'deal-documents'
     AND name LIKE 'remediation_idp/' || $1 || '/%'
   ORDER BY created_at DESC LIMIT 3`,
  [remediation_deal_id]
);
console.log(`storage paths under remediation_idp/${remediation_deal_id}/:`);
for (const r of storageRows) console.log(`  ${r.name}`);
if (storageRows.length === 0) {
  console.log('  (none — either DocuSign auth was missing or the doc download failed)');
}

const { rows: auditRows } = await client.query(
  `SELECT action, created_at, metadata
   FROM audit_log
   WHERE action = 'remediation_deal.signed'
     AND metadata->>'remediation_deal_id' = $1
   ORDER BY created_at DESC LIMIT 3`,
  [remediation_deal_id]
);
console.log(`audit_log remediation_deal.signed entries (${auditRows.length}):`);
for (const r of auditRows) {
  console.log(`  ${r.created_at} envelope=${r.metadata.envelope_id} pdf_stored=${r.metadata.pdf_stored}`);
}

const { rows: dedupRows } = await client.query(
  `SELECT event_id, event_type, processed_at, processing_result
   FROM docusign_webhook_events
   WHERE envelope_id = $1
   ORDER BY received_at DESC LIMIT 5`,
  [envelope_id]
);
console.log(`docusign_webhook_events for this envelope (${dedupRows.length}):`);
for (const r of dedupRows) {
  console.log(`  ${r.event_id} type=${r.event_type} processed_at=${r.processed_at} result=${r.processing_result}`);
}

await client.end();
console.log('\nDone.');
