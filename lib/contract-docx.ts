import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  Header,
  Footer,
  PageNumber,
  Tab,
  TabStopPosition,
  TabStopType,
} from 'docx'

// ============================================================================
// Shared Helpers
// ============================================================================

const FONT = 'Times New Roman'
const FONT_SIZE = 24 // docx uses half-points, so 24 = 12pt
const SMALL_SIZE = 16 // 8pt

function heading2(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 360, after: 120 },
    children: [new TextRun({ text, bold: true, font: FONT, size: 28, color: '000000' })],
  })
}

function body(text: string, opts?: { bold?: boolean; italic?: boolean; indent?: number; spacing?: number; alignment?: (typeof AlignmentType)[keyof typeof AlignmentType] }): Paragraph {
  return new Paragraph({
    alignment: opts?.alignment,
    indent: opts?.indent ? { left: opts.indent } : undefined,
    spacing: { after: opts?.spacing ?? 120 },
    children: [new TextRun({ text, font: FONT, size: FONT_SIZE, bold: opts?.bold, italics: opts?.italic })],
  })
}

function richParagraph(runs: { text: string; bold?: boolean; italic?: boolean }[], opts?: { indent?: number; spacing?: number }): Paragraph {
  return new Paragraph({
    indent: opts?.indent ? { left: opts.indent } : undefined,
    spacing: { after: opts?.spacing ?? 120 },
    children: runs.map(r => new TextRun({ text: r.text, font: FONT, size: FONT_SIZE, bold: r.bold, italics: r.italic })),
  })
}

function emptyLine(): Paragraph {
  return new Paragraph({ spacing: { after: 200 }, children: [] })
}

function makeHeader(title: string): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: '000000' } },
        children: [new TextRun({ text: `FIRM FUNDS INC. — ${title}`, font: FONT, size: 18, color: '000000' })],
      }),
    ],
  })
}

/** Footer WITH initials — used on every page except the signature page.
 *  The visible line shows "Initials: ___________" right-aligned.
 *  A hidden /ini1/ anchor (white, 2pt) lets DocuSign place an initials tab on every page. */
function makeFooterWithInitials(initialsLabel: string): Footer {
  return new Footer({
    children: [
      // Initials line — right-aligned, visible underline for agent to initial
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 120, after: 60 },
        children: [
          new TextRun({ text: `${initialsLabel}:  ___________`, font: FONT, size: 20 }),
          // Hidden anchor — DocuSign finds /ini1/ here on every page and places the initials tab
          new TextRun({ text: '  /ini1/', font: FONT, size: 2, color: 'FFFFFF' }),
        ],
      }),
      // Page number + confidential line
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 1, color: '000000' } },
        spacing: { before: 40 },
        tabStops: [
          { type: TabStopType.RIGHT, position: TabStopPosition.MAX },
        ],
        children: [
          new TextRun({ text: 'FIRM FUNDS INC. — Confidential', font: FONT, size: SMALL_SIZE }),
          new TextRun({ children: [new Tab()] }),
          new TextRun({ text: 'Page ', font: FONT, size: SMALL_SIZE }),
          new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SMALL_SIZE }),
          new TextRun({ text: ' of ', font: FONT, size: SMALL_SIZE }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: SMALL_SIZE }),
        ],
      }),
    ],
  })
}

/** Footer WITHOUT initials — used on the signature page only. */
function makeFooterNoInitials(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 1, color: '000000' } },
        spacing: { before: 60 },
        tabStops: [
          { type: TabStopType.RIGHT, position: TabStopPosition.MAX },
        ],
        children: [
          new TextRun({ text: 'FIRM FUNDS INC. — Confidential', font: FONT, size: SMALL_SIZE }),
          new TextRun({ children: [new Tab()] }),
          new TextRun({ text: 'Page ', font: FONT, size: SMALL_SIZE }),
          new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SMALL_SIZE }),
          new TextRun({ text: ' of ', font: FONT, size: SMALL_SIZE }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: SMALL_SIZE }),
        ],
      }),
    ],
  })
}

function scheduleTable(rows: [string, string][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          new TableCell({
            width: { size: 35, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: 'Item', bold: true, font: FONT, size: 22 })] })],
          }),
          new TableCell({
            width: { size: 65, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: 'Details', bold: true, font: FONT, size: 22 })] })],
          }),
        ],
      }),
      ...rows.map(([label, value]) =>
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: label, font: FONT, size: 22 })] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: value, font: FONT, size: 22 })] })] }),
          ],
        })
      ),
    ],
  })
}

function infoTable(rows: [string, string][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([label, value]) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: 35, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, font: FONT, size: 22 })] })],
          }),
          new TableCell({
            width: { size: 65, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: value, font: FONT, size: 22 })] })],
          }),
        ],
      })
    ),
  })
}

// ============================================================================
// CPA Generator
// ============================================================================

