# Firm Funds: Automated Firm Deal Detection System

Last updated: 2026-05-24

## Problem

Capture every firm deal at every onboarded brokerage so we can pitch the agent a same-day commission advance, without depending on brokerage admin discipline or agent self-reporting.

## Architecture

```
[Shared Google Sheet]    ──→  Cron poller (every 15 min) ─┐
                                                          ├──→ [Pre-filter] ──→ [AI parser] ──→ [Dedup + Match] ──→ [Notification engine]
[Brokerage email rule]   ──→  Postmark inbound webhook  ─┘                                                                  │
        (Phase 2)                                                                                                            ▼
                                                                                                          [Agent lands in FF dashboard,
                                                                                                           uploads docs or requests admin,
                                                                                                           advance request created]
```

Two intake pipes (one in Phase 1, one in Phase 2), one parser, one decision layer, two outbound channels (email and SMS, both Phase 1).

## Intake pipes

### Pipe 1: Shared Google Sheet (Phase 1)

- Brokerage shares their sheet read-only with a Firm Funds Google service account.
- API scope locked to `spreadsheets.readonly`. We physically cannot write to their data.
- Cron poller every 15 minutes reads new rows since last poll.
- Per-brokerage config stores: sheet ID, last polled state, and column mapping (which column is address, which is closing date, etc.).
- For Bud's sheet specifically, the trigger pattern is rows leaving the Conditional tab and appearing in a Month tab.

### Pipe 2: Email BCC (Phase 2)

- Domain `deals.firmfunds.ca` routed through Postmark inbound. $15 per month tier.
- Each brokerage gets a unique BCC address like `fb-<brokerage_id>@deals.firmfunds.ca`.
- Brokerage IT sets one mail rule. Outbound emails containing terms like "firm" / "deal sheet" / "conditions waived" / "commission statement" auto BCC that address.
- Postmark calls our webhook with parsed JSON. Cheap keyword pre-filter runs before AI to skip obviously irrelevant emails.
- Not built or paid for until the first external brokerage actually onboards.

## AI parser

- Runs on Claude Haiku 4.5 via the Anthropic API.
- Roughly $0.003 per parsed event with prompt caching. At 10 brokerages of typical size, around $20 to $30 per month total.
- Extracts: address, MLS number, listing agent, selling agent, closing date, sale price (if present), commission percentages (if present), confidence score.
- PDF deal sheet attachments get text extracted first.
- Pipe agnostic. Same function handles spreadsheet rows and emails. Provider can be swapped in a day if needed.

## Matching logic

Three buckets, only one automatic:

1. **Match against enrolled agents at this brokerage.** Name in listing or selling column matches one of our onboarded agents at that office. Auto-fire offer. Choice Realty test showed all 18 distinct in-office agents matched correctly, including last-initial disambiguation (Mike B, Mike R, Bill M).
2. **Known outside brokerage shorthand.** Names like EXP, Exit, Royal, Castle, Godfrey, Interboard. Auto-skip. Built up over time as encountered.
3. **Everything else.** Lands in a review queue tab inside the admin app. Each entry has one-click options: assign to an in-office agent, assign and remember the mapping forever after, mark as outside and remember, or skip just this row.

System trains itself through the review queue. No upfront config form at brokerage onboarding.

## Notification engine: Email plus SMS in parallel

Both channels fire on the same trigger, share dedup, and use the same per-brokerage white-label brand (for example "Choice Advances · Powered by Firm Funds").

### Email scenarios

| Code | When | Has dollar amounts |
|------|------|--------------------|
| A1   | Trigger from sparse data (your brokerage and most spreadsheet pipes) | No |
| A2   | Trigger from rich data (email pipe with deal sheet attached) | Yes |
| A3   | Same agent held both sides (dual agency) | Maybe |
| B1   | 48-hour nudge if no response | No |

Visual hierarchy makes the TODAY option pop. Mockups saved at `email-mockup.html` for reference.

### SMS variants

One short message per scenario above. Always opens with the brand prefix and ends with "Reply STOP to opt out" (required by CASL). Twilio handles opt-out automatically. Around $0.013 per message in Canada, roughly $1.50 per brokerage per month at typical volume.

### Explicitly removed

- Second-deal-this-week variant (just send the same email again).
- Closing-approaching last-call email (no pestering).
- Email alerts for unmatched agents (in-app tab instead).
- Weekly review queue digest email (in-app tab instead).

## Agent journey on click

1. Agent taps the CTA in email or SMS.
2. Lands inside their existing Firm Funds dashboard, already authenticated via tokenized link.
3. Two paths from there: upload documents and confirm deal details themselves, or click "Request my admin to send the info" which fires a notification to the brokerage admin.
4. Either path creates a new advance request on our side.

