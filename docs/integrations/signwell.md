# SignWell Integration

_Last updated: 2026-06-10_

This document explains how Firm Funds sends contracts for e-signature through SignWell, how field placement works with hidden text tags, how the webhook processes completions, where signed documents are stored, how the executed Direction to Pay is emailed to the brokerage, the runtime provider flag that toggles between SignWell and DocuSign, and the open items that still need live validation.

> SignWell is a **pilot** meant to replace [DocuSign](docusign.md). It is built behind a runtime flag (`ESIGN_PROVIDER`) so DocuSign keeps working untouched until a real SignWell send is validated in production. Read this doc alongside [docusign.md](docusign.md) — the SignWell path deliberately mirrors the DocuSign path field-for-field so both providers produce identical database state.

## 1. Overview

### Why SignWell

DocuSign locks email and signing-page branding behind a sales-only "Direct" account. SignWell includes branding (the green Firm Funds accent and logo) on its free API tier, so the contracts and signing experience can look like Firm Funds without a sales contract. SignWell is being trialed as a drop-in replacement.

SignWell signs the same four document types as DocuSign:

| Internal type | Document | Signer | Lives on |
| --- | --- | --- | --- |
| `cpa` | Commission Purchase Agreement | Agent | a deal |
| `idp` | Irrevocable Direction to Pay | Agent | a deal |
| `bca` | Brokerage Cooperation Agreement | Broker of Record | a brokerage |
| `remediation_idp` | Remediation Direction to Pay | Agent | a remediation deal |

The signer is always recipient `"1"` (the agent, or the Broker of Record on a BCA).

### Provider flag

The active provider is chosen at runtime by the `ESIGN_PROVIDER` env var, read by `getEsignProvider()` in `lib/esign-config.ts`. Values are `docusign` (the default) or `signwell`. The **same** `.docx` generators serve both providers; `lib/contract-docx.ts` emits provider-specific field markers based on the flag. Nothing else in the app needs to know which provider is active.

## 2. Files

| File | Responsibility |
| --- | --- |
| `lib/esign-config.ts` | The provider flag (`getEsignProvider()`) and SignWell field pixel sizes (`SIGNWELL_FIELD_SIZE`). Tiny and dependency-free so both the generator and the client can import it |
| `lib/signwell.ts` | SignWell API client — the counterpart to `lib/docusign.ts`. Create/send, cancel, completed-PDF download, completed-PDF URL, webhook HMAC verification |
| `lib/actions/esign-actions.ts` | Server actions that build contract data and send each document type. Branches on `getEsignProvider()` to pick SignWell or DocuSign |
| `lib/contract-docx.ts` | Generates the `.docx` documents and, when SignWell is active, embeds hidden SignWell text tags for signatures, dates, and per-page initials |
| `app/api/signwell/webhook/route.ts` | SignWell webhook (HMAC verified). Marks rows signed, stores the completed PDF, links documents and checklist items |

### Client exports (`lib/signwell.ts`)

`isSignWellConfigured`, `sendSignWellDocument`, `cancelSignWellDocument`, `getSignWellCompletedPdf`, `getSignWellCompletedPdfUrl`, `verifySignWellWebhook`.

The client authenticates with an `X-Api-Key: <key>` header on every request against the base `https://www.signwell.com/api/v1`. It reads secrets lazily inside each function (never at module top level) so a missing key fails the call, not the whole module load, and it always `await`s every async op because it runs inside Netlify serverless functions.

## 3. How field placement works (hidden text tags)

SignWell turns `{{...}}` markers embedded in the document into signature fields when the create request sends `text_tags: true`. Firm Funds embeds these tags as **hidden** runs — white text at 1-2pt — so the signer never sees the raw code on the page (`signWellTagRun()` in `lib/contract-docx.ts`).

### Tag grammar

```
{{Type:Signer:Required:Label:Prefill:ApiID:Width:Height}}
```

Firm Funds uses three field types:

- `signature` — the agent/Broker-of-Record signature.
- `autofill_date_signed` — the date the document was signed, auto-filled by SignWell.
- `initial` — per-page initials.

Two grammar details matter:

