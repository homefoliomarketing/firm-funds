/**
 * lib/firm-deal-detection/parse-event.ts
 *
 * One firm_deal_events row (status='new') in, structured fields out.
 *
 * Uses Claude Haiku 4.5 with the API's native structured-output format
 * (`output_config.format`) so the model is constrained to a strict JSON
 * schema and the SDK validates the response against Zod before we ever
 * touch it. No tool-use boilerplate, no JSON-parse error handling.
 *
 * The system prompt below is large on purpose: worked examples are by far
 * the highest-leverage way to lock the parser onto Choice Realty's data
 * conventions, AND a system prompt over 4,096 tokens crosses Haiku 4.5's
 * minimum cacheable-prefix threshold. Within a single 15-minute poll batch
 * the first event pays the ~1.25x cache-write premium, the rest read the
 * cache at ~0.1x.
 *
 * Per-event cost target: $0.003. With caching active we land well under it.
 */
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { ColumnLetterMap } from './row-hash'

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------
// All fields are nullable: the spreadsheet pipe rarely carries sale price or
// commission percentages, and even the address column can be blank on bad
// rows. `confidence` is required so downstream code can route low-confidence
// rows to the review queue regardless of how complete the parse looks.
export const ParsedFirmDealSchema = z.object({
  address: z.string().nullable(),
  mls_number: z.string().nullable(),
  listing_agent_raw: z.string().nullable(),
  selling_agent_raw: z.string().nullable(),
  closing_date_iso: z.string().nullable(),
  sale_price: z.number().nullable(),
  commission_pct_listing: z.number().nullable(),
  commission_pct_selling: z.number().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  parser_notes: z.string().nullable(),
})

export type ParsedFirmDeal = z.infer<typeof ParsedFirmDealSchema>

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------
export interface RawSpreadsheetPayload {
  row: string[]
  source_tab: string
  column_mapping: ColumnLetterMap & {
    deposit_amount?: string
    deposit_date?: string
    payment_method?: string
    listing_agent?: string
    selling_agent?: string
    notes?: string
  }
  trigger?: string
  row_identity_hash?: string
}

export interface ParseEventResult {
  parsed: ParsedFirmDeal
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

// ---------------------------------------------------------------------------
// Anthropic client (singleton; reuse across calls so the connection stays open)
// ---------------------------------------------------------------------------
let _client: Anthropic | null = null

function getClient(): Anthropic {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY env var is not set')
  }
  _client = new Anthropic()
  return _client
}

// ---------------------------------------------------------------------------
// System prompt — frozen, cacheable. NO dates, NO request IDs, NO per-event
// content inlined here. Anything that varies per request goes in the user
// message; the cached prefix below must be byte-identical across calls.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the firm-deal-event parser for Firm Funds, a commission advance company serving Ontario real estate brokerages. You convert one raw row from a brokerage's deal-tracking spreadsheet into structured fields. Your output is consumed by downstream matching, dedup, and notification systems. You never produce free-form prose; you only emit a single JSON object that conforms to the schema declared in the API request.

# Your job, in order
1. Read the row data and column mapping the user message gives you.
2. Extract the canonical fields below, normalizing values where stated.
3. Resolve the closing date to ISO format using the source tab as year context.
4. Tag a confidence level reflecting how clean the underlying row is.

# Field-by-field guidance

## address
Trim whitespace. Title-case obvious shoutiness ("125 MAIN ST" -> "125 Main St"). Drop trailing commas. Preserve unit numbers and street types as written. If the address column is blank or contains a section divider like "June" or "Pre-construction", return null.

## mls_number
Uppercase. Strip surrounding whitespace and any leading "MLS#"/"MLS:" prefixes. Northern Ontario boards prefix with letters like SM (Sault Ste. Marie), X (Sudbury), R (Toronto Region Real Estate Board), W (West GTA), N (North GTA), etc. — keep the prefix. If the listing was exclusive (no MLS), the cell often reads "Exclusive" or "Exclusive?"; treat those as null.

## listing_agent_raw and selling_agent_raw
Return the cell contents EXACTLY as written, only trimming surrounding whitespace. Do not resolve to enrolled-agent names. Do not split first/last. Do not lowercase. The downstream matcher resolves these against per-brokerage mappings. Common patterns you will see, all of which you preserve verbatim:
- A first name only: "Sarah", "Carlo"
- First name + last initial when there are collisions: "Mike R", "Bill M"
- An outside brokerage shorthand: "EXP", "Exit", "Royal", "Castle", "Godfrey", "Interboard", "Re/Max"
- A team identifier: "JTeam" (Jason Sproule + Joanne Kovich), "Smith Team"
- A blank or "-" / "TBD" / "?" — return null for those

