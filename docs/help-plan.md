# Firm Funds Help Center + FAQ Build Plan

## Summary

Build a static, in-app Help Center at `/help` that ships with the Next.js
16 app and lives inside the existing `(dashboard)` route group so the
agent and brokerage portals can deep-link into it from their headers.
Content is authored as colocated TypeScript / TSX modules (no markdown
library, no CMS) so we can interpolate live constants from
`lib/constants.ts` and `lib/calculations.ts` and let the writer drop in
purpose-built React components (callouts, fee worksheets, status
diagrams) without spinning up MDX tooling. The Help Center has a single
sidebar layout that serves both roles; the sidebar filters its sections
to the signed-in user's role, plus a shared "Money + Policy" section
visible to everyone. A separate `/help/faq` page hosts the searchable
question bank. Plain language, semantic HTML, dark-mode-locked tokens,
zero em dashes, and no hardcoded hex.

---

## IA decision

**Pick: Option 3: sidebar at `/help` that hosts everything**, with a
dedicated `/help/faq` sub-route nested in the same layout.

Why this fits over the two-card or tabs versions:

1. Bud's users are mid-task when they hit Help. A sidebar gives them a
   stable map of the whole portal in their peripheral vision while they
   read one article. Two-card landing forces an extra click and a back
   button; tabs hide one role entirely behind a click.
2. Role visibility is per-section, not per-page. A brokerage admin and
   their agent both need "How is my advance calculated?". The sidebar
   filters in-place; the URL space stays single and shareable.
3. The portal already uses sidebar-style nav patterns (brokerage page
   internal tabs, admin section, agent header nav). A sidebar matches
   the muscle memory of the rest of the app.
4. Search lives in the sidebar header. With tabs or role cards search
   has to live on a third surface.
5. Deep links into Help (e.g. from a failed-deal email to
   `/help/agent/cure-election`) work without query-string juggling.

`/help/faq` is the same layout with the article body replaced by the FAQ
list; the sidebar stays put.

---

## Markdown library decision

**Pick: plain TSX content modules. No `react-markdown`, no `next-mdx-remote`.**

Reasons:

- We need to interpolate `DISCOUNT_RATE_PER_1000_PER_DAY`,
  `SETTLEMENT_PERIOD_DAYS`, `LATE_INTEREST_RATE_PER_ANNUM`, and the
  output of `getChargeDays()`, `calculateDeal()`, and
  `liveFailedDealInterestOwed()` directly inside the article body. Any
  markdown layer means "string interpolation, no type checking" which
  is exactly the kind of drift we want to avoid for financial copy.
- We can call existing UI primitives (`Card`, `Alert`, `Badge`,
  `Button`) inside articles for callouts and CTAs.
- No new prod dependency. `package.json` has no markdown library; the
  app already loads heavy stuff (DocuSign, Twilio, googleapis), so we
  don't want to grow it for static text.
- Type-checked: a malformed article breaks the build, not the user's
  page.
- One-line per-article export shape lets the writer agent crank these
  out as fast as markdown.

The article module shape is documented under "Content directory" below.

---

## Search decision

**Yes, simple client-side filter.** A help center without search is a
tax on the user, and Bud's audience is not going to ctrl-F.

Implementation: a single in-memory index built at module load from each
article's frontmatter and headings. No fuzzy library: `String.includes`
on a normalized lowercase haystack is fine for ~50 entries.

Data shape (TypeScript):

```ts
interface HelpSearchEntry {
  type: 'article' | 'faq'
  slug: string             // 'agent/submit-deal' or 'faq/how-is-advance-calculated'
  role: 'agent' | 'brokerage' | 'shared'
  title: string
  summary: string
  /** Concatenated section headings + first 200 chars of body, lowercased. */
  haystack: string
  /** For FAQs only, the question text rendered as the link label. */
  question?: string
}
```

The index is exported from `content/help/index.ts` and consumed by
`<HelpSearchPalette>` (cmdk: already in deps as `"cmdk": "1.1.1"`).

---

## Routing map

All paths are under `app/(dashboard)/` so the dashboard auth gate
(`app/(dashboard)/layout.tsx`) protects them. The portal route gate in
`proxy.ts` `ROUTE_ROLES` is keyed by `/admin`, `/brokerage`, `/agent`;
`/help` is intentionally NOT in that map, so any signed-in user
(agent, brokerage admin, or FF admin) can reach it. The dashboard layout
already redirects unauthenticated users to `/login`.

