'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'

// ============================================================================
// DocuSign Configuration
// ============================================================================

const DOCUSIGN_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY!
const DOCUSIGN_SECRET_KEY = process.env.DOCUSIGN_SECRET_KEY!
const DOCUSIGN_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID!
const DOCUSIGN_AUTH_URL = process.env.DOCUSIGN_AUTH_URL || 'https://account-d.docusign.com'
const DOCUSIGN_BASE_URL = process.env.DOCUSIGN_BASE_URL || 'https://demo.docusign.net/restapi'
const DOCUSIGN_REDIRECT_URI = process.env.DOCUSIGN_REDIRECT_URI || 'http://localhost:3000/api/docusign/callback'

// ============================================================================
// OAuth — Consent URL
// ============================================================================

export async function getConsentUrl(): Promise<string> {
  const scopes = 'signature impersonation'
  return `${DOCUSIGN_AUTH_URL}/oauth/auth?response_type=code&scope=${encodeURIComponent(scopes)}&client_id=${DOCUSIGN_INTEGRATION_KEY}&redirect_uri=${encodeURIComponent(DOCUSIGN_REDIRECT_URI)}`
}

// ============================================================================
// OAuth — Exchange Code for Tokens
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
      redirect_uri: DOCUSIGN_REDIRECT_URI,
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

  const expiresAt = new Date(tokenRow.expires_at)
  const now = new Date()
  const bufferMs = 5 * 60 * 1000 // 5 minutes buffer

  // Token still valid
  if (expiresAt.getTime() - now.getTime() > bufferMs) {
    return {
      accessToken: tokenRow.access_token,
      accountId: tokenRow.account_id,
      baseUri: tokenRow.base_uri,
    }
  }

  // Token expired or about to — refresh it
  try {
    const refreshed = await refreshAccessToken(tokenRow.refresh_token)
    await saveTokens({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_in: refreshed.expires_in,
      token_type: refreshed.token_type,
      account_id: tokenRow.account_id,
      base_uri: tokenRow.base_uri,
    })

    return {
      accessToken: refreshed.access_token,
      accountId: tokenRow.account_id,
      baseUri: tokenRow.base_uri,
    }
  } catch (err) {
    console.error('Failed to refresh DocuSign token — admin needs to re-authorize')
    return null
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
