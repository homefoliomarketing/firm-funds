// =============================================================================
// Deal completion receipt — one-page branded PDF.
// -----------------------------------------------------------------------------
// When a deal completes (funded + repaid -> status 'completed'), the app issues
// the agent a receipt for the advance: the deal/trade number, the key dates, and
// a costs breakdown (net commission, advance amount the agent received, the
// service fee they paid, and the total the brokerage repaid). This builder
// returns the raw PDF bytes as a Buffer.
//
// Visual idioms (Letter page, green accent bar, hexToRgb from the single brand
// constant, manual layout, manual money formatting, logo-or-wordmark fallback)
// are taken from lib/reports/pdf.ts. Unlike that multi-page report builder this
// is deliberately a single, self-contained page: no pagination, no generic table
// engine. pdf-lib has no auto-wrap/pagination, so everything is laid out by hand.
// No em dashes anywhere in the rendered copy.
// =============================================================================

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { BRAND_GREEN_HEX } from '../constants'

// -----------------------------------------------------------------------------
// Layout constants (Letter portrait), matching lib/reports/pdf.ts.
// -----------------------------------------------------------------------------
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 48
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

// BRAND_GREEN_HEX is '#5FA873'. Convert that single source-of-truth hex into a
// pdf-lib rgb() triple so this receipt tracks the brand constant.
function hexToRgb(hex: string) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return rgb(r, g, b)
}
const GREEN = hexToRgb(BRAND_GREEN_HEX)
const INK = rgb(0.12, 0.12, 0.12)
const SUBINK = rgb(0.3, 0.3, 0.3)
const GREY = rgb(0.55, 0.55, 0.55)
const LIGHT_GREY = rgb(0.85, 0.85, 0.85)
const ROW_ALT = rgb(0.97, 0.98, 0.97)
const WHITE = rgb(1, 1, 1)

// Currency formatter - CAD, used everywhere money is printed.
const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
function money(v: number): string {
  return cad.format(Math.round(v * 100) / 100)
}

/** Shape consumed by the receipt builder. The orchestrator in
 *  lib/invoices/completion-receipt.ts assembles this from the deal + agent +
 *  brokerage rows. All money values are plain dollars (not cents). */
export interface CompletionReceiptData {
  /** White-label brand name for the header (brokerage name, or "Firm Funds"). */
  brandName: string
  /** Human-readable deal/trade number, e.g. "0001-0609-26". May be null. */
  dealNumber: string | null
  propertyAddress: string | null
  agentName: string
  brokerageName: string
  /** Key dates as already-formatted display strings ("Jun 9, 2026") or null. */
  fundedDate: string | null
  closingDate: string | null
  repaidDate: string | null
  /** Settlement window in days, snapshotted at funding. */
  settlementDays: number | null
  // Money breakdown (plain dollars).
  netCommission: number
  /** What the agent received. */
  advanceAmount: number
  /** The cost: discount/service fee the agent effectively paid. */
  serviceFee: number
  /** Total the brokerage repaid to Firm Funds. */
  totalRepaid: number
  /** Date the receipt is issued ("Jun 11, 2026"). */
  issuedDate: string
}

/**
 * Render a clean, branded one-page completion receipt and return its PDF bytes
 * as a Buffer. Never throws on a missing logo file (falls back to a text
 * wordmark). Safe to run in a serverless function (pure pdf-lib, no native deps).
 */