- **Signer is always `1`.** Every tag targets recipient `"1"`, the lone signer.
- **Width/Height (positions 7 and 8, in pixels) are required.** SignWell sizes a field to the rendered footprint of its placeholder text. Because the tag text is hidden (white, 1pt), without an explicit size the field would collapse to a tiny unusable dot. The pixel sizes live in `SIGNWELL_FIELD_SIZE` in `lib/esign-config.ts` (`signature` 200×40, `initial` 64×28, `date` 130×28). SignWell caps signature/initial fields at 200px tall.

### Signature at the end of each document

A `{{signature}}` tag plus an `{{autofill_date_signed}}` tag sit on the signature line at the end of each document — the CPA signature page, the IDP / Remediation IDP signature block, and the BCA signature page. This mirrors DocuSign's `/sig1/` and `/dat1/` anchors.

### Per-page initials (in the footer)

For the per-page initials Firm Funds wants, the `{{initial}}` tag is placed in the **page footer**. Word footers repeat on every page, so a single tag in the footer is intended to yield exactly one initials field per page — with no per-page anchor bookkeeping.

This is deliberately different from the DocuSign path: DocuSign double-matched a footer anchor (it found the anchor in both the default and first-page footer XML and stacked duplicate initials tabs), so on the DocuSign path the initials anchor lives in the body via `initialsAnchor()` and the footer stays a plain visible line. On the SignWell path, `initialsAnchor()` is a no-op and the footer carries the hidden `{{initial}}` tag instead.

