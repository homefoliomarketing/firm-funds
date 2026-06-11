# Email Integration (Resend)

_Last updated: 2026-06-11_

This document describes how Firm Funds sends transactional and notification email through Resend, the available templates and when each is sent, and how unsubscribe, preference, and retry tracking work.

## Note on file layout

The original task framing referenced `lib/email/resend.ts` and `lib/email/templates.ts`. Those files do not exist. The entire email integration (the Resend client, the shared HTML wrapper, and every template) lives in a single file: `lib/email.ts`. There is also **no `email_log` table** in this codebase. Email observability is handled through a different set of tables described in section 5. This document reflects what the code actually does.

## 1. The Resend client

`getResend()` in `lib/email.ts` lazily constructs a singleton `Resend` instance from `RESEND_API_KEY`. The behavior when the key is missing depends on environment:

- In production, it throws and logs an error rather than silently dropping mail.
- In development, it returns null and emails are simply disabled, so local builds keep working.

The from-address is `Firm Funds <notifications@firmfunds.ca>`, the internal admin address is `bud@firmfunds.ca`, and links are built against `NEXT_PUBLIC_SITE_URL` (default `https://firmfunds.ca`).

## 2. The send wrapper, CASL, and branding

Every template routes through `sendEmailWithUnsubscribe(opts)`, which:

1. Optionally checks the recipient's notification preference and skips the send if they have unsubscribed (non-transactional mail only).
2. Mints or fetches a stable per-entity unsubscribe token.
3. Appends a CASL-compliant footer and sets the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058), so Gmail, iCloud, and Yahoo render a one-click unsubscribe button.
4. Sends through Resend. Failures are logged and swallowed (never thrown), so a Resend hiccup never crashes a server action.

`sendEmailWithUnsubscribe` also accepts an optional `attachments: { filename, content }[]` (content is a `Buffer`, which the Resend SDK base64-encodes). This is how `sendBrokerageExecutedIdpNotification` delivers the executed signed Direction to Pay PDF to the brokerage.

Subject lines are sanitized (`sanitizeSubject` strips CR/LF to prevent header injection and caps length); body interpolations are HTML-escaped (`escapeHtml`). The shared `wrap()` function renders the dark-themed branded HTML shell. Agent-facing and brokerage-facing emails can show the brokerage's own logo via `getBrandingForAgent` / `getBrandingForBrokerage`, falling back to the Firm Funds wordmark on any miss.

### 2a. The shared template shell (`wrap`) and its tokens

`wrap(body, branding?, preheader?, fullWidthTrailer?)` is the single source of the email frame. It is email-safe by construction: table layout with `role="presentation"`, all styling inline, a web-safe font stack, no flex or grid for structure, and every gradient declares a solid-color fallback first (Outlook ignores the gradient and keeps the solid). It returns the COMPLETE document but deliberately omits the CASL unsubscribe footer, because `sendEmailWithUnsubscribe` appends that as `opts.html + footer`.

Shell anatomy, ported from `public/email-mockup-welcome.html`:

- Near-black page background (`#0A0A0A`), centered, with `56px 20px` outer padding.
- A 560px elevated card (`#161616`, `1px` border `#2A2A2A`, `18px` radius).
- A `2px` green top accent key-line. The solid `#5FA873` fallback is declared before the `linear-gradient(...)` so non-gradient clients still get a clean green line.
- The brand logo header (see `brandHeader`).
- A `44px 44px 40px` padded body region that renders `body`.
- A three-line quiet footer (`#5C5C59`, `11px`) ending in the `firmfunds.ca` link.

Parameters:

