/**
 * One-off: regenerate Century 21 Choice Realty's brokerage logo with the
 * tightened generator so the live brokerage portal shows the new layout for
 * verification. Re-uploads to the same storage path the brokerages.logo_url
 * already points to and bumps the `?t=` cache buster on the row.
 *
 * Run: npx tsx scripts/regenerate-choice-advances-logo.mts
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
  // Find the Choice Advances brokerage (Century 21 Choice Realty in the test
  // account). We can match on either the legal name (brokerages.name) or
  // the brand. Bud's test seat reports the display name as "Choice Advances".
  const { data: rows, error } = await supabase
    .from('brokerages')
    .select('id, name, brand, logo_url, logo_includes_tagline')
    .or('name.ilike.%choice%,brand.ilike.%choice%')
  if (error) {
    console.error('Query error:', error.message)
    process.exit(1)
  }
  if (!rows?.length) {
    console.error('No brokerage matched "choice"')
    process.exit(1)
  }
  console.log('Matched brokerages:')
  for (const r of rows) {
    console.log(` - ${r.id} ${r.name} (brand=${r.brand}) logo_url=${r.logo_url?.slice(0, 100)}`)
  }

  // Regenerate for every matched brokerage. The wordmark uses the brokerage
  // `name` (e.g. "Choice Advances"); `brand` is "Century 21" (the parent
  // franchise label) and isn't what the logo wordmark should show.
  for (const r of rows) {
    const displayName = r.name.trim()
    const svg = generateBrokerageLogoSvg(displayName, { background: 'transparent' })
    const path = `${r.id}/logo-generated.svg`
    const { error: uploadErr } = await supabase.storage
      .from('brokerage-logos')
      .upload(path, new Blob([svg], { type: 'image/svg+xml' }), { upsert: true, contentType: 'image/svg+xml' })
    if (uploadErr) {
      console.error(`Upload failed for ${r.id}: ${uploadErr.message}`)
      continue
    }
    const { data: { publicUrl } } = supabase.storage.from('brokerage-logos').getPublicUrl(path)
    const newUrl = `${publicUrl}?t=${Date.now()}`
    const { error: updateErr } = await supabase
      .from('brokerages')
      .update({ logo_url: newUrl, logo_includes_tagline: true })
      .eq('id', r.id)
    if (updateErr) {
      console.error(`Update failed for ${r.id}: ${updateErr.message}`)
      continue
    }
    console.log(`✓ regenerated logo for ${r.name} (${displayName}) → ${newUrl}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