export async function generateCpaDocx(data: Record<string, string>): Promise<Buffer> {
  const r = (key: string) => data[key] || key

  const doc = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1400, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Commission Purchase Agreement') },
        footers: { default: makeFooterWithInitials('Seller Initials') },
        children: [
          // Title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: 'COMMISSION PURCHASE AGREEMENT', bold: true, font: FONT, size: 36, color: '000000' })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
            children: [new TextRun({ text: 'True Sale of Commission Receivable', italics: true, font: FONT, size: FONT_SIZE })],
          }),

          // Date + Parties
          richParagraph([
            { text: 'THIS AGREEMENT made as of ' },
            { text: r('{{AGREEMENT_DATE}}'), bold: true },
            { text: '.' },
          ]),
          emptyLine(),
          body('BETWEEN:', { bold: true }),
          richParagraph([
            { text: r('{{AGENT_FULL_LEGAL_NAME}}'), bold: true },
          ], { indent: 600 }),
          body('(hereinafter called the "Seller")', { italic: true, indent: 600 }),
          body('— and —', { alignment: AlignmentType.CENTER }),
          body('FIRM FUNDS INC.', { bold: true, indent: 600 }),
          body('a corporation incorporated under the laws of the Province of Ontario', { indent: 600 }),
          body('(hereinafter called the "Purchaser")', { italic: true, indent: 600 }),
          emptyLine(),

          // Recitals
          heading2('RECITALS'),
          richParagraph([
            { text: 'WHEREAS ', bold: true },
            { text: 'the Seller is a licensed real estate salesperson registered with the Real Estate Council of Ontario ("RECO") and is affiliated with the Brokerage identified in Schedule "A" hereto (the "Brokerage");' },
          ], { indent: 300 }),
          richParagraph([
            { text: 'WHEREAS ', bold: true },
            { text: 'the Seller has earned a commission (the "Commission") in connection with the real estate transaction described in Schedule "A" hereto (the "Real Estate Transaction");' },
          ], { indent: 300 }),
          richParagraph([
            { text: 'WHEREAS ', bold: true },
            { text: 'the Real Estate Transaction is firm, with all conditions of the Agreement of Purchase and Sale having been waived or satisfied;' },
          ], { indent: 300 }),
          richParagraph([
            { text: 'WHEREAS ', bold: true },
            { text: 'the Seller wishes to sell, and the Purchaser wishes to purchase, the Commission on the terms and conditions set forth herein;' },
          ], { indent: 300 }),
          richParagraph([
            { text: 'WHEREAS ', bold: true },
            { text: 'the Parties intend this Agreement to constitute an absolute and unconditional sale and assignment of the Commission from the Seller to the Purchaser, and expressly do not intend this transaction to constitute a loan, a financing arrangement, or a security interest of any kind;' },
          ], { indent: 300 }),
          emptyLine(),
          richParagraph([
            { text: 'NOW THEREFORE', bold: true },
            { text: ', in consideration of the mutual covenants and agreements herein contained and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the Parties agree as follows:' },
          ]),

          // Article 1 — Definitions
          heading2('ARTICLE 1 — DEFINITIONS'),
          ...([
            ['"Agreement of Purchase and Sale" or "APS"', ' means the binding written agreement for the purchase and sale of real property as described in Schedule "A", including any addenda or amendments thereto;'],
            ['"Brokerage"', ' means the real estate brokerage holding the Commission in trust as described in Schedule "A";'],
            ['"Closing Date"', ' means the expected closing date of the APS as set out in Schedule "A", or such earlier or later date as may be mutually agreed in writing by the parties to the APS;'],
            ['"Commission"', ' means the specific commission receivable being purchased, as described in Schedule "A";'],
            ['"Settlement Period Fee"', ' means the non-refundable fee covering the fourteen (14) calendar day settlement period following the Expected Closing Date, during which the Brokerage is required to remit the Commission to the Purchaser, calculated in accordance with Article 3;'],
            ['"Late Payment Interest"', ' means interest at the rate of twenty-four percent (24%) per annum, calculated daily, applicable to any amounts remaining unpaid after the Payment Due Date, as set out in Article 6;'],
            ['"Face Value"', ' means the net commission payable to the Seller after the Brokerage\'s commission split, as set out in Schedule "A";'],
            ['"Payment Due Date"', ' means the date that is fourteen (14) calendar days following the Expected Closing Date, by which the Brokerage must remit the Commission to the Purchaser;'],
            ['"Irrevocable Direction to Pay"', ' means the irrevocable direction executed by the Seller directing the Brokerage to pay the Commission directly to the Purchaser, in the form attached as Schedule "B";'],
            ['"Purchase Discount"', ' means the fee charged by the Purchaser for this purchase transaction, calculated as set out in Article 3;'],
            ['"Purchase Price"', ' means the amount paid by the Purchaser to the Seller, being the Face Value less the Purchase Discount and the Settlement Period Fee;'],
            ['"Referral Fee"', ' means any referral or cooperation fee payable by the Purchaser to the Brokerage in connection with this transaction;'],
            ['"RECO"', ' means the Real Estate Council of Ontario.'],
          ] as [string, string][]).map(([term, def]) =>
            richParagraph([{ text: term, bold: true }, { text: def }], { indent: 300 })
          ),

          // Article 2
          heading2('ARTICLE 2 — PURCHASE AND SALE'),
          richParagraph([{ text: '2.1 Sale and Assignment. ', bold: true }, { text: 'The Seller hereby sells, assigns, and transfers to the Purchaser, absolutely and unconditionally, all of the Seller\'s right, title, interest, and entitlement in and to the Commission, free and clear of all liens, charges, encumbrances, claims, and security interests of any kind.' }]),
          richParagraph([{ text: '2.2 Absolute Assignment. ', bold: true }, { text: 'The Parties acknowledge and agree that this transaction constitutes a true sale and absolute assignment of the Commission, and not an assignment by way of security or a loan.' }]),
          richParagraph([{ text: '2.3 No Residual Interest. ', bold: true }, { text: 'Following the execution of this Agreement, the Seller shall have no further right, title, interest, or claim in or to the Commission, except as expressly set forth in this Agreement.' }]),

          // Article 3
          heading2('ARTICLE 3 — PURCHASE PRICE AND PAYMENT'),
          richParagraph([{ text: '3.1 Face Value. ', bold: true }, { text: `The Face Value of the Commission is ${r('{{FACE_VALUE}}')} (the "Face Value"), being the net commission payable to the Seller after the Brokerage's commission split.` }]),
          richParagraph([{ text: '3.2 Purchase Discount. ', bold: true }, { text: `The Purchase Discount is ${r('{{PURCHASE_DISCOUNT}}')} (the "Purchase Discount"), calculated as follows: $0.75 per $1,000.00 of Face Value per day, for ${r('{{NUMBER_OF_DAYS}}')} days (being the number of calendar days from the day following the Funding Date to the Expected Closing Date).` }]),
          richParagraph([{ text: '3.3 Settlement Period Fee. ', bold: true }, { text: `The Settlement Period Fee is ${r('{{SETTLEMENT_PERIOD_FEE}}')} (the "Settlement Period Fee"), calculated as follows: $0.75 per $1,000.00 of Face Value per day, for fourteen (14) calendar days. This fee covers the settlement period during which the Brokerage is required to remit the Commission to the Purchaser. The Settlement Period Fee is a non-refundable flat fee and is not subject to proration or adjustment regardless of when payment is received.` }]),
          richParagraph([{ text: '3.4 Purchase Price. ', bold: true }, { text: `The Purchase Price payable to the Seller is ${r('{{PURCHASE_PRICE}}')} (the "Purchase Price"), being the Face Value less the Purchase Discount and the Settlement Period Fee.` }]),
          richParagraph([{ text: '3.5 Payment. ', bold: true }, { text: 'The Purchaser shall pay the Purchase Price to the Seller by electronic funds transfer to the account specified in Schedule "C" within two (2) business days of execution of this Agreement and the Irrevocable Direction to Pay.' }]),

          // Article 4
          heading2('ARTICLE 4 — COLLECTION'),
          richParagraph([{ text: '4.1 ', bold: true }, { text: 'The Purchaser shall collect the Commission directly from the Brokerage\'s trust account upon closing of the Real Estate Transaction.' }]),
          richParagraph([{ text: '4.2 ', bold: true }, { text: 'The Seller shall, concurrently with the execution of this Agreement, execute an Irrevocable Direction to Pay directing the Brokerage to pay the Commission directly to the Purchaser.' }]),

          // Article 5
          heading2('ARTICLE 5 — SELLER\'S REPAYMENT OBLIGATION'),
          richParagraph([{ text: '5.1 Non-Closing — Full Repayment. ', bold: true }, { text: 'If the Real Estate Transaction does not close for any reason, the Seller shall be personally liable to repay the Purchaser the full Purchase Price. The Seller\'s obligation to repay is unconditional and is not limited by the reason for non-closing, including but not limited to buyer default, financing failure, mutual termination, or any act or omission of the Seller, the buyer, or any third party.' }]),
          richParagraph([{ text: '5.2 Partial Shortfall — Commission Deficiency. ', bold: true }, { text: 'If the Real Estate Transaction closes but the commission actually received by the Purchaser is less than the Face Value (whether due to reduction, holdback, dispute, or any other reason), the Seller shall be personally liable to pay the Purchaser the difference between the Face Value and the amount actually received. For clarity, any Referral Fee lawfully deducted by the Brokerage under the Brokerage Cooperation Agreement shall not be treated as a deficiency for the purposes of this Article.' }]),
          richParagraph([{ text: '5.3 Repayment on Demand. ', bold: true }, { text: 'Upon written notice from the Purchaser that the Real Estate Transaction has failed to close or that the Commission has not been received in full, the Seller shall pay the amount owing under Article 5.1 or 5.2, as applicable, within thirty (30) days. If the Seller fails to make payment within this period, the outstanding amount shall be charged to the Seller\'s Firm Funds account as a balance owing, and interest at the rate of twenty-four percent (24%) per annum shall accrue on the unpaid balance from the thirty-first (31st) day. For clarity, this interest provision applies specifically to seller repayment obligations under this Article, as distinct from the Late Payment Interest on brokerage remittance set out in Article 6.' }]),
          richParagraph([{ text: '5.4 Right of Offset. ', bold: true }, { text: 'The Purchaser may, at its sole discretion, offset any amount owing by the Seller under this Article against future commission purchase transactions, without further notice to the Seller.' }]),

          // Article 6
          heading2('ARTICLE 6 — LATE PAYMENT INTEREST'),
          richParagraph([{ text: '6.1 Payment Due Date. ', bold: true }, { text: `The Brokerage shall remit the Commission to the Purchaser within fourteen (14) calendar days following the Expected Closing Date (the "Payment Due Date"). The Payment Due Date for this transaction is ${r('{{DUE_DATE}}')}.` }]),
          richParagraph([{ text: '6.2 Late Payment Interest. ', bold: true }, { text: 'If the Real Estate Transaction closes but the Commission is not remitted to the Purchaser by the Payment Due Date, Late Payment Interest shall accrue at the rate of twenty-four percent (24%) per annum, calculated daily on the Purchase Price, commencing on the day following the Payment Due Date and continuing until the date the Commission is received by the Purchaser in full. For the purposes of this Article, the Commission shall be considered received in full when the Purchaser has received the Face Value less any Referral Fee lawfully deducted by the Brokerage under the Brokerage Cooperation Agreement. This Article applies to late remittance by the Brokerage following a closing; interest on seller repayment obligations following non-closing or commission deficiency is governed by Article 5.3.' }]),
          richParagraph([{ text: '6.3 Responsibility for Late Payment Interest. ', bold: true }, { text: 'The Seller acknowledges and agrees that Late Payment Interest is the sole responsibility of the Seller. Such interest shall be charged to the Seller\'s account with the Purchaser and may be deducted from future commission purchase transactions or invoiced separately at the Purchaser\'s discretion.' }]),
          richParagraph([{ text: '6.4 No Refund of Settlement Period Fee. ', bold: true }, { text: 'For greater certainty, the Settlement Period Fee set out in Article 3.3 is non-refundable and shall not be credited, prorated, or adjusted in any circumstance, including early payment by the Brokerage.' }]),

          // Article 7
          heading2('ARTICLE 7 — SUBSTITUTION AND REPAYMENT ARRANGEMENTS'),
          richParagraph([{ text: '7.1 Substitution Option. ', bold: true }, { text: 'If the Real Estate Transaction does not close, the Seller may, with the prior written consent of the Purchaser, offer a substitute commission receivable of equal or greater Face Value. Acceptance of a substitute commission is at the sole discretion of the Purchaser and does not discharge or reduce the Seller\'s repayment obligation under Article 5 unless the Purchaser confirms acceptance in writing.' }]),
          richParagraph([{ text: '7.2 Repayment Arrangement. ', bold: true }, { text: 'The Purchaser may, at its sole discretion, agree to a repayment arrangement with the Seller. Any such arrangement must be agreed to in writing and shall not exceed six (6) monthly installments. Interest at the rate of twenty-four percent (24%) per annum, as set out in Article 5.3, shall continue to accrue on any unpaid balance during the repayment period.' }]),
          richParagraph([{ text: '7.3 Account Balance. ', bold: true }, { text: 'The following amounts shall be recorded as a balance owing on the Seller\'s Firm Funds account: (a) the full Purchase Price owing under Article 5.1 (non-closing); (b) any commission shortfall owing under Article 5.2 (partial deficiency); (c) interest on seller repayment obligations under Article 5.3; and (d) Late Payment Interest on brokerage late remittance under Article 6.2. The Purchaser may offset any balance owing against future commission purchase transactions without further notice to the Seller.' }]),
          richParagraph([{ text: '7.4 Cumulative Remedies. ', bold: true }, { text: 'The remedies set out in this Article are in addition to, and not in substitution for, any other rights or remedies available to the Purchaser at law or in equity.' }]),

          // Article 8
          heading2('ARTICLE 8 — SELLER\'S REPRESENTATIONS AND WARRANTIES'),
          body('The Seller represents and warrants: (a) valid RECO registration and good standing; (b) full authority to sell and assign the Commission; (c) firm transaction with all conditions satisfied; (d) no prior assignment of the Commission; (e) no impediments to closing; (f) all information provided is true and accurate; (g) no pending litigation; (h) no PPSA registrations against the Commission; (i) buyer financing verified; (j) sufficient proceeds to pay the Commission.'),

          // Articles 9-12
          heading2('ARTICLE 9 — NOTIFICATION OBLIGATION'),
          body('The Seller shall immediately notify the Purchaser if: (a) the Closing Date changes; (b) the transaction is terminated; (c) any circumstance may prevent closing; or (d) the Seller ceases to be licensed.'),

          heading2('ARTICLE 10 — TAX OBLIGATIONS'),
          body('The collection, reporting, and remittance of all applicable GST/HST on the Commission is the sole responsibility of the Seller.'),

          heading2('ARTICLE 11 — FINTRAC COMPLIANCE'),
          body('The Seller acknowledges identity verification through the Purchaser\'s portal and consents to record retention for a minimum of five (5) years.'),

          heading2('ARTICLE 12 — GENERAL PROVISIONS'),
          body('Governed by the laws of Ontario. Electronic signatures valid under the Electronic Commerce Act, 2000 (Ontario). Each Party has been advised to obtain independent legal advice.'),
        ],
      },

      // Schedule A — new section (new page)
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1400, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Commission Purchase Agreement — Schedule "A"') },
        footers: { default: makeFooterWithInitials('Seller Initials') },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'SCHEDULE "A" — TRANSACTION DETAILS', bold: true, font: FONT, size: 28, color: '000000' })],
          }),
          scheduleTable([
            ['Property Address', r('{{PROPERTY_ADDRESS}}')],
            ['MLS Number', r('{{MLS_NUMBER}}')],
            ['Expected Closing Date', r('{{EXPECTED_CLOSING_DATE}}')],
            ['Payment Due Date', r('{{DUE_DATE}}')],
            ['Gross Commission Amount', r('{{GROSS_COMMISSION_AMOUNT}}')],
            ['Brokerage Commission Split', `${r('{{BROKERAGE_SPLIT}}')}%`],
            ['Net Commission to Seller (Face Value)', r('{{FACE_VALUE}}')],
            ['Discount Rate', '$0.75 per $1,000 per day'],
            ['Number of Days (Discount Period)', r('{{NUMBER_OF_DAYS}}')],
            ['Purchase Discount', r('{{PURCHASE_DISCOUNT}}')],
            ['Settlement Period Fee (14 days)', r('{{SETTLEMENT_PERIOD_FEE}}')],
            ['Purchase Price (Agent Receives)', r('{{PURCHASE_PRICE}}')],
            ['Brokerage Referral Fee', r('{{BROKERAGE_REFERRAL_FEE}}')],
            ['Late Payment Interest Rate', `${r('{{LATE_INTEREST_RATE}}')} per annum`],
            ['Brokerage Legal Name', r('{{BROKERAGE_LEGAL_NAME}}')],
            ['Brokerage Address', r('{{BROKERAGE_ADDRESS}}')],
            ['Broker of Record', r('{{BROKER_OF_RECORD}}')],
          ]),
        ],
      },

      // Signature Page — new section (new page)
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1400, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Commission Purchase Agreement — Signature Page') },
        footers: { default: makeFooterNoInitials() },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'SIGNATURE PAGE', bold: true, font: FONT, size: 28, color: '000000' })],
          }),
          body('IN WITNESS WHEREOF the Parties have executed this Agreement as of the date first written above.'),
          emptyLine(),
          body('SELLER:', { bold: true }),
          body(`Name: ${r('{{AGENT_FULL_LEGAL_NAME}}')}`),
          body(`RECO Registration No.: ${r('{{RECO_REGISTRATION_NUMBER}}')}`),
          emptyLine(),
          emptyLine(),
          body('Signature: /sig1/', { italic: true }),
          body('Date Signed: /dat1/', { italic: true }),
          emptyLine(),
          emptyLine(),
          body('PURCHASER: FIRM FUNDS INC.', { bold: true }),
          body('Title: President'),
        ],
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  return Buffer.from(buffer)
}

