'use server'

import { createServiceRoleClient } from '@/lib/supabase/server'
import { calculateDeal, effectiveSettlementDays } from '@/lib/calculations'
import { DealSubmissionSchema, DealStatusChangeSchema } from '@/lib/validations'
import { voidEnvelope } from '@/lib/docusign'
import {
  DISCOUNT_RATE_PER_1000_PER_DAY,
  MIN_DAYS_UNTIL_CLOSING,
  MAX_DAYS_UNTIL_CLOSING,
  MAX_UPLOAD_SIZE_BYTES,
  ALLOWED_UPLOAD_MIME_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  VALID_DOCUMENT_TYPE_VALUES,
  calcDaysUntilClosing,
} from '@/lib/constants'
import { logAuditEvent } from '@/lib/audit'
import {
  sendNewDealNotification,
  sendBrokerageAdminNewDealNotification,
  sendStatusChangeNotification,
  sendDocumentUploadedNotification,
  sendDocumentRequestNotification,
  sendFailedToCloseElectionEmail,
} from '@/lib/email'
import { getAuthenticatedUser, getAuthenticatedWriter, getAuthenticatedCapable } from '@/lib/auth-helpers'
import { hasCapability } from '@/lib/access'
import { verifyFileMagicBytes } from '@/lib/file-validation'
import { sumConfirmedPayments } from '@/lib/brokerage-payments'
import { postDealAdvanceEntry, reverseDealAdvanceEntry } from '@/lib/agent-statement'
import { formatCurrency } from '@/lib/formatting'

// ============================================================================
// Types
// ============================================================================

interface ActionResult {
  success: boolean
  error?: string
  // Callers consume specific shapes via assertion; using any preserves call-site compatibility
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>
}

interface DealPreviewInput {
  grossCommission: number
  brokerageSplitPct: number
  brokerageFlatFee?: number
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
      .select('brokerage_id, account_balance, brokerages(referral_fee_percentage, settlement_days_override, auto_bumped_to_14_days_at)')
      .eq('id', input.agentId)
      .single()

    type AgentWithBrokerage = {
      brokerage_id?: string
      account_balance?: number
      brokerages?: {
        referral_fee_percentage: number | null
        settlement_days_override?: number | null
        auto_bumped_to_14_days_at?: string | null
      } | null
    }
    const brokerage = (agentData as AgentWithBrokerage | null)?.brokerages
    const referralPct = brokerage?.referral_fee_percentage

    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee not configured. Please contact support.' }
    }

    const settlementDays = effectiveSettlementDays(brokerage)

    const result = calculateDeal({
      grossCommission: input.grossCommission,
      brokerageSplitPct: input.brokerageSplitPct,
      brokerageFlatFee: input.brokerageFlatFee,
      daysUntilClosing,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
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
        settlementPeriodDays: settlementDays,
      },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Deal preview calculation error:', _msg)
    return { success: false, error: 'Failed to calculate deal preview. Please check your inputs.' }
  }
}

// ============================================================================
// Failed-deal submission gate
//
// Policy (Bud, 2026-06-02): an agent who has a deal that failed to close and
// still owes a balance may NOT submit a new advance request unless approved
// (not-yet-funded) advances already in the pipeline fully cover what they owe.
// When those approved deals fund, the balance-deduction at funding clears the
// debt — so a covered pipeline means the debt is on track to be repaid.
//
//   trigger  = agent has any failed_to_close deal with outstanding_balance > 0
//   owed     = the agent's full current account_balance (everything they owe)
//   coverage = combined advance_amount of the agent's 'approved' deals
//   blocked  = coverage does not reach owed
//
// Uses a service-role client so the gate always sees the true state regardless
// of who is submitting (agent self-serve or brokerage admin on their behalf).
// ============================================================================

async function evaluateFailedDealGate(
  agentId: string,
): Promise<{ blocked: boolean; owed: number; coverage: number }> {
  const client = createServiceRoleClient()

  // Trigger: any failed-to-close deal still carrying a balance.
  const { data: failed } = await client
    .from('deals')
    .select('id')
    .eq('agent_id', agentId)
    .eq('status', 'failed_to_close')
    .gt('outstanding_balance', 0)
    .limit(1)
  if (!failed || failed.length === 0) return { blocked: false, owed: 0, coverage: 0 }

  // Owed = everything the agent owes Firm Funds right now.
  const { data: agentRow } = await client
    .from('agents')
    .select('account_balance')
    .eq('id', agentId)
    .single()
  const owed = Number(agentRow?.account_balance) || 0
  if (owed <= 0) return { blocked: false, owed, coverage: 0 }

  // Coverage = combined advance of the agent's approved (not-yet-funded) deals.
  const { data: approved } = await client
    .from('deals')
    .select('advance_amount')
    .eq('agent_id', agentId)
    .eq('status', 'approved')
  const coverage = (approved ?? []).reduce((s, d) => s + (Number(d.advance_amount) || 0), 0)

  // Cent tolerance so floating-point noise on NUMERIC dollars can't false-block.
  return { blocked: coverage + 0.01 < owed, owed, coverage }
}

// ============================================================================
// Server Action: Read-only submission-gate status for the new-deal pages.
// Lets the agent and brokerage forms warn up front (and disable submit) instead
// of letting someone fill out the whole form only to be blocked on submit. The
// authoritative enforcement still lives in submitDeal / submitDealAsBrokerage.
// ============================================================================

export async function getDealSubmissionGate(agentId: string): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser([
    'agent', 'brokerage_admin', 'super_admin', 'firm_funds_admin',
  ])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  // Agents may only check themselves.
  if (profile.role === 'agent' && profile.agent_id !== agentId) {
    return { success: false, error: 'Access denied' }
  }
  // Brokerage admins may only check agents in their own brokerage.
  if (profile.role === 'brokerage_admin') {
    const svc = createServiceRoleClient()
    const { data: a } = await svc.from('agents').select('brokerage_id').eq('id', agentId).single()
    if (!a || a.brokerage_id !== profile.brokerage_id) return { success: false, error: 'Access denied' }
  }

  const gate = await evaluateFailedDealGate(agentId)
  return { success: true, data: gate }
}

// ============================================================================
// Server Action: Submit a new deal
// ============================================================================

