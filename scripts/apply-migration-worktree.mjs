#!/usr/bin/env node
/**
 * scripts/apply-migration-worktree.mjs
 *
 * Worktree-friendly variant of apply-migration.mjs. Resolves `pg` from the
 * parent repo's node_modules so it works even when the worktree has no
 * locally-installed dependencies.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('file:///c:/Users/randi/Dev/firm-funds/node_modules/');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-migration-worktree.mjs <path-to-sql>');
  process.exit(1);
}

const envText = fs.readFileSync('.env.local', 'utf8');
const envMap = Object.fromEntries(
  envText.split('\n').filter(Boolean).filter(l => !l.startsWith('#')).map(l => {
    const eq = l.indexOf('=');
    return [l.slice(0, eq), l.slice(eq + 1)];
  })
);

const DB_URL = envMap.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('Missing SUPABASE_DB_URL in .env.local');
  process.exit(1);
}

const sql = fs.readFileSync(file, 'utf8');

const client = new Client({
  connectionString: DB_URL.replace(/^["']|["']$/g, ''),
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  console.log(`Applying ${file} ...`);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('OK — committed.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED — rolled back.');
    console.error(err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
