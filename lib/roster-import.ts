// ============================================================================
// Agent roster parsing, shared by the bulk-import server action and tests.
//
// Accepts .csv and .xlsx/.xls rosters. Both formats funnel into the same
// string[][] shape and through the same header-detection / column-mapping /
// formula-injection pipeline (rowsToBulkAgents), so the two paths cannot
// drift apart. Blank rows are preserved by both parsers so that array index
// i is source row i + 1, which keeps error messages pointing at the row the
// user actually sees in their spreadsheet.
//
// This file must stay free of 'use server': it exports sync helpers and
// constants, which a server-action file cannot.
// ============================================================================

import * as XLSX from 'xlsx'

export interface BulkAgentRow {
  firstName: string
  lastName: string
  // ⚠️ TEMPORARY: email optional for testing, REVERT BEFORE GO-LIVE
  email?: string
  phone?: string
  recoNumber?: string
  addressStreet?: string
  addressCity?: string
  addressProvince?: string
  addressPostalCode?: string
  // 1-based row in the source spreadsheet/CSV, used for error messages.
  sourceRow?: number
}

export const MAX_ROSTER_CSV_BYTES = 256 * 1024
// xlsx is a zip container, so it needs more headroom than plain text. Real
// rosters are tens of KB (the branded 47-agent roster is ~27KB). This cap is
// also the ONLY bound on decompression work: SheetJS inflates the whole zip
// (including sharedStrings) before any parse option applies, and a crafted
// zip can inflate ~1000x. Do not raise this cap casually.
export const MAX_ROSTER_XLSX_BYTES = 1024 * 1024
export const MAX_ROSTER_ROWS = 200
// The branded onboarding roster puts its table header on spreadsheet row 12
// (title banner + Brokerage Details block above it), so scan well past that.
const HEADER_SCAN_ROWS = 25
// Hard bound on the sheet's physical row count. Rejecting (rather than
// truncating) anything longer guarantees rows are never silently dropped;
// 2000 leaves room for styled gaps far beyond the 200-agent import cap.
export const XLSX_SHEET_ROW_LIMIT = 2000

export class RosterSheetTooLargeError extends Error {
  constructor() {
    super(`Roster sheet has more than ${XLSX_SHEET_ROW_LIMIT} rows`)
    this.name = 'RosterSheetTooLargeError'
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      row.push(value)
      value = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++
      row.push(value)
      // Keep blank rows so array index tracks the source line number.
      rows.push(row)
      row = []
      value = ''
      continue
    }

    value += char
  }

  // Drop a phantom final row produced by a trailing newline.
  row.push(value)
  if (row.some(cell => cell.trim() !== '')) rows.push(row)
  return rows
}

// Parse the first worksheet of an .xlsx/.xls workbook into the same
// string[][] shape parseCsv returns. Only the first sheet is parsed (the
// branded roster's second sheet is instructions), and formatted text is used
// so phone numbers and RECO numbers survive as the user sees them rather
// than as raw numerics. Throws RosterSheetTooLargeError instead of silently
// truncating when the sheet's used range exceeds XLSX_SHEET_ROW_LIMIT.
export function parseXlsxRows(data: ArrayBuffer | Uint8Array): string[][] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const workbook = XLSX.read(bytes, {
    type: 'array',
    sheets: 0,
    // Parsed-row cap keeps the output array bounded even when a sheet's used
    // range is huge (e.g. whole-column formatting). The length check below
    // turns hitting this cap into an explicit error, never silent loss.
    sheetRows: XLSX_SHEET_ROW_LIMIT,
    dense: true,
    cellHTML: false,
  })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) return []

  // When sheetRows truncates the parse, SheetJS records the sheet's original
  // range in !fullref. Reject outright instead of silently dropping rows.
  const fullRef = sheet['!fullref'] as string | undefined
  if (fullRef && XLSX.utils.decode_range(fullRef).e.r + 1 > XLSX_SHEET_ROW_LIMIT) {
    throw new RosterSheetTooLargeError()
  }

  // blankrows keeps empty rows so array index i is spreadsheet row i + 1;
  // rowsToBulkAgents relies on that for accurate row numbers in errors.
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true,
  }) as unknown[][]

  return raw.map(row => row.map(cell => (cell == null ? '' : String(cell))))
}

