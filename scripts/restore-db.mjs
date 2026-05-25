#!/usr/bin/env node
/**
 * scripts/restore-db.mjs
 *
 * SAFETY-FIRST restore tool. Generates a SQL file from a JSON backup that the
 * user can review BEFORE applying. Never auto-applies in default mode.
 *
 * Usage:
 *   node scripts/restore-db.mjs <backup.json.gz> [--table <name>] [--out <file>] \
 *        --confirm <hostname> [--i-understand-this-is-production]
 *
 *   --table NAME                          Restore only one table (recommended).
 *   --out FILE                            Output SQL file (default: backups/restore-<table>-<iso>.sql).
 *   --schema-only                         Produce only TRUNCATE + COMMENT, no INSERTs (preview).
 *   --confirm HOSTNAME                    Must match the hostname parsed from SUPABASE_DB_URL.
 *   --i-understand-this-is-production     Required if the target DB is production (bzijzmxhrpiwuhzhbiqc).
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
import readline from 'node:readline';

const PROD_PROJECT_REF = 'bzijzmxhrpiwuhzhbiqc';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.error('Usage: node scripts/restore-db.mjs <backup.json.gz> [--table NAME] [--out FILE] --confirm <hostname> [--i-understand-this-is-production]');
  process.exit(1);
}

const backupFile = args[0];
const tableIdx = args.indexOf('--table');
const outIdx = args.indexOf('--out');
const confirmIdx = args.indexOf('--confirm');
const onlyTable = tableIdx >= 0 ? args[tableIdx + 1] : null;
const schemaOnly = args.includes('--schema-only');
const confirmHost = confirmIdx >= 0 ? args[confirmIdx + 1] : null;
const productionAck = args.includes('--i-understand-this-is-production');

if (!fs.existsSync(backupFile)) {
  console.error(`Backup file not found: ${backupFile}`);
  process.exit(1);
}

// --- SAFETY GUARDS ---------------------------------------------------------
// Parse the hostname from SUPABASE_DB_URL in .env.local and require the
// operator to confirm it on the CLI. This prevents accidentally running the
// generated TRUNCATE-and-INSERT SQL against the wrong database.
if (!fs.existsSync('.env.local')) {
  console.error('ERROR: .env.local not found. Cannot determine target hostname.');
  process.exit(1);
}

const envText = fs.readFileSync('.env.local', 'utf8');
const dbUrlLine = envText
  .split('\n')
  .map(l => l.trim())
  .find(l => l.startsWith('SUPABASE_DB_URL='));

if (!dbUrlLine) {
  console.error('ERROR: SUPABASE_DB_URL not found in .env.local.');
  process.exit(1);
}

const dbUrl = dbUrlLine.slice('SUPABASE_DB_URL='.length).trim();
let targetHost;
try {
  targetHost = new URL(dbUrl).hostname;
} catch {
  console.error('ERROR: SUPABASE_DB_URL in .env.local is not a valid URL.');
  process.exit(1);
}

if (!confirmHost) {
  console.error('ERROR: --confirm <hostname> is required.');
  console.error(`       Expected hostname (from SUPABASE_DB_URL): ${targetHost}`);
  console.error(`       Re-run with: --confirm ${targetHost}`);
  process.exit(1);
}

if (confirmHost !== targetHost) {
  console.error('ERROR: --confirm hostname does NOT match SUPABASE_DB_URL hostname.');
  console.error(`       --confirm value: ${confirmHost}`);
  console.error(`       SUPABASE_DB_URL: ${targetHost}`);
  console.error('       Aborting. Verify which database you intend to restore to.');
  process.exit(1);
}

const isProduction = dbUrl.includes(PROD_PROJECT_REF) || targetHost.includes(PROD_PROJECT_REF);

if (isProduction) {
  console.error('');
  console.error('################################################################');
  console.error('#                                                              #');
  console.error('#   !!!  WARNING: PRODUCTION DATABASE DETECTED  !!!            #');
  console.error('#                                                              #');
  console.error(`#   Target: ${targetHost.padEnd(50)} #`);
  console.error(`#   Project ref: ${PROD_PROJECT_REF.padEnd(45)} #`);
  console.error('#                                                              #');
  console.error('#   The SQL this script generates will TRUNCATE TABLE ...      #');
  console.error('#   CASCADE on EVERY table listed. This is IRREVERSIBLE        #');
  console.error('#   without a separate backup. Real customer money is at risk. #');
  console.error('#                                                              #');
  console.error('################################################################');
  console.error('');
  if (!productionAck) {
    console.error('ERROR: --i-understand-this-is-production flag is required for production.');
    process.exit(1);
  }
}

// Interactive hostname re-type. Operator must type the hostname back.
async function promptHostname() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`Type the target hostname to continue (${targetHost}): `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptYes(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(msg, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

const totalRows = tablesToRestore.reduce((sum, t) => sum + dump.tables[t].length, 0);

async function runGuards() {
  const typed = await promptHostname();
  if (typed !== targetHost) {
    console.error(`ERROR: typed hostname "${typed}" does not match "${targetHost}". Aborting.`);
    process.exit(1);
  }

  console.error('');
  console.error('SUMMARY OF GENERATED SQL:');
  console.error(`  Target host:   ${targetHost}`);
  console.error(`  Production?:   ${isProduction ? 'YES' : 'no'}`);
  console.error(`  Source backup: ${path.basename(backupFile)}`);
  console.error(`  Tables:        ${tablesToRestore.length}`);
  console.error(`  Total rows:    ${totalRows}`);
  console.error(`  Mode:          ${schemaOnly ? 'schema-only (TRUNCATE without INSERTs)' : 'TRUNCATE + INSERTs'}`);
  console.error('');
  console.error('  Each table will get TRUNCATE TABLE ... CASCADE applied when this SQL runs.');
  console.error('');

  const ack = await promptYes(`Type 'yes' to GENERATE the SQL file (not apply): `);
  if (ack !== 'yes') {
    console.error('Aborted by operator.');
    process.exit(1);
  }
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

function buildSql() {
  let lines = [];
  lines.push(`-- Restore script generated ${new Date().toISOString()}`);
  lines.push(`-- Source backup: ${path.basename(backupFile)}`);
  lines.push(`-- Backup timestamp: ${dump.timestamp}`);
  lines.push(`-- Target host: ${targetHost}${isProduction ? ' (PRODUCTION)' : ''}`);
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
  return lines.join('\n');
}

(async () => {
  await runGuards();
  fs.writeFileSync(outFile, buildSql());
  console.error(`\nWrote ${outFile}`);
  console.error(`\nNEXT STEPS (read the file first):`);
  console.error(`  1. Review ${outFile} with an editor.`);
  console.error(`  2. Make a SAFETY backup of current DB first: node scripts/backup-db.mjs --label pre-restore`);
  console.error(`  3. Apply: DBURL=$(grep '^SUPABASE_DB_URL=' .env.local | cut -d= -f2-) && npx supabase db query --db-url "$DBURL" --file ${outFile}`);
  console.error(`     (Note: large restores may need to be split into individual statements per Supabase CLI limitation.)`);
})().catch(err => {
  console.error('Restore generation failed:', err);
  process.exit(1);
});
