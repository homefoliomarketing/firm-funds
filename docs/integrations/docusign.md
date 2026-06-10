# DocuSign Integration

_Last updated: 2026-06-09_

This document explains how Firm Funds generates contracts, sends them for e-signature through DocuSign, processes the Connect webhook, stores signed documents, and what environment variables and tokens the integration needs.

## 1. Overview

Firm Funds uses DocuSign to get legally binding signatures on four document types:

| Internal type | Document | Signer | Lives on |
| --- | --- | --- | --- |
| `cpa` | Commission Purchase Agreement | Agent | a deal |
| `idp` | Irrevocable Direction to Pay | Agent | a deal |
| `bca` | Brokerage Cooperation Agreement | Broker of Record | a brokerage |
| `remediation_idp` | Remediation Direction to Pay | Agent | a remediation deal |

The integration runs against a **production DocuSign account**. The config helper (`getDocuSignConfig` in `lib/docusign.ts`) refuses to start in production if any required env var is missing, and explicitly throws if the auth or base URL still points at the DocuSign sandbox (`account-d.docusign.com` or `demo.docusign.net`), because a signature routed through the sandbox is not legally enforceable.

## 2. Files

| File | Responsibility |
| --- | --- |
| `lib/docusign.ts` | OAuth token lifecycle, envelope create / status / void / download |
| `lib/actions/esign-actions.ts` | Server actions that build contract data and send each document type |
| `lib/contract-docx.ts` | Generates the actual .docx documents (CPA, IDP, BCA, amendment, remediation IDP) |
| `app/api/docusign/connect/route.ts` | Starts the OAuth consent flow, sets a CSRF state cookie |
| `app/api/docusign/callback/route.ts` | OAuth redirect target; exchanges the code for tokens |
| `app/api/docusign/webhook/route.ts` | DocuSign Connect webhook (HMAC verified) |

## 3. Authorization (OAuth)

DocuSign uses authorization-code OAuth with refresh tokens, stored in the single-row `docusign_tokens` table (`id = 1`).

- An admin starts the flow at `/api/docusign/connect`, which sets a one-time CSRF state cookie before redirecting to DocuSign. Never build a consent URL anywhere else; that path skips the state check.
- The `/callback` route verifies the state cookie and calls `exchangeCodeForTokens()`. `getUserInfo()` resolves the account's base URI, and `saveTokens()` upserts everything.
- `getValidAccessToken()` returns a fresh token. If the stored token is within 5 minutes of expiry it refreshes, serialized behind a Postgres advisory lock (`pg_advisory_xact_lock`) held in an explicit transaction. This matters because DocuSign rotates refresh tokens on every refresh; two parallel callers racing would invalidate each other's refresh token and break the integration until an admin re-authorizes. The loser of the race re-reads inside its own lock and finds the freshly refreshed token.
- `getValidAccessToken()` also fails closed in production if the stored `base_uri` is missing or points at the sandbox (`assertNotSandboxInProd`).
- `isDocuSignConnected()` is a simple "do we have a valid token" check used to gate the UI.

## 4. Sending a document for signature

The send actions all live in `lib/actions/esign-actions.ts` and follow the same shape. Taking `sendForSignature(dealId)` (CPA plus IDP) as the canonical example:

1. Verify the caller is a Firm Funds admin and DocuSign is connected.
2. Load the deal with its agent and brokerage. The deal must be in `approved` status, and the agent must have an email.
3. Refuse if an active (`sent` or `delivered`) envelope already exists for this deal.
4. Optimistic-lock claim on the deal's `version` so a parallel send cannot create duplicate envelopes.
5. Build a `contractData` merge-field map (legal names, fee figures, dates, RECO number, banking placeholders, and so on). The printed discount-period day count uses `getChargeDays(deal.days_until_closing)` so the contract's math reconciles with what is actually charged.
6. Generate the .docx documents (`generateCpaDocx`, `generateIdpDocx`) and base64-encode them.
7. Call `createAndSendEnvelope()`, which POSTs to `/restapi/v2.1/accounts/{accountId}/envelopes` with the documents, the agent as signer (recipient id 1), and the broker of record / brokerage admin as carbon copies. Signature, date, and initial fields are placed using anchor strings embedded in the document text (for example `Signature: /sig1/`, `Date Signed: /dat1/`, `/ini1/`).
8. Insert one `esignature_envelopes` row per document (CPA and IDP share the same `envelope_id` but have different `document_type`). If this insert fails, the DocuSign envelope is voided so a "sent" envelope can never become untrackable.
9. Audit-log `esignature.sent`.

`sendBcaForSignature`, `sendAmendedCpaForSignature`, and `sendRemediationIdpForSignature` follow the same pattern with their own merge fields and parent rows. The remediation send additionally CAS-claims the `remediation_deals` row from `pending` to `idp_sent` to prevent duplicate sends, reverting to `pending` if envelope creation fails.

