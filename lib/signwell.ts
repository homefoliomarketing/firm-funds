/**
 * lib/signwell.ts
 *
 * SignWell e-signature API client — the SignWell counterpart to `lib/docusign.ts`.
 *
 * Firm Funds is piloting SignWell as a replacement for DocuSign (free API tier,
 * branding included). Server actions choose between the two providers via
 * `getEsignProvider()` in `lib/esign-config.ts`; this module is the SignWell
 * implementation that gets selected when that returns 'signwell'. (We do NOT
 * import esign-config here — this file is a leaf client with no provider logic.)
 *
 * Runtime constraints (this runs inside Netlify serverless functions):
 *   - ALWAYS `await` every async op (a returned-but-unawaited promise gets the
 *     function killed before it resolves).
 *   - NEVER read secrets at module top-level — read `process.env` lazily inside
 *     each function so a missing key fails the call, not the whole module load.
 *   - Fail with clear errors that include the HTTP status + SignWell's response
 *     body, so callers can surface validation messages (e.g. the 422 trial cap).
 *
 * SignWell API facts this is coded to (https://www.signwell.com/api/v1):
 *   - Auth: `X-Api-Key: <key>` header on every request.
 *   - Create:  POST /documents            (201 on success)
 *   - Get one: GET  /documents/{id}
 *   - Signed PDF (binary): GET /documents/{id}/completed_pdf
 *   - Signed PDF (url):    GET /documents/{id}/completed_pdf?url_only=true
 *   - Cancel/delete:       DELETE /documents/{id}
 *   - Webhook HMAC: HMAC-SHA256, key = the webhook id (SIGNWELL_WEBHOOK_ID),
 *     message = `${eventType}@${eventTime}`, compared against `event.hash`.
 */

import { createHmac, timingSafeEqual } from 'crypto'

// ============================================================================
// Configuration
// ============================================================================

const SIGNWELL_API_BASE = 'https://www.signwell.com/api/v1'

/** The real "Firm Funds" API App id (green accent + logo branding). */
const DEFAULT_API_APPLICATION_ID = '045510cd-b609-4c84-88b3-6a752599185c'

/**
 * Read the API key from the environment. Throws a clear error when missing so a
 * call fails loudly instead of sending an unauthenticated request.
 */
function getApiKey(): string {
  const key = process.env.SIGNWELL_API_KEY
  if (!key || key.trim() === '') {
    throw new Error('SIGNWELL_API_KEY is not configured')
  }
  return key
}

/** The branding API App id, falling back to the real Firm Funds app. */
function getApiApplicationId(): string {
  const id = process.env.SIGNWELL_API_APPLICATION_ID
  return id && id.trim() !== '' ? id : DEFAULT_API_APPLICATION_ID
}

/** True iff a SignWell API key is configured (non-empty string). */
export function isSignWellConfigured(): boolean {
  const key = process.env.SIGNWELL_API_KEY
  return typeof key === 'string' && key.trim() !== ''
}

// ============================================================================
// Public types
// ============================================================================

export interface SignWellFile {
  /** File name — MUST include the extension, e.g. "Commission Purchase Agreement.docx". */
  name: string
  /** Base64-encoded file contents (no data: URI prefix). */
  base64: string
}

export interface SignWellRecipient {
  /** Your own signer number as a string, e.g. "1". REQUIRED — referenced by text tags. */
  id: string
  email: string
  name: string
}

export interface SendSignWellParams {
  name: string
  subject: string
  message: string
  files: SignWellFile[]
  recipients: SignWellRecipient[]
  metadata?: Record<string, string>
  /** Default false. true = unlimited, non-binding test documents (good for validation). */
  testMode?: boolean
}

export interface SendSignWellResult {
  documentId: string
  status: string
  /** files[].pages_number, in the same order as the request files. */
  pagesPerFile: number[]
  /** recipients[].signing_url (empty strings where SignWell omitted one). */
  signingUrls: string[]
  /** The parsed JSON response, for debugging/logging. */
  raw: unknown
}

// ============================================================================
// Internal response narrowing helpers (no `any`)
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Coerce SignWell's pages_number (int, possibly stringified) to a number. */
function asPageCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** Parse a response body as JSON, returning undefined if it isn't JSON. */
async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

// ============================================================================
// Create / Send
// ============================================================================

/**
 * Create and send a SignWell document.
 *
 * Always sets `text_tags: true` (so embedded {{...}} tags become fields) and the
 * branding `api_application_id`. `test_mode` comes from params.testMode (default
 * false). Throws on any non-201 with the HTTP status + SignWell's response body.
 */
