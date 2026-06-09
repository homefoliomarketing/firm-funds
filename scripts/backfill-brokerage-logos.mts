/**
 * Backfill: generate + store an advance-division logo for every brokerage that
 * has a null/empty logo_url. Generates the SVG from the brokerage name, uploads
 * it to the brokerage-logos bucket at `${id}/logo-generated.svg`, and sets
 * brokerages.logo_url + logo_includes_tagline=true.
 *
 * Why: logo generation was a manual admin step ("Generate Logo" button), so any
 * brokerage onboarded without that click ended up with logo_url = NULL. The
 * agent/brokerage portals then fell back to the bare Firm Funds wordmark, and
 * email/OG surfaces (which can only reference a stored URL) had no brand. The
 * portal now also falls back to an on-the-fly generated logo, but this backfill
 * makes the STORED data correct so every surface is consistent.
 *
 * Idempotent: only touches rows where logo_url IS NULL or ''. Re-runnable.
 *
 * Run: npx tsx scripts/backfill-brokerage-logos.mts
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { generateBrokerageLogoSvg } from '../lib/brokerage-logo-generator'

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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

async function main() {
  // All brokerages missing a logo. (Supabase treats '' and NULL distinctly, so
  // match both.)
  const { data: rows, error } = await supabase
    .from('brokerages')
    .select('id, name, logo_url')
    .or('logo_url.is.null,logo_url.eq.')
    .order('name')
  if (error) {
    console.error('Query error:', error.message)
    process.exit(1)
  }
  if (!rows?.length) {
    console.log('No brokerages missing a logo. Nothing to do.')
    return
  }

  console.log(`${rows.length} brokerage(s) missing a logo:`)
  for (const r of rows) console.log(` - ${r.name} (${r.id})`)
  console.log('')

  let ok = 0
  for (const r of rows) {
    const displayName = (r.name ?? '').trim()
    if (!displayName) {
      console.warn(`! skipping ${r.id}: no name`)
      continue
    }
    const svg = generateBrokerageLogoSvg(displayName, { background: 'transparent' })
    const path = `${r.id}/logo-generated.svg`
    const { error: uploadErr } = await supabase.storage
      .from('brokerage-logos')
      .upload(path, new Blob([svg], { type: 'image/svg+xml' }), { upsert: true, contentType: 'image/svg+xml' })
    if (uploadErr) {
      console.error(`! upload failed for ${displayName}: ${uploadErr.message}`)
      continue
    }
    const { data: { publicUrl } } = supabase.storage.from('brokerage-logos').getPublicUrl(path)
    const newUrl = `${publicUrl}?t=${Date.now()}`
    const { error: updateErr } = await supabase
      .from('brokerages')
      .update({ logo_url: newUrl, logo_includes_tagline: true })
      .eq('id', r.id)
    if (updateErr) {
      console.error(`! update failed for ${displayName}: ${updateErr.message}`)
      continue
    }
    console.log(`✓ ${displayName} → ${newUrl}`)
    ok++
  }
  console.log(`\nDone. Backfilled ${ok}/${rows.length}.`)
}

main().catch(e => { console.error(e); process.exit(1) })
