# Firm-Deal Brokerage Notification Revert: Build Plan

## Summary

**The user's framing in the brief is partially off, and reading the
code makes the revert smaller than implied.** At firm-deal detection
time, only the AGENT is notified (email + SMS) by
`dispatch-notification.ts`. The brokerage is NEVER notified at
detection time. The brokerage email actually fires from inside
`acceptFirmDealOffer()` when the agent clicks the existing
"Notify my brokerage I want an advance" CTA on the `/agent` banner.
That flow is exactly the brief's "Desired behavior" steps 1-4.

What makes the brokerage side feel "noisy" is the trio of follow-ups
that fire AFTER acceptance:
1. A 2-hour brokerage nudge cron
2. A 4-hour internal escalation cron
3. An agent-triggered manual "Remind my brokerage" button
4. Plus the Tier A/B/C dynamic content on the brokerage email

**The actual revert is: kill the follow-up nudges and escalations,
simplify the brokerage email to a single non-tiered "advance
requested" message, drop the manual reminder button, and rename the
audit event to match the new flow.** No new banner, no new popup, no
new server action is needed. The banner already exists with three
states (not-yet-accepted, just-accepted, previously-accepted) and the
CTA already creates the deal + sends the email.

## Verified call sites (file:line)

1. `lib/firm-deal-detection/dispatch-brokerage-offer.ts:435` -
   `sendBrokerageOfferNotification` exported.
2. `lib/firm-deal-detection/dispatch-brokerage-offer.ts:439` -
   `sendBrokerageOfferNudge2h` exported.
3. `lib/firm-deal-detection/dispatch-brokerage-offer.ts:494` -
   `sendInternalEscalation4h` exported.
4. `lib/actions/firm-deal-offer-actions.ts:444`: `acceptFirmDealOffer`
   calls `sendBrokerageOfferNotification`. **This is the only
   brokerage email triggered by user action.**
