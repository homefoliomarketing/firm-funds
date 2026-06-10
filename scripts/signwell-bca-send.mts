/**
 * scripts/signwell-bca-send.mts
 *
 * Headless equivalent of admin "Send BCA for Signature" — faithful copy of
 * lib/actions/esign-actions.ts::sendBcaForSignature (SignWell branch). Same
 * generator (generateBcaDocx), same SignWell client, same single bca envelope
 * row. Signer is the brokerage's Broker of Record.
 *
 *   npx tsx scripts/signwell-bca-send.mts <brokerageId>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
process.env.ESIGN_PROVIDER = 'signwell'

const { generateBcaDocx } = await import('../lib/contract-docx')
const { sendSignWellDocument } = await import('../lib/signwell')
const {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  SETTLEMENT_PERIOD_DAYS,
  LATE_INTEREST_GRACE_DAYS_FROM_CLOSING,
  BROKERAGE_LATE_STRIKE_THRESHOLD,
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
} = await import('../lib/constants')

const ADMIN_ID = '056bc7d7-96a1-4fa5-9b6f-043bdd46d49a'
const brokerageId = process.argv[2]
if (!brokerageId) { console.error('Usage: npx tsx scripts/signwell-bca-send.mts <brokerageId>'); process.exit(1) }

const num = (v: unknown) => Number(v ?? 0)
const fmtDate = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

const brokerage = (await client.query(`SELECT * FROM brokerages WHERE id = $1`, [brokerageId])).rows[0]
if (!brokerage) { console.error('Brokerage not found'); process.exit(1) }
if (!brokerage.broker_of_record_email) { console.error('Brokerage has no broker_of_record_email'); process.exit(1) }
if (!brokerage.broker_of_record_name) { console.error('Brokerage has no broker_of_record_name'); process.exit(1) }

const active = (await client.query(
  `SELECT id FROM esignature_envelopes WHERE brokerage_id = $1 AND document_type = 'bca' AND status IN ('sent','delivered')`, [brokerageId])).rows
if (active.length) { console.error('Brokerage already has a pending BCA. Void it first.'); process.exit(1) }

const today = new Date().toISOString().slice(0, 10)
const referralPct = brokerage.referral_fee_percentage
const referralDisplay = referralPct !== null && referralPct !== undefined ? `${(num(referralPct) * 100).toFixed(0)}%` : '20%'

const contractData: Record<string, string> = {
  '{{AGREEMENT_DATE}}': fmtDate(today),
  '{{BROKERAGE_LEGAL_NAME}}': brokerage.name,
  '{{BROKERAGE_ADDRESS}}': [brokerage.address, brokerage.city, brokerage.province, brokerage.postal_code].filter(Boolean).join(', ') || 'On file',
  '{{BROKER_OF_RECORD}}': brokerage.broker_of_record_name,
  '{{BROKERAGE_EMAIL}}': brokerage.email,
  '{{BROKERAGE_PHONE}}': brokerage.phone || 'On file',
  '{{REFERRAL_FEE_PCT}}': referralDisplay,
  '{{SETTLEMENT_PERIOD_DAYS}}': String(SETTLEMENT_PERIOD_DAYS),
  '{{LATE_STRIKE_THRESHOLD}}': String(BROKERAGE_LATE_STRIKE_THRESHOLD),
  '{{BUMPED_SETTLEMENT_DAYS}}': String(BROKERAGE_BUMPED_SETTLEMENT_DAYS),
  '{{LATE_INTEREST_GRACE_DAYS}}': String(LATE_INTEREST_GRACE_DAYS_FROM_CLOSING),
  '{{DISCOUNT_RATE}}': `$${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day`,
  '{{SIGNATURE_DATE}}': '',
}

const bcaBuffer = await generateBcaDocx(contractData)
const borFirstName = brokerage.broker_of_record_name.split(' ')[0] || 'there'
const emailSubject = `Firm Funds — Brokerage Cooperation Agreement: ${brokerage.name}`
const emailBlurb = `Hi ${borFirstName},\n\nFirm Funds Inc. has prepared a Brokerage Cooperation Agreement for ${brokerage.name}. This agreement establishes the partnership between your brokerage and Firm Funds for our Commission Purchase Program.\n\nPlease review and sign at your earliest convenience. If you have any questions, reply to this email or contact us at bud@firmfunds.ca.\n\nThank you,\n\n— The Firm Funds Team`

console.log(`Sending REAL (non-test) BCA to broker of record ${brokerage.broker_of_record_name} <${brokerage.broker_of_record_email}> ...`)
const result = await sendSignWellDocument({
  name: `Firm Funds — ${brokerage.name}`,
  subject: emailSubject,
  message: emailBlurb,
  files: [{ name: 'Brokerage Cooperation Agreement.docx', base64: bcaBuffer.toString('base64') }],
  recipients: [{ id: '1', email: brokerage.broker_of_record_email, name: brokerage.broker_of_record_name }],
  metadata: { brokerage_id: brokerageId },
})

await client.query(
  `INSERT INTO esignature_envelopes (brokerage_id, envelope_id, document_type, status, agent_signer_status, sent_by, envelope_uri)
   VALUES ($1,$2,'bca','sent','sent',$3,$4)`,
  [brokerageId, result.documentId, ADMIN_ID, result.signingUrls[0] ?? ''],
)

console.log('\nSent through the production client.')
console.log('  documentId :', result.documentId)
console.log('  status     :', result.status)
console.log('  signingUrl :', result.signingUrls[0] ?? '')
console.log('  bca envelope row inserted (brokerage_id', brokerageId + ')')
console.log('\nBroker-of-record inbox (' + brokerage.broker_of_record_email + ') now has the BCA signing email.')

await client.end()
