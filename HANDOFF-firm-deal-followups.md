# Handoff — Firm Deal Detection Phase 1 Follow-ups

**Date written:** 2026-05-26 (Session 33, refreshed end of session 34, P1 #5 + #6 shipped in session 35)
**Status:** Phase 1 LIVE. All P0 items shipped. P1 #5 (Twilio Restricted key) and P1 #6 (tokenized magic links) shipped 2026-05-26 evening. Only P2 polish items remain.

**For Bud:** Open this file in a new session and say "work through the firm deal handoff" — Claude will know what to do.

---

## Production state right now

- Pipeline: Google Sheets (Choice Realty) → poller (15 min) → processor (2 min, Haiku parser) → review queue → admin clicks Send → Resend email + Twilio SMS in parallel.
- All 5 cron jobs live on cron-job.org under `bud@firmfunds.ca`.
- Netlify env vars complete: `TWILIO_*` (4), `ANTHROPIC_API_KEY`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON`, plus `NODE_OPTIONS=--max-old-space-size=4096` (fixes OOM during TypeScript checking).
- Only real events from the live sheet sit in `firm_deal_events`. Choice Realty agents have `phone = NULL` and `email = NULL` for test safety; Ryan Dodd has Bud's test email + phone manually set so the loop is sendable end-to-end.
- DMARC on `firmfunds.ca` is at `p=none` as of 2026-05-26 (softened from `p=quarantine` to remove DMARC as a possible spam-folder cause while the domain builds reputation). Propagation typically ~1 hour, up to 48 hours globally.
- **Before going live with real recipients:** restore agent phones/emails. They're nowhere backed up automatically — re-import from the original CSV/source.

Last commits on `main`:
- `8b00f58` admin nav card (P0 #1)
- `70a4402` per-brokerage filter (P0 #2)
- `b5489ef` onboarding wizard (P0 #3)

---

## DONE — P0 (shipped, verified end-to-end)

### P0 #1 — Admin nav link to `/admin/firm-deal-review` ✅
Shipped in [8b00f58](https://github.com/homefoliomarketing/firm-funds/commit/8b00f58). "Firm Deal Review" appears in the admin dashboard nav with a live red count badge of `unmatched + awaiting_approval + errored` events. Polls every 30s.

### P0 #2 — Per-brokerage filter on the review queue ✅
Shipped in [70a4402](https://github.com/homefoliomarketing/firm-funds/commit/70a4402). Selector hides when only one brokerage is in the queue, shows "All brokerages (N)" once 2+ are represented. Filter persists to `?brokerage=<uuid>` and survives reload. Filters both pending and recently-resolved lists client-side.

### P0 #3 — New-brokerage onboarding wizard ✅
Shipped in [b5489ef](https://github.com/homefoliomarketing/firm-funds/commit/b5489ef). Five-step wizard at `/admin/brokerages/[id]/firm-deal-pipe`:
1. Sheet share check (paste URL/ID → `testSheetAccess` returns tabs or surfaces service-account share instructions)
2. Tab classification (Conditional / Watch / Ignore; one Conditional required, ≥1 Watch required)
3. Column mapping (preview rows + per-column dropdown; address required, ≥1 of listing/selling agent required)
4. Brand (defaults to `<Brokerage> Advances` / `Powered by Firm Funds`)
5. Confirm + create

Entry point: Inbox icon next to the edit pencil on each brokerage row. Output `brokerage_pipes` row matches what `scripts/seed-choice-realty-pipe.mjs` produces: `auto_fire_enabled=false`, `enabled=true`, no `last_poll_state` so the first poll baselines without firing.

If a pipe already exists, the page short-circuits to a read-only summary instead of letting the admin double-create.

End-to-end verified 2026-05-26: created a "Test Brokerage (DELETE)" record, walked through the wizard against a copy of Choice's sheet, confirmed the inserted pipe shape, ran the poller against it (baselined 984 hashes, 0 events), added a test row to January 2026, triggered the next poll (`rows_new_firm=1, trigger=direct_to_month`). Production processor cron parsed the row via Haiku (correctly extracted address/MLS/closing date and flagged the `(DELETE)` marker in `parser_notes`), event landed in review queue at status `unmatched`. Filter selector switched from hidden to "All brokerages (2)" automatically. Cleanup left the test brokerage soft-deleted (`deleted_at` set) and the test pipe disabled (`enabled=false`); the test Google Sheet ("Firm Funds Test Brokerage Sheet") is still in Bud's Drive and can be deleted whenever.

### P0 #4 — Resend / DNS deliverability ✅
Resend already has `firmfunds.ca` verified with SPF/DKIM/DMARC; the earlier Hotmail spam-folder landing was a reputation/content issue, not DNS. DMARC was further softened to `p=none` on 2026-05-26 to remove DMARC as a possible cause while the brand-new domain builds reputation. Re-test deliverability whenever convenient: send a fresh offer to a Hotmail/Gmail address that has never received Firm Funds mail before. If it lands in inbox, reputation can be ruled out. If it spams, the cause is content/reputation, not DNS.

---

## DONE — P1 (shipped 2026-05-26 session 35)

### P1 #5 — Twilio key tightened to Restricted scope ✅
New key `firmfunds-sms-restricted` (SID `SKe7…7186`) with **Messages: Read + List + Create** only. Old Main-scoped `firmfunds-sms` deleted. Netlify env vars updated, prod deployed, real SMS verified end-to-end to budj_12@hotmail.com via the smoke-test event pattern.

### P1 #6 — Tokenized magic-link CTAs ✅
Shipped across commits `170b860` (feature), `695c5e1` (middleware fix), `ef81aeb` (verifyOtp), `1bf5399` (URL fix). End-to-end verified: cleared cookies → visited `/agent/firm-deal/<token>` → landed signed in on `/agent?firm_deal=<id>` with the agent dashboard rendering Bud's real data.

Files:
- `supabase/migrations/080_firm_deal_magic_links.sql` — new table, 7-day TTL, single-use via `used_at` CAS
- `lib/firm-deal-detection/magic-link.ts` — `mintFirmDealMagicLink` + `consumeFirmDealMagicLink`
- `app/agent/firm-deal/[token]/route.ts` — validates token, generateLink, **server-side** `verifyOtp` so SSR sees the session (NOT redirect to action_link, which puts JWT in URL hash invisible to the server)
- `lib/firm-deal-detection/dispatch-notification.ts` — mints token per dispatch, falls back to deep link if minting fails
- `middleware.ts` — `/agent/firm-deal` in PUBLIC_PATHS, role check skipped on public paths so admins clicking agent links don't get signed out

**Note for future enhancement:** The redirect target `/agent?firm_deal=<id>` carries the param, but `/agent/page.tsx` doesn't yet consume it. To highlight the specific offer, the agent dashboard would need to read `firm_deal` from the query string, look up `firm_deal_events.offer_deal_id`, and either auto-scroll to that deal or show a banner. The original code was already broken here (linked to `/agent/dashboard` which 404'd). Magic link works correctly now; surfacing the specific offer is a separate UI task.

---

## TODO — P2 (when volume justifies)

### P2 #8 — Per-brokerage auto-fire toggle in the UI
**Why:** Right now flipping a brokerage from manual review → auto-fire is a SQL change:
```sql
UPDATE brokerage_pipes SET auto_fire_enabled = true WHERE brokerage_id = '<uuid>';
```

After ~20-30 validated events per brokerage, Bud should be able to flip the switch from the admin UI. Add it to `/admin/brokerages/[id]/firm-deal-pipe` (same page as the onboarding wizard):
- Show: "Mode: Manual review (X validated events)" or "Auto-fire enabled (since YYYY-MM-DD)".
- Big switch with a confirmation modal that quotes the validated-events count.

**Effort:** A couple hours.

### P2 #9 — Per-pipe statistics
**Why:** A small dashboard on `/admin/brokerages/[id]` (or the pipe page) showing:
- Events in the last 30 days (total / sent / rejected / errored)
- Most recent poll time
- Most recent firm-deal event
- Top 10 unresolved shorthands (so Bud can train mappings proactively)

This is for the longer term once 3+ brokerages are live.

**Effort:** Half a day.

---

## DROPPED (intentionally, per Bud)

### ~~P1 #7 — Onboarding Opportunities tab~~
**Rationale (2026-05-26):** Firm Funds onboards entire brokerages, not individual agents. A list of unmapped names doing real volume doesn't fit the business model. Skip permanently.

---

## Files / context the next session should read first

1. `firm-deal-detection-plan.md` — original architecture doc.
2. `lib/firm-deal-detection/poll-spreadsheet.ts`, `process-event.ts`, `match-agents.ts`, `dispatch-notification.ts` — the four core modules.
3. `app/(dashboard)/admin/firm-deal-review/page.tsx` — review UI (with per-brokerage filter).
4. `app/(dashboard)/admin/brokerages/[id]/firm-deal-pipe/page.tsx` — onboarding wizard.
5. `lib/actions/firm-deal-pipe-actions.ts` — wizard's server actions.
6. `lib/actions/firm-deal-review-actions.ts` — server actions for resolve / approve / reject.
7. `scripts/seed-choice-realty-pipe.mjs` — template for the brokerage_pipes config schema.
8. `supabase/migrations/078_firm_deal_detection.sql` — base schema.
9. `supabase/migrations/079_firm_deal_side_tracking.sql` — side-aware columns added in session 33.
10. Project memory `project_firm_deal_detection.md` for the current state.

---

## Working order suggestion

If the next session goes top-to-bottom:
1. **P1 #5** (Twilio key, 5-10 min Bud-side) — quickest hygiene fix.
2. **P1 #6** (magic-link CTAs, half a day) — biggest conversion impact, should ship before real recipients start receiving offers.
3. **P2 #8 / #9** when you have multiple brokerages live and the pain becomes real.
