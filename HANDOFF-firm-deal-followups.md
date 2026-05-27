# Handoff — Firm Deal Detection Phase 1 Follow-ups

**Date written:** 2026-05-26 (sessions 33–36; latest is session 36 evening, magic link fully working end-to-end on mobile)
**Status:** Phase 1 LIVE. All P0 + P1 + P2 items shipped. Magic link verified working from a real phone after two production-only bugs got found and fixed. Remaining work is **post-acceptance UX**, captured below.

**For Bud:** Open this file in a new session and say "work through the firm deal handoff" — Claude will know what to do.

---

## Production state right now

- Pipeline: Google Sheets (Choice Realty) → poller (15 min) → processor (2 min, Haiku parser) → review queue → admin clicks Send → Resend email + Twilio SMS in parallel, each carrying a tokenized magic-link CTA.
- All 5 cron jobs live on cron-job.org under `bud@firmfunds.ca`.
- Netlify env vars complete: `TWILIO_*` (4, Restricted key), `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON`, plus `NODE_OPTIONS=--max-old-space-size=4096`.
- Real events from the live sheet sit in `firm_deal_events`. Choice Realty agents have `phone = NULL` and `email = NULL` for test safety; Ryan Dodd has Bud's test contact info (`budj_12@hotmail.com` / `705-542-1016`) manually set so the loop is sendable end-to-end.
- DMARC on `firmfunds.ca` is at `p=none`.
- **Before going live with real recipients:** restore agent phones/emails. They're nowhere backed up automatically — re-import from the original CSV/source.

