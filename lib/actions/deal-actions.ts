'use server'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { calculateDeal } from '@/lib/calculations'
import { DealSubmissionSchema, DealStatusChangeSchema } from '@/lib/validations'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  SETTLEMENT_PERIOD_DAYS,
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
import { getAuthenticatedUser } from '@/lib/auth-helpers'
import { verifyFileMagicBytes } from '@/lib/file-validation'

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

    // Look up the agent's brokerage and account balance
    const { data: agentData } = await supabase
      .from('agents')
      .select('brokerage_id, account_balance, brokerages(referral_fee_percentage)')
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

    // Check if agent has outstanding balance that will be deducted at funding
    const outstandingBalance = agentData?.account_balance || 0
    const estimatedBalanceDeduction = outstandingBalance > 0
      ? Math.min(outstandingBalance, result.advanceAmount)
      : 0

    return {
      success: true,
      data: {
        ...result,
        daysUntilClosing,
        brokerageReferralPct: referralPct,
        outstandingBalance,
        estimatedBalanceDeduction,
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
        settlement_period_fee: calc.settlementPeriodFee,
        advance_amount: calc.advanceAmount,
        brokerage_referral_fee: calc.brokerageReferralFee,
        brokerage_referral_pct: referralPct,
        amount_due_from_brokerage: calc.amountDueFromBrokerage,
        source: 'manual_portal',
        notes: noteText,
        payment_status: 'not_applicable', // not funded yet
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
        ...calc,
        daysUntilClosing,
        outstandingBalance: 0,
        estimatedBalanceDeduction: 0,
      },
    }
  } catch (err: any) {
    console.error('Deal submission error:', err?.message)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Server Action: Calculate deal preview as brokerage admin (Session 34)
// ============================================================================

export async function calculateDealPreviewForBrokerage(input: DealPreviewInput): Promise<ActionResult> {
  const { error: authErr, profile, supabase } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const daysUntilClosing = calcDaysUntilClosing(input.closingDate)
    if (daysUntilClosing < MIN_DAYS_UNTIL_CLOSING || daysUntilClosing > MAX_DAYS_UNTIL_CLOSING) {
      return { success: false, error: `Closing date must be between ${MIN_DAYS_UNTIL_CLOSING} and ${MAX_DAYS_UNTIL_CLOSING} days from today` }
    }

    const { data: agentData } = await supabase
      .from('agents')
      .select('brokerage_id, account_balance, account_activated_at, brokerages(referral_fee_percentage)')
      .eq('id', input.agentId)
      .single()

    if (!agentData) return { success: false, error: 'Agent not found' }
    if (agentData.brokerage_id !== profile.brokerage_id) {
      return { success: false, error: 'Agent does not belong to your brokerage' }
    }

    const brokerage = (agentData as any).brokerages
    const referralPct = brokerage?.referral_fee_percentage
    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee not configured.' }
    }

    const result = calculateDeal({
      grossCommission: input.grossCommission,
      brokerageSplitPct: input.brokerageSplitPct,
      daysUntilClosing,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
    })

    const outstandingBalance = agentData.account_balance || 0
    const estimatedBalanceDeduction = outstandingBalance > 0
      ? Math.min(outstandingBalance, result.advanceAmount)
      : 0

    return {
      success: true,
      data: {
        ...result,
        daysUntilClosing,
        brokerageReferralPct: referralPct,
        outstandingBalance,
        estimatedBalanceDeduction,
        agentActivated: !!agentData.account_activated_at,
      },
    }
  } catch (err: any) {
    console.error('Brokerage deal preview error:', err?.message)
    return { success: false, error: 'Failed to calculate deal preview.' }
  }
}

// ============================================================================
// Server Action: Submit a new deal as brokerage admin on behalf of an agent
// ============================================================================

