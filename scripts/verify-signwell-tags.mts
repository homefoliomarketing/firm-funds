/**
 * scripts/verify-signwell-tags.mts
 *
 * STATIC verification that the contract generators embed the right e-signature
 * field markers for each provider. It generates the CPA/IDP/BCA .docx in both
 * ESIGN_PROVIDER modes, unzips each in-memory, and counts the SignWell text
 * tags ({{signature}}, {{initial}}, {{autofill_date_signed}}) vs the legacy
 * DocuSign anchors (/sig1/, /dat1/, /ini1/), reporting which part file (body
 * document.xml vs a footer*.xml) each lands in.
 *
 * This proves the tags are PRESENT, HIDDEN, and POSITIONED. It does NOT prove
 * SignWell parses them — that's the separate live test_mode send.
 *
 *   npx tsx scripts/verify-signwell-tags.mts
 */
import JSZip from 'jszip'
import { generateCpaDocx, generateIdpDocx, generateBcaDocx } from '../lib/contract-docx'

type Gen = (data: Record<string, string>) => Promise<Buffer>

const PATTERNS = [
  '{{signature',
  '{{autofill_date_signed',
  '{{initial',
  '/sig1/',
  '/dat1/',
  '/ini1/',
]

async function inspect(name: string, gen: Gen) {
  const buf = await gen({})
  const zip = await JSZip.loadAsync(buf)
  // Map: pattern -> { part -> count }
  const hits: Record<string, Record<string, number>> = {}
  for (const p of PATTERNS) hits[p] = {}
  for (const partName of Object.keys(zip.files)) {
    if (!partName.endsWith('.xml')) continue
    const xml = await zip.files[partName].async('string')
    for (const p of PATTERNS) {
      let idx = 0
      let count = 0
      while ((idx = xml.indexOf(p, idx)) !== -1) {
        count++
        idx += p.length
      }
      if (count > 0) hits[p][partName] = count
    }
  }
  console.log(`\n=== ${name} ===`)
  for (const p of PATTERNS) {
    const parts = hits[p]
    const total = Object.values(parts).reduce((a, b) => a + b, 0)
    if (total === 0) continue
    const where = Object.entries(parts).map(([f, c]) => `${f}×${c}`).join(', ')
    console.log(`  ${p.padEnd(26)} total ${total}   in: ${where}`)
  }
}

async function main() {
  // The generators call getEsignProvider() at generation time (inside the
  // shared helpers), so flipping process.env before each call is enough — no
  // re-import needed.
  for (const provider of ['signwell', 'docusign'] as const) {
    process.env.ESIGN_PROVIDER = provider
    console.log(`\n############ ESIGN_PROVIDER=${provider} ############`)
    await inspect('CPA', generateCpaDocx)
    await inspect('IDP', generateIdpDocx)
    await inspect('BCA', generateBcaDocx)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