// ============================================================================
// IDP Generator
// ============================================================================

export async function generateIdpDocx(data: Record<string, string>): Promise<Buffer> {
  const r = (key: string) => data[key] || key

  const doc = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1400, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Irrevocable Direction to Pay') },
        footers: { default: makeFooterWithInitials('Agent Initials') },
        children: [
          // Title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: 'IRREVOCABLE DIRECTION TO PAY', bold: true, font: FONT, size: 36, color: '000000' })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
            children: [new TextRun({ text: 'Commission Payment Direction', italics: true, font: FONT, size: FONT_SIZE })],
          }),

          // Date
          richParagraph([{ text: 'Date: ' }, { text: r('{{AGREEMENT_DATE}}'), bold: true }]),
          emptyLine(),

          // TO
          body('TO:', { bold: true }),
          body(r('{{BROKERAGE_LEGAL_NAME}}'), { bold: true, indent: 300 }),
          body(r('{{BROKERAGE_ADDRESS}}'), { indent: 300 }),
          richParagraph([{ text: 'Attention: ' }, { text: r('{{BROKER_OF_RECORD}}'), bold: true }], { indent: 300 }),
          emptyLine(),

          // FROM
          body('FROM:', { bold: true }),
          body(r('{{AGENT_FULL_LEGAL_NAME}}'), { bold: true, indent: 300 }),
          body(`RECO Registration No.: ${r('{{RECO_REGISTRATION_NUMBER}}')}`, { indent: 300 }),
          emptyLine(),

          // RE
          richParagraph([
            { text: 'RE: ', bold: true },
            { text: 'Commission on sale of ' },
            { text: r('{{PROPERTY_ADDRESS}}'), bold: true },
            { text: ', MLS No. ' },
            { text: r('{{MLS_NUMBER}}'), bold: true },
          ]),
          emptyLine(),

          // Direction
          heading2('DIRECTION'),
          richParagraph([
            { text: 'I, ' },
            { text: r('{{AGENT_FULL_LEGAL_NAME}}'), bold: true },
            { text: ', a registered real estate salesperson/broker affiliated with ' },
            { text: r('{{BROKERAGE_LEGAL_NAME}}'), bold: true },
            { text: ' (the "Brokerage"), hereby irrevocably direct the Brokerage to pay the sum of ' },
            { text: r('{{DIRECTED_AMOUNT}}'), bold: true },
            { text: ' (the "Directed Amount") from my commission earned on the sale of the property municipally known as ' },
            { text: r('{{PROPERTY_ADDRESS}}'), bold: true },
            { text: ' (MLS No. ' },
            { text: r('{{MLS_NUMBER}}'), bold: true },
            { text: ') directly to ' },
            { text: 'Firm Funds Inc.', bold: true },
            { text: ' (the "Purchaser").' },
          ]),
          emptyLine(),
          body('This Direction is irrevocable and may not be revoked, altered, amended, or countermanded by me without the prior written consent of the Purchaser.'),
          emptyLine(),
          body('I acknowledge that the Brokerage is entitled to deduct a Referral Fee from the Directed Amount prior to remittance, as set out in the Brokerage Cooperation Agreement between the Brokerage and the Purchaser. The net amount remitted after such deduction shall constitute compliance with this Direction.'),
          emptyLine(),
          richParagraph([
            { text: 'Subject to the Referral Fee deduction described above, the Directed Amount shall be paid from the Brokerage\'s real estate trust account no later than the Payment Due Date, being ' },
            { text: r('{{DUE_DATE}}'), bold: true },
            { text: ' (fourteen (14) calendar days following the Expected Closing Date of ' },
            { text: r('{{EXPECTED_CLOSING_DATE}}'), bold: true },
            { text: '), by electronic funds transfer to the following account:' },
          ]),
          emptyLine(),

          // Payment info table
          infoTable([
            ['Payee', 'Firm Funds Inc.'],
            ['Financial Institution', r('{{PURCHASER_BANK_NAME}}')],
            ['Transit Number', r('{{PURCHASER_TRANSIT}}')],
            ['Account Number', r('{{PURCHASER_ACCOUNT}}')],
          ]),
          emptyLine(),
          body('If the commission actually payable to me on this transaction (after the Brokerage\'s commission split) is less than the Directed Amount, the Brokerage shall pay the full commission amount to the Purchaser, subject to the Referral Fee deduction described above. I acknowledge that the difference between the Directed Amount and the amount actually received by the Purchaser, excluding any Referral Fee lawfully deducted by the Brokerage under the Brokerage Cooperation Agreement, shall remain my personal obligation to the Purchaser, as set out in Article 5.2 of the Commission Purchase Agreement. Such shortfall shall be charged to my Firm Funds account as a balance owing, and may be deducted from future commission purchase transactions, invoiced separately, or demanded by the Purchaser at any time.'),
          body('If the Real Estate Transaction does not close for any reason, I acknowledge that my obligation to repay the full Purchase Price to the Purchaser remains in effect, as set out in Article 5.1 of the Commission Purchase Agreement.'),

          // Brokerage Auth
          heading2('BROKERAGE AUTHORIZATION'),
          body('I acknowledge that the Brokerage has entered into a Brokerage Cooperation Agreement with Firm Funds Inc., under which the Brokerage has agreed to honour Irrevocable Directions to Pay. A copy of this Direction will be provided to the Brokerage upon execution.'),

          // Settlement Period Fee & Late Payment Interest
          heading2('SETTLEMENT PERIOD FEE AND LATE PAYMENT INTEREST'),
          body(`I acknowledge that a non-refundable Settlement Period Fee has been included in the calculation of the Purchase Price, covering the fourteen (14) calendar day settlement period following the Expected Closing Date (${r('{{EXPECTED_CLOSING_DATE}}')}) during which the Brokerage is required to remit the Commission to the Purchaser.`),
          body(`I further acknowledge that if the Real Estate Transaction closes but the Commission is not remitted to the Purchaser by the Payment Due Date (${r('{{DUE_DATE}}')}, being fourteen (14) calendar days after the Expected Closing Date), Late Payment Interest shall accrue at the rate of twenty-four percent (24%) per annum, calculated daily, and shall be charged to my Firm Funds account. Such interest may be deducted from future commission purchase transactions or invoiced separately. My repayment obligations in the event of non-closing or commission deficiency are governed by the Commission Purchase Agreement.`),

          // Notification
          heading2('NOTIFICATION OBLIGATION'),
          body('I shall immediately notify both the Brokerage and the Purchaser if: (a) the closing date is changed; (b) the transaction is terminated; or (c) any circumstance may prevent or delay closing.'),

          // ILA
          heading2('INDEPENDENT LEGAL ADVICE'),
          body('I acknowledge that I have been advised to obtain independent legal advice. I am executing this Direction freely, voluntarily, and with full knowledge of its contents and legal effect.'),

          // E-Sig
          heading2('ELECTRONIC SIGNATURE'),
          body('This Direction may be executed by electronic signature in accordance with the Electronic Commerce Act, 2000 (Ontario).'),

          emptyLine(),
          emptyLine(),

          // Signature block
          body('AGENT SIGNATURE', { bold: true }),
          body(`Name: ${r('{{AGENT_FULL_LEGAL_NAME}}')}`),
          body(`RECO Registration No.: ${r('{{RECO_REGISTRATION_NUMBER}}')}`),
          emptyLine(),
          emptyLine(),
          body('Signature: /sig1/', { italic: true }),
          body('Date Signed: /dat1/', { italic: true }),
        ],
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  return Buffer.from(buffer)
}