5. `lib/actions/firm-deal-offer-actions.ts:759` -
   `remindBrokerageOfPendingOffer` calls `sendBrokerageOfferNudge2h`
   (agent's manual reminder button).
6. `app/api/cron/firm-deal-offer-nudges/route.ts:138`: cron calls
   `sendInternalEscalation4h` at 4h after `brokerage_notified_at`.
7. `app/api/cron/firm-deal-offer-nudges/route.ts:153`: cron calls
   `sendBrokerageOfferNudge2h` at 2h after `brokerage_notified_at`.
8. `app/api/cron/firm-deal-offer-nudges/route.ts:114-126`: cron
   force-cancels offered deals at 60 days.
9. `app/api/cron/firm-deal-dispatcher/route.ts:82`: calls
   `dispatchFirmDealNotification` (agent-only at detection time). No
   brokerage notification here. Keep as-is.

### What the agent already gets at detection
`lib/firm-deal-detection/dispatch-notification.ts` runs Tier A/B/C
variant selection in `pickAgentVariant()` (lines 270-329) and sends
email + SMS to the matched agent only. Brokerage is NOT contacted
here. The brief's "Tier A/B/C copy keeps working" is already
satisfied.

### Magic link redirect
`app/agent/firm-deal/[token]/route.ts:168` builds
`dashboard.searchParams.set('firm_deal', consumed.firm_deal_event_id)`
and redirects to `/agent?firm_deal=<event_id>`. Confirmed correct, no
change.

### Existing banner on `/agent`
`app/(dashboard)/agent/page.tsx:463-559` already renders the firm-deal
offer banner with three states. The CTA at line 501-545 already calls
`acceptFirmDealOffer(firmDealOffer.event_id)` (line 508). The action
already creates the offered deal AND fires the brokerage email in one
call. No new banner, no new component, no new server action needed.

### Tier resolution today (to delete)
`lib/firm-deal-detection/dispatch-brokerage-offer.ts:198-211` -
`resolveTier()` picks A/B/C based on closing date + commission
presence. After the revert this is dead code.

### Available data when the brokerage email fires
At the moment `acceptFirmDealOffer` reaches the dispatch call we have
(from `loadContext` in `dispatch-brokerage-offer.ts:76-185`):
- Address (from `firm_deal_events.parsed.address` or
  `deals.property_address`)
- Closing date (already validated as present at lines 254-286)
- Agent first/last name, email, phone
- Brokerage name + recipient roster (brokerage email + broker_of_record
  + extra emails)
- Pipe brand name + tagline for white-label headers
- Side-of-deal commission amount when the matcher tagged the side AND
  co_agent_split is false
- A deep link to `/brokerage/deals/new?from_offer=<deal_id>` built by
  `buildBrokeragePortalUrl`

So the brief's "by this point we always have address and closing date,
and usually commission" is correct.

## Files to change

### `lib/firm-deal-detection/dispatch-brokerage-offer.ts`: REPURPOSE
- Keep the file.
- Delete `sendBrokerageOfferNudge2h` (line 439).
- Delete `sendInternalEscalation4h` (lines 494-540).
- Rename `sendBrokerageOfferNotification` (line 435) to
  `sendBrokerageAdvanceRequestedEmail`. Update its single caller.
- Delete `resolveTier` (lines 198-211).
- Simplify `dispatchBrokerageVariant` (lines 354-433):
  - Remove `variant` param. Only one variant now.
  - Remove `tier` and `advance` from renderer input.
  - Stop stamping `brokerage_nudge_2h_at` (line 402). Only stamp
    `brokerage_notified_at` (line 401) on send success.
  - Update audit log action from `firm_deal.notify_brokerage_dispatched`
    to `firm_deal.advance_requested`.
  - Drop `variant` and `notify_tier` from audit metadata.
- Keep `recipientsForBrokerage`, `loadBrokerageOfferRecipients`,
  `resolveFFInbox`, `loadContext`: all still used.
- Keep `sendAgentDeclineNotification` (lines 449-492). Unrelated.

### `lib/firm-deal-detection/render-brokerage-offer-email.ts`: REPURPOSE
- Rename file to `render-brokerage-advance-requested-email.ts`.
- Drop `BrokerageOfferVariant` type.
- Drop `BrokerageOfferTier` type + `tier`, `commission_amount`,
  `advance_estimate` fields from input.
- Rename `renderBrokerageOfferEmail` to
  `renderBrokerageAdvanceRequestedEmail`.
- Subject becomes a single fixed line:
  `"{Agent name} requested an advance on {address}"`.
- Body becomes a single template: name, address, closing date,
  "Review, approve, or submit." Mention commission inline only if
  present.
- Drop `renderInternalEscalationEmail`.

### `app/api/cron/firm-deal-dispatcher/route.ts`: NO CHANGE
Agent-side only. Tier A/B/C agent tiering lives here and stays.

### `app/api/cron/firm-deal-offer-nudges/route.ts`: GUT
The cron has three jobs today:
1. 2h brokerage nudge: DELETE.
2. 4h internal escalation: DELETE.
3. 60-day offered-deal auto-cancel: KEEP behavior.

**Recommended:** gut it in place. Keep the URL path (the cron-job.org
schedule can stay) but rename the comment header so the next reader
knows it's only doing 60-day expiry. Lower frequency to daily on
cron-job.org: Bud's action.

### `lib/actions/firm-deal-offer-actions.ts`: EDIT
- Update import (lines 6-10): drop `sendBrokerageOfferNudge2h`. Rename
  `sendBrokerageOfferNotification` to
  `sendBrokerageAdvanceRequestedEmail`.
- In `acceptFirmDealOffer`:
  - Update call at line 444 to use the new name.
  - Update retry-enqueue `email_type` (line 452) from
    `'firm_deal_offer_notification'` to
    `'firm_deal_advance_requested'`.
  - Keep `'deal.firm_deal_offer_accepted'` audit event (line 508) for
    backward compat. The new `firm_deal.advance_requested` event is
    written from the dispatcher.
- **DELETE `remindBrokerageOfPendingOffer`** (lines 701-812).

### `app/(dashboard)/agent/deals/[id]/page.tsx`: EDIT
- Remove the "Remind my brokerage" button + handler + import. Grep
  `remindBrokerageOfPendingOffer` to find every usage.

### `app/(dashboard)/agent/page.tsx`: NO CHANGE
The banner at lines 463-559 already does what the brief asks. The
brief calls for "popup or banner"; current implementation is a
dismissable banner with the right copy.

### `app/agent/firm-deal/[token]/route.ts`: NO CHANGE
Redirect to `/agent?firm_deal=<event_id>` confirmed at line 168.

### `lib/email.ts`: NO CHANGE
Brokerage email render lives in `lib/firm-deal-detection/`.

### `scripts/test-firm-deal-offer-acceptance.mts`: EDIT
Update imports (lines 168-190) to new function name and delete the
nudge / escalation test paths.

### Stale doc files: TIDY
`HANDOFF-firm-deal-followups.md`, `findings.md`, `task_plan.md`. Touch
only if they reference the deleted functions.

## New files

### Rename, not new
`lib/firm-deal-detection/render-brokerage-advance-requested-email.ts`
- input shape:

```ts
export interface BrokerageAdvanceRequestedEmailInput {
  brokerage_name: string
  agent_full_name: string
  agent_email: string | null
  agent_phone: string | null
  property_address: string
  closing_date_iso: string | null
  brand_name: string
  brand_tagline: string
  brokerage_portal_url: string
  commission_amount?: number | null
}
```

### Migration `supabase/migrations/100_firm_deal_revert.sql`: OPTIONAL

`firm_deal_events.offer_deal_id` / `second_offer_deal_id` already act
as the "already requested" gate. Adding `advance_requested_at` is
purely for clarity. **Recommendation: skip unless Bud wants the
explicit timestamp surfaced.**

If we go ahead:
```sql
ALTER TABLE firm_deal_events
  ADD COLUMN IF NOT EXISTS advance_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS second_advance_requested_at TIMESTAMPTZ;
```

## Audit event

- New event name: `firm_deal.advance_requested`
- Written from inside `dispatchBrokerageVariant` (now
  `dispatchBrokerageAdvanceRequested`) in `dispatch-brokerage-offer.ts`,
  replacing the existing `firm_deal.notify_brokerage_dispatched` log
  call at line 411.
- Metadata fields:
  ```ts
  {
    deal_id: string,
    brokerage_id: string,
    event_id: string,
    agent_id: string,
    recipients: string[],
    address: string,
    closing_date_iso: string | null,
    commission_amount: number | null,
    provider_id: string | null
  }
  ```
- Keep the existing `deal.firm_deal_offer_accepted` event in
  `acceptFirmDealOffer` (different semantic layer: deal-level
  rather than notification-level). Renaming would risk breaking
  downstream queries.

## Order of edits

1. Rename render file to `render-brokerage-advance-requested-email.ts`.
   Simplify.
2. Edit `dispatch-brokerage-offer.ts`: rename send function, drop
   nudge/escalation functions, drop `resolveTier`, update audit event.
3. Edit `lib/actions/firm-deal-offer-actions.ts`: update imports,
   rename call site, drop `remindBrokerageOfPendingOffer`.
4. Edit `app/(dashboard)/agent/deals/[id]/page.tsx`: remove
   "Remind my brokerage" button.
5. Gut `app/api/cron/firm-deal-offer-nudges/route.ts` down to 60-day
   expiry sweep only.
6. Edit `scripts/test-firm-deal-offer-acceptance.mts`: drop nudge /
   escalation imports and test paths.
7. Update stale doc files.
8. `npx tsc --noEmit` to catch dangling imports.
9. Run the test plan in dev.
10. Push to main. Bud updates cron-job.org to lower the
    `firm-deal-offer-nudges` cadence to daily (now just an expiry
    sweep, hourly is overkill).

## Test plan

### Trigger a firm-deal detection in dev
1. Drop a row into the test brokerage's Google Sheet, or call the
   poller route directly:
   ```bash
   curl -X GET "http://localhost:3000/api/cron/firm-deal-poller" \
     -H "Authorization: Bearer $CRON_SECRET"
   ```
2. Then call processor + dispatcher:
   ```bash
   curl -X GET "http://localhost:3000/api/cron/firm-deal-processor" \
     -H "Authorization: Bearer $CRON_SECRET"
   curl -X GET "http://localhost:3000/api/cron/firm-deal-dispatcher" \
     -H "Authorization: Bearer $CRON_SECRET"
   ```

### Confirm only agent is notified at detection
- Supabase: `firm_deal_events.email_sent_at` and `sms_sent_at` set.
- Resend dashboard: ONE outbound email to agent address. No second
  email to brokerage.
- `audit_log`: one `firm_deal.notify_dispatched` row. No
  `firm_deal.advance_requested` row yet.

### Confirm `/agent` banner
- Log in as matched test agent.
- Visit `/agent/firm-deal/<token>` from the email.
- Confirm redirect to `/agent?firm_deal=<event_id>`.
- Confirm banner renders with address + closing date.

### Confirm CTA fires the single brokerage email
- Click "Notify my brokerage I want an advance".
- Banner switches to "Your brokerage has been notified" state.
- Supabase: new `deals` row with `status='offered'`,
  `offered_event_id` set, `brokerage_notified_at` set.
  `firm_deal_events.offer_deal_id` linked.
- Resend: one email to brokerage recipient roster.
- Render: no tier-specific copy, no advance estimate, single CTA to
  `/brokerage/deals/new?from_offer=<deal_id>`.

### Verify audit logs
- One row `action='firm_deal.advance_requested'`, metadata includes
  deal_id, brokerage_id, event_id, agent_id, recipients, address,
  closing_date_iso, commission_amount, provider_id.
- One row `action='deal.firm_deal_offer_accepted'`.
- No new `firm_deal.notify_brokerage_dispatched` rows.

### Verify nudges are gone
- Run nudges route manually with curl. Confirm 0 nudges sent (only
  expiry path reachable).

### Verify agent's offered-deal page lost the manual reminder
- Visit `/agent/deals/<offered_deal_id>` for the new row. Confirm no
  "Remind my brokerage" button.

## Open questions

1. **Migration or no migration?** `offer_deal_id` already gates
   "already requested". Skipping the migration unless Bud asks for
   the explicit timestamp.
2. **Co-agency dual emails.** Today on dual-agency events, both
   agents get notifications and each can independently accept,
   producing one brokerage email per side (up to two). Confirm
   that's acceptable.
3. **`deal.firm_deal_offer_accepted` audit event.** Keep as-is for
   backward compat. New event sits alongside.
4. **60-day expiry copy.** Currently
   `brokerage_declined_reason='Offer expired automatically after 60
   days...'`. Window and copy stay unless Bud says otherwise.
5. **Notification preferences integration.** Firm-deal emails
   currently bypass migration 092's unsubscribe prefs. Confirm Bud
   wants either email subject to those prefs.

## Rollback plan

If a bug surfaces in prod:
1. Revert the merge commit on main. `git revert <sha>` then
   `git push origin main`.
2. Netlify redeploys in ~3 minutes.
3. If the optional migration was applied: column adds are additive
   (`ADD COLUMN IF NOT EXISTS`); no down migration needed.
4. Old function names and the old render file come back automatically
   with the code revert.
5. No data corruption risk. Only message routing changes.