### Files to create

```
app/(dashboard)/help/
  layout.tsx                  // shared sidebar + main column shell
  page.tsx                    // /help: landing copy and quick-start tiles
  not-found.tsx               // 404 inside Help context
  faq/
    page.tsx                  // /help/faq: searchable Q&A list
  agent/
    [slug]/
      page.tsx                // /help/agent/:slug: dynamic article loader
  brokerage/
    [slug]/
      page.tsx                // /help/brokerage/:slug: dynamic article loader
  shared/
    [slug]/
      page.tsx                // /help/shared/:slug: money + policy articles

components/help/
  HelpShell.tsx               // server component: sidebar + main outlet
  HelpSidebar.tsx             // client: filtered nav, current article highlight
  HelpSearchPalette.tsx       // client: cmdk-based search dialog (ctrl+K)
  HelpArticleHeader.tsx       // title, summary, updated-at, role badge
  HelpArticleBody.tsx         // article container with prose styles
  HelpCallout.tsx             // four variants: note, warning, success, money
  HelpStepList.tsx            // numbered steps with optional "if this fails" branch
  HelpFeeWorksheet.tsx        // renders a worked example from calculations.ts
  HelpFaqList.tsx             // grouped, searchable Q&A list
  HelpScreenshot.tsx          // <figure> wrapper with caption + alt text
  HelpStatusFlowDiagram.tsx   // svg pill chain: under_review -> approved -> funded -> completed; failed branch

content/help/
  index.ts                    // ALL_ARTICLES, ALL_FAQS, buildSearchIndex()
  articles/
    agent/
      first-time-signing-in.tsx
      submit-a-deal.tsx
      upload-kyc-documents.tsx
      reading-your-dashboard.tsx
      pay-remediation-idp.tsx
      update-banking-info.tsx
      account-balance-and-ledger.tsx
      what-happens-if-deal-falls-through.tsx
    brokerage/
      submit-on-behalf-of-agent.tsx
      accept-or-decline-firm-offer.tsx
      settle-a-funded-deal.tsx
      record-a-payment.tsx
      late-strikes-and-the-14-day-bump.tsx
      pay-remediation-remittance.tsx
      manage-team-admins.tsx
      brokerage-dashboard-tour.tsx
    shared/
      how-the-advance-is-calculated.tsx
      what-a-remediation-idp-is.tsx
      late-interest-rules.tsx
      settlement-window.tsx
      security-and-data.tsx
      contacting-firm-funds.tsx
  faqs/
    agent.ts
    brokerage.ts
    shared.ts
  types.ts
```

### Entry-point edits to dashboards

1. `components/AgentHeader.tsx`: add a Help link button to the nav row.
   Icon: `LifeBuoy` from `lucide-react`. Keyboard activatable.
2. `app/(dashboard)/brokerage/page.tsx`: the brokerage header is inline.
   Add an equivalent Help button near Settings / Messages / Inbox.

No edits to `proxy.ts` are required: `/help` falls under the default
"authenticated users only" branch.

---

## Article module shape

```ts
// content/help/types.ts
export type HelpRole = 'agent' | 'brokerage' | 'shared'
export type HelpCategory =
  | 'getting-started'
  | 'deals'
  | 'kyc-and-banking'
  | 'money-and-policy'
  | 'team'
  | 'failed-deals'
  | 'settlements'
  | 'support'

export interface HelpArticleMeta {
  slug: string
  title: string
  summary: string
  role: HelpRole
  category: HelpCategory
  order: number
  updatedAt: string
  searchHaystack: string
}

export interface HelpArticle {
  meta: HelpArticleMeta
  Body: React.ComponentType
}

export interface HelpFaq {
  id: string
  role: HelpRole
  category: HelpCategory
  question: string
  Answer: React.ComponentType
  related?: string[]
  updatedAt: string
}
```

---

## Articles to write (v1 scope: 22 articles)

Each article binds to a source-of-truth file so the writer cannot invent
facts.

### Agent

