# Firm Deals (Proactive Offer Detection)

_Last updated: 2026-06-11_

This document describes how Firm Funds detects a real estate deal becoming firm, matches it to an enrolled agent, and turns it into a proactive commission advance offer.

## Important correction on the data source

The original task framing for this document referenced a "ParcLabs" real-estate transaction feed. After reading the code, there is **no ParcLabs integration anywhere in the repository**. The implemented Phase 1 firm-deal pipeline reads each partner brokerage's own deal-tracking Google Sheet, detects when a row moves from "Conditional" to a firmed month tab, and uses an AI parser to structure the row. This document describes what the code actually does. The ParcLabs naming should be treated as a planning-era placeholder, not a shipped integration. See `integrations/parcllabs.md` for the same correction stated from the integrations side.

## 1. The big picture

A partner brokerage (the canonical example in the code is Choice Realty) keeps a shared spreadsheet of their pending deals. When a conditional deal firms up, an admin copies or moves the row into a month tab. Firm Funds polls that sheet, notices the move, parses the row with an AI model, matches the listing and selling agent cells against enrolled agents, and (after review or auto-fire) sends the agent a proactive advance offer. The agent accepts, their brokerage admin is notified to submit on their behalf, and nudge crons keep the clock moving.

The pipeline files live in `lib/firm-deal-detection/` and the cron entry points in `app/api/cron/firm-deal-*`.

## 2. The pipeline, stage by stage

### Stage 1: poll the sheet (`poll-spreadsheet.ts`, cron `firm-deal-poller`)

`pollSpreadsheetPipe()` reads every configured tab of a brokerage's Google Sheet in one batch (`readAllTabValues` in `sheets-client.ts`, read-only service account), builds a snapshot of `{ rowIdentityHash -> tabName }`, and diffs it against the prior `last_poll_state`. A row triggers a firm-deal event when:

1. It now appears in a watched month tab and did not appear anywhere on the previous poll (`direct_to_month`), or
2. It now appears in a watched month tab and was previously in the Conditional tab (`moved_from_conditional`, the canonical trigger).

A row that appears in both Conditional and a month tab is treated as month-tab (the firmed state wins). The very first poll records state only and fires nothing, so historical deals are not dumped into the queue. Each detected trigger is written as a `firm_deal_events` row with `status='new'`, carrying the raw row, the source tab, the column mapping, and a content `deal_hash` for deduplication (`computeDealHash` in `deal-hash.ts`).

### Stage 2: parse the row (`parse-event.ts`, cron `firm-deal-processor`)

`parseFirmDealEvent()` sends one raw row to Claude Haiku 4.5 using the API's structured-output format, constrained to the `ParsedFirmDealSchema` Zod schema. The system prompt is a large, frozen, cacheable block of worked examples teaching the model the brokerage's spreadsheet conventions. It extracts: address, MLS number, raw listing-agent and selling-agent cells (preserved verbatim, never resolved), ISO closing date (using the tab name for year context), and optional gross-commission dollar amounts per side. It also tags a confidence level (high / medium / low) so low-confidence rows can be routed to review.

### Stage 3: dedup and match (`process-event.ts` + `match-agents.ts`)

`processFirmDealEvent()` is the orchestrator. It is idempotent (only processes `new` or `errored` rows). It parses, dedups against existing events sharing the same `deal_hash`, then calls `matchEvent()` to resolve both agent cells, and finally transitions the event's status. Its own state machine (`FIRM_DEAL_EVENT_TRANSITIONS`) is:

`new -> parsed | unmatched | commission_hold | awaiting_approval | approved | duplicate | errored`, then `commission_hold -> awaiting_approval | approved | rejected | errored`, then `awaiting_approval -> approved | rejected | errored`, then `approved -> offer_sent | errored`. `rejected`, `duplicate`, and `offer_sent` are terminal. (`commission_hold` is the one-cycle wait for a missing commission, below.)

### Stage 3.5: hold one cycle for a missing commission (`commission-hold.ts`)

