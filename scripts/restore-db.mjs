#!/usr/bin/env node
/**
 * scripts/restore-db.mjs
 *
 * SAFETY-FIRST restore tool. Generates a SQL file from a JSON backup that the
 * user can review BEFORE applying. Never auto-applies in default mode.
 *
 * Usage:
 *   node scripts/restore-db.mjs <backup.json.gz> [--table <name>] [--out <file>]
 *
 *   --table NAME   Restore only one table (recommended for surgical recovery).
 *   --out FILE     Output SQL file (default: backups/restore-<table>-<iso>.sql).
 *   --schema-only  Produce only TRUNCATE + COMMENT, no INSERTs (preview).
 *
 * After running this, REVIEW the generated SQL, then apply with:
 *   DBURL=$(grep '^SUPABASE_DB_URL=' .env.local | cut -d= -f2-)
 *   npx supabase db query --db-url "$DBURL" --file backups/restore-*.sql
 *
 * IMPORTANT: This script does NOT connect to the database. It only converts
 * JSON to SQL. The SQL it produces is destructive (TRUNCATE + INSERT). Read it.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.error('Usage: node scripts/restore-db.mjs <backup.json.gz> [--table NAME] [--out FILE]');
  process.exit(1);
}

const backupFile = args[0];
const tableIdx = args.indexOf('--table');
const outIdx = args.indexOf('--out');
const onlyTable = tableIdx >= 0 ? args[tableIdx + 1] : null;
const schemaOnly = args.includes('--schema-only');

if (!fs.existsSync(backupFile)) {
  console.error(`Backup file not found: ${backupFile}`);
  process.exit(1);
}

const raw = fs.readFileSync(backupFile);
const dump = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
console.error(`Loaded backup from ${dump.timestamp}, ${Object.keys(dump.tables).length} tables`);

const tablesToRestore = onlyTable
  ? (dump.tables[onlyTable] !== undefined ? [onlyTable] : [])
  : Object.keys(dump.tables);

if (tablesToRestore.length === 0) {
  console.error(`Table "${onlyTable}" not found in backup. Available: ${Object.keys(dump.tables).join(', ')}`);
  process.exit(1);
}

const iso = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
const defaultOut = onlyTable
  ? `backups/restore-${onlyTable}-${iso}.sql`
  : `backups/restore-all-${iso}.sql`;
const outFile = outIdx >= 0 ? args[outIdx + 1] : defaultOut;

function sqlQuote(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') {
    return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(val).replace(/'/g, "''")}'`;
}

let lines = [];
lines.push(`-- Restore script generated ${new Date().toISOString()}`);
lines.push(`-- Source backup: ${path.basename(backupFile)}`);
lines.push(`-- Backup timestamp: ${dump.timestamp}`);
lines.push(`-- WARNING: This SQL is destructive. Review before applying.`);
lines.push(`-- Each table: TRUNCATE (preserves FK cascades as RESTRICT) + INSERT.`);
lines.push(``);
lines.push(`BEGIN;`);
lines.push(`SET session_replication_role = replica; -- temporarily disable triggers + FK checks for clean restore`);
lines.push(``);

for (const table of tablesToRestore) {
  const rows = dump.tables[table];
  lines.push(`-- ===== ${table} (${rows.length} rows) =====`);
  lines.push(`TRUNCATE TABLE public.${table} CASCADE;`);
  if (schemaOnly || rows.length === 0) {
    lines.push(``);
    continue;
  }
  const cols = Object.keys(rows[0]);
  const colList = cols.map(c => `"${c}"`).join(', ');
  for (const row of rows) {
    const vals = cols.map(c => sqlQuote(row[c])).join(', ');
    lines.push(`INSERT INTO public.${table} (${colList}) VALUES (${vals});`);
  }
  lines.push(``);
}

lines.push(`SET session_replication_role = origin;`);
lines.push(`COMMIT;`);

fs.writeFileSync(outFile, lines.join('\n'));
console.error(`\nWrote ${outFile}`);
console.error(`\nNEXT STEPS (read the file first):`);
console.error(`  1. Review ${outFile} with an editor.`);
console.error(`  2. Make a SAFETY backup of current DB first: node scripts/backup-db.mjs --label pre-restore`);
console.error(`  3. Apply: DBURL=$(grep '^SUPABASE_DB_URL=' .env.local | cut -d= -f2-) && npx supabase db query --db-url "$DBURL" --file ${outFile}`);
console.error(`     (Note: large restores may need to be split into individual statements per Supabase CLI limitation.)`);
