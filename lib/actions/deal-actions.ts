'use server'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { calculateDeal } from '@/lib/calculations'
import { DealSubmissionSchema, DealStatusChangeSchema } from '@/lib/validations'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  MIN_DAYS_UNTIL_CLOSING,
  MAX_DAYS_UNTIL_CLOSING,
  MAX_UPLOAD_SIZE_BYTES,
  ALLOWED_UPLOAD_MIME_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  VALID_DOCUMENT_TYPE_VALUES,
  VALID_UPLOAD_SOURCES,
  calcDaysUntilClosing,
} from '@/lib/constants'
import { logAuditEvent } from '@/lib/audit'
import {
  sendNewDealNotification,
  sendBrokerageAdminNewDealNotification,
  sendStatusChangeNotification,
  sendDocumentUploadedNotification,
  sendDocumentRequestNotification,
} from '@/lib/email'

// ============================================================================
// Types
// ============================================================================

interface ActionResult {
  success: boolean
  error?: string
  data?: Record<string, any>
}

interface DealPreviewInput {
  grossCommission: number
  brokerageSplitPct: number
  closingDate: string
  agentId: string
}

// ============================================================================
// Helper: get authenticated user + profile
// ============================================================================

async function getAuthenticatedUser(requiredRoles?: string[]) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: 'Not authenticated', user: null, profile: null, supabase }
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return { error: 'User profile not found', user, profile: null, supabase }
  }

  if (requiredRoles && !requiredRoles.includes(profile.role)) {
    return { error: 'Insufficient permissions', user, profile, supabase }
  }

  return { error: null, user, profile, supabase }
}

// ============================================================================
// Server Action: Calculate deal preview (no DB write)
// ============================================================================

export async function calculateDealPreview(input: DealPreviewInput): Promise<ActionResult> {
  const { error: authErr, supabase } = await getAuthenticatedUser(['agent'])
  if (authErr) return { success: false, error: authErr }

  try {
    const daysUntilClosing = calcDaysUntilClosing(input.closingDate)

    if (daysUntilClosing < MIN_DAYS_UNTIL_CLOSING || daysUntilClosing > MAX_DAYS_UNTIL_CLOSING) {
      return { success: false, error: `Closing date must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING} days from today` }
    }

    // Look up the agent's brokerage to get the real referral fee percentage
    const { data: agentData } = await supabase
      .from('agents')
      .select('brokerage_id, brokerages(referral_fee_percentage)')
      .eq('id', input.agentId)
      .single()

    const brokerage = (agentData as any)?.brokerages
    const referralPct = brokerage?.referral_fee_percentage

    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee not configured. Please contact support.' }
    }

    const result = calculateDeal({
      grossCommission: input.grossCommission,
      brokerageSplitPct: input.brokerageSplitPct,
      daysUntilClosing,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
    })

    return {
      success: true,
      data: {
        ...result,
        daysUntilClosing,
        brokerageReferralPct: referralPct,
      },
    }
  } catch (err: any) {
    console.error('Deal preview calculation error:', err?.message)
    return { success: false, error: 'Failed to calculate deal preview. Please check your inputs.' }
  }
}

// ============================================================================
// Server Action: Submit a new deal
// ============================================================================