Last commits on `main` related to firm-deal work:
- `8b00f58` admin nav card (P0 #1)
- `70a4402` per-brokerage filter (P0 #2)
- `b5489ef` onboarding wizard (P0 #3)
- `170b860` / `695c5e1` / `ef81aeb` / `1bf5399` — original P1 #6 magic-link plumbing
- `2ef3274` — banner + auto-fire toggle + per-pipe stats (P1 #6 dashboard side, P2 #8, P2 #9)
- `2298579` — **fix:** route handler now binds Supabase client to the redirect response so the session cookie actually lands on the wire
- `b523186` — **fix:** consume allows reuse within TTL so SMS/Chrome link-prefetch can't burn the token before the agent taps it

---

## DONE — P0 (shipped, verified end-to-end)

### P0 #1 — Admin nav link to `/admin/firm-deal-review` ✅
Shipped in [8b00f58](https://github.com/homefoliomarketing/firm-funds/commit/8b00f58). "Firm Deal Review" appears in the admin dashboard nav with a live red count badge of `unmatched + awaiting_approval + errored` events. Polls every 30s.

### P0 #2 — Per-brokerage filter on the review queue ✅
Shipped in [70a4402](https://github.com/homefoliomarketing/firm-funds/commit/70a4402).

### P0 #3 — New-brokerage onboarding wizard ✅
Shipped in [b5489ef](https://github.com/homefoliomarketing/firm-funds/commit/b5489ef). Five-step wizard at `/admin/brokerages/[id]/firm-deal-pipe`. End-to-end verified 2026-05-26.

### P0 #4 — Resend / DNS deliverability ✅
Resend has `firmfunds.ca` verified with SPF/DKIM/DMARC. DMARC softened to `p=none` on 2026-05-26 while reputation builds.

---

## DONE — P1 (shipped 2026-05-26 sessions 35 + 36)

### P1 #5 — Twilio key tightened to Restricted scope ✅
New key `firmfunds-sms-restricted` (SID `SKe7…7186`) with **Messages: Read + List + Create** only. Old Main-scoped `firmfunds-sms` deleted.

### P1 #6 — Tokenized magic-link CTAs ✅ (fully working on mobile)
The first three shipped commits got a passing dev-server smoke test but **did not work in production**. Session 36 found two production-only bugs that session 35's smoke test missed:

**Bug 1 (commit `2298579`):** The route used the shared `@/lib/supabase/server.createClient()` which writes cookies via `next/headers.cookies()`. In Route Handlers that store is read-only — the writes silently swallow into a try/catch. `verifyOtp` "succeeded" but no auth cookie ever made it onto the redirect response, so middleware on the next request saw no session and bounced the agent to `/login`.

  **Fix:** Build the redirect `NextResponse` first, then construct a route-local `createServerClient` whose `setAll()` writes directly to `response.cookies`. Same pattern `middleware.ts` already uses.

**Bug 2 (commit `b523186`):** Single-use tokens got burned by SMS/Chrome link-prefetch before the human ever tapped. Production DB row showed `used_at` set ~3 seconds after mint — too fast for any human read-then-tap. Bud's actual click then hit an `already_used` token and got redirected to `/login?reason=firm_deal_invalid`.

  **Fix:** Dropped the single-use restriction. Token exists + not expired = valid. `used_at` is still stamped on first hit as a forensic marker. Trade-off: anyone who has the link can sign in as that agent for up to 7 days — but the link was delivered over the agent's own verified email + SMS, so the realistic adversary isn't a hostile party intercepting, it's the automated link scanner between Twilio and the screen. Same trade-off Slack/Notion/etc. make.

End-to-end verified 2026-05-26 evening: real email + SMS sent via production dispatcher → Bud clicked from his Android phone in Chrome → landed signed in on `/agent?firm_deal=<id>` with the Choice Advances offer banner rendering.

Files:
- `supabase/migrations/080_firm_deal_magic_links.sql` — table, 7-day TTL
- `lib/firm-deal-detection/magic-link.ts` — `mintFirmDealMagicLink` + multi-use `consumeFirmDealMagicLink`
- `app/agent/firm-deal/[token]/route.ts` — route-local Supabase client bound to the response
- `lib/firm-deal-detection/dispatch-notification.ts` — mints token per dispatch
- `app/(dashboard)/agent/page.tsx` — reads `?firm_deal=<id>`, renders the offer banner
- `lib/actions/firm-deal-offer-actions.ts` — `getFirmDealOfferForCurrentAgent` enforces matched-agent ownership
- `middleware.ts` — `/agent/firm-deal` allowlisted
- `scripts/test-magic-link-dispatch.mts` — repeatable smoke test; usage at top of file

---

## DONE — P2 (shipped session 36)

### P2 #8 — Per-brokerage auto-fire toggle in the UI ✅
Shipped in [2ef3274](https://github.com/homefoliomarketing/firm-funds/commit/2ef3274). Switch on `/admin/brokerages/[id]/firm-deal-pipe`; confirmation modal quotes lifetime `offer_sent` count.

### P2 #9 — Per-pipe statistics ✅
Same commit. 30-day funnel + last poll/event timestamps + top-10 unresolved shorthands.

---

## TODO — Post-acceptance UX (raised by Bud session 36, end-of-session)

When Bud actually clicked the offer banner CTA, the current flow took him to `/agent/new-deal` (the regular advance-request form). That isn't the right design for the real product. Bud's view:

> "We will need to revamp this whole area before going live, but we also need that to send a notification to the brokerage via email and inside their portal indicating that they have a deal to send to us. I believe most deals will be sent by the brokerage admins."
> "Also if they click that, it disappears after if they go back. This deal should then get put down in their 'Your Deals' list as a New Deal. It should stay there for 60 days and if it doesn't get turned into a deal, it should just drop off and delete."

### Required pieces

**1. Offer-acceptance creates an offered-deal placeholder.**
- New `deals` row on agent CTA click, with a status like `'offered'`. Carries the address / closing date / agent_id / brokerage_id from the parsed firm-deal event.
- Set `firm_deal_events.offer_deal_id` to the new deal id so the dashboard banner stops showing (the existing `?firm_deal` path already scrolls to the row when `offer_deal_id` is set).
- Show it in the agent's "Your Deals" list with a distinct "Offered" badge so the agent knows it's still pending real submission.

**2. Brokerage notification (email + in-portal).**
- Email to the brokerage's `notifications_email` (or whatever the right brokerage contact column is) with the agent name, property, closing date, and a link to the brokerage portal pre-loaded on that deal.
- In-portal: a banner / red-dot on the brokerage dashboard reading "New offer accepted — [Agent Name] wants an advance on [Address]".
- Brokerage admin completes the submission, which transitions `deals.status` from `'offered'` → `'under_review'`.

**3. 60-day expiry sweep.**
- Daily cron deletes (or soft-deletes) `deals` rows that are still `status = 'offered'` 60 days after creation.
- Likely sits alongside the existing closing-date-alerts cron.

**4. CTA copy + button.**
- The banner button currently reads "Request advance". Probably needs to be "Notify my brokerage I want an advance" or similar — clearer about who actually fills out the form.
- After click, the banner should change to a confirmation state ("Your brokerage has been notified") rather than disappearing entirely.

### Open design questions for next session
- Should the brokerage admin be able to **decline** the offer on the agent's behalf? (Probably yes — agent might have an unusual deal that doesn't qualify.)
- If the brokerage admin doesn't act within X days, escalate to the agent ("your brokerage hasn't picked this up; want to submit directly?"). Or just let the 60-day timer expire.
- Where does the agent see the status of the offered deal? Inline on the row? Click-through to a detail page?

**Effort estimate:** 1–2 days end-to-end. Touches three personas (agent CTA, brokerage notification, agent's deal list), one new deal status, one cron, and a chunk of new email templating.

---

## Before going live with real recipients

1. **Restore agent contact info on the Choice Realty roster.** They're nulled-out for test safety; re-import from the original CSV/source.
2. **Decide the brokerage notification design** above and ship #1–#4.
3. **Pick a tester brokerage other than Choice** and walk a fresh agent through the loop end-to-end.

---

## DROPPED (intentionally, per Bud)

### ~~P1 #7 — Onboarding Opportunities tab~~
**Rationale (2026-05-26):** Firm Funds onboards entire brokerages, not individual agents. Skip permanently.

---

## Files / context the next session should read first

1. `firm-deal-detection-plan.md` — original architecture doc.
2. `lib/firm-deal-detection/poll-spreadsheet.ts`, `process-event.ts`, `match-agents.ts`, `dispatch-notification.ts` — the four core modules.
3. `app/(dashboard)/admin/firm-deal-review/page.tsx` — review UI (with per-brokerage filter).
4. `app/(dashboard)/admin/brokerages/[id]/firm-deal-pipe/page.tsx` — pipe page (wizard + toggle + stats).
5. `lib/actions/firm-deal-pipe-actions.ts` — wizard's server actions + `getPipeStatistics` + `setPipeAutoFire`.
6. `lib/actions/firm-deal-review-actions.ts` — server actions for resolve / approve / reject.
7. `lib/actions/firm-deal-offer-actions.ts` — agent-side `getFirmDealOfferForCurrentAgent`.
8. `app/(dashboard)/agent/page.tsx` — banner + scroll-to-deal logic.
9. `app/agent/firm-deal/[token]/route.ts` — magic-link route (the one with the cookie binding fix).
10. `lib/firm-deal-detection/magic-link.ts` — mint + multi-use consume helpers.
11. `scripts/seed-choice-realty-pipe.mjs` — template for the brokerage_pipes config schema.
12. `scripts/test-magic-link-dispatch.mts` — repeatable end-to-end smoke test for the dispatcher path.
13. `supabase/migrations/078_firm_deal_detection.sql`, `079_firm_deal_side_tracking.sql`, `080_firm_deal_magic_links.sql` — schema in order.
14. Project memory `project_firm_deal_detection.md` for the current state.
