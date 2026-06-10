// ============================================================================
// Excel (xlsx) generator for the financial reporting system.
//
// Turns a normalized ReportPackage (built by lib/reports/build.ts) into a
// multi-sheet workbook and returns it as a Node Buffer for the
// /api/admin/reports/export route to stream back.
//
// SheetJS notes for this repo:
//   - `xlsx` is the CDN-pinned SheetJS 0.20.3 (NEVER npm-upgrade it). Import
//     with `import * as XLSX from 'xlsx'`, same as lib/roster-import.ts.
//   - Sheets are built array-of-arrays with XLSX.utils.aoa_to_sheet for full
//     control over row/column placement.
//   - We never call XLSX.writeFile (it touches the filesystem and is forbidden
//     in Netlify serverless). XLSX.write({ type: 'buffer' }) returns a Buffer.
//   - The community SheetJS build ignores most cell styling (bold/fill/font),
//     so the ONLY formatting we rely on is per-cell number format (`.z`) and
//     column widths (`!cols`). Money cells are written as real numbers so the
//     accountant can sum them, then stamped with a currency `.z` format.
// ============================================================================

import type { ReportPackage } from './types'
import * as XLSX from 'xlsx'

const MONEY_FORMAT = '$#,##0.00'

// A single cell value placed into an array-of-arrays worksheet.
type Cell = string | number | null

// Round a money value to cents so floating-point noise never reaches the
// spreadsheet (e.g. 1234.5700000001). Returns a real number, never a string,
// so the cells remain summable in Excel.
function money(value: number): number {
  return Math.round(value * 100) / 100
}

// Stamp the currency number format (`.z`) onto every cell in the given columns
// across an inclusive data-row range. Columns are 0-based indices. Rows are
// 0-based worksheet row indices (inclusive). Cells that do not exist or are not
// numeric are skipped, so blank/label rows are never corrupted.
function applyMoneyFormat(
  ws: XLSX.WorkSheet,
  columns: number[],
  firstRow: number,
  lastRow: number
): void {
  if (lastRow < firstRow) return
  for (let r = firstRow; r <= lastRow; r++) {
    for (const c of columns) {
      const ref = XLSX.utils.encode_cell({ r, c })
      const cell = ws[ref] as XLSX.CellObject | undefined
      if (cell && typeof cell.v === 'number') {
        cell.z = MONEY_FORMAT
      }
    }
  }
}

// Set column widths on a worksheet. Width values are character counts (wch).
function setColumnWidths(ws: XLSX.WorkSheet, widths: number[]): void {
  ws['!cols'] = widths.map(wch => ({ wch }))
}

// Excel sheet names must be <= 31 chars and may not contain : \ / ? * [ ].
// All our literal names already satisfy this; this guard keeps it true if a
// name is ever edited.
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ')
  return cleaned.length > 31 ? cleaned.slice(0, 31) : cleaned
}

function appendSheet(wb: XLSX.WorkBook, ws: XLSX.WorkSheet, name: string): void {
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name))
}

// ----------------------------------------------------------------------------
// Sheet builders. Each returns the worksheet (or null when the section is empty
// and should be skipped). 'Summary' is the only sheet that is always present.
// ----------------------------------------------------------------------------