No DocuSign references in outbound copy. No timing promises. The dashboard guides the rest.

## Internal admin tabs (not emails)

### Onboarding Opportunities tab
One row per unmatched-name event involving an agent not enrolled with us. Quick actions: send onboarding invite, add to outside-brokerage list, dismiss.

### Review Queue tab
One row per ambiguous-name event. Same one-click resolution actions described in matching logic. Smarter the more it is used.

## Database additions

Existing tables (`agents`, `brokerages`, `deals`) stay untouched. Two new tables:

```sql
brokerage_pipes
  id, brokerage_id, pipe_type ('spreadsheet' | 'email'),
  config jsonb (sheet_id, column_mapping, bcc_address, etc.),
  brand_name, brand_tagline,
  enabled, last_polled_at

firm_deal_events
  id, brokerage_pipe_id, source, raw_payload jsonb, parsed jsonb,
  deal_hash, status ('new' | 'duplicate' | 'matched' | 'unmatched' | 'errored'),
  matched_agent_id, offer_deal_id,
  email_sent_at, sms_sent_at,
  received_at, processed_at
```

Plus a `brokerage_name_mapping` table populated through the review queue (shorthand to either agent_id or "outside").

## Tech stack and operating cost

| Component        | Service                       | Phase | Approximate monthly cost     |
|------------------|-------------------------------|-------|------------------------------|
| Sheet polling    | Google Sheets API             | 1     | $0 (free tier)               |
| AI parsing       | Anthropic Claude Haiku 4.5    | 1     | $20 to $30 across all brokerages |
| Outbound SMS     | Twilio                        | 1     | ~$1.50 per brokerage         |
| Inbound email    | Postmark                      | 2     | $15                          |
| Compute          | Existing Netlify functions    | 1     | $0 marginal                  |

Phase 1 total operating cost: well under $50 per month even with several brokerages live.

## Operational mode

- Every brokerage starts in **manual review mode**. Each parsed event lands in a queue with a yellow "Awaiting approval" badge. Click Send or Reject per event.
- After 20 to 30 events from a brokerage have validated the parser on their data patterns, flip that brokerage to **auto-fire**. Dashboard banner shows the count per brokerage so the mode is always clear at a glance.
- View-only is enforced structurally. We never write to a brokerage's spreadsheet.

## Phasing

### Phase 1: Alpha at Choice Realty
**Goal:** End-to-end on Bud's own brokerage. Real triggers, real notifications, real review queue. Manual approval before each send.

- New tables and migrations.
- Google Sheets poller with read-only scope.
- Claude parser with structured output.
- Dedup, enrolled-agent matching, review queue.
- Email rendering using the white-label template (mockup approved).
- Twilio outbound SMS in parallel with email.
- Wire into existing advance request flow.
- Admin UI: review queue tab + onboarding opportunities tab.
- Mode toggle: manual review vs auto-fire per brokerage.

External signups needed: Google service account, Anthropic API key, Twilio account.

### Phase 2: First external brokerage
**Goal:** Onboard one friendly outside brokerage on the email pipe.

- Postmark account, DNS records, inbound webhook.
- Per-brokerage BCC address generation.
- Walkthrough doc or short video for the brokerage admin or IT to set the mail rule.
- Per-brokerage brand config UI (name, tagline, eventually logo upload).

External signups needed: Postmark account.

### Phase 3: Polish and brand
- Logo upload integrated into brokerage onboarding flow.
- White-label brand variations rendered correctly across email + SMS + portal.
- Subject line rotation locked in.

### Phase 4 (later, when volume justifies)
- Monthly MLS reconciliation as a quality check, not a trigger. Flag pipes with under 90 percent capture rate against board sold-firm data.

## Decisions still pending from Bud

1. OK to sign up for Anthropic API, Google Cloud project (for service account), and Twilio accounts? All have free tiers or pay as you go.
2. Final pick on greeting style. Landed on "Hi Sarah" but worth confirming.
3. Per-brokerage logo design and upload UI (acknowledged as future work).

## What we are deliberately not building

So these do not creep back in later without a decision:

- SMS inbound pipe (admin texting in firm deals).
- Direct integrations with Lone Wolf, TransactionDesk, or other brokerage software.
- Lawyer-side data ingestion through Dye and Durham or similar.
- TRS compliance generator. We are not becoming a compliance software company.
- Commission escrow or payment processor pivot.
- Standard commission rate assumptions per brokerage (illegal price fixing).
- Email alerts for internal events. In-app tabs only.
- Closing-approaching pestering emails.
- Per-brokerage deal-fell-through tracking. Every office does this differently and chasing each variant is unsustainable. If a funded deal later collapses, the existing remediation and cure process handles it on the financial side.
