import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('file:///c:/Users/randi/Dev/firm-funds/node_modules/');
const { Client } = require('pg');

const envText = fs.readFileSync('.env.local', 'utf8');
const url = envText.match(/^SUPABASE_DB_URL=(.+)/m)[1].replace(/["']/g, '');
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// Pick an agent + their user_profile so we can simulate the agent's own session
const { rows: probe } = await client.query(
  `SELECT a.id AS agent_id, up.id AS user_id, a.bank_account_number, a.kyc_status
   FROM agents a
   JOIN user_profiles up ON up.agent_id = a.id
   LIMIT 1`
);
if (!probe.length) { console.log('no agent+profile pair found'); process.exit(0); }
const { agent_id, user_id, bank_account_number, kyc_status } = probe[0];
console.log(`probe: agent_id=${agent_id} user_id=${user_id}`);
console.log(`before: bank_account_number=${bank_account_number ?? 'NULL'} kyc_status=${kyc_status}`);

try {
  await client.query('BEGIN');
  await client.query("SET LOCAL ROLE authenticated");
  // Simulate the agent's JWT by setting request.jwt.claims to include sub=user_id
  await client.query(`SELECT set_config('request.jwt.claims', '{"sub":"${user_id}","role":"authenticated"}', true)`);

  const { rowCount, rows: r } = await client.query(
    `UPDATE agents
        SET bank_account_number = '999999999',
            kyc_status = 'verified'
      WHERE id = $1
      RETURNING bank_account_number, kyc_status`,
    [agent_id]
  );
  if (rowCount > 0) {
    console.log('CRITICAL: authenticated session as agent CAN update bank_account_number + kyc_status');
    console.log('result:', JSON.stringify(r[0]));
  } else {
    console.log('GOOD: UPDATE returned 0 rows (RLS blocked)');
  }
  await client.query('ROLLBACK');
  console.log('(rolled back)');
} catch (err) {
  console.log('GOOD: UPDATE rejected');
  console.log('error:', err.message);
  await client.query('ROLLBACK').catch(() => {});
} finally {
  await client.end();
}