A deal often goes firm in the sheet a little before the brokerage types in the commission. To get the agent the richer Tier C offer (real dollar figures) more often, the processor parks such an event for exactly one poll cycle instead of sending immediately. `shouldHoldForCommission()` parks the event in `status='commission_hold'` (stamping `commission_hold_since`) when ALL of:

- it matched and would otherwise send (`awaiting_approval` or `approved`),
- it has a closing date (no date means no Tier C upside to wait for),
- the pipe's `column_mapping` actually carries a commission column (so a commission CAN still appear), and
- no commission amount is parsed on either side yet, and it is not a co-agent split.

The release happens on the **next** poll, inside `pollSpreadsheetPipe` (`releaseCommissionHoldsForPipe`), reusing the fresh sheet rows the poller already read that cycle. The held row is re-found by its stable `row_identity_hash` (the hash keys off MLS or address+closing date, so adding a commission cell does not change it) and the commission column is re-read deterministically (`parseMoneyCell`). The event is then released to the normal send path (`approved` for auto-fire pipes, `awaiting_approval` for manual ones), **whether or not** the commission showed up, so an offer is never held more than one cycle.

The one-cycle wait is guaranteed two ways: the poller runs Stage 1 (poll + release) before Stage 2 (process new events, where a fresh hold is created), and the release ignores holds younger than `HOLD_MIN_MINUTES` (10) so a manual re-trigger cannot cut it short. A global `releaseStaleCommissionHolds` sweep (Stage 1.5 in the poller) releases any hold older than `HOLD_STALE_MINUTES` (25) left behind by a pipe that was disabled mid-hold, so nothing gets stuck. Holds are skipped for co-agent splits and date-less deals (no Tier C benefit). Both the park and the release are audit-logged (`firm_deal.commission_hold_released`).

### Stage 4: dispatch the offer (cron `firm-deal-dispatcher`)

The dispatcher picks up `approved` events and sends the offer to the matched agent by email and/or SMS, moving the event to `offer_sent`. Auto-fire is per pipe: when `brokerage_pipes.auto_fire_enabled` is false (the Phase 1 default), a matched event lands in `awaiting_approval` for a human to approve; when true, it goes straight to `approved` and dispatches automatically.

**Re-send.** An admin can re-fire the email + SMS for an already-sent offer from the Firm Deal Review page (the "Re-send" button on `offer_sent` rows under Recently resolved), via `resendFirmDealOffer()` -> `dispatchFirmDealNotification(eventId, supabase, { resend: true })`. Each Recently-resolved row is clickable and expands to show what was on the deal before it was sent (the resolved listing/selling agents, the commission figures pulled from the sheet, closing date, MLS, and parser notes) via the shared `EventSideSummary` / `EventCommissionSummary` components. Resend mode skips the approved-status and already-sent guards, mints a fresh magic link, and deliberately leaves the event's status and `email_sent_at` / `sms_sent_at` untouched, so `offer_sent` stays terminal and a failed re-send can never downgrade the event back to `errored`.

### The offer email + SMS (payment-choice framing)

The outbound email (`render-email.ts`) and SMS (`render-sms.ts`) are tiered by how much we know about the deal at send time, via `pickAgentVariant()` in `offer-estimate.ts`:

| Variant | We know | Framing |
| --- | --- | --- |
| `sparse` (Tier A) | address only | "We spotted a possible deal, confirm it's yours." |
| `sparse_with_date` (Tier B) | address + closing date | "Wait for closing, or get paid today" (no dollar figures). |
| `detailed` (Tier C) | address + closing date + this side's gross commission | The full **payment chooser** (below). |
| `dual_agency` | same agent both sides | Generic "both sides, both commissions." |

**The chooser (Tier C only).** When we have the commission and a closing date, the email asks **"How would you like to get paid?"** and presents two options side by side:

- **Wait for closing** - the gross commission, paid on the closing date, labelled "nothing to do." This is the default: if the agent ignores the offer, their commission simply lands at closing the usual way (paid by their brokerage, not Firm Funds). It is informational, **not** a button.
- **Get paid today \*** - the pre-split advance (`estimateAdvanceFromGross`), styled as the prominent green CTA. This is the **only** actionable path; tapping it runs the sign-in -> accept flow (§5). The asterisk footnotes "we aim to fund every approved advance within 24 hours."

