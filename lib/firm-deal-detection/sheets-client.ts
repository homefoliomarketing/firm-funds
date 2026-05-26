/**
 * lib/firm-deal-detection/sheets-client.ts
 *
 * Read-only Google Sheets API client backed by the firmfunds-sheets-poller
 * service account. The scope is `spreadsheets.readonly` so this code
 * structurally cannot mutate any brokerage's sheet.
 *
 * The service account JSON in `.env.local` is stored as a JSON-encoded string
 * (outer quotes, escaped inner quotes), so we parse-twice when needed.
 */
import { google, sheets_v4 } from 'googleapis'

let cachedClient: sheets_v4.Sheets | null = null

function parseServiceAccountCredentials(): Record<string, unknown> {
  const raw = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON
  if (!raw) {
    throw new Error('GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON env var is not set')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
  } catch (e) {
    throw new Error(
      `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON failed to parse: ${(e as Error).message}`
    )
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !(parsed as Record<string, unknown>).client_email
  ) {
    throw new Error(
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON missing client_email; check the env var value'
    )
  }
  return parsed as Record<string, unknown>
}

export function getSheetsClient(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient
  const credentials = parseServiceAccountCredentials()
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
  cachedClient = google.sheets({ version: 'v4', auth })
  return cachedClient
}

/**
 * Read every cell of every named tab in one batchGet round-trip.
 *
 * Returns { [tabName]: rows } where each `rows` is a 2D array exactly as
 * Sheets returns it (trailing empty cells trimmed, empty trailing rows
 * omitted by Sheets).
 */
export async function readAllTabValues(
  sheetId: string,
  tabNames: string[]
): Promise<Record<string, string[][]>> {
  if (tabNames.length === 0) return {}
  const sheets = getSheetsClient()
  // Quote tab names with single quotes; escape any internal quotes by
  // doubling per the A1 spec.
  const ranges = tabNames.map(t => `'${t.replace(/'/g, "''")}'`)
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  })
  const out: Record<string, string[][]> = {}
  const valueRanges = res.data.valueRanges || []
  // batchGet returns results in the same order as ranges
  for (let i = 0; i < tabNames.length; i++) {
    const vr = valueRanges[i]
    const rows = (vr?.values || []) as string[][]
    out[tabNames[i]] = rows
  }
  return out
}

/**
 * Fetch the live list of tab names for a sheet (titles only, no row data).
 * Useful when a brokerage adds new month tabs and we want to discover them.
 */
export async function listTabs(sheetId: string): Promise<string[]> {
  const sheets = getSheetsClient()
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets(properties(title))',
  })
  return (meta.data.sheets || [])
    .map(s => s.properties?.title || '')
    .filter(Boolean)
}
