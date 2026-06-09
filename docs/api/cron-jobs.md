# Cron Jobs

_Last updated: 2026-06-09_

This document describes every scheduled `/api/cron/*` endpoint: what it processes, how it is authenticated, and the recommended firing cadence.

## How crons are triggered

These endpoints are not self-scheduling. They are plain GET routes that an external scheduler hits on a fixed cadence. The schedules live on **cron-job.org** under the account `bud@firmfunds.ca`. Each scheduled job sends the request with the shared secret in the `Authorization` header.

## Authentication

Every cron route uses the same scheme:

- It reads `CRON_SECRET` from the environment. If that env var is missing, the route **fails closed** and returns `500` (`{ error: 'Cron not configured' }`).
- It requires the request header `Authorization: Bearer <CRON_SECRET>`. Any mismatch returns `401` (`{ error: 'Unauthorized' }`).

The cron paths are also handled specially by `proxy.ts` (middleware): the `/api/cron/` prefix is CSRF-exempt and is granted public access via a dedicated `pathname.startsWith('/api/cron/')` clause (rather than a literal entry in the `PUBLIC_PATHS` array), so these GET requests are not redirected to `/login` and are not subjected to the browser Origin check. Their only gate is the Bearer secret above.

## Idempotency

Every cron claims a `(job_name, period)` row in `cron_run_log` at the start of the run. The `period` is a time bucket (Toronto-local day, UTC minute, quarter-hour, hour, or `YYYY-MM` depending on the job). A duplicate run within the same bucket hits the table's unique constraint (Postgres error `23505`) and returns `{ already_ran: true }` with `200` without repeating side effects. Each run also records its outcome (`success`, `partial_success`, or `error`) and a details payload back into `cron_run_log`.

## Cron endpoint summary

| Endpoint | Purpose | Suggested schedule | Idempotency period |
| --- | --- | --- | --- |
| `/api/cron/closing-date-alerts` | Daily deal-lifecycle sweep: closing-date alerts, settlement reminders, late-payment interest, failed-deal interest, overdue flagging. | Once per day (morning ET) | Toronto-local day |
| `/api/cron/monthly-broker-statements` | Email profit-share statements to white-label partner brokerages. | Last day of each month, ~18:00 ET | `YYYY-MM` month |
| `/api/cron/firm-deal-poller` | Read brokerage Google Sheets and insert detected events, then parse+match new events and dispatch approved ones — the whole pipeline in one job. | Every 15 minutes | 15-minute bucket |
| `/api/cron/firm-deal-processor` | Parse, dedup, and agent-match new firm-deal events. **Folded into the poller**; route kept for manual trigger, its cron is retired. | inline in poller | 1-minute bucket |
| `/api/cron/firm-deal-dispatcher` | Send the email + SMS pair for approved firm-deal events. **Folded into the poller**; route kept for manual trigger, its cron is retired. | inline in poller | 1-minute bucket |
| `/api/cron/firm-deal-offer-nudges` | Nudge brokerages on offered deals (2h), escalate internally (4h), expire after 60 days. | Hourly | Hour bucket |
| `/api/cron/remediation-overdue-escalation` | Bump escalation level and email a digest for overdue remediation deals. | Once per day (mid-morning ET) | Toronto-local day |
| `/api/cron/retry-failed-emails` | Drain the dead-letter email queue and retry failed sends. | Every 15 minutes | 1-minute bucket |
| `/api/cron/webhook-dedup-cleanup` | Prune DocuSign webhook dedup rows older than 30 days. | Once per day (~04:00 ET) | Toronto-local day |

## Endpoint detail

### `/api/cron/closing-date-alerts`

The main daily lifecycle job. In one run it:

1. Builds and emails an admin digest of deals that are approaching close (within 7 days) or overdue.
2. Recomputes `days_until_closing` on active deals via the `recompute_active_deal_days_until_closing` RPC.
3. Sends settlement-period reminders to agents and brokerages: a closing-day reminder on the closing date and a softer post-deadline payment check-in once the per-deal settlement window has lapsed (uses `settlement_days_at_funding`, which is 7 standard or 14 for bumped brokerages).
4. Posts monthly late-payment interest (24% p.a. compounded daily, starting day 31 after closing) via `autoChargeMonthlyLatePaymentInterest()`.
5. Flags funded deals past the 30-day grace as `payment_status='overdue'`.
6. Posts monthly failed-deal interest (CPA 5.3) via `autoChargeMonthlyFailedDealInterest()`.

