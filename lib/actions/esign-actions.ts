'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { createAndSendEnvelope, isDocuSignConnected, voidEnvelope, getConsentUrl } from '@/lib/docusign'
import { logAuditEvent } from '@/lib/audit'
import { generateCpaDocx, generateIdpDocx, generateBcaDocx, generateCpaAmendmentDocx } from '@/lib/contract-docx'

type ActionResult = { success: boolean; error?: string; data?: any }

// ============================================================================
// Helpers
// ============================================================================

async function getAuthenticatedAdmin(): Promise<{ error?: string; user?: any; supabase: any }> {
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
    return { connected: false, consentUrl: await getConsentUrl() }
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

    // Build contract data
    const agentName = `${agent.first_name} ${agent.last_name}`
    const today = new Date().toISOString().split('T')[0]

    // Placeholder values for contract merge fields
    const contractData: Record<string, string> = {
      '{{AGREEMENT_DATE}}': formatDate(today),
      '{{AGENT_FULL_LEGAL_NAME}}': agentName,
      '{{FACE_VALUE}}': formatCurrency(deal.net_commission),
      '{{PURCHASE_DISCOUNT}}': formatCurrency(deal.discount_fee),
      '{{SETTLEMENT_PERIOD_FEE}}': formatCurrency(deal.settlement_period_fee || 0),
      '{{TOTAL_FEES}}': formatCurrency((deal.discount_fee || 0) + (deal.settlement_period_fee || 0)),
      '{{NUMBER_OF_DAYS}}': deal.days_until_closing?.toString() || 'N/A',
      '{{SETTLEMENT_PERIOD_DAYS}}': '14',
      '{{PURCHASE_PRICE}}': formatCurrency(deal.advance_amount),
      '{{PROPERTY_ADDRESS}}': deal.property_address,
      '{{MLS_NUMBER}}': 'See APS',
      '{{EXPECTED_CLOSING_DATE}}': formatDate(deal.closing_date),
      '{{DUE_DATE}}': deal.due_date ? formatDate(deal.due_date) : 'Closing Date + 14 days',
      '{{LATE_INTEREST_RATE}}': '24%',
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
      console.error('Failed to save envelope records:', insertErr.message)
      // Don't fail — envelope was sent, just tracking failed
    }

    await logAuditEvent({
      action: 'esignature.sent',
      entityType: 'deal',
      entityId: dealId,
      metadata: { envelopeId: result.envelopeId, agentEmail: agent.email, agentName },
    })

    return { success: true, data: { envelopeId: result.envelopeId } }
  } catch (err: any) {
    console.error('sendForSignature error:', err?.message)
    return { success: false, error: err?.message || 'Failed to send for signature' }
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

    // Get unique envelope IDs (CPA and IDP share the same envelope)
    const seen = new Set<string>()
    for (const env of envelopes) {
      const eid = (env as { envelope_id: string }).envelope_id
      if (!seen.has(eid)) {
        seen.add(eid)
        await voidEnvelope(eid, reason)
      }
    }

    // Update all envelope records
    await supabase
      .from('esignature_envelopes')
      .update({
        status: 'voided',
        voided_at: new Date().toISOString(),
        void_reason: reason,
      })
      .eq('deal_id', dealId)
      .in('status', ['sent', 'delivered'])

    await logAuditEvent({
      action: 'esignature.voided',
      entityType: 'deal',
      entityId: dealId,
      metadata: { reason, envelopeIds: Array.from(seen) },
    })

    return { success: true }
  } catch (err: any) {
    console.error('voidDealEnvelopes error:', err?.message)
    return { success: false, error: err?.message || 'Failed to void envelopes' }
  }
}

// ============================================================================
// Get Signature Status for a Deal
// ============================================================================

export async function getDealSignatureStatus(dealId: string): Promise<ActionResult> {
  const supabase = createServiceRoleClient()

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
      console.error('Failed to save BCA envelope record:', insertErr.message)
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
  } catch (err: any) {
    console.error('sendBcaForSignature error:', err?.message)
    return { success: false, error: err?.message || 'Failed to send BCA for signature' }
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

    // Void each unique envelope in DocuSign
    const seen = new Set<string>()
    for (const env of envelopes) {
      const eid = (env as { envelope_id: string }).envelope_id
      if (!seen.has(eid)) {
        seen.add(eid)
        await voidEnvelope(eid, reason)
      }
    }

    // Update records
    await supabase
      .from('esignature_envelopes')
      .update({
        status: 'voided',
        voided_at: new Date().toISOString(),
        void_reason: reason,
      })
      .eq('brokerage_id', brokerageId)
      .eq('document_type', 'bca')
      .in('status', ['sent', 'delivered'])

    await logAuditEvent({
      action: 'bca.voided',
      entityType: 'brokerage',
      entityId: brokerageId,
      metadata: { reason, envelopeIds: Array.from(seen) },
    })

    return { success: true }
  } catch (err: any) {
    console.error('voidBcaEnvelope error:', err?.message)
    return { success: false, error: err?.message || 'Failed to void BCA envelope' }
  }
}

// ============================================================================
// BCA — Get Signature Status
// ============================================================================

export async function getBcaSignatureStatus(brokerageId: string): Promise<ActionResult> {
  const supabase = createServiceRoleClient()

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
  const supabase = createServiceRoleClient()

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
    const newDaysNum = Math.ceil((new Date(amendment.new_closing_date + 'T00:00:00Z').getTime() - new Date(fundingDate + 'T00:00:00Z').getTime()) / (1000 * 60 * 60 * 24))

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

    await supabase
      .from('esignature_envelopes')
      .insert({
        deal_id: dealId,
        envelope_id: result.envelopeId,
        document_type: 'cpa' as const,
        status: 'sent' as const,
        agent_signer_status: 'sent' as const,
        envelope_uri: result.uri,
      })

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
  } catch (err: any) {
    console.error('Send amended CPA error:', err?.message)
    return { success: false, error: err?.message || 'Failed to send amended CPA' }
  }
}
