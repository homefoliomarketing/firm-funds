'use server'

import { Client } from 'pg'
import { createServiceRoleClient } from '@/lib/supabase/server'

// ============================================================================
// DocuSign Configuration
// ============================================================================

const DOCUSIGN_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY!
const DOCUSIGN_SECRET_KEY = process.env.DOCUSIGN_SECRET_KEY!
const DOCUSIGN_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID!

// In production, all three URLs MUST be set explicitly. Defaulting to
// demo.docusign.net / account-d.docusign.com silently routes signed CPAs
// through the sandbox, where they are not legally enforceable. Dev keeps
// the sandbox defaults for local testing.
const DOCUSIGN_AUTH_URL = process.env.DOCUSIGN_AUTH_URL || 'https://account-d.docusign.com'
const DOCUSIGN_BASE_URL = process.env.DOCUSIGN_BASE_URL
const DOCUSIGN_REDIRECT_URI = process.env.DOCUSIGN_REDIRECT_URI

if (process.env.NODE_ENV === 'production') {
  if (!process.env.DOCUSIGN_AUTH_URL) {
    throw new Error('DOCUSIGN_AUTH_URL not configured for production')
  }
  if (!DOCUSIGN_BASE_URL) {
    throw new Error('DOCUSIGN_BASE_URL not configured for production')
  }
  if (!DOCUSIGN_REDIRECT_URI) {
    throw new Error('DOCUSIGN_REDIRECT_URI not configured for production')
  }
  if (DOCUSIGN_AUTH_URL.includes('account-d.docusign.com')) {
    throw new Error('DOCUSIGN_AUTH_URL points at sandbox in production')
  }
  if (DOCUSIGN_BASE_URL.includes('demo.docusign.net')) {
    throw new Error('DOCUSIGN_BASE_URL points at sandbox in production')
  }
}

// ============================================================================
// OAuth — Exchange Code for Tokens
//
// Note: the consent URL is built by /api/docusign/connect, which also sets a
// one-time CSRF state cookie before redirecting to DocuSign. The /callback
// route verifies the cookie. Do not construct an auth URL elsewhere — that
// path skips the state check.
// ============================================================================