| Slug | Title | Source files | Screenshot? |
|------|-------|--------------|-------------|
| `first-time-signing-in` | First time signing in | `app/invite/[token]`, `app/(dashboard)/agent/setup/page.tsx` | Yes |
| `submit-a-deal` | Submit an advance request | `app/(dashboard)/agent/new-deal/page.tsx`, `lib/actions/deal-actions.ts`, `lib/calculations.ts` | Yes |
| `upload-kyc-documents` | Upload KYC documents | `app/kyc-upload/[token]/page.tsx`, `components/AgentKycGate.tsx` | Yes |
| `reading-your-dashboard` | What your dashboard tells you | `app/(dashboard)/agent/page.tsx`, `lib/constants.ts` | Yes |
| `account-balance-and-ledger` | Your account balance and ledger | `app/(dashboard)/agent/account/page.tsx`, `types/database.ts` | Yes |
| `update-banking-info` | Update your banking information | `app/(dashboard)/agent/profile/page.tsx`, `lib/actions/settings-actions.ts` | Optional |
| `what-happens-if-deal-falls-through` | What happens if my deal falls through | `app/(dashboard)/agent/cure-election/[dealId]/page.tsx`, `lib/calculations.ts`, `lib/actions/deal-actions.ts` | Yes |
| `pay-remediation-idp` | Paying a Remediation IDP | `components/remediation/AddRemediationDealModal.tsx`, `lib/actions/remediation-actions.ts`, `lib/actions/esign-actions.ts` | Optional |

### Brokerage

| Slug | Title | Source files | Screenshot? |
|------|-------|--------------|-------------|
| `brokerage-dashboard-tour` | Your brokerage dashboard tour | `app/(dashboard)/brokerage/page.tsx`, `components/brokerage/*` | Yes |
| `submit-on-behalf-of-agent` | Submit a deal on behalf of an agent | Brokerage new-deal flow, `lib/calculations.ts` | Yes |
| `accept-or-decline-firm-offer` | Reviewing a firm-deal offer | `components/brokerage/OfferedDealsBanner.tsx`, `lib/actions/firm-deal-offer-actions.ts` | Yes |
| `settle-a-funded-deal` | Settle a funded deal | `lib/calculations.ts` (`effectiveSettlementDays`), `lib/constants.ts` | Yes |
| `record-a-payment` | Record a payment | `components/brokerage/RecordPaymentModal.tsx`, `lib/actions/brokerage-actions.ts` | Yes |
| `late-strikes-and-the-14-day-bump` | Late strikes and the 14-day bump | `lib/calculations.ts`, `lib/constants.ts` | No |
| `pay-remediation-remittance` | Pay a Remediation remittance | `app/(dashboard)/brokerage/failed-deals/page.tsx`, `lib/actions/remediation-actions.ts` | Optional |
| `manage-team-admins` | Manage team admins | `app/(dashboard)/brokerage/admins/page.tsx`, `lib/brokerage-admin-roles.ts` | Optional |

### Shared (Money + Policy)

| Slug | Title | Source files |
|------|-------|--------------|
| `how-the-advance-is-calculated` | How the advance is calculated | `lib/calculations.ts`, `lib/constants.ts` |
| `late-interest-rules` | Late payment interest rules | `lib/calculations.ts`, `lib/constants.ts` |
| `settlement-window` | The settlement window | `lib/calculations.ts` (`effectiveSettlementDays`) |
| `what-a-remediation-idp-is` | What a Remediation IDP is | `lib/contract-docx.ts`, `lib/actions/remediation-actions.ts` |
| `security-and-data` | How we keep your data safe | `proxy.ts`, `lib/supabase/server.ts` |
| `contacting-firm-funds` | Contacting Firm Funds | `lib/email.ts` |

---

## Walkthroughs (key flows)

Each walkthrough renders as `<HelpStepList>` with: title, expected
outcome per step, optional "what to do if this doesn't work" fallback.
Spec for the heavy hitters:

### Submit a deal (agent)
- Prereqs: KYC verified, banking on file.
- Steps: open New advance request -> fill address/closing/commission/split -> see live preview update -> upload supporting docs -> Submit. Expected: redirected to `/agent`, deal appears in `under_review`.
- Failures: button greyed (KYC not done), commission out of band, upload too large.

### Submit a deal on behalf (brokerage)
- Prereqs: agent on roster with KYC verified.
- Steps: open New advance request -> pick agent -> fill property + commission + split -> attach docs -> Submit. Expected: deal in `under_review`, agent gets email.
- Failures: agent missing from dropdown, calculator throws (out-of-band commission or closing too close).

### Cure election (agent)
- Prereqs: deal in `failed_to_close`, cure election within 15 days.
- Steps: open the cure election link from the email -> pick `cash_repayment` or `commission_assignment` -> submit. Expected: `cure_election` saved, late interest accrual starts day 31 after closing.
- Failures: deadline passed (15+ days), no banking on file for cash path.

