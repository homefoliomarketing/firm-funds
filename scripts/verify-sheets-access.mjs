#!/usr/bin/env node
/**
 * scripts/verify-sheets-access.mjs
 *
 * Sanity check that:
 *   1. GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON in .env.local parses
 *   2. The service account can authenticate against the Sheets API
 *   3. The provided sheet has been shared read-only with that service account
 *
 * Usage:
 *   node scripts/verify-sheets-access.mjs <SHEET_ID>
 *
 * On success: prints sheet title, tab list (with row/col counts), and the
 * first 3 rows of the first tab so we can eyeball the data shape.
 */
import fs from 'node:fs';
import { google } from 'googleapis';

const sheetId = process.argv[2];
if (!sheetId) {
  console.error('Usage: node scripts/verify-sheets-access.mjs <SHEET_ID>');
  process.exit(1);
}

const envText = fs.readFileSync('.env.local', 'utf8');
const envMap = Object.fromEntries(
  envText.split('\n').filter(Boolean).filter(l => !l.startsWith('#')).map(l => {
    const eq = l.indexOf('=');
    return [l.slice(0, eq), l.slice(eq + 1)];
  })
);

const saRaw = envMap.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON;
if (!saRaw) {
  console.error('Missing GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON in .env.local');
  process.exit(1);
}

let credentials;
try {
  // The value may be stored either as raw JSON or as a JSON-encoded string
  // (i.e. wrapped in outer quotes with escaped inner quotes). Handle both.
  let parsed = JSON.parse(saRaw);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  credentials = parsed;
} catch (e) {
  console.error('GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is not valid JSON:', e.message);
  process.exit(1);
}
if (!credentials || !credentials.client_email) {
  console.error('Parsed credentials do not contain client_email. Got keys:', Object.keys(credentials || {}));
  process.exit(1);
}

console.log(`Service account: ${credentials.client_email}`);
console.log(`Project: ${credentials.project_id}`);
console.log('');

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const sheets = google.sheets({ version: 'v4', auth });

try {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  console.log(`Sheet title: ${meta.data.properties.title}`);
  console.log(`Tabs (${meta.data.sheets.length}):`);
  for (const s of meta.data.sheets) {
    const p = s.properties;
    console.log(`  - "${p.title}"  (gid ${p.sheetId}, ${p.gridProperties.rowCount}r x ${p.gridProperties.columnCount}c)`);
  }
  console.log('');

  const firstTab = meta.data.sheets[0].properties.title;
  const sample = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${firstTab}'!A1:N3`,
  });
  console.log(`First 3 rows of "${firstTab}":`);
  for (const row of sample.data.values || []) {
    console.log(`  ${JSON.stringify(row)}`);
  }
} catch (err) {
  console.error('Failed to read sheet:', err.message);
  if (err.code === 403 || /permission|access/i.test(err.message)) {
    console.error('');
    console.error('Most likely: the sheet has NOT been shared with the service account.');
    console.error(`Share read-only with: ${credentials.client_email}`);
  }
  process.exit(1);
}
