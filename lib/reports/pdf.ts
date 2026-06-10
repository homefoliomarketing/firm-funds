// =============================================================================
// Branded PDF financial report generator.
// -----------------------------------------------------------------------------
// Renders a polished, multi-page financial report from a normalized
// ReportPackage and returns the raw PDF bytes. This is the PDF counterpart to
// lib/reports/xlsx.ts — both consume the SAME ReportPackage so the two exports
// always agree.
//
// Visual idioms (Letter page, green accent bar, summary boxes, paginated tables
// with repeating headers, per-page footer, manual pagination, manual text
// truncation) are copied from the existing branded report in
// app/api/reports/referral-fees/route.ts. pdf-lib has NO automatic text
// wrapping or pagination, so everything here is done by hand.
// =============================================================================

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib'
import { BRAND_GREEN_HEX } from '../constants'
import type { ReportPackage } from './types'

// -----------------------------------------------------------------------------
// Layout constants
// -----------------------------------------------------------------------------
const PAGE_WIDTH = 612 // Letter portrait
const PAGE_HEIGHT = 792
const MARGIN = 40
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const BOTTOM_LIMIT = MARGIN + 30 // y cursor below this -> start a new page

// BRAND_GREEN_HEX is '#5FA873'. Convert that single source-of-truth hex into a
// pdf-lib rgb() triple so the report green tracks the brand constant.
function hexToRgb(hex: string) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return rgb(r, g, b)
}
const GREEN = hexToRgb(BRAND_GREEN_HEX) // #5FA873 -> rgb(95/255, 168/255, 115/255)
const INK = rgb(0.12, 0.12, 0.12)
const SUBINK = rgb(0.3, 0.3, 0.3)
const GREY = rgb(0.6, 0.6, 0.6)
const LIGHT_GREY = rgb(0.85, 0.85, 0.85)
const AMBER = rgb(0.72, 0.45, 0.0) // warning tone for flagged aging buckets
const ROW_ALT = rgb(0.98, 0.98, 0.98)
const WHITE = rgb(1, 1, 1)
const HEADER_BG = rgb(0.94, 0.94, 0.94)

// Currency formatter — CAD, used everywhere money is printed.
const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
function money(v: number): string {
  return cad.format(Math.round(v * 100) / 100)
}

type Align = 'left' | 'right'

interface ColumnSpec {
  /** Header label drawn in the column header band. */
  label: string
  /** Left edge x of the column (absolute page coordinate). */
  x: number
  /** Column width, used for right-alignment and truncation. */
  width: number
  align: Align
  /** Cell color resolver; defaults to standard ink. */
  color?: (rowIndex: number) => ReturnType<typeof rgb>
  /** Font resolver; defaults to the regular face. */
  bold?: boolean
}

interface RowSpec {
  /** Cell values, parallel to the column array. */
  cells: string[]
  /** Optional per-row override color (e.g. amber for a flagged bucket). */
  color?: ReturnType<typeof rgb>
  /** Render the whole row in bold (used for Totals rows). */
  bold?: boolean
  /** Draw a heavy rule above this row (used for Totals rows). */
  ruleAbove?: boolean
}

