import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('file:///c:/Users/randi/Dev/firm-funds/node_modules/');
const { Client } = require('pg');

const envText = fs.readFileSync('.env.local', 'utf8');
const envMap = Object.fromEntries(
  envText.split('\n').filter(Boolean).filter(l => !l.startsWith('#')).map(l => {
    const eq = l.indexOf('=');
    return [l.slice(0, eq), l.slice(eq + 1).replace(/^["']|["']$/g, '')];
  })
);

const client = new Client({ connectionString: envMap.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const sql = `
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  array_agg(DISTINCT acl.grantee::regrole::text) FILTER (WHERE acl.privilege_type = 'EXECUTE') AS execute_grantees
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl ON true
WHERE n.nspname = 'public'
  AND p.proname IN (
    'apply_agent_balance_delta',
    'apply_late_payment_interest',
    'apply_failed_deal_interest',
    'apply_remediation_remittance',
    'record_brokerage_late_strike',
    'delete_brokerage_atomic'
  )
GROUP BY p.proname, p.oid
ORDER BY p.proname;
`;

const { rows } = await client.query(sql);
console.log(JSON.stringify(rows, null, 2));
await client.end();