function buildSummarySheet(pkg: ReportPackage): XLSX.WorkSheet {
  const { meta, summary } = pkg
  // Brokerage audience hides Firm Funds margin (fees earned + gross profit) and
  // relabels figures from the brokerage's own point of view.
  const brokerage = meta.audience === 'brokerage'
  const rows: Cell[][] = []

  // Title block.
  rows.push([meta.scopeLabel])
  if (meta.scopeSubLabel) rows.push([meta.scopeSubLabel])
  rows.push([meta.periodLabel])
  rows.push([`Generated ${meta.generatedAtLabel}`])
  rows.push([meta.statusLabel])
  rows.push([]) // blank spacer

  // Key/value summary. Track which rows carry money so we can format them.
  const kvStart = rows.length
  // Brokerage variant drops "Fees earned" + "Firm Funds gross profit",
  // relabels "Brokerage share paid" to "Referral earnings", and relabels the
  // receivable to "Owed to Firm Funds".
  const kv: [string, number][] = brokerage
    ? [
        ['Advances funded (count)', summary.fundedCount],
        ['Advances funded ($)', money(summary.fundedAmount)],
        ['Collected (count)', summary.collectedCount],
        ['Collected ($)', money(summary.collectedAmount)],
        ['Referral earnings', money(summary.referralPaid)],
        ['Owed to Firm Funds (count)', summary.outstandingCount],
        ['Owed to Firm Funds ($)', money(summary.outstandingAmount)],
      ]
    : [
        ['Advances funded (count)', summary.fundedCount],
        ['Advances funded ($)', money(summary.fundedAmount)],
        ['Fees earned', money(summary.feesEarned)],
        ['Collected (count)', summary.collectedCount],
        ['Collected ($)', money(summary.collectedAmount)],
        ['Brokerage share paid', money(summary.referralPaid)],
        ['Firm Funds gross profit', money(summary.firmProfit)],
        ['Outstanding receivable (count)', summary.outstandingCount],
        ['Outstanding receivable ($)', money(summary.outstandingAmount)],
      ]
  // Value-column rows that hold dollars (not counts) get the currency format.
  // 0-based offsets within kv.
  const moneyRowOffsets = brokerage
    ? new Set([1, 3, 4, 6])
    : new Set([1, 2, 4, 5, 6, 8])
  for (const [label, value] of kv) rows.push([label, value])

  rows.push([]) // blank spacer
  for (const note of pkg.notes) rows.push([note])

  const ws = XLSX.utils.aoa_to_sheet(rows)

  // Stamp currency format only on the dollar value cells (column 1).
  for (const offset of moneyRowOffsets) {
    applyMoneyFormat(ws, [1], kvStart + offset, kvStart + offset)
  }

  setColumnWidths(ws, [34, 22])
  return ws
}

function buildFundedSheet(pkg: ReportPackage): XLSX.WorkSheet | null {
  if (pkg.fundedDeals.length === 0) return null

  // Brokerage audience drops the "Fee" column (Firm Funds margin).
  const brokerage = pkg.meta.audience === 'brokerage'

  const header: Cell[] = brokerage
    ? ['Date', 'Deal #', 'Agent', 'Brokerage', 'Advanced', 'Days', 'Status']
    : ['Date', 'Deal #', 'Agent', 'Brokerage', 'Advanced', 'Days', 'Fee', 'Status']
  const rows: Cell[][] = [header]

  let totalAdvanced = 0
  let totalFee = 0
  for (const d of pkg.fundedDeals) {
    totalAdvanced += d.advanceAmount
    totalFee += d.fee
    rows.push(
      brokerage
        ? [d.date, d.dealNumber ?? '', d.agentName, d.brokerageName, money(d.advanceAmount), d.days, d.status]
        : [
            d.date,
            d.dealNumber ?? '',
            d.agentName,
            d.brokerageName,
            money(d.advanceAmount),
            d.days,
            money(d.fee),
            d.status,
          ],
    )
  }

  const dataFirst = 1
  const dataLast = pkg.fundedDeals.length // last data row index (0-based)
  rows.push(
    brokerage
      ? ['Totals', '', '', '', money(totalAdvanced), '', '']
      : ['Totals', '', '', '', money(totalAdvanced), '', money(totalFee), ''],
  )
  const totalsRow = rows.length - 1

  const ws = XLSX.utils.aoa_to_sheet(rows)
  if (brokerage) {
    // Money column: Advanced (4) only.
    applyMoneyFormat(ws, [4], dataFirst, dataLast)
    applyMoneyFormat(ws, [4], totalsRow, totalsRow)
    setColumnWidths(ws, [13, 14, 24, 26, 14, 7, 16])
  } else {
    // Money columns: Advanced (4) and Fee (6), across data rows + totals row.
    applyMoneyFormat(ws, [4, 6], dataFirst, dataLast)
    applyMoneyFormat(ws, [4, 6], totalsRow, totalsRow)
    setColumnWidths(ws, [13, 14, 24, 26, 14, 7, 12, 16])
  }
  return ws
}

function buildCollectionsSheet(pkg: ReportPackage): XLSX.WorkSheet | null {
  if (pkg.collections.length === 0) return null

  const header: Cell[] = [
    'Paid date',
    'Funded date',
    'Deal #',
    'Agent',
    'Brokerage',
    'Amount',
  ]
  const rows: Cell[][] = [header]

  let total = 0
  for (const c of pkg.collections) {
    total += c.amount
    rows.push([
      c.paidDate,
      c.fundedDate ?? '',
      c.dealNumber ?? '',
      c.agentName,
      c.brokerageName,
      money(c.amount),
    ])
  }

  const dataLast = pkg.collections.length
  rows.push(['Total', '', '', '', '', money(total)])
  const totalsRow = rows.length - 1

  const ws = XLSX.utils.aoa_to_sheet(rows)
  applyMoneyFormat(ws, [5], 1, dataLast)
  applyMoneyFormat(ws, [5], totalsRow, totalsRow)
  setColumnWidths(ws, [13, 13, 14, 24, 26, 14])
  return ws
}

