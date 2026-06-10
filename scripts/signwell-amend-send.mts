/**
 * scripts/signwell-amend-send.mts
 *
 * Headless equivalent of admin "Send Amended CPA" — faithful copy of
 * lib/actions/esign-actions.ts::sendAmendedCpaForSignature (SignWell branch).
 * Same generator (generateCpaAmendmentDocx), same SignWell client, same single
 * cpa envelope row (document_type 'cpa', deal_id). Signer is the agent.
 *
 *   npx tsx scripts/signwell-amend-send.mts <dealId> <amendmentId>
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

const { generateCpaAmendmentDocx } = await import('../lib/contract-docx')
const { sendSignWellDocument } = await import('../lib/signwell')
const { getChargeDays } = await import('../lib/calculations')
const { DISCOUNT_RATE_PER_1000_PER_DAY, SETTLEMENT_PERIOD_DAYS, LATE_INTEREST_GRACE_DAYS_FROM_CLOSING } = await import('../lib/constants')

const ADMIN_ID = '056bc7d7-96a1-4fa5-9b6f-043bdd46d49a'
const [dealId, amendmentId] = [process.argv[2], process.argv[3]]
if (!dealId || !amendmentId) { console.error('Usage: npx tsx scripts/signwell-amend-send.mts <dealId> <amendmentId>'); process.exit(1) }

const num = (v: unknown) => Number(v ?? 0)
const fmtCurrency = (n: unknown) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(num(n))
const dateOnly = (v: unknown) => (v == null ? null : new Date(v as string).toISOString().slice(0, 10))
const fmtDate = (v: unknown) => { const d = dateOnly(v); return d ? new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A' }

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

const deal = (await client.query(`SELECT * FROM deals WHERE id = $1`, [dealId])).rows[0]
if (!deal) { console.error('Deal not found'); process.exit(1) }
const amendment = (await client.query(`SELECT * FROM closing_date_amendments WHERE id = $1`, [amendmentId])).rows[0]
if (!amendment) { console.error('Amendment not found'); process.exit(1) }
const agent = (await client.query(`SELECT * FROM agents WHERE id = $1`, [deal.agent_id])).rows[0]
if (!agent?.email) { console.error('Agent has no email'); process.exit(1) }

const agentName = `${agent.first_name} ${agent.last_name}`
const today = new Date().toISOString().slice(0, 10)
const newDiscount = num(amendment.new_discount_fee)
const newSettlementFee = num(amendment.new_settlement_period_fee)
const newPurchasePrice = num(amendment.new_advance_amount)
const oldPurchasePrice = num(amendment.old_advance_amount)
const oldDiscount = num(amendment.old_discount_fee)
const oldSettlementFee = num(amendment.old_settlement_period_fee)
const feeAdjustment = num(amendment.fee_adjustment_amount)
const scenario = amendment.adjustment_scenario || 'approved_recalc'
const fundingDate = dateOnly(deal.funding_date) || today
const rawDaysToClosing = Math.ceil((new Date(dateOnly(amendment.new_closing_date)! + 'T00:00:00Z').getTime() - new Date(fundingDate + 'T00:00:00Z').getTime()) / 86400000)
const newDaysNum = getChargeDays(rawDaysToClosing)

const contractData: Record<string, string> = {
  '{{AMENDMENT_DATE}}': fmtDate(today),
  '{{DEAL_NUMBER}}': deal.deal_number || 'N/A',
  '{{AGENT_FULL_LEGAL_NAME}}': agentName,
  '{{RECO_REGISTRATION_NUMBER}}': agent.reco_number || 'On file',
  '{{PROPERTY_ADDRESS}}': deal.property_address,
  '{{ORIGINAL_CPA_DATE}}': deal.funding_date ? fmtDate(deal.funding_date) : 'original date',
  '{{OLD_CLOSING_DATE}}': fmtDate(amendment.old_closing_date),
  '{{NEW_CLOSING_DATE}}': fmtDate(amendment.new_closing_date),
  '{{OLD_DUE_DATE}}': amendment.old_due_date ? fmtDate(amendment.old_due_date) : 'N/A',
  '{{NEW_DUE_DATE}}': amendment.new_due_date ? fmtDate(amendment.new_due_date) : 'N/A',
  '{{FACE_VALUE}}': fmtCurrency(deal.net_commission),
  '{{OLD_PURCHASE_DISCOUNT}}': fmtCurrency(oldDiscount),
  '{{NEW_PURCHASE_DISCOUNT}}': fmtCurrency(newDiscount),
  '{{OLD_SETTLEMENT_PERIOD_FEE}}': fmtCurrency(oldSettlementFee),
  '{{NEW_SETTLEMENT_PERIOD_FEE}}': fmtCurrency(newSettlementFee),
  '{{OLD_PURCHASE_PRICE}}': fmtCurrency(oldPurchasePrice),
  '{{NEW_PURCHASE_PRICE}}': fmtCurrency(newPurchasePrice),
  '{{NEW_NUMBER_OF_DAYS}}': newDaysNum.toString(),
  '{{SCENARIO}}': scenario,
  '{{FEE_ADJUSTMENT_DISPLAY}}': fmtCurrency(Math.abs(feeAdjustment)),
  '{{DISCOUNT_RATE}}': `$${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day`,
  '{{SETTLEMENT_PERIOD_DAYS}}': String(deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS),
  '{{LATE_INTEREST_GRACE_DAYS}}': String(LATE_INTEREST_GRACE_DAYS_FROM_CLOSING),
}

const buffer = await generateCpaAmendmentDocx(contractData)
const emailSubject = `Firm Funds — Closing Date Amendment Signature Required: ${deal.property_address}`
const emailBlurb = `Hi ${agent.first_name || 'there'},\n\nThe closing date for your deal at ${deal.property_address} has been updated. Firm Funds Inc. has prepared a Commission Purchase Agreement Amendment that reflects the new terms.\n\nPlease review and sign at your earliest convenience. If you have any questions, reply to this email or contact us at bud@firmfunds.ca.\n\nThank you,\n\n— The Firm Funds Team`

console.log(`Sending REAL (non-test) CPA Amendment for deal ${deal.deal_number} to ${agentName} <${agent.email}> ...`)
const result = await sendSignWellDocument({
  name: `Firm Funds — ${deal.property_address}`,
  subject: emailSubject,
  message: emailBlurb,
  files: [{ name: 'CPA Amendment.docx', base64: buffer.toString('base64') }],
  recipients: [{ id: '1', email: agent.email, name: agentName }],
  metadata: { deal_id: dealId, amendment_id: amendmentId },
})

await client.query(
  `INSERT INTO esignature_envelopes (deal_id, envelope_id, document_type, status, agent_signer_status, sent_by, envelope_uri)
   VALUES ($1,$2,'cpa','sent','sent',$3,$4)`,
  [dealId, result.documentId, ADMIN_ID, result.signingUrls[0] ?? ''],
)

console.log('\nSent through the production client.')
console.log('  documentId :', result.documentId)
console.log('  status     :', result.status)
console.log('  signingUrl :', result.signingUrls[0] ?? '')
console.log('  cpa(amendment) envelope row inserted (deal_id', dealId + ')')
console.log('\nAgent inbox (' + agent.email + ') now has the CPA Amendment signing email.')

await client.end()