| Param | Effect | Default |
| --- | --- | --- |
| `body` | Inner HTML for the padded card-body region | required |
| `branding` | Brokerage logo + name for the header and footer line | Firm Funds default |
| `preheader` | When set, renders the hidden preview-text div (`preheaderBlock`) at the top of `<body>`. This is the inbox-list preview line. Optional and positional so the ~37 callers that pass only `(body, branding)` are unaffected. | none |
| `fullWidthTrailer` | Emitted edge-to-edge inside the card, below the padded body. Used for the recessed fallback-link shelf, which the design renders flush to the card edges on its own darker background. | none |

`brandHeader(branding)` preserves three branches: (a) a generated brokerage logo that already bakes in "Powered by Firm Funds" (rendered alone at 88px), (b) a custom-uploaded logo with a separate "Powered by Firm Funds" line beneath it, and (c) the no-logo Firm Funds wordmark default.

### 2b. Reusable body components

Pure string-returning helpers in `lib/email.ts`, shared across every template (the redesign is now fully propagated). All interpolated user data is passed through `escapeHtml`.

| Helper | Renders |
| --- | --- |
| `emailKicker(text)` | The green uppercase eyebrow label. Uppercasing is CSS (`text-transform` + `letter-spacing`), not hardcoded uppercase text. |
| `emailHeadline(text)` | The standard h1 under the kicker (near-white `#F5F5F4`, 26px, tight tracking). Text is escaped. Convention: headlines end with a period to match the approved Welcome email. |
| `emailButton(label, href)` | The hero CTA. Bulletproof: a VML `v:roundrect` fallback for Outlook plus a padded, gradient-backed anchor (solid-color fallback first) everywhere else. `href` is a server-built URL. Every primary CTA uses this single green button (urgency is carried by a danger `emailCallout`, never a red button). |
| `emailDetailCard(rows)` | The statement-style details card. `rows` is `{ label, value, valueColor?, strong? }[]`; values are right-aligned with hairline dividers between rows. `valueColor` adds semantic emphasis (a green `#6FB783` amount, a red `#F08C8C` removed value) and `strong` bolds the value; both are optional and default to the muted body grey at normal weight. |
| `emailCallout({ tone, title?, body, align? })` | The tinted, rounded highlight box used for every semantic banner: approval, funded, denial/return/security warning, settlement/info, caution, and neutral message quotes. `tone` is one of `success` / `funded` / `info` / `warning` / `danger` / `neutral`, each tuned for WCAG AA on the dark card. `title` is escaped; `body` is RAW HTML so the caller escapes its own interpolations (use `white-space:pre-wrap` for quoted messages). |
| `emailFallbackLink(url)` | The recessed monospaced "Button not working?" shelf carrying the raw URL. Pass it as `wrap`'s `fullWidthTrailer` so it renders flush to the card edges. Used whenever an email's primary CTA is a unique action/deep link. |

### 2c. The pure-render pattern

Every transactional email now follows this split. For each `send<Name>` there is an exported, synchronous, side-effect-free `render<Name>Email(params)` that builds the full document via `wrap(...)` and the body helpers. The renderer does NO DB or Resend I/O: it takes the values its body interpolates plus an optional `branding` (and, for the two dual-recipient settlement reminders, an `audience: 'agent' | 'brokerage'` flag, and for the array-driven statement/digest emails the already-shaped row arrays). The `send<Name>` function owns all the I/O: it resolves branding, builds URLs, computes the subject, calls `render<Name>Email`, and passes the result as `html` to `sendEmailWithUnsubscribe` (external signatures, subjects, `entityType`/`entityId`, transactional flags, and attachments are unchanged). `renderAgentInviteEmail` / `sendAgentInviteNotification` is the reference split.

Because the renderers are pure, the whole set can be eyeballed offline. `npx tsx scripts/render-email-preview.mts` imports every `render*Email` and writes one `public/email-preview-<slug>.html` per email (plus `public/email-preview-index.html`) using realistic sample data. Run it with `NEXT_PUBLIC_SITE_URL=http://localhost:8770` and serve `public/` with the `public-static` launch config (port 8770) so the Firm Funds wordmark and sample brokerage logo load locally. These preview files are gitignored scratch.