function buildRevenueShareSheet(pkg: ReportPackage): XLSX.WorkSheet | null {
  if (pkg.revenueShare.length === 0) return null

  // Brokerage audience drops the "Fees generated" column (Firm Funds margin).
  const brokerage = pkg.meta.audience === 'brokerage'

  const header: Cell[] = brokerage
    ? ['Brokerage', 'Share %', 'Share earned', 'Remitted']
    : ['Brokerage', 'Fees generated', 'Share %', 'Share earned', 'Remitted']
  const rows: Cell[][] = [header]

  let totalFees = 0
  let totalShare = 0
  let totalRemitted = 0
  for (const r of pkg.revenueShare) {
    totalFees += r.feeBase
    totalShare += r.shareAmount
    totalRemitted += r.remitted
    rows.push(
      brokerage
        ? [
            r.brokerageName,
            r.sharePct, // percent stays a plain number (whole-number display value)
            money(r.shareAmount),
            money(r.remitted),
          ]
        : [
            r.brokerageName,
            money(r.feeBase),
            r.sharePct, // percent stays a plain number (whole-number display value)
            money(r.shareAmount),
            money(r.remitted),
          ],
    )
  }

  const dataLast = pkg.revenueShare.length
  rows.push(
    brokerage
      ? ['Totals', '', money(totalShare), money(totalRemitted)]
      : ['Totals', money(totalFees), '', money(totalShare), money(totalRemitted)],
  )
  const totalsRow = rows.length - 1

  const ws = XLSX.utils.aoa_to_sheet(rows)
  if (brokerage) {
    // Money columns: Share earned (2), Remitted (3).
    applyMoneyFormat(ws, [2, 3], 1, dataLast)
    applyMoneyFormat(ws, [2, 3], totalsRow, totalsRow)
    setColumnWidths(ws, [26, 10, 16, 14])
  } else {
    // Money columns: Fees generated (1), Share earned (3), Remitted (4).
    applyMoneyFormat(ws, [1, 3, 4], 1, dataLast)
    applyMoneyFormat(ws, [1, 3, 4], totalsRow, totalsRow)
    setColumnWidths(ws, [26, 16, 10, 16, 14])
  }
  return ws
}

function buildAgingSheet(pkg: ReportPackage): XLSX.WorkSheet | null {
  if (pkg.aging.length === 0) return null

  const header: Cell[] = ['Bucket', 'Deals', 'Amount']
  const rows: Cell[][] = [header]

  let total = 0
  for (const b of pkg.aging) {
    total += b.amount
    rows.push([b.label, b.count, money(b.amount)])
  }

  const dataLast = pkg.aging.length
  rows.push(['Total', '', money(total)])
  const totalsRow = rows.length - 1

  const ws = XLSX.utils.aoa_to_sheet(rows)
  applyMoneyFormat(ws, [2], 1, dataLast)
  applyMoneyFormat(ws, [2], totalsRow, totalsRow)
  setColumnWidths(ws, [22, 8, 16])
  return ws
}

function buildFailedSheet(pkg: ReportPackage): XLSX.WorkSheet | null {
  if (pkg.failedDeals.length === 0) return null

  const header: Cell[] = [
    'Deal #',
    'Agent',
    'Brokerage',
    'Advanced',
    'Outstanding',
    'Interest accrued',
    'Failed on',
    'Status',
  ]
  const rows: Cell[][] = [header]

  for (const f of pkg.failedDeals) {
    rows.push([
      f.dealNumber ?? '',
      f.agentName,
      f.brokerageName,
      money(f.advanceAmount),
      money(f.outstanding),
      money(f.interestAccrued),
      f.failedAt ?? '',
      f.status,
    ])
  }

  const dataLast = pkg.failedDeals.length
  const ws = XLSX.utils.aoa_to_sheet(rows)
  // Money columns: Advanced (3), Outstanding (4), Interest accrued (5).
  applyMoneyFormat(ws, [3, 4, 5], 1, dataLast)
  setColumnWidths(ws, [14, 24, 26, 14, 14, 16, 13, 16])
  return ws
}

