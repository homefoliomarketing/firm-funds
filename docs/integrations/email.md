# Email Integration (Resend)

_Last updated: 2026-06-10_

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

The firm-deal templates in `lib/firm-deal-detection/` (which build their own light-themed HTML shells outside `wrap()`) follow the same white-label pattern. The agent-facing trigger email (`render-email.ts`) renders the brokerage's logo image in its header when `brand_logo_url` is supplied, falling back to the green text banner otherwise. `dispatch-notification.ts` resolves that logo from `brokerages.logo_url` / `logo_includes_tagline` (keyed off the event's `brokerage_id`, the same column the `lib/email.ts` headers use) and passes `brand_logo_url` / `brand_logo_includes_tagline` into the renderer; a missing logo or read error just leaves it null so the send is never blocked. When the logo already bakes in the tagline (generated logos, `logo_includes_tagline = true`) it is rendered alone; for custom uploads a small "Powered by Firm Funds" line is added beneath it.

### Transactional vs notification class

`opts.transactional = true` marks account, security, and legal emails the recipient cannot opt out of (invites, password resets, KYC, BoR documents, contact-email changes). These still include a `List-Unsubscribe` header (mailbox providers expect one) but bypass the preference check, and the footer wording reflects their mandatory nature. Everything else is notification-class and respects the preference flag.

## 3. The templates and when each fires

All of the following are exported `send...` functions in `lib/email.ts`.

### Deal lifecycle

| Function | Recipient | When | Class |
| --- | --- | --- | --- |
| `sendNewDealNotification` | Firm Funds admin | A new advance request is submitted | transactional |
| `sendBrokerageAdminNewDealNotification` | Brokerage admin | An agent submits a request | notification |
| `sendStatusChangeNotification` | Agent | Deal status changes (special copy for approved / funded / denied) | notification |
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