// ============================================================================
// BCA Generator — Brokerage Cooperation Agreement
// ============================================================================

export async function generateBcaDocx(data: Record<string, string>): Promise<Buffer> {
  const r = (key: string) => data[key] || key

  const doc = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1400, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Brokerage Cooperation Agreement') },
        footers: { default: makeFooterWithInitials('Broker of Record Initials') },
        children: [
          // Title — (#1) "Commission Purchase Program" instead of "Commission Advance Program"
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: 'BROKERAGE COOPERATION AGREEMENT', bold: true, font: FONT, size: 36, color: '000000' })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [new TextRun({ text: '(Commission Purchase Program)', font: FONT, size: FONT_SIZE, italics: true })],
          }),

          // Date and Parties
          richParagraph([
            { text: 'Date: ' },
            { text: r('{{AGREEMENT_DATE}}'), bold: true },
          ]),
          emptyLine(),

          body('THIS BROKERAGE COOPERATION AGREEMENT (the "Agreement") is entered into by and between:', { bold: true }),
          emptyLine(),

          richParagraph([
            { text: 'FIRM FUNDS INC.', bold: true },
            { text: ', a corporation incorporated under the laws of Ontario, carrying on business at 121 Brock Street, Sault Ste. Marie, ON P6A 3B6 (the "Purchaser" or "Firm Funds");' },
          ]),
          emptyLine(),
          body('— AND —', { alignment: AlignmentType.CENTER, bold: true }),
          emptyLine(),
          richParagraph([
            { text: r('{{BROKERAGE_LEGAL_NAME}}'), bold: true },
            { text: ', a real estate brokerage registered under the ' },
            { text: 'Trust in Real Estate Services Act, 2002', italic: true },
            { text: ' (Ontario), with its principal office at ' },
            { text: r('{{BROKERAGE_ADDRESS}}') },
            { text: ' (the "Brokerage");' },
          ]),
          emptyLine(),
          richParagraph([
            { text: 'represented by its Broker of Record, ' },
            { text: r('{{BROKER_OF_RECORD}}'), bold: true },
            { text: '.' },
          ]),

          emptyLine(),

          // Recitals — (#1) purchase language throughout
          body('RECITALS', { bold: true }),
          body('WHEREAS Firm Funds operates a commission purchase program under which it purchases the right to receive real estate commission receivables from individual real estate agents ("Agents") registered with the Brokerage;'),
          body('AND WHEREAS the Brokerage acknowledges the value of commission purchase services to its Agents, and wishes to cooperate with Firm Funds to facilitate the orderly processing and payment of commission receivables;'),
          body('AND WHEREAS each commission purchase transaction will be governed by a separate Commission Purchase Agreement between Firm Funds and the Agent, and an Irrevocable Direction to Pay issued by the Agent to the Brokerage;'),
          body('NOW THEREFORE, in consideration of the mutual covenants and agreements hereinafter set forth, and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the parties agree as follows:'),

          emptyLine(),

          // Article 1: Definitions — (#2) add Face Value, (#8) remove seller-facing definitions
          heading2('ARTICLE 1 — DEFINITIONS'),
          body('1.1 "Agent" means a real estate salesperson or broker registered under the Brokerage who enters into a Commission Purchase Agreement with Firm Funds.'),
          body('1.2 "Commission Purchase Agreement" or "CPA" means the agreement between Firm Funds and an Agent pursuant to which Firm Funds purchases the right to receive all or a portion of a Commission Receivable.'),
          body('1.3 "Irrevocable Direction to Pay" or "IDP" means an irrevocable written instruction from the Agent directing the Brokerage to remit commission funds to Firm Funds.'),
          body('1.4 "Commission Receivable" means the amount of real estate commission payable to an Agent through the Brokerage upon the closing of a real estate transaction.'),
          body('1.5 "Face Value" means the net commission payable to the Agent after the Brokerage\'s commission split, as set out in the applicable CPA.'),
          body('1.6 "Transaction" means a real estate transaction giving rise to a Commission Receivable.'),
          body('1.7 "Referral Fee" means the fee payable by Firm Funds to the Brokerage in connection with each commission purchase transaction, calculated as a percentage of the Purchase Discount (as defined in the applicable CPA). The applicable Referral Fee percentage for each Transaction shall be as set out in the applicable CPA, and may vary by Transaction.'),
          body('1.8 "Purchase Discount" means the fee charged by Firm Funds to the Agent for the commission purchase transaction, as calculated and set out in the applicable CPA. For clarity, the Purchase Discount does not include the Settlement Period Fee.'),
          body('1.9 "Payment Due Date" means the date that is fourteen (14) calendar days following the Expected Closing Date as set out in the applicable CPA and IDP, by which the Brokerage must remit the Commission to Firm Funds.'),

          // Article 2: Cooperation — (#1) purchase language, (#4) tightened 2.3
          heading2('ARTICLE 2 — COOPERATION AND ACKNOWLEDGMENT'),
          body('2.1 The Brokerage agrees to cooperate with Firm Funds in the processing of commission purchase transactions involving its Agents. This cooperation includes, without limitation, honouring Irrevocable Directions to Pay and facilitating the timely remittance of commission funds.'),
          body('2.2 The Brokerage acknowledges that each commission purchase transaction constitutes a true sale and purchase of a Commission Receivable, and not a loan or security interest. The Brokerage acknowledges that upon execution of a CPA and IDP, Firm Funds acquires a property right in the Commission Receivable.'),
          body('2.3 Nothing in this Agreement creates an obligation on the part of the Brokerage to recommend or market the commission purchase program to its Agents. However, upon receiving a valid IDP and supporting CPA documentation from an Agent, the Brokerage shall honour it in accordance with this Agreement.'),

          // Article 3: Irrevocable Direction to Pay — (#3) Payment Due Date harmonized, (#5) partial shortfall, (#6) dispute handling
          heading2('ARTICLE 3 — IRREVOCABLE DIRECTION TO PAY'),
          body('3.1 Upon receiving a valid Irrevocable Direction to Pay from an Agent, the Brokerage shall honour such direction and remit to Firm Funds: (a) the directed amount, less the Referral Fee as set out in Article 4.4, or (b) if the commission actually payable to the Agent on the Transaction (after the Brokerage\'s commission split) is less than the directed amount, the full commission actually payable less the Referral Fee. Any shortfall between the directed amount and the commission actually remitted (exclusive of the Referral Fee) is governed by the applicable CPA and IDP.'),
          body('3.2 The Brokerage acknowledges that an IDP, once executed by the Agent and delivered to the Brokerage, is irrevocable and may not be cancelled, modified, or overridden except with the express written consent of Firm Funds.'),
          body('3.3 The Brokerage agrees to process payment to Firm Funds no later than the Payment Due Date set out in the applicable IDP and CPA. Payment shall be made by electronic funds transfer to the account specified in the applicable IDP.'),
          body('3.4 In the event of a commission dispute, holdback, or adjustment that affects the amount payable under an IDP, the Brokerage shall: (a) promptly notify both the Agent and Firm Funds in writing; (b) remit to Firm Funds any undisputed or actually payable portion of the commission, less the Referral Fee under Article 4.4, up to the directed amount; and (c) withhold only the disputed, held-back, or not-yet-payable portion pending resolution or written instructions from Firm Funds.'),

          // Article 4: Commission Handling
          heading2('ARTICLE 4 — COMMISSION HANDLING AND REMITTANCE'),
          body('4.1 Upon closing of a Transaction, the Brokerage shall remit the amount required under Article 3.1 directly to Firm Funds by electronic funds transfer (EFT) to the account specified in the IDP, or by such other method as Firm Funds may direct in writing.'),
          body('4.2 Any residual commission amount remaining after remittance to Firm Funds under Article 3.1 shall be remitted to the Agent in accordance with the Brokerage\'s standard commission disbursement practices.'),
          body('4.3 The Brokerage shall provide Firm Funds with reasonable confirmation of payment, including the date of remittance and transaction reference number, within five (5) business days of payment.'),
          body(`4.4 Referral Fee. For each Transaction in which the Brokerage honours an IDP, the Brokerage shall be entitled to a Referral Fee of ${r('{{REFERRAL_FEE_PCT}}')} of the Purchase Discount. The Referral Fee percentage may be adjusted for a specific Transaction by written agreement between the parties, as reflected in the applicable CPA. The Referral Fee shall apply to the Purchase Discount only and shall not apply to the Settlement Period Fee or any other fees or charges under the CPA.`),
          body('4.5 Deduction of Referral Fee. The Brokerage shall deduct the Referral Fee from the amount otherwise remittable to Firm Funds under Article 3.1 at the time of remittance. The Brokerage shall include the Referral Fee amount and the calculation basis in the payment confirmation provided under Article 4.3.'),
          body('4.6 Referral Fee on Partial Commission. If the commission actually payable is less than the directed amount and the Brokerage remits a reduced amount under Article 3.1(b), the Referral Fee shall be calculated on the Purchase Discount as originally set out in the applicable CPA, and shall not be recalculated based on the reduced remittance amount.'),

          // Article 5: Notification Obligations
          heading2('ARTICLE 5 — NOTIFICATION OBLIGATIONS'),
          body('5.1 The Brokerage shall promptly notify Firm Funds in writing if it becomes aware of any of the following: (a) a change to the expected closing date of a Transaction subject to an IDP; (b) the termination, collapse, or material amendment of a Transaction; (c) any commission dispute, holdback, or legal proceeding affecting a Commission Receivable; (d) any change in the Agent\'s status, including termination, suspension, or transfer to another brokerage.'),
          body('5.2 The Brokerage shall provide Firm Funds with such notice within two (2) business days of becoming aware of the applicable event.'),

          // Article 6: Agent Authorization — (#1) purchase language, (#4) tightened 6.1
          heading2('ARTICLE 6 — AGENT AUTHORIZATION'),
          body('6.1 The Brokerage confirms that it shall not restrict its Agents from participating in lawful commission purchase arrangements with Firm Funds, and that upon receiving a valid IDP and CPA, the Brokerage shall honour the direction in accordance with this Agreement.'),
          body('6.2 The Brokerage agrees not to take any action to impede, discourage, or penalize an Agent solely for participating in the Firm Funds commission purchase program.'),

          // Article 7: Term and Termination — (#7) broadened survival clause
          heading2('ARTICLE 7 — TERM AND TERMINATION'),
          body('7.1 This Agreement shall commence on the date first written above and shall continue in force for a period of one (1) year, automatically renewing for successive one-year terms unless either party provides not less than ninety (90) days\' written notice of non-renewal prior to the end of the then-current term.'),
          body('7.2 Either party may terminate this Agreement for cause upon thirty (30) days\' written notice if the other party commits a material breach and fails to cure such breach within the notice period.'),
          body('7.3 Termination of this Agreement shall not affect any IDP that has been executed and delivered prior to the effective date of termination. Following termination, the Brokerage shall continue to comply with: (a) all outstanding IDPs; (b) its remittance obligations under Article 3; and (c) its notification obligations under Article 5, including with respect to non-closing, delay, deficiency, dispute, or holdback, until each outstanding Transaction is fully resolved and all amounts have been remitted or accounted for.'),

          // Article 8: Representations and Warranties — (#1) purchase language
          heading2('ARTICLE 8 — REPRESENTATIONS AND WARRANTIES'),
          body('8.1 The Brokerage represents and warrants that: (a) it is a brokerage in good standing registered under the Trust in Real Estate Services Act, 2002 (Ontario); (b) the Broker of Record has full authority to enter into this Agreement on behalf of the Brokerage; (c) entering into this Agreement does not conflict with any other agreement or obligation of the Brokerage; (d) it maintains adequate trust accounting and commission disbursement procedures.'),
          body('8.2 Firm Funds represents and warrants that: (a) it is a corporation in good standing under the laws of Ontario; (b) it has full authority to enter into this Agreement; (c) it shall comply with all applicable laws, including FINTRAC requirements, in connection with its commission purchase operations.'),

          // Article 9: Confidentiality
          heading2('ARTICLE 9 — CONFIDENTIALITY'),
          body('9.1 Each party agrees to keep confidential all information received from the other party in connection with this Agreement, including Agent information, transaction details, and financial terms. Such information may be disclosed only: (a) to the extent required by law or regulatory authority; (b) to professional advisors bound by confidentiality obligations; (c) with the prior written consent of the disclosing party.'),

          // Article 10: Indemnification — (#1) purchase language
          heading2('ARTICLE 10 — INDEMNIFICATION'),
          body('10.1 The Brokerage shall indemnify and hold harmless Firm Funds from any loss, cost, or expense (including reasonable legal fees) arising from: (a) a breach of this Agreement by the Brokerage; (b) the Brokerage\'s failure to honour a valid IDP; (c) the Brokerage\'s release of directed funds in contravention of an IDP.'),
          body('10.2 Firm Funds shall indemnify and hold harmless the Brokerage from any loss, cost, or expense (including reasonable legal fees) arising from: (a) a breach of this Agreement by Firm Funds; (b) any claim by a third party relating to Firm Funds\' commission purchase activities, to the extent such claim does not arise from the Brokerage\'s own acts or omissions.'),

          // Article 11: General Provisions
          heading2('ARTICLE 11 — GENERAL PROVISIONS'),
          body('11.1 Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the Province of Ontario and the federal laws of Canada applicable therein.'),
          body('11.2 Entire Agreement. This Agreement constitutes the entire agreement between the parties with respect to the subject matter hereof and supersedes all prior negotiations, representations, and agreements.'),
          body('11.3 Amendments. No amendment to this Agreement shall be effective unless made in writing and signed by both parties.'),
          body('11.4 Severability. If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.'),
          body('11.5 Notices. All notices shall be in writing and delivered to the addresses set out above, or to such other address as a party may designate in writing.'),
          body('11.6 Assignment. Neither party may assign this Agreement without the prior written consent of the other party, except that Firm Funds may assign its rights to an affiliate or in connection with a merger or sale of substantially all of its assets.'),
          body('11.7 Electronic Execution. This Agreement may be executed by electronic signature in accordance with the Electronic Commerce Act, 2000 (Ontario), and electronic signatures shall be deemed original signatures for all purposes.'),
        ],
      },
      // Signature Page — separate section so it has no initials in footer
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1400, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Brokerage Cooperation Agreement') },
        footers: { default: makeFooterNoInitials() },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'SIGNATURE PAGE', bold: true, font: FONT, size: 28 })],
          }),

          body('IN WITNESS WHEREOF, the parties have executed this Brokerage Cooperation Agreement as of the date first written above.'),
          emptyLine(),
          emptyLine(),

          // Firm Funds signature block
          body('FIRM FUNDS INC.', { bold: true }),
          emptyLine(),
          body('Name: Bud Jones'),
          body('Title: Principal'),
          emptyLine(),
          body('(Signed on behalf of Firm Funds Inc. prior to delivery)'),

          emptyLine(),
          emptyLine(),
          emptyLine(),

          // Brokerage signature block — DocuSign places tabs here
          body('BROKERAGE:', { bold: true }),
          richParagraph([
            { text: r('{{BROKERAGE_LEGAL_NAME}}') },
          ]),
          emptyLine(),
          richParagraph([
            { text: 'Broker of Record: ' },
            { text: r('{{BROKER_OF_RECORD}}'), bold: true },
          ]),
          emptyLine(),
          emptyLine(),
          body('Signature: /sig1/', { italic: true }),
          body('Date Signed: /dat1/', { italic: true }),
        ],
      },
    ],
  })

  const bcaBuffer = await Packer.toBuffer(doc)
  return Buffer.from(bcaBuffer)
}

