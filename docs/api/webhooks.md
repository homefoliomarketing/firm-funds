# Inbound Webhooks

_Last updated: 2026-05-29_

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
2. **BCA envelope (Brokerage Cooperation Agreement):** downloads the single signed PDF to `brokerage-bca/{brokerageId}/...` and stamps `bca_signed_at` on the brokerage.
3. **Remediation IDP envelope (failed-deal cure):** downloads the signed PDF to `remediation_idp/{remediationDealId}/...`, flips the `remediation_deals` row to `idp_signed` with `signed_at` (compare-and-swap guarded on the prior `idp_sent` status), audit-logs the event, and emails the Firm Funds admin so the brokerage remittance step is tracked.

In every case the `esignature_envelopes` rows for that envelope are updated to the mapped status (with a compare-and-swap on `agent_signed_at` so re-arrivals do not overwrite the timestamp), and the dedup row is marked processed.

### Response behavior

Returns `200 OK` for handled, duplicate, and most soft-failure cases (so DocuSign does not loop on retries). Returns `401` only on HMAC failure, and `500` only if the dedup table write itself fails. If a signed envelope cannot be downloaded because there is no valid DocuSign auth token, the route logs the failure and does **not** check off the checklist items, leaving them for an admin to handle after re-authorizing DocuSign.

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
