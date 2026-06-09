# Firm Deals (Proactive Offer Detection)

_Last updated: 2026-06-09_

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

`new -> parsed | unmatched | awaiting_approval | approved | duplicate | errored`, then `awaiting_approval -> approved | rejected | errored`, then `approved -> offer_sent | errored`. `rejected`, `duplicate`, and `offer_sent` are terminal.

### Stage 4: dispatch the offer (cron `firm-deal-dispatcher`)

The dispatcher picks up `approved` events and sends the offer to the matched agent by email and/or SMS, moving the event to `offer_sent`. Auto-fire is per pipe: when `brokerage_pipes.auto_fire_enabled` is false (the Phase 1 default), a matched event lands in `awaiting_approval` for a human to approve; when true, it goes straight to `approved` and dispatches automatically.

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

Once an offer has been dispatched, the agent lands on their dashboard via a magic link carrying `?firm_deal=<id>`. The flow:

1. **View the offer.** `getFirmDealOfferForCurrentAgent()` returns the offer summary only if the logged-in agent is the matched (primary or secondary) agent on the event. A guessed id quietly returns null, leaking nothing about other agents' offers.
2. **Accept.** `acceptFirmDealOffer()` creates a placeholder `deals` row in `status='offered'` with the address and closing date copied from the parsed event and all financial columns set to 0 (the UI hides these on offered rows so the agent never sees fake numbers). A partial unique index prevents two simultaneous clicks from double-creating. The event is back-linked via `offer_deal_id` (or `second_offer_deal_id` for the co-agent on a dual-side deal).
3. **Notify the brokerage.** The brokerage admin team is emailed to submit the advance on the agent's behalf. This is best-effort: if Resend fails, the send is enqueued in `cron_email_failures` for the retry sweeper, and the agent is told "we'll keep trying." The offered deal is never rolled back because the notification failed. There is a recipient gate: if the brokerage has no email, no configured pipe recipients, and no `FIRM_FUNDS_OFFER_INBOX`, acceptance is refused with a clear support message rather than creating a black hole.
4. **Decline.** A brokerage admin can decline an offered deal via `declineFirmDealOffer()`, moving it to `cancelled` with a recorded reason. The agent is notified (best-effort, same retry pattern).
5. **Manual nudge.** An anxious agent can fire `remindBrokerageOfPendingOffer()` from the offered-deal page, sending the same email the 2-hour cron would, rate-limited to once per 6 hours per deal.
6. **Agent self-submit (the agent takes it over).** From the offered-deal page the agent can choose "I'll submit this myself" instead of waiting on the brokerage. `agentTakeOverOffer()` stamps `deals.agent_self_submit_at` (migration 105) and routes the agent to `/agent/new-deal?fromOffer=<dealId>`, which prefills the property + closing date and, on submit, CONVERTS the same offered row in place to `under_review` (via `submitDeal`'s `fromOfferDealId` branch). That conversion is the no-duplicate guarantee: it reuses the one offered row rather than inserting a second deal, with a CAS guard (`.eq('status','offered')`) against a concurrent submit. The agent can reverse the decision with `agentHandBackOffer()`, which clears the flag and resumes the brokerage flow.

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
