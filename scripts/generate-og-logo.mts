/**
 * Generate the social / SMS link-preview card image (PNG) for a brokerage's
 * white-label logo and store it on brokerages.og_image_url.
 *
 * Why: brokerages.logo_url is an SVG (auto-generated at onboarding). Messaging
 * apps will not render an SVG as an og:image, so the firm-deal offer link needs
 * a raster companion. This renders the on-file SVG with a real browser engine
 * (Edge headless, so the Big Shoulders web font resolves) onto a 1200x630 dark
 * card, uploads it to the brokerage-logos bucket as logo-og.png, and sets
 * og_image_url. Run after onboarding a white-label partner (or to backfill).
 *
 * Run:  npx tsx scripts/generate-og-logo.mts [brokerageId]
 *   - no arg  -> every is_white_label_partner brokerage with a logo_url
 *   - with id -> just that brokerage
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
 * and Microsoft Edge installed (Windows).
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

function loadDotEnv(file = '.env.local'): Record<string, string> {
  try {
    const raw = readFileSync(file, 'utf8')
    const out: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
      if (!m) continue
      let v = m[2]
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
      out[m[1]] = v
    }
    return out
  } catch { return {} }
}
const env = { ...loadDotEnv(), ...process.env }

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env')
  process.exit(1)
}

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
function findEdge(): string {
  for (const p of EDGE_CANDIDATES) {
    try { readFileSync(p); return p } catch { /* not here */ }
  }
  console.error('Could not find msedge.exe in the usual locations.')
  process.exit(1)
}
const EDGE = findEdge()

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const OG_W = 1200
const OG_H = 630

function wrapperHtml(svg: string): string {
  // Dark card matching the offer splash. The transparent-variant logo
  // (light-grey F-mark + green wordmark + light-grey tagline) pops on dark.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    .wrap{width:${OG_W}px;height:${OG_H}px;background:#0b1220;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:80px}
    .wrap svg{width:720px;height:auto;max-width:1000px;max-height:470px}
  </style></head><body><div class="wrap">${svg}</div></body></html>`
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function renderPng(svg: string, work: string): Promise<Buffer> {
  const htmlPath = join(work, 'card.html')
  const pngPath = join(work, 'card.png')
  writeFileSync(htmlPath, wrapperHtml(svg), 'utf8')
  try {
    execFileSync(EDGE, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      `--window-size=${OG_W},${OG_H}`,
      `--user-data-dir=${join(work, 'profile')}`,
      `--screenshot=${pngPath.replace(/\\/g, '/')}`,
      'file:///' + htmlPath.replace(/\\/g, '/'),
    ], { stdio: 'ignore', timeout: 60_000 })
  } catch {
    // Edge often detaches and the launcher exits 0 (or is reaped) before the
    // screenshot is flushed. We don't trust the exit; we poll for the file.
  }
  // Poll for the screenshot to land (the write races the process exit).
  const deadline = Date.now() + 20_000
  while (!existsSync(pngPath) && Date.now() < deadline) await sleep(250)
  if (!existsSync(pngPath)) throw new Error('Edge did not produce a screenshot')
  // Small settle so we read a fully-flushed file, not a partial one.
  await sleep(150)
  return readFileSync(pngPath)
}

async function processBrokerage(b: { id: string; name: string; logo_url: string | null }): Promise<void> {
  if (!b.logo_url) { console.warn(`- ${b.name}: no logo_url, skipping`); return }
  const work = mkdtempSync(join(tmpdir(), 'ff-og-'))
  try {
    const res = await fetch(b.logo_url)
    if (!res.ok) { console.error(`- ${b.name}: failed to fetch logo (${res.status})`); return }
    const svg = await res.text()
    if (!svg.includes('<svg')) { console.error(`- ${b.name}: logo_url is not an SVG, skipping`); return }

    const png = await renderPng(svg, work)
    const path = `${b.id}/logo-og.png`
    const { error: upErr } = await supabase.storage
      .from('brokerage-logos')
      .upload(path, png, { upsert: true, contentType: 'image/png' })
    if (upErr) { console.error(`- ${b.name}: upload failed: ${upErr.message}`); return }

    const { data: { publicUrl } } = supabase.storage.from('brokerage-logos').getPublicUrl(path)
    const ogUrl = `${publicUrl}?t=${Date.now()}`
    const { error: updErr } = await supabase
      .from('brokerages')
      .update({ og_image_url: ogUrl })
      .eq('id', b.id)
    if (updErr) { console.error(`- ${b.name}: db update failed: ${updErr.message}`); return }

    console.log(`✓ ${b.name} (${b.id}) -> ${ogUrl}  [${png.length} bytes]`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const idArg = process.argv[2]
  let query = supabase.from('brokerages').select('id, name, logo_url')
  query = idArg
    ? query.eq('id', idArg)
    : query.eq('is_white_label_partner', true).not('logo_url', 'is', null)

  const { data: rows, error } = await query
  if (error) { console.error('Query error:', error.message); process.exit(1) }
  if (!rows?.length) { console.error('No matching brokerages.'); process.exit(1) }

  console.log(`Generating OG card image for ${rows.length} brokerage(s):`)
  for (const b of rows) {
    await processBrokerage(b as { id: string; name: string; logo_url: string | null })
  }
}

main().catch(e => { console.error(e); process.exit(1) })