export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}> {
  const basicAuth = Buffer.from(`${DOCUSIGN_INTEGRATION_KEY}:${DOCUSIGN_SECRET_KEY}`).toString('base64')

  const res = await fetch(`${DOCUSIGN_AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DOCUSIGN_REDIRECT_URI || 'http://localhost:3000/api/docusign/callback',
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('DocuSign token exchange failed:', errText)
    throw new Error(`DocuSign token exchange failed: ${res.status}`)
  }

  return res.json()
}

// ============================================================================
// OAuth — Refresh Token
// ============================================================================

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}> {
  const basicAuth = Buffer.from(`${DOCUSIGN_INTEGRATION_KEY}:${DOCUSIGN_SECRET_KEY}`).toString('base64')

  const res = await fetch(`${DOCUSIGN_AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('DocuSign token refresh failed:', errText)
    throw new Error(`DocuSign token refresh failed: ${res.status}`)
  }

  return res.json()
}

// ============================================================================
// OAuth — Get User Info (to find base URI)
// ============================================================================

export async function getUserInfo(accessToken: string): Promise<{
  accounts: { account_id: string; base_uri: string; is_default: boolean }[]
}> {
  const res = await fetch(`${DOCUSIGN_AUTH_URL}/oauth/userinfo`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    throw new Error(`DocuSign userinfo failed: ${res.status}`)
  }

  return res.json()
}

// ============================================================================
// Token Storage — Save / Retrieve from Supabase
// ============================================================================

export async function saveTokens(tokens: {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  account_id: string
  base_uri: string
}): Promise<void> {
  const supabase = createServiceRoleClient()
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  const { error } = await supabase
    .from('docusign_tokens')
    .upsert({
      id: 1,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      expires_at: expiresAt,
      account_id: tokens.account_id,
      base_uri: tokens.base_uri,
    })

  if (error) {
    console.error('Failed to save DocuSign tokens:', error.message)
    throw new Error('Failed to save DocuSign tokens')
  }
}

// Token refresh is serialized with a Postgres advisory lock so two parallel
// callers (e.g. concurrent webhook invocations) can't both call DocuSign's
// /oauth/token endpoint. DocuSign rotates refresh tokens — if two callers
// race, the second's refresh_token is invalidated server-side and future
// refreshes break until an admin re-authorizes.
//
// The lock is held inside an explicit transaction during the entire HTTP
// refresh, so a concurrent caller blocks at pg_advisory_xact_lock until the
// winner commits. The loser then re-reads inside its own lock and finds the
// freshly-refreshed token, returning without calling DocuSign.
const DOCUSIGN_TOKEN_LOCK_KEY = 'docusign_token_singleton'
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

function tokenIsFresh(expiresAt: string | Date): boolean {
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime()
  return ms - Date.now() > TOKEN_REFRESH_BUFFER_MS
}

// Fail closed if the saved DocuSign account is null/missing or sandbox-bound
// while we're running in production. A misconfigured base_uri silently routes
// signed CPAs through demo.docusign.net where they are not enforceable.
function assertNotSandboxInProd(baseUri: string | null | undefined): void {
  if (process.env.NODE_ENV !== 'production') return
  if (!baseUri || baseUri.includes('demo.docusign.net')) {
    throw new Error(
      'DocuSign integration is pointing at SANDBOX in production. ' +
      'Re-link via /api/docusign/connect with the production account.'
    )
  }
}

export async function getValidAccessToken(): Promise<{
  accessToken: string
  accountId: string
  baseUri: string
} | null> {
  const supabase = createServiceRoleClient()

  const { data: tokenRow, error } = await supabase
    .from('docusign_tokens')
    .select('*')
    .eq('id', 1)
    .single()

  if (error || !tokenRow) {
    console.error('No DocuSign tokens found — admin needs to authorize')
    return null
  }

  if (tokenIsFresh(tokenRow.expires_at)) {
    assertNotSandboxInProd(tokenRow.base_uri)
    return {
      accessToken: tokenRow.access_token,
      accountId: tokenRow.account_id,
      baseUri: tokenRow.base_uri,
    }
  }

  const dbUrl = process.env.SUPABASE_DB_URL
  if (!dbUrl) {
    console.error('SUPABASE_DB_URL not set — cannot acquire token refresh lock')
    return null
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DOCUSIGN_TOKEN_LOCK_KEY])

    const { rows } = await client.query('SELECT * FROM docusign_tokens WHERE id = 1')
    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return null
    }
    const row = rows[0]

    if (tokenIsFresh(row.expires_at)) {
      await client.query('COMMIT')
      assertNotSandboxInProd(row.base_uri)
      return {
        accessToken: row.access_token,
        accountId: row.account_id,
        baseUri: row.base_uri,
      }
    }

    const refreshed = await refreshAccessToken(row.refresh_token)
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()

    await client.query(
      `UPDATE docusign_tokens
       SET access_token = $1, refresh_token = $2, token_type = $3, expires_at = $4, updated_at = now()
       WHERE id = 1`,
      [refreshed.access_token, refreshed.refresh_token, refreshed.token_type, newExpiresAt]
    )

    await client.query('COMMIT')

    assertNotSandboxInProd(row.base_uri)
    return {
      accessToken: refreshed.access_token,
      accountId: row.account_id,
      baseUri: row.base_uri,
    }
  } catch (err: any) {
    console.error('Failed to refresh DocuSign token — admin may need to re-authorize:', err?.message)
    try { await client.query('ROLLBACK') } catch { /* nothing to roll back */ }
    return null
  } finally {
    try { await client.end() } catch { /* already closed */ }
  }
}

// ============================================================================
// Check if DocuSign is connected
// ============================================================================

export async function isDocuSignConnected(): Promise<boolean> {
  const token = await getValidAccessToken()
  return token !== null
}

