# Inbound Webhooks

_Last updated: 2026-06-10_

This document describes the inbound webhook endpoints that accept POSTs from external systems, how each one is authenticated, the payload it expects, and the side effects it triggers.

## Critical: the middleware allowlist

> Any API route that accepts an external POST (a webhook or a provider callback) **must** be added to the relevant allowlist in `proxy.ts` (this project's middleware, exported as `proxy`), or the request gets bounced with a `302` redirect to `/login` before the handler ever runs.

There are two relevant lists in `proxy.ts`:

1. **`PUBLIC_PATHS`** lets the request through without a logged-in Supabase session. The DocuSign webhook (`/api/docusign/webhook`) and the unsubscribe endpoint (`/api/unsubscribe`) are both on it.
2. **CSRF exemption** (`API_CSRF_EXEMPT_EXACT` and `API_CSRF_EXEMPT_PREFIX`) skips the Origin/Referer check that otherwise rejects every state-changing `/api/*` request with `403`. External callers do not send a browser Origin header, so any webhook must be exempt here. The DocuSign webhook and the unsubscribe POST are exact-match exempt; all `/api/cron/*` routes are prefix-exempt.

When adding a new external POST endpoint, add it to both lists as needed and document its out-of-band authentication (HMAC, bearer secret, or token) inline in `proxy.ts`, preferring an exact path match over a wildcard.

---

## DocuSign Connect webhook

**Path:** `/api/docusign/webhook`
**Method:** POST
**Source file:** `app/api/docusign/webhook/route.ts`

### Purpose

Receives DocuSign Connect envelope status updates and drives the signing side of the deal lifecycle: when an envelope is signed, the route downloads the signed PDFs from DocuSign, stores them in Supabase storage, and updates the relevant records.

### Configuration (in DocuSign)

- URL: `https://firmfunds.ca/api/docusign/webhook`
- Data format: REST v2.1 (JSON)
- Event delivery mode: Aggregate
- HMAC security: required (configured in the DocuSign Connect configuration)

### Authentication / verification

The route verifies an **HMAC-SHA256** signature. DocuSign computes `base64(HMAC-SHA256(secret, rawBody))` and sends it in the `X-DocuSign-Signature-1` header. The handler recomputes the digest using the `DOCUSIGN_HMAC_SECRET` env var over the raw request body and compares with a constant-time check (`timingSafeEqual`).

The endpoint **fails closed**: if `DOCUSIGN_HMAC_SECRET` is unset, the signature header is missing, or the signature does not match, it returns `401 Unauthorized`. There is a development-only escape hatch (`DOCUSIGN_HMAC_DEV_BYPASS=1`) that skips verification and logs a warning; it must never be set in production. This HMAC enforcement closed a vulnerability where a leaked envelope ID could be used to forge a "signed" event and fast-track a deal to funding.

### Expected payload

A DocuSign Connect REST v2.1 aggregate JSON body. The handler reads fields defensively because the shape varies:

- Envelope ID from `envelopeId`, `data.envelopeId`, or `EnvelopeStatus.EnvelopeID`.
- Event from the `event` field (for example `envelope-completed`, `envelope-sent`, `recipient-completed`), mapped to an internal status. Falls back to `status` / nested summary fields for older shapes.
- Recipient statuses from `recipients.signers[]` (recipient `1` is the agent signer).

### Idempotency

DocuSign retries any non-2xx delivery and aggregate mode legitimately sends multiple events per envelope. The handler composes a canonical `event_id` from `event + generatedDateTime + envelopeId` and inserts it into `docusign_webhook_events`. A unique-violation (`23505`) means the event was already processed, so it returns `200` to stop retries. Unrecognized shapes fall back to a random UUID, so dedup is best-effort for them.

### Side effects on a signed envelope

The handler dispatches on the envelope's `document_type` into one of three flows:

1. **Deal envelope (CPA + IDP):** downloads each signed PDF (CPA = document 1, IDP = document 2), uploads to the `deal-documents` storage bucket, inserts `deal_documents` rows, and auto-checks the matching `underwriting_checklist` items, linking each to its stored document.
2. **BCA envelope (Brokerage Cooperation Agreement):** downloads the single signed PDF to `brokerage-bca/{brokerageId}/...`, stamps `bca_signed_at` on the brokerage, **and records the storage path in `brokerages.bca_signed_pdf_path`** (migration 107) so the signed BCA can be viewed/downloaded later. The admin Brokerages page surfaces a "View signed BCA" button backed by the Owner-only `getSignedBcaUrl` server action (`brokerage.manage` capability), which mints a short-lived signed URL for that path.
3. **Remediation IDP envelope (failed-deal cure):** downloads the signed PDF to `remediation_idp/{remediationDealId}/...`, flips the `remediation_deals` row to `idp_signed` with `signed_at` (compare-and-swap guarded on the prior `idp_sent` status), audit-logs the event, and emails the Firm Funds admin so the brokerage remittance step is tracked.

In every case the `esignature_envelopes` rows for that envelope are updated to the mapped status (with a compare-and-swap on `agent_signed_at` so re-arrivals do not overwrite the timestamp), and the dedup row is marked processed.

### Response behavior

Returns `200 OK` for handled, duplicate, and most soft-failure cases (so DocuSign does not loop on retries). Returns `401` only on HMAC failure, and `500` only if the dedup table write itself fails. If a signed envelope cannot be downloaded because there is no valid DocuSign auth token, the route logs the failure and does **not** check off the checklist items, leaving them for an admin to handle after re-authorizing DocuSign.

---

## SignWell webhook

**Path:** `/api/signwell/webhook`
**Method:** POST
**Source file:** `app/api/signwell/webhook/route.ts`

This is the SignWell counterpart to the DocuSign Connect webhook, added for the SignWell pilot (see [docs/integrations/signwell.md](../integrations/signwell.md)). It is active whenever `ESIGN_PROVIDER=signwell`. It mirrors the DocuSign webhook field-for-field so both providers produce identical database state, with a few SignWell-specific differences noted below.

### Purpose

Receives SignWell document status updates and drives the signing side of the deal lifecycle: when a document is completed, the route downloads the merged signed PDF from SignWell, stores it in Supabase storage, and updates the relevant records (`esignature_envelopes`, `deal_documents`, `underwriting_checklist`, `brokerages`, `remediation_deals`).

### Configuration (in SignWell)

- URL: `https://firmfunds.ca/api/signwell/webhook`
- Register under SignWell Settings -> API -> Webhooks (or via the API hook field), and capture the webhook's id into `SIGNWELL_WEBHOOK_ID` (it is the HMAC secret).

### Authentication / verification

SignWell signs in the **body, not a header**. It sends `hex(HMAC-SHA256(secret, message))` as the `event.hash` field of the JSON body, where the **secret** is the webhook id (`SIGNWELL_WEBHOOK_ID`) and the **message** is `` `${event.type}@${event.time}` ``. `verifySignWellWebhook()` recomputes the hex digest and compares constant-time against `event.hash`.

The endpoint **fails closed**: a missing `SIGNWELL_WEBHOOK_ID`, a missing/empty hash, or a mismatch returns `401`. A dev-only escape hatch (`SIGNWELL_HMAC_DEV_BYPASS=1`) skips verification and must never be set in production. This closes the same forged-completion vulnerability the DocuSign HMAC check closes.

### Expected payload

A SignWell JSON body of the shape `{ event: { type, time, hash }, data: { object: { id, status, ... }, account_id } }`. The handler reads the event type from `event.type`, the document id from `data.object.id`, and the document status from `data.object.status`, all defensively.

Terminal events handled: `document_completed` -> `signed`, `document_declined` -> `declined`, `document_canceled` -> `voided`. Non-terminal events (`document_sent`, `document_viewed`, per-signer `document_signed`) are acknowledged with `200` and ignored.

### Idempotency

SignWell sends no stable per-delivery event id, so the handler synthesizes a dedup key from the `` `${event.type}@${event.time}@${documentId}` `` triple (the same triple SignWell signs) and inserts it into `signwell_webhook_events` (migration 109) at the start of processing. A unique-violation (`23505`) returns `200` to stop retries.

### Side effects on a signed document

Dispatches on the first envelope row's `document_type` into the same three flows as the DocuSign webhook (deal CPA+IDP, BCA, Remediation IDP). Two SignWell-specific differences:

- The SignWell **document** id is stored in `esignature_envelopes.envelope_id` (a CPA+IDP send has two rows sharing one document id).
- SignWell returns **one merged completed PDF per document** (`GET /documents/{id}/completed_pdf`), not a per-file download. For a CPA+IDP document the same merged bytes back both `deal_documents` rows.

### Response behavior

Returns `200` for handled, duplicate, non-terminal, and malformed cases (so SignWell stops retrying), and `401` only on HMAC failure. On a **recoverable** failure while downloading/storing the signed PDF, it deletes its dedup-claim row and returns `503` so SignWell re-delivers and the download is retried. The `500` path is reserved for a failure writing the dedup table itself.

---

## CASL one-click unsubscribe (provider POST)

**Path:** `/api/unsubscribe`
**Method:** POST (also GET and PUT)
**Source file:** `app/api/unsubscribe/route.ts`

This is not a third-party service webhook in the DocuSign sense, but it is an inbound POST that arrives from external mail providers (Gmail, iCloud, Yahoo) on the recipient's behalf, so it has the same middleware requirements and is documented here.

### Purpose

RFC 8058 one-click unsubscribe. When a recipient clicks the mailbox "Unsubscribe" button, the provider POSTs to the URL from the email's `List-Unsubscribe` header, often with an empty body. The handler sets the target entity's `email_notifications_enabled` to `false`.

### Authentication / verification

There is no HMAC or session. The **per-entity token** (from `email_unsubscribe_tokens`) carried in the query string or request body is the authentication. The token is the secret; the worst an attacker who replays a captured URL can do is unsubscribe the recipient, who can resubscribe via the same link. Because of this, the endpoint is intentionally CSRF-exempt (providers send no Origin header) and `PUBLIC_PATHS`-listed, and every method is rate-limited per IP to slow token enumeration.

### Expected payload

The token may arrive three ways: `?token=...` in the query, a JSON body `{ token }`, or a form-encoded `token` field. Tokens shorter than 16 characters are rejected with `400`.

### Side effects

- **POST** sets `email_notifications_enabled=false` on the `agents` or `brokerages` row and writes a fire-and-forget audit-log entry (`email.notifications_unsubscribed`). Returns `{ ok: true, action: 'unsubscribed' }`.
- **GET** is a validation probe that returns `{ ok: true, entityType }` without changing anything.
- **PUT** (used by the human landing page's resubscribe button) flips the flag back to `true` and logs `email.notifications_resubscribed`.

---

## Note on ParcLabs

Earlier planning notes referenced a ParcLabs firm-deal webhook (`app/api/webhooks/parcllabs/route.ts`). That route does **not** exist in the current tree. Firm-deal detection is currently driven by the spreadsheet-polling cron (`/api/cron/firm-deal-poller`) reading brokerage Google Sheets, not by an inbound ParcLabs POST. If a ParcLabs (or any other) webhook is added later, document it in this file, describe its verification mechanism, and remember to add its path to the `PUBLIC_PATHS` and CSRF-exemption lists in `proxy.ts`.