// ============================================================================
// CPA Amendment Generator — for closing date changes
// ============================================================================

export async function generateCpaAmendmentDocx(data: Record<string, string>): Promise<Buffer> {
  const r = (key: string) => data[key] || key

  const doc = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1400, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Commission Purchase Agreement — Amendment') },
        footers: { default: makeFooterWithInitials('Seller Initials') },
        children: [
          // Title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: 'AMENDMENT TO COMMISSION PURCHASE AGREEMENT', bold: true, font: FONT, size: 32, color: '000000' })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: '(Closing Date Amendment)', italics: true, font: FONT, size: FONT_SIZE })],
          }),

          // Amendment Date
          richParagraph([
            { text: 'Amendment Date: ' },
            { text: r('{{AMENDMENT_DATE}}'), bold: true },
          ]),
          emptyLine(),

          // Parties
          body('BETWEEN:', { bold: true }),
          body(r('{{AGENT_FULL_LEGAL_NAME}}'), { bold: true, indent: 300 }),
          body('(the "Seller")', { italic: true, indent: 300 }),
          emptyLine(),
          body('— AND —', { alignment: AlignmentType.CENTER, bold: true }),
          emptyLine(),
          body('FIRM FUNDS INC.', { bold: true, indent: 300 }),
          body('(the "Purchaser")', { italic: true, indent: 300 }),
          emptyLine(),

          // Recitals
          heading2('RECITALS'),
          richParagraph([
            { text: 'WHEREAS ', bold: true },
            { text: `the Parties entered into a Commission Purchase Agreement dated ${r('{{ORIGINAL_CPA_DATE}}')} (the "Original Agreement") in connection with the real estate transaction at ${r('{{PROPERTY_ADDRESS}}')};` },
          ], { indent: 300 }),
          richParagraph([
            { text: 'AND WHEREAS ', bold: true },
            { text: `the Seller has notified the Purchaser that the Expected Closing Date of the Real Estate Transaction has been changed from ${r('{{OLD_CLOSING_DATE}}')} to ${r('{{NEW_CLOSING_DATE}}')}, and has provided a copy of the fully executed amendment to the underlying Agreement of Purchase and Sale;` },
          ], { indent: 300 }),
          richParagraph([
            { text: 'AND WHEREAS ', bold: true },
            { text: 'the Parties wish to amend the Original Agreement to reflect the new Expected Closing Date and the corresponding adjustments to the Purchase Discount, Settlement Period Fee, Purchase Price, and Payment Due Date;' },
          ], { indent: 300 }),
          emptyLine(),
          richParagraph([
            { text: 'NOW THEREFORE', bold: true },
            { text: ', in consideration of the mutual covenants herein and for other good and valuable consideration, the Parties agree as follows:' },
          ]),
          emptyLine(),

          // Article 1 — Amendments
          heading2('ARTICLE 1 — AMENDMENTS TO ORIGINAL AGREEMENT'),
          richParagraph([
            { text: '1.1 Expected Closing Date. ', bold: true },
            { text: `The Expected Closing Date is amended from ${r('{{OLD_CLOSING_DATE}}')} to ${r('{{NEW_CLOSING_DATE}}')}.` },
          ]),
          richParagraph([
            { text: '1.2 Purchase Discount. ', bold: true },
            { text: `The Purchase Discount is amended from ${r('{{OLD_PURCHASE_DISCOUNT}}')} to ${r('{{NEW_PURCHASE_DISCOUNT}}')}, calculated at $0.75 per $1,000.00 of Face Value per day for ${r('{{NEW_NUMBER_OF_DAYS}}')} days.` },
          ]),
          richParagraph([
            { text: '1.3 Settlement Period Fee. ', bold: true },
            { text: `The Settlement Period Fee is amended from ${r('{{OLD_SETTLEMENT_PERIOD_FEE}}')} to ${r('{{NEW_SETTLEMENT_PERIOD_FEE}}')}, calculated at $0.75 per $1,000.00 of Face Value per day for fourteen (14) calendar days.` },
          ]),
          richParagraph([
            { text: '1.4 Purchase Price. ', bold: true },
            { text: `The Purchase Price is amended from ${r('{{OLD_PURCHASE_PRICE}}')} to ${r('{{NEW_PURCHASE_PRICE}}')}, being the Face Value less the amended Purchase Discount and Settlement Period Fee.` },
          ]),
          richParagraph([
            { text: '1.5 Payment Due Date. ', bold: true },
            { text: `The Payment Due Date is amended from ${r('{{OLD_DUE_DATE}}')} to ${r('{{NEW_DUE_DATE}}')}, being fourteen (14) calendar days following the new Expected Closing Date.` },
          ]),

          // Article 2 — Adjustment
          heading2('ARTICLE 2 — FINANCIAL ADJUSTMENT'),
          body('2.1 If the original Purchase Price has already been paid to the Seller, the Seller shall pay to the Purchaser the difference between the original Purchase Price and the amended Purchase Price set out in Article 1.4. Such amount shall be charged to the Seller\'s Firm Funds account as a balance owing and may be deducted from future commission purchase transactions, invoiced separately, or demanded by the Purchaser at any time.'),
          body('2.2 If the original Purchase Price has not yet been paid to the Seller, the Purchaser shall pay the amended Purchase Price to the Seller in accordance with the Original Agreement.'),

          // Article 3 — Confirmation
          heading2('ARTICLE 3 — CONFIRMATION OF ORIGINAL AGREEMENT'),
          body('3.1 Except as expressly amended herein, all terms and conditions of the Original Agreement shall remain in full force and effect and are hereby ratified and confirmed by the Parties.'),
          body('3.2 This Amendment shall be read together with the Original Agreement, and in the event of any conflict between this Amendment and the Original Agreement, the provisions of this Amendment shall prevail with respect to the matters addressed herein.'),
          body('3.3 All capitalized terms used but not defined in this Amendment shall have the meanings given to them in the Original Agreement.'),

          // Amendment Summary Table
          emptyLine(),
          heading2('SCHEDULE — AMENDED TERMS SUMMARY'),
          scheduleTable([
            ['Property Address', r('{{PROPERTY_ADDRESS}}')],
            ['Original Closing Date', r('{{OLD_CLOSING_DATE}}')],
            ['Amended Closing Date', r('{{NEW_CLOSING_DATE}}')],
            ['Original Payment Due Date', r('{{OLD_DUE_DATE}}')],
            ['Amended Payment Due Date', r('{{NEW_DUE_DATE}}')],
            ['Face Value', r('{{FACE_VALUE}}')],
            ['Original Purchase Discount', r('{{OLD_PURCHASE_DISCOUNT}}')],
            ['Amended Purchase Discount', r('{{NEW_PURCHASE_DISCOUNT}}')],
            ['Original Settlement Period Fee', r('{{OLD_SETTLEMENT_PERIOD_FEE}}')],
            ['Amended Settlement Period Fee', r('{{NEW_SETTLEMENT_PERIOD_FEE}}')],
            ['Original Purchase Price', r('{{OLD_PURCHASE_PRICE}}')],
            ['Amended Purchase Price', r('{{NEW_PURCHASE_PRICE}}')],
          ]),
        ],
      },

      // Signature Page
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1400, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Commission Purchase Agreement — Amendment Signature') },
        footers: { default: makeFooterNoInitials() },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'SIGNATURE PAGE', bold: true, font: FONT, size: 28, color: '000000' })],
          }),
          body('IN WITNESS WHEREOF the Parties have executed this Amendment as of the Amendment Date first written above.'),
          emptyLine(),
          body('SELLER:', { bold: true }),
          body(`Name: ${r('{{AGENT_FULL_LEGAL_NAME}}')}`),
          body(`RECO Registration No.: ${r('{{RECO_REGISTRATION_NUMBER}}')}`),
          emptyLine(),
          emptyLine(),
          body('Signature: /sig1/', { italic: true }),
          body('Date Signed: /dat1/', { italic: true }),
          emptyLine(),
          emptyLine(),
          body('PURCHASER: FIRM FUNDS INC.', { bold: true }),
          body('By: Bud Jones, Principal'),
        ],
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  return Buffer.from(buffer)
}
