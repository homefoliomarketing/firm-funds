/**
 * scripts/signwell-poc.mts
 *
 * SignWell proof-of-concept: sends ONE branded sample agreement through the
 * SignWell API so Bud can see what a Firm Funds signing email + signing page
 * looks like before we commit to migrating off DocuSign.
 *
 * It proves the pieces our real integration needs:
 *   - X-Api-Key auth
 *   - hidden text tags placing a signature / initials / date field
 *     ({{signature:1:y}}, {{initial:1:y}}, {{autofill_date_signed:1:y}}),
 *     coloured white so the signer never sees the raw code (same trick we use
 *     for DocuSign /sig1/ anchors)
 *   - account-level branding (logo + colours + sender name) auto-applied
 *
 * SETUP (Bud, one time):
 *   1. Create a FREE SignWell account at https://www.signwell.com  (a credit
 *      card is required even on the free tier; you are not charged under 25
 *      documents/month).
 *   2. Settings -> Branding: upload the Firm Funds logo, set the brand colour
 *      (our green #5FA873) and the sender name "Firm Funds Inc."
 *   3. Settings -> API: create an API key.
 *   4. Add it to .env.local as:   SIGNWELL_API_KEY=your_key_here
 *
 * RUN:
 *   npx tsx scripts/signwell-poc.mts you@example.com "Your Name"
 *
 * The named recipient gets a real SignWell signing email. It uses 1 of your 25
 * free monthly documents. Nothing in the live app is touched.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
} from 'docx'

// --- Config -----------------------------------------------------------------

const SIGNWELL_API_BASE = 'https://www.signwell.com/api/v1'
const FONT = 'Times New Roman'
const FONT_SIZE = 24 // half-points => 12pt

/** Read a single key out of .env.local (this project keeps secrets there). */
function readEnvLocal(key: string): string | undefined {
  let raw = ''
  try {
    raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
  } catch {
    return undefined
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[1] === key) {
      return m[2].replace(/^["']|["']$/g, '').trim()
    }
  }
  return undefined
}

/** A hidden (white) SignWell text tag — invisible to the signer, parsed by SignWell. */
function hiddenTag(tag: string): TextRun {
  return new TextRun({ text: tag, font: FONT, size: 11, color: 'FFFFFF' })
}

/** Build a SignWell text tag with an EXPLICIT pixel size so the field is a normal
 *  size. SignWell otherwise sizes the field to the rendered placeholder, which is
 *  tiny here because the tag is hidden. Format:
 *  {{FieldType:Signer:Required:Label:Prefill:ApiID:Width:Height}}  */
function fieldTag(type: string, signer: string, w: number, h: number): string {
  return `{{${[type, signer, 'y', '', '', '', String(w), String(h)].join(':')}}}`
}

// --- Build a minimal branded sample agreement -------------------------------

async function buildSampleDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'FIRM FUNDS INC.', bold: true, font: FONT, size: 32, color: '000000' })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
            children: [new TextRun({ text: 'Sample Agreement (SignWell branding test)', italics: true, font: FONT, size: 24 })],
          }),
          new Paragraph({
            spacing: { after: 200 },
            children: [new TextRun({ text: 'This is a non-binding test document sent through SignWell so Firm Funds can review the branded signing experience. No legal effect.', font: FONT, size: FONT_SIZE })],
          }),
          new Paragraph({ spacing: { after: 400 }, children: [] }),
          new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'SELLER (Agent):', bold: true, font: FONT, size: FONT_SIZE })] }),
          // Signature line: visible label + hidden tag + visible underline
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({ text: 'Signature: ', font: FONT, size: FONT_SIZE }),
              hiddenTag(fieldTag('signature', '1', 240, 48)),
              new TextRun({ text: '______________________________', font: FONT, size: FONT_SIZE }),
            ],
          }),
          // Initials line
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({ text: 'Initials: ', font: FONT, size: FONT_SIZE }),
              hiddenTag(fieldTag('initial', '1', 80, 40)),
              new TextRun({ text: '____________', font: FONT, size: FONT_SIZE }),
            ],
          }),
          // Date-signed line (auto-fills with the signing date)
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({ text: 'Date Signed: ', font: FONT, size: FONT_SIZE }),
              hiddenTag(fieldTag('autofill_date_signed', '1', 150, 34)),
              new TextRun({ text: '______________________________', font: FONT, size: FONT_SIZE }),
            ],
          }),
        ],
      },
    ],
  })
  const buffer = await Packer.toBuffer(doc)
  return Buffer.from(buffer)
}

// --- Send through SignWell ---------------------------------------------------

async function main() {
  const apiKey = readEnvLocal('SIGNWELL_API_KEY')
  if (!apiKey) {
    console.error('\n  Missing SIGNWELL_API_KEY in .env.local.')
    console.error('  Add a line:  SIGNWELL_API_KEY=your_key_here  (Settings -> API in SignWell)\n')
    process.exit(1)
  }

  const recipientEmail = process.argv[2]
  const recipientName = process.argv[3] || 'Firm Funds Test'
  if (!recipientEmail) {
    console.error('\n  Usage: npx tsx scripts/signwell-poc.mts you@example.com "Your Name"\n')
    process.exit(1)
  }

  console.log(`Building sample agreement and sending to ${recipientName} <${recipientEmail}> ...`)
  const docBuffer = await buildSampleDocx()
  const fileBase64 = docBuffer.toString('base64')

  const body = {
    test_mode: false, // real send so the branded email actually arrives
    draft: false, // send immediately
    text_tags: true, // parse the {{...}} tags into fields
    // The "Firm Funds" API App (045510cd-b609-4c84-88b3-6a752599185c) applies the
    // green accent, but has its OWN logo slot separate from Settings -> Branding.
    // Omitting api_application_id uses the workspace branding (uploaded logo + From
    // name). Re-enable once the logo is uploaded to the API App too, for logo+green.
    api_application_id: '045510cd-b609-4c84-88b3-6a752599185c', // re-test api app
    name: 'Firm Funds — SignWell Test 6 (wide logo)',
    subject: 'Firm Funds: please review and sign (test 6)',
    message: 'This is a quick test of the Firm Funds signing experience. You can sign it; it has no legal effect.',
    recipients: [
      { id: '1', email: recipientEmail, name: recipientName },
    ],
    files: [
      { name: 'firm-funds-sample.docx', file_base64: fileBase64 },
    ],
  }

  const res = await fetch(`${SIGNWELL_API_BASE}/documents`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    console.error(`\n  SignWell API error ${res.status}:\n${text}\n`)
    process.exit(1)
  }

  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) } catch { /* leave raw */ }
  console.log('\n  Sent. SignWell document created:')
  console.log('    id:    ', json.id ?? '(see raw below)')
  console.log('    status:', json.status ?? '(see raw below)')
  console.log(`\n  ${recipientName} should receive a SignWell email shortly. Check that it shows the Firm Funds`)
  console.log('  logo/colours/sender name (configured under Settings -> Branding), and that the signature,')
  console.log('  initials and date fields land on the lines with NO visible {{...}} codes.\n')
  if (!json.id) console.log('  Raw response:\n', text, '\n')
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