### Record a payment (brokerage)
- Prereqs: funded deal with `amount_due_from_brokerage > 0`.
- Steps: Settlements tab -> Record payment -> pick deal/amount/date/method/reference -> Save. Expected: payment shows `pending`. Firm Funds reconciles, flips to `confirmed`.
- Failures: modal won't open (refresh), stuck pending more than 2 days (message us with reference).

### Pay a Remediation IDP (agent + brokerage)
- Prereqs: cure path = `commission_assignment`; FF admin created the Remediation Deal; envelope sent.
- Steps (agent): receive DocuSign email -> sign -> watch status flip on `/agent/failed-deals`. Expected: ledger credit when brokerage remits.
- Steps (brokerage): named commission lands at trust -> EFT/wire directed amount -> notify FF in message thread. Expected: row moves to `remitted`.

---

## FAQ Q&A pairs (32 entries; v1 cuts to 25 minimum)

Full Q+A drafts are below. Plain language, no em dashes, no jargon.

### Money + policy (shared)

**Q1. How is my advance calculated?**
We start with your net commission, which is the gross commission minus
your brokerage's split. We charge a discount fee of $0.80 per $1,000
per day for every day from the day after funding through and including
the closing day. We also charge a settlement period fee at the same daily
rate for the standard 7-day window after closing. Your advance is the net
commission minus those two fees. The math lives in `lib/calculations.ts`.

**Q2. Which days are charged?**
Your funds arrive the day after we fund the deal, so the funding day is not
charged. Closing day is charged, because that is not the day we are repaid:
your brokerage remits afterward. So a 30-day deal carries 30 charge days.

**Q3. What happens if my deal falls through?**
We move the deal to `failed_to_close` and email you within minutes.
You then have 15 days to elect a cure path: cash repayment of the
outstanding balance, or commission assignment, where we redirect a
future commission to Firm Funds via a Remediation Irrevocable
Direction to Pay. Either way, late interest at 24% per year
compounded daily starts on day 31 after the closing date.

**Q4. What is a Remediation IDP?**
An Irrevocable Direction to Pay (IDP) is a one-page document signed
by you and your brokerage that redirects a specific upcoming
commission to Firm Funds. We use it when a previously advanced deal
fails to close and you elect commission assignment as your cure path.

**Q5. What does the 24% late interest actually cost me per day?**
The 24% is a true APR, compounded daily. The daily rate is
`(1 + 0.24)^(1/365) - 1`, which is about 0.0590 percent. On a
$10,000 balance that is about $5.90 the first day, and a little more
each day after because the next day's interest is on the slightly
higher balance.

**Q6. Why does my brokerage have a settlement window?**
Closing day is when your commission lands in your brokerage's trust
account. Your brokerage needs a few business days to clear funds and
remit our portion. The standard window is 7 calendar days after
closing. We snapshot that window into the deal at funding, so later
amendments do not move the goalposts on that specific deal.

**Q7. Why did our brokerage settlement window jump from 7 to 14 days?**
Your brokerage hit 5 manual late-payment strikes. When that happens
the system auto-bumps your window to 14 days for new deals going
forward. Existing funded deals keep whatever window was snapshotted
at funding. Ship every payment on time for a full quarter and Firm
Funds will manually clear the bump.

**Q8. Is my information secure?**
Yes. We use Postgres with row-level security, so every database query
is filtered by your account ID before any data leaves the database.
Sensitive endpoints use a strict Content Security Policy, CSRF
protection, and same-origin checks. KYC documents live in an
ownership-scoped storage bucket and are not visible to other
brokerages.

**Q9. Who is Firm Funds?**
Firm Funds Inc. is an Ontario-based commission advance company. We
pay real estate agents the bulk of their commission as soon as the
deal is firm, then collect from the brokerage at closing. We are not
a bank or a lender to the public; this is a purchase of a future
commission receivable.

**Q10. Can I cancel an advance after I request it?**
While the deal is in `under_review` you can withdraw it by messaging
Firm Funds. Once it moves to `approved` the documents are out for
signature; you can still walk away until the IDP is countersigned.
After `funded` the money has moved; if the deal then fails to close,
the failed-to-close path applies.

