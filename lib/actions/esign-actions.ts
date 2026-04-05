'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { createAndSendEnvelope, isDocuSignConnected, voidEnvelope, getConsentUrl } from '@/lib/docusign'
import { logAuditEvent } from '@/lib/audit'

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
      '{{NUMBER_OF_DAYS}}': deal.days_until_closing?.toString() || 'N/A',
      '{{PURCHASE_PRICE}}': formatCurrency(deal.advance_amount),
      '{{PROPERTY_ADDRESS}}': deal.property_address,
      '{{MLS_NUMBER}}': 'See APS',
      '{{EXPECTED_CLOSING_DATE}}': formatDate(deal.closing_date),
      '{{BROKERAGE_LEGAL_NAME}}': brokerage.name,
      '{{BROKERAGE_ADDRESS}}': brokerage.address || 'On file',
      '{{BROKER_OF_RECORD}}': brokerage.broker_of_record_name || 'On file',
      '{{BROKERAGE_REFERRAL_FEE}}': formatCurrency(deal.brokerage_referral_fee),
      '{{BROKERAGE_SPLIT}}': ((deal.brokerage_split_pct || 0) * 100).toFixed(1),
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
      // Brokerage Cooperation Agreement date
      '{{BCA_DATE}}': 'On file',
      // Property details — some we don't have yet
      '{{BUYER_NAMES}}': 'See APS',
      '{{CLIENT_NAMES}}': 'See APS',
      '{{APS_DATE}}': 'See APS',
      '{{PROPERTY_PURCHASE_PRICE}}': 'See APS',
      '{{LISTING_OR_COOPERATING}}': 'See Trade Record',
      '{{DEPOSIT_BROKERAGE}}': 'See APS',
      '{{DEPOSIT_COOP}}': 'N/A',
    }

    // For now, we send a simple text-based summary since the actual .docx template
    // merge will be implemented when we integrate document generation.
    // DocuSign supports PDF/DOCX upload — we'll generate PDFs with filled data.

    // Generate simple HTML contracts as PDFs for DocuSign
    const cpaHtml = generateCpaHtml(contractData)
    const idpHtml = generateIdpHtml(contractData)

    const cpaBase64 = Buffer.from(cpaHtml).toString('base64')
    const idpBase64 = Buffer.from(idpHtml).toString('base64')

    // Create envelope with both documents
    const result = await createAndSendEnvelope({
      emailSubject: `Firm Funds — Signature Required: ${deal.property_address}`,
      documents: [
        {
          documentBase64: cpaBase64,
          name: 'Commission Purchase Agreement',
          fileExtension: 'html',
          documentId: '1',
        },
        {
          documentBase64: idpBase64,
          name: 'Irrevocable Direction to Pay',
          fileExtension: 'html',
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
              // CPA signature
              { documentId: '1', pageNumber: 'last', xPosition: '100', yPosition: '200' },
              // IDP signature
              { documentId: '2', pageNumber: 'last', xPosition: '100', yPosition: '200' },
            ],
            dateSignedTabs: [
              { documentId: '1', pageNumber: 'last', xPosition: '100', yPosition: '280' },
              { documentId: '2', pageNumber: 'last', xPosition: '100', yPosition: '280' },
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
    const uniqueEnvelopeIds = [...new Set(envelopes.map(e => e.envelope_id))]

    for (const envId of uniqueEnvelopeIds) {
      await voidEnvelope(envId, reason)
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
      metadata: { reason, envelopeIds: uniqueEnvelopeIds },
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

// ============================================================================
// HTML Contract Generators
// ============================================================================

function generateCpaHtml(data: Record<string, string>): string {
  const r = (key: string) => data[key] || key

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; margin: 60px; color: #000; }
  h1 { text-align: center; font-size: 18pt; margin-bottom: 4px; }
  h2 { font-size: 14pt; margin-top: 24px; margin-bottom: 8px; }
  .subtitle { text-align: center; font-style: italic; margin-bottom: 30px; }
  .parties { margin-left: 40px; margin-bottom: 10px; }
  .indent { margin-left: 20px; }
  .section { margin-bottom: 8px; }
  .lettered { margin-left: 40px; margin-bottom: 4px; }
  table.schedule { width: 100%; border-collapse: collapse; margin: 10px 0; }
  table.schedule td, table.schedule th { border: 1px solid #999; padding: 6px 10px; font-size: 11pt; }
  table.schedule th { background: #eee; text-align: left; font-weight: bold; }
  .sig-line { border-bottom: 1px solid #000; width: 300px; display: inline-block; margin-bottom: 4px; }
  .sig-block { margin-top: 30px; }
  .page-break { page-break-before: always; }
  .header { text-align: center; font-size: 9pt; color: #666; margin-bottom: 20px; border-bottom: 1px solid #ccc; padding-bottom: 8px; }
</style></head><body>
<div class="header">FIRM FUNDS INC. — Commission Purchase Agreement</div>
<h1>COMMISSION PURCHASE AGREEMENT</h1>
<p class="subtitle">True Sale of Commission Receivable</p>

<p>THIS AGREEMENT made as of <strong>${r('{{AGREEMENT_DATE}}')}</strong>.</p>

<p><strong>BETWEEN:</strong></p>
<p class="parties"><strong>${r('{{AGENT_FULL_LEGAL_NAME}}')}</strong><br><em>(hereinafter called the "Seller")</em></p>
<p style="text-align:center;">— and —</p>
<p class="parties"><strong>FIRM FUNDS INC.</strong><br>a corporation incorporated under the laws of the Province of Ontario<br><em>(hereinafter called the "Purchaser")</em></p>

<h2>RECITALS</h2>
<p class="indent"><strong>WHEREAS</strong> the Seller is a licensed real estate salesperson registered with the Real Estate Council of Ontario ("RECO") and is affiliated with the Brokerage identified in Schedule "A" hereto (the "Brokerage");</p>
<p class="indent"><strong>WHEREAS</strong> the Seller has earned a commission (the "Commission") in connection with the real estate transaction described in Schedule "A" hereto (the "Real Estate Transaction");</p>
<p class="indent"><strong>WHEREAS</strong> the Real Estate Transaction is firm, with all conditions of the Agreement of Purchase and Sale having been waived or satisfied;</p>
<p class="indent"><strong>WHEREAS</strong> the Seller wishes to sell, and the Purchaser wishes to purchase, the Commission on the terms and conditions set forth herein;</p>
<p class="indent"><strong>WHEREAS</strong> the Parties intend this Agreement to constitute an absolute and unconditional sale and assignment of the Commission from the Seller to the Purchaser, and expressly do not intend this transaction to constitute a loan, a financing arrangement, or a security interest of any kind;</p>

<p><strong>NOW THEREFORE</strong>, in consideration of the mutual covenants and agreements herein contained and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the Parties agree as follows:</p>

<h2>ARTICLE 1 — DEFINITIONS</h2>
<p class="indent"><strong>"Agreement of Purchase and Sale" or "APS"</strong> means the binding written agreement for the purchase and sale of real property as described in Schedule "A", including any addenda or amendments thereto;</p>
<p class="indent"><strong>"Brokerage"</strong> means the real estate brokerage holding the Commission in trust as described in Schedule "A";</p>
<p class="indent"><strong>"Closing Date"</strong> means the expected closing date of the APS as set out in Schedule "A", or such earlier or later date as may be mutually agreed in writing by the parties to the APS;</p>
<p class="indent"><strong>"Commission"</strong> means the specific commission receivable being purchased, as described in Schedule "A";</p>
<p class="indent"><strong>"Extension Fee"</strong> means the flat per-diem charge applicable if the Real Estate Transaction does not close on or before the Expected Closing Date, calculated in accordance with Article 6;</p>
<p class="indent"><strong>"Face Value"</strong> means the net commission payable to the Seller after the Brokerage's commission split, as set out in Schedule "A";</p>
<p class="indent"><strong>"Grace Period"</strong> means the five (5) calendar day period immediately following the Expected Closing Date during which no Extension Fee shall accrue;</p>
<p class="indent"><strong>"Irrevocable Direction to Pay"</strong> means the irrevocable direction executed by the Seller directing the Brokerage to pay the Commission directly to the Purchaser, in the form attached as Schedule "B";</p>
<p class="indent"><strong>"Purchase Discount"</strong> means the fee charged by the Purchaser for this purchase transaction, calculated as set out in Article 3;</p>
<p class="indent"><strong>"Purchase Price"</strong> means the amount paid by the Purchaser to the Seller, being the Face Value less the Purchase Discount;</p>
<p class="indent"><strong>"Referral Fee"</strong> means any referral or cooperation fee payable by the Purchaser to the Brokerage in connection with this transaction;</p>
<p class="indent"><strong>"RECO"</strong> means the Real Estate Council of Ontario.</p>

<h2>ARTICLE 2 — PURCHASE AND SALE</h2>
<p class="section"><strong>2.1 Sale and Assignment.</strong> The Seller hereby sells, assigns, and transfers to the Purchaser, absolutely and unconditionally, all of the Seller's right, title, interest, and entitlement in and to the Commission, free and clear of all liens, charges, encumbrances, claims, and security interests of any kind.</p>
<p class="section"><strong>2.2 Absolute Assignment.</strong> The Parties acknowledge and agree that this transaction constitutes a true sale and absolute assignment of the Commission, and not an assignment by way of security or a loan.</p>
<p class="section"><strong>2.3 No Residual Interest.</strong> Following the execution of this Agreement, the Seller shall have no further right, title, interest, or claim in or to the Commission, except as expressly set forth in this Agreement.</p>

<h2>ARTICLE 3 — PURCHASE PRICE AND PAYMENT</h2>
<p class="section"><strong>3.1 Face Value.</strong> The Face Value of the Commission is ${r('{{FACE_VALUE}}')} (the "Face Value"), being the net commission payable to the Seller after the Brokerage's commission split.</p>
<p class="section"><strong>3.2 Purchase Discount.</strong> The Purchase Discount is ${r('{{PURCHASE_DISCOUNT}}')} (the "Purchase Discount"), calculated as follows: $0.75 per $1,000.00 of Face Value per day, for ${r('{{NUMBER_OF_DAYS}}')} days (being the number of calendar days from the date of this Agreement to the Expected Closing Date, plus ten (10) business days).</p>
<p class="section"><strong>3.3 Purchase Price.</strong> The Purchase Price payable to the Seller is ${r('{{PURCHASE_PRICE}}')} (the "Purchase Price"), being the Face Value less the Purchase Discount.</p>
<p class="section"><strong>3.4 Payment.</strong> The Purchaser shall pay the Purchase Price to the Seller by electronic funds transfer to the account specified in Schedule "C" within two (2) business days of execution of this Agreement and the Irrevocable Direction to Pay.</p>

<h2>ARTICLE 4 — COLLECTION</h2>
<p class="section"><strong>4.1</strong> The Purchaser shall collect the Commission directly from the Brokerage's trust account upon closing of the Real Estate Transaction.</p>
<p class="section"><strong>4.2</strong> The Seller shall, concurrently with the execution of this Agreement, execute an Irrevocable Direction to Pay directing the Brokerage to pay the Commission directly to the Purchaser.</p>

<h2>ARTICLE 5 — RISK OF LOSS</h2>
<p class="section"><strong>5.1 Assumption of Risk.</strong> The Purchaser acknowledges that by purchasing the Commission, the Purchaser assumes the risk that the Real Estate Transaction may not close for any reason.</p>
<p class="section"><strong>5.2 No Guarantee.</strong> The Seller does not guarantee that the Purchaser will collect the full Face Value of the Commission or any amount whatsoever.</p>
<p class="section"><strong>5.3 Limited Remedies.</strong> In the event that the Real Estate Transaction does not close, the Purchaser's remedies shall be limited to those set forth in Article 7.</p>

<h2>ARTICLE 6 — EXTENSION FEE</h2>
<p class="section"><strong>6.1 Grace Period.</strong> If the Real Estate Transaction does not close on or before the Expected Closing Date, no Extension Fee shall accrue during the first five (5) calendar days following the Expected Closing Date (the "Grace Period").</p>
<p class="section"><strong>6.2 Extension Fee.</strong> If the Real Estate Transaction does not close within the Grace Period, an extension fee shall apply at the rate of $0.75 per $1,000.00 of Face Value per day for each calendar day from the expiry of the Grace Period to the actual Closing Date, inclusive.</p>
<p class="section"><strong>6.3 Deduction at Collection.</strong> The Extension Fee shall be deducted by the Purchaser from the Commission at the time of collection from the Brokerage.</p>

<h2>ARTICLE 7 — NON-CLOSING REMEDIES (LIMITED RECOURSE)</h2>
<p class="section"><strong>7.1 Substitution.</strong> If the Real Estate Transaction does not close, the Seller shall use commercially reasonable efforts, within thirty (30) days, to identify and offer a substitute commission receivable of equal or greater Face Value.</p>
<p class="section"><strong>7.2 Repayment Arrangement.</strong> If the Seller is unable to provide a substitute commission, the Seller shall enter into a reasonable repayment arrangement: (a) repayment of the Purchase Price only; (b) not exceeding six (6) monthly installments; (c) no additional fees or penalties; (d) no compounding or escalation.</p>
<p class="section"><strong>7.3 Recovery Balance.</strong> Any amount owing by the Seller shall be recorded as a recovery balance on the Seller's account with the Purchaser. The Purchaser may offset any recovery balance against future commission purchases.</p>

<h2>ARTICLE 8 — SELLER'S REPRESENTATIONS AND WARRANTIES</h2>
<p class="section">The Seller represents and warrants: (a) valid RECO registration and good standing; (b) full authority to sell and assign the Commission; (c) firm transaction with all conditions satisfied; (d) no prior assignment of the Commission; (e) no impediments to closing; (f) all information provided is true and accurate; (g) no pending litigation; (h) no PPSA registrations against the Commission; (i) buyer financing verified; (j) sufficient proceeds to pay the Commission.</p>

<h2>ARTICLE 9 — NOTIFICATION OBLIGATION</h2>
<p class="section">The Seller shall immediately notify the Purchaser if: (a) the Closing Date changes; (b) the transaction is terminated; (c) any circumstance may prevent closing; or (d) the Seller ceases to be licensed.</p>

<h2>ARTICLE 10 — TAX OBLIGATIONS</h2>
<p class="section">The collection, reporting, and remittance of all applicable GST/HST on the Commission is the sole responsibility of the Seller.</p>

<h2>ARTICLE 11 — FINTRAC COMPLIANCE</h2>
<p class="section">The Seller acknowledges identity verification through the Purchaser's portal and consents to record retention for a minimum of five (5) years.</p>

<h2>ARTICLE 12 — GENERAL PROVISIONS</h2>
<p class="section">Governed by the laws of Ontario. Electronic signatures valid under the Electronic Commerce Act, 2000 (Ontario). Each Party has been advised to obtain independent legal advice.</p>

<div class="page-break"></div>
<div class="header">FIRM FUNDS INC. — Commission Purchase Agreement — Schedule "A"</div>
<h2 style="text-align:center;">SCHEDULE "A" — TRANSACTION DETAILS</h2>
<table class="schedule">
<tr><th>Item</th><th>Details</th></tr>
<tr><td>Property Address</td><td>${r('{{PROPERTY_ADDRESS}}')}</td></tr>
<tr><td>MLS Number</td><td>${r('{{MLS_NUMBER}}')}</td></tr>
<tr><td>Expected Closing Date</td><td>${r('{{EXPECTED_CLOSING_DATE}}')}</td></tr>
<tr><td>Gross Commission Amount</td><td>${r('{{GROSS_COMMISSION_AMOUNT}}')}</td></tr>
<tr><td>Brokerage Commission Split</td><td>${r('{{BROKERAGE_SPLIT}}')}%</td></tr>
<tr><td>Net Commission to Seller (Face Value)</td><td>${r('{{FACE_VALUE}}')}</td></tr>
<tr><td>Discount Rate</td><td>$0.75 per $1,000 per day</td></tr>
<tr><td>Number of Days</td><td>${r('{{NUMBER_OF_DAYS}}')}</td></tr>
<tr><td>Purchase Discount</td><td>${r('{{PURCHASE_DISCOUNT}}')}</td></tr>
<tr><td>Purchase Price (Agent Receives)</td><td>${r('{{PURCHASE_PRICE}}')}</td></tr>
<tr><td>Brokerage Referral Fee</td><td>${r('{{BROKERAGE_REFERRAL_FEE}}')}</td></tr>
<tr><td>Brokerage Legal Name</td><td>${r('{{BROKERAGE_LEGAL_NAME}}')}</td></tr>
<tr><td>Brokerage Address</td><td>${r('{{BROKERAGE_ADDRESS}}')}</td></tr>
<tr><td>Broker of Record</td><td>${r('{{BROKER_OF_RECORD}}')}</td></tr>
</table>

<div class="page-break"></div>
<div class="header">FIRM FUNDS INC. — Commission Purchase Agreement — Signature Page</div>
<h2 style="text-align:center;">SIGNATURE PAGE</h2>
<p>IN WITNESS WHEREOF the Parties have executed this Agreement as of the date first written above.</p>

<div class="sig-block">
<p><strong>SELLER:</strong></p>
<p>Name: ${r('{{AGENT_FULL_LEGAL_NAME}}')}</p>
<p>RECO Registration No.: ${r('{{RECO_REGISTRATION_NUMBER}}')}</p>
<p style="margin-top: 40px;"><em>Signature: \\s1\\</em></p>
<p><em>Date Signed: \\d1\\</em></p>
</div>

<div class="sig-block">
<p><strong>PURCHASER: FIRM FUNDS INC.</strong></p>
<p>Title: President</p>
</div>

</body></html>`
}

function generateIdpHtml(data: Record<string, string>): string {
  const r = (key: string) => data[key] || key

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; margin: 60px; color: #000; }
  h1 { text-align: center; font-size: 18pt; margin-bottom: 4px; }
  h2 { font-size: 14pt; margin-top: 24px; margin-bottom: 8px; }
  .subtitle { text-align: center; font-style: italic; margin-bottom: 30px; }
  .indent { margin-left: 20px; }
  .section { margin-bottom: 8px; }
  .lettered { margin-left: 40px; margin-bottom: 4px; }
  table.info { border-collapse: collapse; margin: 10px 0; }
  table.info td { border: 1px solid #999; padding: 6px 10px; font-size: 11pt; }
  table.info td:first-child { font-weight: bold; background: #f5f5f5; width: 200px; }
  .sig-block { margin-top: 30px; }
  .header { text-align: center; font-size: 9pt; color: #666; margin-bottom: 20px; border-bottom: 1px solid #ccc; padding-bottom: 8px; }
</style></head><body>
<div class="header">FIRM FUNDS INC. — Irrevocable Direction to Pay</div>
<h1>IRREVOCABLE DIRECTION TO PAY</h1>
<p class="subtitle">Commission Payment Direction</p>

<p>Date: <strong>${r('{{AGREEMENT_DATE}}')}</strong></p>

<p><strong>TO:</strong></p>
<p class="indent"><strong>${r('{{BROKERAGE_LEGAL_NAME}}')}</strong><br>${r('{{BROKERAGE_ADDRESS}}')}<br>Attention: <strong>${r('{{BROKER_OF_RECORD}}')}</strong></p>

<p><strong>FROM:</strong></p>
<p class="indent"><strong>${r('{{AGENT_FULL_LEGAL_NAME}}')}</strong><br>RECO Registration No.: ${r('{{RECO_REGISTRATION_NUMBER}}')}</p>

<p><strong>RE:</strong> Commission on sale of <strong>${r('{{PROPERTY_ADDRESS}}')}</strong>, MLS No. <strong>${r('{{MLS_NUMBER}}')}</strong></p>

<h2>DIRECTION</h2>
<p>I, <strong>${r('{{AGENT_FULL_LEGAL_NAME}}')}</strong>, a registered real estate salesperson/broker affiliated with <strong>${r('{{BROKERAGE_LEGAL_NAME}}')}</strong> (the "Brokerage"), hereby irrevocably direct the Brokerage to pay the sum of <strong>${r('{{DIRECTED_AMOUNT}}')}</strong> (the "Directed Amount") from my commission earned on the sale of the property municipally known as <strong>${r('{{PROPERTY_ADDRESS}}')}</strong> (MLS No. <strong>${r('{{MLS_NUMBER}}')}</strong>) directly to <strong>Firm Funds Inc.</strong> (the "Purchaser").</p>

<p>This Direction is irrevocable and may not be revoked, altered, amended, or countermanded by me without the prior written consent of the Purchaser.</p>

<p>The Directed Amount shall be paid from the Brokerage's real estate trust account within <strong>five (5) business days</strong> of the closing of the above-referenced real estate transaction, by electronic funds transfer to the following account:</p>

<table class="info">
<tr><td>Payee</td><td>Firm Funds Inc.</td></tr>
<tr><td>Financial Institution</td><td>${r('{{PURCHASER_BANK_NAME}}')}</td></tr>
<tr><td>Transit Number</td><td>${r('{{PURCHASER_TRANSIT}}')}</td></tr>
<tr><td>Account Number</td><td>${r('{{PURCHASER_ACCOUNT}}')}</td></tr>
</table>

<p>If the Directed Amount exceeds the commission actually payable to me on this transaction (after the Brokerage's commission split), the Brokerage shall pay the lesser of the Directed Amount and the commission actually payable.</p>

<h2>BROKERAGE AUTHORIZATION</h2>
<p>I acknowledge that the Brokerage has entered into a Brokerage Cooperation Agreement with Firm Funds Inc., under which the Brokerage has agreed to honour Irrevocable Directions to Pay. A copy of this Direction will be provided to the Brokerage upon execution.</p>

<h2>EXTENSION FEE ACKNOWLEDGMENT</h2>
<p>I acknowledge that an Extension Fee may apply if the real estate transaction does not close on or before the Expected Closing Date. The Extension Fee applies at the rate of $0.75 per $1,000.00 of Face Value per day, following a five (5) calendar day grace period after the Expected Closing Date.</p>

<h2>NOTIFICATION OBLIGATION</h2>
<p>I shall immediately notify both the Brokerage and the Purchaser if: (a) the closing date is changed; (b) the transaction is terminated; or (c) any circumstance may prevent or delay closing.</p>

<h2>INDEPENDENT LEGAL ADVICE</h2>
<p>I acknowledge that I have been advised to obtain independent legal advice. I am executing this Direction freely, voluntarily, and with full knowledge of its contents and legal effect.</p>

<h2>ELECTRONIC SIGNATURE</h2>
<p>This Direction may be executed by electronic signature in accordance with the Electronic Commerce Act, 2000 (Ontario).</p>

<div class="sig-block">
<p><strong>AGENT SIGNATURE</strong></p>
<p>Name: ${r('{{AGENT_FULL_LEGAL_NAME}}')}</p>
<p>RECO Registration No.: ${r('{{RECO_REGISTRATION_NUMBER}}')}</p>
<p style="margin-top: 40px;"><em>Signature: \\s1\\</em></p>
<p><em>Date Signed: \\d1\\</em></p>
</div>

</body></html>`
}