// ============================================================================
// Envelope — Create and Send
// ============================================================================

interface EnvelopeRecipient {
  email: string
  name: string
  recipientId: string
  routingOrder: string
  tabs?: {
    signHereTabs?: { documentId: string; anchorString: string; anchorXOffset: string; anchorYOffset: string; anchorUnits?: string }[]
    dateSignedTabs?: { documentId: string; anchorString: string; anchorXOffset: string; anchorYOffset: string; anchorUnits?: string }[]
    initialHereTabs?: { documentId: string; anchorString: string; anchorXOffset: string; anchorYOffset: string; anchorUnits?: string }[]
  }
}

interface EnvelopeDocument {
  documentBase64: string
  name: string
  fileExtension: string
  documentId: string
}

export async function createAndSendEnvelope(params: {
  emailSubject: string
  emailBlurb?: string  // Body text shown in the signing email
  documents: EnvelopeDocument[]
  signers: EnvelopeRecipient[]
  ccRecipients?: { email: string; name: string; recipientId: string; routingOrder: string }[]
  status?: 'sent' | 'created'  // 'created' = draft, 'sent' = send immediately
}): Promise<{ envelopeId: string; uri: string; status: string }> {
  const auth = await getValidAccessToken()
  if (!auth) {
    throw new Error('DocuSign not connected. Admin must authorize first.')
  }

  const envelopeDefinition = {
    emailSubject: params.emailSubject,
    ...(params.emailBlurb ? { emailBlurb: params.emailBlurb } : {}),
    documents: params.documents,
    recipients: {
      signers: params.signers,
      carbonCopies: params.ccRecipients || [],
    },
    status: params.status || 'sent',
  }

  const res = await fetch(
    `${auth.baseUri}/restapi/v2.1/accounts/${auth.accountId}/envelopes`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(envelopeDefinition),
    }
  )

  if (!res.ok) {
    const errText = await res.text()
    console.error('DocuSign create envelope failed:', errText)
    throw new Error(`Failed to create DocuSign envelope: ${res.status}`)
  }

  const result = await res.json()
  return {
    envelopeId: result.envelopeId,
    uri: result.uri,
    status: result.status,
  }
}

// ============================================================================
// Envelope — Get Status
// ============================================================================

export async function getEnvelopeStatus(envelopeId: string): Promise<{
  status: string
  recipients?: any
}> {
  const auth = await getValidAccessToken()
  if (!auth) throw new Error('DocuSign not connected')

  const res = await fetch(
    `${auth.baseUri}/restapi/v2.1/accounts/${auth.accountId}/envelopes/${envelopeId}`,
    {
      headers: { 'Authorization': `Bearer ${auth.accessToken}` },
    }
  )

  if (!res.ok) throw new Error(`Failed to get envelope status: ${res.status}`)
  return res.json()
}

// ============================================================================
// Envelope — Void
// ============================================================================

export async function voidEnvelope(envelopeId: string, reason: string): Promise<void> {
  const auth = await getValidAccessToken()
  if (!auth) throw new Error('DocuSign not connected')

  const res = await fetch(
    `${auth.baseUri}/restapi/v2.1/accounts/${auth.accountId}/envelopes/${envelopeId}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'voided', voidedReason: reason }),
    }
  )

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Failed to void envelope: ${errText}`)
  }
}

// ============================================================================
// Envelope — Download Signed Document
// ============================================================================

export async function downloadSignedDocument(envelopeId: string, documentId: string): Promise<Buffer> {
  const auth = await getValidAccessToken()
  if (!auth) throw new Error('DocuSign not connected')

  const res = await fetch(
    `${auth.baseUri}/restapi/v2.1/accounts/${auth.accountId}/envelopes/${envelopeId}/documents/${documentId}`,
    {
      headers: { 'Authorization': `Bearer ${auth.accessToken}` },
    }
  )

  if (!res.ok) throw new Error(`Failed to download document: ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