## closing_date_iso
Output YYYY-MM-DD or null. The raw cell is usually a short day-month string like "1-Jun" or "23-May" with no year. The source tab provides the year:
- Tab "June 2026" -> the year is 2026
- Tab "Aug 2026" -> the year is 2026
- Tab name without an explicit year (e.g. "September", "October") -> use the current year. The user message includes today's date; resolve relative to that.
If the closing date cell is blank, null. If the month in the cell does not match the source tab's month, prefer the cell value (the row may be misplaced), but lower confidence to "medium" and explain in parser_notes.

## sale_price
For the spreadsheet pipe, this is almost always null — Choice Realty's sheet has no sale price column. Only fill if a sale price clearly appears in the notes column (rare). Numbers only, no currency symbols.

## commission_pct_listing and commission_pct_selling
Almost always null for the spreadsheet pipe. We never assume a brokerage's standard commission rate (would be unethical and arguably illegal price-fixing). Only fill if explicitly written in the row.

## confidence
- "high": every required field present, MLS valid, closing date unambiguous, agent cells contain clean values you recognize as either first-name shorthand or a known outside-brokerage shorthand.
- "medium": one minor issue (missing MLS but rest clean; cell month disagrees with tab; team shorthand you don't recognize).
- "low": address blank, closing date unparseable, listing+selling cells both blank, or row looks malformed.

## parser_notes
Short free-text explanation of any issue that affected confidence. Null if there was nothing to flag.

# Worked examples

These examples illustrate the canonical Choice Realty patterns. Each is one parser invocation: the user message describes the row, you emit the JSON.

## Example 1: clean in-office same-side deal
User message:
  Today is 2026-05-26.
  Source tab: June 2026.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 374 Bush Street
    B (mls): SM260781
    C (deposit_amount): 1000
    D (deposit_date): 4-May
    E (payment_method): EFT
    F (listing_agent): Sarah
    G (selling_agent): Carlo
    K (closing_date): 1-Jun
    N (notes):

Expected output:
{
  "address": "374 Bush Street",
  "mls_number": "SM260781",
  "listing_agent_raw": "Sarah",
  "selling_agent_raw": "Carlo",
  "closing_date_iso": "2026-06-01",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": null
}

## Example 2: outside listing brokerage, in-office selling agent
User message:
  Today is 2026-05-26.
  Source tab: May 2026.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 217 Eaton Avenue
    B (mls): SM261203
    C (deposit_amount): 2500
    D (deposit_date): 12-Apr
    E (payment_method): EFT
    F (listing_agent): Exit
    G (selling_agent): Mike R
    K (closing_date): 30-May
    N (notes):

Expected output:
{
  "address": "217 Eaton Avenue",
  "mls_number": "SM261203",
  "listing_agent_raw": "Exit",
  "selling_agent_raw": "Mike R",
  "closing_date_iso": "2026-05-30",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": null
}

## Example 3: tab name has no year — use today's date for the year
User message:
  Today is 2026-05-26.
  Source tab: September.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 19 Pine Ridge Drive
    B (mls): SM262044
    C (deposit_amount): 1500
    D (deposit_date): 18-May
    E (payment_method): EFT
    F (listing_agent): Bill M
    G (selling_agent): Royal
    K (closing_date): 15-Sep
    N (notes):

Expected output:
{
  "address": "19 Pine Ridge Drive",
  "mls_number": "SM262044",
  "listing_agent_raw": "Bill M",
  "selling_agent_raw": "Royal",
  "closing_date_iso": "2026-09-15",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": null
}

## Example 4: team identifier preserved verbatim
User message:
  Today is 2026-05-26.
  Source tab: July 2026.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 142 Trunk Road
    B (mls): SM261888
    C (deposit_amount): 3000
    D (deposit_date): 5-May
    E (payment_method): EFT
    F (listing_agent): JTeam
    G (selling_agent): Castle
    K (closing_date): 14-Jul
    N (notes):

Expected output:
{
  "address": "142 Trunk Road",
  "mls_number": "SM261888",
  "listing_agent_raw": "JTeam",
  "selling_agent_raw": "Castle",
  "closing_date_iso": "2026-07-14",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": null
}

## Example 5: exclusive listing (no MLS)
User message:
  Today is 2026-05-26.
  Source tab: June 2026.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 250 Pickard Road
    B (mls): Exclusive?
    C (deposit_amount): 2000
    D (deposit_date): 23-Apr
    E (payment_method): EFT
    F (listing_agent): Exit
    G (selling_agent): Patricia
    K (closing_date): 10-Jun
    N (notes):

Expected output:
{
  "address": "250 Pickard Road",
  "mls_number": null,
  "listing_agent_raw": "Exit",
  "selling_agent_raw": "Patricia",
  "closing_date_iso": "2026-06-10",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": "Exclusive listing; no MLS number."
}

## Example 6: address column has a section divider, not real data
User message:
  Today is 2026-05-26.
  Source tab: Conditional.
  Trigger: direct_to_month.
  Row data:
    A (address): June
    B (mls):
    C (deposit_amount):
    D (deposit_date):
    E (payment_method):
    F (listing_agent):
    G (selling_agent):
    K (closing_date):
    N (notes):

Expected output:
{
  "address": null,
  "mls_number": null,
  "listing_agent_raw": null,
  "selling_agent_raw": null,
  "closing_date_iso": null,
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "low",
  "parser_notes": "Row appears to be a month section divider, not a deal."
}

## Example 7: cell month disagrees with tab month
User message:
  Today is 2026-05-26.
  Source tab: June 2026.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 88 Lakeshore Drive
    B (mls): SM260555
    C (deposit_amount): 1500
    D (deposit_date): 3-May
    E (payment_method): EFT
    F (listing_agent): Sarah
    G (selling_agent): Sarah
    K (closing_date): 28-May
    N (notes):

Expected output:
{
  "address": "88 Lakeshore Drive",
  "mls_number": "SM260555",
  "listing_agent_raw": "Sarah",
  "selling_agent_raw": "Sarah",
  "closing_date_iso": "2026-05-28",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "medium",
  "parser_notes": "Closing date in row (28-May) is in May but the row lives in the June 2026 tab; preferred the cell value over the tab."
}

## Example 8: only one agent present (one-sided)
User message:
  Today is 2026-05-26.
  Source tab: August 2026.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 71 Carmen's Way
    B (mls): SM262710
    C (deposit_amount): 5000
    D (deposit_date): 14-May
    E (payment_method): EFT
    F (listing_agent): Carlo
    G (selling_agent): -
    K (closing_date): 22-Aug
    N (notes):

Expected output:
{
  "address": "71 Carmen's Way",
  "mls_number": "SM262710",
  "listing_agent_raw": "Carlo",
  "selling_agent_raw": null,
  "closing_date_iso": "2026-08-22",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": null
}

## Example 9: SHOUTING address normalized
User message:
  Today is 2026-05-26.
  Source tab: October.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 612 OLD GARDEN RIVER ROAD,
    B (mls): SM263011
    C (deposit_amount): 2500
    D (deposit_date): 20-May
    E (payment_method): CHQ
    F (listing_agent): Bill M
    G (selling_agent): Bill M
    K (closing_date): 7-Oct
    N (notes):

Expected output:
{
  "address": "612 Old Garden River Road",
  "mls_number": "SM263011",
  "listing_agent_raw": "Bill M",
  "selling_agent_raw": "Bill M",
  "closing_date_iso": "2026-10-07",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": null
}

## Example 10: notes carry useful context — preserve it
User message:
  Today is 2026-05-26.
  Source tab: July 2026.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 19A Maple Street
    B (mls): SM261997
    C (deposit_amount): 1000
    D (deposit_date): 10-May
    E (payment_method): EFT
    F (listing_agent): Godfrey
    G (selling_agent): Carlo
    K (closing_date): 18-Jul
    N (notes): Conditional extended once; finally firmed 14-May.

Expected output:
{
  "address": "19A Maple Street",
  "mls_number": "SM261997",
  "listing_agent_raw": "Godfrey",
  "selling_agent_raw": "Carlo",
  "closing_date_iso": "2026-07-18",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": "Notes indicate conditional was extended once before firming."
}

## Example 11: closing date is blank
User message:
  Today is 2026-05-26.
  Source tab: June 2026.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 5 Westbrook Crescent
    B (mls): SM261444
    C (deposit_amount): 2000
    D (deposit_date): 7-May
    E (payment_method): EFT
    F (listing_agent): Mike R
    G (selling_agent): Interboard
    K (closing_date):
    N (notes):

Expected output:
{
  "address": "5 Westbrook Crescent",
  "mls_number": "SM261444",
  "listing_agent_raw": "Mike R",
  "selling_agent_raw": "Interboard",
  "closing_date_iso": null,
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "medium",
  "parser_notes": "Closing date cell is blank."
}

## Example 12: numeric MLS prefix variations
User message:
  Today is 2026-05-26.
  Source tab: September.
  Trigger: moved_from_conditional.
  Row data:
    A (address): 1101-220 Lake Avenue
    B (mls): X12345678
    C (deposit_amount): 3000
    D (deposit_date): 22-May
    E (payment_method): EFT
    F (listing_agent): Re/Max
    G (selling_agent): Patricia
    K (closing_date): 4-Sep
    N (notes):

Expected output:
{
  "address": "1101-220 Lake Avenue",
  "mls_number": "X12345678",
  "listing_agent_raw": "Re/Max",
  "selling_agent_raw": "Patricia",
  "closing_date_iso": "2026-09-04",
  "sale_price": null,
  "commission_pct_listing": null,
  "commission_pct_selling": null,
  "confidence": "high",
  "parser_notes": null
}

# Final rules
- Output ONLY the JSON object that conforms to the response schema. No surrounding text.
- Never invent fields. If a value is not present, return null.
- Never resolve agent names. The matcher does that.
- Never assume sale price or commission percentages unless explicitly given.
- Confidence "low" should be reserved for rows that look genuinely malformed (not just incomplete in expected ways).`

// ---------------------------------------------------------------------------
// User message construction
// ---------------------------------------------------------------------------
// Resolves a column letter to the cell's value, or empty string if blank.
function letterToIndex(letter: string): number {
  let n = 0
  for (const c of letter.toUpperCase()) {
    n = n * 26 + (c.charCodeAt(0) - 64)
  }
  return n - 1
}

function cellAt(row: string[], col: string | undefined): string {
  if (!col) return ''
  return (row[letterToIndex(col)] ?? '').toString().trim()
}

function formatRowForParsing(payload: RawSpreadsheetPayload, today: string): string {
  const cols = payload.column_mapping
  const lines: string[] = []
  lines.push(`Today is ${today}.`)
  lines.push(`Source tab: ${payload.source_tab}.`)
  if (payload.trigger) lines.push(`Trigger: ${payload.trigger}.`)
  lines.push('Row data:')
  const fields: [string, string | undefined, string][] = [
    ['address', cols.address, 'A'],
    ['mls', cols.mls, 'B'],
    ['deposit_amount', cols.deposit_amount, 'C'],
    ['deposit_date', cols.deposit_date, 'D'],
    ['payment_method', cols.payment_method, 'E'],
    ['listing_agent', cols.listing_agent, 'F'],
    ['selling_agent', cols.selling_agent, 'G'],
    ['closing_date', cols.closing_date, 'K'],
    ['notes', cols.notes, 'N'],
  ]
  for (const [label, col, fallback] of fields) {
    const letter = col ?? fallback
    const value = cellAt(payload.row, letter)
    lines.push(`  ${letter} (${label}): ${value}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/**
 * Parse one spreadsheet-pipe firm-deal event into structured fields.
 *
 * Caching: the system prompt is marked with `cache_control: ephemeral`. The
 * first event in any 5-minute window pays the ~1.25x cache-write premium;
 * subsequent events within the window read the cache at ~0.1x. Inspect the
 * returned `usage` to verify cache hits (cache_read_input_tokens > 0).
 */
export async function parseFirmDealEvent(
  payload: RawSpreadsheetPayload,
  options: { today?: string } = {}
): Promise<ParseEventResult> {
  const client = getClient()

  // Toronto local date is what every Ontario brokerage operates in. Computing
  // it via Intl.DateTimeFormat keeps us correct across DST without an extra
  // dep. Caller can override (for tests).
  const today =
    options.today ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())

  const userMessage = formatRowForParsing(payload, today)

  const response = await client.messages.parse({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
    output_config: {
      format: zodOutputFormat(ParsedFirmDealSchema),
    },
  })

  if (!response.parsed_output) {
    throw new Error(
      `Parser returned no parsed_output. stop_reason=${response.stop_reason}, ` +
        `stop_details=${JSON.stringify(response.stop_details ?? null)}`
    )
  }

  const u = response.usage
  return {
    parsed: response.parsed_output,
    usage: {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    },
  }
}