function buildDealDetailSheet(pkg: ReportPackage): XLSX.WorkSheet | null {
  if (pkg.dealDetail.length === 0) return null

  // Brokerage audience drops the "Discount fee" + "Settlement fee" columns
  // (Firm Funds margin).
  const brokerage = pkg.meta.audience === 'brokerage'

  const header: Cell[] = brokerage
    ? [
        'Deal #',
        'Status',
        'Agent',
        'Brokerage',
        'Property',
        'Gross commission',
        'Net commission',
        'Advanced',
        'Referral fee',
        'Due from brokerage',
        'Funded',
        'Closing',
        'Repaid',
        'Created',
      ]
    : [
        'Deal #',
        'Status',
        'Agent',
        'Brokerage',
        'Property',
        'Gross commission',
        'Net commission',
        'Discount fee',
        'Settlement fee',
        'Advanced',
        'Referral fee',
        'Due from brokerage',
        'Funded',
        'Closing',
        'Repaid',
        'Created',
      ]
  const rows: Cell[][] = [header]

  for (const d of pkg.dealDetail) {
    rows.push(
      brokerage
        ? [
            d.dealNumber ?? '',
            d.status,
            d.agentName,
            d.brokerageName,
            d.property,
            money(d.grossCommission),
            money(d.netCommission),
            money(d.advanceAmount),
            money(d.referralFee),
            money(d.amountDueFromBrokerage),
            d.fundingDate ?? '',
            d.closingDate ?? '',
            d.repaymentDate ?? '',
            d.createdAt,
          ]
        : [
            d.dealNumber ?? '',
            d.status,
            d.agentName,
            d.brokerageName,
            d.property,
            money(d.grossCommission),
            money(d.netCommission),
            money(d.discountFee),
            money(d.settlementFee),
            money(d.advanceAmount),
            money(d.referralFee),
            money(d.amountDueFromBrokerage),
            d.fundingDate ?? '',
            d.closingDate ?? '',
            d.repaymentDate ?? '',
            d.createdAt,
          ],
    )
  }

  const dataLast = pkg.dealDetail.length
  const ws = XLSX.utils.aoa_to_sheet(rows)
  if (brokerage) {
    // Money columns: Gross (5), Net (6), Advanced (7), Referral fee (8),
    // Due from brokerage (9).
    applyMoneyFormat(ws, [5, 6, 7, 8, 9], 1, dataLast)
    setColumnWidths(ws, [
      14, 16, 24, 26, 30, 17, 16, 14, 13, 18, 13, 13, 13, 13,
    ])
  } else {
    // Money columns: 5..11 inclusive (Gross..Due from brokerage).
    applyMoneyFormat(ws, [5, 6, 7, 8, 9, 10, 11], 1, dataLast)
    setColumnWidths(ws, [
      14, 16, 24, 26, 30, 17, 16, 13, 14, 14, 13, 18, 13, 13, 13, 13,
    ])
  }
  return ws
}

function buildAgentLedgerSheet(pkg: ReportPackage): XLSX.WorkSheet | null {
  if (!pkg.agentLedger) return null

  const rows: Cell[][] = []
  rows.push(['Current balance', money(pkg.agentBalance ?? 0)])
  rows.push([]) // blank spacer

  rows.push(['Date', 'Type', 'Description', 'Amount', 'Running balance'])

  const dataFirst = rows.length
  for (const line of pkg.agentLedger) {
    rows.push([
      line.date,
      line.type,
      line.description,
      money(line.amount),
      money(line.runningBalance),
    ])
  }
  const dataLast = rows.length - 1

  const ws = XLSX.utils.aoa_to_sheet(rows)
  // Current-balance value (row 0, col 1) is money.
  applyMoneyFormat(ws, [1], 0, 0)
  // Amount (3) and Running balance (4) across the ledger data rows.
  if (pkg.agentLedger.length > 0) {
    applyMoneyFormat(ws, [3, 4], dataFirst, dataLast)
  }
  setColumnWidths(ws, [13, 18, 40, 14, 16])
  return ws
}

// ----------------------------------------------------------------------------
// Public entry point.
// ----------------------------------------------------------------------------

export function reportToWorkbook(pkg: ReportPackage): Buffer {
  const wb = XLSX.utils.book_new()

  // 'Summary' is always present.
  appendSheet(wb, buildSummarySheet(pkg), 'Summary')

  const sections: [XLSX.WorkSheet | null, string][] = [
    [buildFundedSheet(pkg), 'Funded'],
    [buildCollectionsSheet(pkg), 'Collections'],
    [buildRevenueShareSheet(pkg), 'Revenue share'],
    [buildAgingSheet(pkg), 'Aging'],
    [buildFailedSheet(pkg), 'Failed deals'],
    [buildDealDetailSheet(pkg), 'Deal detail'],
    [buildAgentLedgerSheet(pkg), 'Agent ledger'],
  ]

  for (const [ws, name] of sections) {
    if (ws) appendSheet(wb, ws, name)
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
