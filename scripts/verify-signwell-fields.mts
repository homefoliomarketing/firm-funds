/**
 * scripts/verify-signwell-fields.mts
 *
 * LIVE validation that SignWell parses our embedded text tags into the fields we
 * expect: one INITIAL on every page (via the repeating footer tag) plus a
 * SIGNATURE + auto-date at the end of each document.
 *
 * Generates the real CPA + IDP in SignWell mode, creates a SignWell document
 * with test_mode:true + draft:true (free, unbilled, sends NO email), POLLS until
 * SignWell finishes converting + parsing (pages_number > 0), prints a per-page
 * field breakdown, then DELETES the draft.
 *
 *   npx tsx scripts/verify-signwell-fields.mts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.ESIGN_PROVIDER = 'signwell'
const { generateCpaDocx, generateIdpDocx, generateBcaDocx } = await import('../lib/contract-docx')

const API_BASE = 'https://www.signwell.com/api/v1'

function readEnvLocal(key: string): string | undefined {
  let raw = ''
  try { raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8') } catch { return undefined }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '').trim()
  }
  return undefined
}

const apiKey = readEnvLocal('SIGNWELL_API_KEY')
if (!apiKey) { console.error('Missing SIGNWELL_API_KEY in .env.local'); process.exit(1) }
const appId = readEnvLocal('SIGNWELL_API_APPLICATION_ID') || '045510cd-b609-4c84-88b3-6a752599185c'

const sample: Record<string, string> = {
  '{{DEAL_NUMBER}}': 'TEST-0610-26',
  '{{AGENT_FULL_LEGAL_NAME}}': 'Test Agent',
  '{{PROPERTY_ADDRESS}}': '123 Test Street, Sault Ste. Marie, ON',
}

type DocObj = {
  id?: string
  status?: string
  files?: { name?: string; pages_number?: number }[]
  fields?: unknown
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getDoc(id: string): Promise<DocObj> {
  const r = await fetch(`${API_BASE}/documents/${encodeURIComponent(id)}`, {
    headers: { 'X-Api-Key': apiKey as string },
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`GET ${r.status}: ${t}`)
  return JSON.parse(t) as DocObj
}

function summarizeFile(fileIdx: number, arr: unknown, pages: number | string) {
  if (!Array.isArray(arr)) { console.log(`  file[${fileIdx}] fields: (none / not an array)`); return }
  const byType: Record<string, number[]> = {}
  for (const f of arr as Array<Record<string, unknown>>) {
    const t = String(f.type ?? '?')
    const p = Number(f.page ?? -1)
    ;(byType[t] ??= []).push(p)
  }
  console.log(`\n  file[${fileIdx}] (${pages} pages) parsed fields:`)
  for (const [t, ps] of Object.entries(byType)) {
    ps.sort((a, b) => a - b)
    console.log(`    ${t.padEnd(22)} ${ps.length}x  on pages [${ps.join(', ')}]`)
  }
}

async function validate(label: string, files: { name: string; file_base64: string }[]) {
  console.log(`\n##################### ${label} #####################`)
  const body = {
    test_mode: true,
    draft: true, // created but NOT sent -> no email, no charge
    text_tags: true,
    api_application_id: appId,
    name: `FIELD VALIDATION (${label}) — delete me`,
    subject: 'validation',
    message: 'validation',
    recipients: [{ id: '1', email: 'homefoliomarketing@gmail.com', name: 'Test Agent' }],
    files,
  }

  const res = await fetch(`${API_BASE}/documents`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey as string, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) { console.error(`\nSignWell error ${res.status}:\n${text}\n`); return }

  const created = JSON.parse(text) as DocObj
  const docId = created.id
  if (!docId) { console.error('No document id in response'); return }
  console.log(`Created ${docId} (status ${created.status}). Polling until field count stabilizes...`)

  let doc = created
  let stableCount = -1
  let stableStreak = 0
  for (let i = 0; i < 24; i++) {
    await sleep(2500)
    try { doc = await getDoc(docId) } catch (e) { console.log(`  poll ${i + 1}: ${(e as Error).message}`); continue }
    const pages = (doc.files ?? []).map((f) => f.pages_number ?? 0)
    const fieldCount = Array.isArray(doc.fields)
      ? (doc.fields as unknown[]).reduce((sum: number, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0)
      : 0
    console.log(`  poll ${i + 1}: status ${doc.status}, pages ${JSON.stringify(pages)}, fields ${fieldCount}`)
    if (doc.status === 'Sent' || doc.status === 'Sending') { console.log('  (draft not honored — stopping before it emails)'); break }
    const ready = pages.length > 0 && pages.every((p) => p > 0)
    if (ready && fieldCount > 0) {
      if (fieldCount === stableCount) { stableStreak++; if (stableStreak >= 2) break }
      else { stableCount = fieldCount; stableStreak = 0 }
    }
  }

  const docFiles = doc.files ?? []
  console.log(`\nFinal status: ${doc.status}`)
  docFiles.forEach((f, i) => console.log(`  file[${i}] ${f.name} -> ${f.pages_number} pages`))

  console.log('\n=== Parsed field breakdown ===')
  const fields = doc.fields
  if (Array.isArray(fields)) {
    ;(fields as unknown[]).forEach((arr, i) => summarizeFile(i, arr, docFiles[i]?.pages_number ?? '?'))
  } else {
    console.log('fields was not a 2-D array; raw value:')
    console.log(JSON.stringify(fields, null, 2)?.slice(0, 3000))
  }

  const del = await fetch(`${API_BASE}/documents/${encodeURIComponent(docId)}`, {
    method: 'DELETE',
    headers: { 'X-Api-Key': apiKey as string },
  })
  console.log(`\nCleanup: deleted draft (${del.status}).`)
}

const cpa = await generateCpaDocx(sample)
const idp = await generateIdpDocx(sample)
const bca = await generateBcaDocx(sample)

// Deal packet: CPA + IDP bundled into one document (production behavior).
await validate('DEAL PACKET: CPA + IDP', [
  { name: 'Commission Purchase Agreement.docx', file_base64: cpa.toString('base64') },
  { name: 'Irrevocable Direction to Pay.docx', file_base64: idp.toString('base64') },
])

// BCA: sent on its own (brokerage-level, signer is the Broker of Record).
await validate('BCA', [
  { name: 'Brokerage Cooperation Agreement.docx', file_base64: bca.toString('base64') },
])