export async function reportToPdf(pkg: ReportPackage): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  // ---------------------------------------------------------------------------
  // Logo — resilient filesystem read. NEVER let a missing/oversized/corrupt
  // file crash the report; fall back to a bold-green text wordmark.
  // black.png is the dark wordmark, correct for a white PDF page. pdf-lib can
  // only embed PNG/JPG (not SVG), hence the .png.
  // ---------------------------------------------------------------------------
  let logoImg: Awaited<ReturnType<PDFDocument['embedPng']>> | null = null
  try {
    const logoBytes = await readFile(path.join(process.cwd(), 'public', 'brand', 'black.png'))
    logoImg = await pdfDoc.embedPng(logoBytes)
  } catch {
    logoImg = null
  }

  // ---------------------------------------------------------------------------
  // Page + cursor state. yPos is the baseline the NEXT element will draw at;
  // it counts DOWN from the top margin toward the bottom.
  // ---------------------------------------------------------------------------
  let page: PDFPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let yPos = PAGE_HEIGHT - MARGIN

  /** Draws the green accent bar across the very top of the current page. */
  function drawAccentBar(p: PDFPage) {
    p.drawRectangle({ x: 0, y: PAGE_HEIGHT - 4, width: PAGE_WIDTH, height: 4, color: GREEN })
  }

  /**
   * Starts a fresh page, draws the accent bar + a slim continuation header,
   * resets the y cursor, and returns the new page.
   */
  function newPage(): PDFPage {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    yPos = PAGE_HEIGHT - MARGIN
    drawAccentBar(page)
    page.drawText('Firm Funds — Financial report', {
      x: MARGIN, y: yPos, size: 10, font: fontBold, color: GREEN,
    })
    page.drawText(`${pkg.meta.scopeLabel}  |  ${pkg.meta.periodLabel}`, {
      x: MARGIN, y: yPos - 12, size: 8, font, color: GREY,
    })
    yPos -= 34
    return page
  }

  /** Ensures at least `needed` vertical px remain; otherwise breaks to a new page. */
  function ensureSpace(needed: number) {
    if (yPos - needed < BOTTOM_LIMIT) {
      newPage()
    }
  }

  /** Truncate `text` so it fits within `maxWidth` at `size`, appending an ellipsis. */
  function truncate(text: string, f: PDFFont, size: number, maxWidth: number): string {
    if (!text) return ''
    if (f.widthOfTextAtSize(text, size) <= maxWidth) return text
    const ellipsis = '…'
    let s = text
    while (s.length > 1 && f.widthOfTextAtSize(s + ellipsis, size) > maxWidth) {
      s = s.slice(0, -1)
    }
    return s + ellipsis
  }

  /** Draw a single cell, honoring right-alignment within its column box. */
  function drawCell(
    p: PDFPage, value: string, col: ColumnSpec, baselineY: number,
    f: PDFFont, size: number, color: ReturnType<typeof rgb>,
  ) {
    const pad = 4
    const usable = col.width - pad * 2
    const text = truncate(value, f, size, usable)
    let x = col.x + pad
    if (col.align === 'right') {
      const w = f.widthOfTextAtSize(text, size)
      x = col.x + col.width - pad - w
    }
    p.drawText(text, { x, y: baselineY, size, font: f, color })
  }

  // ---------------------------------------------------------------------------
  // Section title helper.
  // ---------------------------------------------------------------------------
  function sectionTitle(title: string) {
    ensureSpace(30)
    page.drawText(title, { x: MARGIN, y: yPos, size: 12, font: fontBold, color: INK })
    yPos -= 6
    page.drawLine({
      start: { x: MARGIN, y: yPos }, end: { x: PAGE_WIDTH - MARGIN, y: yPos },
      thickness: 1, color: LIGHT_GREY,
    })
    yPos -= 14
  }

  // ---------------------------------------------------------------------------
  // Generic table renderer. Handles a repeating column-header band, alternating
  // row backgrounds, page breaks (re-drawing the header on each new page), and
  // optional bold "ruleAbove" totals rows.
  // ---------------------------------------------------------------------------
  const ROW_H = 16
  const HEADER_H = 18

  function drawColumnHeader(cols: ColumnSpec[]) {
    page.drawRectangle({
      x: MARGIN, y: yPos - 4, width: CONTENT_WIDTH, height: HEADER_H, color: HEADER_BG,
    })
    const headerSize = 7
    for (const col of cols) {
      const label = col.label.toUpperCase()
      const text = truncate(label, fontBold, headerSize, col.width - 8)
      let x = col.x + 4
      if (col.align === 'right') {
        x = col.x + col.width - 4 - fontBold.widthOfTextAtSize(text, headerSize)
      }
      page.drawText(text, { x, y: yPos, size: headerSize, font: fontBold, color: GREY })
    }
    yPos -= HEADER_H + 2
  }

  function drawTable(cols: ColumnSpec[], rows: RowSpec[]) {
    ensureSpace(HEADER_H + ROW_H + 4)
    drawColumnHeader(cols)

    const cellSize = 8
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      // Totals rows want a little extra headroom for their rule.
      const needed = ROW_H + (row.ruleAbove ? 8 : 0)
      if (yPos - needed < BOTTOM_LIMIT) {
        newPage()
        drawColumnHeader(cols)
      }

      if (row.ruleAbove) {
        yPos -= 4
        page.drawLine({
          start: { x: MARGIN, y: yPos + ROW_H - 2 },
          end: { x: PAGE_WIDTH - MARGIN, y: yPos + ROW_H - 2 },
          thickness: 1.5, color: SUBINK,
        })
      } else {
        // Alternating row background for normal data rows.
        page.drawRectangle({
          x: MARGIN, y: yPos - 4, width: CONTENT_WIDTH, height: ROW_H,
          color: i % 2 === 0 ? WHITE : ROW_ALT,
        })
      }

      const rowFont = row.bold ? fontBold : font
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c]
        const value = row.cells[c] ?? ''
        const cellFont = col.bold || row.bold ? fontBold : rowFont
        const color = row.color ?? (col.color ? col.color(i) : INK)
        drawCell(page, value, col, yPos, cellFont, cellSize, color)
      }
      yPos -= ROW_H
    }
    yPos -= 8
  }

  // Helper: build evenly-described columns from [label, width, align] tuples,
  // laying them out left-to-right starting at MARGIN.
  function layoutColumns(
    specs: Array<{ label: string; width: number; align: Align; bold?: boolean; color?: (i: number) => ReturnType<typeof rgb> }>,
  ): ColumnSpec[] {
    const out: ColumnSpec[] = []
    let x = MARGIN
    for (const s of specs) {
      out.push({ label: s.label, x, width: s.width, align: s.align, bold: s.bold, color: s.color })
      x += s.width
    }
    return out
  }

  // ===========================================================================
  // 1. HEADER BAND
  // ===========================================================================
  drawAccentBar(page)
  yPos = PAGE_HEIGHT - MARGIN

  const headerTop = yPos
  // Logo (or text wordmark fallback) top-left, scaled to ~28px tall.
  const LOGO_H = 28
  if (logoImg) {
    const scale = LOGO_H / logoImg.height
    const logoW = logoImg.width * scale
    page.drawImage(logoImg, {
      x: MARGIN, y: headerTop - LOGO_H + 6, width: logoW, height: LOGO_H,
    })
  } else {
    page.drawText('FIRM FUNDS', {
      x: MARGIN, y: headerTop - LOGO_H + 12, size: 18, font: fontBold, color: GREEN,
    })
  }

  // Title under the logo.
  yPos = headerTop - LOGO_H - 6
  page.drawText('Financial report', { x: MARGIN, y: yPos, size: 22, font: fontBold, color: INK })
  yPos -= 22

  // Scope + sub-label.
  page.drawText(pkg.meta.scopeLabel, { x: MARGIN, y: yPos, size: 12, font: fontBold, color: SUBINK })
  yPos -= 15
  if (pkg.meta.scopeSubLabel) {
    page.drawText(pkg.meta.scopeSubLabel, { x: MARGIN, y: yPos, size: 9, font, color: GREY })
    yPos -= 13
  }

  // Period / generated / status line.
  page.drawText(`Period: ${pkg.meta.periodLabel}`, { x: MARGIN, y: yPos, size: 9, font, color: GREY })
  yPos -= 12
  page.drawText(`Generated ${pkg.meta.generatedAtLabel}  •  ${pkg.meta.statusLabel}`, {
    x: MARGIN, y: yPos, size: 9, font, color: GREY,
  })
  yPos -= 8

  page.drawLine({
    start: { x: MARGIN, y: yPos }, end: { x: PAGE_WIDTH - MARGIN, y: yPos },
    thickness: 1, color: LIGHT_GREY,
  })
  yPos -= 20

  // ===========================================================================
  // 2. SUMMARY BOXES (dashboard row, wraps to a second row of 3)
  // ===========================================================================
  const s = pkg.summary
  type SummaryBox = { label: string; value: string; sub?: string; accent: ReturnType<typeof rgb> }
  const boxes: SummaryBox[] = [
    { label: 'ADVANCES FUNDED', value: money(s.fundedAmount), sub: `${s.fundedCount} deal${s.fundedCount !== 1 ? 's' : ''}`, accent: GREEN },
    { label: 'FEES EARNED', value: money(s.feesEarned), accent: rgb(0.24, 0.35, 0.6) },
    { label: 'COLLECTED', value: money(s.collectedAmount), sub: `${s.collectedCount} repayment${s.collectedCount !== 1 ? 's' : ''}`, accent: rgb(0.2, 0.5, 0.35) },
    { label: 'FF GROSS PROFIT', value: money(s.firmProfit), accent: GREEN },
    { label: 'OUTSTANDING RECEIVABLE', value: money(s.outstandingAmount), sub: `${s.outstandingCount} open`, accent: rgb(0.57, 0.44, 0.1) },
  ]

  const perRow = 3
  const gap = 10
  const boxW = (CONTENT_WIDTH - gap * (perRow - 1)) / perRow
  const boxH = 50
  for (let i = 0; i < boxes.length; i++) {
    const colIdx = i % perRow
    if (colIdx === 0 && i > 0) {
      yPos -= boxH + gap // start a new row of boxes
    }
    const bx = MARGIN + colIdx * (boxW + gap)
    const by = yPos - boxH
    const b = boxes[i]
    page.drawRectangle({
      x: bx, y: by, width: boxW, height: boxH,
      color: rgb(0.97, 0.98, 0.97), borderColor: rgb(0.88, 0.92, 0.89), borderWidth: 1,
    })
    page.drawText(b.label, { x: bx + 10, y: by + boxH - 16, size: 7, font: fontBold, color: GREY })
    page.drawText(b.value, { x: bx + 10, y: by + 18, size: 15, font: fontBold, color: b.accent })
    if (b.sub) {
      page.drawText(b.sub, { x: bx + 10, y: by + 6, size: 7, font, color: GREY })
    }
  }
  yPos -= boxH + 24

  // ===========================================================================
  // 3. ADVANCES FUNDED
  // ===========================================================================
  sectionTitle('Advances funded')
  {
    const cols = layoutColumns([
      { label: 'Date', width: 62, align: 'left' },
      { label: 'Deal #', width: 78, align: 'left' },
      { label: 'Agent', width: 110, align: 'left' },
      { label: 'Brokerage', width: 110, align: 'left' },
      { label: 'Advanced', width: 70, align: 'right' },
      { label: 'Days', width: 32, align: 'right' },
      { label: 'Fee', width: 70, align: 'right' },
    ])
    const rows: RowSpec[] = pkg.fundedDeals.map((d) => ({
      cells: [
        d.date, d.dealNumber ?? '—', d.agentName, d.brokerageName,
        money(d.advanceAmount), String(d.days), money(d.fee),
      ],
    }))
    if (rows.length === 0) {
      rows.push({ cells: ['No advances funded in this period.', '', '', '', '', '', ''], color: GREY })
    } else {
      const totAdv = pkg.fundedDeals.reduce((a, d) => a + d.advanceAmount, 0)
      const totFee = pkg.fundedDeals.reduce((a, d) => a + d.fee, 0)
      rows.push({
        cells: [`Totals (${pkg.fundedDeals.length})`, '', '', '', money(totAdv), '', money(totFee)],
        bold: true, ruleAbove: true,
      })
    }
    drawTable(cols, rows)
  }

  // ===========================================================================
  // 4. REPAYMENTS COLLECTED
  // ===========================================================================
  sectionTitle('Repayments collected')
  {
    const cols = layoutColumns([
      { label: 'Paid', width: 62, align: 'left' },
      { label: 'Funded', width: 62, align: 'left' },
      { label: 'Deal #', width: 84, align: 'left' },
      { label: 'Agent', width: 130, align: 'left' },
      { label: 'Brokerage', width: 130, align: 'left' },
      { label: 'Amount', width: 64, align: 'right' },
    ])
    const rows: RowSpec[] = pkg.collections.map((c) => ({
      cells: [c.paidDate, c.fundedDate ?? '—', c.dealNumber ?? '—', c.agentName, c.brokerageName, money(c.amount)],
    }))
    if (rows.length === 0) {
      rows.push({ cells: ['No repayments collected in this period.', '', '', '', '', ''], color: GREY })
    } else {
      const tot = pkg.collections.reduce((a, c) => a + c.amount, 0)
      rows.push({
        cells: [`Total (${pkg.collections.length})`, '', '', '', '', money(tot)],
        bold: true, ruleAbove: true,
      })
    }
    drawTable(cols, rows)
  }

  // ===========================================================================
  // 5. REVENUE SHARE TO BROKERAGES
  // ===========================================================================
  sectionTitle('Revenue share to brokerages')
  {
    const cols = layoutColumns([
      { label: 'Brokerage', width: 200, align: 'left' },
      { label: 'Fees generated', width: 90, align: 'right' },
      { label: 'Share %', width: 60, align: 'right' },
      { label: 'Share earned', width: 90, align: 'right' },
      { label: 'Remitted', width: 92, align: 'right' },
    ])
    const rows: RowSpec[] = pkg.revenueShare.map((r) => ({
      cells: [r.brokerageName, money(r.feeBase), `${r.sharePct}%`, money(r.shareAmount), money(r.remitted)],
    }))
    if (rows.length === 0) {
      rows.push({ cells: ['No revenue share in this period.', '', '', '', ''], color: GREY })
    } else {
      const totBase = pkg.revenueShare.reduce((a, r) => a + r.feeBase, 0)
      const totShare = pkg.revenueShare.reduce((a, r) => a + r.shareAmount, 0)
      const totRem = pkg.revenueShare.reduce((a, r) => a + r.remitted, 0)
      rows.push({
        cells: [`Totals (${pkg.revenueShare.length})`, money(totBase), '', money(totShare), money(totRem)],
        bold: true, ruleAbove: true,
      })
    }
    drawTable(cols, rows)
  }

  // ===========================================================================
  // 6. OUTSTANDING RECEIVABLES (AGING)
  // ===========================================================================
  sectionTitle('Outstanding receivables (aging)')
  {
    const cols = layoutColumns([
      { label: 'Bucket', width: 280, align: 'left' },
      { label: 'Deals', width: 120, align: 'right' },
      { label: 'Amount', width: 132, align: 'right' },
    ])
    const rows: RowSpec[] = pkg.aging.map((b) => ({
      cells: [b.label, String(b.count), money(b.amount)],
      // Flagged (e.g. overdue) buckets render in an amber warning tone.
      color: b.flagged ? AMBER : undefined,
    }))
    if (rows.length === 0) {
      rows.push({ cells: ['No outstanding receivables.', '', ''], color: GREY })
    } else {
      const totCount = pkg.aging.reduce((a, b) => a + b.count, 0)
      const totAmt = pkg.aging.reduce((a, b) => a + b.amount, 0)
      rows.push({ cells: ['Total', String(totCount), money(totAmt)], bold: true, ruleAbove: true })
    }
    drawTable(cols, rows)
  }

  // ===========================================================================
  // 7. FAILED / FLAGGED DEALS (only when present)
  // ===========================================================================
  if (pkg.failedDeals.length > 0) {
    sectionTitle('Failed / flagged deals')
    const cols = layoutColumns([
      { label: 'Deal #', width: 70, align: 'left' },
      { label: 'Agent', width: 92, align: 'left' },
      { label: 'Brokerage', width: 92, align: 'left' },
      { label: 'Advanced', width: 62, align: 'right' },
      { label: 'Outstanding', width: 66, align: 'right' },
      { label: 'Interest', width: 56, align: 'right' },
      { label: 'Failed on', width: 58, align: 'left' },
      { label: 'Status', width: 36, align: 'left' },
    ])
    const rows: RowSpec[] = pkg.failedDeals.map((d) => ({
      cells: [
        d.dealNumber ?? '—', d.agentName, d.brokerageName,
        money(d.advanceAmount), money(d.outstanding), money(d.interestAccrued),
        d.failedAt ?? '—', d.status,
      ],
    }))
    drawTable(cols, rows)
  }

  // ===========================================================================
  // 8. AGENT LEDGER (only for agent-scoped reports)
  // ===========================================================================
  if (pkg.agentLedger) {
    sectionTitle('Agent ledger')

    // Current balance, shown prominently like a summary box.
    ensureSpace(46)
    const balW = 200
    const balH = 40
    const balY = yPos - balH
    const balance = pkg.agentBalance ?? 0
    page.drawRectangle({
      x: MARGIN, y: balY, width: balW, height: balH,
      color: rgb(0.97, 0.98, 0.97), borderColor: rgb(0.88, 0.92, 0.89), borderWidth: 1,
    })
    page.drawText('CURRENT BALANCE', { x: MARGIN + 10, y: balY + balH - 15, size: 7, font: fontBold, color: GREY })
    page.drawText(money(balance), {
      x: MARGIN + 10, y: balY + 10, size: 16, font: fontBold,
      color: balance < 0 ? AMBER : GREEN,
    })
    yPos -= balH + 18

    const cols = layoutColumns([
      { label: 'Date', width: 70, align: 'left' },
      { label: 'Type', width: 90, align: 'left' },
      { label: 'Description', width: 200, align: 'left' },
      { label: 'Amount', width: 80, align: 'right' },
      { label: 'Running balance', width: 92, align: 'right' },
    ])
    const rows: RowSpec[] = pkg.agentLedger.map((l) => ({
      cells: [l.date, l.type, l.description, money(l.amount), money(l.runningBalance)],
    }))
    if (rows.length === 0) {
      rows.push({ cells: ['No ledger activity.', '', '', '', ''], color: GREY })
    }
    drawTable(cols, rows)
  }

  // ===========================================================================
  // 9. NOTES (small grey footnotes)
  // ===========================================================================
  if (pkg.notes.length > 0) {
    ensureSpace(24)
    page.drawText('Notes', { x: MARGIN, y: yPos, size: 9, font: fontBold, color: SUBINK })
    yPos -= 14
    const noteSize = 7
    for (const note of pkg.notes) {
      ensureSpace(12)
      const text = truncate(note, font, noteSize, CONTENT_WIDTH - 10)
      page.drawText(text, { x: MARGIN, y: yPos, size: noteSize, font, color: GREY })
      yPos -= 11
    }
  }

  // ===========================================================================
  // FOOTER on EVERY page — computed after all pages exist so "of Y" is correct.
  // ===========================================================================
  const pages = pdfDoc.getPages()
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    p.drawText('Firm Funds Incorporated  •  firmfunds.ca  •  Confidential', {
      x: MARGIN, y: 20, size: 7, font, color: GREY,
    })
    const pageLabel = `Page ${i + 1} of ${pages.length}`
    const labelW = font.widthOfTextAtSize(pageLabel, 7)
    p.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN - labelW, y: 20, size: 7, font, color: GREY })
    // Bottom green accent line to bookend the top bar.
    p.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: 3, color: GREEN })
  }

  const bytes = await pdfDoc.save()
  return bytes
}
