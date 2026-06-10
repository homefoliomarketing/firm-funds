/**
 * scripts/signwell-dress-send.mts
 *
 * Headless equivalent of the admin "Send for Signature" button for the SignWell
 * dress rehearsal, used only because the operator cannot type the admin password
 * into the login form. It mirrors lib/actions/esign-actions.ts::sendForSignature
 * field-for-field: SAME production doc generators (lib/contract-docx), SAME
 * production SignWell client (lib/signwell), SAME esignature_envelopes rows.
 *
 * The resulting SignWell document + DB envelope rows are indistinguishable from a
 * real UI send, so signing it fires the real production webhook exactly as a
 * normal deal would.
 *
 *   npx tsx scripts/signwell-dress-send.mts <dealId>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

// tsx doesn't auto-load .env.local; lib/signwell.ts reads process.env.
const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
process.env.ESIGN_PROVIDER = 'signwell'

const { generateCpaDocx, generateIdpDocx } = await import('../lib/contract-docx')
const { sendSignWellDocument } = await import('../lib/signwell')
const { getChargeDays } = await import('../lib/calculations')
const {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  SETTLEMENT_PERIOD_DAYS,
  LATE_INTEREST_GRACE_DAYS_FROM_CLOSING,
  LATE_INTEREST_RATE_PER_ANNUM,
  BROKERAGE_LATE_STRIKE_THRESHOLD,
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
} = await import('../lib/constants')

const ADMIN_ID = '056bc7d7-96a1-4fa5-9b6f-043bdd46d49a' // bud@firmfunds.ca (sent_by)
const dealId = process.argv[2]
if (!dealId) { console.error('Usage: npx tsx scripts/signwell-dress-send.mts <dealId>'); process.exit(1) }

// node-postgres returns `numeric` columns as strings — coerce before math.
const num = (v: unknown) => Number(v ?? 0)
const fmtCurrency = (n: unknown) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(num(n))
const fmtDate = (s: string) =>
  new Date(s + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
const dateOnly = (v: unknown) => (v == null ? null : new Date(v as string).toISOString().slice(0, 10))

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

const deal = (await client.query(`SELECT * FROM deals WHERE id = $1`, [dealId])).rows[0]
if (!deal) { console.error('Deal not found'); process.exit(1) }
if (deal.status !== 'approved') { console.error(`Deal must be approved, is "${deal.status}"`); process.exit(1) }
const agent = (await client.query(`SELECT * FROM agents WHERE id = $1`, [deal.agent_id])).rows[0]
const brokerage = (await client.query(`SELECT * FROM brokerages WHERE id = $1`, [deal.brokerage_id])).rows[0]
if (!agent?.email) { console.error('Agent has no email'); process.exit(1) }

const active = (await client.query(
  `SELECT id FROM esignature_envelopes WHERE deal_id = $1 AND status IN ('sent','delivered')`, [dealId])).rows
if (active.length) { console.error('Deal already has pending envelopes. Void them first.'); process.exit(1) }

const agentName = `${agent.first_name} ${agent.last_name}`
const today = new Date().toISOString().slice(0, 10)
const closing = dateOnly(deal.closing_date)!
const dealSettlementDays = deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS

const contractData: Record<string, string> = {
  '{{AGREEMENT_DATE}}': fmtDate(today),
  '{{DEAL_NUMBER}}': deal.deal_number || 'N/A',
  '{{AGENT_FULL_LEGAL_NAME}}': agentName,
  '{{FACE_VALUE}}': fmtCurrency(deal.net_commission),
  '{{PURCHASE_DISCOUNT}}': fmtCurrency(deal.discount_fee),
  '{{SETTLEMENT_PERIOD_FEE}}': fmtCurrency(deal.settlement_period_fee || 0),
  '{{TOTAL_FEES}}': fmtCurrency(num(deal.discount_fee) + num(deal.settlement_period_fee)),
  '{{NUMBER_OF_DAYS}}': deal.days_until_closing ? getChargeDays(num(deal.days_until_closing)).toString() : 'N/A',
  '{{SETTLEMENT_PERIOD_DAYS}}': String(dealSettlementDays),
  '{{LATE_INTEREST_GRACE_DAYS}}': String(LATE_INTEREST_GRACE_DAYS_FROM_CLOSING),
  '{{LATE_STRIKE_THRESHOLD}}': String(BROKERAGE_LATE_STRIKE_THRESHOLD),
  '{{BUMPED_SETTLEMENT_DAYS}}': String(BROKERAGE_BUMPED_SETTLEMENT_DAYS),
  '{{DISCOUNT_RATE}}': `$${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day`,
  '{{PURCHASE_PRICE}}': fmtCurrency(deal.advance_amount),
  '{{PROPERTY_ADDRESS}}': deal.property_address,
  '{{MLS_NUMBER}}': 'See APS',
  '{{EXPECTED_CLOSING_DATE}}': fmtDate(closing),
  '{{DUE_DATE}}': deal.due_date ? fmtDate(dateOnly(deal.due_date)!) : `Closing Date + ${dealSettlementDays} days`,
  '{{LATE_INTEREST_RATE}}': `${(LATE_INTEREST_RATE_PER_ANNUM * 100).toFixed(0)}%`,
  '{{BROKERAGE_LEGAL_NAME}}': brokerage.name,
  '{{BROKERAGE_ADDRESS}}': [brokerage.address, brokerage.city, brokerage.province, brokerage.postal_code].filter(Boolean).join(', ') || 'On file',
  '{{BROKER_OF_RECORD}}': brokerage.broker_of_record_name || 'On file',
  '{{BROKERAGE_REFERRAL_FEE}}': fmtCurrency(deal.brokerage_referral_fee),
  '{{BROKERAGE_SPLIT}}': num(deal.brokerage_split_pct).toFixed(1),
  '{{GROSS_COMMISSION_RATE}}': 'See Trade Record',
  '{{GROSS_COMMISSION_AMOUNT}}': fmtCurrency(deal.gross_commission),
  '{{RECO_REGISTRATION_NUMBER}}': agent.reco_number || 'On file',
  '{{AGENT_EMAIL}}': agent.email,
  '{{AGENT_PHONE}}': agent.phone || 'On file',
  '{{AGENT_ADDRESS}}': [agent.address_street, agent.address_city, agent.address_province, agent.address_postal_code].filter(Boolean).join(', ') || 'On file',
  '{{SIGNATURE_DATE}}': '',
  '{{DIRECTED_AMOUNT}}': fmtCurrency(deal.net_commission),
  '{{AGENT_BANK_NAME}}': 'On file',
  '{{AGENT_TRANSIT}}': agent.bank_transit_number || 'On file',
  '{{AGENT_ACCOUNT}}': agent.bank_account_number || 'On file',
  '{{AGENT_ACCOUNT_HOLDER}}': agentName,
  '{{PURCHASER_BANK_NAME}}': 'On file with Firm Funds',
  '{{PURCHASER_TRANSIT}}': 'On file',
  '{{PURCHASER_ACCOUNT}}': 'On file',
  '{{BCA_DATE}}': brokerage.bca_signed_at ? fmtDate(dateOnly(brokerage.bca_signed_at)!) : 'On file',
  '{{BUYER_NAMES}}': 'See APS',
  '{{CLIENT_NAMES}}': 'See APS',
  '{{APS_DATE}}': 'See APS',
  '{{PROPERTY_PURCHASE_PRICE}}': 'See APS',
  '{{LISTING_OR_COOPERATING}}': 'See Trade Record',
  '{{DEPOSIT_BROKERAGE}}': 'See APS',
  '{{DEPOSIT_COOP}}': 'N/A',
}

const cpaBuffer = await generateCpaDocx(contractData)
const idpBuffer = await generateIdpDocx(contractData)

const agentFirstName = agent.first_name || 'there'
const emailSubject = `Firm Funds — Signature Required: ${deal.property_address}`
const emailBlurb = `Hi ${agentFirstName},\n\nFirm Funds Inc. has prepared your Commission Purchase Agreement and Irrevocable Direction to Pay for the property at ${deal.property_address}.\n\nPlease review and sign both documents at your earliest convenience. If you have any questions, reply to this email or contact us at bud@firmfunds.ca.\n\nThank you for choosing Firm Funds.\n\n— The Firm Funds Team`

console.log(`Sending REAL (non-test) SignWell packet for deal ${deal.deal_number} to ${agentName} <${agent.email}> ...`)
const result = await sendSignWellDocument({
  name: `Firm Funds — ${deal.property_address}`,
  subject: emailSubject,
  message: emailBlurb,
  files: [
    { name: 'Commission Purchase Agreement.docx', base64: cpaBuffer.toString('base64') },
    { name: 'Irrevocable Direction to Pay.docx', base64: idpBuffer.toString('base64') },
  ],
  recipients: [{ id: '1', email: agent.email, name: agentName }],
  metadata: { deal_id: dealId, deal_number: deal.deal_number ?? '' },
  // testMode omitted → false → real binding document that fires the webhook.
})

const envelopeId = result.documentId
const envelopeUri = result.signingUrls[0] ?? ''

for (const document_type of ['cpa', 'idp'] as const) {
  await client.query(
    `INSERT INTO esignature_envelopes (deal_id, envelope_id, document_type, status, agent_signer_status, sent_by, envelope_uri)
     VALUES ($1,$2,$3,'sent','sent',$4,$5)`,
    [dealId, envelopeId, document_type, ADMIN_ID, envelopeUri],
  )
}

await client.query(
  `INSERT INTO audit_log (action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4)`,
  ['esignature.sent', 'deal', dealId, JSON.stringify({ envelopeId, agentEmail: agent.email, agentName, via: 'dress-rehearsal script' })],
).catch((e) => console.warn('(audit_log insert skipped:', e.message, ')'))

console.log('\nSent through the production client.')
console.log('  documentId :', envelopeId)
console.log('  status     :', result.status)
console.log('  pages/file :', JSON.stringify(result.pagesPerFile))
console.log('  signingUrl :', envelopeUri)
console.log('  envelope rows inserted: cpa + idp (deal_id', dealId + ')')
console.log('\nThe agent inbox (' + agent.email + ') now has the branded signing email.')

await client.end()
