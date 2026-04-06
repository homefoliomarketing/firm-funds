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
  HeadingLevel,
  Header,
  Footer,
  PageNumber,
  Tab,
  TabStopPosition,
  TabStopType,
  SectionType,
} from 'docx'

// ============================================================================
// Shared Helpers
// ============================================================================

const FONT = 'Times New Roman'
const FONT_SIZE = 24 // docx uses half-points, so 24 = 12pt
const SMALL_SIZE = 16 // 8pt

function heading2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 360, after: 120 },
    children: [new TextRun({ text, bold: true, font: FONT, size: 28 })],
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
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
        children: [new TextRun({ text: `FIRM FUNDS INC. — ${title}`, font: FONT, size: 18, color: '666666' })],
      }),
    ],
  })
}

function makeFooter(initialsLabel: string): Footer {
  return new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
        spacing: { before: 100 },
        tabStops: [
          { type: TabStopType.CENTER, position: TabStopPosition.MAX / 2 },
          { type: TabStopType.RIGHT, position: TabStopPosition.MAX },
        ],
        children: [
          new TextRun({ text: `FIRM FUNDS INC. — Confidential`, font: FONT, size: SMALL_SIZE, color: '999999' }),
          new TextRun({ children: [new Tab()] }),
          new TextRun({ text: `${initialsLabel}: /ini1/`, font: FONT, size: SMALL_SIZE, color: '666666' }),
          new TextRun({ children: [new Tab()] }),
          new TextRun({ text: 'Page ', font: FONT, size: SMALL_SIZE, color: '999999' }),
          new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SMALL_SIZE, color: '999999' }),
          new TextRun({ text: ' of ', font: FONT, size: SMALL_SIZE, color: '999999' }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: SMALL_SIZE, color: '999999' }),
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
            shading: { fill: 'EEEEEE' },
            children: [new Paragraph({ children: [new TextRun({ text: 'Item', bold: true, font: FONT, size: 22 })] })],
          }),
          new TableCell({
            width: { size: 65, type: WidthType.PERCENTAGE },
            shading: { fill: 'EEEEEE' },
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
            shading: { fill: 'F5F5F5' },
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
          page: { margin: { top: 1000, bottom: 1200, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Commission Purchase Agreement') },
        footers: { default: makeFooter('Seller Initials') },
        children: [
          // Title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: 'COMMISSION PURCHASE AGREEMENT', bold: true, font: FONT, size: 36 })],
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
            ['"Extension Fee"', ' means the flat per-diem charge applicable if the Real Estate Transaction does not close on or before the Expected Closing Date, calculated in accordance with Article 6;'],
            ['"Face Value"', ' means the net commission payable to the Seller after the Brokerage\'s commission split, as set out in Schedule "A";'],
            ['"Grace Period"', ' means the five (5) calendar day period immediately following the Expected Closing Date during which no Extension Fee shall accrue;'],
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
          richParagraph([{ text: '3.2 Purchase Discount. ', bold: true }, { text: `The Purchase Discount is ${r('{{PURCHASE_DISCOUNT}}')} (the "Purchase Discount"), calculated as follows: $0.75 per $1,000.00 of Face Value per day, for ${r('{{NUMBER_OF_DAYS}}')} days (being the number of calendar days from the date of this Agreement to the Expected Closing Date, plus ten (10) business days).` }]),
          richParagraph([{ text: '3.3 Purchase Price. ', bold: true }, { text: `The Purchase Price payable to the Seller is ${r('{{PURCHASE_PRICE}}')} (the "Purchase Price"), being the Face Value less the Purchase Discount.` }]),
          richParagraph([{ text: '3.4 Payment. ', bold: true }, { text: 'The Purchaser shall pay the Purchase Price to the Seller by electronic funds transfer to the account specified in Schedule "C" within two (2) business days of execution of this Agreement and the Irrevocable Direction to Pay.' }]),

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
          heading2('ARTICLE 6 — EXTENSION FEE'),
          richParagraph([{ text: '6.1 Grace Period. ', bold: true }, { text: 'If the Real Estate Transaction does not close on or before the Expected Closing Date, no Extension Fee shall accrue during the first five (5) calendar days following the Expected Closing Date (the "Grace Period").' }]),
          richParagraph([{ text: '6.2 Extension Fee. ', bold: true }, { text: 'If the Real Estate Transaction does not close within the Grace Period, an extension fee shall apply at the rate of $0.75 per $1,000.00 of Face Value per day for each calendar day from the expiry of the Grace Period to the actual Closing Date, inclusive.' }]),
          richParagraph([{ text: '6.3 Deduction at Collection. ', bold: true }, { text: 'The Extension Fee shall be deducted by the Purchaser from the Commission at the time of collection from the Brokerage.' }]),

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
          page: { margin: { top: 1000, bottom: 1200, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Commission Purchase Agreement — Schedule "A"') },
        footers: { default: makeFooter('Seller Initials') },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'SCHEDULE "A" — TRANSACTION DETAILS', bold: true, font: FONT, size: 28 })],
          }),
          scheduleTable([
            ['Property Address', r('{{PROPERTY_ADDRESS}}')],
            ['MLS Number', r('{{MLS_NUMBER}}')],
            ['Expected Closing Date', r('{{EXPECTED_CLOSING_DATE}}')],
            ['Gross Commission Amount', r('{{GROSS_COMMISSION_AMOUNT}}')],
            ['Brokerage Commission Split', `${r('{{BROKERAGE_SPLIT}}')}%`],
            ['Net Commission to Seller (Face Value)', r('{{FACE_VALUE}}')],
            ['Discount Rate', '$0.75 per $1,000 per day'],
            ['Number of Days', r('{{NUMBER_OF_DAYS}}')],
            ['Purchase Discount', r('{{PURCHASE_DISCOUNT}}')],
            ['Purchase Price (Agent Receives)', r('{{PURCHASE_PRICE}}')],
            ['Brokerage Referral Fee', r('{{BROKERAGE_REFERRAL_FEE}}')],
            ['Brokerage Legal Name', r('{{BROKERAGE_LEGAL_NAME}}')],
            ['Brokerage Address', r('{{BROKERAGE_ADDRESS}}')],
            ['Broker of Record', r('{{BROKER_OF_RECORD}}')],
          ]),
        ],
      },

      // Signature Page — new section (new page)
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1200, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Commission Purchase Agreement — Signature Page') },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                border: { top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
                spacing: { before: 100 },
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                children: [
                  new TextRun({ text: 'FIRM FUNDS INC. — Confidential', font: FONT, size: SMALL_SIZE, color: '999999' }),
                  new TextRun({ children: [new Tab()] }),
                  new TextRun({ text: 'Page ', font: FONT, size: SMALL_SIZE, color: '999999' }),
                  new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SMALL_SIZE, color: '999999' }),
                  new TextRun({ text: ' of ', font: FONT, size: SMALL_SIZE, color: '999999' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: SMALL_SIZE, color: '999999' }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'SIGNATURE PAGE', bold: true, font: FONT, size: 28 })],
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
          page: { margin: { top: 1000, bottom: 1200, left: 1000, right: 1000 } },
        },
        headers: { default: makeHeader('Irrevocable Direction to Pay') },
        footers: { default: makeFooter('Agent Initials') },
        children: [
          // Title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: 'IRREVOCABLE DIRECTION TO PAY', bold: true, font: FONT, size: 36 })],
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

          // Extension Fee
          heading2('EXTENSION FEE ACKNOWLEDGMENT'),
          body('I acknowledge that an Extension Fee may apply if the real estate transaction does not close on or before the Expected Closing Date. The Extension Fee applies at the rate of $0.75 per $1,000.00 of Face Value per day, following a five (5) calendar day grace period after the Expected Closing Date.'),

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
