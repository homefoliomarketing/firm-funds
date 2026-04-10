'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import { calculateDeal } from '@/lib/calculations'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  SETTLEMENT_PERIOD_DAYS,
  MIN_DAYS_UNTIL_CLOSING,
  MAX_DAYS_UNTIL_CLOSING,
  MAX_UPLOAD_SIZE_BYTES,
  ALLOWED_UPLOAD_MIME_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  calcDaysUntilClosing,
} from '@/lib/constants'
import { logAuditEvent } from '@/lib/audit'
import { verifyFileMagicBytes } from '@/lib/file-validation'
import {
  sendAmendmentRequestedNotification,
  sendAmendmentApprovedNotification,
  sendAmendmentRejectedNotification,
} from '@/lib/email'

interface ActionResult {
  success: boolean
  error?: string
  data?: any
}

// ============================================================================
// Agent Action: Submit Closing Date Amendment Request
// ============================================================================

export async function submitClosingDateAmendment(formData: FormData): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['agent'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const dealId = formData.get('dealId') as string | null
    const newClosingDate = formData.get('newClosingDate') as string | null
    const file = formData.get('file') as File | null

    if (!dealId || !newClosingDate || !file) {
      return { success: false, error: 'Missing required fields' }
    }

    // Validate deal exists and agent owns it
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single()

    if (dealError || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    if (deal.agent_id !== profile.agent_id) {
      return { success: false, error: 'You do not have access to this deal' }
    }

    if (!['approved', 'funded'].includes(deal.status)) {
      return { success: false, error: 'Closing date can only be amended on approved or funded deals' }
    }

    // Check for existing pending amendment
    const serviceClient = createServiceRoleClient()
    const { data: existingPending } = await serviceClient
      .from('closing_date_amendments')
      .select('id')
      .eq('deal_id', dealId)
      .eq('status', 'pending')
      .limit(1)

    if (existingPending && existingPending.length > 0) {
      return { success: false, error: 'There is already a pending amendment request for this deal. Please wait for admin review.' }
    }

    // Validate new closing date
    const newDays = calcDaysUntilClosing(newClosingDate)
    if (newDays < MIN_DAYS_UNTIL_CLOSING || newDays > MAX_DAYS_UNTIL_CLOSING) {
      return { success: false, error: `New closing date must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING} days from today` }
    }

    if (newClosingDate === deal.closing_date) {
      return { success: false, error: 'New closing date is the same as the current closing date' }
    }

    // Validate file
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return { success: false, error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB` }
    }
    if (file.size === 0) {
      return { success: false, error: 'File is empty' }
    }

    const fileName = file.name.toLowerCase()
    const ext = '.' + fileName.split('.').pop()
    if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext as any)) {
      return { success: false, error: `File type not allowed. Accepted: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}` }
    }
    if (!ALLOWED_UPLOAD_MIME_TYPES.includes(file.type as any)) {
      return { success: false, error: 'File MIME type not allowed' }
    }

    const magicBytesValid = await verifyFileMagicBytes(file)
    if (!magicBytesValid) {
      return { success: false, error: 'File content does not match its declared type' }
    }

    // Upload file to storage
    const timestamp = Date.now()
    const randomId = crypto.randomUUID()
    const safePath = `${dealId}/${timestamp}_amendment_${randomId}${ext}`

    const { error: uploadError } = await supabase.storage
      .from('deal-documents')
      .upload(safePath, file)

    if (uploadError) {
      console.error('Amendment upload error:', uploadError.message)
      return { success: false, error: 'Failed to upload amendment document' }
    }

    // Create document record
    const { data: docRecord, error: docError } = await serviceClient
      .from('deal_documents')
      .insert({
        deal_id: dealId,
        uploaded_by: user.id,
        document_type: 'closing_date_amendment' as const,
        file_name: file.name,
        file_path: safePath,
        file_size: file.size,
        upload_source: 'manual_upload' as const,
      })
      .select()
      .single()

    if (docError || !docRecord) {
      await supabase.storage.from('deal-documents').remove([safePath])
      return { success: false, error: 'Failed to save document record' }
    }

    // Calculate what the new fees would be (preview only, not stored yet)
    const referralPct = deal.brokerage_referral_pct || 0.20
    const newCalc = calculateDeal({
      grossCommission: deal.gross_commission,
      brokerageSplitPct: deal.brokerage_split_pct,
      daysUntilClosing: newDays,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
    })

    // Compute new due date
    const newClosingDateObj = new Date(newClosingDate + 'T00:00:00Z')
    const newDueDate = new Date(newClosingDateObj.getTime() + SETTLEMENT_PERIOD_DAYS * 24 * 60 * 60 * 1000)
    const newDueDateStr = newDueDate.toISOString().split('T')[0]

    // Create amendment request record
    const { data: amendment, error: amendError } = await serviceClient
      .from('closing_date_amendments')
      .insert({
        deal_id: dealId,
        requested_by: user.id,
        old_closing_date: deal.closing_date,
        new_closing_date: newClosingDate,
        status: 'pending',
        amendment_document_id: docRecord.id,
        old_discount_fee: deal.discount_fee,
        new_discount_fee: newCalc.discountFee,
        old_settlement_period_fee: deal.settlement_period_fee || 0,
        new_settlement_period_fee: newCalc.settlementPeriodFee,
        old_advance_amount: deal.advance_amount,
        new_advance_amount: newCalc.advanceAmount,
        old_due_date: deal.due_date,
        new_due_date: newDueDateStr,
      })
      .select()
      .single()

    if (amendError || !amendment) {
      console.error('Amendment insert error:', amendError?.message)
      return { success: false, error: 'Failed to create amendment request' }
    }

    await logAuditEvent({
      action: 'amendment.requested',
      entityType: 'deal',
      entityId: dealId,
      metadata: {
        amendment_id: amendment.id,
        old_closing_date: deal.closing_date,
        new_closing_date: newClosingDate,
        requested_by: user.id,
      },
    })

    // Notify admin
    const { data: agentData } = await serviceClient
      .from('agents')
      .select('first_name, last_name')
      .eq('id', deal.agent_id)
      .single()

    if (agentData) {
      sendAmendmentRequestedNotification({
        dealId: deal.id,
        propertyAddress: deal.property_address,
        agentName: `${agentData.first_name} ${agentData.last_name}`,
        oldClosingDate: deal.closing_date,
        newClosingDate,
      })
    }

    return { success: true, data: { amendmentId: amendment.id } }
  } catch (err: any) {
    console.error('Submit closing date amendment error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Admin Action: Approve Closing Date Amendment
// ============================================================================

export async function approveClosingDateAmendment(input: {
  amendmentId: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    // Fetch amendment with deal
    const { data: amendment, error: amendError } = await serviceClient
      .from('closing_date_amendments')
      .select('*, deals(*, agents(*, brokerages(*)))')
      .eq('id', input.amendmentId)
      .single()

    if (amendError || !amendment) {
      return { success: false, error: 'Amendment not found' }
    }

    if (amendment.status !== 'pending') {
      return { success: false, error: 'Amendment has already been reviewed' }
    }

    const deal = amendment.deals as any
    if (!deal) return { success: false, error: 'Deal not found' }

    // Recalculate fees with new closing date
    const newDays = calcDaysUntilClosing(amendment.new_closing_date)
    const referralPct = deal.brokerage_referral_pct || 0.20

    const newCalc = calculateDeal({
      grossCommission: deal.gross_commission,
      brokerageSplitPct: deal.brokerage_split_pct,
      daysUntilClosing: newDays,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
    })

    // Compute new due date
    const newClosingDateObj = new Date(amendment.new_closing_date + 'T00:00:00Z')
    const newDueDate = new Date(newClosingDateObj.getTime() + SETTLEMENT_PERIOD_DAYS * 24 * 60 * 60 * 1000)
    const newDueDateStr = newDueDate.toISOString().split('T')[0]

    // Update deal with new values
    const { error: updateError } = await serviceClient
      .from('deals')
      .update({
        closing_date: amendment.new_closing_date,
        days_until_closing: newDays,
        discount_fee: newCalc.discountFee,
        settlement_period_fee: newCalc.settlementPeriodFee,
        advance_amount: newCalc.advanceAmount,
        brokerage_referral_fee: newCalc.brokerageReferralFee,
        amount_due_from_brokerage: newCalc.amountDueFromBrokerage,
        due_date: newDueDateStr,
      })
      .eq('id', deal.id)

    if (updateError) {
      console.error('Deal update error on amendment approve:', updateError.message)
      return { success: false, error: 'Failed to update deal' }
    }

    // Mark amendment as approved
    await serviceClient
      .from('closing_date_amendments')
      .update({
        status: 'approved',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        new_discount_fee: newCalc.discountFee,
        new_settlement_period_fee: newCalc.settlementPeriodFee,
        new_advance_amount: newCalc.advanceAmount,
        new_due_date: newDueDateStr,
      })
      .eq('id', input.amendmentId)

    // Generate and send amended CPA via DocuSign
    let envelopeId: string | null = null
    try {
      const { sendAmendedCpaForSignature } = await import('@/lib/actions/esign-actions')
      const sendResult = await sendAmendedCpaForSignature(deal.id, input.amendmentId)
      if (sendResult.success && sendResult.data?.envelopeId) {
        envelopeId = sendResult.data.envelopeId
        await serviceClient
          .from('closing_date_amendments')
          .update({ amended_envelope_id: envelopeId })
          .eq('id', input.amendmentId)
      }
    } catch (err: any) {
      console.error('Failed to send amended CPA:', err?.message)
      // Don't fail the whole approval — amendment is approved, envelope can be retried
    }

    await logAuditEvent({
      action: 'amendment.approved',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        amendment_id: input.amendmentId,
        old_closing_date: amendment.old_closing_date,
        new_closing_date: amendment.new_closing_date,
        envelope_id: envelopeId,
      },
    })

    // Notify agent
    const agent = deal.agents
    if (agent?.email) {
      sendAmendmentApprovedNotification({
        dealId: deal.id,
        propertyAddress: deal.property_address,
        agentEmail: agent.email,
        agentFirstName: agent.first_name,
        newClosingDate: amendment.new_closing_date,
        newAdvanceAmount: newCalc.advanceAmount,
      })
    }

    return { success: true, data: { envelopeId } }
  } catch (err: any) {
    console.error('Approve amendment error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Admin Action: Reject Closing Date Amendment
// ============================================================================

export async function rejectClosingDateAmendment(input: {
  amendmentId: string
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.reason?.trim()) {
    return { success: false, error: 'Rejection reason is required' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: amendment } = await serviceClient
      .from('closing_date_amendments')
      .select('*, deals(id, property_address, agents(first_name, email))')
      .eq('id', input.amendmentId)
      .single()

    if (!amendment) return { success: false, error: 'Amendment not found' }
    if (amendment.status !== 'pending') {
      return { success: false, error: 'Amendment has already been reviewed' }
    }

    await serviceClient
      .from('closing_date_amendments')
      .update({
        status: 'rejected',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        rejection_reason: input.reason.trim(),
      })
      .eq('id', input.amendmentId)

    await logAuditEvent({
      action: 'amendment.rejected',
      entityType: 'deal',
      entityId: (amendment.deals as any)?.id,
      metadata: {
        amendment_id: input.amendmentId,
        reason: input.reason,
      },
    })

    // Notify agent
    const deal = amendment.deals as any
    const agent = deal?.agents
    if (agent?.email && deal) {
      sendAmendmentRejectedNotification({
        dealId: deal.id,
        propertyAddress: deal.property_address,
        agentEmail: agent.email,
        agentFirstName: agent.first_name,
        reason: input.reason.trim(),
      })
    }

    return { success: true }
  } catch (err: any) {
    console.error('Reject amendment error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Get amendments for a deal (used by both agent and admin)
// ============================================================================

export async function getDealAmendments(dealId: string): Promise<ActionResult> {
  const serviceClient = createServiceRoleClient()

  try {
    const { data, error } = await serviceClient
      .from('closing_date_amendments')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })

    if (error) return { success: false, error: error.message }
    return { success: true, data: data || [] }
  } catch (err: any) {
    return { success: false, error: 'Failed to fetch amendments' }
  }
}

// ============================================================================
// Admin: Get all pending amendments
// ============================================================================

export async function getPendingAmendments(): Promise<ActionResult> {
  const { error: authErr } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr) return { success: false, error: authErr }

  const serviceClient = createServiceRoleClient()

  try {
    const { data, error } = await serviceClient
      .from('closing_date_amendments')
      .select('*, deals(id, property_address, status, agents(first_name, last_name))')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) return { success: false, error: error.message }
    return { success: true, data: data || [] }
  } catch (err: any) {
    return { success: false, error: 'Failed to fetch pending amendments' }
  }
}