**Q11. What is the difference between gross and net commission?**
Gross commission is the full commission your brokerage receives.
Net commission is what is left after your brokerage's split. We
advance against the net, not the gross.

**Q12. Why is my approval taking so long?**
Most advances are reviewed the same business day. If your deal sits
in `under_review` more than 24 business hours, we are usually
waiting on a document (trust receipt, signed agreement of purchase
and sale, MLS firm record), or your KYC may have flagged for manual
review. Message us from the deal page.

### Agent-specific

**Q13. How do I update my banking info?**
Open the Profile page from the header, scroll to Banking Information,
edit the fields, and click Save. Firm Funds verifies new banking
details before they are used for funding, so allow one business day.
If you have a closing inside 48 hours, message us as soon as you
change anything so we can prioritize.

**Q14. How do I see what I owe Firm Funds right now?**
The Account Balance page (header link with a wallet icon) shows your
current balance and every transaction line item. Late interest,
failed-deal interest, credits from Remediation remittances, and
adjustments are all there. A positive balance means you owe us.

**Q15. What does each transaction type on the ledger mean?**
- `late_closing_interest` and `late_payment_interest`: interest while a funded deal is overdue
- `failed_deal_balance`: original unpaid principal when a deal fails to close
- `failed_deal_interest`: monthly compounded interest posted to your ledger
- `balance_deduction` and `invoice_payment`: money we pulled to settle a charge
- `credit`: money we applied (typically from a Remediation remittance)
- `adjustment`: manual one-off, always with a note from Firm Funds

**Q16. My closing date moved. What do I do?**
Ask your brokerage to file the amendment from their dashboard. Once
they file it we update the deal and recompute downstream dates.

**Q17. I missed the 15-day cure election deadline. What happens?**
The deal stays in `failed_to_close` and Firm Funds reaches out
directly. Interest continues to accrue at 24 percent APR regardless.
Get in touch right away if you missed the window.

**Q18. Can I sign up without an email address on file?**
Most agents have an email but a small number of brokerages keep
their roster phone-only. The `agents.email` column is intentionally
nullable. We will route notifications through your brokerage admin
until an email is added.

**Q19. The notification icon shows a count but I can't find the message.**
The agent header polls every 30 seconds for unread messages and
pending KYC returns. Click into each open thread once and the
counter clears. If it persists, refresh.

**Q20. What email address does Firm Funds send from?**
All notifications come from `notifications@firmfunds.ca`. If you
ever get a message claiming to be Firm Funds from a different
domain, do not click links; forward it to bud@firmfunds.ca.

### Brokerage-specific

**Q21. How do I add a team admin?**
Open the Team page. Click Invite admin, enter their name and email,
and pick a role: `brokerage_admin` (submit deals and manage agents)
or `brokerage_manager` (everything except changing the Broker of
Record). The invitee gets a magic-link email.

**Q22. What is the difference between the three brokerage admin roles?**
`broker_of_record` is the regulatory signatory; only Firm Funds can
change who fills that slot. `brokerage_manager` is the day-to-day
owner of the portal and can invite or remove other admins.
`brokerage_admin` can submit deals and manage agents but cannot
manage other admins.

**Q23. How do I dispute a late strike?**
Reply in the message thread for the specific deal and tell us which
date you actually sent payment plus the bank reference. We
reconcile against the bank deposit, not against the date the amount
lands on our books.

**Q24. One of our agents had a deal fail. What is our role in the cure?**
If the agent elects commission assignment, we set up a Remediation
Deal that names an upcoming commission of theirs at your brokerage.
Once both parties sign the Remediation IDP, you receive a copy.
When that underlying commission is paid to your trust account,
remit the directed amount to Firm Funds.

**Q25. We can't find the invite email for a new admin we just sent. What now?**
The Team page has a Resend action on the pending invite row. If
resends don't arrive, check the email address for typos and that
the recipient's inbox isn't blocking `notifications@firmfunds.ca`.

**Q26. Why does the dashboard sometimes show "1 agent is waiting on you"?**
That is a firm-deal offer surfaced by the Offered Deals banner.
Firm Funds detected that one of your agents just had a deal go
firm, and an advance request was kicked off on their behalf. The
agent's name and the property are on the row.

**Q27. Can our brokerage opt out of email notifications?**
Yes. Every Firm Funds email has a one-click unsubscribe link
(RFC 8058). We honor unsubscribes by flipping
`brokerages.email_notifications_enabled` to false. Transactional
messages (account / security) still go out.

