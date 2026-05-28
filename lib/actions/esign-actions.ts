'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { createAndSendEnvelope, isDocuSignConnected, voidEnvelope } from '@/lib/docusign'
import { logAuditEvent } from '@/lib/audit'
import { generateCpaDocx, generateIdpDocx, generateBcaDocx, generateCpaAmendmentDocx, generateRemediationIdpDocx } from '@/lib/contract-docx'
import { getChargeDays } from '@/lib/calculations'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  SETTLEMENT_PERIOD_DAYS,
  LATE_INTEREST_GRACE_DAYS_FROM_CLOSING,
  LATE_INTEREST_RATE_PER_ANNUM,
  BROKERAGE_LATE_STRIKE_THRESHOLD,
  BROKERAGE_BUMPED_SETTLEMENT_DAYS,
} from '@/lib/constants'

// Callers consume specific shapes via assertion; using any preserves call-site compatibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionResult = { success: boolean; error?: string; data?: any }

// ============================================================================
// Helpers
// ============================================================================

import type { User, SupabaseClient } from '@supabase/supabase-js'

async function getAuthenticatedAdmin(): Promise<{ error?: string; user?: User; supabase: SupabaseClient }> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return { error: 'Authentication failed', supabase }

  const serviceClient = createServiceRoleClient()
  const { data: profile } = await serviceClient
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !['firm_funds_admin', 'super_admin'].includes(profile.role)) {
    return { error: 'Unauthorized — admin only', supabase }
  }

  return { user, supabase: serviceClient }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
}

// ============================================================================
// Get DocuSign Connection Status (for UI)
// ============================================================================

export async function getDocuSignStatus(): Promise<{ connected: boolean; consentUrl?: string }> {
  const connected = await isDocuSignConnected()
  if (!connected) {
    // The connect route generates a one-time CSRF state cookie before
    // redirecting to DocuSign. Linking directly to the DocuSign auth URL
    // would skip that step and leave the admin vulnerable to OAuth CSRF.
    if (!process.env.DOCUSIGN_INTEGRATION_KEY) {
      return { connected: false }
    }
    return { connected: false, consentUrl: '/api/docusign/connect' }
  }
  return { connected: true }
}

// ============================================================================
// Send Deal for E-Signature
// ============================================================================

