/**
 * scripts/signwell-register-webhook.mjs
 * Lists SignWell webhooks and registers our production callback if absent.
 * Prints the webhook id, which becomes SIGNWELL_WEBHOOK_ID (the HMAC key).
 *   node scripts/signwell-register-webhook.mjs
 */
import { readFileSync } from 'node:fs'

function envLocal(key) {
  const raw = readFileSync('.env.local', 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '').trim()
  }
  return undefined
}

const apiKey = envLocal('SIGNWELL_API_KEY')
if (!apiKey) { console.error('Missing SIGNWELL_API_KEY'); process.exit(1) }
const appId = envLocal('SIGNWELL_API_APPLICATION_ID') || '045510cd-b609-4c84-88b3-6a752599185c'
const BASE = 'https://www.signwell.com/api/v1'
const CALLBACK = 'https://firmfunds.ca/api/signwell/webhook'

const listRes = await fetch(`${BASE}/hooks`, { headers: { 'X-Api-Key': apiKey } })
const listText = await listRes.text()
console.log(`GET /hooks -> ${listRes.status}`)
let parsed
try { parsed = JSON.parse(listText) } catch { parsed = null }
const hooks = Array.isArray(parsed)
  ? parsed
  : Array.isArray(parsed?.hooks) ? parsed.hooks
  : Array.isArray(parsed?.data) ? parsed.data
  : []
console.log(`Existing hooks: ${JSON.stringify(hooks)}`)

const existing = hooks.find((h) => h?.callback_url === CALLBACK)
if (existing) {
  console.log(`\nALREADY REGISTERED. SIGNWELL_WEBHOOK_ID=${existing.id}`)
  process.exit(0)
}

const res = await fetch(`${BASE}/hooks`, {
  method: 'POST',
  headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ callback_url: CALLBACK, api_application_id: appId }),
})
const text = await res.text()
if (!res.ok) { console.error(`POST /hooks failed ${res.status}: ${text}`); process.exit(1) }
const j = JSON.parse(text)
console.log(`\nREGISTERED. SIGNWELL_WEBHOOK_ID=${j.id}`)
console.log(`callback_url=${j.callback_url}`)