export function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z]/g, '')
}

function isPhoneHeader(header: string) {
  const normalized = normalizeHeader(header)
  return ['phone', 'cell', 'mobile', 'tel', 'telephone'].some(term => normalized.includes(term))
}

export function hasSpreadsheetFormulaRisk(value: string, header: string) {
  const trimmed = value.trimStart()
  if (!/^[=+\-@]/.test(trimmed)) return false

  // Phone numbers commonly start with + and may contain hyphens; allow only
  // those characters in phone-like columns.
  if (isPhoneHeader(header) && /^[+\-\d\s().]+$/.test(trimmed)) return false

  return true
}

export function rowsToBulkAgents(rows: string[][]): { agents: BulkAgentRow[]; error?: string } {
  let headerRowIdx = -1
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const rowText = rows[i].join(' ').toLowerCase()
    if (rowText.includes('first') && rowText.includes('email')) {
      headerRowIdx = i
      break
    }
  }

  if (headerRowIdx < 0) {
    return { agents: [], error: 'Roster must include a header row with First Name and Email columns' }
  }

  const headers = rows[headerRowIdx].map(header => header.trim())
  const dataRows = rows.slice(headerRowIdx + 1)
  if (dataRows.length === 0) return { agents: [], error: 'Roster contains no agent rows' }

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    for (let colIdx = 0; colIdx < headers.length; colIdx++) {
      const cell = dataRows[rowIdx][colIdx] ?? ''
      if (hasSpreadsheetFormulaRisk(cell, headers[colIdx] ?? '')) {
        return {
          agents: [],
          error: `Row ${rowIdx + headerRowIdx + 2}: spreadsheet formula-like values are not allowed`,
        }
      }
    }
  }

  const findValue = (row: string[], needles: string[], excludeNeedles: string[] = []) => {
    const idx = headers.findIndex(header => {
      const normalized = normalizeHeader(header)
      if (excludeNeedles.some(needle => normalized.includes(needle))) return false
      return needles.some(needle => normalized.includes(needle))
    })
    return idx >= 0 ? String(row[idx] ?? '').trim() : ''
  }

  const agents = dataRows
    .map((row, idx) => ({
      firstName: findValue(row, ['firstname', 'first']),
      lastName: findValue(row, ['lastname', 'last']),
      // 'email' (not 'mail') so a "Mailing Address" column is never read as
      // an email; "E-mail" still normalizes to 'email' and matches.
      email: findValue(row, ['email']),
      phone: findValue(row, ['phone', 'cell', 'mobile', 'tel']) || undefined,
      recoNumber: findValue(row, ['reco', 'license', 'licence', 'registration']) || undefined,
      // "Email Address" contains "address": exclude email-ish headers so the
      // street column doesn't grab the email value. "Mailing Address" does
      // not contain 'email' and still maps here.
      addressStreet: findValue(row, ['street', 'addressstreet', 'streetaddress', 'address'], ['email']) || undefined,
      addressCity: findValue(row, ['city', 'addresscity']) || undefined,
      addressProvince: findValue(row, ['province', 'addressprovince', 'state', 'prov']) || undefined,
      addressPostalCode: findValue(row, ['postal', 'postalcode', 'zip', 'addresspostalcode']) || undefined,
      sourceRow: headerRowIdx + 2 + idx,
    }))
    // Drop rows that carry no agent data in any mapped column: blank rows,
    // and the branded roster's pre-styled rows that only hold "#"/Status.
    .filter(agent =>
      [
        agent.firstName,
        agent.lastName,
        agent.email,
        agent.phone,
        agent.recoNumber,
        agent.addressStreet,
        agent.addressCity,
        agent.addressProvince,
        agent.addressPostalCode,
      ].some(value => value !== undefined && value !== '')
    )

  if (agents.length === 0) return { agents: [], error: 'Roster contains no agent rows' }
  if (agents.length > MAX_ROSTER_ROWS) {
    return { agents: [], error: `Maximum ${MAX_ROSTER_ROWS} agents per import` }
  }

  return { agents }
}
