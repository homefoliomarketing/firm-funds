#!/usr/bin/env node
/**
 * scripts/backup-db.mjs
 *
 * Dumps every row of every table in the public schema to a single JSON file.
 * Uses the Supabase service-role client (no Docker, no pg_dump required).
 *
 * Usage:
 *   node scripts/backup-db.mjs                       # default: backups/db-<ISO>.json.gz
 *   node scripts/backup-db.mjs --label pre-session-1 # backups/db-pre-session-1-<ISO>.json.gz
 *
 * Restore: scripts/restore-db.mjs <file>  (run with confirmation prompt)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const labelArgIdx = args.indexOf('--label');
const label = labelArgIdx >= 0 ? args[labelArgIdx + 1] : null;

const envText = fs.readFileSync('.env.local', 'utf8');
const envMap = Object.fromEntries(
  envText.split('\n').filter(Boolean).filter(l => !l.startsWith('#')).map(l => {
    const eq = l.indexOf('=');
    return [l.slice(0, eq), l.slice(eq + 1)];
  })
);

const SUPABASE_URL = envMap.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = envMap.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function listTables() {
  const { data, error } = await supabase.rpc('list_public_tables');
  if (error) {
    throw new Error(`list_public_tables RPC failed: ${error.message}. Migration 048 must be applied.`);
  }
  if (!data || data.length === 0) {
    throw new Error('list_public_tables returned no tables. Aborting to avoid empty backup.');
  }
  return data.map(r => r.table_name);
}

async function fetchAll(table) {
  const PAGE = 1000;
  let all = [];
  let from = 0;
  // Use createdAt or id ordering for stable pagination.
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + PAGE - 1);
    if (error) {
      if (error.code === '42P01' || error.message?.includes('Could not find the table')) {
        // Table does not exist; skip.
        return null;
      }
      throw new Error(`Table ${table}: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  const tables = await listTables();
  const iso = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const fname = label
    ? `backups/db-${label}-${iso}.json.gz`
    : `backups/db-${iso}.json.gz`;
  const counts = {};
  const dump = { schema_version: 1, timestamp: new Date().toISOString(), tables: {} };

  for (const table of tables) {
    process.stdout.write(`  ${table}... `);
    const rows = await fetchAll(table);
    if (rows === null) {
      console.log('SKIPPED (does not exist)');
      continue;
    }
    counts[table] = rows.length;
    dump.tables[table] = rows;
    console.log(`${rows.length} rows`);
  }

  fs.mkdirSync('backups', { recursive: true });
  const json = JSON.stringify(dump);
  const gz = zlib.gzipSync(json);
  fs.writeFileSync(fname, gz);

  const rowcountsFname = fname.replace('.json.gz', '.rowcounts.txt');
  const rowcountText = Object.entries(counts)
    .sort()
    .map(([t, n]) => `${t.padEnd(40)} ${n}`)
    .join('\n');
  fs.writeFileSync(rowcountsFname, rowcountText + '\n');

  const sizeMB = (gz.length / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${fname} (${sizeMB} MB, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows total)`);
  console.log(`Row counts: ${rowcountsFname}`);
}

main().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
