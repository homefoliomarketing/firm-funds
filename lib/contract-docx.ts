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
            ['"Purchase Price"', ' means the amount paid by the Purchaser to the Seller, being the Face Value less the Purchase Discount;'],
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
          heading2('ARTICLE 5 — RISK OF LOSS'),
          richParagraph([{ text: '5.1 Assumption of Risk. ', bold: true }, { text: 'The Purchaser acknowledges that by purchasing the Commission, the Purchaser assumes the risk that the Real Estate Transaction may not close for any reason.' }]),
          richParagraph([{ text: '5.2 No Guarantee. ', bold: true }, { text: 'The Seller does not guarantee that the Purchaser will collect the full Face Value of the Commission or any amount whatsoever.' }]),
          richParagraph([{ text: '5.3 Limited Remedies. ', bold: true }, { text: 'In the event that the Real Estate Transaction does not close, the Purchaser\'s remedies shall be limited to those set forth in Article 7.' }]),

          // Article 6
          heading2('ARTICLE 6 — LATE PAYMENT INTEREST'),
          richParagraph([{ text: '6.1 Payment Due Date. ', bold: true }, { text: `The Brokerage shall remit the Commission to the Purchaser within fourteen (14) calendar days following the Expected Closing Date (the "Payment Due Date"). The Payment Due Date for this transaction is ${r('{{DUE_DATE}}')}.` }]),
          richParagraph([{ text: '6.2 Late Payment Interest. ', bold: true }, { text: 'If the Commission is not remitted to the Purchaser by the Payment Due Date, Late Payment Interest shall accrue at the rate of twenty-four percent (24%) per annum, calculated daily on the Purchase Price, commencing on the day following the Payment Due Date and continuing until the date the Commission is received by the Purchaser in full.' }]),
          richParagraph([{ text: '6.3 Responsibility for Late Payment Interest. ', bold: true }, { text: 'The Seller acknowledges and agrees that Late Payment Interest is the sole responsibility of the Seller. Such interest shall be charged to the Seller\'s account with the Purchaser and may be deducted from future commission purchase transactions or invoiced separately at the Purchaser\'s discretion.' }]),
          richParagraph([{ text: '6.4 No Refund of Settlement Period Fee. ', bold: true }, { text: 'For greater certainty, the Settlement Period Fee set out in Article 3.3 is non-refundable and shall not be credited, prorated, or adjusted in any circumstance, including early payment by the Brokerage.' }]),

          // Article 7
          heading2('ARTICLE 7 — NON-CLOSING REMEDIES (LIMITED RECOURSE)'),
          richParagraph([{ text: '7.1 Substitution. ', bold: true }, { text: 'If the Real Estate Transaction does not close, the Seller shall use commercially reasonable efforts, within thirty (30) days, to identify and offer a substitute commission receivable of equal or greater Face Value.' }]),
          richParagraph([{ text: '7.2 Repayment Arrangement. ', bold: true }, { text: 'If the Seller is unable to provide a substitute commission, the Seller shall enter into a reasonable repayment arrangement: (a) repayment of the Purchase Price only; (b) not exceeding six (6) monthly installments; (c) no additional fees or penalties; (d) no compounding or escalation.' }]),
          richParagraph([{ text: '7.3 Recovery Balance. ', bold: true }, { text: 'Any amount owing by the Seller shall be recorded as a recovery balance on the Seller\'s account with the Purchaser. The Purchaser may offset any recovery balance against future commission purchases.' }]),

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
          richParagraph([
            { text: 'The Directed Amount shall be paid from the Brokerage\'s real estate trust account within ' },
            { text: 'five (5) business days', bold: true },
            { text: ' of the closing of the above-referenced real estate transaction, by electronic funds transfer to the following account:' },
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
          body('If the Directed Amount exceeds the commission actually payable to me on this transaction (after the Brokerage\'s commission split), the Brokerage shall pay the lesser of the Directed Amount and the commission actually payable.'),

          // Brokerage Auth
          heading2('BROKERAGE AUTHORIZATION'),
          body('I acknowledge that the Brokerage has entered into a Brokerage Cooperation Agreement with Firm Funds Inc., under which the Brokerage has agreed to honour Irrevocable Directions to Pay. A copy of this Direction will be provided to the Brokerage upon execution.'),

          // Settlement Period Fee & Late Payment Interest
          heading2('SETTLEMENT PERIOD FEE AND LATE PAYMENT INTEREST'),
          body('I acknowledge that a non-refundable Settlement Period Fee has been included in the calculation of the Purchase Price, covering the fourteen (14) calendar day settlement period following the Expected Closing Date during which the Brokerage is required to remit the Commission to the Purchaser.'),
          body('I further acknowledge that if the Commission is not remitted to the Purchaser by the Payment Due Date (being fourteen (14) calendar days after the Expected Closing Date), Late Payment Interest shall accrue at the rate of twenty-four percent (24%) per annum, calculated daily, and shall be charged to my Firm Funds account. Such interest may be deducted from future commission purchase transactions or invoiced separately.'),

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
          // Title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: 'BROKERAGE COOPERATION AGREEMENT', bold: true, font: FONT, size: 36, color: '000000' })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [new TextRun({ text: '(Commission Advance Program)', font: FONT, size: FONT_SIZE, italics: true })],
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
            { text: ', a corporation incorporated under the laws of Ontario, carrying on business at the address on file (the "Purchaser" or "Firm Funds");' },
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

          // Recitals
          body('RECITALS', { bold: true }),
          body('WHEREAS Firm Funds operates a commission advance program under which it purchases the right to receive real estate commission receivables from individual real estate agents ("Agents") registered with the Brokerage;'),
          body('AND WHEREAS the Brokerage acknowledges the value of commission advance services to its Agents, and wishes to cooperate with Firm Funds to facilitate the orderly processing and payment of commission receivables;'),
          body('AND WHEREAS each commission advance transaction will be governed by a separate Commission Purchase Agreement between Firm Funds and the Agent, and an Irrevocable Direction to Pay issued by the Agent to the Brokerage;'),
          body('NOW THEREFORE, in consideration of the mutual covenants and agreements hereinafter set forth, and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the parties agree as follows:'),

          emptyLine(),

          // Article 1: Definitions
          heading2('ARTICLE 1 — DEFINITIONS'),
          body('1.1 "Agent" means a real estate salesperson or broker registered under the Brokerage who enters into a Commission Purchase Agreement with Firm Funds.'),
          body('1.2 "Commission Purchase Agreement" or "CPA" means the agreement between Firm Funds and an Agent pursuant to which Firm Funds purchases the right to receive all or a portion of a commission receivable.'),
          body('1.3 "Irrevocable Direction to Pay" or "IDP" means an irrevocable written instruction from the Agent directing the Brokerage to remit commission funds to Firm Funds.'),
          body('1.4 "Commission Receivable" means the amount of real estate commission payable to an Agent through the Brokerage upon the closing of a real estate transaction.'),
          body('1.5 "Transaction" means a real estate transaction giving rise to a Commission Receivable.'),
          body('1.6 "Settlement Period Fee" means the non-refundable fee of $0.75 per $1,000 of Face Value per day for fourteen (14) calendar days, covering the settlement period during which the Brokerage is required to remit the Commission to the Purchaser.'),
          body('1.7 "Late Payment Interest" means interest at the rate of twenty-four percent (24%) per annum, calculated daily, applicable to any amounts remaining unpaid after the Payment Due Date (being fourteen (14) calendar days following the expected closing date).'),

          // Article 2: Cooperation
          heading2('ARTICLE 2 — COOPERATION AND ACKNOWLEDGMENT'),
          body('2.1 The Brokerage agrees to cooperate with Firm Funds in the processing of commission advance transactions involving its Agents. This cooperation includes, without limitation, honouring Irrevocable Directions to Pay and facilitating the timely remittance of commission funds.'),
          body('2.2 The Brokerage acknowledges that each commission advance transaction constitutes a true sale and purchase of a commission receivable, and not a loan or security interest. The Brokerage acknowledges that upon execution of a CPA and IDP, Firm Funds acquires a property right in the Commission Receivable.'),
          body('2.3 Nothing in this Agreement creates an obligation on the part of the Brokerage to approve or facilitate any individual Agent\'s participation in the commission advance program. Each Agent\'s participation remains subject to the Agent\'s own independent decision and the Brokerage\'s internal policies.'),

          // Article 3: Irrevocable Direction to Pay
          heading2('ARTICLE 3 — IRREVOCABLE DIRECTION TO PAY'),
          body('3.1 Upon receiving a valid Irrevocable Direction to Pay from an Agent, the Brokerage shall honour such direction and remit the directed amount to Firm Funds from the Agent\'s commission upon closing of the Transaction.'),
          body('3.2 The Brokerage acknowledges that an IDP, once executed by the Agent and delivered to the Brokerage, is irrevocable and may not be cancelled, modified, or overridden except with the express written consent of Firm Funds.'),
          body('3.3 The Brokerage agrees to process payment to Firm Funds in the same manner and timeframe as it would remit commission funds to the Agent. Payment shall be made within five (5) business days of the Brokerage receiving commission funds from the Transaction.'),
          body('3.4 In the event of a commission dispute, holdback, or adjustment that affects the amount payable under an IDP, the Brokerage shall promptly notify both the Agent and Firm Funds in writing, and shall not release the directed funds until the dispute is resolved or Firm Funds provides written instructions.'),

          // Article 4: Commission Handling
          heading2('ARTICLE 4 — COMMISSION HANDLING AND REMITTANCE'),
          body('4.1 Upon closing of a Transaction, the Brokerage shall remit the IDP-directed amount directly to Firm Funds by electronic funds transfer (EFT) to the account specified in the IDP, or by such other method as Firm Funds may direct in writing.'),
          body('4.2 Any residual commission amount (i.e., the Agent\'s commission less the IDP-directed amount and any applicable brokerage fees or splits) shall be remitted to the Agent in accordance with the Brokerage\'s standard commission disbursement practices.'),
          body('4.3 The Brokerage shall provide Firm Funds with reasonable confirmation of payment, including the date of remittance and transaction reference number, within five (5) business days of payment.'),

          // Article 5: Notification Obligations
          heading2('ARTICLE 5 — NOTIFICATION OBLIGATIONS'),
          body('5.1 The Brokerage shall promptly notify Firm Funds in writing if it becomes aware of any of the following: (a) a change to the expected closing date of a Transaction subject to an IDP; (b) the termination, collapse, or material amendment of a Transaction; (c) any commission dispute, holdback, or legal proceeding affecting a Commission Receivable; (d) any change in the Agent\'s status, including termination, suspension, or transfer to another brokerage.'),
          body('5.2 The Brokerage shall provide Firm Funds with such notice within two (2) business days of becoming aware of the applicable event.'),

          // Article 6: Agent Authorization
          heading2('ARTICLE 6 — AGENT AUTHORIZATION'),
          body('6.1 The Brokerage confirms that each Agent participating in the commission advance program has been authorized by the Brokerage to enter into a CPA and IDP, or alternatively, that the Brokerage does not restrict its Agents from participating in lawful commission advance arrangements.'),
          body('6.2 The Brokerage agrees not to take any action to impede, discourage, or penalize an Agent solely for participating in the Firm Funds commission advance program.'),

          // Article 7: Term and Termination
          heading2('ARTICLE 7 — TERM AND TERMINATION'),
          body('7.1 This Agreement shall commence on the date first written above and shall continue in force for a period of one (1) year, automatically renewing for successive one-year terms unless either party provides not less than ninety (90) days\' written notice of non-renewal prior to the end of the then-current term.'),
          body('7.2 Either party may terminate this Agreement for cause upon thirty (30) days\' written notice if the other party commits a material breach and fails to cure such breach within the notice period.'),
          body('7.3 Termination of this Agreement shall not affect any IDP that has already been executed and delivered prior to termination. All outstanding IDPs shall continue to be honoured by the Brokerage in accordance with their terms until the underlying Transactions have closed and all amounts have been remitted to Firm Funds.'),

          // Article 8: Representations and Warranties
          heading2('ARTICLE 8 — REPRESENTATIONS AND WARRANTIES'),
          body('8.1 The Brokerage represents and warrants that: (a) it is a brokerage in good standing registered under the Trust in Real Estate Services Act, 2002 (Ontario); (b) the Broker of Record has full authority to enter into this Agreement on behalf of the Brokerage; (c) entering into this Agreement does not conflict with any other agreement or obligation of the Brokerage; (d) it maintains adequate trust accounting and commission disbursement procedures.'),
          body('8.2 Firm Funds represents and warrants that: (a) it is a corporation in good standing under the laws of Ontario; (b) it has full authority to enter into this Agreement; (c) it shall comply with all applicable laws, including FINTRAC requirements, in connection with its commission advance operations.'),

          // Article 9: Confidentiality
          heading2('ARTICLE 9 — CONFIDENTIALITY'),
          body('9.1 Each party agrees to keep confidential all information received from the other party in connection with this Agreement, including Agent information, transaction details, and financial terms. Such information may be disclosed only: (a) to the extent required by law or regulatory authority; (b) to professional advisors bound by confidentiality obligations; (c) with the prior written consent of the disclosing party.'),

          // Article 10: Indemnification
          heading2('ARTICLE 10 — INDEMNIFICATION'),
          body('10.1 The Brokerage shall indemnify and hold harmless Firm Funds from any loss, cost, or expense (including reasonable legal fees) arising from: (a) a breach of this Agreement by the Brokerage; (b) the Brokerage\'s failure to honour a valid IDP; (c) the Brokerage\'s release of directed funds in contravention of an IDP.'),
          body('10.2 Firm Funds shall indemnify and hold harmless the Brokerage from any loss, cost, or expense (including reasonable legal fees) arising from: (a) a breach of this Agreement by Firm Funds; (b) any claim by a third party relating to Firm Funds\' commission advance activities, to the extent such claim does not arise from the Brokerage\'s own acts or omissions.'),

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
          body('Name: Bud Dickie'),
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