The CASL footer that `sendEmailWithUnsubscribe` appends (`buildUnsubscribeFooter`, now exported for preview) is itself styled to match the premium dark frame: a centered, max-width-560px, muted (`#5C5C59`, 11px) block on the page background with the unsubscribe / manage-preferences link in green, replacing the old plain `<hr>` + grey paragraph. It still renders below the card because it is concatenated as `wrap(...) + footer`.

The firm-deal templates in `lib/firm-deal-detection/` (which build their own light-themed HTML shells outside `wrap()`) follow the same white-label pattern. The agent-facing trigger email (`render-email.ts`) renders the brokerage's logo image in its header when `brand_logo_url` is supplied, falling back to the green text banner otherwise. `dispatch-notification.ts` resolves that logo from `brokerages.logo_url` / `logo_includes_tagline` (keyed off the event's `brokerage_id`, the same column the `lib/email.ts` headers use) and passes `brand_logo_url` / `brand_logo_includes_tagline` into the renderer; a missing logo or read error just leaves it null so the send is never blocked. When the logo already bakes in the tagline (generated logos, `logo_includes_tagline = true`) it is rendered alone; for custom uploads a small "Powered by Firm Funds" line is added beneath it. When the trigger has the agent's commission and a closing date (the `detailed` / Tier C variant) the body is a two-option **payment chooser** ("wait for closing" vs "get paid today"); the framing is documented in `business/firm-deals.md`. The firm-deal email + SMS render offline via `npx tsx scripts/preview-firm-deal-email.mts` (writes gitignored `public/firm-deal-*.html` and dumps every SMS variant with its segment count).

### Transactional vs notification class

`opts.transactional = true` marks account, security, and legal emails the recipient cannot opt out of (invites, password resets, KYC, BoR documents, contact-email changes). These still include a `List-Unsubscribe` header (mailbox providers expect one) but bypass the preference check, and the footer wording reflects their mandatory nature. Everything else is notification-class and respects the preference flag.

## 3. The templates and when each fires

All of the following are exported `send...` functions in `lib/email.ts`.

### Deal lifecycle

| Function | Recipient | When | Class |
| --- | --- | --- | --- |
| `sendNewDealNotification` | Firm Funds admin | A new advance request is submitted | transactional |
| `sendBrokerageAdminNewDealNotification` | Brokerage admin | An agent submits a request | notification |
| `sendStatusChangeNotification` | Agent | Deal status changes. **Approved** renders a celebratory "stamped APPROVED" email that also confirms funds are on the way and flags the separate e-sign email as an action item; the deal-actions caller **skips this email entirely for `funded`** so the agent is not double-notified (the approval email already said funds were coming). Denied/other keep the status-transition treatment. | notification |
| `sendDocumentRequestNotification` | Agent | Admin requests a document | notification |
| `sendDocumentUploadedNotification` | Firm Funds admin | A document is uploaded | transactional |
| `sendDocumentReturnNotification` | Agent | A document is returned for fixing | notification |
| `sendDealMessageNotification` | Agent | A message is posted on the deal | notification |
| `sendAgentMessageNotification` | Firm Funds admin | An agent sends a message | notification |
| `sendInvoiceNotification` | (deal party) | An invoice is issued | notification |
| `sendClosingDateAlertDigest` | Firm Funds admin | Daily digest of approaching and overdue closings | transactional |

### Onboarding, accounts, and KYC

