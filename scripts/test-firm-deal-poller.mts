/**
 * scripts/test-firm-deal-poller.mts
 *
 * Direct invocation of the poller logic without the HTTP cron route, so we
 * can verify end-to-end against a real brokerage_pipes row without spinning
 * up the dev server.
 *
 * Usage:
 *   npx tsx scripts/test-firm-deal-poller.mts
 */
import fs from 'node:fs'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

// Load .env.local manually so we don't need next/server context
const envText = fs.readFileSync('.env.local', 'utf8')
for (const line of envText.split('\n')) {
  if (!line || line.startsWith('#')) continue
  const eq = line.indexOf('=')
  if (eq < 0) continue
  const k = line.slice(0, eq)
  const v = line.slice(eq + 1)
  if (!process.env[k]) process.env[k] = v
}

const { pollSpreadsheetPipe } = await import('../lib/firm-deal-detection/poll-spreadsheet')

const supabase = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const { data: pipes, error } = await supabase
  .from('brokerage_pipes')
  .select('id, brokerage_id, pipe_type, config, last_poll_state')
  .eq('pipe_type', 'spreadsheet')
  .eq('enabled', true)

if (error) {
  console.error('Failed to load pipes:', error.message)
  process.exit(1)
}
if (!pipes || pipes.length === 0) {
  console.error('No enabled spreadsheet pipes. Run seed-choice-realty-pipe.mjs first.')
  process.exit(1)
}

for (const pipe of pipes) {
  console.log(`\nPolling pipe ${pipe.id} (brokerage ${pipe.brokerage_id}) ...`)
  const result = await pollSpreadsheetPipe(
    {
      id: pipe.id,
      brokerage_id: pipe.brokerage_id,
      pipe_type: pipe.pipe_type as 'spreadsheet',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: pipe.config as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      last_poll_state: pipe.last_poll_state as any,
    },
    supabase
  )
  console.log(JSON.stringify(result, null, 2))
}