export async function submitDealAsBrokerage(formData: {
  agentId: string
  propertyAddress: string
  closingDate: string
  grossCommission: number
  brokerageSplitPct: number
  transactionType: string
  notes?: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['brokerage_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  if (!profile.brokerage_id) {
    return { success: false, error: 'Your account is not linked to a brokerage' }
  }

  // Validate the deal-form portion of the input
  const validation = DealSubmissionSchema.safeParse({
    propertyAddress: formData.propertyAddress,
    closingDate: formData.closingDate,
    grossCommission: formData.grossCommission,
    brokerageSplitPct: formData.brokerageSplitPct,
    notes: formData.notes,
  })
  if (!validation.success) {
    return { success: false, error: validation.error.issues[0]?.message || 'Invalid input' }
  }

  try {
    const { data: agentData, error: agentError } = await supabase
      .from('agents')
      .select('*, brokerages(*)')
      .eq('id', formData.agentId)
      .single()

    if (agentError || !agentData) return { success: false, error: 'Agent not found' }
    if (agentData.brokerage_id !== profile.brokerage_id) {
      return { success: false, error: 'Agent does not belong to your brokerage' }
    }
    if (!agentData.account_activated_at) {
      return { success: false, error: `${agentData.first_name} ${agentData.last_name} hasn't activated their account yet. Trigger the welcome email and have them complete setup before submitting a deal.` }
    }

    const brokerage = (agentData as any).brokerages
    const referralPct = brokerage?.referral_fee_percentage
    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee not configured.' }
    }

    const daysUntilClosing = calcDaysUntilClosing(formData.closingDate)
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

    const noteText = `Submitted by brokerage admin (${profile.full_name || profile.email}) — Transaction type: ${formData.transactionType}${formData.notes?.trim() ? '\n' + formData.notes.trim() : ''}`

    // Use service-role client for the INSERT — there is no RLS policy allowing
    // brokerage_admin role to write to `deals`. Auth + ownership checks above
    // already gate this path; we trust the verified inputs.
    const adminSupabase = createServiceRoleClient()
    const { data: newDeal, error: insertError } = await adminSupabase
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
        settlement_period_fee: calc.settlementPeriodFee,
        advance_amount: calc.advanceAmount,
        brokerage_referral_fee: calc.brokerageReferralFee,
        brokerage_referral_pct: referralPct,
        amount_due_from_brokerage: calc.amountDueFromBrokerage,
        source: 'manual_portal',
        notes: noteText,
        payment_status: 'not_applicable',
      })
      .select()
      .single()

    if (insertError) {
      console.error('Brokerage deal insert error:', insertError.message)
      return { success: false, error: `Failed to submit deal: ${insertError.message}` }
    }

    await logAuditEvent({
      action: 'deal.submit_by_brokerage',
      entityType: 'deal',
      entityId: newDeal.id,
      metadata: {
        property_address: validation.data.propertyAddress,
        advance_amount: calc.advanceAmount,
        agent_id: agentData.id,
        brokerage_id: agentData.brokerage_id,
        submitted_by_user_id: user.id,
      },
    })

    // Notify Firm Funds admin
    await sendNewDealNotification({
      dealId: newDeal.id,
      propertyAddress: validation.data.propertyAddress,
      advanceAmount: calc.advanceAmount,
      agentName: `${agentData.first_name} ${agentData.last_name}`,
      brokerageName: brokerage?.name || 'Unknown Brokerage',
    })

    return {
      success: true,
      data: {
        dealId: newDeal.id,
        ...calc,
        daysUntilClosing,
      },
    }
  } catch (err: any) {
    console.error('Brokerage deal submission error:', err?.message)
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
  brokerageReferralPct?: number // per-deal override (0-1 decimal)
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
      funded: ['completed', 'approved'],
      denied: ['under_review'],
      cancelled: ['under_review'],
      completed: ['funded'],
    }

    const allowedTransitions = STATUS_FLOW[deal.status] || []
    if (!allowedTransitions.includes(input.newStatus)) {
      return { success: false, error: `Cannot transition from "${deal.status}" to "${input.newStatus}"` }
    }

    // Require denial reason
    if (input.newStatus === 'denied' && !input.denialReason?.trim()) {
      return { success: false, error: 'Denial reason is required' }
    }

    // Block approval if agent banking info is not verified
    if (input.newStatus === 'approved') {
      const { data: agent } = await supabase
        .from('agents')
        .select('banking_verified, bank_transit_number, bank_institution_number, bank_account_number')
        .eq('id', deal.agent_id)
        .single()

      if (!agent?.banking_verified || !agent?.bank_transit_number || !agent?.bank_institution_number || !agent?.bank_account_number) {
        return { success: false, error: 'Cannot approve: agent banking information has not been verified. Please enter banking details on the agent\'s profile first.' }
      }
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

    // Clear repayment date and amount when reverting from completed
    if (deal.status === 'completed' && input.newStatus === 'funded') {
      updateData.repayment_date = null
      updateData.repayment_amount = null
      updateData.payment_status = 'pending'
    }

    // Set payment_status for denied/cancelled
    if (input.newStatus === 'denied' || input.newStatus === 'cancelled') {
      updateData.payment_status = 'not_applicable'
    }

    if (input.newStatus === 'funded') {
      updateData.funding_date = new Date().toISOString().split('T')[0]

      // Recalculate financials server-side using actual days from today (Eastern Time) to closing
      const actualDays = Math.max(1, calcDaysUntilClosing(deal.closing_date))

      // Fetch brokerage incl. profit_share_pct (every onboarded brokerage is white-label;
      // profit_share_pct == 0 means no profit-share arrangement)
      const { data: brokerage } = await supabase
        .from('brokerages')
        .select('referral_fee_percentage, profit_share_pct')
        .eq('id', deal.brokerage_id)
        .single()

      // When the brokerage has a configured profit_share_pct (>0), it governs both the
      // brokerage's keep AND the historical broker_share snapshot. Per-deal override still wins.
      const profitSharePct = Number(brokerage?.profit_share_pct ?? 0)
      const profitShareDecimal = profitSharePct > 0 ? profitSharePct / 100 : null

      const referralPct = input.brokerageReferralPct
        ?? profitShareDecimal
        ?? brokerage?.referral_fee_percentage
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

      // Snapshot the profit share (whole pct) at funding so historical deals are
      // unaffected by future renegotiations. Only snapshot when there is a share arrangement.
      if (profitSharePct > 0) {
        updateData.broker_share_pct_at_funding = profitSharePct
      }

      // Calculate due date: closing + 14 calendar days
      const closingDate = new Date(deal.closing_date + 'T00:00:00Z')
      const dueDate = new Date(closingDate.getTime() + SETTLEMENT_PERIOD_DAYS * 24 * 60 * 60 * 1000)
      const dueDateStr = dueDate.toISOString().split('T')[0]

      updateData.days_until_closing = actualDays
      updateData.discount_fee = calc.discountFee
      updateData.settlement_period_fee = calc.settlementPeriodFee
      updateData.advance_amount = calc.advanceAmount
      updateData.brokerage_referral_fee = calc.brokerageReferralFee
      updateData.brokerage_referral_pct = referralPct
      updateData.amount_due_from_brokerage = calc.amountDueFromBrokerage
      updateData.due_date = dueDateStr
      updateData.payment_status = 'pending'

      // Balance deduction: if agent owes money, deduct from advance
      const { data: agentForBalance } = await supabase
        .from('agents')
        .select('id, account_balance')
        .eq('id', deal.agent_id)
        .single()

      const outstandingBalance = agentForBalance?.account_balance || 0
      if (outstandingBalance > 0 && calc.advanceAmount > 0) {
        const deductAmount = Math.min(outstandingBalance, calc.advanceAmount)
        const newBalance = outstandingBalance - deductAmount

        // Update agent balance
        await supabase
          .from('agents')
          .update({ account_balance: newBalance })
          .eq('id', deal.agent_id)

        // Record deduction in ledger
        await supabase
          .from('agent_transactions')
          .insert({
            agent_id: deal.agent_id,
            deal_id: deal.id,
            type: 'balance_deduction',
            amount: -deductAmount,
            running_balance: newBalance,
            description: `Balance deduction from advance — ${deal.property_address}`,
            created_by: user.id,
          })

        updateData.balance_deducted = deductAmount
      }
    }

    if (input.newStatus === 'completed') {
      updateData.repayment_date = new Date().toISOString().split('T')[0]
      updateData.payment_status = 'paid'
      if (input.repaymentAmount !== undefined) {
        updateData.repayment_amount = input.repaymentAmount
      }
      // White-label: calculate broker_share_amount from the snapshotted pct + actual fees.
      // Includes BOTH the discount fee and the 14-day settlement period fee — matches the
      // brokerage_referral_fee formula in lib/calculations.ts. Used for monthly statements
      // and audit. Only set if a snapshot exists (i.e. funded as white-label).
      if (deal.broker_share_pct_at_funding != null && deal.discount_fee != null) {
        const pct = Number(deal.broker_share_pct_at_funding)
        const fee = Number(deal.discount_fee) + Number(deal.settlement_period_fee || 0)
        updateData.broker_share_amount = Math.round(fee * pct) / 100
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
      oldValue: { status: deal.status },
      newValue: { status: input.newStatus },
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

    // Email notification → brokerage (if brokerage has an email)
    try {
      const { data: brokerageInfo } = await supabase
        .from('brokerages')
        .select('name, contact_email')
        .eq('id', deal.brokerage_id)
        .single()

      if (brokerageInfo?.contact_email) {
        const { sendBrokerageStatusNotification } = await import('@/lib/email')
        sendBrokerageStatusNotification({
          brokerageEmail: brokerageInfo.contact_email,
          brokerageName: brokerageInfo.name,
          propertyAddress: deal.property_address,
          agentName: agentInfo ? `${agentInfo.first_name} ${agentInfo.last_name}` : 'Agent',
          newStatus: input.newStatus,
          dealId: deal.id,
        })
      }
    } catch {
      // Brokerage email failure shouldn't block the status change
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
    // Check if this is the auto-managed "good standing" item
    const { data: item } = await supabase
      .from('underwriting_checklist')
      .select('checklist_item, deal_id')
      .eq('id', input.itemId)
      .single()

    if (item?.checklist_item === 'Agent in good standing with Brokerage (Not flagged)') {
      // Look up the agent's flag status via the deal
      const { data: deal } = await supabase
        .from('deals')
        .select('agent_id')
        .eq('id', item.deal_id)
        .single()

      if (deal?.agent_id) {
        const serviceClient = createServiceRoleClient()
        const { data: agent } = await serviceClient
          .from('agents')
          .select('flagged_by_brokerage')
          .eq('id', deal.agent_id)
          .single()

        if (agent?.flagged_by_brokerage) {
          return { success: false, error: 'Cannot check this item — agent is flagged by their brokerage. Remove the flag first.' }
        }
      }
    }

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

    await logAuditEvent({
      action: 'checklist.toggle',
      entityType: 'deal',
      entityId: input.itemId,
      metadata: { checked: input.isChecked },
    })

    return { success: true }
  } catch (err: any) {
    console.error('Checklist toggle error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Toggle underwriting checklist item N/A status (admin only)
// ============================================================================

export async function toggleChecklistItemNA(input: {
  itemId: string
  isNA: boolean
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { error } = await supabase
      .from('underwriting_checklist')
      .update({
        is_na: input.isNA,
        // If marking as N/A, also uncheck and clear check metadata
        ...(input.isNA ? { is_checked: false, checked_by: null, checked_at: null } : {}),
      })
      .eq('id', input.itemId)

    if (error) {
      console.error('Checklist N/A toggle error:', error.message)
      return { success: false, error: 'Failed to update checklist item' }
    }

    await logAuditEvent({
      action: 'checklist.toggle',
      entityType: 'deal',
      entityId: input.itemId,
      metadata: { na: input.isNA },
    })

    return { success: true }
  } catch (err: any) {
    console.error('Checklist N/A toggle error:', err?.message)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Link/unlink a document to a checklist item (admin only)
// ============================================================================

export async function linkDocumentToChecklist(input: {
  checklistItemId: string
  documentId: string | null  // null = unlink
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // If unlinking, verify the item is NOT already checked (locked)
    if (input.documentId === null) {
      const { data: item } = await supabase
        .from('underwriting_checklist')
        .select('is_checked')
        .eq('id', input.checklistItemId)
        .single()

      if (item?.is_checked) {
        return { success: false, error: 'Cannot unlink document from a confirmed checklist item. Uncheck the item first.' }
      }
    }

    const { error } = await supabase
      .from('underwriting_checklist')
      .update({ linked_document_id: input.documentId })
      .eq('id', input.checklistItemId)

    if (error) {
      console.error('Link document error:', error.message)
      return { success: false, error: 'Failed to link document to checklist item' }
    }

    await logAuditEvent({
      action: input.documentId ? 'checklist.link_document' : 'checklist.unlink_document',
      entityType: 'deal',
      entityId: input.checklistItemId,
      metadata: { documentId: input.documentId },
    })

    return { success: true }
  } catch (err: any) {
    console.error('Link document error:', err?.message)
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
  // Allow admins, agents, and brokerage admins
  const { error: authErr, profile, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin', 'agent', 'brokerage_admin'])
  if (authErr || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Authorization: verify the user actually has access to this deal
    if (profile.role === 'agent') {
      const { data: deal } = await supabase
        .from('deals')
        .select('agent_id')
        .eq('id', input.dealId)
        .single()
      if (!deal || deal.agent_id !== profile.agent_id) {
        return { success: false, error: 'Access denied' }
      }
    } else if (profile.role === 'brokerage_admin') {
      const { data: deal } = await supabase
        .from('deals')
        .select('brokerage_id')
        .eq('id', input.dealId)
        .single()
      if (!deal || deal.brokerage_id !== profile.brokerage_id) {
        return { success: false, error: 'Access denied' }
      }
    }
    // super_admin and firm_funds_admin can access all deals

    // Use service role client to bypass RLS/storage policies
    const { createServiceRoleClient } = await import('@/lib/supabase/server')
    const serviceClient = createServiceRoleClient()

    const { data, error } = await serviceClient.storage
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

    // Magic byte verification — confirm file content matches declared type (H7 security fix)
    const magicBytesValid = await verifyFileMagicBytes(file)
    if (!magicBytesValid) {
      return { success: false, error: 'File content does not match its declared type' }
    }

    // Generate safe file path
    const timestamp = Date.now()
    const randomId = crypto.randomUUID()
    const safePath = `${dealId}/${timestamp}_${randomId}${ext}`

    // Use service role for the actual mutation. Authorization was already
    // verified above (deal ownership for agent / brokerage match for
    // brokerage_admin / unrestricted for super_admin & firm_funds_admin).
    // RLS on deal_documents has no policy for brokerage_admin, so the
    // user-scoped client would silently reject the metadata insert.
    const adminSupabase = createServiceRoleClient()

    // Upload to Supabase Storage
    const { error: uploadError } = await adminSupabase.storage
      .from('deal-documents')
      .upload(safePath, file)

    if (uploadError) {
      console.error('Storage upload error:', uploadError.message)
      return { success: false, error: 'Failed to upload file. Please try again.' }
    }

    // Insert metadata
    const { data: docRecord, error: insertError } = await adminSupabase
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
      await adminSupabase.storage.from('deal-documents').remove([safePath])
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
        settlement_period_fee: calc.settlementPeriodFee,
        advance_amount: calc.advanceAmount,
        brokerage_referral_fee: calc.brokerageReferralFee,
        brokerage_referral_pct: referralPct,
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
      oldValue: {
        property_address: deal.property_address,
        closing_date: deal.closing_date,
        gross_commission: deal.gross_commission,
        brokerage_split_pct: deal.brokerage_split_pct,
        advance_amount: deal.advance_amount,
      },
      newValue: {
        property_address: input.propertyAddress,
        closing_date: input.closingDate,
        gross_commission: input.grossCommission,
        brokerage_split_pct: input.brokerageSplitPct,
        advance_amount: calc.advanceAmount,
      },
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

    const adminClient = createServiceRoleClient()

    if (deal.status === 'under_review') {
      // Under review = hasn't been touched yet — delete it entirely
      // Clean up related records first
      await adminClient.from('document_requests').delete().eq('deal_id', input.dealId)
      await adminClient.from('deal_documents').delete().eq('deal_id', input.dealId)
      await adminClient.from('underwriting_checklist').delete().eq('deal_id', input.dealId)

      // Delete any uploaded files from storage
      const { data: docs } = await adminClient.from('deal_documents').select('file_path').eq('deal_id', input.dealId)
      if (docs && docs.length > 0) {
        await adminClient.storage.from('deal-documents').remove(docs.map(d => d.file_path))
      }

      const { error: deleteError } = await adminClient
        .from('deals')
        .delete()
        .eq('id', input.dealId)

      if (deleteError) {
        console.error('Deal delete error:', deleteError.message)
        return { success: false, error: `Failed to delete deal: ${deleteError.message}` }
      }

      await logAuditEvent({
        action: 'deal.withdrawn',
        entityType: 'deal',
        entityId: input.dealId,
        metadata: { property_address: deal.property_address, withdrawn_by: user.id },
      })

      return { success: true, data: { deleted: true } }
    }

    // Approved = already reviewed — mark as cancelled instead of deleting
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

    // Recalculate due date when closing date changes
    const newClosingDate = new Date(input.newClosingDate + 'T00:00:00Z')
    const newDueDate = new Date(newClosingDate.getTime() + SETTLEMENT_PERIOD_DAYS * 24 * 60 * 60 * 1000)
    const newDueDateStr = newDueDate.toISOString().split('T')[0]

    const { error: updateError } = await supabase
      .from('deals')
      .update({
        closing_date: input.newClosingDate,
        days_until_closing: newDays,
        discount_fee: newCalc.discountFee,
        settlement_period_fee: newCalc.settlementPeriodFee,
        advance_amount: newCalc.advanceAmount,
        brokerage_referral_fee: newCalc.brokerageReferralFee,
        amount_due_from_brokerage: newCalc.amountDueFromBrokerage,
        due_date: newDueDateStr,
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
        updated_by: profile.full_name,
      },
      oldValue: {
        closing_date: oldValues.closing_date,
        advance_amount: oldValues.advance_amount,
        discount_fee: oldValues.discount_fee,
      },
      newValue: {
        closing_date: input.newClosingDate,
        advance_amount: newCalc.advanceAmount,
        discount_fee: newCalc.discountFee,
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