Both figures are quoted **before the brokerage split** (we do not know the agent's office split at offer time), so a single "Amounts shown before your brokerage split" line covers them and the comparison stays apples-to-apples. The SMS mirrors this by naming both figures in one line ("Take $X at closing (Aug 13) or about $Y today, before splits:"); it has no buttons, so the link is the call to action. Nothing about the redesign changes deal mechanics - it is presentation only.

**Subjects** are tiered too. Tier A leads with "We spotted a possible deal at {address}"; Tier B with "Your deal at {address} is closing {date}. Want an advance?"; **Tier C congratulates the sale and puts the get-paid-today figure in the subject itself - "Congrats on your sale! Want $5,710 today?"** where the dollar amount is that agent's pre-split advance estimate (`formatMoney(advance_estimate)`). The fallback (detailed data present but no parseable closing date) is "Your deal at {address} went firm".

### Link preview (white-label Open Graph card)

The offer link in the SMS / email is `https://firmfunds.ca/agent/firm-deal/<token>` (`app/agent/firm-deal/[token]/route.ts`). When a messaging app renders that link it fetches the URL and reads its Open Graph tags to draw a preview card. A bare GET now returns a branded HTML page (`lib/firm-deal-detection/offer-launch.ts`): the card shows the **brokerage's** white-label brand (`brokerage_pipes.brand_name`) and logo (`brokerages.og_image_url`) plus the same advance estimate the SMS quotes (via the shared `pickAgentVariant` in `offer-estimate.ts`), instead of generic Firm Funds. The card text is the brand name + the deal's dollar figure; the website line stays `firmfunds.ca`. A nonce'd inline script forwards a real human on to `?go=1`, which runs the existing sign-in + dashboard redirect; preview crawlers do not run JS, so they only read the meta tags and never consume the (multi-use) token.

The og:image must be a raster: messaging apps will not render the auto-generated SVG logo as an og:image. `brokerages.og_image_url` holds a PNG of the logo (dark 1200x630 card). Generate or refresh it with `npx tsx scripts/generate-og-logo.mts [brokerageId]` after onboarding a white-label partner (no arg = all `is_white_label_partner` brokerages); it renders the on-file SVG with Edge so the Big Shoulders wordmark font resolves, uploads `logo-og.png`, and sets `og_image_url`. When `og_image_url` is null the card falls back to the Firm Funds icon.

## 3. Agent matching (`match-agents.ts`)

`matchOneSide(rawValue, ctx)` resolves a raw cell (for example "Sarah", "Mike R", "Exit", "JTeam") into one of these kinds:

| Kind | Meaning |
| --- | --- |
| `agent` | A single enrolled agent at this brokerage |
| `team` | Multiple enrolled agents under a team shorthand |
| `split` | Co-agents sharing one side of the deal (see below) |
| `outside` | A known outside brokerage / shorthand; no offer |
| `ambiguous` | Matches several in-office agents; sent to review |
| `unresolved` | Matches nobody known; sent to review |
| `empty` | Blank cell |

Resolution order:

1. **Per-brokerage learned mapping** (`brokerage_name_mapping` table). Anything an admin tagged in the review queue wins outright. This runs first so a brokerage shorthand containing a delimiter (like "Re/Max") resolves cleanly before the splitter can mis-parse it.
2. **Co-agent split detection** (next section).
3. **Heuristic match** against enrolled agents: "Sarah" matches `first_name = 'Sarah'`; "Mike R" matches `first_name = 'Mike'` and `last_name LIKE 'R%'`. A unique match wins; multiple matches return `ambiguous`.
4. If nothing matches, `unresolved`, into the review queue. The system deliberately does not hardcode outside-brokerage names; the review queue trains the mapping over time.

`matchEvent()` resolves both sides, deduplicates the enrolled agents, and recommends an event status: `awaiting_approval` if at least one clean enrolled agent and no unclear side; `unmatched` if any side is ambiguous or unresolved, or if more than two distinct enrolled agents land on the event (the schema holds at most two); `rejected` if both sides are outside or empty.

## 4. Co-agent splits (a "Kyle/Tricia" cell is NOT a team)

When a single agent cell looks like "Kyle/Tricia", "Sarah & Bill V", or "Mike R, Carlo", the matcher recognizes the delimiter and tries to resolve each piece independently. The recognized delimiters, in priority order, are: ` and `, `&`, `/`, `,`, `+`, and newline (`SPLIT_DELIMITERS`).

- If two or more pieces resolve to distinct enrolled agents, the result is `kind='split'` with the agent ids. The event is stamped `co_agent_split=true`, and the dispatcher sends **both** agents the generic (non-detailed) email/SMS variant, because Firm Funds does not know how the commission divides between them.
- If exactly one piece resolves, the lone match is surfaced as a plain `agent`.
- If zero pieces resolve, the matcher falls through to the single-cell heuristic on the whole raw value (the agent may just have unusual punctuation in their name).

A split is a **one-off** description of how one transaction's commission is shared. It is explicitly **not** persisted as a team. The matcher re-detects delimited combinations on each future event from the raw cell text; it never writes a durable "Kyle plus Tricia" team mapping. Mapped brokerage shorthands are exempted from splitting before the split layer runs, so "Re/Max" stays a single outside-brokerage token.

## 5. The offer acceptance flow (`lib/actions/firm-deal-offer-actions.ts`)

Once an offer has been dispatched, the agent lands on their dashboard via a magic link carrying `?firm_deal=<id>`. The offer link itself (`/agent/firm-deal/<token>`, handler `app/agent/firm-deal/[token]/route.ts`) auto-signs-in the agent: it consumes the token, resolves the agent's email, and mints a Supabase session. If the matched agent has no Firm Funds login yet — common, since the spreadsheet can match an `agents` row no human ever signed up against — the route auto-provisions one on the fly (in `must_reset_password` state) and still logs the agent in, so they land on `/change-password` to set a password rather than dead-ending at the login screen. Only an agent with no email anywhere (a test-data edge) still hits the old `?reason=firm_deal_no_account` dead-end. See the firm-deal auto-login section in `docs/architecture/authentication.md` for the full provisioning cases and security model. The flow:

1. **View the offer.** `getFirmDealOfferForCurrentAgent()` returns the offer summary only if the logged-in agent is the matched (primary or secondary) agent on the event. A guessed id quietly returns null, leaking nothing about other agents' offers. The offer also persists without the URL param: `getLatestOutstandingFirmDealOfferForCurrentAgent()` discovers the newest still-open offer matched to the logged-in agent (sent, not yet accepted on their side, not past its closing date) so the dashboard can keep showing the banner after a fresh login when `?firm_deal=<id>` is gone (see "The offer persists on the dashboard" below). The `FirmDealOfferSummary` it returns carries a `pre_requested` flag so the UI can render "Requested" instead of the accept CTA.
2. **Accept.** `acceptFirmDealOffer()` creates a placeholder `deals` row in `status='offered'` with the address and closing date copied from the parsed event and all financial columns set to 0 (the UI hides these on offered rows so the agent never sees fake numbers). A partial unique index prevents two simultaneous clicks from double-creating. The event is back-linked via `offer_deal_id` (or `second_offer_deal_id` for the co-agent on a dual-side deal). The real work lives in the shared `performFirmDealOfferAcceptance(supabase, { eventId, agentId, actor })` core in `lib/firm-deal-detection/offer-acceptance.ts` (ownership re-check, closing-date validation, recipient gate, race-safe insert, brokerage notification + retry enqueue, audit); `acceptFirmDealOffer()` is just a thin authenticated wrapper over it, so the pre-request-on-activation path (below) runs the identical logic without a user session.
3. **Notify the brokerage.** The brokerage admin team is emailed to submit the advance on the agent's behalf. This is best-effort: if Resend fails, the send is enqueued in `cron_email_failures` for the retry sweeper, and the agent is told "we'll keep trying." The offered deal is never rolled back because the notification failed. There is a recipient gate: if the brokerage has no email, no configured pipe recipients, and no `FIRM_FUNDS_OFFER_INBOX`, acceptance is refused with a clear support message rather than creating a black hole.
4. **Decline.** A brokerage admin can decline an offered deal via `declineFirmDealOffer()`, moving it to `cancelled` with a recorded reason. The agent is notified (best-effort, same retry pattern).
5. **Manual nudge.** An anxious agent can fire `remindBrokerageOfPendingOffer()` from the offered-deal page, sending the same email the 2-hour cron would, rate-limited to once per 6 hours per deal.
6. **Agent self-submit (the agent takes it over).** From the offered-deal page the agent can choose "I'll submit this myself" instead of waiting on the brokerage. `agentTakeOverOffer()` stamps `deals.agent_self_submit_at` (migration 105) and routes the agent to `/agent/new-deal?fromOffer=<dealId>`, which prefills the property + closing date and, on submit, CONVERTS the same offered row in place to `under_review` (via `submitDeal`'s `fromOfferDealId` branch). That conversion is the no-duplicate guarantee: it reuses the one offered row rather than inserting a second deal, with a CAS guard (`.eq('status','offered')`) against a concurrent submit. The agent can reverse the decision with `agentHandBackOffer()`, which clears the flag and resumes the brokerage flow.

### Pre-request: request-on-approval for a brand-new agent (migration 116)

A matched agent often has no Firm Funds account yet. When they click the offer email/SMS they are auto-provisioned, set a password, and complete onboarding (ID/KYC + banking) on `/agent/setup` (see the agent-activation section in `deal-lifecycle.md` §7). Submitting both lands them on the "You're all set" pending state while Firm Funds reviews the account. That used to be a dead end for the offer: the agent had to wait for the approval email, log back in, find the offer, and click accept.

Now the pending card surfaces the outstanding offer with a **"Request my advance now"** button (a PRE-REQUEST). Because the account is not yet approved, this does **not** notify the brokerage. `preRequestFirmDealOffer(eventId)` instead records the intent on the agent's side of the event by stamping `agent_pre_request_at` (or `second_agent_pre_request_at` for the dual-agency co-agent), and the card flips to a confirmed "Requested" state. A `deal.firm_deal_offer_pre_requested` audit row (entity `firm_deal_event`) is logged. (Edge case: if the agent is somehow already activated when they pre-request, `preRequestFirmDealOffer` skips the queue and accepts immediately so the request is never stranded.)

The acceptance then fires automatically the moment Firm Funds activates the account. `account_activated_at` is still set by the migration-043 DB trigger when KYC is verified **and** banking is approved. The three approval actions that can flip that gate (`verifyAgentKyc` in `lib/actions/kyc-actions.ts`, and `brokerageVerifyAgentKyc` + `approveAgentBanking` in `lib/actions/profile-actions.ts`) each call `fireQueuedFirmDealOffersForAgent(supabase, agentId)` at the end. That hook no-ops unless the account is fully activated, then runs `performFirmDealOfferAcceptance` for every pre-requested-but-unaccepted offer on either side (creating the `offered` deal and notifying the brokerage). It is best-effort (never throws into the approval flow) and idempotent (the shared core fast-paths on an existing `offer_deal_id`), so calling it from both the KYC and banking paths cannot double-create. The auto-fired acceptance audit-logs `deal.firm_deal_offer_accepted` with `accepted_via: 'pre_request_on_activation'` (versus `'agent_click'` for a normal banner accept). The agent never has to log back in to kick it off.

### The offer persists on the dashboard (discovery without the magic-link param)

The firm-deal offer banner on `/agent` previously rendered only when the URL carried `?firm_deal=<eventId>` from the magic link. After a fresh login that param is gone, so an offer the agent had not yet accepted became invisible: the deal that "brought them here" simply vanished. The dashboard now also DISCOVERS any outstanding offer matched to the logged-in agent via `getLatestOutstandingFirmDealOfferForCurrentAgent()` (no URL param needed) and shows the banner so they can accept it. When the offer was pre-requested but not yet fired (`pre_requested` true, no linked deal yet), the banner renders a "Requested" pill with pending-approval copy instead of the accept CTA. An already-accepted offer is **not** re-surfaced as a banner (it already appears as an `offered` row in the agent's deal list), because discovery skips events whose side already has a linked `offer_deal_id`.

### The brokerage is paused while `agent_self_submit_at` is set

Once an agent takes an offer over, the brokerage must have no path to submit it (otherwise both could submit, creating two deals). The flag pauses the brokerage everywhere it could otherwise act:

- The `OfferedDealsBanner` shows the row as a passive "This agent is submitting this themselves" note with no Submit/Decline buttons, and it no longer counts toward "N agents are waiting on you."
- `brokerage/deals/new?from_offer=<id>` refuses to prefill (and `submitDealAsBrokerage`'s conversion path refuses the write) with "This agent has chosen to submit this advance themselves."
- `declineFirmDealOffer()` refuses with the same kind of message.
- The nudge/escalation/expiry cron (§6) excludes flagged rows entirely, so the brokerage is never emailed about an offer the agent took over, and the offer does not auto-expire while the agent is working on it.
- `remindBrokerageOfPendingOffer()` is guarded server-side too (it is normally unreachable because the agent's "Remind my brokerage" button is hidden once the offer is taken over).

### Dual agency (both sides enrolled)

When both the listing and selling cell resolve to enrolled agents at the same brokerage, each agent gets an independent offer wired to the same event via `matched_agent_id` and `second_matched_agent_id`. Each side becomes its own offered deal, with `offer_deal_id` and `second_offer_deal_id` tracked separately, so either agent can accept or be declined independently. The brokerage submits each side as a separate advance request. Phase 1 deliberately does not merge dual-side accepts into one deal.

## 6. The nudge, escalation, and expiry cron (`app/api/cron/firm-deal-offer-nudges`)

This cron runs hourly over every `offered` deal **whose `agent_self_submit_at` is null** (offers the agent took over to submit themselves are skipped, see §5) and does up to three time-based things, each fired at most once via a stamp column:

| Timer (from `brokerage_notified_at`, or `created_at` for expiry) | Action | Stamp |
| --- | --- | --- |
| 2 hours | Nudge the brokerage admin to submit | `brokerage_nudge_2h_at` |
| 4 hours | Aggressive internal email to the Firm Funds inbox to phone the brokerage | `internal_alert_4h_at` |
| 60 days | Auto-expire: flip the offer to `cancelled` with an "expired automatically" reason | (status change) |

The 60-day expiry takes priority and short-circuits the nudges. The cron is protected by a `CRON_SECRET` bearer header and is idempotent per hour via `cron_run_log`. A manual nudge fired by the agent stamps `brokerage_nudge_2h_at`, so it supersedes the automated 2-hour nudge for that deal.

## 7. Per-brokerage notification channels (migration 114)

Each brokerage has two independent switches, `firm_deal_email_enabled` and `firm_deal_sms_enabled` (both default on), set on the admin firm-deal pipe page under **Notification channels**. They let a brokerage take emails but no texts, texts but no emails, or both.

- **Email switch off** suppresses every brokerage-facing firm-deal email: the agent offer email, the 2-hour brokerage nudge (§6), and the agent decline notice. It does **not** suppress the 4-hour internal Firm Funds escalation — that is our own ops alert and always fires, so a stalled deal still reaches us (in fact, a brokerage with email off will more often hit the 4h escalation, which is the intended safety net).
- **SMS switch off** suppresses the Twilio offer texts to that brokerage's agents.

The agent-side dispatcher skips a disabled channel with status `skipped_disabled` (visible in the audit log). If a brokerage turns **both** channels off, the agent gets no offer notification and the event resolves to `errored` with a per-channel summary, surfacing the misconfiguration in the admin queue. These switches are separate from the master `email_notifications_enabled` kill switch (migration 092), which the firm-deal dispatchers do not consult. Source: `lib/firm-deal-detection/dispatch-notification.ts` (agent offers) and `dispatch-brokerage-offer.ts` (brokerage emails); written via `setBrokerageFirmDealChannels` in `lib/actions/firm-deal-pipe-actions.ts`.