**Q28. Do we ever pay Firm Funds before closing?**
No. Brokerages pay only after closing, within your settlement
window. The fees on the deal are paid by the agent out of the
advance, not by the brokerage.

---

## Component shopping list

| Component | Spec |
|-----------|------|
| `<HelpShell>` | Server. Sidebar + outlet. Resolves role from Supabase. |
| `<HelpSidebar>` | Client. Filtered nav, current article highlight, search trigger. |
| `<HelpSearchPalette>` | Client. cmdk dialog. Triggered by ctrl/cmd+K. |
| `<HelpArticleHeader>` | Server. h1 + summary + updatedAt + role badge. |
| `<HelpArticleBody>` | Server. `<article>` wrapper with prose tokens. |
| `<HelpCallout>` | Server. Variants: note, warning, success, money. Uses status-color tokens. |
| `<HelpStepList>` | Server. `<ol>` of `{ title, expected, fallback? }`. Fallback renders as `<details>`. |
| `<HelpFeeWorksheet>` | Client. Calls `calculateDeal()`. Default example when no props. |
| `<HelpFaqList>` | Client. Native `<details>/<summary>` for each Q. Inline filter. |
| `<HelpScreenshot>` | Server. `<figure><Image><figcaption>`. Forbids missing alt at type. |
| `<HelpStatusFlowDiagram>` | Server. Pure SVG. |

Notes: no new accordion primitive. Native `<details>` gives keyboard +
screen-reader semantics for free.

---

## Screenshots to capture

Capture each on the local dev server with the existing test fixtures.
Filename: `public/help/screenshots/<role>/<slug>.png`.

1. Agent dashboard with one funded deal (`reading-your-dashboard`)
2. New-deal form with fee preview card (`submit-a-deal`)
3. Agent ledger with mixed transaction types (`account-balance-and-ledger`)
4. KYC upload modal (`upload-kyc-documents`)
5. Cure election screen (`what-happens-if-deal-falls-through`)
6. Brokerage dashboard top with Offered Deals banner (`accept-or-decline-firm-offer`)
7. Brokerage Settlements tab with one outstanding (`settle-a-funded-deal`)
8. Record Payment modal (`record-a-payment`)
9. Brokerage dashboard tour shot (`brokerage-dashboard-tour`)

If a screenshot is not feasible inside the dev session (data fixture
not present), skip and note in `findings.md`; do not invent.

---

## Open questions / unresolved for Bud

1. Public phone number, if any, for "Contacting Firm Funds" article.
2. Response-time SLA claim ("one business day" for KYC and banking
   verification) needs Bud's sign-off.
3. "Who is Firm Funds?" paragraph: check `marketing/` for approved
   copy before drafting.
4. Privacy and Terms URLs for the security article.
5. Banking-update activation behavior: confirm whether saved banking
   info is auto-active or requires Firm Funds verification.
6. Should `/help` be visible to FF admins (default plan: yes,
   neutrally, with a pointer that admin docs are elsewhere)?
7. Confirm robots `noindex` should remain on `/help`.

---

## Verification plan

### Type and lint
- `npx tsc --noEmit` must pass.
- `npx eslint .` must pass with no new warnings.

### Dev-server smoke
Sign in as agent fixture, then click each:
- `/help` (landing renders)
- `/help/agent/submit-a-deal` (article + FeeWorksheet)
- `/help/agent/what-happens-if-deal-falls-through`
- `/help/shared/how-the-advance-is-calculated` (worksheet)
- `/help/faq` (filter works)

Repeat as brokerage fixture for brokerage articles.

### Screenshot pass
Capture all 9 above. Embed in articles. No layout shift on load.

### Accessibility
- Keyboard-only run through a representative article.
- Confirm `<details>` announces expanded state.
- Spot-check callout contrast against dark background.

### Em-dash / jargon sweep
- Search new files for U+2014 (em dash) and U+2013 (en dash). Zero matches.
- Skim every article body for "leverage", "robust", "facilitate", "enable" and similar. Replace with plain words.

### Constants drift check
After build, verify rendered numbers inside "How the advance is
calculated" match `DISCOUNT_RATE_PER_1000_PER_DAY`,
`SETTLEMENT_PERIOD_DAYS`, and `LATE_INTEREST_RATE_PER_ANNUM`. Because
articles import the constants directly, this should be automatic; the
visual sanity check confirms we wired it correctly.
