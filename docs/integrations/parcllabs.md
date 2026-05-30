# ParcLabs Integration (status: not implemented)

_Last updated: 2026-05-29_

This document records that no ParcLabs integration exists in the Firm Funds codebase, and describes the Google Sheets pipeline that actually feeds proactive deal detection in its place.

## 1. There is no ParcLabs integration

The task that requested this document assumed `lib/firm-deals/parcllabs.ts` existed and that ParcLabs publishes real-estate transaction events that Firm Funds ingests. After searching the entire repository (case-insensitive, across all file types) for "parcl", "parcllabs", and "ParcLabs", there are zero matches. There is no `lib/firm-deals/` directory and no `parcllabs.ts` file anywhere.

This is not an absence-of-evidence guess: the search covered the full tree and returned nothing. ParcLabs appears to be a planning-era idea that was never built. The shipped Phase 1 firm-deal pipeline uses a completely different data source.

## 2. What actually feeds the firm-deal matcher: Google Sheets

Proactive deal detection reads each partner brokerage's own deal-tracking Google Sheet. The integration is in `lib/firm-deal-detection/`, and the matcher is `lib/firm-deal-detection/match-agents.ts`. Full detail is in `business/firm-deals.md`; the integration-level facts are summarized here.

### Data it provides

A brokerage's spreadsheet contains one row per deal, spread across tabs: a "Conditional" tab for pending deals and one tab per month for firmed deals. Columns are mapped per brokerage (`column_mapping`) and typically include address, MLS number, listing agent, selling agent, deposit details, closing date, notes, and optionally per-side gross commission. The signal Firm Funds extracts is "this deal just became firm," detected when a row moves from Conditional into a month tab.

### How events are received (polling, not push)

There is no webhook from the sheet. A cron (`app/api/cron/firm-deal-poller`) polls on a schedule and calls `pollSpreadsheetPipe()` in `lib/firm-deal-detection/poll-spreadsheet.ts`. Reads go through `lib/firm-deal-detection/sheets-client.ts`, which uses the Google Sheets API v4 `spreadsheets.values.batchGet` to read all configured tabs in one round-trip. The client is authenticated with a **read-only** service account (scope `https://www.googleapis.com/auth/spreadsheets.readonly`), so it structurally cannot modify a brokerage's sheet. Each poll diffs the current sheet snapshot against the stored `last_poll_state` and writes a `firm_deal_events` row (`status='new'`) for each detected move. The first poll records state only and fires nothing.

### How it feeds the matcher

A separate cron (`firm-deal-processor`) runs `processFirmDealEvent()`, which parses each new row with Claude Haiku 4.5 (`parse-event.ts`), deduplicates on a content hash, and then calls `matchEvent()` in `match-agents.ts` to resolve the listing and selling agent cells against enrolled agents. Matched events become proactive advance offers. See `business/firm-deals.md` for the matcher logic, co-agent split handling, and the offer lifecycle.

## 3. Environment variables and keys

The real pipeline uses Google credentials, not a ParcLabs API key:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` | Service-account credentials JSON for the read-only Sheets client. Stored as a JSON-encoded string (the parser handles a double-encoded value). Must contain a `client_email`. |
| `ANTHROPIC_API_KEY` | Used by the row parser (`parse-event.ts`) to call Claude Haiku 4.5 |
| `CRON_SECRET` | Bearer secret protecting the poller / processor / dispatcher / nudge cron routes |
| `FIRM_FUNDS_OFFER_INBOX` | Fallback recipient for offer notifications (default `bud@firmfunds.ca`) |

There is no ParcLabs API key, base URL, or webhook secret because there is no ParcLabs integration.

## 4. If ParcLabs is added later

If a third-party transaction feed like ParcLabs is ever introduced, the cleanest insertion point is as a new pipe `source` alongside `'spreadsheet'`. `firm_deal_events.source` and the `brokerage_pipes.pipe_type` already model multiple source types (`'spreadsheet' | 'email'`), and `processFirmDealEvent()` currently rejects any source other than `'spreadsheet'` with an explicit "Unsupported source" error. A ParcLabs pipe would add a poller/webhook that writes `firm_deal_events` rows in the same shape, after which the existing parse, dedup, match, and offer machinery would apply unchanged.
