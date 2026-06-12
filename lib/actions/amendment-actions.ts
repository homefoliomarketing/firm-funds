'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { getAuthenticatedUser, getAuthenticatedWriter, getAuthenticatedCapable } from '@/lib/auth-helpers'
import { calculateDeal, computeAmendmentBrokerageRecalc } from '@/lib/calculations'
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
  sendInvoiceNotification,
  sendAmendedRemittanceNotification,
} from '@/lib/email'
import { insertAgentInvoice } from '@/lib/agent-invoices'

interface ActionResult<T = unknown> {
  success: boolean
  error?: string
  data?: T
}

/**
 * Closing-date amendment fee delta for a FUNDED deal.
 *
 * The agent has already paid the discount fee for the funding-to-current-
 * closing window. Amending the closing date should only adjust the fee for
 * the ADDITIONAL calendar days between the current closing date and the
 * new closing date — not re-price the deal from today onward.
 *
 * Without this distinction, a missed closing that gets amended months
 * later would credit the agent for time they have actually held the funds
 * (e.g. original closing 4 months ago, new closing 7 days out → re-pricing
 * from today produces a refund instead of a charge for the extra 4 months).
 *
 * Positive delta = closing extended → additional charge.
 * Negative delta = closing pulled earlier → credit.
 */
function computeFundedAmendmentDelta(
  netCommission: number | null | undefined,
  currentClosingIso: string,
  newClosingIso: string
): { extraDays: number; feeAdjustment: number } {
  const oldClosing = new Date(currentClosingIso + 'T00:00:00Z')
  const newClosing = new Date(newClosingIso + 'T00:00:00Z')
  const extraDays = Math.round((newClosing.getTime() - oldClosing.getTime()) / 86400000)
  const dailyRate = DISCOUNT_RATE_PER_1000_PER_DAY / 1000
  const feeAdjustment = Math.round((netCommission || 0) * dailyRate * extraDays * 100) / 100
  return { extraDays, feeAdjustment }
}

// ============================================================================
// Agent Action: Submit Closing Date Amendment Request
// ============================================================================