export async function submitDeal(formData: {
  propertyAddress: string
  closingDate: string
  grossCommission: number
  brokerageSplitPct: number
  brokerageFlatFee?: number
  transactionType: string
  notes?: string
  // Task 5: when this submission is a revision of a previously denied deal,
  // the original deal's id is written to revised_from_deal_id so the lineage
  // is queryable from the new deal.
  revisedFromDealId?: string
  // Migration 105: when the agent took over a firm-deal offer to submit it
  // themselves, this is the id of that 'offered' deal row. We CONVERT that
  // same row in place (status -> under_review) instead of inserting a new one,
  // so there is never a duplicate deal and the firm_deal_events back-link
  // stays valid. The brokerage is already paused on it via agent_self_submit_at.
  fromOfferDealId?: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['agent'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  // Validate inputs with Zod
  const validation = DealSubmissionSchema.safeParse({
    propertyAddress: formData.propertyAddress,
    closingDate: formData.closingDate,
    grossCommission: formData.grossCommission,
    brokerageSplitPct: formData.brokerageSplitPct,
    brokerageFlatFee: formData.brokerageFlatFee,
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

    // Failed-deal gate: block new submissions while an uncovered failed-to-close
    // balance is outstanding (see evaluateFailedDealGate).
    const gate = await evaluateFailedDealGate(agentData.id)
    if (gate.blocked) {
      return {
        success: false,
        error: `You have an outstanding balance of ${formatCurrency(gate.owed)} from a deal that failed to close. You can't submit a new advance request until approved advances covering that balance are in place (currently approved: ${formatCurrency(gate.coverage)}). Please contact Firm Funds to resolve this.`,
      }
    }

    // Calculate days until closing (Eastern Time)
    const daysUntilClosing = calcDaysUntilClosing(formData.closingDate)

    const settlementDays = effectiveSettlementDays(brokerage)

    // Server-side financial calculations using the shared library
    const calc = calculateDeal({
      grossCommission: formData.grossCommission,
      brokerageSplitPct: formData.brokerageSplitPct,
      brokerageFlatFee: formData.brokerageFlatFee,
      daysUntilClosing,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
    })

    if (calc.advanceAmount <= 0) {
      return { success: false, error: 'The discount fee exceeds the net commission. This deal cannot be advanced.' }
    }

    // Build notes with transaction type
    const noteText = `Transaction type: ${formData.transactionType}${formData.notes?.trim() ? '\n' + formData.notes.trim() : ''}`

    // Two paths to a single under_review deal:
    //   - fromOfferDealId set → the agent took over a firm-deal offer (migration
    //     105). CONVERT that same 'offered' row in place so there is never a
    //     duplicate and the firm_deal_events back-link stays valid. Mirrors the
    //     brokerage conversion in submitDealAsBrokerage.
    //   - Otherwise → INSERT a brand-new row.
    // Lock the settlement window at submission so the CPA the agent signs and
    // the system's enforcement can never diverge if the brokerage's effective
    // window changes later (e.g., a 5th strike auto-bumps them mid-flight).
    let newDeal: { id: string; deal_number?: string | null } | null = null
    if (formData.fromOfferDealId) {
      // RLS doesn't let an agent flip their own deal's status, so use the
      // service-role client for the conversion. Ownership + status + the
      // self-submit flag are all verified in code below before the write.
      const offerSupabase = createServiceRoleClient()
      const { data: existing } = await offerSupabase
        .from('deals')
        .select('id, agent_id, brokerage_id, status, agent_self_submit_at')
        .eq('id', formData.fromOfferDealId)
        .maybeSingle()
      if (!existing) return { success: false, error: 'Offered deal not found.' }
      if (existing.agent_id !== agentData.id) {
        return { success: false, error: 'This offer does not belong to you.' }
      }
      if (existing.brokerage_id !== agentData.brokerage_id) {
        return { success: false, error: 'This offer belongs to another brokerage.' }
      }
      if (existing.status !== 'offered') {
        return { success: false, error: `This offer has already been ${existing.status}. Reload the page.` }
      }
      if (!existing.agent_self_submit_at) {
        // The agent must have taken the offer over first (which pauses the
        // brokerage). Without that flag the brokerage is still the owner.
        return { success: false, error: 'Take this offer over before submitting it yourself.' }
      }

      const { data: updated, error: convertError } = await offerSupabase
        .from('deals')
        .update({
          status: 'under_review',
          property_address: validation.data.propertyAddress,
          closing_date: formData.closingDate,
          gross_commission: formData.grossCommission,
          brokerage_split_pct: formData.brokerageSplitPct,
          brokerage_flat_fee: formData.brokerageFlatFee ?? 0,
          net_commission: calc.netCommission,
          days_until_closing: daysUntilClosing,
          discount_fee: calc.discountFee,
          settlement_period_fee: calc.settlementPeriodFee,
          settlement_days_at_funding: settlementDays,
          advance_amount: calc.advanceAmount,
          brokerage_referral_fee: calc.brokerageReferralFee,
          brokerage_referral_pct: referralPct,
          amount_due_from_brokerage: calc.amountDueFromBrokerage,
          // Keep source='firm_deal_offer' so the deal still attributes to the
          // automated pipeline; notes capture the transaction type.
          notes: noteText,
          payment_status: 'not_applicable',
          // Defensive: clear any stale balance_deducted from the offered row.
          balance_deducted: 0,
          ...(formData.revisedFromDealId
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO: regen types after migration 084 applied
            ? ({ revised_from_deal_id: formData.revisedFromDealId } as any)
            : {}),
        })
        .eq('id', formData.fromOfferDealId)
        .eq('status', 'offered')  // CAS-style guard against a double-submit
        .select('id, deal_number')
        .single()
      if (convertError || !updated) {
        console.error('Agent offer conversion error:', convertError?.message)
        return { success: false, error: `Failed to submit deal: ${convertError?.message ?? 'no rows updated'}` }
      }
      newDeal = updated
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('deals')
        .insert({
          agent_id: agentData.id,
          brokerage_id: agentData.brokerage_id,
          status: 'under_review',
          property_address: validation.data.propertyAddress,
          closing_date: formData.closingDate,
          gross_commission: formData.grossCommission,
          brokerage_split_pct: formData.brokerageSplitPct,
          brokerage_flat_fee: formData.brokerageFlatFee ?? 0,
          net_commission: calc.netCommission,
          days_until_closing: daysUntilClosing,
          discount_fee: calc.discountFee,
          settlement_period_fee: calc.settlementPeriodFee,
          settlement_days_at_funding: settlementDays,
          advance_amount: calc.advanceAmount,
          brokerage_referral_fee: calc.brokerageReferralFee,
          brokerage_referral_pct: referralPct,
          amount_due_from_brokerage: calc.amountDueFromBrokerage,
          source: 'manual_portal',
          notes: noteText,
          payment_status: 'not_applicable', // not funded yet
          // Task 5: lineage link for resubmissions of previously denied deals.
          ...(formData.revisedFromDealId
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO: regen types after migration 084 applied
            ? ({ revised_from_deal_id: formData.revisedFromDealId } as any)
            : {}),
        })
        .select()
        .single()

      if (insertError) {
        console.error('Deal insert error:', insertError.message, insertError.details, insertError.hint)
        return { success: false, error: `Failed to submit deal: ${insertError.message}` }
      }
      newDeal = inserted
    }

    if (!newDeal) {
      return { success: false, error: 'Failed to record the deal (no row).' }
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
      dealNumber: newDeal.deal_number,
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
          dealNumber: newDeal.deal_number,
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Deal submission error:', _msg)
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
      .select('brokerage_id, account_balance, account_activated_at, brokerages(referral_fee_percentage, settlement_days_override, auto_bumped_to_14_days_at)')
      .eq('id', input.agentId)
      .single()

    if (!agentData) return { success: false, error: 'Agent not found' }
    if (agentData.brokerage_id !== profile.brokerage_id) {
      return { success: false, error: 'Agent does not belong to your brokerage' }
    }

    const brokerage = (agentData as unknown as { brokerages?: { name?: string | null; referral_fee_percentage: number | null; settlement_days_override?: number | null; auto_bumped_to_14_days_at?: string | null } | null }).brokerages
    const referralPct = brokerage?.referral_fee_percentage
    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee not configured.' }
    }

    const settlementDays = effectiveSettlementDays(brokerage)

    const result = calculateDeal({
      grossCommission: input.grossCommission,
      brokerageSplitPct: input.brokerageSplitPct,
      brokerageFlatFee: input.brokerageFlatFee,
      daysUntilClosing,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
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
        settlementPeriodDays: settlementDays,
        agentActivated: !!agentData.account_activated_at,
      },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Brokerage deal preview error:', _msg)
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
  brokerageFlatFee?: number
  transactionType: string
  notes?: string
  // When set, this submission is converting an existing 'offered' deal
  // (created by the agent accepting a firm-deal offer). We UPDATE that row
  // in place rather than inserting a new one, so the back-link from
  // firm_deal_events.offer_deal_id stays valid and the agent's deals list
  // doesn't end up with two entries for the same property.
  fromOfferDealId?: string
  // Task 5: when this submission is a revision of a previously denied deal,
  // the original deal's id is written to revised_from_deal_id so the lineage
  // is queryable from the new deal.
  revisedFromDealId?: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['brokerage_admin'])
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
    brokerageFlatFee: formData.brokerageFlatFee,
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

    const brokerage = (agentData as unknown as { brokerages?: { name?: string | null; referral_fee_percentage: number | null; settlement_days_override?: number | null; auto_bumped_to_14_days_at?: string | null } | null }).brokerages
    const referralPct = brokerage?.referral_fee_percentage
    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee not configured.' }
    }

    // Failed-deal gate: block submissions on behalf of an agent who has an
    // uncovered failed-to-close balance (see evaluateFailedDealGate).
    const gate = await evaluateFailedDealGate(agentData.id)
    if (gate.blocked) {
      return {
        success: false,
        error: `${agentData.first_name} ${agentData.last_name} has an outstanding balance of ${formatCurrency(gate.owed)} from a deal that failed to close. You can't submit a new advance on their behalf until approved advances covering that balance are in place (currently approved: ${formatCurrency(gate.coverage)}).`,
      }
    }

    const daysUntilClosing = calcDaysUntilClosing(formData.closingDate)
    const settlementDays = effectiveSettlementDays(brokerage)
    const calc = calculateDeal({
      grossCommission: formData.grossCommission,
      brokerageSplitPct: formData.brokerageSplitPct,
      brokerageFlatFee: formData.brokerageFlatFee,
      daysUntilClosing,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
    })
    if (calc.advanceAmount <= 0) {
      return { success: false, error: 'The discount fee exceeds the net commission. This deal cannot be advanced.' }
    }

    const noteText = `Submitted by brokerage admin (${profile.full_name || profile.email}) — Transaction type: ${formData.transactionType}${formData.notes?.trim() ? '\n' + formData.notes.trim() : ''}`

    // Use service-role client for the INSERT/UPDATE — there is no RLS policy
    // allowing brokerage_admin role to write to `deals`. Auth + ownership
    // checks above already gate this path; we trust the verified inputs.
    // Lock the settlement window at submission so the CPA the agent signs and
    // the system's enforcement can never diverge later.
    const adminSupabase = createServiceRoleClient()

    // Two paths:
    //   - fromOfferDealId set → we are converting an existing 'offered' row.
    //     UPDATE in place so the back-link from firm_deal_events stays valid
    //     and the agent's deals list doesn't duplicate.
    //   - Otherwise → INSERT a brand-new row.
    let newDeal: { id: string; deal_number?: string | null } | null = null
    if (formData.fromOfferDealId) {
      // Validate the offered row still exists, is owned by this brokerage,
      // is for the same agent, and hasn't already been claimed. Race window
      // is small but real (two admins clicking at once); the .eq('status',
      // 'offered') on the update guards against the double-submit case.
      const { data: existing } = await adminSupabase
        .from('deals')
        .select('id, agent_id, brokerage_id, status, agent_self_submit_at')
        .eq('id', formData.fromOfferDealId)
        .maybeSingle()
      if (!existing) return { success: false, error: 'Offered deal not found.' }
      if (existing.brokerage_id !== profile.brokerage_id) {
        return { success: false, error: 'This offer belongs to another brokerage.' }
      }
      if (existing.agent_id !== agentData.id) {
        return { success: false, error: 'The offered deal is for a different agent.' }
      }
      if (existing.status !== 'offered') {
        return { success: false, error: `This offer has already been ${existing.status}. Reload the page.` }
      }
      // Paused: the agent took this offer over to submit it themselves. Refuse
      // so the brokerage can't create a duplicate submission (migration 105).
      if (existing.agent_self_submit_at) {
        return { success: false, error: 'This agent has chosen to submit this advance themselves.' }
      }

      const { data: updated, error: updateError } = await adminSupabase
        .from('deals')
        .update({
          status: 'under_review',
          property_address: validation.data.propertyAddress,
          closing_date: formData.closingDate,
          gross_commission: formData.grossCommission,
          brokerage_split_pct: formData.brokerageSplitPct,
          brokerage_flat_fee: formData.brokerageFlatFee ?? 0,
          net_commission: calc.netCommission,
          days_until_closing: daysUntilClosing,
          discount_fee: calc.discountFee,
          settlement_period_fee: calc.settlementPeriodFee,
          settlement_days_at_funding: settlementDays,
          advance_amount: calc.advanceAmount,
          brokerage_referral_fee: calc.brokerageReferralFee,
          brokerage_referral_pct: referralPct,
          amount_due_from_brokerage: calc.amountDueFromBrokerage,
          // Keep source='firm_deal_offer' so we can attribute the deal back
          // to the automated firm-deal pipeline; the notes capture the
          // submitter and transaction type.
          notes: noteText,
          payment_status: 'not_applicable',
          // Task 8: explicitly clear any stale balance_deducted carried over
          // from a previous (cancelled) acceptance attempt. The offered row
          // was created with no deduction, but be defensive — if a future
          // bug populates it, we don't want stale values surviving the
          // conversion to under_review and breaking funding-time math.
          balance_deducted: 0,
          // Task 5: link the revised deal back to the originally denied one
          // when supplied. NULL on the standard offer-conversion path.
          ...(formData.revisedFromDealId
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO: regen types after migration 084 applied
            ? ({ revised_from_deal_id: formData.revisedFromDealId } as any)
            : {}),
        })
        .eq('id', formData.fromOfferDealId)
        .eq('status', 'offered')  // CAS-style guard against double-submit
        .select('id, deal_number')
        .single()
      if (updateError || !updated) {
        console.error('Brokerage offer conversion error:', updateError?.message)
        return { success: false, error: `Failed to submit deal: ${updateError?.message ?? 'no rows updated'}` }
      }
      newDeal = updated
    } else {
      const { data: inserted, error: insertError } = await adminSupabase
        .from('deals')
        .insert({
          agent_id: agentData.id,
          brokerage_id: agentData.brokerage_id,
          status: 'under_review',
          property_address: validation.data.propertyAddress,
          closing_date: formData.closingDate,
          gross_commission: formData.grossCommission,
          brokerage_split_pct: formData.brokerageSplitPct,
          brokerage_flat_fee: formData.brokerageFlatFee ?? 0,
          net_commission: calc.netCommission,
          days_until_closing: daysUntilClosing,
          discount_fee: calc.discountFee,
          settlement_period_fee: calc.settlementPeriodFee,
          settlement_days_at_funding: settlementDays,
          advance_amount: calc.advanceAmount,
          brokerage_referral_fee: calc.brokerageReferralFee,
          brokerage_referral_pct: referralPct,
          amount_due_from_brokerage: calc.amountDueFromBrokerage,
          source: 'manual_portal',
          notes: noteText,
          payment_status: 'not_applicable',
          // Task 5: lineage link for resubmissions of previously denied deals.
          ...(formData.revisedFromDealId
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO: regen types after migration 084 applied
            ? ({ revised_from_deal_id: formData.revisedFromDealId } as any)
            : {}),
        })
        .select('id, deal_number')
        .single()
      if (insertError || !inserted) {
        console.error('Brokerage deal insert error:', insertError?.message)
        return { success: false, error: `Failed to submit deal: ${insertError?.message ?? 'no rows inserted'}` }
      }
      newDeal = inserted
    }

    // Defensive: TypeScript can't always narrow newDeal across the if/else
    // above. Both branches assign or return, but make it explicit.
    if (!newDeal) {
      return { success: false, error: 'Failed to record the deal (no row).' }
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
      dealNumber: newDeal.deal_number,
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Brokerage deal submission error:', _msg)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Server Action: Update deal status (admin only)
// ============================================================================

// All status strings the state machine knows about. Used to gate `newStatus`
// inputs before we hand them to STATUS_FLOW. Kept in sync with DealStatus in
// types/database.ts and the DB CHECK constraints on deals.status.
const ALL_DEAL_STATUSES = new Set<string>([
  'under_review',
  'approved',
  'funded',
  'completed',
  'denied',
  'cancelled',
  'failed_to_close',
  'cured',
  'funding_failed',
  'offered',
])

export async function updateDealStatus(input: {
  dealId: string
  newStatus: string
  denialReason?: string
  repaymentAmount?: number
  brokerageReferralPct?: number // per-deal override (0-1 decimal)
}): Promise<ActionResult> {
  // Baseline internal-staff gate (needed to read the deal first). The real
  // capability check happens below, once we know which transition is requested:
  // moving/settling money requires money.write (Owner only); a pure underwriting
  // transition requires deal.underwrite (Manager+).
  const { error: authErr, user, profile, supabase } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  // dealId / denialReason still go through Zod, but `newStatus` is validated
  // manually below because the canonical schema in lib/validations.ts predates
  // the failed_to_close / cured / funding_failed / offered statuses. Trying to
  // push those through the legacy enum would 400 before STATUS_FLOW even runs.
  const validation = DealStatusChangeSchema
    .pick({ dealId: true, denialReason: true })
    .safeParse({
      dealId: input.dealId,
      denialReason: input.denialReason,
    })

  if (!validation.success) {
    const firstError = validation.error.issues[0]?.message || 'Invalid input'
    return { success: false, error: firstError }
  }

  if (!ALL_DEAL_STATUSES.has(input.newStatus)) {
    return { success: false, error: `Invalid status "${input.newStatus}"` }
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

    // Capability split (least-privilege roles). Any transition INTO or OUT OF a
    // money-active state (funded / completed / cured) moves or settles money and
    // requires money.write (Owner only). Every other transition is underwriting
    // and requires deal.underwrite (Manager and up).
    const MONEY_ACTIVE_STATUSES = new Set(['funded', 'completed', 'cured'])
    const movesMoney =
      MONEY_ACTIVE_STATUSES.has(input.newStatus) || MONEY_ACTIVE_STATUSES.has(deal.status)
    const requiredCapability = movesMoney ? 'money.write' : 'deal.underwrite'
    if (!hasCapability(profile, requiredCapability)) {
      return { success: false, error: 'You do not have permission to perform this action.' }
    }

    // Validate status transition (includes backward transitions). Extended in
    // Task 1 to cover the remediation lifecycle (failed_to_close → cured),
    // EFT-failure recovery (funding_failed → funded/cancelled), and firm-deal
    // offer states (offered → under_review/cancelled).
    const STATUS_FLOW: Record<string, string[]> = {
      under_review: ['approved', 'denied', 'cancelled'],
      approved: ['funded', 'denied', 'cancelled', 'under_review'],
      funded: ['completed', 'approved'],
      denied: ['under_review'],
      cancelled: ['under_review'],
      completed: ['funded'],
      failed_to_close: ['cured', 'funded'],  // failed deals can be manually cured or reverted to funded if mis-marked
      cured: [],  // terminal state — no further transitions allowed
      funding_failed: ['funded', 'cancelled'],  // EFT bounced, can retry funding or cancel
      offered: ['under_review', 'cancelled'],  // firm-deal offer states
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

    // Block funding if the agent's ID verification (KYC) is not complete.
    // No advance may be disbursed without verified ID on file.
    if (input.newStatus === 'funded') {
      const { data: kycAgent } = await supabase
        .from('agents')
        .select('kyc_status')
        .eq('id', deal.agent_id)
        .single()

      if (kycAgent?.kyc_status !== 'verified') {
        return { success: false, error: 'Cannot fund: the agent\'s ID verification (KYC) is not complete. Verify the agent\'s identity before funding this advance.' }
      }
    }

    // Money-integrity invariant: a deal must NOT complete unless the brokerage's
    // payment has actually been recorded AND confirmed to cover what they owe.
    // The "Mark Completed" button is gated in the UI too, but that is not
    // authoritative — enforce it server-side so no code path can complete a deal
    // with money still outstanding.
    if (input.newStatus === 'completed') {
      const { data: pmts, error: pmtErr } = await supabase
        .from('brokerage_payments')
        .select('amount, status')
        .eq('deal_id', deal.id)
      if (pmtErr) {
        return { success: false, error: `Could not verify brokerage payments: ${pmtErr.message}` }
      }
      const confirmedTotal = sumConfirmedPayments(pmts || [])
      const amountDue = deal.amount_due_from_brokerage == null ? null : Number(deal.amount_due_from_brokerage)
      // When the amount owed is known, confirmed payments must cover it (cent
      // tolerance for NUMERIC noise). When unknown (legacy/null), require at least
      // one confirmed payment so a deal never completes with nothing recorded.
      const covered =
        amountDue != null && amountDue > 0
          ? confirmedTotal >= amountDue - 0.01
          : confirmedTotal > 0
      if (!covered) {
        const dueStr = amountDue != null && amountDue > 0 ? `$${amountDue.toFixed(2)}` : 'the amount owed'
        return {
          success: false,
          error: `Cannot mark this deal completed: confirmed brokerage payments total $${confirmedTotal.toFixed(2)}, which does not cover ${dueStr}. Record the brokerage's payment first.`,
        }
      }
    }

    // Refund gate: a deal that still owes the agent a refund (an early-closing
    // or amendment credit that hasn't been paid out) cannot be completed. The
    // admin must issue it first ("Mark refund issued"). Deal-scoped via
    // refund_owed_amount so an unrelated credit on another deal never blocks
    // this one.
    if (input.newStatus === 'completed') {
      const refundOwed = Number(deal.refund_owed_amount ?? 0)
      if (refundOwed > 0.01) {
        return {
          success: false,
          error: `Cannot mark this deal completed: a refund of $${refundOwed.toFixed(2)} is owed to the agent. Issue the refund ("Mark refund issued") before completing this deal.`,
        }
      }
    }

    // Build update payload
    const updateData: Record<string, unknown> = { status: input.newStatus }

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

    // Funding-only: precomputed payload for the post-CAS balance delta. We
    // build all data here but defer the apply_agent_balance_delta call until
    // after we have exclusively claimed the deal via the CAS update below.
    // see audit finding #5
    let pendingFundingDeduction: { agentId: string; amount: number; description: string } | null = null
    // Funding-only: informational "Advance issued" charge for the agent's
    // statement (migration 106). Balance-neutral, posted after the CAS wins.
    let pendingAdvanceEntry: { agentId: string; amount: number; propertyAddress: string | null } | null = null

    if (input.newStatus === 'funded') {
      // Stamp the funding date as the Toronto calendar date, NOT the UTC date.
      // new Date().toISOString() is UTC, so funding late evening Toronto would
      // record tomorrow's date. en-CA renders YYYY-MM-DD.
      updateData.funding_date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

      // Recalculate financials server-side using actual days from today (Eastern Time) to closing
      const actualDays = Math.max(1, calcDaysUntilClosing(deal.closing_date))

      // Fetch brokerage incl. profit_share_pct and settlement override columns.
      // Every onboarded brokerage is white-label; profit_share_pct == 0 means
      // no profit-share arrangement.
      const { data: brokerage } = await supabase
        .from('brokerages')
        .select('referral_fee_percentage, profit_share_pct, settlement_days_override, auto_bumped_to_14_days_at')
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

      // Settlement window: prefer the snapshot taken at submission so the
      // CPA the agent signed and the system enforcement stay consistent
      // even if the brokerage's effective window changed between submission
      // and funding (e.g., they hit strike #5 on a different deal). Task 12:
      // surface silent NULL fallbacks so we can spot deals that slipped past
      // the snapshot path (e.g. recently funded but pre-snapshot data).
      const settlementDays = deal.settlement_days_at_funding ?? (() => {
        console.warn(`[deal-actions] Deal ${deal.id} missing settlement_days_at_funding snapshot — using current brokerage setting. Investigate if this is a recently-funded deal.`)
        return effectiveSettlementDays(brokerage)
      })()

      const calc = calculateDeal({
        grossCommission: deal.gross_commission,
        brokerageSplitPct: deal.brokerage_split_pct,
        brokerageFlatFee: Number(deal.brokerage_flat_fee ?? 0),
        daysUntilClosing: actualDays,
        discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
        brokerageReferralPct: referralPct,
        settlementPeriodDays: settlementDays,
      })

      // Snapshot the profit share (whole pct) at funding so historical deals are
      // unaffected by future renegotiations. Only snapshot when there is a share arrangement.
      if (profitSharePct > 0) {
        updateData.broker_share_pct_at_funding = profitSharePct
      }

      // Due date = closing + the brokerage's effective settlement window
      // (7 standard, 14 if auto-bumped or overridden). Snapshot the days
      // used onto the deal row so the value is stable for the life of the
      // deal even if the brokerage's effective days later change.
      const closingDate = new Date(deal.closing_date + 'T00:00:00Z')
      const dueDate = new Date(closingDate.getTime() + settlementDays * 24 * 60 * 60 * 1000)
      const dueDateStr = dueDate.toISOString().split('T')[0]

      updateData.days_until_closing = actualDays
      updateData.discount_fee = calc.discountFee
      updateData.settlement_period_fee = calc.settlementPeriodFee
      updateData.advance_amount = calc.advanceAmount
      updateData.brokerage_referral_fee = calc.brokerageReferralFee
      updateData.brokerage_referral_pct = referralPct
      updateData.amount_due_from_brokerage = calc.amountDueFromBrokerage
      updateData.due_date = dueDateStr
      updateData.settlement_days_at_funding = settlementDays
      updateData.payment_status = 'pending'

      // Defer the balance deduction until after the CAS update wins.
      const { data: agentForBalance } = await supabase
        .from('agents')
        .select('id, account_balance')
        .eq('id', deal.agent_id)
        .single()

      const outstandingBalance = agentForBalance?.account_balance || 0
      if (outstandingBalance > 0 && calc.advanceAmount > 0) {
        const deductAmount = Math.min(outstandingBalance, calc.advanceAmount)
        updateData.balance_deducted = deductAmount
        pendingFundingDeduction = {
          agentId: deal.agent_id,
          amount: deductAmount,
          description: `Balance deduction from advance: ${deal.property_address}`,
        }
      }

      // Informational charge for the agent's statement: the outstanding balance
      // the brokerage will repay. Balance-neutral (does not move account_balance);
      // posted after the CAS update wins so we don't write it on a failed claim.
      pendingAdvanceEntry = {
        agentId: deal.agent_id,
        amount: calc.amountDueFromBrokerage,
        propertyAddress: deal.property_address ?? null,
      }
    }

    if (input.newStatus === 'completed') {
      // Toronto calendar date (see funding_date note above) — avoids a UTC
      // off-by-one when completing late evening Toronto time.
      updateData.repayment_date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
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

    // Reverse balance deduction when reverting a funded deal back to approved
    // so a subsequent re-funding doesn't deduct twice. see audit finding #19
    const prevBalanceDeducted = Number(deal.balance_deducted || 0)
    const isFundedToApprovedReversal =
      deal.status === 'funded' && input.newStatus === 'approved' && prevBalanceDeducted > 0
    if (isFundedToApprovedReversal) {
      updateData.balance_deducted = 0
    }
    // The informational advance charge is posted on EVERY funding, so its
    // reversal must fire on any funded->approved revert, not only when a
    // balance deduction also occurred.
    const isFundedToApprovedRevert = deal.status === 'funded' && input.newStatus === 'approved'

    // Task 2: Execute update with optimistic concurrency control via the
    // `version` column (migration 083 auto-increments it on every UPDATE).
    // Status-based CAS is preserved as a belt-and-suspenders guard so two
    // writers racing the same version still can't both win when their target
    // status differs from the row's current status.
    // The whole builder is cast to `any` once at the start so the chained
    // .eq('version', ...) doesn't blow up TS2589 (the supabase generic
    // recursion limit chokes when the column name isn't in the generated
    // types yet — TODO: regen types after migration 083 applied).
    const currentVersion = (deal as { version?: number }).version ?? null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase generic recursion limit chokes on .eq('version') until types are regenerated
    const { data: updatedRows, error: updateError } = await ((supabase as any)
      .from('deals')
      .update(updateData)
      .eq('id', deal.id)
      .eq('status', deal.status) // belt: status hasn't drifted
      .eq('version', currentVersion) // suspenders: row hasn't been written by anyone else
      .select())

    if (updateError) {
      console.error('Deal status update error:', updateError.message, updateError.details, updateError.hint)
      return { success: false, error: `Failed to update deal status: ${updateError.message}` }
    }

    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: 'This deal was updated by another user while you were viewing. Please refresh and try again.' }
    }

    // see audit finding #5: only this caller has claimed the deal; safe to debit now.
    // RPC requires service role (migration 072 locked apply_agent_balance_delta to service_role).
    const rpcClient = (pendingFundingDeduction || isFundedToApprovedReversal || isFundedToApprovedRevert || pendingAdvanceEntry)
      ? createServiceRoleClient()
      : null
    if (pendingFundingDeduction && rpcClient) {
      const { error: rpcErr } = await rpcClient
        .rpc('apply_agent_balance_delta', {
          p_agent_id: pendingFundingDeduction.agentId,
          p_delta: -pendingFundingDeduction.amount,
          p_type: 'balance_deduction',
          p_description: pendingFundingDeduction.description,
          p_deal_id: deal.id,
          p_created_by: user.id,
        })
      if (rpcErr) {
        const { error: revertErr } = await supabase
          .from('deals')
          .update({
            status: deal.status,
            funding_date: null,
            balance_deducted: 0,
            payment_status: deal.payment_status,
          })
          .eq('id', deal.id)
          .eq('status', 'funded')
        if (revertErr) {
          console.error('CRITICAL: funding balance debit failed AND status revert failed:', revertErr.message)
        }
        return { success: false, error: `Failed to deduct balance: ${rpcErr.message}` }
      }
    }

    // Informational "Advance issued" charge on the agent's statement. Balance-
    // neutral and best-effort: the deal is already funded, so a failure here is
    // logged (inside the helper) but never unwinds the funding.
    if (pendingAdvanceEntry && rpcClient) {
      await postDealAdvanceEntry(rpcClient, {
        agentId: pendingAdvanceEntry.agentId,
        dealId: deal.id,
        amount: pendingAdvanceEntry.amount,
        propertyAddress: pendingAdvanceEntry.propertyAddress,
        createdBy: user.id,
      })
    }

    // see audit finding #19: refund the previously deducted balance now that
    // the CAS demoted funded back to approved.
    if (isFundedToApprovedReversal && rpcClient) {
      const { error: refundErr } = await rpcClient
        .rpc('apply_agent_balance_delta', {
          p_agent_id: deal.agent_id,
          p_delta: prevBalanceDeducted,
          p_type: 'credit',
          p_description: `Reversal of balance deduction for ${deal.property_address} (funded reverted to approved)`,
          p_deal_id: deal.id,
          p_created_by: user.id,
        })
      if (refundErr) {
        const { error: revertErr } = await supabase
          .from('deals')
          .update({ status: 'funded', balance_deducted: prevBalanceDeducted })
          .eq('id', deal.id)
          .eq('status', 'approved')
        if (revertErr) {
          console.error('CRITICAL: balance refund failed AND status revert failed:', revertErr.message)
        }
        return { success: false, error: `Failed to refund balance deduction: ${refundErr.message}` }
      }

      await logAuditEvent({
        action: 'deal.balance_deduction_reversed',
        entityType: 'deal',
        entityId: deal.id,
        metadata: {
          agent_id: deal.agent_id,
          refunded_amount: prevBalanceDeducted,
          reason: 'funded reverted to approved',
        },
      })
    }

    // Reverse the informational "Advance issued" charge so the statement does
    // not show a phantom advance on a deal that was pulled back to review.
    if (isFundedToApprovedRevert && rpcClient) {
      await reverseDealAdvanceEntry(rpcClient, {
        agentId: deal.agent_id,
        dealId: deal.id,
        amount: Number(deal.amount_due_from_brokerage || 0),
        propertyAddress: deal.property_address ?? null,
        reason: 'deal returned to review',
        createdBy: user.id,
      })
    }

    // Task 6: When denying an approved deal, void any in-flight DocuSign
    // envelopes so the agent doesn't sign a contract for a deal that has
    // already been killed. Best-effort — we never block the denial on a
    // DocuSign failure; just log loudly so admin can void manually.
    if (input.newStatus === 'denied' && deal.status === 'approved') {
      try {
        const { data: envelopes } = await supabase
          .from('esignature_envelopes')
          .select('envelope_id, status')
          .eq('deal_id', deal.id)
          .in('status', ['sent', 'delivered'])

        if (envelopes && envelopes.length > 0) {
          const reason = `Deal denied: ${input.denialReason?.slice(0, 200) || 'no reason provided'}`
          for (const env of envelopes) {
            try {
              await voidEnvelope(env.envelope_id, reason)
              // Mark the envelope row as voided so the next admin pass sees
              // the same state. Best-effort: if this write fails the
              // DocuSign webhook will eventually flip the row.
              await supabase
                .from('esignature_envelopes')
                .update({
                  status: 'voided',
                  voided_at: new Date().toISOString(),
                  void_reason: reason,
                })
                .eq('envelope_id', env.envelope_id)
            } catch (voidErr: unknown) {
              const _msg = voidErr instanceof Error ? voidErr.message : "Unknown error"
              console.error(`Failed to void envelope ${env.envelope_id} on deal denial:`, _msg)
            }
          }
        }
      } catch (envQueryErr: unknown) {
        const _msg = envQueryErr instanceof Error ? envQueryErr.message : "Unknown error"
        console.error('Failed to query envelopes for void on denial:', _msg)
      }
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

    // The agent gets ONE status email per deal lifecycle. The approval email now
    // already tells them their funds are on the way, so we deliberately skip the
    // separate "Funds on the Way" email when the deal moves to funded. The portal
    // status still advances to funded; we just don't double-email the agent.
    if (agentInfo?.email && input.newStatus !== 'funded') {
      sendStatusChangeNotification({
        dealId: deal.id,
        dealNumber: deal.deal_number,
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
        .select('name, email')
        .eq('id', deal.brokerage_id)
        .single()

      if (brokerageInfo?.email) {
        const { sendBrokerageStatusNotification } = await import('@/lib/email')
        sendBrokerageStatusNotification({
          brokerageEmail: brokerageInfo.email,
          brokerageName: brokerageInfo.name,
          propertyAddress: deal.property_address,
          agentName: agentInfo ? `${agentInfo.first_name} ${agentInfo.last_name}` : 'Agent',
          newStatus: input.newStatus,
          dealId: deal.id,
          dealNumber: deal.deal_number,
        })
      }
    } catch {
      // Brokerage email failure shouldn't block the status change
    }

    // Approving a deal now ALSO sends the contract for e-signature in one step
    // (so the admin no longer has to click "Send for signature" separately).
    // Best-effort: the approval already succeeded above and must NOT be unwound.
    // A send failure (agent has no email on file, the e-sign provider isn't
    // configured, an active envelope already exists, etc.) is surfaced as a
    // warning so the admin can send manually, but the deal stays approved. Only
    // fire on a genuine forward under_review → approved transition, never on a
    // funded → approved revert (which must not spawn a fresh envelope).
    let autoSendWarning: string | undefined
    if (input.newStatus === 'approved' && deal.status === 'under_review') {
      try {
        const { sendForSignature } = await import('@/lib/actions/esign-actions')
        const sendRes = await sendForSignature(deal.id)
        if (!sendRes.success) {
          autoSendWarning = sendRes.error
            || 'The deal was approved, but the documents could not be sent for signature automatically. Send them manually from the deal page.'
          console.warn(`[deal-actions] Auto-send on approval did not send for deal ${deal.id}: ${autoSendWarning}`)
        }
      } catch (sendErr: unknown) {
        autoSendWarning = sendErr instanceof Error ? sendErr.message : 'The deal was approved, but sending the documents for signature failed.'
        console.error(`[deal-actions] Auto-send on approval threw for deal ${deal.id}:`, autoSendWarning)
      }
    }

    return {
      success: true,
      data: { ...updateData, autoSendWarning },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Deal status change error:', _msg)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Server Action: Mark an agent refund as issued (Owner only)
// ----------------------------------------------------------------------------
// Pays out the refund a deal owes the agent. The negative account_balance (the
// agent's credit) is cleared by a positive balance delta; the deal's
// refund_owed_amount is zeroed and refund_issued_at stamped, which unblocks
// completion (the 'completed' gate keys off refund_owed_amount). The actual
// money movement (e-transfer/cheque) happens out-of-band — this records that it
// was done and clears the ledger credit. Atomic claim-then-pay prevents a
// double payout if the button is double-clicked.
// ============================================================================
export async function markRefundIssued(input: {
  dealId: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }
  // Issuing a refund moves money — Owner only.
  if (!hasCapability(profile, 'money.write')) {
    return { success: false, error: 'You do not have permission to issue refunds.' }
  }

  try {
    const rpcClient = createServiceRoleClient()

    const { data: deal, error: dealErr } = await rpcClient
      .from('deals')
      .select('id, agent_id, property_address, refund_owed_amount')
      .eq('id', input.dealId)
      .single()
    if (dealErr || !deal) return { success: false, error: 'Deal not found' }

    const owed = Number(deal.refund_owed_amount ?? 0)
    if (owed <= 0.01) {
      return { success: false, error: 'This deal has no refund owed to the agent.' }
    }

    // 1. Atomically CLAIM the refund: zero refund_owed_amount only while it is
    //    still > 0. If no row updates, another writer already issued it — abort
    //    before touching the ledger so we can never double-pay.
    const issuedAt = new Date().toISOString()
    const { data: claimed, error: claimErr } = await rpcClient
      .from('deals')
      .update({ refund_owed_amount: 0, refund_issued_at: issuedAt, refund_issued_by: user.id })
      .eq('id', deal.id)
      .gt('refund_owed_amount', 0)
      .select('id')
    if (claimErr) {
      return { success: false, error: `Failed to issue refund: ${claimErr.message}` }
    }
    if (!claimed || claimed.length === 0) {
      return { success: false, error: 'This refund has already been issued.' }
    }

    // 2. Pay the agent (clear their credit). On failure, roll the claim back so
    //    the gate re-engages and the refund can be retried.
    const { error: rpcErr } = await rpcClient.rpc('apply_agent_balance_delta', {
      p_agent_id: deal.agent_id,
      p_delta: owed,
      p_type: 'refund_issued',
      p_description: `Refund issued to agent: ${deal.property_address ?? 'deal'}`,
      p_deal_id: deal.id,
      p_created_by: user.id,
    })
    if (rpcErr) {
      await rpcClient
        .from('deals')
        .update({ refund_owed_amount: owed, refund_issued_at: null, refund_issued_by: null })
        .eq('id', deal.id)
      return { success: false, error: `Failed to record the refund payout: ${rpcErr.message}` }
    }

    await logAuditEvent({
      action: 'deal.refund_issued',
      entityType: 'deal',
      entityId: deal.id,
      metadata: { agent_id: deal.agent_id, refund_amount: owed },
    })

    return { success: true, data: { refund_amount: owed } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('markRefundIssued error:', _msg)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Server Action: Issue an agent's standing refund/credit (Owner only)
// ----------------------------------------------------------------------------
// Account-level companion to markRefundIssued: clears a STANDING credit (a
// negative account_balance not necessarily tied to one open deal) in a single
// click from the agent page. Pays the agent the full credit (positive delta ->
// balance back to ~0) and clears any per-deal refund markers the agent carries
// so gated deals unblock. Use markRefundIssued for the per-deal flow; use this
// for a leftover credit. The actual money movement (e-transfer/cheque) happens
// out-of-band; this records that it was done and clears the ledger credit.
// ============================================================================
export async function issueAgentRefund(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }
  // Issuing a refund moves money — Owner only.
  if (!hasCapability(profile, 'money.write')) {
    return { success: false, error: 'You do not have permission to issue refunds.' }
  }

  try {
    const rpcClient = createServiceRoleClient()

    const { data: agent, error: agentErr } = await rpcClient
      .from('agents')
      .select('id, first_name, last_name, account_balance')
      .eq('id', input.agentId)
      .single()
    if (agentErr || !agent) return { success: false, error: 'Agent not found' }

    const balance = Number(agent.account_balance ?? 0)
    // A credit is a NEGATIVE balance. Nothing to refund if they're at/above 0.
    if (balance >= -0.01) {
      return { success: false, error: 'This agent has no credit to refund.' }
    }
    const refundAmt = Math.round(Math.abs(balance) * 100) / 100

    // Pay the agent: a positive delta clears the credit (balance -> ~0).
    const { error: rpcErr } = await rpcClient.rpc('apply_agent_balance_delta', {
      p_agent_id: agent.id,
      p_delta: refundAmt,
      p_type: 'refund_issued',
      p_description: 'Refund issued to agent — account credit cleared',
      p_deal_id: null,
      p_created_by: user.id,
    })
    if (rpcErr) {
      return { success: false, error: `Failed to record the refund: ${rpcErr.message}` }
    }

    // Paying the full credit settles every refund this agent was owed, so clear
    // any per-deal refund markers too (keeps the completion gate consistent).
    await rpcClient
      .from('deals')
      .update({ refund_owed_amount: 0, refund_issued_at: new Date().toISOString(), refund_issued_by: user.id })
      .eq('agent_id', agent.id)
      .gt('refund_owed_amount', 0)

    await logAuditEvent({
      action: 'agent.refund_issued',
      entityType: 'agent',
      entityId: agent.id,
      metadata: { refund_amount: refundAmt },
    })

    return { success: true, data: { refund_amount: refundAmt } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('issueAgentRefund error:', _msg)
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
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('deal.underwrite')
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Checklist toggle error:', _msg)
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
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('deal.underwrite')
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Checklist N/A toggle error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Link/unlink a document to a checklist item (admin only)
// ============================================================================

// Link a document to a checklist item. Migration 111: appends to the
// linked_document_ids array so MULTIPLE documents can be attached per checklist
// line. The scalar linked_document_id is left untouched (it remains the
// auto-link channel for signed contracts/KYC); the underwriting UI renders the
// union of the scalar and the array. Idempotent — a doc already linked via
// either channel is a no-op.
export async function linkDocumentToChecklist(input: {
  checklistItemId: string
  documentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('deal.underwrite')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: item, error: fetchErr } = await supabase
      .from('underwriting_checklist')
      .select('linked_document_id, linked_document_ids')
      .eq('id', input.checklistItemId)
      .single()
    if (fetchErr || !item) {
      return { success: false, error: 'Checklist item not found' }
    }

    const existing: string[] = (item.linked_document_ids as string[] | null) ?? []
    // Already linked (via the scalar auto-link channel or the array)? No-op.
    if (input.documentId === item.linked_document_id || existing.includes(input.documentId)) {
      return { success: true }
    }

    const { error } = await supabase
      .from('underwriting_checklist')
      .update({ linked_document_ids: [...existing, input.documentId] })
      .eq('id', input.checklistItemId)

    if (error) {
      console.error('Link document error:', error.message)
      return { success: false, error: 'Failed to link document to checklist item' }
    }

    await logAuditEvent({
      action: 'checklist.link_document',
      entityType: 'deal',
      entityId: input.checklistItemId,
      metadata: { documentId: input.documentId },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Link document error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// Unlink ONE specific document from a checklist item (migration 111). Removes it
// from the linked_document_ids array and/or clears the scalar linked_document_id
// if it is the auto-linked/primary doc. Blocked while the item is confirmed
// (checked) — uncheck first — matching the prior single-link behaviour.
export async function unlinkDocumentFromChecklist(input: {
  checklistItemId: string
  documentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('deal.underwrite')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: item, error: fetchErr } = await supabase
      .from('underwriting_checklist')
      .select('is_checked, linked_document_id, linked_document_ids')
      .eq('id', input.checklistItemId)
      .single()
    if (fetchErr || !item) {
      return { success: false, error: 'Checklist item not found' }
    }
    if (item.is_checked) {
      return { success: false, error: 'Cannot unlink a document from a confirmed checklist item. Uncheck the item first.' }
    }

    const existing: string[] = (item.linked_document_ids as string[] | null) ?? []
    const updates: Record<string, unknown> = {}
    if (existing.includes(input.documentId)) {
      updates.linked_document_ids = existing.filter((id) => id !== input.documentId)
    }
    if (item.linked_document_id === input.documentId) {
      updates.linked_document_id = null
    }
    if (Object.keys(updates).length === 0) {
      return { success: true }  // wasn't linked — no-op
    }

    const { error } = await supabase
      .from('underwriting_checklist')
      .update(updates)
      .eq('id', input.checklistItemId)

    if (error) {
      console.error('Unlink document error:', error.message)
      return { success: false, error: 'Failed to unlink document from checklist item' }
    }

    await logAuditEvent({
      action: 'checklist.unlink_document',
      entityType: 'deal',
      entityId: input.checklistItemId,
      metadata: { documentId: input.documentId },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Unlink document error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Delete document (admin only)
// ============================================================================

export async function deleteDocument(input: {
  documentId: string
}): Promise<ActionResult> {
  const { error: authErr } = await getAuthenticatedCapable('documents.delete')
  if (authErr) return { success: false, error: authErr }

  try {
    const adminSupabase = createServiceRoleClient()
    const { data: document, error: documentError } = await adminSupabase
      .from('deal_documents')
      .select('id, deal_id, file_name, file_path')
      .eq('id', input.documentId)
      .single()

    if (documentError || !document) {
      return { success: false, error: 'Document not found' }
    }

    // Delete DB row FIRST, then storage file. If storage delete fails we have
    // an orphaned file (recoverable via storage admin) instead of an orphan
    // DB pointer to a missing file (which surfaces as a broken download for
    // the user). Original order was reversed and would silently leave the
    // metadata row pointing at a missing object when the DB delete failed.
    const { error: dbError } = await adminSupabase
      .from('deal_documents')
      .delete()
      .eq('id', input.documentId)

    if (dbError) {
      console.error('Document delete error:', dbError.message)
      return { success: false, error: 'Failed to delete document record' }
    }

    // Prune the deleted document id out of any checklist arrays (migration 111).
    // A uuid[] has no FK cascade, so unlike the scalar linked_document_id (which
    // auto-nulls via ON DELETE SET NULL) the array would otherwise keep a
    // dangling id. Best-effort, non-fatal — the UI also filters missing docs.
    try {
      const { data: linkedItems } = await adminSupabase
        .from('underwriting_checklist')
        .select('id, linked_document_ids')
        .eq('deal_id', document.deal_id)
        .contains('linked_document_ids', [input.documentId])
      for (const ci of linkedItems ?? []) {
        const pruned = ((ci.linked_document_ids as string[] | null) ?? []).filter((id) => id !== input.documentId)
        await adminSupabase.from('underwriting_checklist').update({ linked_document_ids: pruned }).eq('id', ci.id)
      }
    } catch (pruneErr: unknown) {
      const _msg = pruneErr instanceof Error ? pruneErr.message : 'Unknown error'
      console.error('Checklist array prune after document delete failed (non-fatal):', _msg)
    }

    const { error: storageError } = await adminSupabase.storage.from('deal-documents').remove([document.file_path])
    if (storageError) {
      console.error('Document storage delete error (DB row already removed):', storageError.message)
      // Best-effort: DB row is gone, the orphaned storage object is leaked
      // but not user-facing. Don't fail the request.
    }

    // Audit log
    await logAuditEvent({
      action: 'document.delete',
      entityType: 'document',
      entityId: input.documentId,
      metadata: {
        deal_id: document.deal_id,
        file_name: document.file_name,
        storage_orphaned: Boolean(storageError),
      },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Document delete error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// SEC-D4 helper: a brokerage admin may administer a brokerage via the legacy
// user_profiles.brokerage_id column OR the brokerage_admins junction (migrations
// 087/095). Service-role lookup, so it bypasses RLS to resolve membership but
// can never grant access to a brokerage the user does not actually administer.
// ============================================================================

async function brokerageAdminCanAccessBrokerage(
  serviceClient: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  profileBrokerageId: string | null | undefined,
  dealBrokerageId: string | null | undefined,
): Promise<boolean> {
  if (!dealBrokerageId) return false
  if (profileBrokerageId && profileBrokerageId === dealBrokerageId) return true
  const { data, error } = await serviceClient
    .from('brokerage_admins')
    .select('id')
    .eq('brokerage_id', dealBrokerageId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    console.error('brokerage_admins membership check failed:', error.message)
    return false
  }
  return !!data
}

// ============================================================================
// Server Action: Generate signed download URL
// ============================================================================

export async function getDocumentSignedUrl(input: {
  documentId: string
}): Promise<ActionResult> {
  // Allow admins, agents, and brokerage admins
  const { error: authErr, profile } = await getAuthenticatedUser(['super_admin', 'firm_funds_admin', 'agent', 'brokerage_admin'])
  if (authErr || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const serviceClient = createServiceRoleClient()
    const { data: document, error: documentError } = await serviceClient
      .from('deal_documents')
      .select('id, deal_id, file_name, file_path, deals(agent_id, brokerage_id)')
      .eq('id', input.documentId)
      .single()

    if (documentError || !document) {
      return { success: false, error: 'Document not found' }
    }

    type DocumentDealJoin = { agent_id?: string | null; brokerage_id?: string | null }
    type DocumentWithDeals = { deals: DocumentDealJoin | DocumentDealJoin[] | null }
    const docWithDeals = document as DocumentWithDeals
    const deal: DocumentDealJoin | null = Array.isArray(docWithDeals.deals)
      ? docWithDeals.deals[0] ?? null
      : docWithDeals.deals

    if (!deal) {
      return { success: false, error: 'Document deal not found' }
    }

    // Authorization: verify the user actually has access to the document's deal.
    // The storage path is intentionally loaded from the trusted DB record, not
    // supplied by the caller.
    if (profile.role === 'agent') {
      if (!deal || deal.agent_id !== profile.agent_id) {
        return { success: false, error: 'Access denied' }
      }
    } else if (profile.role === 'brokerage_admin') {
      const allowed = await brokerageAdminCanAccessBrokerage(
        serviceClient, profile.id, profile.brokerage_id, deal.brokerage_id,
      )
      if (!allowed) {
        return { success: false, error: 'Access denied' }
      }
    }
    // super_admin and firm_funds_admin can access all deals

    const { data, error } = await serviceClient.storage
      .from('deal-documents')
      .createSignedUrl(document.file_path, 3600, { download: false })

    if (error) {
      console.error('Signed URL error:', error.message)
      return { success: false, error: 'Failed to generate download link' }
    }

    await logAuditEvent({
      action: 'document.view',
      entityType: 'document',
      entityId: document.id,
      metadata: {
        deal_id: document.deal_id,
        file_name: document.file_name,
        access_type: 'signed_url',
      },
    })

    return { success: true, data: { signedUrl: data.signedUrl } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Signed URL error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Upload document with server-side validation
// ============================================================================

export async function uploadDocument(formData: FormData): Promise<ActionResult> {
  // Multi-role by design: agents and brokerage admins upload to their own deals;
  // internal staff upload on anyone's deal. Access is row-scoped by role below,
  // so this stays a role gate (NOT capability-gated). All internal staff hold
  // documents.write anyway, so behavior is unchanged for them.
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['agent', 'brokerage_admin', 'super_admin', 'firm_funds_admin'])
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
      // Brokerage admins can upload to deals belonging to a brokerage they
      // administer, via the legacy brokerage_id column OR the brokerage_admins
      // junction. Read the deal with the service client so a junction-only admin
      // (whose user_profiles.brokerage_id may differ) is not blocked by deals RLS
      // before we can authorize.
      const svc = createServiceRoleClient()
      const { data: deal, error: dealError } = await svc
        .from('deals')
        .select('id, brokerage_id')
        .eq('id', dealId)
        .single()

      if (dealError || !deal) {
        return { success: false, error: 'Deal not found' }
      }

      const allowed = await brokerageAdminCanAccessBrokerage(
        svc, user.id, profile.brokerage_id, deal.brokerage_id,
      )
      if (!allowed) {
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
    if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
      return { success: false, error: `File type not allowed. Accepted: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}` }
    }

    // Validate MIME type
    if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
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
        .select('property_address, deal_number, agent_id, agents(first_name, last_name)')
        .eq('id', dealId)
        .single()

      const agent = (dealInfo as { agents?: { first_name: string; last_name: string } | null } | null)?.agents
      const uploaderName = profile.full_name || 'Unknown User'

      sendDocumentUploadedNotification({
        dealId,
        dealNumber: dealInfo?.deal_number,
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Document upload error:', _msg)
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
  brokerageFlatFee?: number
  notes?: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['agent'])
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
      brokerageFlatFee: input.brokerageFlatFee,
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
        brokerage_flat_fee: input.brokerageFlatFee ?? 0,
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Deal update error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Cancel deal (agent only — before funding)
// ============================================================================

export async function cancelDeal(input: { dealId: string }): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['agent'])
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
      // Under review = hasn't been touched yet — delete it entirely.
      // CAPTURE storage paths BEFORE deleting the deal_documents rows.
      // Previously the storage query ran AFTER the DELETE, returning zero
      // rows and leaking the files in storage (which the migration 053
      // bucket-policy tightening makes less dangerous, but still wasteful).
      const { data: docs } = await adminClient.from('deal_documents').select('file_path').eq('deal_id', input.dealId)

      // Now delete metadata rows
      await adminClient.from('document_requests').delete().eq('deal_id', input.dealId)
      await adminClient.from('deal_documents').delete().eq('deal_id', input.dealId)
      await adminClient.from('underwriting_checklist').delete().eq('deal_id', input.dealId)

      // Then storage files (with the paths we captured above)
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

    // Approved = already reviewed — mark as cancelled instead of deleting.
    // Task 2: add version-based optimistic lock alongside the status CAS so a
    // concurrent admin write cannot silently clobber other fields between our
    // SELECT above and this UPDATE. Builder cast to any to dodge TS2589 until
    // types are regenerated post migration 083.
    const cancelVersion = (deal as { version?: number }).version ?? null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase generic recursion limit chokes on .eq('version') until types are regenerated
    const { data: updatedDeal, error: updateError } = await ((adminClient as any)
      .from('deals')
      .update({ status: 'cancelled' })
      .eq('id', input.dealId)
      .eq('status', deal.status)
      .eq('version', cancelVersion)
      .select()
      .maybeSingle())

    if (updateError) {
      console.error('Deal cancel error:', updateError.message)
      return { success: false, error: `Failed to cancel deal: ${updateError.message}` }
    }
    if (!updatedDeal) {
      return { success: false, error: 'This deal was updated by another user while you were viewing. Please refresh and try again.' }
    }

    await logAuditEvent({
      action: 'deal.cancel',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { old_status: deal.status, cancelled_by: user.id },
    })

    return { success: true, data: updatedDeal }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Deal cancel error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Delete deal (admin only)
// ============================================================================
// Allowed only for non-financial statuses (under_review / cancelled / denied).
// The DB trigger prevent_financial_deal_delete (migration 048) backstops this
// in case the action guard is ever bypassed.
// ============================================================================

const DELETABLE_DEAL_STATUSES = ['under_review', 'cancelled', 'denied'] as const

export async function deleteDeal(input: { dealId: string }): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('deal.delete')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  // Mutations use the service-role client so we don't depend on admin RLS
  // permitting DELETE on closing_date_amendments / deal_documents (migration
  // 056 removed those). Authorization was already proven above.
  const serviceClient = createServiceRoleClient()

  try {
    // 1. Verify deal is in a deletable status
    const { data: deal, error: fetchErr } = await serviceClient
      .from('deals')
      .select('id, status, property_address')
      .eq('id', input.dealId)
      .single()

    if (fetchErr || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    if (!DELETABLE_DEAL_STATUSES.includes(deal.status as typeof DELETABLE_DEAL_STATUSES[number])) {
      return {
        success: false,
        error: `Cannot delete deal in status "${deal.status}". Only under_review, cancelled, or denied deals can be deleted.`,
      }
    }

    // 2. Get storage paths for cleanup
    const { data: docs } = await serviceClient
      .from('deal_documents')
      .select('file_path')
      .eq('deal_id', input.dealId)

    // 3. Clean up RESTRICT-protected child records first (envelopes, amendments).
    //    These are never expected on a deletable-status deal, but if they exist
    //    they must be removed explicitly because their FKs are ON DELETE RESTRICT
    //    (migration 049). remediation_deals is not cleaned up here: if one exists
    //    against a deletable deal something is wrong; refuse the delete.
    const { count: remediationCount } = await serviceClient
      .from('remediation_deals')
      .select('id', { count: 'exact', head: true })
      .eq('failed_deal_id', input.dealId)

    if ((remediationCount ?? 0) > 0) {
      return {
        success: false,
        error: 'Deal has remediation_deals attached. Investigate before deleting.',
      }
    }

    await serviceClient.from('esignature_envelopes').delete().eq('deal_id', input.dealId)
    await serviceClient.from('closing_date_amendments').delete().eq('deal_id', input.dealId)

    // 4. Cascading children (deal_documents, underwriting_checklist) will be
    //    handled by ON DELETE CASCADE, but clear deal_documents first so we can
    //    remove the storage files (DB row before storage avoids orphan refs).
    await serviceClient.from('deal_documents').delete().eq('deal_id', input.dealId)
    await serviceClient.from('underwriting_checklist').delete().eq('deal_id', input.dealId)

    if (docs && docs.length > 0) {
      await serviceClient.storage
        .from('deal-documents')
        .remove(docs.map(d => d.file_path))
    }

    // 5. Delete the deal itself
    const { error: deleteError } = await serviceClient
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
      metadata: {
        deleted_by: user.id,
        prior_status: deal.status,
        property_address: deal.property_address,
      },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Deal delete error:', _msg)
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
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('documents.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Validate document type
    if (!(VALID_DOCUMENT_TYPE_VALUES as readonly string[]).includes(input.documentType)) {
      return { success: false, error: 'Invalid document type' }
    }

    // Fetch deal + agent info
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, property_address, deal_number, agent_id')
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
      dealNumber: deal.deal_number,
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Document request error:', _msg)
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
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('documents.write')
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Fulfill request error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Cancel document request (admin only)
// ============================================================================

export async function cancelDocumentRequest(input: {
  requestId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('documents.write')
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
  } catch {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Save Admin Notes
// ============================================================================

export async function saveAdminNotes(input: { dealId: string; adminNotes: string }): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('comms')
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Admin notes save error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Add admin note (append to JSONB timeline)
// ============================================================================

export async function addAdminNote(input: { dealId: string; note: string }): Promise<ActionResult> {
  const { error: authErr, user, profile } = await getAuthenticatedCapable('comms')
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  const noteText = input.note.trim()
  if (!noteText) return { success: false, error: 'Note cannot be empty' }

  try {
    const newEntry = {
      id: crypto.randomUUID(),
      text: noteText,
      author_id: user.id,
      author_name: profile.full_name || user.email || 'Admin',
      created_at: new Date().toISOString(),
    }

    // Atomic append via migration 077 RPC. Replaces the previous
    // read-modify-write which lost notes when two admins commented at
    // the same time. The RPC runs a single UPDATE using jsonb
    // concatenation against the live row, so row-level locking
    // serializes concurrent appenders and both notes survive.
    const serviceClient = createServiceRoleClient()
    const { data: timeline, error: rpcError } = await serviceClient
      .rpc('append_admin_note', {
        p_deal_id: input.dealId,
        p_entry: newEntry,
      })

    if (rpcError) {
      console.error('Admin note add error:', rpcError.message)
      return { success: false, error: `Failed to add note: ${rpcError.message}` }
    }

    await logAuditEvent({
      action: 'deal.admin_note_added',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: { author: profile.full_name, note_preview: noteText.substring(0, 100) },
    })

    return { success: true, data: { timeline: timeline ?? [], newEntry } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Admin note add error:', _msg)
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
  const { error: authErr, user, profile, supabase } = await getAuthenticatedCapable('deal.underwrite')
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Fetch the deal
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*, brokerages(referral_fee_percentage, settlement_days_override, auto_bumped_to_14_days_at)')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    const newDays = calcDaysUntilClosing(input.newClosingDate)
    if (newDays < MIN_DAYS_UNTIL_CLOSING) {
      return { success: false, error: `New closing date must be at least ${MIN_DAYS_UNTIL_CLOSING} days from today` }
    }

    type DealWithBrokerage = { brokerages?: { referral_fee_percentage: number | null; settlement_days_override?: number | null; auto_bumped_to_14_days_at?: string | null } | null }
    const referralPct = (deal as DealWithBrokerage).brokerages?.referral_fee_percentage
    if (referralPct === null || referralPct === undefined) {
      return { success: false, error: 'Brokerage referral fee not configured' }
    }

    // Use the snapshotted settlement window if the deal has already been funded;
    // otherwise compute from the brokerage's current effective settings.
    const settlementDays = deal.settlement_days_at_funding
      ?? effectiveSettlementDays((deal as DealWithBrokerage).brokerages)

    // Recalculate with new days
    const newCalc = calculateDeal({
      grossCommission: deal.gross_commission,
      brokerageSplitPct: deal.brokerage_split_pct,
      brokerageFlatFee: Number(deal.brokerage_flat_fee ?? 0),
      daysUntilClosing: newDays,
      discountRate: DISCOUNT_RATE_PER_1000_PER_DAY,
      brokerageReferralPct: referralPct,
      settlementPeriodDays: settlementDays,
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

    // Recalculate due date when closing date changes — closing + the effective
    // settlement window for this deal (snapshotted or computed)
    const newClosingDate = new Date(input.newClosingDate + 'T00:00:00Z')
    const newDueDate = new Date(newClosingDate.getTime() + settlementDays * 24 * 60 * 60 * 1000)
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
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Closing date update error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Server Action: Mark deal as failed to close (admin only)
// CPA Article 5.1/5.2/5.3 — triggers mandatory cure election under 5.5
// ============================================================================

export async function markDealFailedToClose(input: {
  dealId: string
  failureType: 'non_closing' | 'commission_deficiency'
  outstandingAmount: number
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.reason?.trim()) {
    return { success: false, error: 'Failure reason is required' }
  }
  if (!Number.isFinite(input.outstandingAmount) || input.outstandingAmount <= 0) {
    return { success: false, error: 'Outstanding amount must be greater than zero' }
  }
  if (input.failureType !== 'non_closing' && input.failureType !== 'commission_deficiency') {
    return { success: false, error: 'Invalid failure type' }
  }

  try {
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    if (deal.status !== 'funded') {
      return { success: false, error: `Cannot mark deal as failed: status is "${deal.status}". Only funded deals can be marked as failed to close.` }
    }

    // Task 3: Validate the deal has actually been funded and isn't ancient.
    // A funded deal with no funding_date is data-corrupt and shouldn't be
    // failed-to-close without admin intervention. The 90-day cutoff catches
    // cases where the lawyer says the deal failed months ago — the contract
    // mechanics around interest accrual and remediation assume the failure
    // is fresh, so we want a senior admin in the loop before proceeding.
    if (!deal.funding_date) {
      return { success: false, error: 'Deal must have a funding date before marking failed to close' }
    }
    const fundedAgo = Date.now() - new Date(deal.funding_date).getTime()
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000
    if (fundedAgo > NINETY_DAYS_MS) {
      return { success: false, error: 'Deal was funded more than 90 days ago. Contact a senior admin before marking failed to close — contract terms may have shifted.' }
    }

    const now = new Date()
    const deadline = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000)

    // Task 2 + audit finding #6: claim the deal first via version-based CAS;
    // only then post the agent balance so a failed RPC can't leave a funded
    // deal with no ledger entry. Status equality preserved as belt+suspenders.
    // Builder cast to any to dodge TS2589 until types are regenerated post
    // migration 083.
    const currentVersion = (deal as { version?: number }).version ?? null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase generic recursion limit chokes on .eq('version') until types are regenerated
    const { data: updatedRows, error: updateError } = await ((supabase as any)
      .from('deals')
      .update({
        status: 'failed_to_close',
        failed_to_close_at: now.toISOString(),
        failure_type: input.failureType,
        failure_reason: input.reason.trim(),
        outstanding_balance: input.outstandingAmount,
        cure_election_deadline: deadline.toISOString(),
        payment_status: 'not_applicable',
      })
      .eq('id', deal.id)
      .eq('status', 'funded')
      .eq('version', currentVersion)
      .select())

    if (updateError) {
      console.error('Deal failed-to-close update error:', updateError.message)
      return { success: false, error: `Failed to update deal: ${updateError.message}` }
    }
    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: 'Deal status was changed by another user. Please refresh and try again.' }
    }

    const serviceClient = createServiceRoleClient()

    const { data: agent } = await serviceClient
      .from('agents')
      .select('id, first_name, last_name, email')
      .eq('id', deal.agent_id)
      .single()

    // Atomic balance + ledger write via RPC (migration 052). The previous
    // read-modify-write could race with concurrent interest accruals.
    const { error: rpcErr } = await serviceClient
      .rpc('apply_agent_balance_delta', {
        p_agent_id: deal.agent_id,
        p_delta: input.outstandingAmount,
        p_type: 'failed_deal_balance',
        p_description: input.failureType === 'non_closing'
          ? `Failed deal — full Purchase Price owed (${deal.property_address})`
          : `Commission deficiency — shortfall owed (${deal.property_address})`,
        p_deal_id: deal.id,
        p_created_by: user.id,
      })
    if (rpcErr) {
      console.error('markDealFailedToClose balance RPC error:', rpcErr.message)
      const { error: revertErr } = await serviceClient
        .from('deals')
        .update({
          status: 'funded',
          failed_to_close_at: null,
          failure_type: null,
          failure_reason: null,
          outstanding_balance: 0,
          cure_election_deadline: null,
          payment_status: deal.payment_status,
        })
        .eq('id', deal.id)
        .eq('status', 'failed_to_close')
      if (revertErr) {
        console.error('CRITICAL: failed-to-close balance post failed AND status revert failed:', revertErr.message)
      }
      return { success: false, error: `Failed to record balance owed: ${rpcErr.message}` }
    }

    await logAuditEvent({
      action: 'deal.failed_to_close',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        failure_type: input.failureType,
        outstanding_amount: input.outstandingAmount,
        reason: input.reason.trim(),
        cure_election_deadline: deadline.toISOString(),
      },
    })

    if (agent?.email) {
      sendFailedToCloseElectionEmail({
        dealId: deal.id,
        dealNumber: deal.deal_number,
        propertyAddress: deal.property_address,
        agentEmail: agent.email,
        agentFirstName: agent.first_name,
        failureType: input.failureType,
        outstandingAmount: input.outstandingAmount,
        deadline: deadline.toISOString(),
      })
    }

    return { success: true, data: { dealId: deal.id } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('markDealFailedToClose error:', _msg)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Server Action: Submit cure election (agent only)
// CPA Article 5.5 — agent chooses cash or commission assignment within 15 days
// ============================================================================

export async function submitCureElection(input: {
  dealId: string
  election: 'cash_repayment' | 'commission_assignment'
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['agent'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  if (input.election !== 'cash_repayment' && input.election !== 'commission_assignment') {
    return { success: false, error: 'Invalid election' }
  }

  try {
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, agent_id, status, cure_election, property_address, outstanding_balance')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) {
      return { success: false, error: 'Deal not found' }
    }

    if (deal.agent_id !== profile.agent_id) {
      return { success: false, error: 'This deal does not belong to you' }
    }

    if (deal.status !== 'failed_to_close') {
      return { success: false, error: 'This deal is not in a failed-to-close state' }
    }

    if (deal.cure_election) {
      return { success: false, error: 'You have already made your election on this deal' }
    }

    // Use service role for the write — agents don't have a row-level UPDATE
    // policy on deals. Authorization is enforced above (agent_id check,
    // status check, election-still-null check). Task 2: add version-based
    // optimistic lock on top of the existing `cure_election IS NULL` guard.
    // Builder cast to any to dodge TS2589 until types are regenerated post
    // migration 083.
    const serviceClient = createServiceRoleClient()
    const electionVersion = (deal as { version?: number }).version ?? null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase generic recursion limit chokes on .eq('version') until types are regenerated
    const { data: updated, error: updateError } = await ((serviceClient as any)
      .from('deals')
      .update({
        cure_election: input.election,
        cure_election_at: new Date().toISOString(),
      })
      .eq('id', deal.id)
      .is('cure_election', null)
      .eq('version', electionVersion)
      .select())

    if (updateError) {
      console.error('Cure election update error:', updateError.message)
      return { success: false, error: `Failed to record election: ${updateError.message}` }
    }
    if (!updated || updated.length === 0) {
      return { success: false, error: 'Election was already recorded or another change landed first. Please refresh.' }
    }

    await logAuditEvent({
      action: 'deal.cure_election',
      entityType: 'deal',
      entityId: deal.id,
      metadata: {
        election: input.election,
      },
    })

    return { success: true, data: { election: input.election } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('submitCureElection error:', _msg)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Task 4 — Failed funding (EFT bounce) handler
// ----------------------------------------------------------------------------
// When the EFT for a funded deal bounces, admin records it via this action.
// We flip status funded -> funding_failed and, if a balance deduction was
// applied at funding time, reverse it back to the agent's account so they
// aren't paying down an advance that never landed in their bank.
// ============================================================================

export async function markFundingFailed(input: {
  dealId: string
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const reason = (input.reason || '').trim()
  if (!reason) return { success: false, error: 'Reason is required (e.g. NSF, account closed, wrong banking info)' }
  if (reason.length > 500) return { success: false, error: 'Reason must be under 500 characters' }

  try {
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }
    if (deal.status !== 'funded') {
      return { success: false, error: `Cannot mark funding as failed: deal status is "${deal.status}". Only funded deals can be marked.` }
    }

    const currentVersion = (deal as { version?: number }).version ?? null  // TODO: regen types after migration 083 applied
    const priorBalanceDeducted = Number(deal.balance_deducted || 0)
    const now = new Date().toISOString()

    // CAS-claim the deal so a concurrent admin action can't race us into a
    // double-reversal of the balance deduction. Builder cast to any to dodge
    // TS2589 until types are regenerated post migrations 083 + 084.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase generic recursion limit chokes on .eq('version') until types are regenerated
    const { data: updatedRows, error: updateError } = await ((supabase as any)
      .from('deals')
      .update({
        status: 'funding_failed',
        funding_failure_reason: reason,
        funding_failed_at: now,
        payment_status: 'not_applicable',
        // Clear the deducted amount up front; we're about to refund it (if any).
        balance_deducted: 0,
      })
      .eq('id', deal.id)
      .eq('status', 'funded')
      .eq('version', currentVersion)
      .select())

    if (updateError) {
      console.error('markFundingFailed update error:', updateError.message)
      return { success: false, error: `Failed to mark funding failed: ${updateError.message}` }
    }
    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: 'This deal was updated by another user while you were viewing. Please refresh and try again.' }
    }

    // Reverse the prior balance deduction (if any) so the agent's account is
    // made whole. RPC requires service role.
    if (priorBalanceDeducted > 0) {
      const serviceClient = createServiceRoleClient()
      const { error: rpcErr } = await serviceClient
        .rpc('apply_agent_balance_delta', {
          p_agent_id: deal.agent_id,
          p_delta: priorBalanceDeducted,
          p_type: 'balance_deduction_reversed',
          p_description: `Funding failed: reversal of balance deduction for ${deal.property_address} (${reason.slice(0, 100)})`,
          p_deal_id: deal.id,
          p_created_by: user.id,
        })
      if (rpcErr) {
        // The status flip already landed. Surface the discrepancy loudly so
        // admin can manually reconcile via the ledger UI — we don't try to
        // revert the status because we'd then need another CAS and could end
        // up with both writes failing. The audit log captures the partial.
        console.error('CRITICAL: markFundingFailed status flipped but balance reversal RPC failed:', rpcErr.message)
        await logAuditEvent({
          action: 'deal.funding_failed_reversal_failed',
          entityType: 'deal',
          entityId: deal.id,
          severity: 'critical',
          metadata: {
            agent_id: deal.agent_id,
            expected_reversal: priorBalanceDeducted,
            error: rpcErr.message,
          },
        })
        return {
          success: false,
          error: `Funding marked as failed, but the balance reversal of $${priorBalanceDeducted.toFixed(2)} did NOT post. Apply a manual credit on the agent ledger to reconcile.`,
        }
      }
    }

    // Reverse the informational "Advance issued" charge so the agent's
    // statement does not keep showing an advance whose funding bounced.
    if (deal.agent_id) {
      await reverseDealAdvanceEntry(createServiceRoleClient(), {
        agentId: deal.agent_id,
        dealId: deal.id,
        amount: Number(deal.amount_due_from_brokerage || 0),
        propertyAddress: deal.property_address ?? null,
        reason: 'funding failed',
        createdBy: user.id,
      })
    }

    await logAuditEvent({
      action: 'deal.funding_failed',
      entityType: 'deal',
      entityId: deal.id,
      severity: 'critical',
      metadata: {
        reason,
        balance_reversed: priorBalanceDeducted,
        property_address: deal.property_address,
      },
      oldValue: { status: 'funded', balance_deducted: priorBalanceDeducted },
      newValue: { status: 'funding_failed', balance_deducted: 0 },
    })

    return {
      success: true,
      data: {
        dealId: deal.id,
        status: 'funding_failed',
        balanceReversed: priorBalanceDeducted,
      },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('markFundingFailed error:', _msg)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Task 4 — Retry funding after a previous EFT failure
// ----------------------------------------------------------------------------
// Flips funding_failed -> approved so the admin can re-run the standard
// approve-then-fund flow (which will deduct the balance again via the existing
// path). Symmetric with markFundingFailed: this restores the deal to a state
// where the next funding attempt is a normal updateDealStatus('funded') call.
// ============================================================================

export async function retryFundingAfterFailure(input: {
  dealId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('*')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }
    if (deal.status !== 'funding_failed') {
      return { success: false, error: `Cannot retry funding: deal status is "${deal.status}", expected "funding_failed".` }
    }

    const currentVersion = (deal as { version?: number }).version ?? null  // TODO: regen types after migration 083 applied

    // Flip back to approved. We deliberately do NOT re-deduct here — the
    // existing approved->funded path runs the balance deduction so we keep
    // exactly one code path that touches the agent ledger on funding. Builder
    // cast to any to dodge TS2589 until types are regenerated post migrations
    // 083 + 084.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase generic recursion limit chokes on .eq('version') until types are regenerated
    const { data: updatedRows, error: updateError } = await ((supabase as any)
      .from('deals')
      .update({
        status: 'approved',
        // Clear the failure markers so the deal looks like a clean approval.
        funding_failure_reason: null,
        funding_failed_at: null,
        funding_date: null,
        payment_status: 'not_applicable',
        // Already cleared by markFundingFailed but be defensive.
        balance_deducted: 0,
      })
      .eq('id', deal.id)
      .eq('status', 'funding_failed')
      .eq('version', currentVersion)
      .select())

    if (updateError) {
      console.error('retryFundingAfterFailure update error:', updateError.message)
      return { success: false, error: `Failed to retry funding: ${updateError.message}` }
    }
    if (!updatedRows || updatedRows.length === 0) {
      return { success: false, error: 'This deal was updated by another user while you were viewing. Please refresh and try again.' }
    }

    await logAuditEvent({
      action: 'deal.funding_retry_requested',
      entityType: 'deal',
      entityId: deal.id,
      severity: 'warning',
      metadata: {
        prior_failure_reason: deal.funding_failure_reason ?? null,
        prior_failure_at: deal.funding_failed_at ?? null,
      },
      oldValue: { status: 'funding_failed' },
      newValue: { status: 'approved' },
    })

    return {
      success: true,
      data: {
        dealId: deal.id,
        status: 'approved',
      },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('retryFundingAfterFailure error:', _msg)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ============================================================================
// Task 5 — Build a prefill object from a denied deal for resubmission
// ----------------------------------------------------------------------------
// Returns the form-ready fields the UI needs to seed a new submission form.
// This does NOT create the new deal — the UI calls submitDeal /
// submitDealAsBrokerage with the prefilled values, passing originalDealId
// as revisedFromDealId so the lineage is preserved on insert.
// ============================================================================

export async function createRevisedDealFromDenied(input: {
  originalDealId: string
}): Promise<ActionResult> {
  const { error: authErr, user, profile, supabase } = await getAuthenticatedWriter(['agent', 'brokerage_admin'])
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: original, error: fetchErr } = await supabase
      .from('deals')
      .select('id, agent_id, brokerage_id, status, property_address, closing_date, gross_commission, brokerage_split_pct, brokerage_flat_fee, notes, denial_reason')
      .eq('id', input.originalDealId)
      .single()

    if (fetchErr || !original) return { success: false, error: 'Original deal not found' }

    // Permission: agents can only revise their own deal; brokerage_admin can
    // revise deals belonging to any agent at their brokerage.
    if (profile.role === 'agent') {
      if (original.agent_id !== profile.agent_id) {
        return { success: false, error: 'You can only revise your own deals' }
      }
    } else if (profile.role === 'brokerage_admin') {
      if (original.brokerage_id !== profile.brokerage_id) {
        return { success: false, error: 'This deal belongs to another brokerage' }
      }
    }

    // Only denied deals can be revised. (Cancelled is reachable via the
    // standard new-deal flow without a revision link; failed/cured deals
    // have their own remediation path.)
    if (original.status !== 'denied') {
      return { success: false, error: `Only denied deals can be revised. This deal is "${original.status}".` }
    }

    // Strip the transaction-type prefix the submit path wraps notes in so the
    // user gets a clean editable note. If we can't parse it, return notes raw.
    let transactionType = ''
    let cleanNotes = ''
    const raw = original.notes ?? ''
    const m = raw.match(/^Transaction type:\s*(.+?)(?:\n([\s\S]*))?$/)
    if (m) {
      transactionType = m[1].trim()
      cleanNotes = (m[2] || '').trim()
    } else {
      cleanNotes = raw
    }

    return {
      success: true,
      data: {
        originalDealId: original.id,
        // Prefill values for the form
        propertyAddress: original.property_address,
        // The denied deal's closing date is almost certainly stale — bubble it
        // up so the UI can show "previously: X" but the user must pick a fresh
        // date that satisfies MIN_DAYS_UNTIL_CLOSING.
        previousClosingDate: original.closing_date,
        grossCommission: original.gross_commission,
        brokerageSplitPct: original.brokerage_split_pct,
        brokerageFlatFee: original.brokerage_flat_fee,
        transactionType,
        notes: cleanNotes,
        denialReason: original.denial_reason,
      },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('createRevisedDealFromDenied error:', _msg)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}