export async function sendForSignature(dealId: string): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Check DocuSign connection
    const connected = await isDocuSignConnected()
    if (!connected) {
      return { success: false, error: 'DocuSign is not connected. Go to Admin Settings to authorize.' }
    }

    // Fetch deal with agent and brokerage data
    const { data: deal, error: dealErr } = await supabase
      .from('deals')
      .select('*, agent:agents(*, brokerage:brokerages(*))')
      .eq('id', dealId)
      .single()

    if (dealErr || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    if (deal.status !== 'approved') {
      return { success: false, error: 'Deal must be approved before sending for signature' }
    }

    const agent = deal.agent
    const brokerage = agent?.brokerage

    if (!agent || !brokerage) {
      return { success: false, error: 'Deal is missing agent or brokerage data' }
    }

    if (!agent.email) {
      return { success: false, error: 'Agent has no email address' }
    }

    // Check for existing unsigned envelopes
    const { data: existingEnvelopes } = await supabase
      .from('esignature_envelopes')
      .select('*')
      .eq('deal_id', dealId)
      .in('status', ['sent', 'delivered'])

    if (existingEnvelopes && existingEnvelopes.length > 0) {
      return { success: false, error: 'This deal already has pending signature requests. Void them first if you need to resend.' }
    }

    // Optimistic-lock claim: bump the deal's version before spending time on
    // DocuSign API calls. If a parallel sendForSignature call (or any other
    // mutation) lands first, this CAS fails and we bail out cleanly instead
    // of creating duplicate envelopes. The version-bump trigger from
    // migration 083 increments deal.version atomically on every UPDATE.
    const initialVersion = (deal as { version?: number }).version
    if (typeof initialVersion === 'number') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service-role supabase client supplies a relaxed typing for select chains
      const { data: claimed, error: claimErr } = await (supabase as any)
        .from('deals')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', dealId)
        .eq('status', 'approved')
        .eq('version', initialVersion)
        .select('id')
        .maybeSingle()
      if (claimErr || !claimed) {
        return { success: false, error: 'This deal was updated by another user while you were sending it for signature. Please refresh and try again.' }
      }
    }


    // Build contract data
    const agentName = `${agent.first_name} ${agent.last_name}`
    const today = new Date().toISOString().split('T')[0]

    // Use the deal's snapshotted settlement window if funded; otherwise fall
    // back to the brokerage's current effective settings (handled via the
    // already-saved settlement_period_fee).
    const dealSettlementDays = deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS

    // Placeholder values for contract merge fields
    const contractData: Record<string, string> = {
      '{{AGREEMENT_DATE}}': formatDate(today),
      '{{AGENT_FULL_LEGAL_NAME}}': agentName,
      '{{FACE_VALUE}}': formatCurrency(deal.net_commission),
      '{{PURCHASE_DISCOUNT}}': formatCurrency(deal.discount_fee),
      '{{SETTLEMENT_PERIOD_FEE}}': formatCurrency(deal.settlement_period_fee || 0),
      '{{TOTAL_FEES}}': formatCurrency((deal.discount_fee || 0) + (deal.settlement_period_fee || 0)),
      // The CPA's printed discount calculation must reconcile with what is
      // actually charged. effectiveDays = getChargeDays(days_until_closing) =
      // days_until_closing - 1 + RETURN_PROCESSING_DAYS. Article 3.2's text
      // describes the period as "from the day following the Funding Date to
      // the day before the Expected Closing Date" so the count matches the
      // charged days (closing day itself is not charged).
      '{{NUMBER_OF_DAYS}}': deal.days_until_closing
        ? getChargeDays(deal.days_until_closing).toString()
        : 'N/A',
      '{{SETTLEMENT_PERIOD_DAYS}}': String(dealSettlementDays),
      '{{LATE_INTEREST_GRACE_DAYS}}': String(LATE_INTEREST_GRACE_DAYS_FROM_CLOSING),
      '{{LATE_STRIKE_THRESHOLD}}': String(BROKERAGE_LATE_STRIKE_THRESHOLD),
      '{{BUMPED_SETTLEMENT_DAYS}}': String(BROKERAGE_BUMPED_SETTLEMENT_DAYS),
      '{{DISCOUNT_RATE}}': `$${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day`,
      '{{PURCHASE_PRICE}}': formatCurrency(deal.advance_amount),
      '{{PROPERTY_ADDRESS}}': deal.property_address,
      '{{MLS_NUMBER}}': 'See APS',
      '{{EXPECTED_CLOSING_DATE}}': formatDate(deal.closing_date),
      '{{DUE_DATE}}': deal.due_date ? formatDate(deal.due_date) : `Closing Date + ${dealSettlementDays} days`,
      '{{LATE_INTEREST_RATE}}': `${(LATE_INTEREST_RATE_PER_ANNUM * 100).toFixed(0)}%`,
      '{{BROKERAGE_LEGAL_NAME}}': brokerage.name,
      '{{BROKERAGE_ADDRESS}}': [brokerage.address, brokerage.city, brokerage.province, brokerage.postal_code].filter(Boolean).join(', ') || 'On file',
      '{{BROKER_OF_RECORD}}': brokerage.broker_of_record_name || 'On file',
      '{{BROKERAGE_REFERRAL_FEE}}': formatCurrency(deal.brokerage_referral_fee),
      '{{BROKERAGE_SPLIT}}': (deal.brokerage_split_pct || 0).toFixed(1),
      '{{GROSS_COMMISSION_RATE}}': 'See Trade Record',
      '{{GROSS_COMMISSION_AMOUNT}}': formatCurrency(deal.gross_commission),
      '{{RECO_REGISTRATION_NUMBER}}': agent.reco_number || 'On file',
      '{{AGENT_EMAIL}}': agent.email,
      '{{AGENT_PHONE}}': agent.phone || 'On file',
      '{{AGENT_ADDRESS}}': [agent.address_street, agent.address_city, agent.address_province, agent.address_postal_code].filter(Boolean).join(', ') || 'On file',
      '{{SIGNATURE_DATE}}': '',  // DocuSign will fill this
      '{{DIRECTED_AMOUNT}}': formatCurrency(deal.net_commission),
      // Banking info — agent
      '{{AGENT_BANK_NAME}}': 'On file',
      '{{AGENT_TRANSIT}}': agent.bank_transit_number || 'On file',
      '{{AGENT_ACCOUNT}}': agent.bank_account_number || 'On file',
      '{{AGENT_ACCOUNT_HOLDER}}': agentName,
      // Purchaser banking (Firm Funds — placeholder until banking is set up)
      '{{PURCHASER_BANK_NAME}}': 'On file with Firm Funds',
      '{{PURCHASER_TRANSIT}}': 'On file',
      '{{PURCHASER_ACCOUNT}}': 'On file',
      // Brokerage Cooperation Agreement date (dynamic — uses actual signed date if available)
      '{{BCA_DATE}}': brokerage.bca_signed_at ? formatDate(brokerage.bca_signed_at.split('T')[0]) : 'On file',
      // Property details — some we don't have yet
      '{{BUYER_NAMES}}': 'See APS',
      '{{CLIENT_NAMES}}': 'See APS',
      '{{APS_DATE}}': 'See APS',
      '{{PROPERTY_PURCHASE_PRICE}}': 'See APS',
      '{{LISTING_OR_COOPERATING}}': 'See Trade Record',
      '{{DEPOSIT_BROKERAGE}}': 'See APS',
      '{{DEPOSIT_COOP}}': 'N/A',
    }

    // Generate .docx contracts with proper page numbers, headers, footers
    const cpaBuffer = await generateCpaDocx(contractData)
    const idpBuffer = await generateIdpDocx(contractData)

    const cpaBase64 = cpaBuffer.toString('base64')
    const idpBase64 = idpBuffer.toString('base64')

    // Create envelope with both documents
    const agentFirstName = agent.first_name || 'there'
    const result = await createAndSendEnvelope({
      emailSubject: `Firm Funds — Signature Required: ${deal.property_address}`,
      emailBlurb: `Hi ${agentFirstName},\n\nFirm Funds Inc. has prepared your Commission Purchase Agreement and Irrevocable Direction to Pay for the property at ${deal.property_address}.\n\nPlease review and sign both documents at your earliest convenience. If you have any questions, reply to this email or contact us at bud@firmfunds.ca.\n\nThank you for choosing Firm Funds.\n\n— The Firm Funds Team`,
      documents: [
        {
          documentBase64: cpaBase64,
          name: 'Commission Purchase Agreement',
          fileExtension: 'docx',
          documentId: '1',
        },
        {
          documentBase64: idpBase64,
          name: 'Irrevocable Direction to Pay',
          fileExtension: 'docx',
          documentId: '2',
        },
      ],
      signers: [
        {
          email: agent.email,
          name: agentName,
          recipientId: '1',
          routingOrder: '1',
          tabs: {
            signHereTabs: [
              // CPA signature — anchored to the text in the HTML
              { documentId: '1', anchorString: 'Signature: /sig1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
              // IDP signature
              { documentId: '2', anchorString: 'Signature: /sig1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
            dateSignedTabs: [
              { documentId: '1', anchorString: 'Date Signed: /dat1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
              { documentId: '2', anchorString: 'Date Signed: /dat1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
            initialHereTabs: [
              // CPA — initials on pages 1-4 (page 5 is signature page, no initials needed)
              { documentId: '1', anchorString: '/ini1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
              // IDP — initials on page 1 (page 2 is signature page)
              { documentId: '2', anchorString: '/ini1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
          },
        },
      ],
      // CC the brokerage admin and broker of record
      ccRecipients: [
        ...(brokerage.broker_of_record_email ? [{
          email: brokerage.broker_of_record_email,
          name: brokerage.broker_of_record_name || brokerage.name,
          recipientId: '2',
          routingOrder: '2',
        }] : []),
        ...(brokerage.email && brokerage.email !== brokerage.broker_of_record_email ? [{
          email: brokerage.email,
          name: brokerage.name + ' (Admin)',
          recipientId: '3',
          routingOrder: '2',
        }] : []),
      ],
      status: 'sent',
    })

    // Save envelope records to database
    const envelopeRecords = [
      {
        deal_id: dealId,
        envelope_id: result.envelopeId,
        document_type: 'cpa' as const,
        status: 'sent' as const,
        agent_signer_status: 'sent' as const,
        sent_by: user.id,
        envelope_uri: result.uri,
      },
      {
        deal_id: dealId,
        envelope_id: result.envelopeId,
        document_type: 'idp' as const,
        status: 'sent' as const,
        agent_signer_status: 'sent' as const,
        sent_by: user.id,
        envelope_uri: result.uri,
      },
    ]

    const { error: insertErr } = await supabase
      .from('esignature_envelopes')
      .insert(envelopeRecords)

    if (insertErr) {
      // Finding 31/32: unique constraint violation = another concurrent send
      // beat us to the active envelope slot; void the duplicate envelope we
      // just created in DocuSign and return a friendly error. Any other
      // insert failure: same cleanup so we don't leak a sent envelope that
      // can't be tracked.
      console.error('Failed to save envelope records:', insertErr.message)
      try {
        await voidEnvelope(result.envelopeId, 'cleanup after record-save failure')
      } catch (voidErr: unknown) {
        const _msg = voidErr instanceof Error ? voidErr.message : "Unknown error"
        console.error('Failed to void DocuSign envelope during cleanup:', _msg)
      }
      const isUniqueViolation = (insertErr as { code?: string }).code === '23505'
      return {
        success: false,
        error: isUniqueViolation
          ? 'An active envelope already exists for this deal.'
          : 'Failed to record envelope; DocuSign envelope was voided.',
      }
    }

    await logAuditEvent({
      action: 'esignature.sent',
      entityType: 'deal',
      entityId: dealId,
      metadata: { envelopeId: result.envelopeId, agentEmail: agent.email, agentName },
    })

    return { success: true, data: { envelopeId: result.envelopeId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('sendForSignature error:', _msg)
    return { success: false, error: _msg || 'Failed to send for signature' }
  }
}

// ============================================================================
// Void Existing Envelope
// ============================================================================

export async function voidDealEnvelopes(dealId: string, reason: string): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: envelopes } = await supabase
      .from('esignature_envelopes')
      .select('*')
      .eq('deal_id', dealId)
      .in('status', ['sent', 'delivered'])

    if (!envelopes || envelopes.length === 0) {
      return { success: false, error: 'No active envelopes found for this deal' }
    }

    // Finding 33: capture envelope IDs from the initial SELECT so the UPDATE
    // below only touches the rows we actually voided in DocuSign, not any new
    // envelopes a concurrent send may have inserted in the meantime.
    // Finding 34: track void successes vs failures separately so partial
    // failures don't leave DB rows mismarked or DocuSign envelopes orphaned.
    const targetIds: string[] = []
    const seen = new Set<string>()
    for (const env of envelopes) {
      const eid = (env as { envelope_id: string }).envelope_id
      if (!seen.has(eid)) {
        seen.add(eid)
        targetIds.push(eid)
      }
    }

    const voided: string[] = []
    const failed: { envelopeId: string; error: string }[] = []
    for (const eid of targetIds) {
      try {
        await voidEnvelope(eid, reason)
        voided.push(eid)
      } catch (voidErr: unknown) {
        const voidMessage = voidErr instanceof Error ? voidErr.message : 'Unknown void error'
        failed.push({ envelopeId: eid, error: voidMessage })
      }
    }

    // Update only the records whose DocuSign side actually voided.
    if (voided.length > 0) {
      await supabase
        .from('esignature_envelopes')
        .update({
          status: 'voided',
          voided_at: new Date().toISOString(),
          void_reason: reason,
        })
        .eq('deal_id', dealId)
        .in('envelope_id', voided)
        .in('status', ['sent', 'delivered'])
    }

    await logAuditEvent({
      action: 'esignature.voided',
      entityType: 'deal',
      entityId: dealId,
      metadata: { reason, envelopeIds: voided, failedEnvelopeIds: failed },
    })

    if (failed.length > 0) {
      return {
        success: voided.length > 0,
        error: `Voided ${voided.length} envelope(s); failed to void ${failed.length}: ${failed.map(f => f.envelopeId).join(', ')}`,
        data: { voided, failed },
      }
    }

    return { success: true, data: { voided } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('voidDealEnvelopes error:', _msg)
    return { success: false, error: _msg || 'Failed to void envelopes' }
  }
}

// ============================================================================
// Get Signature Status for a Deal
// ============================================================================

export async function getDealSignatureStatus(dealId: string): Promise<ActionResult> {
  // Authorization (Finding 11): previously unauthenticated. Any logged-in
  // user could enumerate envelopes across the platform; envelope IDs are the
  // secret used to spoof the (now HMAC-verified) DocuSign webhook.
  const { createClient: createUserClient } = await import('@/lib/supabase/server')
  const userSupabase = await createUserClient()
  const { data: { user } } = await userSupabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const supabase = createServiceRoleClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, agent_id, brokerage_id')
    .eq('id', user.id)
    .single()
  if (!profile) return { success: false, error: 'Profile not found' }

  const isAdmin = ['super_admin', 'firm_funds_admin'].includes(profile.role)
  if (!isAdmin) {
    const { data: deal } = await supabase
      .from('deals')
      .select('agent_id, brokerage_id')
      .eq('id', dealId)
      .single()
    if (!deal) return { success: false, error: 'Deal not found' }
    const isOwner =
      (profile.role === 'agent' && profile.agent_id === deal.agent_id) ||
      (profile.role === 'brokerage_admin' && profile.brokerage_id === deal.brokerage_id)
    if (!isOwner) return { success: false, error: 'Not authorized for this deal' }
  }

  const { data: envelopes, error } = await supabase
    .from('esignature_envelopes')
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: false })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, data: envelopes || [] }
}

// Contract generators moved to lib/contract-docx.ts (.docx format with proper page numbers, headers, footers)

// ============================================================================
// BCA — Send Brokerage Cooperation Agreement for Signature
// ============================================================================

export async function sendBcaForSignature(brokerageId: string): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Check DocuSign connection
    const connected = await isDocuSignConnected()
    if (!connected) {
      return { success: false, error: 'DocuSign is not connected. Go to Admin Settings to authorize.' }
    }

    // Fetch brokerage data
    const { data: brokerage, error: brokErr } = await supabase
      .from('brokerages')
      .select('*')
      .eq('id', brokerageId)
      .single()

    if (brokErr || !brokerage) {
      return { success: false, error: 'Brokerage not found' }
    }

    if (!brokerage.broker_of_record_email) {
      return { success: false, error: 'Brokerage has no Broker of Record email. Add it first.' }
    }

    if (!brokerage.broker_of_record_name) {
      return { success: false, error: 'Brokerage has no Broker of Record name. Add it first.' }
    }

    // Check for existing unsigned BCA envelopes
    const { data: existingEnvelopes } = await supabase
      .from('esignature_envelopes')
      .select('*')
      .eq('brokerage_id', brokerageId)
      .eq('document_type', 'bca')
      .in('status', ['sent', 'delivered'])

    if (existingEnvelopes && existingEnvelopes.length > 0) {
      return { success: false, error: 'This brokerage already has a pending BCA signature request. Void it first if you need to resend.' }
    }

    // Build BCA contract data
    const today = new Date().toISOString().split('T')[0]

    const referralPct = brokerage.referral_fee_percentage
    const referralDisplay = referralPct !== null && referralPct !== undefined
      ? `${(referralPct * 100).toFixed(0)}%`
      : '20%'

    const contractData: Record<string, string> = {
      '{{AGREEMENT_DATE}}': formatDate(today),
      '{{BROKERAGE_LEGAL_NAME}}': brokerage.name,
      '{{BROKERAGE_ADDRESS}}': [brokerage.address, brokerage.city, brokerage.province, brokerage.postal_code].filter(Boolean).join(', ') || 'On file',
      '{{BROKER_OF_RECORD}}': brokerage.broker_of_record_name,
      '{{BROKERAGE_EMAIL}}': brokerage.email,
      '{{BROKERAGE_PHONE}}': brokerage.phone || 'On file',
      '{{REFERRAL_FEE_PCT}}': referralDisplay,
      '{{SETTLEMENT_PERIOD_DAYS}}': String(SETTLEMENT_PERIOD_DAYS),
      '{{LATE_STRIKE_THRESHOLD}}': String(BROKERAGE_LATE_STRIKE_THRESHOLD),
      '{{BUMPED_SETTLEMENT_DAYS}}': String(BROKERAGE_BUMPED_SETTLEMENT_DAYS),
      '{{LATE_INTEREST_GRACE_DAYS}}': String(LATE_INTEREST_GRACE_DAYS_FROM_CLOSING),
      '{{DISCOUNT_RATE}}': `$${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day`,
      '{{SIGNATURE_DATE}}': '', // DocuSign fills this
    }

    // Generate BCA .docx
    const bcaBuffer = await generateBcaDocx(contractData)
    const bcaBase64 = bcaBuffer.toString('base64')

    // Create envelope — signer is the Broker of Record
    const borFirstName = brokerage.broker_of_record_name?.split(' ')[0] || 'there'
    const result = await createAndSendEnvelope({
      emailSubject: `Firm Funds — Brokerage Cooperation Agreement: ${brokerage.name}`,
      emailBlurb: `Hi ${borFirstName},\n\nFirm Funds Inc. has prepared a Brokerage Cooperation Agreement for ${brokerage.name}. This agreement establishes the partnership between your brokerage and Firm Funds for our Commission Purchase Program.\n\nPlease review and sign at your earliest convenience. If you have any questions, reply to this email or contact us at bud@firmfunds.ca.\n\nThank you,\n\n— The Firm Funds Team`,
      documents: [
        {
          documentBase64: bcaBase64,
          name: 'Brokerage Cooperation Agreement',
          fileExtension: 'docx',
          documentId: '1',
        },
      ],
      signers: [
        {
          email: brokerage.broker_of_record_email,
          name: brokerage.broker_of_record_name,
          recipientId: '1',
          routingOrder: '1',
          tabs: {
            signHereTabs: [
              { documentId: '1', anchorString: 'Signature: /sig1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
            dateSignedTabs: [
              { documentId: '1', anchorString: 'Date Signed: /dat1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
            initialHereTabs: [
              { documentId: '1', anchorString: '/ini1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
          },
        },
      ],
      // CC the brokerage admin email + Firm Funds admin
      ccRecipients: [
        ...(brokerage.email && brokerage.email !== brokerage.broker_of_record_email ? [{
          email: brokerage.email,
          name: brokerage.name + ' (Admin)',
          recipientId: '2',
          routingOrder: '2',
        }] : []),
      ],
      status: 'sent',
    })

    // Save envelope record — uses brokerage_id, NOT deal_id
    const { error: insertErr } = await supabase
      .from('esignature_envelopes')
      .insert({
        brokerage_id: brokerageId,
        envelope_id: result.envelopeId,
        document_type: 'bca' as const,
        status: 'sent' as const,
        agent_signer_status: 'sent' as const, // re-used field: tracks BOR signer status
        sent_by: user.id,
        envelope_uri: result.uri,
      })

    if (insertErr) {
      // Finding 32: void the DocuSign envelope if we couldn't track it, so the
      // duplicate-envelope guard above remains the source of truth.
      console.error('Failed to save BCA envelope record:', insertErr.message)
      try {
        await voidEnvelope(result.envelopeId, 'cleanup after record-save failure')
      } catch (voidErr: unknown) {
        const _msg = voidErr instanceof Error ? voidErr.message : "Unknown error"
        console.error('Failed to void DocuSign BCA envelope during cleanup:', _msg)
      }
      return { success: false, error: 'Failed to record BCA envelope; DocuSign envelope was voided.' }
    }

    await logAuditEvent({
      action: 'bca.sent',
      entityType: 'brokerage',
      entityId: brokerageId,
      metadata: {
        envelopeId: result.envelopeId,
        brokerageName: brokerage.name,
        brokerOfRecord: brokerage.broker_of_record_name,
        brokerOfRecordEmail: brokerage.broker_of_record_email,
      },
    })

    return { success: true, data: { envelopeId: result.envelopeId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('sendBcaForSignature error:', _msg)
    return { success: false, error: _msg || 'Failed to send BCA for signature' }
  }
}

// ============================================================================
// BCA — Void Existing BCA Envelope
// ============================================================================

export async function voidBcaEnvelope(brokerageId: string, reason: string): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: envelopes } = await supabase
      .from('esignature_envelopes')
      .select('*')
      .eq('brokerage_id', brokerageId)
      .eq('document_type', 'bca')
      .in('status', ['sent', 'delivered'])

    if (!envelopes || envelopes.length === 0) {
      return { success: false, error: 'No active BCA envelopes found for this brokerage' }
    }

    // Findings 33/34: capture envelope IDs up front, void each one
    // independently, and only mark the rows whose DocuSign void succeeded.
    const targetIds: string[] = []
    const seen = new Set<string>()
    for (const env of envelopes) {
      const eid = (env as { envelope_id: string }).envelope_id
      if (!seen.has(eid)) {
        seen.add(eid)
        targetIds.push(eid)
      }
    }

    const voided: string[] = []
    const failed: { envelopeId: string; error: string }[] = []
    for (const eid of targetIds) {
      try {
        await voidEnvelope(eid, reason)
        voided.push(eid)
      } catch (voidErr: unknown) {
        const voidMessage = voidErr instanceof Error ? voidErr.message : 'Unknown void error'
        failed.push({ envelopeId: eid, error: voidMessage })
      }
    }

    if (voided.length > 0) {
      await supabase
        .from('esignature_envelopes')
        .update({
          status: 'voided',
          voided_at: new Date().toISOString(),
          void_reason: reason,
        })
        .eq('brokerage_id', brokerageId)
        .eq('document_type', 'bca')
        .in('envelope_id', voided)
        .in('status', ['sent', 'delivered'])
    }

    await logAuditEvent({
      action: 'bca.voided',
      entityType: 'brokerage',
      entityId: brokerageId,
      metadata: { reason, envelopeIds: voided, failedEnvelopeIds: failed },
    })

    if (failed.length > 0) {
      return {
        success: voided.length > 0,
        error: `Voided ${voided.length} envelope(s); failed to void ${failed.length}: ${failed.map(f => f.envelopeId).join(', ')}`,
        data: { voided, failed },
      }
    }

    return { success: true, data: { voided } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('voidBcaEnvelope error:', _msg)
    return { success: false, error: _msg || 'Failed to void BCA envelope' }
  }
}

// ============================================================================
// BCA — Get Signature Status
// ============================================================================

export async function getBcaSignatureStatus(brokerageId: string): Promise<ActionResult> {
  // Authorization (Finding 11): admin OR a brokerage_admin of the same brokerage.
  const { createClient: createUserClient } = await import('@/lib/supabase/server')
  const userSupabase = await createUserClient()
  const { data: { user } } = await userSupabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const supabase = createServiceRoleClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, brokerage_id')
    .eq('id', user.id)
    .single()
  if (!profile) return { success: false, error: 'Profile not found' }

  const isAdmin = ['super_admin', 'firm_funds_admin'].includes(profile.role)
  const isBrokerageOwner = profile.role === 'brokerage_admin' && profile.brokerage_id === brokerageId
  if (!isAdmin && !isBrokerageOwner) {
    return { success: false, error: 'Not authorized for this brokerage' }
  }

  const { data: envelopes, error } = await supabase
    .from('esignature_envelopes')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .eq('document_type', 'bca')
    .order('created_at', { ascending: false })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, data: envelopes || [] }
}

// ============================================================================
// Send Amended CPA for Signature (after closing date amendment approved)
// ============================================================================

export async function sendAmendedCpaForSignature(dealId: string, amendmentId: string): Promise<ActionResult> {
  // Finding 29: gate this server action behind admin auth like its peers.
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const connected = await isDocuSignConnected()
    if (!connected) {
      return { success: false, error: 'DocuSign is not connected' }
    }

    const { data: deal } = await supabase
      .from('deals')
      .select('*, agent:agents(*, brokerage:brokerages(*))')
      .eq('id', dealId)
      .single()

    if (!deal) return { success: false, error: 'Deal not found' }

    const { data: amendment } = await supabase
      .from('closing_date_amendments')
      .select('*')
      .eq('id', amendmentId)
      .single()

    if (!amendment) return { success: false, error: 'Amendment not found' }

    const agent = deal.agent
    if (!agent?.email) return { success: false, error: 'Agent has no email address' }

    const agentName = `${agent.first_name} ${agent.last_name}`

    const newDiscount = amendment.new_discount_fee || 0
    const newSettlementFee = amendment.new_settlement_period_fee || 0
    const newPurchasePrice = amendment.new_advance_amount || 0
    const oldPurchasePrice = amendment.old_advance_amount || 0
    const oldDiscount = amendment.old_discount_fee || 0
    const oldSettlementFee = amendment.old_settlement_period_fee || 0
    const feeAdjustment = amendment.fee_adjustment_amount || 0
    const scenario = amendment.adjustment_scenario || 'approved_recalc'

    const fundingDate = deal.funding_date || new Date().toISOString().split('T')[0]
    // Raw days between funding and new closing; the printed value is the
    // chargeable subset (getChargeDays), matching how Article 3.2 is now worded.
    const rawDaysToClosing = Math.ceil((new Date(amendment.new_closing_date + 'T00:00:00Z').getTime() - new Date(fundingDate + 'T00:00:00Z').getTime()) / (1000 * 60 * 60 * 24))
    const newDaysNum = getChargeDays(rawDaysToClosing)

    const contractData: Record<string, string> = {
      '{{AMENDMENT_DATE}}': formatDate(new Date().toISOString().split('T')[0]),
      '{{AGENT_FULL_LEGAL_NAME}}': agentName,
      '{{RECO_REGISTRATION_NUMBER}}': agent.reco_number || 'On file',
      '{{PROPERTY_ADDRESS}}': deal.property_address,
      '{{ORIGINAL_CPA_DATE}}': deal.funding_date ? formatDate(deal.funding_date) : 'original date',
      '{{OLD_CLOSING_DATE}}': formatDate(amendment.old_closing_date),
      '{{NEW_CLOSING_DATE}}': formatDate(amendment.new_closing_date),
      '{{OLD_DUE_DATE}}': amendment.old_due_date ? formatDate(amendment.old_due_date) : 'N/A',
      '{{NEW_DUE_DATE}}': amendment.new_due_date ? formatDate(amendment.new_due_date) : 'N/A',
      '{{FACE_VALUE}}': formatCurrency(deal.net_commission),
      '{{OLD_PURCHASE_DISCOUNT}}': formatCurrency(oldDiscount),
      '{{NEW_PURCHASE_DISCOUNT}}': formatCurrency(newDiscount),
      '{{OLD_SETTLEMENT_PERIOD_FEE}}': formatCurrency(oldSettlementFee),
      '{{NEW_SETTLEMENT_PERIOD_FEE}}': formatCurrency(newSettlementFee),
      '{{OLD_PURCHASE_PRICE}}': formatCurrency(oldPurchasePrice),
      '{{NEW_PURCHASE_PRICE}}': formatCurrency(newPurchasePrice),
      '{{NEW_NUMBER_OF_DAYS}}': newDaysNum.toString(),
      '{{SCENARIO}}': scenario,
      '{{FEE_ADJUSTMENT_DISPLAY}}': formatCurrency(Math.abs(feeAdjustment)),
      '{{DISCOUNT_RATE}}': `$${DISCOUNT_RATE_PER_1000_PER_DAY.toFixed(2)} per $1,000 per day`,
      '{{SETTLEMENT_PERIOD_DAYS}}': String(deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS),
      '{{LATE_INTEREST_GRACE_DAYS}}': String(LATE_INTEREST_GRACE_DAYS_FROM_CLOSING),
    }

    const amendmentBuffer = await generateCpaAmendmentDocx(contractData)
    const amendmentBase64 = amendmentBuffer.toString('base64')

    const brokerage = agent.brokerage

    const result = await createAndSendEnvelope({
      emailSubject: `Firm Funds — Closing Date Amendment Signature Required: ${deal.property_address}`,
      emailBlurb: `Hi ${agent.first_name || 'there'},\n\nThe closing date for your deal at ${deal.property_address} has been updated. Firm Funds Inc. has prepared a Commission Purchase Agreement Amendment that reflects the new terms.\n\nPlease review and sign at your earliest convenience. If you have any questions, reply to this email or contact us at bud@firmfunds.ca.\n\nThank you,\n\n— The Firm Funds Team`,
      documents: [
        {
          documentBase64: amendmentBase64,
          name: 'CPA Amendment — Closing Date Change',
          fileExtension: 'docx',
          documentId: '1',
        },
      ],
      signers: [
        {
          email: agent.email,
          name: agentName,
          recipientId: '1',
          routingOrder: '1',
          tabs: {
            signHereTabs: [
              { documentId: '1', anchorString: 'Signature: /sig1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
            dateSignedTabs: [
              { documentId: '1', anchorString: 'Date Signed: /dat1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
            initialHereTabs: [
              { documentId: '1', anchorString: '/ini1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
            ],
          },
        },
      ],
      ccRecipients: [
        ...(brokerage?.broker_of_record_email ? [{
          email: brokerage.broker_of_record_email,
          name: brokerage.broker_of_record_name || brokerage.name,
          recipientId: '2',
          routingOrder: '2',
        }] : []),
      ],
      status: 'sent',
    })

    const { error: insertErr } = await supabase
      .from('esignature_envelopes')
      .insert({
        deal_id: dealId,
        envelope_id: result.envelopeId,
        document_type: 'cpa' as const,
        status: 'sent' as const,
        agent_signer_status: 'sent' as const,
        sent_by: user.id,
        envelope_uri: result.uri,
      })

    if (insertErr) {
      // Finding 32: void the DocuSign envelope if we couldn't track it.
      console.error('Failed to save amendment envelope record:', insertErr.message)
      try {
        await voidEnvelope(result.envelopeId, 'cleanup after record-save failure')
      } catch (voidErr: unknown) {
        const _msg = voidErr instanceof Error ? voidErr.message : "Unknown error"
        console.error('Failed to void DocuSign amendment envelope during cleanup:', _msg)
      }
      const isUniqueViolation = (insertErr as { code?: string }).code === '23505'
      return {
        success: false,
        error: isUniqueViolation
          ? 'An active envelope already exists for this deal.'
          : 'Failed to record amendment envelope; DocuSign envelope was voided.',
      }
    }

    await logAuditEvent({
      action: 'amendment.envelope_sent',
      entityType: 'deal',
      entityId: dealId,
      metadata: {
        envelope_id: result.envelopeId,
        amendment_id: amendmentId,
      },
    })

    return { success: true, data: { envelopeId: result.envelopeId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Send amended CPA error:', _msg)
    return { success: false, error: _msg || 'Failed to send amended CPA' }
  }
}

// ============================================================================
// Remediation IDP — generate, send via DocuSign, record envelope
//
// remediationDealId: the admin-entered `remediation_deals` record that
// captures the property, brokerage, expected commission, and directed amount.
// The IDP is generated entirely from that record (Firm Funds doesn't own the
// future commission — it lives at the brokerage).
// ============================================================================

export async function sendRemediationIdpForSignature(input: {
  remediationDealId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const connected = await isDocuSignConnected()
    if (!connected) {
      return { success: false, error: 'DocuSign is not connected. Go to Admin Settings to authorize.' }
    }

    const { data: rem, error: remErr } = await supabase
      .from('remediation_deals')
      .select('*, failed_deal:deals!remediation_deals_failed_deal_id_fkey(id, property_address, funding_date, agent_id), agent:agents(*)')
      .eq('id', input.remediationDealId)
      .single()

    if (remErr || !rem) return { success: false, error: 'Remediation deal not found' }
    if (rem.status !== 'pending') {
      return { success: false, error: `Remediation deal is in status "${rem.status}" — can only send IDP when status is pending` }
    }

    const failedDeal = rem.failed_deal
    const agent = rem.agent
    if (!failedDeal) return { success: false, error: 'Failed deal not found' }
    if (!agent) return { success: false, error: 'Agent not found' }
    if (!agent.email) return { success: false, error: 'Agent has no email address' }
    if (!rem.broker_of_record_email && !rem.brokerage_id) {
      return { success: false, error: 'Either a broker-of-record email or a known brokerage is required to send the IDP' }
    }

    // Prevent duplicate active Remediation IDPs for this remediation deal
    const { data: existing } = await supabase
      .from('esignature_envelopes')
      .select('id, status')
      .eq('remediation_deal_id', rem.id)
      .in('status', ['sent', 'delivered', 'signed'])

    if (existing && existing.length > 0) {
      return { success: false, error: 'An active Remediation IDP already exists for this remediation deal. Void it first to resend.' }
    }

    const directedAmount = Math.round(Number(rem.directed_amount) * 100) / 100
    if (directedAmount <= 0) {
      return { success: false, error: 'Remediation deal has no directed amount to send' }
    }

    // Finding 30: CAS-claim the remediation row from pending -> idp_sent so two
    // concurrent calls cannot both pass the read-then-update gap and spawn
    // duplicate DocuSign envelopes. We revert to pending if envelope creation
    // or record insertion fails below.
    const { data: claimed } = await supabase
      .from('remediation_deals')
      .update({ status: 'idp_sent' })
      .eq('id', input.remediationDealId)
      .eq('status', 'pending')
      .select()
      .maybeSingle()
    if (!claimed) {
      return { success: false, error: 'Remediation already sent or not in pending state' }
    }

    const agentName = `${agent.first_name} ${agent.last_name}`
    const today = new Date().toISOString().split('T')[0]

    const contractData: Record<string, string> = {
      '{{AGREEMENT_DATE}}': formatDate(today),
      '{{AGENT_FULL_LEGAL_NAME}}': agentName,
      '{{RECO_REGISTRATION_NUMBER}}': agent.reco_number || 'On file',
      '{{BROKERAGE_LEGAL_NAME}}': rem.brokerage_legal_name,
      '{{BROKERAGE_ADDRESS}}': rem.brokerage_address || 'On file',
      '{{BROKER_OF_RECORD}}': rem.broker_of_record_name || 'On file',
      '{{OUTSTANDING_BALANCE}}': formatCurrency(directedAmount),
      // Failed deal — establishes the original obligation
      '{{FAILED_DEAL_PROPERTY}}': failedDeal.property_address,
      '{{FAILED_DEAL_DATE}}': failedDeal.funding_date ? formatDate(failedDeal.funding_date) : 'original CPA date',
      // The new commission being assigned (manually entered)
      '{{SOURCE_PROPERTY_ADDRESS}}': rem.property_address,
      '{{SOURCE_MLS_NUMBER}}': rem.mls_number || 'See APS',
      '{{SOURCE_CLOSING_DATE}}': rem.expected_closing_date ? formatDate(rem.expected_closing_date) : 'closing date TBD',
      // Firm Funds banking
      '{{PURCHASER_BANK_NAME}}': 'On file with Firm Funds',
      '{{PURCHASER_TRANSIT}}': 'On file',
      '{{PURCHASER_ACCOUNT}}': 'On file',
    }

    const docBuffer = await generateRemediationIdpDocx(contractData)
    const docBase64 = docBuffer.toString('base64')

    const agentFirstName = agent.first_name || 'there'

    // Finding 30 (cont.): if envelope creation throws, revert CAS so the
    // remediation can be retried instead of being stuck in idp_sent forever.
    let result: Awaited<ReturnType<typeof createAndSendEnvelope>>
    try {
      result = await createAndSendEnvelope({
        emailSubject: `Firm Funds — Remediation Direction to Pay: ${rem.property_address}`,
        emailBlurb: `Hi ${agentFirstName},\n\nUnder your prior Commission Purchase Agreement for ${failedDeal.property_address} (which did not close), you elected to satisfy the outstanding balance of ${formatCurrency(directedAmount)} by assigning your next commission.\n\nFirm Funds Inc. has prepared a Remediation Direction to Pay for the commission earned on your sale of ${rem.property_address}. Please review and sign so your brokerage can remit the commission directly to Firm Funds.\n\nReminder: this is not a new advance — no discount, settlement fee, or referral fee applies. The remittance reduces your outstanding balance.\n\nIf you have any questions, reply to this email or contact us at bud@firmfunds.ca.\n\nThank you,\n\n— The Firm Funds Team`,
        documents: [
          {
            documentBase64: docBase64,
            name: 'Remediation Direction to Pay',
            fileExtension: 'docx',
            documentId: '1',
          },
        ],
        signers: [
          {
            email: agent.email,
            name: agentName,
            recipientId: '1',
            routingOrder: '1',
            tabs: {
              signHereTabs: [
                { documentId: '1', anchorString: 'Signature: /sig1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
              ],
              dateSignedTabs: [
                { documentId: '1', anchorString: 'Date Signed: /dat1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
              ],
              initialHereTabs: [
                { documentId: '1', anchorString: '/ini1/', anchorXOffset: '0', anchorYOffset: '-5', anchorUnits: 'pixels' },
              ],
            },
          },
        ],
        ccRecipients: rem.broker_of_record_email ? [{
          email: rem.broker_of_record_email,
          name: rem.broker_of_record_name || rem.brokerage_legal_name,
          recipientId: '2',
          routingOrder: '2',
        }] : [],
        status: 'sent',
      })
    } catch (envelopeErr: unknown) {
      await supabase
        .from('remediation_deals')
        .update({ status: 'pending' })
        .eq('id', rem.id)
        .eq('status', 'idp_sent')
      throw envelopeErr
    }

    const { error: insertErr } = await supabase
      .from('esignature_envelopes')
      .insert({
        remediation_deal_id: rem.id,
        envelope_id: result.envelopeId,
        document_type: 'remediation_idp' as const,
        status: 'sent' as const,
        agent_signer_status: 'sent' as const,
        sent_by: user.id,
        envelope_uri: result.uri,
      })

    if (insertErr) {
      // Finding 32: if we can't persist the envelope record, void the DocuSign
      // envelope and revert the remediation status, otherwise we end up with
      // a "sent" remediation pointing at no row and the duplicate-envelope
      // guard above can never fire again.
      console.error('Failed to save Remediation IDP envelope record:', insertErr.message)
      try {
        await voidEnvelope(result.envelopeId, 'cleanup after record-save failure')
      } catch (voidErr: unknown) {
        const _msg = voidErr instanceof Error ? voidErr.message : "Unknown error"
        console.error('Failed to void DocuSign envelope during cleanup:', _msg)
      }
      await supabase
        .from('remediation_deals')
        .update({ status: 'pending' })
        .eq('id', rem.id)
        .eq('status', 'idp_sent')
      return { success: false, error: 'Failed to record envelope; DocuSign envelope was voided.' }
    }

    await logAuditEvent({
      action: 'remediation_idp.sent',
      entityType: 'deal',
      entityId: failedDeal.id,
      metadata: {
        envelopeId: result.envelopeId,
        remediationDealId: rem.id,
        sourcePropertyAddress: rem.property_address,
        directedAmount,
        agentEmail: agent.email,
        agentName,
      },
    })

    return { success: true, data: { envelopeId: result.envelopeId, directedAmount } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('sendRemediationIdpForSignature error:', _msg)
    return { success: false, error: _msg || 'Failed to send Remediation IDP' }
  }
}