export async function submitClosingDateAmendment(formData: FormData): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['agent'])
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
    if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
      return { success: false, error: `File type not allowed. Accepted: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}` }
    }
    if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
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

    // Calculate what the new fees would be — preserve the deal's settlement
    // window (snapshotted at funding, or fall back to the current brokerage default)
    const referralPct = deal.brokerage_referral_pct || 0.20
    const settlementDays = deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS
    const newCalc = calculateDeal({
      grossCommission: deal.gross_commission,
      brokerageSplitPct: deal.brokerage_split_pct,
      brokerageFlatFee: Number(deal.brokerage_flat_fee ?? 0),
      daysUntilClosing: newDays,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
    })

    // Compute new due date using the same settlement window
    const newClosingDateObj = new Date(newClosingDate + 'T00:00:00Z')
    const newDueDate = new Date(newClosingDateObj.getTime() + settlementDays * 24 * 60 * 60 * 1000)
    const newDueDateStr = newDueDate.toISOString().split('T')[0]

    // Determine scenario and fee adjustment
    // For APPROVED deals: fully recalculate, no adjustment to agent account
    // For FUNDED deals: fees are LOCKED, only closing_date/due_date change.
    //   The discount-fee delta is the additional charge (or credit) for the
    //   calendar days between the current closing date and the new closing
    //   date — not a wholesale re-pricing from today. See
    //   computeFundedAmendmentDelta above.
    let scenario: 'approved_recalc' | 'funded_extended' | 'funded_earlier' = 'approved_recalc'
    let feeAdjustment = 0
    let newDiscountFeeStored = newCalc.discountFee
    let newSettlementFeeStored = newCalc.settlementPeriodFee
    let newAdvanceAmountStored = newCalc.advanceAmount

    if (deal.status === 'funded') {
      const oldDiscountFee = deal.discount_fee || 0
      const delta = computeFundedAmendmentDelta(
        deal.net_commission,
        deal.closing_date,
        newClosingDate,
      )
      feeAdjustment = delta.feeAdjustment
      // Show the resulting TOTAL discount fee (old + delta) so admin / agent
      // UI displays a consistent picture: this is what they'll have paid in
      // total once the amendment is approved.
      newDiscountFeeStored = Math.round((oldDiscountFee + feeAdjustment) * 100) / 100
      // Settlement period fee and advance are locked at funding — no change.
      newSettlementFeeStored = deal.settlement_period_fee || 0
      newAdvanceAmountStored = deal.advance_amount
      scenario = feeAdjustment >= 0 ? 'funded_extended' : 'funded_earlier'
    }

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
        new_discount_fee: newDiscountFeeStored,
        old_settlement_period_fee: deal.settlement_period_fee || 0,
        new_settlement_period_fee: newSettlementFeeStored,
        old_advance_amount: deal.advance_amount,
        new_advance_amount: newAdvanceAmountStored,
        old_due_date: deal.due_date,
        new_due_date: newDueDateStr,
        fee_adjustment_amount: feeAdjustment,
        adjustment_scenario: scenario,
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
        dealNumber: deal.deal_number,
        propertyAddress: deal.property_address,
        agentName: `${agentData.first_name} ${agentData.last_name}`,
        oldClosingDate: deal.closing_date,
        newClosingDate,
      })
    }

    return { success: true, data: { amendmentId: amendment.id } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Submit closing date amendment error:', message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Brokerage Action: Submit Closing Date Amendment Request
// ============================================================================

export async function submitClosingDateAmendmentAsBrokerage(formData: FormData): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['brokerage_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Brokerage profile not configured' }

  try {
    const dealId = formData.get('dealId') as string | null
    const newClosingDate = formData.get('newClosingDate') as string | null
    const file = formData.get('file') as File | null

    if (!dealId || !newClosingDate || !file) {
      return { success: false, error: 'Missing required fields' }
    }

    // Validate deal exists and belongs to this brokerage
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single()

    if (dealError || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    if (deal.brokerage_id !== profile.brokerage_id) {
      return { success: false, error: 'You do not have access to this deal' }
    }

    if (!['approved', 'funded'].includes(deal.status)) {
      return { success: false, error: 'Closing date can only be amended on approved or funded deals' }
    }

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

    const newDays = calcDaysUntilClosing(newClosingDate)
    if (newDays < MIN_DAYS_UNTIL_CLOSING || newDays > MAX_DAYS_UNTIL_CLOSING) {
      return { success: false, error: `New closing date must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING} days from today` }
    }

    if (newClosingDate === deal.closing_date) {
      return { success: false, error: 'New closing date is the same as the current closing date' }
    }

    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return { success: false, error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB` }
    }
    if (file.size === 0) {
      return { success: false, error: 'File is empty' }
    }

    const fileName = file.name.toLowerCase()
    const ext = '.' + fileName.split('.').pop()
    if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
      return { success: false, error: `File type not allowed. Accepted: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}` }
    }
    if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
      return { success: false, error: 'File MIME type not allowed' }
    }

    const magicBytesValid = await verifyFileMagicBytes(file)
    if (!magicBytesValid) {
      return { success: false, error: 'File content does not match its declared type' }
    }

    const timestamp = Date.now()
    const randomId = crypto.randomUUID()
    const safePath = `${dealId}/${timestamp}_amendment_${randomId}${ext}`

    const { error: uploadError } = await supabase.storage
      .from('deal-documents')
      .upload(safePath, file)

    if (uploadError) {
      console.error('Brokerage amendment upload error:', uploadError.message)
      return { success: false, error: 'Failed to upload amendment document' }
    }

    // Use service role for the deal_documents insert — the brokerage_admin RLS
    // policy on deal_documents has historically been incomplete (see commit b32b5b5).
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

    const referralPct = deal.brokerage_referral_pct || 0.20
    const settlementDays = deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS
    const newCalc = calculateDeal({
      grossCommission: deal.gross_commission,
      brokerageSplitPct: deal.brokerage_split_pct,
      brokerageFlatFee: Number(deal.brokerage_flat_fee ?? 0),
      daysUntilClosing: newDays,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
    })

    const newClosingDateObj = new Date(newClosingDate + 'T00:00:00Z')
    const newDueDate = new Date(newClosingDateObj.getTime() + settlementDays * 24 * 60 * 60 * 1000)
    const newDueDateStr = newDueDate.toISOString().split('T')[0]

    let scenario: 'approved_recalc' | 'funded_extended' | 'funded_earlier' = 'approved_recalc'
    let feeAdjustment = 0
    let newDiscountFeeStored = newCalc.discountFee
    let newSettlementFeeStored = newCalc.settlementPeriodFee
    let newAdvanceAmountStored = newCalc.advanceAmount

    if (deal.status === 'funded') {
      const oldDiscountFee = deal.discount_fee || 0
      const delta = computeFundedAmendmentDelta(
        deal.net_commission,
        deal.closing_date,
        newClosingDate,
      )
      feeAdjustment = delta.feeAdjustment
      newDiscountFeeStored = Math.round((oldDiscountFee + feeAdjustment) * 100) / 100
      newSettlementFeeStored = deal.settlement_period_fee || 0
      newAdvanceAmountStored = deal.advance_amount
      scenario = feeAdjustment >= 0 ? 'funded_extended' : 'funded_earlier'
    }

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
        new_discount_fee: newDiscountFeeStored,
        old_settlement_period_fee: deal.settlement_period_fee || 0,
        new_settlement_period_fee: newSettlementFeeStored,
        old_advance_amount: deal.advance_amount,
        new_advance_amount: newAdvanceAmountStored,
        old_due_date: deal.due_date,
        new_due_date: newDueDateStr,
        fee_adjustment_amount: feeAdjustment,
        adjustment_scenario: scenario,
      })
      .select()
      .single()

    if (amendError || !amendment) {
      console.error('Brokerage amendment insert error:', amendError?.message)
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
        requested_by_role: 'brokerage_admin',
      },
    })

    // Notify admin — fetch the agent on the deal so the email reads naturally
    const { data: agentData } = await serviceClient
      .from('agents')
      .select('first_name, last_name')
      .eq('id', deal.agent_id)
      .single()

    if (agentData) {
      sendAmendmentRequestedNotification({
        dealId: deal.id,
        dealNumber: deal.deal_number,
        propertyAddress: deal.property_address,
        agentName: `${agentData.first_name} ${agentData.last_name}`,
        oldClosingDate: deal.closing_date,
        newClosingDate,
      })
    }

    return { success: true, data: { amendmentId: amendment.id } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Submit brokerage closing date amendment error:', message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Brokerage: Get pending amendments for this brokerage's deals
// ============================================================================

export async function getBrokeragePendingAmendments(): Promise<ActionResult> {
  const { error: authErr, profile } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Brokerage profile not configured' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data, error } = await serviceClient
      .from('closing_date_amendments')
      .select('*, deals!inner(id, property_address, status, brokerage_id, agents(first_name, last_name))')
      .eq('deals.brokerage_id', profile.brokerage_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) return { success: false, error: error.message }
    return { success: true, data: data || [] }
  } catch {
    return { success: false, error: 'Failed to fetch pending amendments' }
  }
}

// ============================================================================
// Brokerage: Get APPROVED amendments that recomputed the brokerage figures.
//
// Powers the "Amended" badge + "was {old}" sub-line on the brokerage deal
// cards. Only amendments that actually moved the brokerage numbers are
// returned (new_amount_due_from_brokerage IS NOT NULL, set on funded
// approvals by migration 117). Keyed by deal_id, LATEST approved amendment
// per deal wins (the deal's stored figures already reflect the cumulative
// result; we just surface the most recent "was" baseline).
//
// closing_date_amendments has no brokerage_admin RLS SELECT policy (see
// migration 056), so this MUST run through the service-role client like
// getBrokeragePendingAmendments above. Scoped to the caller's brokerage via
// deals.brokerage_id. Only the display columns are selected.
// ============================================================================
export interface ApprovedBrokerageAmendment {
  deal_id: string
  old_amount_due_from_brokerage: number | null
  old_brokerage_referral_fee: number | null
  old_closing_date: string | null
  new_closing_date: string | null
}

export async function getBrokerageApprovedBrokerageAmendments(): Promise<ActionResult<Record<string, ApprovedBrokerageAmendment>>> {
  const { error: authErr, profile } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Brokerage profile not configured' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data, error } = await serviceClient
      .from('closing_date_amendments')
      .select('deal_id, old_amount_due_from_brokerage, new_amount_due_from_brokerage, old_brokerage_referral_fee, old_closing_date, new_closing_date, reviewed_at, deals!inner(brokerage_id)')
      .eq('deals.brokerage_id', profile.brokerage_id)
      .eq('status', 'approved')
      .not('new_amount_due_from_brokerage', 'is', null)
      .order('reviewed_at', { ascending: false })

    if (error) return { success: false, error: error.message }

    // Latest-approved-per-deal wins. Rows are ordered newest-first, so the
    // first row seen for a deal_id is the most recent.
    const byDeal: Record<string, ApprovedBrokerageAmendment> = {}
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const dealId = row.deal_id as string
      if (byDeal[dealId]) continue
      byDeal[dealId] = {
        deal_id: dealId,
        old_amount_due_from_brokerage: row.old_amount_due_from_brokerage as number | null,
        old_brokerage_referral_fee: row.old_brokerage_referral_fee as number | null,
        old_closing_date: row.old_closing_date as string | null,
        new_closing_date: row.new_closing_date as string | null,
      }
    }
    return { success: true, data: byDeal }
  } catch {
    return { success: false, error: 'Failed to fetch approved amendments' }
  }
}

// ============================================================================
// Brokerage: Get APPROVED closing-date changes for this brokerage's deals.
//
// Unlike getBrokerageApprovedBrokerageAmendments (which only returns
// amendments that moved the brokerage REMITTANCE figures), this returns EVERY
// approved closing-date amendment so the brokerage portal can flag that a
// deal's closing date changed, even when the remittance amount did not move
// (e.g. a plain date change on an approved-but-not-yet-funded deal). Keyed by
// deal_id, latest approved amendment per deal wins. Service-role + scoped to
// the caller's brokerage (closing_date_amendments has no brokerage RLS).
// ============================================================================
export interface BrokerageClosingDateChange {
  deal_id: string
  old_closing_date: string | null
  new_closing_date: string | null
  amendment_document_id: string | null
}

export async function getBrokerageClosingDateChanges(): Promise<ActionResult<Record<string, BrokerageClosingDateChange>>> {
  const { error: authErr, profile } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !profile) return { success: false, error: authErr || 'Authentication failed' }
  if (!profile.brokerage_id) return { success: false, error: 'Brokerage profile not configured' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data, error } = await serviceClient
      .from('closing_date_amendments')
      .select('deal_id, old_closing_date, new_closing_date, amendment_document_id, reviewed_at, deals!inner(brokerage_id)')
      .eq('deals.brokerage_id', profile.brokerage_id)
      .eq('status', 'approved')
      .order('reviewed_at', { ascending: false })

    if (error) return { success: false, error: error.message }

    const byDeal: Record<string, BrokerageClosingDateChange> = {}
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const dealId = row.deal_id as string
      if (byDeal[dealId]) continue
      byDeal[dealId] = {
        deal_id: dealId,
        old_closing_date: row.old_closing_date as string | null,
        new_closing_date: row.new_closing_date as string | null,
        amendment_document_id: (row.amendment_document_id as string | null) ?? null,
      }
    }
    return { success: true, data: byDeal }
  } catch {
    return { success: false, error: 'Failed to fetch closing date changes' }
  }
}

// ============================================================================
// Admin Action: Approve Closing Date Amendment
// ============================================================================

export async function approveClosingDateAmendment(input: {
  amendmentId: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('deal.underwrite')
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

    type DealWithAgents = {
      id: string
      status: string
      property_address: string
      deal_number: string | null
      closing_date: string
      agent_id: string
      brokerage_id?: string | null
      gross_commission: number
      brokerage_split_pct: number
      brokerage_referral_pct: number | null
      settlement_days_at_funding: number | null
      advance_amount: number | null
      discount_fee?: number | null
      settlement_period_fee?: number | null
      net_commission?: number | null
      brokerage_referral_fee?: number | null
      amount_due_from_brokerage?: number | null
      brokerage_flat_fee?: number | null
      due_date?: string | null
      version?: number
      agents?: {
        id: string
        first_name: string
        last_name: string
        email: string | null
        brokerages?: { name?: string | null; logo_url?: string | null } | null
      } | null
    } | null

    const deal = amendment.deals as DealWithAgents
    if (!deal) return { success: false, error: 'Deal not found' }

    // Recalculate what fees WOULD be with the new closing date
    const newDays = calcDaysUntilClosing(amendment.new_closing_date)
    const referralPct = deal.brokerage_referral_pct ?? 0.20
    const settlementDays = deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS

    const newCalc = calculateDeal({
      grossCommission: deal.gross_commission,
      brokerageSplitPct: deal.brokerage_split_pct,
      brokerageFlatFee: Number(deal.brokerage_flat_fee ?? 0),
      daysUntilClosing: newDays,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
    })

    // Compute new due date using the deal's snapshotted settlement window
    const newClosingDateObj = new Date(amendment.new_closing_date + 'T00:00:00Z')
    const newDueDate = new Date(newClosingDateObj.getTime() + settlementDays * 24 * 60 * 60 * 1000)
    const newDueDateStr = newDueDate.toISOString().split('T')[0]

    // Branch: approved deal (full recalc) vs funded deal (lock fees, adjust balance)
    const isFunded = deal.status === 'funded'
    const oldDiscountFee = deal.discount_fee || 0
    // For funded deals, charge only the additional days between the deal's
    // current closing date and the new closing date - not a re-priced fee
    // from today onward. See computeFundedAmendmentDelta near the top of
    // this file. Approved (not-yet-funded) deals still get the full recalc
    // since no fee has been charged to the agent yet.
    //
    // CRITICAL: use the amendment's snapshotted old_closing_date as the
    // baseline, NOT deal.closing_date. If two amendments are approved in
    // sequence, the second one would otherwise compute its delta against
    // the FIRST amendment's already-applied new closing date, producing a
    // zero or negative charge instead of the correct incremental fee.
    const delta = isFunded
      ? computeFundedAmendmentDelta(
          deal.net_commission,
          amendment.old_closing_date,
          amendment.new_closing_date,
        )
      : { extraDays: 0, feeAdjustment: 0 }
    const feeAdjustment = delta.feeAdjustment
    const fundedNewDiscountFee = isFunded
      ? Math.round((oldDiscountFee + feeAdjustment) * 100) / 100
      : oldDiscountFee

    // Recompute the brokerage's profit share + remittance for the new closing
    // date (funded deals only). Bud's decision: the brokerage keeps its larger
    // share the same way it keeps every other fee, by remitting LESS at
    // settlement (net-remittance), NOT via a ledger/payout. So its referral fee
    // (profit share) rises by its cut of the extra discount fee, and the amount
    // it remits to Firm Funds drops by the same amount. Firm Funds collects the
    // agent's full extra fee separately by invoice and nets the difference.
    //
    // brokerage_share = referralPct * feeAdjustment (its cut of the extra fee)
    // new referral fee = old + share   (== referralPct * new total fees)
    // new amount due    = old - share   (== net_commission - new referral fee)
    //
    // Additive against the deal's CURRENT stored values, so stacked amendments
    // accumulate. Mirror image on a shortening (feeAdjustment < 0): share is
    // negative, so the referral fee falls and the amount due rises. The shared
    // brokerageShare keeps the (referral fee + amount due == net_commission)
    // identity exact. See docs/business/financial-model.md.
    const oldBrokerageReferralFee = Math.round(Number(deal.brokerage_referral_fee ?? 0) * 100) / 100
    const oldAmountDueFromBrokerage = Math.round(Number(deal.amount_due_from_brokerage ?? 0) * 100) / 100
    const { brokerageShare, newBrokerageReferralFee, newAmountDueFromBrokerage } = isFunded
      ? computeAmendmentBrokerageRecalc({
          referralPct,
          feeAdjustment,
          oldBrokerageReferralFee,
          oldAmountDueFromBrokerage,
        })
      : { brokerageShare: 0, newBrokerageReferralFee: oldBrokerageReferralFee, newAmountDueFromBrokerage: oldAmountDueFromBrokerage }

    // Invoice number raised for the extra fee (extensions only), hoisted so the
    // agent amendment-approved email can disclose it after the funded branch.
    let extensionInvoiceNumber: string | null = null

    // Claim the amendment atomically via CAS on status='pending'. Without
    // this guard, two admins clicking Approve at the same time both pass
    // the pre-check, both run the financial side effects, and the agent is
    // charged twice. If 0 rows are affected, someone else already claimed
    // it; abort before touching the deal or balance.
    const claimFields = isFunded
      ? {
          status: 'approved' as const,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          new_discount_fee: fundedNewDiscountFee,
          new_settlement_period_fee: deal.settlement_period_fee || 0,
          new_advance_amount: deal.advance_amount,
          new_due_date: newDueDateStr,
          fee_adjustment_amount: feeAdjustment,
          adjustment_scenario: feeAdjustment >= 0 ? 'funded_extended' : 'funded_earlier',
          // Snapshot the brokerage figures (migration 117) for the audit trail,
          // the amended CPA, and the amended-remittance notice.
          old_brokerage_referral_fee: oldBrokerageReferralFee,
          new_brokerage_referral_fee: newBrokerageReferralFee,
          old_amount_due_from_brokerage: oldAmountDueFromBrokerage,
          new_amount_due_from_brokerage: newAmountDueFromBrokerage,
        }
      : {
          status: 'approved' as const,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          new_discount_fee: newCalc.discountFee,
          new_settlement_period_fee: newCalc.settlementPeriodFee,
          new_advance_amount: newCalc.advanceAmount,
          new_due_date: newDueDateStr,
          fee_adjustment_amount: 0,
          adjustment_scenario: 'approved_recalc',
        }

    const { data: claimed, error: claimErr } = await serviceClient
      .from('closing_date_amendments')
      .update(claimFields)
      .eq('id', input.amendmentId)
      .eq('status', 'pending')
      .select()
      .maybeSingle()

    if (claimErr || !claimed) {
      return { success: false, error: 'Amendment has already been reviewed' }
    }

    if (isFunded) {
      // FUNDED: keep original Face Value, Purchase Price, and fees on the deal.
      // Only update closing_date, days_until_closing, and due_date.
      //
      // CAS on closing_date == amendment.old_closing_date so concurrent
      // amendment approvals against the same deal fail loudly here instead
      // of silently overwriting each other. The amendment claim above
      // already prevents the SAME amendment being approved twice; this guard
      // catches the case where two DIFFERENT pending amendments race past
      // approval.
      // Write the recomputed discount fee + brokerage figures alongside the
      // dates. advance_amount is intentionally NOT updated; it was disbursed at
      // funding and is locked. The extra discount fee is collected from the
      // agent by invoice (below), not deducted from the already-paid advance, so
      // after this `advance_amount !== net_commission - total_fees` on the row.
      // That identity break is expected; the admin Financial Breakdown notes it.
      const { data: updatedDeal, error: updateError } = await serviceClient
        .from('deals')
        .update({
          closing_date: amendment.new_closing_date,
          days_until_closing: newDays,
          due_date: newDueDateStr,
          discount_fee: fundedNewDiscountFee,
          brokerage_referral_fee: newBrokerageReferralFee,
          amount_due_from_brokerage: newAmountDueFromBrokerage,
        })
        .eq('id', deal.id)
        .eq('closing_date', amendment.old_closing_date)
        .select('id')
        .maybeSingle()

      if (updateError || !updatedDeal) {
        console.error(
          'Deal update error on funded amendment approve:',
          updateError?.message || 'CAS lost - closing_date changed concurrently',
        )
        // Release the amendment claim so the admin can retry once the other
        // amendment finishes (or is rejected). Without this revert the
        // amendment is stuck as approved with no fee charged.
        await serviceClient
          .from('closing_date_amendments')
          .update({
            status: 'pending',
            reviewed_by: null,
            reviewed_at: null,
          })
          .eq('id', input.amendmentId)
          .eq('status', 'approved')
        return {
          success: false,
          error: 'Deal closing date changed concurrently. Refresh and try again.',
        }
      }

      // Apply discount-fee delta via the atomic RPC. Replaces the prior
      // read-modify-write on agents.account_balance + direct INSERT into
      // agent_transactions, which violated the ledger-immutability rule
      // from migration 054 and was vulnerable to the same race that
      // migration 052 was created to prevent.
      if (Math.abs(feeAdjustment) > 0.005) {
        const extraDays = delta.extraDays
        const dayLabel = Math.abs(extraDays) === 1 ? 'day' : 'days'
        const { error: rpcErr } = await serviceClient
          .rpc('apply_agent_balance_delta', {
            p_agent_id: deal.agent_id,
            p_delta: feeAdjustment,
            p_type: feeAdjustment > 0 ? 'adjustment' : 'credit',
            p_description: feeAdjustment > 0
              ? `Closing date extension — additional discount fee for ${extraDays} extra ${dayLabel} (${deal.property_address}, new closing ${amendment.new_closing_date})`
              : `Closing date moved earlier — discount fee credit for ${Math.abs(extraDays)} fewer ${dayLabel} (${deal.property_address}, new closing ${amendment.new_closing_date})`,
            p_deal_id: deal.id,
            p_created_by: user.id,
            p_reference_id: input.amendmentId,
          })
        if (rpcErr) {
          console.error('Balance RPC error on funded amendment approve:', rpcErr.message)
          return { success: false, error: 'Failed to apply discount fee adjustment' }
        }
      }

      // A "funded_earlier" amendment credits the agent (feeAdjustment < 0) — the
      // deal now owes them a refund. Record it on the deal so completion is gated
      // until the refund is issued ("Mark refund issued"). Additive so stacked
      // amendments accumulate. Best-effort: the credit is already posted to the
      // ledger above, so a failure here is logged, not fatal.
      if (feeAdjustment < -0.005) {
        const refundAmt = Math.round(Math.abs(feeAdjustment) * 100) / 100
        const { data: refDeal } = await serviceClient
          .from('deals')
          .select('refund_owed_amount')
          .eq('id', deal.id)
          .single()
        const newOwed = Math.round(((Number(refDeal?.refund_owed_amount ?? 0)) + refundAmt) * 100) / 100
        const { error: owedErr } = await serviceClient
          .from('deals')
          .update({ refund_owed_amount: newOwed })
          .eq('id', deal.id)
        if (owedErr) {
          console.error('Failed to set refund_owed_amount on funded_earlier amendment (non-fatal):', owedErr.message)
        }
      }

      // Auto-invoice the agent for the extra discount fee (EXTENSIONS only; a
      // shortening credits the agent through the refund path above, it does not
      // bill them). The balance was already debited by the RPC above; this
      // invoice is a targeted formal bill of exactly that debt. account_balance
      // stays the single source of truth: paying the invoice (markInvoicePaid ->
      // mark_invoice_paid_atomic) subtracts the same amount back off the balance,
      // so the agent is never charged twice. Best-effort: a failure here just
      // leaves the debt on the balance for an admin to bill manually later.
      if (feeAdjustment > 0.005) {
        const dayWord = delta.extraDays === 1 ? 'day' : 'days'
        const nowIso = new Date().toISOString()
        try {
          const invoiceResult = await insertAgentInvoice(serviceClient, {
            agentId: deal.agent_id,
            amount: feeAdjustment,
            dealId: deal.id,
            dueDate: amendment.new_closing_date,
            createdBy: user.id,
            notes: `Closing-date extension fee for ${deal.property_address} (amendment ${input.amendmentId}).`,
            lineItems: [
              {
                description: `Closing date extension: additional discount fee for ${delta.extraDays} extra ${dayWord} (${deal.property_address}, new closing ${amendment.new_closing_date})`,
                amount: feeAdjustment,
                date: nowIso,
                type: 'adjustment',
              },
            ],
          })
          if (invoiceResult.success && invoiceResult.invoice) {
            extensionInvoiceNumber = (invoiceResult.invoice.invoice_number as string | undefined) ?? null
            // Email the itemized invoice (transactional). Only if the agent has
            // an email on file (agents.email is nullable by design).
            const agentForInvoice = deal.agents
            if (agentForInvoice?.email && extensionInvoiceNumber) {
              try {
                await sendInvoiceNotification({
                  invoiceNumber: extensionInvoiceNumber,
                  agentName: `${agentForInvoice.first_name} ${agentForInvoice.last_name}`,
                  agentEmail: agentForInvoice.email,
                  amount: feeAdjustment,
                  dueDate: amendment.new_closing_date,
                  lineItems: [
                    {
                      description: `Closing date extension: additional discount fee for ${delta.extraDays} extra ${dayWord} (${deal.property_address})`,
                      amount: feeAdjustment,
                      date: nowIso,
                    },
                  ],
                  agentId: deal.agent_id,
                })
              } catch (mailErr: unknown) {
                console.error('Extension invoice email failed (non-fatal):', mailErr instanceof Error ? mailErr.message : 'unknown')
              }
            }
          } else {
            console.error('Failed to create extension invoice (non-fatal):', invoiceResult.error)
          }
        } catch (invErr: unknown) {
          console.error('Extension invoice creation threw (non-fatal):', invErr instanceof Error ? invErr.message : 'unknown')
        }
      }

      // Notify the brokerage that the amended closing date changed its
      // remittance. Fires in BOTH directions when the share materially moves
      // (an extension lowers the amount due; a shortening raises it). Skipped
      // when there is no profit share (referralPct 0 -> share 0 -> amount
      // unchanged). Best-effort.
      if (Math.abs(brokerageShare) > 0.005 && deal.brokerage_id) {
        try {
          const { data: brk } = await serviceClient
            .from('brokerages')
            .select('id, name, email, broker_of_record_email')
            .eq('id', deal.brokerage_id)
            .single()
          const brokerageEmail = brk?.broker_of_record_email || brk?.email || null
          if (brokerageEmail) {
            const agentForNotice = deal.agents
            await sendAmendedRemittanceNotification({
              brokerageEmail,
              propertyAddress: deal.property_address,
              agentName: agentForNotice ? `${agentForNotice.first_name} ${agentForNotice.last_name}` : 'an agent',
              oldAmountDue: oldAmountDueFromBrokerage,
              newAmountDue: newAmountDueFromBrokerage,
              oldClosingDate: amendment.old_closing_date,
              newClosingDate: amendment.new_closing_date,
              brokerageId: deal.brokerage_id,
              dealNumber: deal.deal_number,
            })
          }
        } catch (notifyErr: unknown) {
          console.error('Amended-remittance brokerage notice failed (non-fatal):', notifyErr instanceof Error ? notifyErr.message : 'unknown')
        }
      }
    } else {
      // APPROVED (not yet funded): full recalculation, no account balance adjustment
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
        console.error('Deal update error on approved amendment approve:', updateError.message)
        return { success: false, error: 'Failed to update deal' }
      }
    }

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
    } catch (err: unknown) {
      const sendMessage = err instanceof Error ? err.message : 'Unknown error'
      console.error('Failed to send amended CPA:', sendMessage)
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
    // For funded deals, the advance amount is locked, so show the original.
    // On a funded EXTENSION, also disclose the extra discount fee + the invoice
    // raised for it (hidden before this change). Shortenings and non-funded
    // re-prices fall through to the original, advance-only email.
    const displayAdvance = isFunded ? (deal.advance_amount || 0) : newCalc.advanceAmount
    const isFundedExtension = isFunded && feeAdjustment > 0.005
    const agent = deal.agents
    if (agent?.email) {
      sendAmendmentApprovedNotification({
        dealId: deal.id,
        dealNumber: deal.deal_number,
        propertyAddress: deal.property_address,
        agentEmail: agent.email,
        agentFirstName: agent.first_name,
        agentId: deal.agent_id,
        newClosingDate: amendment.new_closing_date,
        newAdvanceAmount: displayAdvance,
        extraFee: isFundedExtension ? feeAdjustment : null,
        extraDays: isFundedExtension ? delta.extraDays : null,
        invoiceNumber: isFundedExtension ? extensionInvoiceNumber : null,
      })
    }

    return { success: true, data: { envelopeId } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Approve amendment error:', message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Admin Action: Reject Closing Date Amendment
// ============================================================================

export async function rejectClosingDateAmendment(input: {
  amendmentId: string
  // Accept either name — operational actions pass `rejectionReason`, legacy
  // callers pass `reason`. Whichever is present wins.
  reason?: string
  rejectionReason?: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('deal.underwrite')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const reason = (input.rejectionReason ?? input.reason ?? '').trim()
  if (!reason) {
    return { success: false, error: 'Rejection reason is required' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: amendment } = await serviceClient
      .from('closing_date_amendments')
      .select('*, deals(id, property_address, deal_number, agents(first_name, email))')
      .eq('id', input.amendmentId)
      .single()

    if (!amendment) return { success: false, error: 'Amendment not found' }
    if (amendment.status !== 'pending') {
      return { success: false, error: 'Amendment has already been reviewed' }
    }

    // CAS on status='pending' to prevent simultaneous reject/approve clicks
    // from both running side effects. If 0 rows are affected, someone else
    // already reviewed this amendment.
    const { data: claimed } = await serviceClient
      .from('closing_date_amendments')
      .update({
        status: 'rejected',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        rejection_reason: reason,
      })
      .eq('id', input.amendmentId)
      .eq('status', 'pending')
      .select()
      .maybeSingle()

    if (!claimed) {
      return { success: false, error: 'Amendment has already been reviewed' }
    }

    type RejectDealRef = {
      id: string
      property_address: string
      deal_number: string | null
      agents?: { first_name: string; email: string | null } | null
    } | null
    const dealRef = amendment.deals as RejectDealRef

    await logAuditEvent({
      action: 'amendment.rejected',
      entityType: 'deal',
      entityId: dealRef?.id,
      metadata: {
        amendment_id: input.amendmentId,
        reason,
      },
    })

    // Notify agent
    const deal = dealRef
    const agent = deal?.agents
    if (agent?.email && deal) {
      sendAmendmentRejectedNotification({
        dealId: deal.id,
        dealNumber: deal.deal_number,
        propertyAddress: deal.property_address,
        agentEmail: agent.email,
        agentFirstName: agent.first_name,
        reason,
      })
    }

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Reject amendment error:', message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Get amendments for a deal (used by both agent and admin)
// ============================================================================

export async function getDealAmendments(dealId: string): Promise<ActionResult> {
  // Authorization: previously this action was unauthenticated. Any logged-in
  // user (and arguably any unauthenticated caller able to invoke server
  // actions) could enumerate amendments for any deal by UUID — leaking
  // financial data (old/new closing dates, discount fees, fee adjustments,
  // rejection reasons).
  const { error: authErr, user, profile } = await getAuthenticatedUser([
    'agent',
    'brokerage_admin',
    'super_admin',
    'firm_funds_admin',
  ])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()

  try {
    const isAdmin = profile?.role === 'super_admin' || profile?.role === 'firm_funds_admin'
    if (!isAdmin) {
      const { data: deal } = await serviceClient
        .from('deals')
        .select('agent_id, brokerage_id')
        .eq('id', dealId)
        .single()
      if (!deal) return { success: false, error: 'Deal not found' }
      const isOwner =
        (profile?.role === 'agent' && deal.agent_id === profile.agent_id) ||
        (profile?.role === 'brokerage_admin' && deal.brokerage_id === profile.brokerage_id)
      if (!isOwner) return { success: false, error: 'Access denied' }
    }

    const { data, error } = await serviceClient
      .from('closing_date_amendments')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })

    if (error) return { success: false, error: error.message }
    return { success: true, data: data || [] }
  } catch {
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
  } catch {
    return { success: false, error: 'Failed to fetch pending amendments' }
  }
}

// ============================================================================
// requestClosingDateAmendment — JSON variant of submitClosingDateAmendment.
//
// The two existing FormData submit functions above require an uploaded
// executed amendment document. This JSON variant is the "operational"
// shortcut: agent or brokerage admin records that an amendment is in flight
// and admin will review with the document attached separately. Reason text
// is captured in the audit log (no DB column for it on closing_date_amendments).
//
// Optimistic-lock via deals.version (migration 083) so the request fails
// loudly if the deal was mutated between read and request.
// ============================================================================
export async function requestClosingDateAmendment(input: {
  dealId: string
  newClosingDate: string // YYYY-MM-DD
  reason: string
  expectedVersion?: number // optional optimistic lock on deals.version
}): Promise<ActionResult<{ amendment_id: string }>> {
  // Agent or brokerage_admin (covers Bud's "brokerage admins submit on behalf
  // of agents" pattern). FF admins can also call this through a back-office
  // path if needed.
  const { error: authErr, user, profile } = await getAuthenticatedUser([
    'agent',
    'brokerage_admin',
    'super_admin',
    'firm_funds_admin',
  ])
  if (authErr || !user || !profile) {
    return { success: false, error: authErr || 'Authentication failed' }
  }

  if (!input.dealId) return { success: false, error: 'dealId is required' }
  if (!input.newClosingDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.newClosingDate)) {
    return { success: false, error: 'newClosingDate must be a YYYY-MM-DD date string' }
  }
  const reason = (input.reason || '').trim()
  if (reason.length < 5) {
    return { success: false, error: 'A reason (at least 5 characters) is required' }
  }
  if (reason.length > 1000) {
    return { success: false, error: 'Reason must be 1000 characters or fewer' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    // Load the deal with everything needed for ownership check + fee math.
    const { data: deal, error: dealErr } = await serviceClient
      .from('deals')
      .select(
        'id, status, closing_date, agent_id, brokerage_id, property_address, deal_number, gross_commission, brokerage_split_pct, brokerage_flat_fee, net_commission, advance_amount, discount_fee, settlement_period_fee, due_date, brokerage_referral_pct, settlement_days_at_funding, version',
      )
      .eq('id', input.dealId)
      .single()

    if (dealErr || !deal) return { success: false, error: 'Deal not found' }

    // Ownership check based on caller role.
    const isFfAdmin =
      profile.role === 'super_admin' || profile.role === 'firm_funds_admin'
    if (!isFfAdmin) {
      if (profile.role === 'agent' && deal.agent_id !== profile.agent_id) {
        return { success: false, error: 'You do not have access to this deal' }
      }
      if (
        profile.role === 'brokerage_admin' &&
        deal.brokerage_id !== profile.brokerage_id
      ) {
        return { success: false, error: 'You do not have access to this deal' }
      }
    }

    if (!['approved', 'funded'].includes(deal.status)) {
      return {
        success: false,
        error: 'Closing date can only be amended on approved or funded deals',
      }
    }

    // Future-date check (Toronto today, same logic as calcDaysUntilClosing).
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
    if (input.newClosingDate <= todayET) {
      return { success: false, error: 'New closing date must be in the future' }
    }

    const newDays = calcDaysUntilClosing(input.newClosingDate)
    if (newDays < MIN_DAYS_UNTIL_CLOSING || newDays > MAX_DAYS_UNTIL_CLOSING) {
      return {
        success: false,
        error: `New closing date must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING} days from today`,
      }
    }
    if (input.newClosingDate === deal.closing_date) {
      return { success: false, error: 'New closing date is the same as the current closing date' }
    }

    // Optimistic lock — fail loudly if the deal was edited (e.g. status flip,
    // closing-date change) between caller's read and this request.
    if (typeof input.expectedVersion === 'number' && deal.version !== input.expectedVersion) {
      return {
        success: false,
        error: 'Deal was modified by another session. Refresh and try again.',
      }
    }

    // Block if there's already a pending amendment (mirrors the FormData flow
    // and the partial unique index from migration 070).
    const { data: existingPending } = await serviceClient
      .from('closing_date_amendments')
      .select('id')
      .eq('deal_id', deal.id)
      .eq('status', 'pending')
      .limit(1)
    if (existingPending && existingPending.length > 0) {
      return {
        success: false,
        error: 'There is already a pending amendment request for this deal. Please wait for admin review.',
      }
    }

    // Compute new fees + due date the same way the FormData flow does, so
    // the admin sees the same numbers on approval. Settlement window is
    // snapshotted at funding for funded deals.
    const referralPct = deal.brokerage_referral_pct || 0.20
    const settlementDays = deal.settlement_days_at_funding ?? SETTLEMENT_PERIOD_DAYS
    const newCalc = calculateDeal({
      grossCommission: deal.gross_commission,
      brokerageSplitPct: deal.brokerage_split_pct,
      brokerageFlatFee: Number(deal.brokerage_flat_fee ?? 0),
      daysUntilClosing: newDays,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
    })
    const newClosingDateObj = new Date(input.newClosingDate + 'T00:00:00Z')
    const newDueDate = new Date(newClosingDateObj.getTime() + settlementDays * 24 * 60 * 60 * 1000)
    const newDueDateStr = newDueDate.toISOString().split('T')[0]

    // Compute fee delta — funded deals lock fees and only delta the discount
    // portion for the extra/saved days. Mirrors computeFundedAmendmentDelta.
    let scenario: 'approved_recalc' | 'funded_extended' | 'funded_earlier' = 'approved_recalc'
    let feeAdjustment = 0
    let newDiscountFeeStored = newCalc.discountFee
    let newSettlementFeeStored = newCalc.settlementPeriodFee
    let newAdvanceAmountStored = newCalc.advanceAmount

    if (deal.status === 'funded') {
      const oldDiscountFee = deal.discount_fee || 0
      const oldClosingMs = new Date((deal.closing_date as string) + 'T00:00:00Z').getTime()
      const newClosingMs = new Date(input.newClosingDate + 'T00:00:00Z').getTime()
      const extraDays = Math.round((newClosingMs - oldClosingMs) / 86400000)
      const dailyRate = DISCOUNT_RATE_PER_1000_PER_DAY / 1000
      feeAdjustment =
        Math.round((deal.net_commission || 0) * dailyRate * extraDays * 100) / 100
      newDiscountFeeStored = Math.round((oldDiscountFee + feeAdjustment) * 100) / 100
      newSettlementFeeStored = deal.settlement_period_fee || 0
      newAdvanceAmountStored = deal.advance_amount
      scenario = feeAdjustment >= 0 ? 'funded_extended' : 'funded_earlier'
    }

    const { data: amendment, error: amendError } = await serviceClient
      .from('closing_date_amendments')
      .insert({
        deal_id: deal.id,
        requested_by: user.id,
        old_closing_date: deal.closing_date,
        new_closing_date: input.newClosingDate,
        status: 'pending',
        old_discount_fee: deal.discount_fee,
        new_discount_fee: newDiscountFeeStored,
        old_settlement_period_fee: deal.settlement_period_fee || 0,
        new_settlement_period_fee: newSettlementFeeStored,
        old_advance_amount: deal.advance_amount,
        new_advance_amount: newAdvanceAmountStored,
        old_due_date: deal.due_date,
        new_due_date: newDueDateStr,
        fee_adjustment_amount: feeAdjustment,
        adjustment_scenario: scenario,
      })
      .select('id')
      .single()

    if (amendError || !amendment) {
      console.error('requestClosingDateAmendment insert error:', amendError?.message)
      return { success: false, error: 'Failed to create amendment request' }
    }

    await logAuditEvent({
      action: 'amendment.requested',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        amendment_id: amendment.id,
        old_closing_date: deal.closing_date,
        new_closing_date: input.newClosingDate,
        requested_by: user.id,
        requested_by_role: profile.role,
        request_path: 'json_no_document',
        reason,
        fee_adjustment_amount: feeAdjustment,
        scenario,
      },
    })

    // Notify admin so they can review (matches the FormData flow).
    const { data: agentData } = await serviceClient
      .from('agents')
      .select('first_name, last_name')
      .eq('id', deal.agent_id)
      .single()
    if (agentData) {
      try {
        await sendAmendmentRequestedNotification({
          dealId: deal.id,
          dealNumber: deal.deal_number,
          propertyAddress: deal.property_address,
          agentName: `${agentData.first_name} ${agentData.last_name}`,
          oldClosingDate: deal.closing_date,
          newClosingDate: input.newClosingDate,
        })
      } catch (notifyErr: unknown) {
        const notifyMessage = notifyErr instanceof Error ? notifyErr.message : 'Unknown error'
        console.warn('[requestClosingDateAmendment] notify failed (non-fatal):', notifyMessage)
      }
    }

    return { success: true, data: { amendment_id: amendment.id } }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('requestClosingDateAmendment error:', message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}