export async function sendSignWellDocument(
  params: SendSignWellParams
): Promise<SendSignWellResult> {
  const apiKey = getApiKey()

  const body: Record<string, unknown> = {
    test_mode: params.testMode === true,
    draft: false,
    text_tags: true,
    api_application_id: getApiApplicationId(),
    name: params.name,
    subject: params.subject,
    message: params.message,
    files: params.files.map((f) => ({ name: f.name, file_base64: f.base64 })),
    recipients: params.recipients.map((r) => ({ id: r.id, email: r.email, name: r.name })),
  }
  if (params.metadata) {
    body.metadata = params.metadata
  }

  const res = await fetch(`${SIGNWELL_API_BASE}/documents`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (res.status !== 201) {
    const errText = await res.text()
    throw new Error(`SignWell create document failed: ${res.status} ${errText}`)
  }

  const json = await parseJsonSafe(res)
  if (!isRecord(json)) {
    throw new Error('SignWell create document returned an unexpected (non-object) response body')
  }

  const documentId = asString(json.id)
  const status = asString(json.status)

  const filesRaw = Array.isArray(json.files) ? json.files : []
  const pagesPerFile = filesRaw.map((f) => (isRecord(f) ? asPageCount(f.pages_number) : 0))

  const recipientsRaw = Array.isArray(json.recipients) ? json.recipients : []
  const signingUrls = recipientsRaw.map((r) => (isRecord(r) ? asString(r.signing_url) : ''))

  return {
    documentId,
    status,
    pagesPerFile,
    signingUrls,
    raw: json,
  }
}

// ============================================================================
// Cancel / Delete
// ============================================================================

/**
 * Cancel (and remove) a SignWell document. Cancels signing if it is in progress.
 * There is no separate "void" endpoint — DELETE is the cancel. Throws on non-2xx.
 */
export async function cancelSignWellDocument(documentId: string): Promise<void> {
  const apiKey = getApiKey()

  const res = await fetch(`${SIGNWELL_API_BASE}/documents/${encodeURIComponent(documentId)}`, {
    method: 'DELETE',
    headers: { 'X-Api-Key': apiKey },
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`SignWell cancel document failed: ${res.status} ${errText}`)
  }
}

// ============================================================================
// Completed (signed) PDF
// ============================================================================

/**
 * Download the fully-signed merged PDF as a Buffer (binary completed_pdf endpoint).
 * The document must be status "Completed"; throws otherwise (with SignWell's body).
 */
export async function getSignWellCompletedPdf(documentId: string): Promise<Buffer> {
  const apiKey = getApiKey()

  const res = await fetch(
    `${SIGNWELL_API_BASE}/documents/${encodeURIComponent(documentId)}/completed_pdf`,
    { headers: { 'X-Api-Key': apiKey } }
  )

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`SignWell completed PDF download failed: ${res.status} ${errText}`)
  }

  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Get a short-lived URL to the completed PDF (url_only=true). The document must be
 * status "Completed". Throws on error or if no file_url comes back.
 */
export async function getSignWellCompletedPdfUrl(documentId: string): Promise<string> {
  const apiKey = getApiKey()

  const res = await fetch(
    `${SIGNWELL_API_BASE}/documents/${encodeURIComponent(documentId)}/completed_pdf?url_only=true`,
    { headers: { 'X-Api-Key': apiKey } }
  )

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`SignWell completed PDF URL fetch failed: ${res.status} ${errText}`)
  }

  const json = await parseJsonSafe(res)
  const fileUrl = isRecord(json) ? asString(json.file_url) : ''
  if (fileUrl === '') {
    throw new Error('SignWell completed PDF URL fetch returned no file_url')
  }
  return fileUrl
}

/**
 * Fetch a SignWell document's current status string (e.g. "Completed",
 * "Declined", "Sent", "Viewed"). The webhook uses this to confirm a claimed
 * terminal event against the LIVE document, since SignWell's HMAC signs only
 * `${type}@${time}` and the document id + status ride in the unsigned body
 * (SEC-D1). Throws on transport/HTTP error so the caller can treat the failure
 * as transient and force a redelivery rather than acting on unverified data.
 */
export async function getSignWellDocumentStatus(documentId: string): Promise<string | null> {
  const apiKey = getApiKey()

  const res = await fetch(
    `${SIGNWELL_API_BASE}/documents/${encodeURIComponent(documentId)}`,
    { headers: { 'X-Api-Key': apiKey } }
  )

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`SignWell document status fetch failed: ${res.status} ${errText}`)
  }

  const json = await parseJsonSafe(res)
  return isRecord(json) ? (asString(json.status) || null) : null
}

// ============================================================================
// Webhook verification
// ============================================================================

/**
 * Verify a SignWell webhook's HMAC signature.
 *
 * SignWell signs in the BODY, not a header: HMAC-SHA256 where the SECRET KEY is
 * the webhook's id (SIGNWELL_WEBHOOK_ID) and the hashed MESSAGE is
 * `${eventType}@${eventTime}` (e.g. "document_completed@1718049600"). The hex
 * digest is compared, constant-time, against the `event.hash` field of the body.
 *
 * Returns true immediately if SIGNWELL_HMAC_DEV_BYPASS === '1' (dev only),
 * mirroring DocuSign's DOCUSIGN_HMAC_DEV_BYPASS.
 *
 * `eventTime` may arrive as a number or string; it is coerced to a string for
 * the hashed message.
 */
export function verifySignWellWebhook(
  eventType: string,
  eventTime: string | number,
  providedHash: string
): boolean {
  if (process.env.SIGNWELL_HMAC_DEV_BYPASS === '1') {
    return true
  }

  const webhookId = process.env.SIGNWELL_WEBHOOK_ID
  if (!webhookId || webhookId.trim() === '') {
    // No secret configured → cannot verify → reject (fail closed).
    return false
  }

  if (typeof providedHash !== 'string' || providedHash === '') {
    return false
  }

  const message = `${eventType}@${String(eventTime)}`
  const expectedHex = createHmac('sha256', webhookId).update(message).digest('hex')

  const expectedBuf = Buffer.from(expectedHex, 'utf8')
  const providedBuf = Buffer.from(providedHash, 'utf8')

  // timingSafeEqual throws on length mismatch — guard it and treat as non-match.
  if (expectedBuf.length !== providedBuf.length) {
    return false
  }

  return timingSafeEqual(expectedBuf, providedBuf)
}
