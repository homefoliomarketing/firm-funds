/**
 * scripts/signwell-test-send.mts
 *
 * Fires ONE real test_mode (non-binding, free) branded SignWell send of the
 * CPA + IDP deal packet to a recipient, THROUGH the production lib/signwell.ts
 * client, so we can see the branded email + per-page initials + end signature in
 * the actual signing experience. Does NOT delete the document (open it from your
 * inbox).
 *
 *   npx tsx scripts/signwell-test-send.mts homefoliomarketing@gmail.com "Bud Jones"
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// tsx doesn't auto-load .env.local, and lib/signwell.ts reads from process.env,
// so load the file into process.env first (without clobbering anything preset).
const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
process.env.ESIGN_PROVIDER = 'signwell'

const { generateCpaDocx, generateIdpDocx } = await import('../lib/contract-docx')
const { sendSignWellDocument } = await import('../lib/signwell')

const email = process.argv[2] || 'homefoliomarketing@gmail.com'
const name = process.argv[3] || 'Bud Jones'

const sample: Record<string, string> = {
  '{{DEAL_NUMBER}}': 'TEST-0610-26',
  '{{AGENT_FULL_LEGAL_NAME}}': name,
  '{{PROPERTY_ADDRESS}}': '123 Test Street, Sault Ste. Marie, ON',
}

const cpa = await generateCpaDocx(sample)
const idp = await generateIdpDocx(sample)

console.log(`Sending branded test_mode packet to ${name} <${email}> ...`)
const result = await sendSignWellDocument({
  name: 'Firm Funds — Test Signing Packet (test mode)',
  subject: 'Firm Funds: please review and sign (test)',
  message:
    'This is a NON-BINDING test of the Firm Funds signing experience. Feel free to open and sign it; it has no legal effect.',
  files: [
    { name: 'Commission Purchase Agreement.docx', base64: cpa.toString('base64') },
    { name: 'Irrevocable Direction to Pay.docx', base64: idp.toString('base64') },
  ],
  recipients: [{ id: '1', email, name }],
  metadata: { purpose: 'branding+field visual check' },
  testMode: true,
})

console.log('\nSent through the production client.')
console.log('  documentId :', result.documentId)
console.log('  status     :', result.status)
console.log('  pages/file :', JSON.stringify(result.pagesPerFile), '(0s are normal — SignWell paginates after the POST)')
console.log('  signingUrls:', JSON.stringify(result.signingUrls))
console.log('\nCheck your inbox. Open the email to see the green logo, the initials on every page, and the signature at the end.')