export async function buildDealCompletionReceiptPdf(
  data: CompletionReceiptData
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create()
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  // Resilient logo read. NEVER let a missing/corrupt file crash the receipt;
  // fall back to a bold-green text wordmark. black.png is the dark wordmark,
  // correct for a white PDF page. pdf-lib embeds PNG/JPG only (not SVG).
  let logoImg: Awaited<ReturnType<PDFDocument['embedPng']>> | null = null
  try {
    const logoBytes = await readFile(path.join(process.cwd(), 'public', 'brand', 'black.png'))
    logoImg = await pdfDoc.embedPng(logoBytes)
  } catch {
    logoImg = null
  }

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])

  // Truncate helper so a long value never overruns its box.
  function truncate(text: string, size: number, maxWidth: number, bold = false): string {
    const f = bold ? fontBold : font
    if (!text) return ''
    if (f.widthOfTextAtSize(text, size) <= maxWidth) return text
    let s = text
    while (s.length > 1 && f.widthOfTextAtSize(s + '…', size) > maxWidth) {
      s = s.slice(0, -1)
    }
    return s + '…'
  }

  // Green accent bar across the very top, mirroring the report PDF.
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 4, width: PAGE_WIDTH, height: 4, color: GREEN })

  let y = PAGE_HEIGHT - MARGIN

  // ===========================================================================
  // HEADER: logo (or wordmark) on the left, "RECEIPT" eyebrow on the right.
  // ===========================================================================
  const headerTop = y
  const LOGO_H = 30
  if (logoImg) {
    const scale = LOGO_H / logoImg.height
    page.drawImage(logoImg, {
      x: MARGIN, y: headerTop - LOGO_H, width: logoImg.width * scale, height: LOGO_H,
    })
  } else {
    page.drawText(truncate(data.brandName || 'Firm Funds', 18, CONTENT_WIDTH * 0.6, true), {
      x: MARGIN, y: headerTop - LOGO_H + 8, size: 18, font: fontBold, color: GREEN,
    })
  }

  // Right-aligned eyebrow.
  const eyebrow = 'RECEIPT'
  const eyebrowSize = 11
  const eyebrowW = fontBold.widthOfTextAtSize(eyebrow, eyebrowSize)
  page.drawText(eyebrow, {
    x: PAGE_WIDTH - MARGIN - eyebrowW, y: headerTop - 10, size: eyebrowSize,
    font: fontBold, color: GREEN,
  })
  const issuedLabel = `Issued ${data.issuedDate}`
  const issuedW = font.widthOfTextAtSize(issuedLabel, 9)
  page.drawText(issuedLabel, {
    x: PAGE_WIDTH - MARGIN - issuedW, y: headerTop - 24, size: 9, font, color: GREY,
  })

  y = headerTop - LOGO_H - 26

  // ===========================================================================
  // TITLE + prominent deal/trade number.
  // ===========================================================================
  page.drawText('Deal Completion Receipt', { x: MARGIN, y, size: 22, font: fontBold, color: INK })
  y -= 26

  if (data.dealNumber) {
    page.drawText('Deal / Trade Number', { x: MARGIN, y, size: 8, font: fontBold, color: GREY })
    y -= 16
    page.drawText(data.dealNumber, { x: MARGIN, y, size: 18, font: fontBold, color: GREEN })
    y -= 22
  }

  // Divider.
  page.drawLine({
    start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: LIGHT_GREY,
  })
  y -= 26

  // ===========================================================================
  // DETAILS BLOCK: label / value pairs, two columns.
  // ===========================================================================
  page.drawText('Details', { x: MARGIN, y, size: 12, font: fontBold, color: INK })
  y -= 18

  type Pair = { label: string; value: string }
  const details: Pair[] = [
    { label: 'Agent', value: data.agentName || '-' },
    { label: 'Brokerage', value: data.brokerageName || '-' },
    { label: 'Property', value: data.propertyAddress || '-' },
    { label: 'Funded', value: data.fundedDate || '-' },
    { label: 'Closing', value: data.closingDate || '-' },
    { label: 'Repaid / completed', value: data.repaidDate || '-' },
    {
      label: 'Settlement window',
      value: data.settlementDays != null ? `${data.settlementDays} days` : '-',
    },
  ]

  // Two columns of detail rows. Left column gets the odd-indexed split.
  const colGap = 24
  const colW = (CONTENT_WIDTH - colGap) / 2
  const labelSize = 8
  const valueSize = 11
  const rowH = 30
  const leftCount = Math.ceil(details.length / 2)
  const startY = y
  for (let i = 0; i < details.length; i++) {
    const isLeft = i < leftCount
    const colIdx = isLeft ? 0 : 1
    const rowIdx = isLeft ? i : i - leftCount
    const cellX = MARGIN + colIdx * (colW + colGap)
    const cellY = startY - rowIdx * rowH
    const d = details[i]
    page.drawText(d.label.toUpperCase(), {
      x: cellX, y: cellY, size: labelSize, font: fontBold, color: GREY,
    })
    page.drawText(truncate(d.value, valueSize, colW), {
      x: cellX, y: cellY - 14, size: valueSize, font, color: SUBINK,
    })
  }
  // Advance y past the taller of the two columns.
  y = startY - leftCount * rowH - 6

  // Divider.
  page.drawLine({
    start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: LIGHT_GREY,
  })
  y -= 26

  // ===========================================================================
  // COSTS TABLE.
  // ===========================================================================
  page.drawText('Summary', { x: MARGIN, y, size: 12, font: fontBold, color: INK })
  y -= 20

  // Header band.
  const tableRowH = 26
  const amountColW = 150
  const descX = MARGIN + 14
  const amountRightX = PAGE_WIDTH - MARGIN - 14

  page.drawRectangle({
    x: MARGIN, y: y - 6, width: CONTENT_WIDTH, height: 22, color: rgb(0.94, 0.94, 0.94),
  })
  page.drawText('DESCRIPTION', { x: descX, y, size: 8, font: fontBold, color: GREY })
  const amtHdr = 'AMOUNT'
  page.drawText(amtHdr, {
    x: amountRightX - fontBold.widthOfTextAtSize(amtHdr, 8), y, size: 8, font: fontBold, color: GREY,
  })
  y -= 22

  // Body rows. The service fee is the cost line; advance is what the agent got.
  const rows: { label: string; amount: number; emphasize?: boolean }[] = [
    { label: 'Net commission', amount: data.netCommission },
    { label: 'Advance amount (paid to you)', amount: data.advanceAmount },
    { label: 'Service fee', amount: data.serviceFee },
  ]

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (i % 2 === 1) {
      page.drawRectangle({
        x: MARGIN, y: y - 8, width: CONTENT_WIDTH, height: tableRowH, color: ROW_ALT,
      })
    } else {
      page.drawRectangle({
        x: MARGIN, y: y - 8, width: CONTENT_WIDTH, height: tableRowH, color: WHITE,
      })
    }
    page.drawText(truncate(r.label, 11, CONTENT_WIDTH - amountColW - 28), {
      x: descX, y, size: 11, font, color: INK,
    })
    const amtStr = money(r.amount)
    page.drawText(amtStr, {
      x: amountRightX - font.widthOfTextAtSize(amtStr, 11), y, size: 11, font, color: INK,
    })
    y -= tableRowH
  }

  // Total row: heavy rule + bold, in brand green (the total the brokerage repaid).
  y -= 2
  page.drawLine({
    start: { x: MARGIN, y: y + tableRowH - 4 }, end: { x: PAGE_WIDTH - MARGIN, y: y + tableRowH - 4 },
    thickness: 1.5, color: SUBINK,
  })
  const totalLabel = 'Total repaid by brokerage'
  page.drawText(totalLabel, { x: descX, y, size: 12, font: fontBold, color: INK })
  const totalStr = money(data.totalRepaid)
  page.drawText(totalStr, {
    x: amountRightX - fontBold.widthOfTextAtSize(totalStr, 12), y, size: 12, font: fontBold, color: GREEN,
  })
  y -= tableRowH + 10

  // ===========================================================================
  // PAID stamp / confirmation note.
  // ===========================================================================
  const noteBoxH = 54
  const noteY = y - noteBoxH
  page.drawRectangle({
    x: MARGIN, y: noteY, width: CONTENT_WIDTH, height: noteBoxH,
    color: rgb(0.96, 0.98, 0.96), borderColor: rgb(0.78, 0.9, 0.8), borderWidth: 1,
  })
  page.drawText('PAID IN FULL', {
    x: MARGIN + 16, y: noteY + noteBoxH - 22, size: 12, font: fontBold, color: GREEN,
  })
  const confirmLine = 'This advance has been fully repaid and the deal is complete. Keep this receipt for your records.'
  page.drawText(truncate(confirmLine, 9, CONTENT_WIDTH - 32), {
    x: MARGIN + 16, y: noteY + 16, size: 9, font, color: SUBINK,
  })

  // ===========================================================================
  // FOOTER.
  // ===========================================================================
  page.drawText('Firm Funds Incorporated  •  firmfunds.ca', {
    x: MARGIN, y: 28, size: 7, font, color: GREY,
  })
  const conf = 'This is a receipt, not a request for payment.'
  page.drawText(conf, {
    x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(conf, 7), y: 28, size: 7, font, color: GREY,
  })
  // Bottom green accent line to bookend the top bar.
  page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: 3, color: GREEN })

  const bytes = await pdfDoc.save()
  return Buffer.from(bytes)
}