Voiding is handled by `voidDealEnvelopes` / `voidBcaEnvelope`, which void each envelope in DocuSign first and only mark the DB rows that actually voided.

## 5. The Connect webhook (`app/api/docusign/webhook/route.ts`)

DocuSign Connect is configured to POST envelope status updates to `https://firmfunds.ca/api/docusign/webhook` in REST v2.1 JSON, aggregate mode. The webhook is registered in `middleware.ts`'s public allowlist so it is not redirected to login.

### HMAC verification (required)

DocuSign computes `base64(HMAC-SHA256(secret, rawBody))` and sends it in the `X-DocuSign-Signature-1` header. `verifyDocusignSignature()` recomputes it with `DOCUSIGN_HMAC_SECRET` and compares in constant time. The webhook **fails closed**: if the secret env var is missing, the header is absent, or the signature does not match, it returns `401`. This prevents an attacker with a leaked envelope id from flipping a deal to "signed" and fast-tracking it to funding. A dev-only escape hatch (`DOCUSIGN_HMAC_DEV_BYPASS=1`) skips verification and must never be set in production.

### Idempotency

DocuSign retries any non-2xx within roughly 100 seconds, and aggregate mode legitimately sends multiple events per envelope (`recipient-completed` plus `envelope-completed`). The webhook composes a canonical `event_id` from `event_name + generatedDateTime + envelopeId` and inserts it into `docusign_webhook_events`; a unique-violation (`23505`) means the event was already processed, so it returns 200 and stops the retries. The webhook always returns 200 on unexpected errors so DocuSign does not loop.

### Status mapping and processing

The DocuSign event name maps to an internal status (`envelope-completed` -> `signed`, `envelope-declined` -> `declined`, `envelope-voided` -> `voided`, and so on). On `signed`, the webhook downloads the signed PDFs and dispatches on the first document type:

- **BCA**: download the single signed PDF, store it under `brokerage-bca/{brokerageId}/...` in the `deal-documents` storage bucket, stamp `brokerages.bca_signed_at`, and record the storage path in `brokerages.bca_signed_pdf_path` (migration 107) so the signed BCA stays retrievable. The admin Brokerages page exposes a "View signed BCA" button that calls the Owner-only `getSignedBcaUrl` action (`brokerage.manage` capability) to mint a short-lived signed URL for that path.
- **Remediation IDP**: download and store under `remediation_idp/{remediationDealId}/...`, CAS-flip the `remediation_deals` row from `idp_sent` to `idp_signed` with `signed_at`, audit-log `remediation_deal.signed`, and email the Firm Funds admin (`sendRemediationIdpSignedNotification`) so the brokerage remittance step is on the radar. The status flip happens even if the PDF download fails, because the signature event itself is authoritative.
- **Regular deal (CPA plus IDP)**: for each document, download the signed PDF (CPA is documentId 1, IDP is documentId 2), store it under `{dealId}/...`, insert a `deal_documents` record (`commission_agreement` or `direction_to_pay`, `upload_source = 'nexone_auto'`), then find the matching underwriting checklist item and auto-check it, linking the document. If there is no valid auth token, the docs are not downloaded and the checklist items are left unchecked so the deal cannot silently advance.

The envelope-record update uses a compare-and-swap on `agent_signed_at` (only set if currently null) so duplicate "signed" deliveries do not overwrite the original timestamp.

## 6. Where signed documents are stored

All signed PDFs go into the Supabase storage bucket `deal-documents`, under a prefix that identifies the parent:

| Document | Storage path prefix |
| --- | --- |
| CPA / IDP | `{dealId}/` |
| BCA | `brokerage-bca/{brokerageId}/` |
| Remediation IDP | `remediation_idp/{remediationDealId}/` |

Deal-level documents (CPA, IDP) also get a row in `deal_documents`; BCA and Remediation IDP are tracked via their parent records (`brokerages.bca_signed_at` plus `brokerages.bca_signed_pdf_path` for the file path, `remediation_deals.status`).

## 7. Environment variables

| Variable | Purpose |
| --- | --- |
| `DOCUSIGN_INTEGRATION_KEY` | OAuth client id |
| `DOCUSIGN_SECRET_KEY` | OAuth client secret |
| `DOCUSIGN_ACCOUNT_ID` | DocuSign account id |
| `DOCUSIGN_AUTH_URL` | OAuth base (must be the production host, not `account-d.docusign.com`) |
| `DOCUSIGN_BASE_URL` | REST API base (must not be `demo.docusign.net`) |
| `DOCUSIGN_REDIRECT_URI` | OAuth callback URL (`/api/docusign/callback`) |
| `DOCUSIGN_HMAC_SECRET` | Connect webhook HMAC secret; webhook 401s if unset |
| `DOCUSIGN_HMAC_DEV_BYPASS` | Dev only; set to `1` to skip HMAC verification (never in production) |
| `SUPABASE_DB_URL` | Used for the advisory lock that serializes token refresh |

In production, every DocuSign variable except the dev bypass is mandatory; the config helper throws on startup if any is missing.
