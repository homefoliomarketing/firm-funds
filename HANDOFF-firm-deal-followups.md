# Handoff — Firm Deal Detection Phase 1 Follow-ups

**Date written:** 2026-05-26 (Session 33)
**Status:** Phase 1 LIVE in production. End-to-end verified with real event "129 Simon Ave" → Ryan Dodd. This handoff covers everything left to make daily use comfortable + the path to onboarding a second brokerage.

**For Bud:** Open this file in a new session and say "work through the firm deal handoff" — Claude will know what to do.

---

## Production state right now

- Pipeline: Google Sheets (Choice Realty) → poller (15 min) → processor (2 min, Haiku parser) → review queue → admin clicks Send → Resend email + Twilio SMS in parallel.
- All 5 cron jobs live on cron-job.org under `bud@firmfunds.ca`. Account password is in 1Password / saved logins.
- Netlify env vars complete: `TWILIO_*` (4), `ANTHROPIC_API_KEY`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON`, plus `NODE_OPTIONS=--max-old-space-size=4096` (fixes the OOM during TypeScript checking).
- Test data wiped from `firm_deal_events`. Only real events from the live sheet remain.
- All 46 Century 21 Choice Realty agents have `phone = NULL` and `email = NULL` for test safety. Ryan Dodd has Bud's test email + phone manually set so the loop is sendable end-to-end.
- Last commit on `main`: `876ea76` (side-tracking fix + UI redesign).

**Before going live with real recipients:** restore agent phones/emails. They're nowhere backed up automatically — re-import from the original CSV/source.

---

## Priority queue

### P0 — daily-use blockers (Bud asked for these)

#### 1. Admin nav link to `/admin/firm-deal-review`
Bud has no clickable path to this page from the admin UI right now. He's typing the URL.

**Where:** `app/(dashboard)/admin/page.tsx`. The dashboard has a card grid (Brokerages, Pending Cures, Reports, Payments, Audit Trail, Messages). Add **Firm Deal Review** with the `Inbox` icon (already used on the review page itself for visual continuity).

**Bonus:** the card should show a live count of pending events (`unmatched + awaiting_approval + errored`). Pull from the same `getFirmDealReviewQueue` action, or do a lightweight count query. Show as a small badge on the card.

**Also add** a sidebar entry if there's a persistent admin sidebar (check `app/(dashboard)/layout.tsx` or wherever the admin chrome lives).

#### 2. Per-brokerage filtering on the review queue
Currently `/admin/firm-deal-review` shows ALL brokerages' events mixed together. With one brokerage that's fine. With two it's a mess.

**Implementation:**
- Add a brokerage selector at the top of the page. Default: "All brokerages". Other options: each distinct `brokerage_id` represented in the queue.
- Persist selection to URL query param (`?brokerage=<uuid>`) so it survives reloads.
- Filter `pending` and `recently_resolved` arrays client-side after fetch — no extra server round-trip needed since `getFirmDealReviewQueue` already returns the brokerage_id on every row.
- When only one brokerage exists, hide the selector (cleaner default).

#### 3. New-brokerage onboarding flow (NO UI exists today)
Today adding a brokerage to the firm-deal pipeline requires:
1. Editing `scripts/seed-choice-realty-pipe.mjs`
2. Running it locally with database credentials
3. Manually sharing the brokerage's Google Sheet with `firmfunds-sheets-poller@firm-funds-sheets.iam.gserviceaccount.com`

That's Claude-only. Bud needs to do this through the admin UI.

**Build a multi-step setup at `/admin/brokerages/[id]/firm-deal-pipe`:**

**Step 1 — Sheet share check.**
- Admin pastes the Sheet ID (or full URL — extract the ID from the URL).
- Backend uses `lib/firm-deal-detection/sheets-client.ts` `listTabs(sheetId)` to test read access.
- If access fails (403), show the service account email with a copy button and "Share the sheet with this email as Viewer, then click 'Retry'" instructions.
- If access succeeds, move to Step 2.

**Step 2 — Tab classification.**
- Show the live list of tabs from the sheet.
- For each tab, three options: `Conditional` (the holding tab — there's exactly one), `Watch` (month tab — these are the "deal went firm" landing tabs), or `Ignore` (anything else: archives, lookup tables, summaries).
- Store the chosen `conditional_tab` and the list of `tabs_to_watch` as the `config` JSON on the pipe.

**Step 3 — Column mapping.**
- Pick any one of the watched tabs and pull the first 5 rows so the admin can see the layout (`readAllTabValues(sheetId, [chosenTab])`).
- For each lettered column (A, B, C, ...) show its first row and let the admin assign a label from a dropdown: `address`, `mls_number`, `closing_date`, `listing_agent`, `selling_agent`, `(ignore)`.
- Required: `address` and at least one of `listing_agent` or `selling_agent`. Recommended: `mls_number`, `closing_date`.
- Store as `config.column_mapping = { address: 'A', mls_number: 'B', ... }`.

**Step 4 — Brand.**
- `brand_name` (e.g., "Choice Advances"). Defaults to `<Brokerage name> Advances`.
- `brand_tagline` (e.g., "Powered by Firm Funds"). Defaults to "Powered by Firm Funds".

**Step 5 — Confirm.**
- Summary of all the above.
- "Create pipe" button → inserts the `brokerage_pipes` row with `enabled=true`, `auto_fire_enabled=false` (manual review mode is the universal default), and an empty `last_poll_state` so the first poll captures a baseline without firing events.

**After Step 5:** the next 15-min poll will baseline the sheet. The poll AFTER that (so ~30 min later) is when real-world changes start triggering events.

#### 4. Resend DNS verification on `firmfunds.ca`
First test sent to budj_12@hotmail.com today landed in spam because `firmfunds.ca` is not verified in Resend (no SPF / DKIM / DMARC).

**Steps for Bud (not a code change):**
1. Log into Resend dashboard → Domains → Add `firmfunds.ca`.
2. Resend gives 3 DNS records (TXT for SPF, TXT for DKIM, CNAME for click tracking).
3. Add records wherever DNS for `firmfunds.ca` is managed. Likely Netlify DNS (Netlify Dashboard → Domains → DNS records) — if Netlify isn't the authoritative DNS, find where the domain is registered (GoDaddy / Namecheap / Cloudflare / etc).
4. Wait ~15 min for propagation. Resend dashboard turns the domain green when verified.
5. Re-test by sending a firm-deal offer to a real email — should land in inbox.

This fix isn't done in code, but it MUST happen before real agents start receiving emails or every one of them will see "Firm Funds" emails in spam.

---

### P1 — security + polish, not blocking

#### 5. Tighten Twilio API key from Main → Restricted (SMS-only)
Current key (`firmfunds-sms`) has Main scope, which grants access to every Twilio resource on the account. We only use SMS via the Programmable Messaging API.

**Steps for Bud (Twilio dashboard):**
1. Account → API Keys → Create new key with "Restricted" scope.
2. Permissions: `Messages` (send and read), nothing else.
3. Replace `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` on Netlify with the new key/secret.
4. Trigger a deploy or wait for the next push to main.
5. Delete the old Main-scoped key.

Auto-recharge is OFF and balance is ~$20, so blast radius is small even if the key leaks. This is hygiene, not urgent.

#### 6. Tokenized magic-link CTAs
Today the offer email + SMS contain a link like `/agent/dashboard?firm_deal=<id>`. If the agent isn't already logged in (they almost certainly aren't), they hit the login wall and have to remember their Firm Funds password or do password reset. That kills the funnel.

**Fix:** the dispatcher generates a one-shot signed token (JWT or random hex stored in a `magic_links` table with TTL ~7 days), embeds it as `/agent/firm-deal/<token>`. A new route at `app/agent/firm-deal/[token]/route.ts` validates the token, signs the agent in (or short-lived session cookie), and redirects to their dashboard with `?firm_deal=<id>`.

There may already be magic-link infrastructure in `lib/auth-helpers.ts` or the existing `/api/magic-link` route — check before reinventing.

#### 7. Onboarding Opportunities tab on review queue
When an unmatched name doesn't belong to any enrolled agent, the admin currently marks it "outside brokerage". Some of those are actually agents at OTHER brokerages we'd love to onboard.

**Build:**
- A second tab on `/admin/firm-deal-review`: "Onboarding opportunities".
- Lists unmatched names where the admin marked "outside" AND the same shorthand has appeared 2+ times in the last 30 days (the threshold is a signal that the person is doing real volume).
- Each row offers: "Send onboarding invite" (one-click email to a user-entered address) or "Dismiss" (remember as outside forever).

---

### P2 — when volume justifies

#### 8. Per-brokerage auto-fire toggle in the UI
Right now flipping a brokerage from manual review → auto-fire is a SQL change:
```sql
UPDATE brokerage_pipes SET auto_fire_enabled = true WHERE brokerage_id = '<uuid>';
```

After 20-30 validated events per brokerage, Bud should be able to flip the switch from the admin UI. Add it to `/admin/brokerages/[id]/firm-deal-pipe` (same page as the onboarding flow above):
- Show: "Mode: Manual review (X validated events)" or "Auto-fire enabled (since YYYY-MM-DD)".
- Big switch with a confirmation modal that quotes the validated-events count.

#### 9. Per-pipe statistics
A small dashboard on `/admin/brokerages/[id]` (or the pipe page) showing:
- Events in the last 30 days (total / sent / rejected / errored)
- Most recent poll time
- Most recent firm-deal event
- Top 10 unresolved shorthands (so Bud can train mappings proactively)

This is for the longer term once 3+ brokerages are live.

---

## Files / context the next session should read first

1. `firm-deal-detection-plan.md` — original architecture doc.
2. `lib/firm-deal-detection/poll-spreadsheet.ts`, `process-event.ts`, `match-agents.ts`, `dispatch-notification.ts` — the four core modules.
3. `app/(dashboard)/admin/firm-deal-review/page.tsx` — current review UI (after today's redesign).
4. `lib/actions/firm-deal-review-actions.ts` — server actions for resolve / approve / reject.
5. `scripts/seed-choice-realty-pipe.mjs` — template for the brokerage_pipes config schema; the new-brokerage onboarding flow needs to produce equivalent rows.
6. `supabase/migrations/078_firm_deal_detection.sql` — base schema.
7. `supabase/migrations/079_firm_deal_side_tracking.sql` — side-aware columns added today.
8. Project memory `project_firm_deal_detection.md` for the current state.

---

## Working order suggestion

If next session goes top-to-bottom: **P0 #1** (nav link, 30 min) → **P0 #2** (filter, 1 hr) → **P0 #3** (onboarding flow, 4-8 hrs — biggest item) → **P0 #4** (DNS, 30 min Bud-side) → then P1 items as time allows.

P0 #1 is the smallest win and unblocks Bud's daily use immediately. Start there.