| Function | Recipient | When | Class |
| --- | --- | --- | --- |
| `sendAgentInviteNotification` | New agent | Agent is invited (token link, 72h expiry) | transactional |
| `sendBrokerageInviteNotification` | New brokerage | Brokerage is invited | transactional |
| `sendPasswordResetNotification` | User | Password reset requested | transactional |
| `sendEmailChangeNotification` | User | Email change requested | transactional |
| `sendAgentPhoneChangedNotification` | Agent | Phone number changed | transactional |
| `sendBrokerageContactEmailConfirm` | Brokerage | Confirm a new contact email | transactional |
| `sendBrokerageContactEmailChangeRequested` | Brokerage | Contact email change requested | transactional |
| `sendKycMobileUploadLink` | Agent | Agent requests a mobile ID-upload link | transactional |
| `sendKycApprovedNotification` | Agent | KYC verification passes | transactional |
| `sendBankingSubmittedNotification` | (admin) | Banking info submitted | notification |
| `sendBankingApprovalNotification` | Agent | Banking info approved | notification |

### Brokerage and settlement

| Function | Recipient | When |
| --- | --- | --- |
| `sendBrokerageMessageNotification` | Brokerage | A message is posted to the brokerage |
| `sendBrokerageStatusNotification` | Brokerage | Brokerage status changes |
| `sendSettlementReminderClosingDay` | Brokerage | On the closing day, reminding remittance |
| `sendSettlementReminderPaymentCheckIn` | Brokerage | Follow-up check-in within the settlement window |
| `sendMonthlyBrokerStatement` | Brokerage | Monthly statement (cron `monthly-broker-statements`) |
| `sendPaymentClaimSubmittedNotification` | (admin) | A brokerage claims it paid |

### Amendments and remediation

| Function | Recipient | When |
| --- | --- | --- |
| `sendAmendmentRequestedNotification` | (party) | A closing-date amendment is requested |
| `sendAmendmentApprovedNotification` | Agent | An amendment is approved |
| `sendAmendmentRejectedNotification` | Agent | An amendment is rejected |
| `sendFailedToCloseElectionEmail` | Agent | A funded deal failed; the agent must elect a cure path |
| `sendRemediationIdpSignedNotification` | Firm Funds admin | A Remediation IDP is signed (fired from the e-sign webhook) |
| `sendBrokerageExecutedIdpNotification` | Brokerage (broker of record + brokerage admin) | A deal's CPA/IDP or a Remediation IDP is fully signed; delivers the executed signed PDF as an attachment so the brokerage has its written authorization to remit (fired from the SignWell webhook) |

Firm-deal offer emails (the proactive offer, the 2-hour brokerage nudge, the 4-hour internal escalation, and the agent decline notice) are sent from `lib/firm-deal-detection/dispatch-brokerage-offer.ts`, not from `lib/email.ts`. See `business/firm-deals.md`.

## 4. The fail-soft pattern

Email is treated as best-effort. Server actions call a `send...` function and never roll back business state if it fails. For high-importance offer notifications, a failed send is enqueued into `cron_email_failures` (see below) for automated retry; for low-importance ones, the failure is just logged.

## 5. Email-related tables (in place of an email_log)

There is no general `email_log` audit table. Email observability and control use three purpose-built tables:

| Table | Purpose |
| --- | --- |
| `email_unsubscribe_tokens` | One stable token per entity (`entity_type` agent/brokerage, `entity_id`). Reused across every send to that entity so any saved unsubscribe link keeps working. Minted lazily by `getUnsubscribeToken`. |
| `agents.email_notifications_enabled` / `brokerages.email_notifications_enabled` | The per-recipient preference flag (NOT NULL DEFAULT true). Checked by `isEmailEnabledForEntity` before non-transactional sends; lookup failures fail open so a transient DB blip does not mute production mail. |
| `cron_email_failures` | A retry queue. When an important send (for example a firm-deal offer or decline notice) errors, a row is inserted here and the `retry-failed-emails` cron re-attempts delivery. |

If a true delivery audit log is ever required, it would be a new addition; today the system relies on Resend's own dashboard plus these three tables.

## 6. Environment variables

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key; required in production, optional (disables email) in dev |
| `NEXT_PUBLIC_SITE_URL` | Base URL used to build links and the unsubscribe URL (default `https://firmfunds.ca`) |