Per-iteration failures are collected rather than thrown, so interest posting still runs even if some emails fail; the run is then marked `partial_success`. Source: `app/api/cron/closing-date-alerts/route.ts`.

### `/api/cron/monthly-broker-statements`

Emails a profit-share statement to every brokerage with `profit_share_pct > 0` that is not archived, summarizing deals funded or completed in the period and the broker share earned. Recipient resolves to `broker_of_record_email`, falling back to `brokerage.email`.

Replay safety: an optional `?period=YYYY-MM` overrides the default (current month) but is restricted to the current month or the previous two. Older backfills require the header `X-Admin-Backfill-Approved: <CRON_BACKFILL_SECRET>`. A malformed period returns `400`. Source: `app/api/cron/monthly-broker-statements/route.ts`.

### `/api/cron/firm-deal-poller`

Loads every enabled `brokerage_pipes` row of `pipe_type='spreadsheet'`, reads the configured tabs from each brokerage's Google Sheet (read-only), diffs against `last_poll_state`, and inserts a `firm_deal_events` row (`status='new'`) for each detected trigger. It then runs the rest of the pipeline inline: `processAllNewEvents` (parse + agent-match every `new` event) followed by `dispatchApprovedEvents` (send any `approved` events). Polling persists `last_poll_state` first, so a slow parse can't lose a detection — leftovers retry next run. This single 15-minute job replaced the former every-2-minute processor + dispatcher crons, which kept tripping request timeouts and being auto-disabled by cron-job.org. Source: `app/api/cron/firm-deal-poller/route.ts`.

### `/api/cron/firm-deal-processor`

Picks up `firm_deal_events` rows in `status='new'` (grouped by brokerage) and runs parse with Claude Haiku, dedup, agent-match, and transition status (via `processAllNewEvents`). **This logic now runs inline in the poller** (see above); the standalone route is retained for manual/debug triggering and its cron-job.org schedule is retired. Source: `app/api/cron/firm-deal-processor/route.ts`.

### `/api/cron/firm-deal-dispatcher`

Picks up `firm_deal_events` in `status='approved'` (set either by a manual review-queue send or by auto-fire) and sends the email + SMS notification pair via `dispatchFirmDealNotification` (batched by `dispatchApprovedEvents`, 50 rows/run). Acts mainly as a retry safety net since manual sends also dispatch inline. **This now runs inline in the poller**; the standalone route is retained for manual triggering and its cron-job.org schedule is retired. Source: `app/api/cron/firm-deal-dispatcher/route.ts`.

### `/api/cron/firm-deal-offer-nudges`

For each `deals` row in `status='offered'` **with `agent_self_submit_at` null** (offers the agent took over to submit themselves are excluded, so the brokerage is never nudged about them and they don't auto-expire while the agent works on them), applies up to three time-based actions keyed off `brokerage_notified_at` and `created_at`:

1. 2 hours after notification: nudge the brokerage admin (stamps `brokerage_nudge_2h_at`).
2. 4 hours after notification: send an aggressive internal escalation to the Firm Funds inbox (stamps `internal_alert_4h_at`).
3. 60 days after creation: soft-delete by flipping to `cancelled` with an expiry reason.

Each side effect is gated by its timestamp so it fires at most once. Caps at 200 rows per run. Source: `app/api/cron/firm-deal-offer-nudges/route.ts`.

### `/api/cron/remediation-overdue-escalation`

Daily sweep over `remediation_deals` that are `status='idp_signed'` and older than 14 days (payment expected but not remitted or cancelled). Bumps each row's `escalation_level` by one, then sends a single digest email (never one per row) to the Firm Funds inbox listing every overdue row. Email failures are written to `cron_email_failures` so the retry cron picks them up. Source: `app/api/cron/remediation-overdue-escalation/route.ts`.

### `/api/cron/retry-failed-emails`

Drains the `cron_email_failures` dead-letter queue: rows not yet succeeded, not given up, under the 5-attempt cap, and last attempted more than 15 minutes ago. Dispatches by `email_type` (currently `settlement_reminder` and `offer_decline`). Unknown types are skipped without burning an attempt; reaching the attempt cap marks `gave_up_at` and logs a critical error. Source: `app/api/cron/retry-failed-emails/route.ts`.

### `/api/cron/webhook-dedup-cleanup`

Daily housekeeping that deletes `docusign_webhook_events` rows older than 30 days. The dedup window only needs to cover DocuSign's replay window plus a forensics buffer, so longer retention is unnecessary. Source: `app/api/cron/webhook-dedup-cleanup/route.ts`.
