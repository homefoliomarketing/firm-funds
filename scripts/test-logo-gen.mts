/**
 * Quick test of the brokerage logo generator.
 * Run: npx tsx scripts/test-logo-gen.mts
 * Outputs SVGs to public/mockups/generated/
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { generateBrokerageLogoSvg } from '../lib/brokerage-logo-generator'

const NAMES = [
  'Choice Advances',
  'Fusion Advances',
  'First Canadian Advances',
  'Leading Edge Advances',
  'Integrity Advances',
  'Millennium Advances',
]

const outDir = join(process.cwd(), 'public', 'mockups', 'generated')
mkdirSync(outDir, { recursive: true })

// Build a single HTML preview page that loads all generated SVGs
const cards: string[] = []
for (const name of NAMES) {
  for (const bg of ['dark', 'light'] as const) {
    const svg = generateBrokerageLogoSvg(name, { background: bg })
    const slug = name.toLowerCase().replace(/\s+/g, '-')
    const file = `${slug}-${bg}.svg`
    writeFileSync(join(outDir, file), svg, 'utf8')
    console.log(`wrote ${file}`)
  }
  const slug = name.toLowerCase().replace(/\s+/g, '-')
  cards.push(`
  <div class="card">
    <div class="card-header">${name}</div>
    <div class="card-body">
      <div class="stage dark"><img src="${slug}-dark.svg" alt="${name} dark" /></div>
      <div class="stage light"><img src="${slug}-light.svg" alt="${name} light" /></div>
    </div>
  </div>`)
}

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Generated Logos Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-sans-serif, system-ui; background: #0a0a0a; color: #e5e5e5; padding: 32px; }
  h1 { color: #fff; margin-bottom: 24px; font-size: 24px; }
  .card { background: #141414; border: 1px solid #262626; border-radius: 12px; overflow: hidden; margin-bottom: 16px; }
  .card-header { padding: 12px 18px; border-bottom: 1px solid #262626; font-weight: 600; color: #fff; font-size: 14px; }
  .card-body { display: grid; grid-template-columns: 1fr 1fr; }
  .stage { padding: 40px 24px; display: flex; align-items: center; justify-content: center; min-height: 240px; }
  .stage.dark { background: #0a0a0a; }
  .stage.light { background: #ffffff; }
  .stage img { max-width: 100%; height: auto; display: block; }
</style></head><body>
<h1>Generated logos — output of <code>lib/brokerage-logo-generator.ts</code></h1>
${cards.join('\n')}
</body></html>`

writeFileSync(join(outDir, 'index.html'), html, 'utf8')
console.log(`wrote index.html`)
console.log(`\nView at: http://localhost:3000/mockups/generated/index.html`)