> **Needs live validation.** Whether SignWell parses a tag inside a repeating Word footer **once per page** is NOT documented by SignWell. This must be confirmed with one live `test_mode` send that inspects the returned `fields` / `pages_number` on the created document. See [Open items](#7-open-items--needs-live-validation).

## 4. Sending a document for signature

The send actions live in `lib/actions/esign-actions.ts` and branch on `getEsignProvider()`. When SignWell is active they first check `isSignWellConfigured()` and return a clear error (`Add SIGNWELL_API_KEY`) if the key is missing.

`sendSignWellDocument(params)` POSTs to `/documents` with:

- `text_tags: true` — so the embedded `{{...}}` tags become fields.
- `api_application_id` — the **"Firm Funds" branding app**. Defaults to `045510cd-b609-4c84-88b3-6a752599185c`, overridable via the `SIGNWELL_API_APPLICATION_ID` env var.
- `test_mode` — from `params.testMode` (default `false`). `true` produces unlimited, non-binding test documents — ideal for validating placement (see the billing note below).
- `files[]` — each `{ name, file_base64 }`. The file name **must** include the extension.
- `recipients[]` — each `{ id, email, name }`. The signer is recipient `"1"`.

A successful create returns `201`; the client throws on any other status with the HTTP status and SignWell's response body so callers can surface validation messages (for example the 422 trial cap). The result exposes the `documentId`, the document `status`, `pagesPerFile` (from `files[].pages_number`, useful for the footer-initials validation above), and `signingUrls`.

### One SignWell document = one document id

For a **CPA + IDP** send, both files go into a single SignWell document, so there is one SignWell document id. Two `esignature_envelopes` rows (`cpa` and `idp`) share that id, stored in the existing `envelope_id` column. **No DB migration was needed for envelopes** — the existing schema already supports two rows pointing at one provider id (this is how the DocuSign path works too). BCA and Remediation IDP each have a single envelope row.

### Cancelling

`cancelSignWellDocument(documentId)` issues `DELETE /documents/{id}`. SignWell has no separate "void" endpoint — DELETE is the cancel, and it cancels signing if it is in progress.

## 5. The webhook (`app/api/signwell/webhook/route.ts`)

SignWell POSTs document status updates to `https://firmfunds.ca/api/signwell/webhook`. The route is on the `proxy.ts` `PUBLIC_PATHS` allowlist and is CSRF-exempt, like every external POST (see [webhooks.md](../api/webhooks.md)).

It handles three terminal events:

- `document_completed` -> internal status `signed`
- `document_declined` -> `declined`
- `document_canceled` -> `voided`

Per-signer / non-terminal events (`document_sent`, `document_viewed`, `document_signed`) are acknowledged with `200` and otherwise ignored.

### HMAC verification (required)

SignWell signs in the **body, not a header**. It computes `hex(HMAC-SHA256(secret, message))` where:

- the **secret** is the webhook's id (the `SIGNWELL_WEBHOOK_ID` env var), and
- the **message** is `` `${event.type}@${event.time}` `` (for example `document_completed@1718049600`).

The result is sent as the `event.hash` field inside the JSON body. `verifySignWellWebhook()` recomputes the hex digest and compares it constant-time against `event.hash`. The webhook **fails closed**: a missing secret, a missing/empty hash, or a mismatch returns `401`. This prevents an attacker with a leaked document id from forging a "signed" event and fast-tracking a deal to funding. A dev-only escape hatch (`SIGNWELL_HMAC_DEV_BYPASS=1`) skips verification and must never be set in production — it mirrors DocuSign's `DOCUSIGN_HMAC_DEV_BYPASS`.

### Idempotency

SignWell sends no stable per-delivery event id, so the route synthesizes a dedup key from the `` `${event.type}@${event.time}@${documentId}` `` triple — the same triple SignWell signs — and inserts it into the `signwell_webhook_events` table (migration 109) at the start of processing. A unique-violation (`23505`) means the event was already handled, so the route returns `200` to stop retries.

### Processing on a signed document

On `document_completed`, the route updates every `esignature_envelopes` row for that document id to `signed` (compare-and-swap on `agent_signed_at` so a re-delivery never re-stamps the timestamp), then dispatches on the first row's `document_type` into the same three flows as the DocuSign webhook:

- **BCA**: store the merged PDF under `brokerage-bca/{brokerageId}/...`, stamp `brokerages.bca_signed_at`, and record the storage path in `brokerages.bca_signed_pdf_path` (migration 107).
- **Remediation IDP**: store under `remediation_idp/{remediationDealId}/...`, CAS-flip the `remediation_deals` row from `idp_sent` to `idp_signed` with `signed_at`, audit-log `remediation_deal.signed`, and email the Firm Funds admin (`sendRemediationIdpSignedNotification`). The status flip happens even if the PDF download fails, because the signature event is authoritative. The broker of record is also emailed the executed signed Remediation IDP (see [Delivering the executed copy to the brokerage](#delivering-the-executed-copy-to-the-brokerage)).
- **Regular deal (CPA + IDP)**: for each envelope row, store the PDF under `{dealId}/...`, insert a `deal_documents` record (`commission_agreement` or `direction_to_pay`, `upload_source = 'nexone_auto'`, note "Signed via SignWell"), then find the matching `underwriting_checklist` item and auto-check it, linking the document. After the rows are stored, the brokerage is emailed the executed signed Direction to Pay (see below).

### Delivering the executed copy to the brokerage

The Irrevocable Direction to Pay is the brokerage's written authorization to remit the agent's commission to Firm Funds, so the brokerage must receive the executed copy. The old DocuSign path handled this by CC'ing the brokerage on the envelope; SignWell treats every recipient as a signer and has no CC, so the webhook delivers the executed copy itself via Resend (`sendBrokerageExecutedIdpNotification` in `lib/email.ts`). This is branded, logged, and more reliable than a provider CC.

- **Deal (CPA + IDP)**: after the signed docs are stored, the webhook loads the deal's agent and brokerage, dedupes the recipient list (`brokerages.broker_of_record_email` and `brokerages.email`, case-insensitive, nulls dropped), and sends one email with the executed PDF attached. If neither address is on file it logs a warning and skips. The attachment is the **merged** completed PDF, so it currently also includes the signed CPA, matching the prior DocuSign CC (which copied the whole envelope). It could be narrowed to the IDP page later via `completed_pdf?file_format=zip`.
- **Remediation IDP**: the broker of record (`remediation_deals.broker_of_record_email`) is emailed the executed Remediation IDP with the same helper.
- **Best-effort, exactly once.** The email send is wrapped in its own try/catch and is fired once per completion (outside the per-row loop). The signed PDF is already stored, so a Resend failure only logs `console.error` — it never throws, never flips the transient-failure flag, and never returns a 503. That avoids a webhook retry re-storing duplicate objects just because email hiccupped.

### Transient-failure retry (503)

The status flips above are CAS-guarded and authoritative on their own, but losing the signed PDF is not acceptable. If downloading or storing the completed PDF hits a recoverable error, the route **deletes its dedup-claim row** and returns `503` so SignWell re-delivers and the download is retried. (A true duplicate never reaches this point — it 200s at the `23505` branch; malformed/non-terminal events also 200 earlier.) Any unexpected error in the handler returns `200` so SignWell does not loop on a bug.

## 6. Where signed documents are stored

The completed PDF comes from `GET /documents/{id}/completed_pdf` (binary) or `?url_only=true` (a short-lived URL). All signed PDFs go into the Supabase `deal-documents` storage bucket, under the same prefixes as the DocuSign path:

| Document | Storage path prefix |
| --- | --- |
| CPA / IDP | `{dealId}/` |
| BCA | `brokerage-bca/{brokerageId}/` |
| Remediation IDP | `remediation_idp/{remediationDealId}/` |

> **Known limitation: merged PDF.** `completed_pdf` returns **one merged PDF** for a multi-file document. For a CPA + IDP send, both the CPA and IDP `deal_documents` rows currently point at storage objects holding the **same merged content** (separate paths, identical bytes). A `TODO(signwell)` in the route notes that `completed_pdf?file_format=zip` can return the individual source files if true per-file splitting is needed later.

## 7. Provider flag and cutover

| Variable | Purpose |
| --- | --- |
| `ESIGN_PROVIDER` | `docusign` (default) or `signwell`. Read by `getEsignProvider()` |
| `SIGNWELL_API_KEY` | SignWell API key (`X-Api-Key` header) |
| `SIGNWELL_API_APPLICATION_ID` | Branding app id. Optional; defaults to the Firm Funds app `045510cd-b609-4c84-88b3-6a752599185c` |
| `SIGNWELL_WEBHOOK_ID` | The webhook id, used as the HMAC secret to verify inbound webhooks |
| `SIGNWELL_HMAC_DEV_BYPASS` | Dev only; set to `1` to skip webhook HMAC verification (never in production) |

See [setup.md](../development/setup.md#signwell-e-signature) for the full env-var table.

### Cutover steps

1. Set `SIGNWELL_API_KEY` (and `SIGNWELL_WEBHOOK_ID` once the webhook is registered).
2. Register the webhook in SignWell pointed at `https://firmfunds.ca/api/signwell/webhook` and capture its id into `SIGNWELL_WEBHOOK_ID`.
3. Validate placement with a `test_mode: true` send (unlimited and unbilled) and inspect the returned `fields` / `pages_number` — especially the per-page footer initials.
4. Flip `ESIGN_PROVIDER=signwell`. DocuSign stays fully wired, so reverting is just flipping the flag back to `docusign`.

### Billing / trial note

- `test_mode: true` sends are **unlimited and unbilled** — the right tool for validating field placement without burning quota or creating binding documents.
- The free API tier is **25 documents/month**.
- The "5 documents/day" limit some accounts hit is **trial-only** (it applies while the account is on a paid-plan trial); it does not exist on the regular API / free tier.

## 8. Open items / needs live validation

These are unverified or incomplete as of this writing. Do not assume they work — confirm before relying on them.

- **Footer-tag per-page initials.** SignWell does not document whether a `{{initial}}` tag inside a repeating Word footer is parsed once per page. Confirm with a single `test_mode` send and inspect the returned `fields` count against `pages_number`. If SignWell only places it once, the initials approach needs a different strategy (for example a body-level per-section tag, like the DocuSign path).
- **Send-time (pre-signing) CC.** SignWell treats every recipient as a signer, so the DocuSign carbon-copy recipient (the Broker of Record / brokerage admin) is **not** added to the document at send time. This is intentionally unimplemented and is now a minor nice-to-have only: on completion the brokerage already receives the executed signed Direction to Pay by email with the PDF attached (see [Delivering the executed copy to the brokerage](#delivering-the-executed-copy-to-the-brokerage)), which is the legally required delivery. A pre-signing "FYI, your agent is signing" CC could still be added later via a separate Resend send if desired.
- **Merged completed PDF.** The CPA and IDP signed copies point at the same merged PDF. `TODO`: split per-file via `completed_pdf?file_format=zip` if separate signed copies are required.
- **Webhook registration.** The webhook must be registered in SignWell (Settings -> API -> Webhooks, or via the API hook field) and its id captured into `SIGNWELL_WEBHOOK_ID`. Until then, `verifySignWellWebhook()` fails closed and the webhook returns `401`.
- **Support questions to confirm with SignWell.** (a) Footer-tag per-page behavior. (b) Whether `completed_pdf?file_format=zip` reliably returns one PDF per source file with signatures applied. (c) Exact `event.time` format used in the HMAC message (epoch seconds vs string) across event types, since the dedup key and the signed message both depend on it.
