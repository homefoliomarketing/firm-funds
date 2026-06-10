/**
 * scripts/signwell-rem-send.mts
 *
 * Headless equivalent of admin "Send Remediation IDP" — faithful copy of
 * lib/actions/esign-actions.ts::sendRemediationIdpForSignature (SignWell branch).
 * Same generator (generateRemediationIdpDocx), same SignWell client, same CAS
 * claim (pending → idp_sent), same single remediation_idp envelope row. Signer
 * is the agent.
 *
 *   npx tsx scripts/signwell-rem-send.mts <remediationDealId>
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

const { generateRemediationIdpDocx } = await import('../lib/contract-docx')
const { sendSignWellDocument } = await import('../lib/signwell')

const ADMIN_ID = '056bc7d7-96a1-4fa5-9b6f-043bdd46d49a'
const remId = process.argv[2]
if (!remId) { console.error('Usage: npx tsx scripts/signwell-rem-send.mts <remediationDealId>'); process.exit(1) }

const num = (v: unknown) => Number(v ?? 0)
const round2 = (n: number) => Math.round(n * 100) / 100
const fmtCurrency = (n: unknown) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(num(n))
const fmtDate = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
const dateOnly = (v: unknown) => (v == null ? null : new Date(v as string).toISOString().slice(0, 10))

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

const rem = (await client.query(`SELECT * FROM remediation_deals WHERE id = $1`, [remId])).rows[0]
if (!rem) { console.error('Remediation deal not found'); process.exit(1) }
if (rem.status !== 'pending') { console.error(`Remediation must be pending, is "${rem.status}"`); process.exit(1) }
const failedDeal = (await client.query(`SELECT * FROM deals WHERE id = $1`, [rem.failed_deal_id])).rows[0]
const agent = (await client.query(`SELECT * FROM agents WHERE id = $1`, [rem.agent_id])).rows[0]
if (!agent?.email) { console.error('Agent has no email'); process.exit(1) }

const existing = (await client.query(
  `SELECT id FROM esignature_envelopes WHERE remediation_deal_id = $1 AND status IN ('sent','delivered','signed')`, [remId])).rows
if (existing.length) { console.error('Active Remediation IDP already exists. Void it first.'); process.exit(1) }

const directedAmount = round2(num(rem.directed_amount))
if (directedAmount <= 0) { console.error('No directed amount'); process.exit(1) }

// CAS claim pending → idp_sent
const claimed = (await client.query(
  `UPDATE remediation_deals SET status = 'idp_sent' WHERE id = $1 AND status = 'pending' RETURNING id`, [remId])).rows[0]
if (!claimed) { console.error('Could not claim remediation (not pending)'); process.exit(1) }

const agentName = `${agent.first_name} ${agent.last_name}`
const today = new Date().toISOString().slice(0, 10)

const contractData: Record<string, string> = {
  '{{AGREEMENT_DATE}}': fmtDate(today),
  '{{AGENT_FULL_LEGAL_NAME}}': agentName,
  '{{RECO_REGISTRATION_NUMBER}}': agent.reco_number || 'On file',
  '{{BROKERAGE_LEGAL_NAME}}': rem.brokerage_legal_name,
  '{{BROKERAGE_ADDRESS}}': rem.brokerage_address || 'On file',
  '{{BROKER_OF_RECORD}}': rem.broker_of_record_name || 'On file',
  '{{OUTSTANDING_BALANCE}}': fmtCurrency(directedAmount),
  '{{ORIGINAL_DEAL_NUMBER}}': failedDeal.deal_number || 'N/A',
  '{{FAILED_DEAL_PROPERTY}}': failedDeal.property_address,
  '{{FAILED_DEAL_DATE}}': failedDeal.funding_date ? fmtDate(dateOnly(failedDeal.funding_date)!) : 'original CPA date',
  '{{SOURCE_PROPERTY_ADDRESS}}': rem.property_address,
  '{{SOURCE_MLS_NUMBER}}': rem.mls_number || 'See APS',
  '{{SOURCE_CLOSING_DATE}}': rem.expected_closing_date ? fmtDate(dateOnly(rem.expected_closing_date)!) : 'closing date TBD',
  '{{PURCHASER_BANK_NAME}}': 'On file with Firm Funds',
  '{{PURCHASER_TRANSIT}}': 'On file',
  '{{PURCHASER_ACCOUNT}}': 'On file',
}

const agentFirstName = agent.first_name || 'there'
const emailSubject = `Firm Funds Remediation Direction to Pay: ${rem.property_address}`
const emailBlurb = `Hi ${agentFirstName},\n\nUnder your prior Commission Purchase Agreement for ${failedDeal.property_address} (which did not close), you elected to satisfy the outstanding balance of ${fmtCurrency(directedAmount)} by assigning your next commission.\n\nFirm Funds Inc. has prepared a Remediation Direction to Pay for the commission earned on your sale of ${rem.property_address}. Please review and sign so your brokerage can remit the commission directly to Firm Funds.\n\nReminder: this is not a new advance, and no discount, settlement fee, or profit share applies. The remittance reduces your outstanding balance.\n\nIf you have any questions, reply to this email or contact us at bud@firmfunds.ca.\n\nThank you,\n\nThe Firm Funds Team`

try {
  const docBuffer = await generateRemediationIdpDocx(contractData)
  console.log(`Sending REAL (non-test) Remediation IDP to ${agentName} <${agent.email}> ...`)
  const result = await sendSignWellDocument({
    name: `Firm Funds — ${rem.property_address}`,
    subject: emailSubject,
    message: emailBlurb,
    files: [{ name: 'Remediation Direction to Pay.docx', base64: docBuffer.toString('base64') }],
    recipients: [{ id: '1', email: agent.email, name: agentName }],
    metadata: { remediation_deal_id: remId },
  })

  await client.query(
    `INSERT INTO esignature_envelopes (remediation_deal_id, envelope_id, document_type, status, agent_signer_status, sent_by, envelope_uri)
     VALUES ($1,$2,'remediation_idp','sent','sent',$3,$4)`,
    [remId, result.documentId, ADMIN_ID, result.signingUrls[0] ?? ''],
  )

  console.log('\nSent through the production client.')
  console.log('  documentId :', result.documentId)
  console.log('  status     :', result.status)
  console.log('  signingUrl :', result.signingUrls[0] ?? '')
  console.log('  remediation_idp envelope row inserted (remediation_deal_id', remId + ')')
  console.log('\nAgent inbox (' + agent.email + ') now has the Remediation IDP signing email.')
} catch (e) {
  // revert CAS so it can be retried
  await client.query(`UPDATE remediation_deals SET status = 'pending' WHERE id = $1 AND status = 'idp_sent'`, [remId])
  console.error('Send failed; reverted remediation to pending. Error:', e instanceof Error ? e.message : e)
  process.exit(1)
}

await client.end()
