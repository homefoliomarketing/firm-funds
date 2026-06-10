/**
 * scripts/generate-sample-contracts.mts
 *
 * Renders the three live Firm Funds legal documents (CPA, IDP, BCA) to .docx
 * using the SAME generators the app uses to send them for signature
 * (lib/contract-docx.ts). Filled with clearly-marked SAMPLE data so Bud can
 * read the exact wording that goes out to agents and brokerages.
 *
 * Run: npx tsx scripts/generate-sample-contracts.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  generateCpaDocx,
  generateIdpDocx,
  generateBcaDocx,
} from '../lib/contract-docx'

const OUT_DIR = join(process.cwd(), 'contract-samples')
mkdirSync(OUT_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Sample deal numbers (computed with the real financial rules so the document
// reads correctly): $0.80 per $1,000 per day, 7-day settlement window.
//   Gross commission ...... $12,000.00
//   Brokerage split ....... 15%  ->  Face Value (net to agent) = $10,200.00
//   Discount period ....... 30 days
//   Per-day discount ...... (10,200 / 1,000) * 0.80 = $8.16/day
//   Purchase Discount ..... 8.16 * 30 = $244.80
//   Settlement Period Fee . 8.16 * 7  = $57.12
//   Purchase Price ........ 10,200 - 244.80 - 57.12 = $9,898.08
//   Referral Fee (20%) .... 0.20 * (244.80 + 57.12) = $60.38
// ---------------------------------------------------------------------------
const sample: Record<string, string> = {
  '{{AGREEMENT_DATE}}': 'June 9, 2026',
  '{{AMENDMENT_DATE}}': 'June 9, 2026',

  // Deal number (format NNNN-MMDD-YY, assigned by DB trigger at submission)
  '{{DEAL_NUMBER}}': '1042-0609-26',

  // Parties (clearly fictional)
  '{{AGENT_FULL_LEGAL_NAME}}': 'Jane Q. Sample (SAMPLE AGENT)',
  '{{RECO_REGISTRATION_NUMBER}}': '0000000',
  '{{BROKERAGE_LEGAL_NAME}}': 'Sample Realty Inc., Brokerage (SAMPLE)',
  '{{BROKERAGE_ADDRESS}}': '456 Example Avenue, Sault Ste. Marie, ON  P6A 1A1',
  '{{BROKERAGE_EMAIL}}': 'broker@samplerealty.example',
  '{{BROKERAGE_PHONE}}': '(705) 555-0100',
  '{{BROKER_OF_RECORD}}': 'John Sample',

  // Transaction
  '{{PROPERTY_ADDRESS}}': '123 Sample Street, Sault Ste. Marie, ON',
  '{{MLS_NUMBER}}': 'SM0000000',
  '{{EXPECTED_CLOSING_DATE}}': 'July 9, 2026',
  '{{DUE_DATE}}': 'July 16, 2026',

  // Money
  '{{GROSS_COMMISSION_AMOUNT}}': '$12,000.00',
  '{{BROKERAGE_SPLIT}}': '15',
  '{{FACE_VALUE}}': '$10,200.00',
  '{{DISCOUNT_RATE}}': '$0.80 per $1,000 per day',
  '{{NUMBER_OF_DAYS}}': '30',
  '{{PURCHASE_DISCOUNT}}': '$244.80',
  '{{SETTLEMENT_PERIOD_FEE}}': '$57.12',
  '{{PURCHASE_PRICE}}': '$9,898.08',
  '{{DIRECTED_AMOUNT}}': '$10,200.00',
  '{{BROKERAGE_REFERRAL_FEE}}': '$60.38',
  '{{REFERRAL_FEE_PCT}}': '20%',

  // Terms / constants
  '{{SETTLEMENT_PERIOD_DAYS}}': '7',
  '{{LATE_INTEREST_GRACE_DAYS}}': '30',
  '{{LATE_INTEREST_RATE}}': '24%',
  '{{LATE_STRIKE_THRESHOLD}}': '5',
  '{{BUMPED_SETTLEMENT_DAYS}}': '14',

  // Firm Funds banking (placeholder — real values live in the app)
  '{{PURCHASER_BANK_NAME}}': '[Firm Funds financial institution]',
  '{{PURCHASER_TRANSIT}}': '[transit]',
  '{{PURCHASER_ACCOUNT}}': '[account]',
}

const docs: [string, (d: Record<string, string>) => Promise<Buffer>][] = [
  ['CPA - Commission Purchase Agreement (SAMPLE).docx', generateCpaDocx],
  ['IDP - Irrevocable Direction to Pay (SAMPLE).docx', generateIdpDocx],
  ['BCA - Brokerage Cooperation Agreement (SAMPLE).docx', generateBcaDocx],
]

for (const [filename, gen] of docs) {
  const buffer = await gen(sample)
  const outPath = join(OUT_DIR, filename)
  writeFileSync(outPath, buffer)
  console.log(`Wrote ${outPath} (${(buffer.length / 1024).toFixed(1)} KB)`)
}

console.log('\nDone. Three sample contracts written to:', OUT_DIR)