export async function submitDeal(formData: {
  propertyAddress: string
  closingDate: string
  grossCommission: number
  brokerageSplitPct: number
  transactionType: string
  notes?: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['agent'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  // Validate inputs with Zod
  const validation = DealSubmissionSchema.safeParse({
    propertyAddress: formData.propertyAddress,
    closingDate: formData.closingDate,
    grossCommission: formData.grossCommission,
    brokerageSplitPct: formData.brokerageSplitPct,
    notes: formData.notes,
  })

  if (!validation.success) {
    const firstError = validation.error.issues[0]?.message || 'Invalid input'
    return { success: false, error: firstError }
  }

  try {
    // Get agent record
    if (!profile.agent_id) {
      return { success: false, error: 'No agent profile linked to your account' }
    }

    const { data: agentData, error: agentError } = await supabase
      .from('agents')
      .select('*, brokerages(*)')
      .eq('id', profile.agent_id)
      .single()

    if (agentError || !agentData) {
      return { success: false, error: 'Agent profile not found' }
    }

    if (!agentData.brokerage_id) {
      return { success: false, error: 'No brokerage associated with your agent profile' }
    }

    const brokerage = agentData.brokerages
    const referralPct = brokerage?.referral_fee_percentage

    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee percentage is not configured. Please contact your brokerage admin.' }
    }

    // Calculate days until closing (Eastern Time)
    const daysUntilClosing = calcDaysUntilClosing(formData.closingDate)

    // Server-side financial calculations using the shared library
    const calc = calculateDeal({
      grossCommission: formData.grossCommission,
      brokerageSplitPct: formData.brokerageSplitPct,
      daysUntilClosing,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
    })

    if (calc.advanceAmount <= 0) {
      return { success: false, error: 'The discount fee exceeds the net commission. This deal cannot be advanced.' }
    }

    // Build notes with transaction type
    const noteText = `Transaction type: ${formData.transactionType}${formData.notes?.trim() ? '\n' + formData.notes.trim() : ''}`

    // Insert the deal with server-calculated values
    const { data: newDeal, error: insertError } = await supabase
      .from('deals')
      .insert({
        agent_id: agentData.id,
        brokerage_id: agentData.brokerage_id,
        status: 'under_review',
        property_address: validation.data.propertyAddress,
        closing_date: formData.closingDate,
        gross_commission: formData.grossCommission,
        brokerage_split_pct: formData.brokerageSplitPct,
        net_commission: calc.netCommission,
        days_until_closing: daysUntilClosing,
        discount_fee: calc.discountFee,
        advance_amount: calc.advanceAmount,
        brokerage_referral_fee: calc.brokerageReferralFee,
        amount_due_from_brokerage: calc.amountDueFromBrokerage,
        source: 'manual_portal',
        notes: noteText,
      })
      .select()
      .single()

    if (insertError) {
      console.error('Deal insert error:', insertError.message, insertError.details, insertError.hint)
      return { success: false, error: `Failed to submit deal: ${insertError.message}` }
    }

    // Audit log
    await logAuditEvent({
      action: 'deal.submit',
      entityType: 'deal',
      entityId: newDeal.id,
      metadata: {
        property_address: validation.data.propertyAddress,
        advance_amount: calc.advanceAmount,
        agent_id: agentData.id,
        brokerage_id: agentData.brokerage_id,
      },
    })

    // Email notification → Firm Funds admin
    sendNewDealNotification({
      dealId: newDeal.id,
      propertyAddress: validation.data.propertyAddress,
      advanceAmount: calc.advanceAmount,
      agentName: `${agentData.first_name} ${agentData.last_name}`,
      brokerageName: brokerage?.name || 'Unknown Brokerage',
    })

    // Email notification → brokerage admin(s)
    const { data: brokerageAdmins } = await supabase
      .from('user_profiles')
      .select('email, full_name')
      .eq('brokerage_id', agentData.brokerage_id)
      .eq('role', 'brokerage_admin')
      .eq('is_active', true)

    if (brokerageAdmins && brokerageAdmins.length > 0) {
      for (const admin of brokerageAdmins) {
        sendBrokerageAdminNewDealNotification({
          dealId: newDeal.id,
          propertyAddress: validation.data.propertyAddress,
          advanceAmount: calc.advanceAmount,
          agentName: `${agentData.first_name} ${agentData.last_name}`,
          brokerageAdminEmail: admin.email,
          brokerageAdminFirstName: admin.full_name?.split(' ')[0] || 'Admin',
          brokerageName: brokerage?.name || 'Unknown Brokerage',
        })
      }
    }

    return {
      success: true,
      data: {
        dealId: newDeal.id,
        advanceAmount: calc.advanceAmount,
        netCommission: calc.netCommission,
        discountFee: calc.discountFee,
        daysUntilClosing,
        brokerageReferralFee: calc.brokerageReferralFee,
        amountDueFromBrokerage: calc.amountDueFromBrokerage,
      },
    }
  } catch (err: any) {
    console.error('Deal submission error:', err?.message)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Server Action: Update deal status (admin only)
// ============================================================================

export async function updateDealStatus(input: {
  dealId: string
  newStatus: string
  denialReason?: string
  repaymentAmount?: number
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  // Validate with Zod
  const validation = DealStatusChangeSchema.safeParse({
    dealId: input.dealId,
    newStatus: input.newStatus,
    denialReason: input.denialReason,
  })

  if (!validation.success) {
    const firstError = validation.error.issues[0]?.message || 'Invalid input'
    return { success: false, error: firstError }
  }

  try {
    // Fetch the deal
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    // Validate status transition (includes backward transitions)
    const STATUS_FLOW: Record<string, string[]> = {
      under_review: ['approved', 'denied', 'cancelled'],
      approved: ['funded', 'denied', 'cancelled', 'under_review'],
      funded: ['repaid', 'approved'],
      denied: ['under_review'],
      cancelled: ['under_review'],
      repaid: ['closed', 'funded'],
    }

    const allowedTransitions = STATUS_FLOW[deal.status] || []
    if (!allowedTransitions.includes(input.newStatus)) {
      return { success: false, error: `Cannot transition from "${deal.status}" to "${input.newStatus}"` }
    }

    // Require denial reason
    if (input.newStatus === 'denied' && !input.denialReason?.trim()) {
      return { success: false, error: 'Denial reason is required' }
    }

    // Build update payload
    const updateData: Record<string, any> = { status: input.newStatus }

    if (input.newStatus === 'denied') {
      updateData.denial_reason = input.denialReason!.trim()
    }

    // Clear denial reason when reverting from denied
    if (deal.status === 'denied' && input.newStatus === 'under_review') {
      updateData.denial_reason = null
    }

    // Clear repayment date and amount when reverting from repaid
    if (deal.status === 'repaid' && input.newStatus === 'funded') {
      updateData.repayment_date = null
      updateData.repayment_amount = null
    }

    if (input.newStatus === 'funded') {
      updateData.funding_date = new Date().toISOString().split('T')[0]

      // Recalculate financials server-side using actual days from today (Eastern Time) to closing
      const actualDays = Math.max(1, calcDaysUntilClosing(deal.closing_date))

      // Fetch brokerage for referral fee
      const { data: brokerage } = await supabase
        .from('brokerages')
        .select('referral_fee_percentage')
        .eq('id', deal.brokerage_id)
        .single()

      const referralPct = brokerage?.referral_fee_percentage
      if (referralPct === null || referralPct === undefined) {
        return { success: false, error: 'Brokerage referral fee percentage is not configured. Cannot fund deal.' }
      }

      const calc = calculateDeal({
        grossCommission: deal.gross_commission,
        brokerageSplitPct: deal.brokerage_split_pct,
        daysUntilClosing: actualDays,
        discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
        brokerageReferralPct: referralPct,
      })

      updateData.days_until_closing = actualDays
      updateData.discount_fee = calc.discountFee
      updateData.advance_amount = calc.advanceAmount
      updateData.brokerage_referral_fee = calc.brokerageReferralFee
      updateData.amount_due_from_brokerage = calc.amountDueFromBrokerage
    }

    if (input.newStatus === 'repaid') {
      updateData.repayment_date = new Date().toISOString().split('T')[0]
      if (input.repaymentAmount !== undefined) {
        updateData.repayment_amount = input.repaymentAmount
      }
    }

    // Execute update with optimistic lock: only update if status hasn't changed
    // This prevents two admins from simultaneously funding/approving the same deal
    const { data: updatedRows, error: updateError } = await supabase
      .from('deals')
      .update(updateData)
      .eq('id', deal.id)
      .eq('status', deal.status) // optimistic lock — fails if another admin changed status first
      .select()

    if (updateError) {
      console.error('Deal status update error:', updateError.message, updateError.details, updateError.hint)
      return { success: false, error: `Failed to update deal status: ${updateError.message}` }
    }

    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: 'Deal status was changed by another user. Please refresh and try again.' }
    }

    // Audit log
    await logAuditEvent({
      action: 'deal.status_change',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        old_status: deal.status,
        new_status: input.newStatus,
        denial_reason: input.denialReason || null,
        recalculated: input.newStatus === 'funded',
      },
    })

    // Email notification → agent
    // Look up the agent's email and name
    const { data: agentInfo } = await supabase
      .from('agents')
      .select('first_name, last_name, email')
      .eq('id', deal.agent_id)
      .single()

    if (agentInfo?.email) {
      sendStatusChangeNotification({
        dealId: deal.id,
        propertyAddress: deal.property_address,
        oldStatus: deal.status,
        newStatus: input.newStatus,
        agentEmail: agentInfo.email,
        agentFirstName: agentInfo.first_name,
        denialReason: input.denialReason,
      })
    }

    return {
      success: true,
      data: updateData,
    }
  } catch (err: any) {
    console.error('Deal status change error:', err?.message)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Server Action: Toggle underwriting checklist item (admin only)
// ============================================================================

export async function toggleChecklistItem(input: {
  itemId: string
  isChecked: boolean
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { error } = await supabase
      .from('underwriting_checklist')
      .update({
        is_checked: input.isChecked,
        checked_by: input.isChecked ? user.id : null,
        checked_at: input.isChecked ? new Date().toISOString() : null,
      })
      .eq('id', input.itemId)

    if (error) {
      console.error('Checklist toggle error:', error.message)
      return { success: false, error: 'Failed to update checklist item' }
    }

    return { success: true }
  } catch (err: any) {
    console.error('Checklist toggle error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Delete document (admin only)
// ============================================================================

export async function deleteDocument(input: {
  documentId: string
  filePath: string
}): Promise<ActionResult> {
  const { error: authErr, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr) return { success: false, error: authErr }

  try {
    // Delete from storage
    await supabase.storage.from('deal-documents').remove([input.filePath])

    // Delete metadata from DB
    const { error: dbError } = await supabase
      .from('deal_documents')
      .delete()
      .eq('id', input.documentId)

    if (dbError) {
      console.error('Document delete error:', dbError.message)
      return { success: false, error: 'Failed to delete document record' }
    }

    // Audit log
    await logAuditEvent({
      action: 'document.delete',
      entityType: 'document',
      entityId: input.documentId,
      metadata: { file_path: input.filePath },
    })

    return { success: true }
  } catch (err: any) {
    console.error('Document delete error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Generate signed download URL
// ============================================================================

export async function getDocumentSignedUrl(input: {
  documentId: string
  filePath: string
  dealId: string
}): Promise<ActionResult> {
  // Allow admins, agents, and brokerage admins (RLS handles per-deal access)
  const { error: authErr, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin', 'agent', 'brokerage_admin'])
  if (authErr) return { success: false, error: authErr }

  try {
    const { data, error } = await supabase.storage
      .from('deal-documents')
      .createSignedUrl(input.filePath, 3600, { download: false })

    if (error) {
      console.error('Signed URL error:', error.message)
      return { success: false, error: 'Failed to generate download link' }
    }

    return { success: true, data: { signedUrl: data.signedUrl } }
  } catch (err: any) {
    console.error('Signed URL error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Upload document with server-side validation
// ============================================================================

export async function uploadDocument(formData: FormData): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['agent', 'brokerage_admin', 'super_admin', 'firm_funds_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const file = formData.get('file') as File | null
    const dealId = formData.get('dealId') as string | null
    const documentType = formData.get('documentType') as string | null

    if (!file || !dealId || !documentType) {
      return { success: false, error: 'Missing required fields' }
    }

    // Validate deal exists and user has access
    if (profile.role === 'agent') {
      const { data: deal, error: dealError } = await supabase
        .from('deals')
        .select('id, agent_id')
        .eq('id', dealId)
        .single()

      if (dealError || !deal) {
        return { success: false, error: 'Deal not found' }
      }

      if (deal.agent_id !== profile.agent_id) {
        return { success: false, error: 'You do not have access to this deal' }
      }
    } else if (profile.role === 'brokerage_admin') {
      // Brokerage admins can only upload to deals belonging to their brokerage
      const { data: deal, error: dealError } = await supabase
        .from('deals')
        .select('id, brokerage_id')
        .eq('id', dealId)
        .single()

      if (dealError || !deal) {
        return { success: false, error: 'Deal not found' }
      }

      if (deal.brokerage_id !== profile.brokerage_id) {
        return { success: false, error: 'You do not have access to this deal' }
      }
    }

    // Validate document type
    if (!(VALID_DOCUMENT_TYPE_VALUES as readonly string[]).includes(documentType)) {
      return { success: false, error: 'Invalid document type' }
    }

    // Validate file size
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return { success: false, error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB` }
    }

    if (file.size === 0) {
      return { success: false, error: 'File is empty' }
    }

    // Validate file extension
    const fileName = file.name.toLowerCase()
    const ext = '.' + fileName.split('.').pop()
    if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext as any)) {
      return { success: false, error: `File type not allowed. Accepted: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}` }
    }

    // Validate MIME type
    if (!ALLOWED_UPLOAD_MIME_TYPES.includes(file.type as any)) {
      return { success: false, error: 'File MIME type not allowed' }
    }

    // Generate safe file path
    const timestamp = Date.now()
    const randomId = crypto.randomUUID()
    const safePath = `${dealId}/${timestamp}_${randomId}${ext}`

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('deal-documents')
      .upload(safePath, file)

    if (uploadError) {
      console.error('Storage upload error:', uploadError.message)
      return { success: false, error: 'Failed to upload file. Please try again.' }
    }

    // Insert metadata
    const { data: docRecord, error: insertError } = await supabase
      .from('deal_documents')
      .insert({
        deal_id: dealId,
        uploaded_by: user.id,
        document_type: documentType,
        file_name: file.name,
        file_path: safePath,
        file_size: file.size,
        upload_source: 'manual_upload' as const,
      })
      .select()
      .single()

    if (insertError) {
      // Clean up uploaded file if DB insert fails
      await supabase.storage.from('deal-documents').remove([safePath])
      console.error('Document record insert error:', insertError.message)
      return { success: false, error: 'Failed to save document record. Please try again.' }
    }

    // Audit log
    await logAuditEvent({
      action: 'document.upload',
      entityType: 'document',
      entityId: docRecord.id,
      metadata: {
        deal_id: dealId,
        document_type: documentType,
        file_name: file.name,
        file_size: file.size,
      },
    })

    // Email notification → admin (only when agent uploads, not admin-to-admin)
    if (profile.role === 'agent' || profile.role === 'brokerage_admin') {
      // Look up deal info for the email
      const { data: dealInfo } = await supabase
        .from('deals')
        .select('property_address, agent_id, agents(first_name, last_name)')
        .eq('id', dealId)
        .single()

      const agent = (dealInfo as any)?.agents
      const uploaderName = profile.full_name || 'Unknown User'

      sendDocumentUploadedNotification({
        dealId,
        propertyAddress: dealInfo?.property_address || 'Unknown Property',
        documentType,
        fileName: file.name,
        agentName: agent ? `${agent.first_name} ${agent.last_name}` : 'Unknown Agent',
        uploaderRole: profile.role,
        uploaderName,
      })
    }

    return {
      success: true,
      data: {
        id: docRecord.id,
        deal_id: dealId,
        document_type: documentType,
        file_name: file.name,
        file_path: safePath,
        file_size: file.size,
        upload_source: 'manual_upload',
        created_at: docRecord.created_at,
        uploaded_by: user.id,
      },
    }
  } catch (err: any) {
    console.error('Document upload error:', err?.message)
    return { success: false, error: 'An unexpected error occurred during upload' }
  }
}

// ============================================================================
// Server Action: Update deal details (agent only, while status is 'under_review')
// ============================================================================

export async function updateDealDetails(input: {
  dealId: string
  propertyAddress: string
  closingDate: string
  grossCommission: number
  brokerageSplitPct: number
  notes?: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['agent'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Fetch the deal and verify ownership
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }
    if (deal.agent_id !== profile.agent_id) return { success: false, error: 'You do not have access to this deal' }
    if (deal.status !== 'under_review') return { success: false, error: 'Only deals in "Under Review" status can be edited' }

    // Get agent + brokerage data
    const { data: agentData } = await supabase
      .from('agents')
      .select('*, brokerages(*)')
      .eq('id', profile.agent_id)
      .single()

    if (!agentData) return { success: false, error: 'Agent profile not found' }
    const brokerage = agentData.brokerages
    const referralPct = brokerage?.referral_fee_percentage
    if (referralPct === null || referralPct === undefined) return { success: false, error: 'Brokerage referral fee not configured' }

    // Recalculate financials (Eastern Time)
    const daysUntilClosing = calcDaysUntilClosing(input.closingDate)

    if (daysUntilClosing < MIN_DAYS_UNTIL_CLOSING || daysUntilClosing > MAX_DAYS_UNTIL_CLOSING) {
      return { success: false, error: `Closing date must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING} days from today` }
    }

    const calc = calculateDeal({
      grossCommission: input.grossCommission,
      brokerageSplitPct: input.brokerageSplitPct,
      daysUntilClosing,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
    })

    if (calc.advanceAmount <= 0) {
      return { success: false, error: 'The discount fee exceeds the net commission. This deal cannot be advanced.' }
    }

    const { data: updatedDeal, error: updateError } = await supabase
      .from('deals')
      .update({
        property_address: input.propertyAddress,
        closing_date: input.closingDate,
        gross_commission: input.grossCommission,
        brokerage_split_pct: input.brokerageSplitPct,
        net_commission: calc.netCommission,
        days_until_closing: daysUntilClosing,
        discount_fee: calc.discountFee,
        advance_amount: calc.advanceAmount,
        brokerage_referral_fee: calc.brokerageReferralFee,
        amount_due_from_brokerage: calc.amountDueFromBrokerage,
        notes: input.notes || deal.notes,
      })
      .eq('id', input.dealId)
      .select()
      .single()

    if (updateError) {
      console.error('Deal update error:', updateError.message)
      return { success: false, error: 'Failed to update deal' }
    }

    await logAuditEvent({
      action: 'deal.edit',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { property_address: input.propertyAddress, advance_amount: calc.advanceAmount },
    })

    return { success: true, data: updatedDeal }
  } catch (err: any) {
    console.error('Deal update error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Cancel deal (agent only — before funding)
// ============================================================================

export async function cancelDeal(input: { dealId: string }): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['agent'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }
    if (deal.agent_id !== profile.agent_id) return { success: false, error: 'You do not have access to this deal' }

    // Agent can only cancel before funding (under_review or approved)
    if (!['under_review', 'approved'].includes(deal.status)) {
      return { success: false, error: 'This deal can no longer be cancelled. Contact support if you need assistance.' }
    }

    // Use service role client for the update to bypass RLS
    const adminClient = createServiceRoleClient()
    const { data: updatedDeal, error: updateError } = await adminClient
      .from('deals')
      .update({ status: 'cancelled' })
      .eq('id', input.dealId)
      .eq('status', deal.status) // optimistic lock
      .select()
      .single()

    if (updateError) {
      console.error('Deal cancel error:', updateError.message)
      return { success: false, error: `Failed to cancel deal: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'deal.cancel',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { old_status: deal.status, cancelled_by: user.id },
    })

    return { success: true, data: updatedDeal }
  } catch (err: any) {
    console.error('Deal cancel error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Delete deal (admin only — TEMPORARY for testing)
// ============================================================================

export async function deleteDeal(input: { dealId: string }): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // 1. Get all documents for this deal to clean up storage
    const { data: docs } = await supabase
      .from('deal_documents')
      .select('file_path')
      .eq('deal_id', input.dealId)

    // 2. Delete files from storage
    if (docs && docs.length > 0) {
      await supabase.storage
        .from('deal-documents')
        .remove(docs.map(d => d.file_path))
    }

    // 3. Delete related records (order matters for FK constraints)
    await supabase.from('deal_documents').delete().eq('deal_id', input.dealId)
    await supabase.from('underwriting_checklist').delete().eq('deal_id', input.dealId)

    // 4. Delete the deal itself
    const { error: deleteError } = await supabase
      .from('deals')
      .delete()
      .eq('id', input.dealId)

    if (deleteError) {
      console.error('Deal delete error:', deleteError.message)
      return { success: false, error: `Failed to delete deal: ${deleteError.message}` }
    }

    await logAuditEvent({
      action: 'deal.delete',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { deleted_by: user.id, note: 'Temporary testing feature' },
    })

    return { success: true }
  } catch (err: any) {
    console.error('Deal delete error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Request document from agent (admin only)
// ============================================================================

export async function requestDocument(input: {
  dealId: string
  documentType: string
  message?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Validate document type
    if (!(VALID_DOCUMENT_TYPE_VALUES as readonly string[]).includes(input.documentType)) {
      return { success: false, error: 'Invalid document type' }
    }

    // Fetch deal + agent info
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, property_address, agent_id')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }

    const { data: agent } = await supabase
      .from('agents')
      .select('first_name, email')
      .eq('id', deal.agent_id)
      .single()

    if (!agent?.email) return { success: false, error: 'Agent email not found' }

    // Write to document_requests table
    const { data: docRequest, error: insertError } = await supabase
      .from('document_requests')
      .insert({
        deal_id: deal.id,
        document_type: input.documentType,
        message: input.message?.trim() || null,
        requested_by: user.id,
        status: 'pending',
      })
      .select()
      .single()

    if (insertError) {
      console.error('Document request insert error:', insertError.message)
      return { success: false, error: `Failed to save document request: ${insertError.message}` }
    }

    // Send the email notification
    sendDocumentRequestNotification({
      dealId: deal.id,
      propertyAddress: deal.property_address,
      documentType: input.documentType,
      agentEmail: agent.email,
      agentFirstName: agent.first_name,
      message: input.message?.trim() || undefined,
    })

    // Audit log
    await logAuditEvent({
      action: 'document.request',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        document_type: input.documentType,
        message: input.message?.trim() || null,
        requested_by: user.id,
        agent_email: agent.email,
        request_id: docRequest.id,
      },
    })

    return { success: true, data: { requestId: docRequest.id } }
  } catch (err: any) {
    console.error('Document request error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Fulfill document request (admin only)
// ============================================================================

export async function fulfillDocumentRequest(input: {
  requestId: string
  documentId?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: request, error: fetchError } = await supabase
      .from('document_requests')
      .select('id, deal_id, document_type, status')
      .eq('id', input.requestId)
      .single()

    if (fetchError || !request) return { success: false, error: 'Document request not found' }
    if (request.status !== 'pending') return { success: false, error: 'Request is not pending' }

    const { error: updateError } = await supabase
      .from('document_requests')
      .update({
        status: 'fulfilled',
        fulfilled_at: new Date().toISOString(),
        fulfilled_document_id: input.documentId || null,
      })
      .eq('id', input.requestId)

    if (updateError) {
      console.error('Fulfill request error:', updateError.message)
      return { success: false, error: `Failed to fulfill request: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'document.request_fulfilled',
      entityType: 'deal',
      entityId: request.deal_id,
      metadata: {
        request_id: input.requestId,
        document_type: request.document_type,
        fulfilled_by: user.id,
        document_id: input.documentId || null,
      },
    })

    return { success: true }
  } catch (err: any) {
    console.error('Fulfill request error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Cancel document request (admin only)
// ============================================================================

export async function cancelDocumentRequest(input: {
  requestId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: request, error: fetchError } = await supabase
      .from('document_requests')
      .select('id, deal_id, document_type, status')
      .eq('id', input.requestId)
      .single()

    if (fetchError || !request) return { success: false, error: 'Document request not found' }
    if (request.status !== 'pending') return { success: false, error: 'Request is not pending' }

    const { error: updateError } = await supabase
      .from('document_requests')
      .update({ status: 'cancelled' })
      .eq('id', input.requestId)

    if (updateError) {
      return { success: false, error: `Failed to cancel request: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'document.request_cancelled',
      entityType: 'deal',
      entityId: request.deal_id,
      metadata: { request_id: input.requestId, cancelled_by: user.id },
    })

    return { success: true }
  } catch (err: any) {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Save Admin Notes
// ============================================================================

export async function saveAdminNotes(input: { dealId: string; adminNotes: string }): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { error: updateError } = await supabase
      .from('deals')
      .update({ admin_notes: input.adminNotes.trim() || null })
      .eq('id', input.dealId)

    if (updateError) {
      console.error('Admin notes save error:', updateError.message)
      return { success: false, error: `Failed to save notes: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'deal.admin_notes_updated',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { updated_by: user.id },
    })

    return { success: true, data: { admin_notes: input.adminNotes.trim() || null } }
  } catch (err: any) {
    console.error('Admin notes save error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Add admin note (append to JSONB timeline)
// ============================================================================

export async function addAdminNote(input: { dealId: string; note: string }): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  const noteText = input.note.trim()
  if (!noteText) return { success: false, error: 'Note cannot be empty' }

  try {
    // Fetch current timeline
    const { data: deal, error: fetchError } = await supabase
      .from('deals')
      .select('admin_notes_timeline')
      .eq('id', input.dealId)
      .single()

    if (fetchError) {
      return { success: false, error: `Failed to fetch deal: ${fetchError.message}` }
    }

    const timeline = Array.isArray(deal?.admin_notes_timeline) ? deal.admin_notes_timeline : []

    const newEntry = {
      id: crypto.randomUUID(),
      text: noteText,
      author_id: user.id,
      author_name: profile.full_name || user.email || 'Admin',
      created_at: new Date().toISOString(),
    }

    timeline.push(newEntry)

    const { error: updateError } = await supabase
      .from('deals')
      .update({ admin_notes_timeline: timeline })
      .eq('id', input.dealId)

    if (updateError) {
      console.error('Admin note add error:', updateError.message)
      return { success: false, error: `Failed to add note: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'deal.admin_note_added',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { author: profile.full_name, note_preview: noteText.substring(0, 100) },
    })

    return { success: true, data: { timeline, newEntry } }
  } catch (err: any) {
    console.error('Admin note add error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Update closing date + recalculate financials (admin only)
// ============================================================================

export async function updateClosingDate(input: {
  dealId: string
  newClosingDate: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Fetch the deal
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*, brokerages(referral_fee_percentage)')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    const newDays = calcDaysUntilClosing(input.newClosingDate)
    if (newDays < MIN_DAYS_UNTIL_CLOSING) {
      return { success: false, error: `New closing date must be at least ${MIN_DAYS_UNTIL_CLOSING} days from today` }
    }

    const referralPct = (deal as any).brokerages?.referral_fee_percentage
    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee not configured' }
    }

    // Recalculate with new days
    const newCalc = calculateDeal({
      grossCommission: deal.gross_commission,
      brokerageSplitPct: deal.brokerage_split_pct,
      daysUntilClosing: newDays,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
    })

    // Store old values for comparison
    const oldValues = {
      closing_date: deal.closing_date,
      days_until_closing: deal.days_until_closing,
      discount_fee: deal.discount_fee,
      advance_amount: deal.advance_amount,
      brokerage_referral_fee: deal.brokerage_referral_fee,
      amount_due_from_brokerage: deal.amount_due_from_brokerage,
    }

    const { error: updateError } = await supabase
      .from('deals')
      .update({
        closing_date: input.newClosingDate,
        days_until_closing: newDays,
        discount_fee: newCalc.discountFee,
        advance_amount: newCalc.advanceAmount,
        brokerage_referral_fee: newCalc.brokerageReferralFee,
        amount_due_from_brokerage: newCalc.amountDueFromBrokerage,
      })
      .eq('id', input.dealId)

    if (updateError) {
      console.error('Closing date update error:', updateError.message)
      return { success: false, error: `Failed to update: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'deal.closing_date_updated',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: {
        old_closing_date: oldValues.closing_date,
        new_closing_date: input.newClosingDate,
        old_advance: oldValues.advance_amount,
        new_advance: newCalc.advanceAmount,
        updated_by: profile.full_name,
      },
    })

    return {
      success: true,
      data: {
        old: oldValues,
        new: {
          closing_date: input.newClosingDate,
          days_until_closing: newDays,
          discount_fee: newCalc.discountFee,
          advance_amount: newCalc.advanceAmount,
          brokerage_referral_fee: newCalc.brokerageReferralFee,
          amount_due_from_brokerage: newCalc.amountDueFromBrokerage,
        },
      },
    }
  } catch (err: any) {
    console.error('Closing date update error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}
