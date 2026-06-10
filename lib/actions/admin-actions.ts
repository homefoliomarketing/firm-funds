'use server'

import crypto from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { sendAgentInviteNotification, sendBrokerageInviteNotification, sendPasswordResetNotification, sendEmailChangeNotification } from '@/lib/email'
import { getAuthenticatedAdmin, getAuthenticatedCapable } from '@/lib/auth-helpers'
import { hasCapability } from '@/lib/access'
import {
  CreateBrokerageSchema,
  UpdateBrokerageSchema,
  CreateAgentSchema,
  UpdateAgentSchema,
  CreateUserAccountSchema,
} from '@/lib/validations'
import {
  BROKERAGE_LATE_STRIKE_THRESHOLD,
  DISCOUNT_RATE_PER_1000_PER_DAY,
} from '@/lib/constants'
import {
  insertPayment,
  deletePayment,
  reviewPayment,
  sumConfirmedPayments,
} from '@/lib/brokerage-payments'
import { postDealRepaymentEntry } from '@/lib/agent-statement'
import { generateBrokerageLogoSvg } from '@/lib/brokerage-logo-generator'
import {
  parseCsv,
  parseXlsxRows,
  rowsToBulkAgents,
  RosterSheetTooLargeError,
  MAX_ROSTER_CSV_BYTES,
  MAX_ROSTER_XLSX_BYTES,
  MAX_ROSTER_ROWS,
  XLSX_SHEET_ROW_LIMIT,
  type BulkAgentRow,
} from '@/lib/roster-import'

// ============================================================================
// Auto-generate a brokerage's advance-division logo when none was supplied.
// Generates the SVG from the brokerage name, uploads it to the brokerage-logos
// bucket, and returns the public URL (with a cache buster). Returns null on
// any failure so the caller can proceed without a stored logo — the portal
// still renders a generated logo on the fly (see components/AgentHeader.tsx),
// this just makes the URL real so EMAIL/OG surfaces (which can only reference a
// URL) brand correctly too. Mirrors the admin "Generate Logo" button and
// scripts/regenerate-choice-advances-logo.mts.
// ============================================================================
async function generateAndStoreBrokerageLogo(
  brokerageId: string,
  brokerageName: string,
): Promise<string | null> {
  try {
    const name = brokerageName.trim()
    if (!name) return null
    const svc = createServiceRoleClient()
    const svg = generateBrokerageLogoSvg(name, { background: 'transparent' })
    const path = `${brokerageId}/logo-generated.svg`
    const { error: uploadErr } = await svc.storage
      .from('brokerage-logos')
      .upload(path, new Blob([svg], { type: 'image/svg+xml' }), {
        upsert: true,
        contentType: 'image/svg+xml',
      })
    if (uploadErr) {
      console.error('Auto-logo upload failed:', uploadErr.message)
      return null
    }
    const { data: { publicUrl } } = svc.storage.from('brokerage-logos').getPublicUrl(path)
    return `${publicUrl}?t=${Date.now()}`
  } catch (err) {
    console.error('Auto-logo generation failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ============================================================================
// Admin: manually record a Late Settlement Strike against a brokerage for a
// specific deal. Idempotent per deal — once a deal has late_strike_recorded
// set, this is a no-op. Auto-bumps the brokerage to 14-day settlement on the
// strike that brings them to BROKERAGE_LATE_STRIKE_THRESHOLD (5). Admin can
// undo via resetBrokerageLateStrikes() if needed.
//
// Recorded manually (not on payment-record) because in-transit wires can
// settle late through no fault of the brokerage; admin is the human judge.
// ============================================================================

export async function recordLateStrike(input: {
  dealId: string
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const reason = (input.reason || '').trim()
  if (!reason) return { success: false, error: 'A reason is required for the audit log' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: deal, error: dealErr } = await serviceClient
      .from('deals')
      .select('id, brokerage_id, status, closing_date, settlement_days_at_funding, due_date, property_address, late_strike_recorded')
      .eq('id', input.dealId)
      .single()

    if (dealErr || !deal) return { success: false, error: 'Deal not found' }
    if (deal.late_strike_recorded) return { success: false, error: 'A strike has already been recorded for this deal' }
    if (deal.status !== 'funded' && deal.status !== 'completed') {
      return { success: false, error: 'Strikes can only be recorded against funded or completed deals' }
    }
    if (!deal.brokerage_id || !deal.due_date) {
      return { success: false, error: 'Deal is missing required brokerage or due-date info' }
    }

    // Sanity: only allow strike if the deal is actually past its due_date
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
    const dueDateStr = typeof deal.due_date === 'string' ? deal.due_date.slice(0, 10) : new Date(deal.due_date as string | number | Date).toISOString().slice(0, 10)
    if (today <= dueDateStr) {
      return { success: false, error: 'Deal is not yet past its Payment Due Date' }
    }

    // audit finding #18: CAS-flip late_strike_recorded so two concurrent
    // strike clicks can't both pass the precheck and both call the RPC.
    const { data: claimed, error: claimErr } = await serviceClient
      .from('deals')
      .update({ late_strike_recorded: true })
      .eq('id', deal.id)
      .eq('late_strike_recorded', false)
      .select('id')
      .maybeSingle()

    if (claimErr) {
      return { success: false, error: `Failed to record strike: ${claimErr.message}` }
    }
    if (!claimed) {
      return { success: true, data: { idempotent: true } }
    }

    // Atomic strike increment + conditional bump via RPC (migration 052).
    const { data: strikeRows, error: strikeErr } = await serviceClient
      .rpc('record_brokerage_late_strike', {
        p_brokerage_id: deal.brokerage_id,
        p_strike_threshold: BROKERAGE_LATE_STRIKE_THRESHOLD,
      })

    if (strikeErr || !strikeRows || !Array.isArray(strikeRows) || strikeRows.length === 0) {
      return { success: false, error: `Failed to record strike: ${strikeErr?.message || 'unknown error'}` }
    }

    const strikeRow = strikeRows[0] as { new_strike_count?: number; bumped_now?: boolean }
    const newCount = Number(strikeRow.new_strike_count) || 0
    const shouldBump = Boolean(strikeRow.bumped_now)

    // Fetch brokerage name for audit metadata (no longer pre-fetched above).
    const { data: brokerage } = await serviceClient
      .from('brokerages')
      .select('id, name')
      .eq('id', deal.brokerage_id)
      .single()
    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    await logAuditEvent({
      action: 'brokerage.late_strike_recorded',
      entityType: 'deal',
      entityId: deal.id,
      severity: 'warning',
      metadata: {
        brokerage_id: brokerage.id,
        brokerage_name: brokerage.name,
        property_address: deal.property_address,
        due_date: dueDateStr,
        reason: reason.slice(0, 500),
        new_strike_count: newCount,
        auto_bumped: shouldBump,
        threshold: BROKERAGE_LATE_STRIKE_THRESHOLD,
      },
    })

    if (shouldBump) {
      await logAuditEvent({
        action: 'brokerage.auto_bumped_to_14_days',
        entityType: 'brokerage',
        entityId: brokerage.id,
        severity: 'warning',
        metadata: { trigger_deal_id: deal.id, threshold: BROKERAGE_LATE_STRIKE_THRESHOLD },
      })
    }

    return { success: true, data: { newStrikeCount: newCount, bumped: shouldBump } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('recordLateStrike error:', _msg)
    return { success: false, error: _msg || 'An unexpected error occurred' }
  }
}

// ============================================================================
// Admin: list funded deals that are past their Payment Due Date and have not
// yet had a Late Settlement Strike recorded. Drives the dashboard banner so
// the admin knows which deals need a strike-or-no-strike judgement call.
// ============================================================================

export async function getOverdueSettlementDeals(): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const serviceClient = createServiceRoleClient()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })

  try {
    const { data, error } = await serviceClient
      .from('deals')
      .select(`
        id,
        property_address,
        closing_date,
        due_date,
        amount_due_from_brokerage,
        brokerage_payments ( amount, status ),
        settlement_days_at_funding,
        agents:agent_id ( first_name, last_name ),
        brokerages:brokerage_id ( id, name )
      `)
      .eq('status', 'funded')
      .eq('late_strike_recorded', false)
      .lt('due_date', today)
      .order('due_date', { ascending: true })

    if (error) {
      console.error('getOverdueSettlementDeals error:', error.message)
      return { success: false, error: error.message }
    }

    type OverdueDealRow = {
      id: string
      property_address: string
      closing_date: string
      due_date: string | null
      amount_due_from_brokerage: number | string | null
      brokerage_payments: { amount: number; status: 'pending' | 'confirmed' | 'rejected' }[] | null
      settlement_days_at_funding: number | null
      agents: { first_name: string | null; last_name: string | null } | null
      brokerages: { id: string; name: string | null } | null
    }
    const rows = ((data as unknown as OverdueDealRow[]) || []).map((d) => {
      const amountDue = Number(d.amount_due_from_brokerage) || 0
      const confirmedTotal = sumConfirmedPayments(d.brokerage_payments)
      const outstanding = Math.max(0, Math.round((amountDue - confirmedTotal) * 100) / 100)
      const dueDateStr = d.due_date ? (d.due_date as string).slice(0, 10) : null
      const daysOverdue = dueDateStr
        ? Math.floor((new Date(today + 'T00:00:00Z').getTime() - new Date(dueDateStr + 'T00:00:00Z').getTime()) / 86400000)
        : 0
      return {
        deal_id: d.id,
        property_address: d.property_address,
        closing_date: d.closing_date,
        due_date: dueDateStr,
        days_overdue: daysOverdue,
        amount_due: amountDue,
        confirmed_total: confirmedTotal,
        outstanding,
        settlement_days: d.settlement_days_at_funding,
        agent_name: d.agents ? `${d.agents.first_name || ''} ${d.agents.last_name || ''}`.trim() : null,
        brokerage_id: d.brokerages?.id || null,
        brokerage_name: d.brokerages?.name || null,
      }
    })

    return { success: true, data: rows }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('getOverdueSettlementDeals error:', _msg)
    return { success: false, error: _msg }
  }
}

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

// ============================================================================
// Email-shape helper used by both brokerage create/update. Migration 086 makes
// brokerages.email + broker_of_record_email NOT NULL with a CHECK constraint;
// validating here gives a friendly app-level error instead of a 500 from the
// constraint. Regex matches the DB CHECK (deliberately permissive — rejects
// obvious garbage like "no-email" or "x@" without chasing RFC 5322).
// ============================================================================
const SIMPLE_EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function normalizeEmail(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

function validateBrokerageEmails(input: {
  email: string
  broker_of_record_email: string
}): { valid: boolean; error?: string; warning?: string } {
  const email = normalizeEmail(input.email)
  const bor = normalizeEmail(input.broker_of_record_email)

  if (!email) return { valid: false, error: 'Brokerage email is required' }
  if (!bor) return { valid: false, error: 'Broker of Record email is required' }
  if (!SIMPLE_EMAIL_REGEX.test(email)) {
    return { valid: false, error: 'Brokerage email is not a valid email address' }
  }
  if (!SIMPLE_EMAIL_REGEX.test(bor)) {
    return { valid: false, error: 'Broker of Record email is not a valid email address' }
  }
  // Non-fatal warning: BOR and general inbox SHOULD usually differ. Caller
  // logs this in audit metadata but does not block the save — some small
  // brokerages legitimately use the same inbox.
  if (email === bor) {
    return {
      valid: true,
      warning: 'Brokerage email and Broker of Record email are the same. This is allowed but unusual.',
    }
  }
  return { valid: true }
}

// ============================================================================
// Brokerage CRUD
// ============================================================================

export async function createBrokerage(input: {
  name: string
  email: string
  brand?: string
  address?: string
  city?: string
  province?: string
  postalCode?: string
  phone?: string
  referralFeePercentage: number
  transactionSystem?: string
  notes?: string
  brokerOfRecordName?: string
  brokerOfRecordEmail?: string
  logoUrl?: string
  /** TRUE if logoUrl was produced by the generator (Powered by Firm Funds baked in). Migration 096. */
  logoIncludesTagline?: boolean
  brandColor?: string
  isWhiteLabelPartner?: boolean
  profitSharePct?: number
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('brokerage.manage')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = CreateBrokerageSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    // Migration 086 makes both columns NOT NULL with an email-shape CHECK.
    // Enforce here (independently of the schema) so we get a friendly error
    // before hitting the DB. CreateBrokerageSchema already requires .email
    // but leaves brokerOfRecordEmail optional; we tighten BOR here.
    const normalizedEmail = normalizeEmail(v.email)
    const normalizedBorEmail = normalizeEmail(v.brokerOfRecordEmail ?? '')
    const emailValidation = validateBrokerageEmails({
      email: normalizedEmail,
      broker_of_record_email: normalizedBorEmail,
    })
    if (!emailValidation.valid) {
      return { success: false, error: emailValidation.error || 'Invalid email' }
    }

    const { data: brokerage, error: insertError } = await supabase
      .from('brokerages')
      .insert({
        name: v.name,
        email: normalizedEmail,
        brand: v.brand || null,
        address: v.address || null,
        city: v.city || null,
        province: v.province || null,
        postal_code: v.postalCode || null,
        phone: v.phone || null,
        referral_fee_percentage: v.referralFeePercentage,
        transaction_system: v.transactionSystem || null,
        notes: v.notes || null,
        broker_of_record_name: v.brokerOfRecordName || null,
        broker_of_record_email: normalizedBorEmail,
        logo_url: v.logoUrl || null,
        brand_color: v.brandColor || null,
        logo_includes_tagline: v.logoIncludesTagline ?? false,
        is_white_label_partner: v.isWhiteLabelPartner ?? false,
        profit_share_pct: v.profitSharePct ?? 0,
        status: 'active',
      })
      .select()
      .single()

    if (insertError) {
      console.error('Brokerage create error:', insertError.message)
      return { success: false, error: `Failed to create brokerage: ${insertError.message}` }
    }

    // Guarantee every brokerage starts with a generated advance-division logo.
    // If the admin didn't supply/generate one in the form, synthesize and store
    // it now so email/OG surfaces brand correctly from day one (the portal
    // already falls back to an on-the-fly generated logo regardless). Best
    // effort: a failure here never blocks brokerage creation.
    if (!v.logoUrl) {
      const generatedUrl = await generateAndStoreBrokerageLogo(brokerage.id, v.name)
      if (generatedUrl) {
        const { error: logoErr } = await supabase
          .from('brokerages')
          .update({ logo_url: generatedUrl, logo_includes_tagline: true })
          .eq('id', brokerage.id)
        if (logoErr) {
          console.error('Auto-logo row update failed:', logoErr.message)
        } else {
          brokerage.logo_url = generatedUrl
          brokerage.logo_includes_tagline = true
        }
      }
    }

    await logAuditEvent({
      action: 'brokerage.create',
      entityType: 'brokerage',
      entityId: brokerage.id,
      metadata: {
        name: input.name,
        email: normalizedEmail,
        broker_of_record_email: normalizedBorEmail,
        emails_warning: emailValidation.warning || null,
      },
    })

    return { success: true, data: brokerage }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Brokerage create error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function updateBrokerage(input: {
  id: string
  name: string
  email: string
  brand?: string
  address?: string
  city?: string
  province?: string
  postalCode?: string
  phone?: string
  referralFeePercentage: number
  transactionSystem?: string
  notes?: string
  brokerOfRecordName?: string
  brokerOfRecordEmail?: string
  logoUrl?: string
  /** TRUE if logoUrl was produced by the generator (Powered by Firm Funds baked in). Migration 096. */
  logoIncludesTagline?: boolean
  brandColor?: string
  isWhiteLabelPartner?: boolean
  profitSharePct?: number
  status: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('brokerage.manage')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = UpdateBrokerageSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    // Migration 086: both email columns NOT NULL with CHECK constraint.
    // updateBrokerage MUST NOT null these out — re-validate here so a UI bug
    // that submits a blank field gets a friendly error before the DB rejects.
    const normalizedEmail = normalizeEmail(v.email)
    const normalizedBorEmail = normalizeEmail(v.brokerOfRecordEmail ?? '')
    const emailValidation = validateBrokerageEmails({
      email: normalizedEmail,
      broker_of_record_email: normalizedBorEmail,
    })
    if (!emailValidation.valid) {
      return { success: false, error: emailValidation.error || 'Invalid email' }
    }

    // Snapshot previous profit-share state to detect onboarding transition.
    // We trigger welcome emails when profit_share_pct goes from 0 to >0.
    const { data: prev } = await supabase
      .from('brokerages')
      .select('profit_share_pct')
      .eq('id', v.id)
      .single()

    const prevPct = Number(prev?.profit_share_pct ?? 0)
    const newPct = Number(v.profitSharePct ?? 0)
    const becamePartner = prevPct === 0 && newPct > 0

    const { data: brokerage, error: updateError } = await supabase
      .from('brokerages')
      .update({
        name: v.name,
        email: normalizedEmail,
        brand: v.brand || null,
        address: v.address || null,
        city: v.city || null,
        province: v.province || null,
        postal_code: v.postalCode || null,
        phone: v.phone || null,
        referral_fee_percentage: v.referralFeePercentage,
        transaction_system: v.transactionSystem || null,
        notes: v.notes || null,
        broker_of_record_name: v.brokerOfRecordName || null,
        broker_of_record_email: normalizedBorEmail,
        logo_url: v.logoUrl || null,
        brand_color: v.brandColor || null,
        logo_includes_tagline: v.logoIncludesTagline ?? false,
        is_white_label_partner: v.isWhiteLabelPartner ?? false,
        profit_share_pct: v.profitSharePct ?? 0,
        status: v.status,
      })
      .eq('id', v.id)
      .select()
      .single()

    if (updateError) {
      console.error('Brokerage update error:', updateError.message)
      return { success: false, error: `Failed to update brokerage: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'brokerage.update',
      entityType: 'brokerage',
      entityId: input.id,
      metadata: {
        name: input.name,
        status: input.status,
        is_white_label_partner: v.isWhiteLabelPartner,
        profit_share_pct: v.profitSharePct,
        became_partner: becamePartner,
      },
    })

    // On activation transition: queue welcome emails to roster.
    // Awaited so Netlify doesn't kill the promise after response.
    let welcomeQueued: { sent: number; failed: number } | undefined
    if (becamePartner) {
      const result = await sendWelcomeToAllBrokerageAgents({ brokerageId: v.id })
      if (result.success && result.data) {
        welcomeQueued = { sent: result.data.sent ?? 0, failed: result.data.failed ?? 0 }
      }
    }

    return { success: true, data: { ...brokerage, welcomeQueued } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Brokerage update error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Agent CRUD
// ============================================================================

// ⚠️ TEMPORARY: email is optional for testing roster uploads without live emails
// REVERT BEFORE GO-LIVE: make email required again
export async function createAgent(input: {
  brokerageId: string
  firstName: string
  lastName: string
  email?: string | null
  phone?: string
  recoNumber?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('agent.invite')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = CreateAgentSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    // Verify brokerage exists (incl. white-label branding for invite email)
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('id, name, logo_url, logo_includes_tagline, is_white_label_partner')
      .eq('id', v.brokerageId)
      .single()

    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    const email = v.email || null

    // Check if agent email already exists (only if email provided)
    if (email) {
      const { data: existingAgent } = await supabase
        .from('agents')
        .select('id')
        .eq('email', email)
        .neq('status', 'archived')
        .maybeSingle()

      if (existingAgent) return { success: false, error: 'An agent with this email already exists' }
    }

    const serviceClient = createServiceRoleClient()
    const { data: agent, error: insertError } = await serviceClient
      .from('agents')
      .insert({
        brokerage_id: v.brokerageId,
        first_name: v.firstName,
        last_name: v.lastName,
        email,
        phone: v.phone || null,
        reco_number: v.recoNumber || null,
        status: 'active',
        flagged_by_brokerage: false,
        outstanding_recovery: 0,
      })
      .select()
      .single()

    if (insertError) {
      console.error('Agent create error:', insertError.message)
      return { success: false, error: `Failed to create agent: ${insertError.message}` }
    }

    await logAuditEvent({
      action: 'agent.create',
      entityType: 'agent',
      entityId: agent.id,
      metadata: { name: `${v.firstName} ${v.lastName}`, email: v.email || 'no-email', brokerage_id: v.brokerageId },
    })

    return { success: true, data: agent }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Agent create error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Bulk import agents from parsed spreadsheet data
//
// Parsing helpers (parseCsv, parseXlsxRows, rowsToBulkAgents) live in
// lib/roster-import.ts so they can be unit-tested; this 'use server' file
// can only export async functions.
// ============================================================================

interface BulkImportResult {
  success: boolean
  error?: string
  data?: {
    imported: number
    skipped: number
    errors: string[]
  }
}

export async function bulkImportAgentsRoster(formData: FormData): Promise<BulkImportResult> {
  const { error: authErr } = await getAuthenticatedCapable('agent.invite')
  if (authErr) return { success: false, error: authErr }

  const brokerageId = String(formData.get('brokerageId') || '')
  const file = formData.get('file') as File | null
  if (!brokerageId) return { success: false, error: 'Brokerage is required' }
  if (!file) return { success: false, error: 'Roster file is required' }

  const fileName = file.name.toLowerCase()
  let rows: string[][]
  if (fileName.endsWith('.csv')) {
    if (file.size > MAX_ROSTER_CSV_BYTES) {
      return { success: false, error: 'CSV file must be 256KB or smaller' }
    }
    rows = parseCsv(await file.text())
  } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    if (file.size > MAX_ROSTER_XLSX_BYTES) {
      return { success: false, error: 'Excel file must be 1MB or smaller' }
    }
    try {
      rows = parseXlsxRows(await file.arrayBuffer())
    } catch (err: unknown) {
      if (err instanceof RosterSheetTooLargeError) {
        return { success: false, error: `Roster sheet has more than ${XLSX_SHEET_ROW_LIMIT} rows. Keep the agent table near the top of the sheet.` }
      }
      console.error('Roster xlsx parse error:', err instanceof Error ? err.message : err)
      return { success: false, error: 'Could not read the Excel file. Make sure it is a valid .xlsx roster.' }
    }
  } else {
    return { success: false, error: 'Roster must be a .csv or .xlsx file' }
  }

  const parsed = rowsToBulkAgents(rows)
  if (parsed.error) return { success: false, error: parsed.error }

  return bulkImportAgents({ brokerageId, agents: parsed.agents })
}

export async function bulkImportAgents(input: {
  brokerageId: string
  agents: BulkAgentRow[]
}): Promise<BulkImportResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('agent.invite')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (!input.brokerageId) return { success: false, error: 'Brokerage is required' }
    if (!input.agents || input.agents.length === 0) return { success: false, error: 'No agents to import' }
    if (input.agents.length > MAX_ROSTER_ROWS) return { success: false, error: `Maximum ${MAX_ROSTER_ROWS} agents per import` }

    // Verify brokerage exists
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('id, name')
      .eq('id', input.brokerageId)
      .single()

    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    // Get existing agent emails for this brokerage to skip duplicates (exclude archived)
    const { data: existingAgents } = await supabase
      .from('agents')
      .select('email')
      .eq('brokerage_id', input.brokerageId)
      .neq('status', 'archived')

    // agents.email is intentionally nullable (many agents are phone-only)
    const existingEmails = new Set(
      (existingAgents || []).flatMap(a => (a.email ? [a.email.toLowerCase()] : []))
    )

    const errors: string[] = []
    let imported = 0
    let skipped = 0

    for (let i = 0; i < input.agents.length; i++) {
      const row = input.agents[i]
      // Prefer the row number from the source spreadsheet (set by
      // rowsToBulkAgents); fall back to header-on-row-1 numbering for
      // direct bulkImportAgents callers.
      const rowNum = row.sourceRow ?? i + 2

      // Validate required fields — only first name + last name required now
      // ⚠️ TEMPORARY: email not required for testing — REVERT BEFORE GO-LIVE
      if (!row.firstName?.trim() || !row.lastName?.trim()) {
        errors.push(`Row ${rowNum}: Missing required field (first name or last name)`)
        skipped++
        continue
      }

      // Email validation (only if provided)
      const email = row.email?.trim().toLowerCase() || null
      if (email) {
        if (!email.includes('@') || !email.includes('.')) {
          errors.push(`Row ${rowNum}: Invalid email "${row.email}"`)
          skipped++
          continue
        }

        // Skip duplicates (only when email exists)
        if (existingEmails.has(email)) {
          errors.push(`Row ${rowNum}: ${row.firstName} ${row.lastName} (${email}) already exists — skipped`)
          skipped++
          continue
        }
      }

      const serviceClient = createServiceRoleClient()
      const { error: insertError } = await serviceClient
        .from('agents')
        .insert({
          brokerage_id: input.brokerageId,
          first_name: row.firstName.trim(),
          last_name: row.lastName.trim(),
          email,
          phone: row.phone?.trim() || null,
          reco_number: row.recoNumber?.trim() || null,
          address_street: row.addressStreet?.trim() || null,
          address_city: row.addressCity?.trim() || null,
          address_province: row.addressProvince?.trim() || null,
          address_postal_code: row.addressPostalCode?.trim() || null,
          status: 'active',
          flagged_by_brokerage: false,
          outstanding_recovery: 0,
        })

      if (insertError) {
        errors.push(`Row ${rowNum}: Failed to import ${row.firstName} ${row.lastName}: ${insertError.message}`)
        skipped++
      } else {
        if (email) existingEmails.add(email) // prevent dupes within same batch
        imported++
      }
    }

    await logAuditEvent({
      action: 'agent.bulk_import',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: { brokerage_name: brokerage.name, imported, skipped, total_rows: input.agents.length },
    })

    return {
      success: true,
      data: { imported, skipped, errors },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Bulk import error:', _msg)
    return { success: false, error: 'An unexpected error occurred during import' }
  }
}

export async function updateAgent(input: {
  id: string
  brokerageId: string
  firstName: string
  lastName: string
  email: string
  phone?: string
  recoNumber?: string
  status: string
  flaggedByBrokerage: boolean
  outstandingRecovery: number
}): Promise<ActionResult> {
  // Editing an agent's profile is agent.invite (Manager and up). This form also
  // carries outstanding_recovery, a money field; changing it is a money write,
  // so that specific change is guarded to money.write (Owner only) below.
  const { error: authErr, user, profile } = await getAuthenticatedCapable('agent.invite')
  if (authErr || !user || !profile) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = UpdateAgentSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    const serviceClient = createServiceRoleClient()

    // Money guard: only an Owner (money.write) may change outstanding_recovery.
    // A Manager can edit everything else on the agent but not this balance field.
    if (!hasCapability(profile, 'money.write')) {
      const { data: existing, error: existingErr } = await serviceClient
        .from('agents')
        .select('outstanding_recovery')
        .eq('id', v.id)
        .single()
      if (existingErr || !existing) {
        return { success: false, error: 'Agent not found' }
      }
      if (Number(existing.outstanding_recovery) !== Number(v.outstandingRecovery)) {
        return {
          success: false,
          error: 'Only an Owner can change an agent\'s outstanding recovery balance.',
        }
      }
    }

    const { data: agent, error: updateError } = await serviceClient
      .from('agents')
      .update({
        brokerage_id: v.brokerageId,
        first_name: v.firstName,
        last_name: v.lastName,
        email: v.email,
        phone: v.phone || null,
        reco_number: v.recoNumber || null,
        status: v.status,
        flagged_by_brokerage: v.flaggedByBrokerage,
        outstanding_recovery: v.outstandingRecovery,
      })
      .eq('id', v.id)
      .select()
      .single()

    if (updateError) {
      console.error('Agent update error:', updateError.message)
      return { success: false, error: `Failed to update agent: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'agent.update',
      entityType: 'agent',
      entityId: v.id,
      metadata: { name: `${v.firstName} ${v.lastName}`, status: v.status },
    })

    return { success: true, data: agent }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Agent update error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Create Auth User + Profile (for agent or brokerage admin login)
// ============================================================================

export async function createUserAccount(input: {
  email: string
  password: string
  fullName: string
  role: 'agent' | 'brokerage_admin'
  agentId?: string
  brokerageId?: string
}): Promise<ActionResult> {
  // Creating an agent login is agent.invite (Manager and up); creating a
  // brokerage admin login is brokerage onboarding -> brokerage.manage (Owner only).
  const requiredCapability = input.role === 'brokerage_admin' ? 'brokerage.manage' : 'agent.invite'
  const { error: authErr, user } = await getAuthenticatedCapable(requiredCapability)
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const parsed = CreateUserAccountSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }
    }
    const v = parsed.data

    // Create auth user via service-role client (required for admin.createUser)
    const serviceClient = createServiceRoleClient()

    const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
      email: v.email,
      password: v.password,
      email_confirm: true,
    })

    if (signUpError) {
      console.error('Auth user create error:', signUpError.message)
      return { success: false, error: `Failed to create user account: ${signUpError.message}` }
    }

    if (!authData.user) {
      return { success: false, error: 'User creation returned no user object' }
    }

    // Create user_profile record (use service client to bypass RLS)
    const { error: profileError } = await serviceClient
      .from('user_profiles')
      .insert({
        id: authData.user.id,
        email: v.email,
        role: v.role,
        full_name: v.fullName,
        agent_id: v.agentId || null,
        brokerage_id: v.brokerageId || null,
        is_active: true,
      })

    if (profileError) {
      console.error('Profile create error:', profileError.message)
      return { success: false, error: `User created but profile failed: ${profileError.message}` }
    }

    await logAuditEvent({
      action: 'user.create',
      entityType: 'user',
      entityId: authData.user.id,
      metadata: { email: v.email, role: v.role, full_name: v.fullName },
    })

    return { success: true, data: { userId: authData.user.id } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('User account create error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Archive Agent: Soft-delete agent + deactivate login
// ============================================================================

export async function archiveAgent(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('account.archive')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Fetch agent record
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, first_name, last_name, email, status, brokerage_id')
      .eq('id', input.agentId)
      .single()

    if (agentError || !agent) return { success: false, error: 'Agent not found' }
    if (agent.status === 'archived') return { success: false, error: 'Agent is already archived' }

    // Use service role client to bypass RLS for all mutations
    const serviceClient = createServiceRoleClient()

    // 1. Set agent status to archived
    const { error: updateError } = await serviceClient
      .from('agents')
      .update({ status: 'archived' })
      .eq('id', input.agentId)

    if (updateError) {
      console.error('Agent archive error:', updateError.message)
      return { success: false, error: `Failed to archive agent: ${updateError.message}` }
    }

    // 2. Deactivate any linked user_profile (prevents login)
    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('id')
      .eq('agent_id', input.agentId)
      .maybeSingle()

    if (profile) {
      await serviceClient
        .from('user_profiles')
        .update({ is_active: false })
        .eq('id', profile.id)

      // 3. Delete the auth user so their email is freed up for reuse
      try {
        await serviceClient.auth.admin.deleteUser(profile.id)
      } catch (err) {
        // Non-fatal — profile deactivation is the primary gate
        console.warn('[archiveAgent] Could not delete auth user:', err)
      }
    }

    await logAuditEvent({
      action: 'agent.archive',
      entityType: 'agent',
      entityId: input.agentId,
      metadata: {
        name: `${agent.first_name} ${agent.last_name}`,
        email: agent.email,
        brokerage_id: agent.brokerage_id,
        archived_by: user.id,
        had_login: !!profile,
      },
    })

    return { success: true, data: { agentId: input.agentId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Agent archive error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Soft-Delete Agent (archived only) — finding #16
// Sets deleted_at and audit-logs. Reversible until permanentlyDeleteAgent runs.
// ============================================================================

export async function softDeleteAgent(input: {
  agentId: string
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('account.delete')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const reason = (input.reason || '').trim()
  if (!reason) return { success: false, error: 'A reason is required for the audit log' }

  try {
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, first_name, last_name, email, status, brokerage_id, deleted_at')
      .eq('id', input.agentId)
      .single()

    if (agentError || !agent) return { success: false, error: 'Agent not found' }
    if (agent.status !== 'archived') return { success: false, error: 'Only archived agents can be soft-deleted' }
    if (agent.deleted_at) return { success: false, error: 'Agent is already soft-deleted' }

    const serviceClient = createServiceRoleClient()
    const { error: updateError } = await serviceClient
      .from('agents')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', input.agentId)
      .is('deleted_at', null)

    if (updateError) {
      console.error('Agent soft delete error:', updateError.message)
      return { success: false, error: `Failed to soft-delete agent: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'agent.soft_delete',
      entityType: 'agent',
      entityId: input.agentId,
      metadata: {
        name: `${agent.first_name} ${agent.last_name}`,
        email: agent.email,
        brokerage_id: agent.brokerage_id,
        deleted_by: user.id,
        reason: reason.slice(0, 500),
      },
    })

    return { success: true, data: { agentId: input.agentId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Agent soft delete error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Permanently Delete Agent (archived only)
// ============================================================================

// finding #16: hard-delete is now gated on soft-delete + 30-day quarantine.
export async function permanentlyDeleteAgent(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('account.delete')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Fetch agent — must be archived
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, first_name, last_name, email, status, brokerage_id, deleted_at')
      .eq('id', input.agentId)
      .single()

    if (agentError || !agent) return { success: false, error: 'Agent not found' }
    if (agent.status !== 'archived') return { success: false, error: 'Only archived agents can be permanently deleted' }
    if (!agent.deleted_at) {
      return { success: false, error: 'Agent must be soft-deleted first. Use Soft Delete and wait 30 days before purging.' }
    }
    const deletedAt = new Date(agent.deleted_at as string).getTime()
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    if (deletedAt > cutoff) {
      const daysLeft = Math.ceil((deletedAt - cutoff) / (24 * 60 * 60 * 1000))
      return { success: false, error: `Agent was soft-deleted less than 30 days ago. ${daysLeft} day(s) remaining in the quarantine window.` }
    }

    const serviceClient = createServiceRoleClient()

    // Check for deal history — agents with deals cannot be permanently deleted
    const { count: dealCount } = await serviceClient
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .eq('agent_id', input.agentId)

    if (dealCount && dealCount > 0) {
      return { success: false, error: 'Cannot permanently delete an agent with deal history. The agent will remain archived.' }
    }

    // Delete any linked user_profile + auth user first
    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('id')
      .eq('agent_id', input.agentId)
      .maybeSingle()

    if (profile) {
      // Delete user_profile (auth user may already be deleted from archive step)
      await serviceClient
        .from('user_profiles')
        .delete()
        .eq('id', profile.id)

      try {
        await serviceClient.auth.admin.deleteUser(profile.id)
      } catch {
        // May already be deleted — that's fine
      }
    }

    // Delete the agent record — FK cascades will clean up deals, transactions, invoices, etc.
    const { error: deleteError } = await serviceClient
      .from('agents')
      .delete()
      .eq('id', input.agentId)

    if (deleteError) {
      console.error('Agent permanent delete error:', deleteError.message)
      return { success: false, error: `Failed to delete agent: ${deleteError.message}` }
    }

    await logAuditEvent({
      action: 'agent.permanent_delete',
      entityType: 'agent',
      entityId: input.agentId,
      metadata: {
        name: `${agent.first_name} ${agent.last_name}`,
        email: agent.email,
        brokerage_id: agent.brokerage_id,
        deleted_by: user.id,
      },
    })

    return { success: true, data: { agentId: input.agentId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Agent permanent delete error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Archive Brokerage: Soft-delete brokerage + deactivate all agents/logins
// ============================================================================

export async function archiveBrokerage(input: {
  brokerageId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('account.archive')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: brokerage, error: brokerageError } = await supabase
      .from('brokerages')
      .select('id, name, email, status')
      .eq('id', input.brokerageId)
      .single()

    if (brokerageError || !brokerage) return { success: false, error: 'Brokerage not found' }
    if (brokerage.status === 'archived') return { success: false, error: 'Brokerage is already archived' }

    const serviceClient = createServiceRoleClient()

    // 1. Set brokerage status to archived
    const { error: updateError } = await serviceClient
      .from('brokerages')
      .update({ status: 'archived' })
      .eq('id', input.brokerageId)

    if (updateError) {
      console.error('Brokerage archive error:', updateError.message)
      return { success: false, error: `Failed to archive brokerage: ${updateError.message}` }
    }

    // 2. Archive all active agents under this brokerage
    const { data: agents } = await serviceClient
      .from('agents')
      .select('id')
      .eq('brokerage_id', input.brokerageId)
      .neq('status', 'archived')

    if (agents && agents.length > 0) {
      await serviceClient
        .from('agents')
        .update({ status: 'archived' })
        .eq('brokerage_id', input.brokerageId)
        .neq('status', 'archived')
    }

    // 3. Deactivate all user_profiles linked to this brokerage's agents
    const { data: agentProfiles } = await serviceClient
      .from('user_profiles')
      .select('id')
      .eq('brokerage_id', input.brokerageId)
      .eq('is_active', true)

    if (agentProfiles && agentProfiles.length > 0) {
      const profileIds = agentProfiles.map((p) => p.id)
      await serviceClient
        .from('user_profiles')
        .update({ is_active: false })
        .in('id', profileIds)

      // Delete auth users to free up emails
      for (const profile of agentProfiles) {
        try {
          await serviceClient.auth.admin.deleteUser(profile.id)
        } catch {
          // Non-fatal
        }
      }
    }

    await logAuditEvent({
      action: 'brokerage.archive',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: {
        name: brokerage.name,
        email: brokerage.email,
        archived_by: user.id,
        agents_archived: agents?.length ?? 0,
        logins_deactivated: agentProfiles?.length ?? 0,
      },
    })

    return { success: true, data: { brokerageId: input.brokerageId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Brokerage archive error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Soft-Delete Brokerage (archived only, no active agents/deals) — finding #16
// Sets deleted_at and audit-logs. Reversible until permanentlyDeleteBrokerage runs.
// ============================================================================

export async function softDeleteBrokerage(input: {
  brokerageId: string
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('account.delete')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const reason = (input.reason || '').trim()
  if (!reason) return { success: false, error: 'A reason is required for the audit log' }

  try {
    const { data: brokerage, error: brokerageError } = await supabase
      .from('brokerages')
      .select('id, name, email, status, deleted_at')
      .eq('id', input.brokerageId)
      .single()

    if (brokerageError || !brokerage) return { success: false, error: 'Brokerage not found' }
    if (brokerage.status !== 'archived') return { success: false, error: 'Only archived brokerages can be soft-deleted' }
    if (brokerage.deleted_at) return { success: false, error: 'Brokerage is already soft-deleted' }

    const serviceClient = createServiceRoleClient()

    const { count: activeAgentCount } = await serviceClient
      .from('agents')
      .select('*', { count: 'exact', head: true })
      .eq('brokerage_id', input.brokerageId)
      .is('deleted_at', null)

    if (activeAgentCount && activeAgentCount > 0) {
      return { success: false, error: 'Cannot soft-delete a brokerage with active (non-deleted) agents. Soft-delete the agents first.' }
    }

    const { count: dealCount } = await serviceClient
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .eq('brokerage_id', input.brokerageId)

    if (dealCount && dealCount > 0) {
      return { success: false, error: 'Cannot soft-delete a brokerage with deal history.' }
    }

    const { error: updateError } = await serviceClient
      .from('brokerages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', input.brokerageId)
      .is('deleted_at', null)

    if (updateError) {
      console.error('Brokerage soft delete error:', updateError.message)
      return { success: false, error: `Failed to soft-delete brokerage: ${updateError.message}` }
    }

    await logAuditEvent({
      action: 'brokerage.soft_delete',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: {
        name: brokerage.name,
        email: brokerage.email,
        deleted_by: user.id,
        reason: reason.slice(0, 500),
      },
    })

    return { success: true, data: { brokerageId: input.brokerageId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Brokerage soft delete error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Permanently Delete Brokerage (archived only, no deal history)
// ============================================================================

// finding #16: hard-delete is now gated on soft-delete + 30-day quarantine.
// finding #17: SQL-side mutations are wrapped in delete_brokerage_atomic (migration 069).
export async function permanentlyDeleteBrokerage(input: {
  brokerageId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('account.delete')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const { data: brokerage, error: brokerageError } = await supabase
      .from('brokerages')
      .select('id, name, email, status, deleted_at')
      .eq('id', input.brokerageId)
      .single()

    if (brokerageError || !brokerage) return { success: false, error: 'Brokerage not found' }
    if (brokerage.status !== 'archived') {
      return { success: false, error: 'Only archived brokerages can be permanently deleted' }
    }
    if (!brokerage.deleted_at) {
      return { success: false, error: 'Brokerage must be soft-deleted first. Use Soft Delete and wait 30 days before purging.' }
    }
    const deletedAt = new Date(brokerage.deleted_at as string).getTime()
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    if (deletedAt > cutoff) {
      const daysLeft = Math.ceil((deletedAt - cutoff) / (24 * 60 * 60 * 1000))
      return { success: false, error: `Brokerage was soft-deleted less than 30 days ago. ${daysLeft} day(s) remaining in the quarantine window.` }
    }

    const serviceClient = createServiceRoleClient()

    // Check for deal history — brokerages with deals cannot be permanently deleted
    const { count: dealCount } = await serviceClient
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .eq('brokerage_id', input.brokerageId)

    if (dealCount && dealCount > 0) {
      return { success: false, error: 'Cannot permanently delete a brokerage with deal history. The brokerage will remain archived.' }
    }

    // audit finding #17: collect every profile (agent-linked + brokerage-linked)
    // BEFORE the atomic SQL purge so we can still hit auth.users after the
    // user_profiles rows are gone. auth.users can't be touched from SQL so it
    // stays outside the transaction (failures are logged, not fatal).
    const { data: agentRows } = await serviceClient
      .from('agents')
      .select('id')
      .eq('brokerage_id', input.brokerageId)
    const agentIds = (agentRows || []).map(a => a.id)

    const { data: agentProfiles } = agentIds.length > 0
      ? await serviceClient
          .from('user_profiles')
          .select('id, email')
          .in('agent_id', agentIds)
      : { data: [] as Array<{ id: string; email: string | null }> }

    const { data: brokerageProfiles } = await serviceClient
      .from('user_profiles')
      .select('id, email')
      .eq('brokerage_id', input.brokerageId)

    const allProfiles = [...(agentProfiles || []), ...(brokerageProfiles || [])]
    const seenIds = new Set<string>()
    const profilesForAuthCleanup = allProfiles.filter(p => {
      if (seenIds.has(p.id)) return false
      seenIds.add(p.id)
      return true
    })

    // Atomic SQL purge inside a single PL/pgSQL function (migration 069).
    // All deletions either commit together or roll back.
    const { error: atomicError } = await serviceClient.rpc('delete_brokerage_atomic', {
      p_brokerage_id: input.brokerageId,
    })

    if (atomicError) {
      console.error('Brokerage permanent delete (atomic) error:', atomicError.message)
      return { success: false, error: `Failed to delete brokerage: ${atomicError.message}` }
    }

    // auth.users live outside Postgres — best-effort cleanup, failures logged.
    for (const profile of profilesForAuthCleanup) {
      try {
        await serviceClient.auth.admin.deleteUser(profile.id)
      } catch (authErr: unknown) {
        const authMessage = authErr instanceof Error ? authErr.message : 'Unknown error'
        console.warn(`Auth user delete failed for profile ${profile.id} (${profile.email}):`, authMessage)
        if (profile.email) {
          try {
            const { data: { users = [] } = {} } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 1000 })
            const match = users.find((u: { id: string; email?: string }) => u.email === profile.email)
            if (match) {
              await serviceClient.auth.admin.deleteUser(match.id)
              console.log(`Auth user cleaned up via email fallback for ${profile.email}`)
            }
          } catch (fallbackErr: unknown) {
            const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : 'Unknown error'
            console.warn(`Auth fallback cleanup also failed for ${profile.email}:`, fallbackMessage)
          }
        }
      }
    }

    await logAuditEvent({
      action: 'brokerage.permanent_delete',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: {
        name: brokerage.name,
        email: brokerage.email,
        deleted_by: user.id,
      },
    })

    return { success: true, data: { brokerageId: input.brokerageId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Brokerage permanent delete error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Invite Agent: Create agent record + auth user + user_profile + send email
// ============================================================================

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let password = ''
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

export async function inviteAgent(input: {
  brokerageId: string
  firstName: string
  lastName: string
  email: string
  phone?: string
  recoNumber?: string
  skipEmail?: boolean
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('agent.invite')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (!input.firstName.trim()) return { success: false, error: 'First name is required' }
    if (!input.lastName.trim()) return { success: false, error: 'Last name is required' }
    if (!input.email.trim()) return { success: false, error: 'Email is required' }
    if (!input.brokerageId) return { success: false, error: 'Brokerage is required' }

    const email = input.email.trim().toLowerCase()

    // Verify brokerage exists (incl. white-label branding)
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('id, name, logo_url, logo_includes_tagline, is_white_label_partner')
      .eq('id', input.brokerageId)
      .single()

    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    // Check if agent email already exists (exclude archived agents so emails can be reused)
    const { data: existingAgent } = await supabase
      .from('agents')
      .select('id')
      .eq('email', email)
      .neq('status', 'archived')
      .maybeSingle()

    if (existingAgent) return { success: false, error: 'An agent with this email already exists' }

    // Use service role client for all mutations (bypasses RLS)
    const serviceClient = createServiceRoleClient()

    // 1. Create agent record
    const { data: agent, error: agentError } = await serviceClient
      .from('agents')
      .insert({
        brokerage_id: input.brokerageId,
        first_name: input.firstName.trim(),
        last_name: input.lastName.trim(),
        email,
        phone: input.phone?.trim() || null,
        reco_number: input.recoNumber?.trim() || null,
        status: 'active',
        flagged_by_brokerage: false,
        outstanding_recovery: 0,
      })
      .select()
      .single()

    if (agentError || !agent) {
      console.error('Agent create error:', agentError?.message)
      return { success: false, error: `Failed to create agent record: ${agentError?.message || 'Unknown error'}` }
    }

    // 2. Create auth user with a random password (agent will set their own via magic link)
    //    If the email already exists in Supabase Auth (e.g. previously archived agent),
    //    delete the old auth user + profile and create fresh
    const tempPassword = generateTempPassword()  // Used only as initial placeholder — never shown to agent

    let authUserId: string

    let { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    })

    if (signUpError && signUpError.message?.includes('already been registered')) {
      // Email exists in Supabase Auth (e.g. previously archived agent whose auth user wasn't fully cleaned up)
      // Look up the old user_profiles record (still exists with is_active=false after archiving)
      const { data: oldProfile } = await serviceClient
        .from('user_profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle()

      if (oldProfile?.id) {
        // Delete the old auth user using the proper admin SDK method
        try {
          await serviceClient.auth.admin.deleteUser(oldProfile.id)
        } catch (delErr: unknown) {
          const _msg = delErr instanceof Error ? delErr.message : "Unknown error"
          console.error('Failed to delete old auth user via admin API:', _msg)
        }
        // Delete the old profile record
        await serviceClient
          .from('user_profiles')
          .delete()
          .eq('id', oldProfile.id)
      } else {
        // No profile found — try brute force: list auth users page by page to find the ID
        let deletedOldUser = false
        let page = 1
        while (!deletedOldUser) {
          const { data: { users = [] } = {}, error: listErr } = await serviceClient.auth.admin.listUsers({ page, perPage: 1000 })
          if (listErr || users.length === 0) break
          const match = users.find((u: { id: string; email?: string }) => u.email === email)
          if (match) {
            try {
              await serviceClient.auth.admin.deleteUser(match.id)
              deletedOldUser = true
            } catch (delErr: unknown) {
              const _msg = delErr instanceof Error ? delErr.message : "Unknown error"
              console.error('Failed to delete old auth user from listUsers match:', _msg)
            }
            break
          }
          if (users.length < 1000) break
          page++
        }
      }

      // Now create a fresh auth user
      const retry = await serviceClient.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
      })

      if (retry.error || !retry.data?.user) {
        console.error('Auth user create retry error:', retry.error?.message)
        return {
          success: false,
          error: `Agent record created but login creation failed on retry: ${retry.error?.message || 'Unknown error'}. Create the login manually via the Supabase dashboard.`,
          data: { agentId: agent.id, agentCreated: true, loginCreated: false },
        }
      }

      authData = retry.data
      signUpError = retry.error
      authUserId = retry.data.user.id

    } else if (signUpError || !authData?.user) {
      console.error('Auth user create error:', signUpError?.message)
      return {
        success: false,
        error: `Agent record created but login creation failed: ${signUpError?.message || 'Unknown error'}. Create the login manually via the Supabase dashboard.`,
        data: { agentId: agent.id, agentCreated: true, loginCreated: false },
      }
    } else {
      authUserId = authData.user.id
    }

    // 3. Create user_profile record (use service client to bypass RLS)
    const { error: profileError } = await serviceClient
      .from('user_profiles')
      .insert({
        id: authUserId,
        email,
        role: 'agent',
        full_name: `${input.firstName.trim()} ${input.lastName.trim()}`,
        agent_id: agent.id,
        brokerage_id: input.brokerageId,
        is_active: true,
        must_reset_password: true,
      })

    if (profileError) {
      console.error('Profile create error:', profileError.message)
      return {
        success: false,
        error: `Agent and login created, but profile link failed: ${profileError.message}. Fix manually in Supabase.`,
        data: { agentId: agent.id, agentCreated: true, loginCreated: true, profileCreated: false },
      }
    }

    // 4. Generate magic link invite token (72-hour expiry)
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

    const { error: tokenError } = await serviceClient
      .from('invite_tokens')
      .insert({
        token: inviteToken,
        user_id: authUserId,
        agent_id: agent.id,
        email,
        expires_at: expiresAt,
      })

    if (tokenError) {
      console.error('Invite token create error:', tokenError.message)
      // Non-fatal — agent and auth user are already created, admin can resend invite
    }

    // 5. Send invite email with magic link (unless skipEmail is set)
    if (!input.skipEmail) {
      await sendAgentInviteNotification({
        agentFirstName: input.firstName.trim(),
        agentEmail: email,
        brokerageName: brokerage.name,
        brokerageLogoUrl: brokerage.logo_url,
            brokerageLogoIncludesTagline: brokerage.logo_includes_tagline,
        inviteToken,
      })
    }

    // Audit log
    await logAuditEvent({
      action: 'agent.invite',
      entityType: 'agent',
      entityId: agent.id,
      metadata: {
        name: `${input.firstName} ${input.lastName}`,
        email,
        brokerage_id: input.brokerageId,
        brokerage_name: brokerage.name,
        invited_by: user.id,
        invite_method: 'magic_link',
        email_sent: !input.skipEmail,
      },
    })

    return {
      success: true,
      data: {
        agentId: agent.id,
        userId: authUserId,
        agentCreated: true,
        loginCreated: true,
        profileCreated: true,
        emailSent: true,
      },
    }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Agent invite error:', _msg)
    return { success: false, error: 'An unexpected error occurred during agent invitation' }
  }
}

// ============================================================================
// Resend welcome email to an agent (generates new temp password)
// ============================================================================

export async function resendAgentWelcomeEmail(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('users.credentials')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    // Get agent details
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, first_name, last_name, email, status, brokerage_id')
      .eq('id', input.agentId)
      .single()

    if (agentError || !agent) return { success: false, error: 'Agent not found' }
    if (agent.status === 'archived') return { success: false, error: 'Cannot send email to archived agent' }

    // Get brokerage incl. white-label branding for the invite email
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('name, logo_url, logo_includes_tagline, is_white_label_partner')
      .eq('id', agent.brokerage_id)
      .single()

    const serviceClient = createServiceRoleClient()

    // Check if auth user exists for this agent
    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('id')
      .eq('agent_id', agent.id)
      .maybeSingle()

    const tempPassword = generateTempPassword()

    if (profile) {
      // Auth user exists — reset their password
      const { error: pwError } = await serviceClient.auth.admin.updateUserById(profile.id, {
        password: tempPassword,
      })

      if (pwError) {
        console.error('Password reset error:', pwError.message)
        return { success: false, error: `Failed to reset password: ${pwError.message}` }
      }

      // Set must_reset_password flag
      await serviceClient
        .from('user_profiles')
        .update({ must_reset_password: true })
        .eq('id', profile.id)

      // Clear any password_changed metadata so middleware forces change again
      await serviceClient.auth.admin.updateUserById(profile.id, {
        user_metadata: { password_changed: false },
      })
    } else {
      // No auth user — create one (agent was added without invite)
      const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
        email: agent.email,
        password: tempPassword,
        email_confirm: true,
      })

      if (signUpError || !authData?.user) {
        return { success: false, error: `Failed to create login: ${signUpError?.message || 'Unknown error'}` }
      }

      // Create user_profile
      await serviceClient
        .from('user_profiles')
        .insert({
          id: authData.user.id,
          email: agent.email,
          role: 'agent',
          full_name: `${agent.first_name} ${agent.last_name}`,
          agent_id: agent.id,
          brokerage_id: agent.brokerage_id,
          is_active: true,
          must_reset_password: true,
        })
    }

    // Get the user ID for the magic link token
    const userId = profile ? profile.id : (await serviceClient.from('user_profiles').select('id').eq('agent_id', agent.id).single()).data?.id

    if (!userId) {
      return { success: false, error: 'Could not resolve user_profile to issue invite token. The agent record may need manual cleanup.' }
    }

    const inviteToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

    await serviceClient
      .from('invite_tokens')
      .insert({
        token: inviteToken,
        user_id: userId,
        agent_id: agent.id,
        email: agent.email,
        expires_at: expiresAt,
      })

    await sendAgentInviteNotification({
      agentFirstName: agent.first_name,
      agentEmail: agent.email,
      brokerageName: brokerage?.name || 'Your Brokerage',
      brokerageLogoUrl: brokerage?.logo_url,
            brokerageLogoIncludesTagline: brokerage?.logo_includes_tagline,
      inviteToken,
    })

    // Stamp welcome_email_sent_at on the agent
    await serviceClient
      .from('agents')
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq('id', agent.id)

    await logAuditEvent({
      action: 'agent.resend_welcome',
      entityType: 'agent',
      entityId: agent.id,
      metadata: {
        name: `${agent.first_name} ${agent.last_name}`,
        email: agent.email,
        resent_by: user.id,
        had_existing_login: !!profile,
        invite_method: userId ? 'magic_link' : 'temp_password',
      },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Resend welcome email error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Send welcome email to ALL agents in a brokerage
// ============================================================================

export async function sendWelcomeToAllBrokerageAgents(input: {
  brokerageId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('agent.invite')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const serviceClient = createServiceRoleClient()

    // Get brokerage incl. white-label branding
    const { data: brokerage } = await supabase
      .from('brokerages')
      .select('id, name, logo_url, logo_includes_tagline, is_white_label_partner')
      .eq('id', input.brokerageId)
      .single()

    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    // Get all non-archived agents for this brokerage
    const { data: agents, error: agentsError } = await supabase
      .from('agents')
      .select('id, first_name, last_name, email, status')
      .eq('brokerage_id', input.brokerageId)
      .neq('status', 'archived')

    if (agentsError || !agents) return { success: false, error: 'Failed to load agents' }
    if (agents.length === 0) return { success: false, error: 'No active agents found in this brokerage' }

    let sent = 0
    let failed = 0
    let skipped = 0
    const errors: string[] = []

    for (const agent of agents) {
      try {
        // Cannot invite without an email
        if (!agent.email) {
          errors.push(`${agent.first_name} ${agent.last_name}: no email on file`)
          skipped++
          continue
        }

        // Check if agent has a user_profile (meaning they have a login)
        let { data: profile } = await serviceClient
          .from('user_profiles')
          .select('id')
          .eq('agent_id', agent.id)
          .maybeSingle()

        // No login? Create one (roster-only agent being activated for white-label).
        if (!profile) {
          const tempPassword = generateTempPassword()
          const { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
            email: agent.email,
            password: tempPassword,
            email_confirm: true,
          })
          if (signUpError || !authData?.user) {
            errors.push(`${agent.first_name} ${agent.last_name}: ${signUpError?.message || 'auth create failed'}`)
            failed++
            continue
          }
          await serviceClient
            .from('user_profiles')
            .insert({
              id: authData.user.id,
              email: agent.email,
              role: 'agent',
              full_name: `${agent.first_name} ${agent.last_name}`,
              agent_id: agent.id,
              brokerage_id: input.brokerageId,
              is_active: true,
              must_reset_password: true,
            })
          profile = { id: authData.user.id }
        }

        // Generate magic link invite token (72-hour expiry)
        const inviteToken = crypto.randomBytes(32).toString('hex')
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

        await serviceClient
          .from('invite_tokens')
          .insert({
            token: inviteToken,
            user_id: profile.id,
            agent_id: agent.id,
            email: agent.email,
            expires_at: expiresAt,
          })

        // Ensure must_reset_password is set
        await serviceClient
          .from('user_profiles')
          .update({ must_reset_password: true })
          .eq('id', profile.id)

        // Clear any password_changed metadata
        await serviceClient.auth.admin.updateUserById(profile.id, {
          user_metadata: { password_changed: false },
        })

        // Send magic link email
        await sendAgentInviteNotification({
          agentFirstName: agent.first_name,
          agentEmail: agent.email,
          brokerageName: brokerage.name,
          brokerageLogoUrl: brokerage.logo_url,
            brokerageLogoIncludesTagline: brokerage.logo_includes_tagline,
          inviteToken,
        })

        // Stamp welcome_email_sent_at on the agent
        await serviceClient
          .from('agents')
          .update({ welcome_email_sent_at: new Date().toISOString() })
          .eq('id', agent.id)

        sent++
      } catch (err: unknown) {
        const _msg = err instanceof Error ? err.message : "Unknown error"
        console.error(`Failed to send welcome to ${agent.email}:`, _msg)
        errors.push(`${agent.first_name} ${agent.last_name}: ${_msg}`)
        failed++
      }
    }

    await logAuditEvent({
      action: 'brokerage.send_all_welcome',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      metadata: {
        brokerage_name: brokerage.name,
        total_agents: agents.length,
        sent,
        failed,
        skipped,
        sent_by: user.id,
      },
    })

    if (failed > 0 && sent > 0) {
      return { success: true, data: { sent, failed, skipped, errors }, error: `Sent ${sent} emails, ${failed} failed, ${skipped} skipped (no email)` }
    } else if (failed > 0 && sent === 0) {
      return { success: false, error: `All ${failed} emails failed. ${errors[0] || ''}` }
    }
    if (sent === 0 && skipped > 0) {
      return { success: true, data: { sent: 0, failed: 0, skipped, errors }, error: `${skipped} agents skipped (no email on file)` }
    }

    return { success: true, data: { sent, failed, skipped } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Send all welcome emails error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// EFT Transfer Tracking
// ============================================================================

// Embed shape matches the loadDealData() select in app/(dashboard)/admin/deals/[id]/page.tsx.
// Keeping the embed inside both the action response and the page reader avoids
// drift between the two.
const EFT_DEAL_SELECT =
  '*, brokerage_payments(id, amount, date:payment_date, reference, method, status, submitted_by_role), eft_transfers(id, amount, transfer_date, confirmed, reference)'

export async function recordEftTransfer(input: {
  dealId: string
  amount: number
  date: string
  reference?: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (input.amount <= 0) return { success: false, error: 'Amount must be greater than 0' }
    if (input.amount > 25000) return { success: false, error: 'Maximum EFT transfer is $25,000 per day' }

    // Verify the deal exists and is in funded status. The actual insert below
    // touches a different table so it can't enforce the status itself.
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, status, advance_amount')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }
    if (deal.status !== 'funded') return { success: false, error: 'EFT transfers can only be recorded on funded deals' }

    // Reconciliation guardrail: the SUM of transfers for a deal must not exceed
    // the advance amount (the total cash owed to the agent). $0.005 tolerance
    // absorbs floating point noise on NUMERIC dollar values.
    const advanceAmount = Number(deal.advance_amount)
    if (deal.advance_amount == null || advanceAmount <= 0) {
      console.warn(
        `[recordEftTransfer] deal ${input.dealId} has missing/zero advance_amount (${deal.advance_amount}); skipping transfer cap check`,
      )
    } else {
      const { data: existingTransfers, error: existingErr } = await supabase
        .from('eft_transfers')
        .select('amount')
        .eq('deal_id', input.dealId)

      if (existingErr) {
        return { success: false, error: `Failed to load existing transfers: ${existingErr.message}` }
      }

      const existingSum = (existingTransfers || []).reduce((s, r) => s + Number(r.amount || 0), 0)
      const TOLERANCE = 0.005
      if (existingSum + input.amount > advanceAmount + TOLERANCE) {
        const remaining = Math.max(0, advanceAmount - existingSum)
        return {
          success: false,
          error: `Recording this $${input.amount.toFixed(2)} transfer would exceed the advance amount. $${existingSum.toFixed(2)} has already been recorded and the advance is $${advanceAmount.toFixed(2)}, so at most $${remaining.toFixed(2)} can still be disbursed.`,
        }
      }
    }

    const { data: inserted, error: insertError } = await supabase
      .from('eft_transfers')
      .insert({
        deal_id: input.dealId,
        amount: input.amount,
        transfer_date: input.date,
        reference: input.reference || null,
        recorded_by_user_id: user.id,
      })
      .select()
      .single()

    if (insertError || !inserted) {
      console.error('EFT transfer error:', insertError?.message)
      return { success: false, error: `Failed to record transfer: ${insertError?.message || 'unknown error'}` }
    }

    const { data: updatedDeal } = await supabase
      .from('deals')
      .select(EFT_DEAL_SELECT)
      .eq('id', input.dealId)
      .single()

    await logAuditEvent({
      action: 'eft.record',
      entityType: 'deal',
      entityId: input.dealId,
      severity: 'critical',
      metadata: { transfer_id: inserted.id, amount: input.amount, date: input.date },
    })

    return { success: true, data: updatedDeal }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('EFT transfer error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function confirmEftTransfer(input: {
  transferId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.transferId) return { success: false, error: 'Transfer id is required' }

  try {
    // CAS guard: only flip from confirmed=false. maybeSingle() returns null
    // for a 0-row update (already confirmed) rather than throwing.
    const { data: confirmed, error: updateError } = await supabase
      .from('eft_transfers')
      .update({
        confirmed: true,
        confirmed_at: new Date().toISOString(),
        confirmed_by_user_id: user.id,
      })
      .eq('id', input.transferId)
      .eq('confirmed', false)
      .select()
      .maybeSingle()

    if (updateError) {
      return { success: false, error: `Failed to confirm transfer: ${updateError.message}` }
    }
    if (!confirmed) {
      return { success: false, error: 'This transfer is missing or has already been confirmed' }
    }

    const { data: updatedDeal } = await supabase
      .from('deals')
      .select(EFT_DEAL_SELECT)
      .eq('id', confirmed.deal_id)
      .single()

    await logAuditEvent({
      action: 'eft.confirm',
      entityType: 'deal',
      entityId: confirmed.deal_id,
      severity: 'critical',
      metadata: { transfer_id: input.transferId, transfer: confirmed },
    })

    return { success: true, data: updatedDeal }
  } catch {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function removeEftTransfer(input: {
  transferId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.transferId) return { success: false, error: 'Transfer id is required' }

  try {
    // audit finding #4: upfront check for a friendlier error before the DB
    // trigger (migration 060) rejects DELETE of a confirmed row.
    const { data: existing, error: fetchError } = await supabase
      .from('eft_transfers')
      .select('id, confirmed')
      .eq('id', input.transferId)
      .maybeSingle()

    if (fetchError) {
      return { success: false, error: `Failed to load transfer: ${fetchError.message}` }
    }
    if (!existing) {
      return { success: false, error: 'Transfer not found' }
    }
    if (existing.confirmed) {
      return { success: false, error: 'Cannot delete a confirmed EFT transfer. Use the void flow instead.' }
    }

    // audit finding #21: .eq('confirmed', false) precondition catches a
    // concurrent confirm between the check above and this DELETE.
    const { data: removed, error: deleteError } = await supabase
      .from('eft_transfers')
      .delete()
      .eq('id', input.transferId)
      .eq('confirmed', false)
      .select()
      .maybeSingle()

    if (deleteError) {
      return { success: false, error: `Failed to remove transfer: ${deleteError.message}` }
    }
    if (!removed) {
      return { success: false, error: 'Transfer was just confirmed by another session. Refresh and try the void flow instead.' }
    }

    const { data: updatedDeal } = await supabase
      .from('deals')
      .select(EFT_DEAL_SELECT)
      .eq('id', removed.deal_id)
      .single()

    await logAuditEvent({
      action: 'eft.remove',
      entityType: 'deal',
      entityId: removed.deal_id,
      severity: 'critical',
      metadata: { transfer_id: input.transferId, removed_transfer: removed },
    })

    return { success: true, data: updatedDeal }
  } catch {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Brokerage Payment: Record incoming payment from brokerage
// ============================================================================

export async function recordBrokeragePayment(input: {
  dealId: string
  amount: number
  date: string
  reference?: string
  method?: string
  allowOverpayment?: boolean
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    if (input.amount <= 0) return { success: false, error: 'Amount must be greater than 0' }

    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, status, brokerage_id, amount_due_from_brokerage, agent_id, property_address')
      .eq('id', input.dealId)
      .single()

    if (dealError || !deal) return { success: false, error: 'Deal not found' }
    if (!['funded', 'completed'].includes(deal.status)) {
      return { success: false, error: 'Brokerage payments can only be recorded on funded or completed deals' }
    }
    if (!deal.brokerage_id) {
      return { success: false, error: 'Deal has no brokerage assigned' }
    }

    // Reconciliation guardrail: confirmed payments must not exceed the amount
    // owed by the brokerage unless the admin explicitly overrides. $0.005
    // tolerance absorbs floating point noise on NUMERIC dollar values.
    const amountDue = deal.amount_due_from_brokerage == null ? null : Number(deal.amount_due_from_brokerage)
    let isIntentionalOverpayment = false
    if (amountDue == null) {
      console.warn(
        `[recordBrokeragePayment] deal ${input.dealId} has null amount_due_from_brokerage; skipping overpayment cap check`,
      )
    } else {
      const { data: existingPayments, error: existingErr } = await supabase
        .from('brokerage_payments')
        .select('amount, status')
        .eq('deal_id', input.dealId)

      if (existingErr) {
        return { success: false, error: `Failed to load existing payments: ${existingErr.message}` }
      }

      const existingConfirmedTotal = sumConfirmedPayments(existingPayments || [])
      const TOLERANCE = 0.005
      const projectedTotal = existingConfirmedTotal + input.amount
      const exceedsDue = projectedTotal > amountDue + TOLERANCE

      if (exceedsDue && input.allowOverpayment !== true) {
        const overage = projectedTotal - amountDue
        return {
          success: false,
          error: `Recording this $${input.amount.toFixed(2)} payment would exceed the amount owed. The brokerage owes $${amountDue.toFixed(2)} and $${existingConfirmedTotal.toFixed(2)} has already been recorded, leaving an overage of $${overage.toFixed(2)}. If this overpayment is intentional, re-submit with an explicit override.`,
        }
      }

      isIntentionalOverpayment = exceedsDue && input.allowOverpayment === true
    }

    const method = ['eft', 'wire', 'cheque', 'cash', 'other'].includes(input.method || '')
      ? (input.method as 'eft' | 'wire' | 'cheque' | 'cash' | 'other')
      : null

    const newPayment = await insertPayment(
      {
        dealId: input.dealId,
        brokerageId: deal.brokerage_id,
        amount: input.amount,
        paymentDate: input.date,
        reference: input.reference || null,
        method,
        status: 'confirmed',
        submittedByRole: 'admin',
        submittedByUserId: user.id,
      },
      supabase,
    )

    // Informational "Repayment received" entry on the agent's statement.
    // Balance-neutral and best-effort: the payment is already recorded, so a
    // failure here is logged (inside the helper) but does not fail the action.
    if (deal.agent_id) {
      await postDealRepaymentEntry(createServiceRoleClient(), {
        agentId: deal.agent_id,
        dealId: deal.id,
        amount: input.amount,
        propertyAddress: deal.property_address ?? null,
        paymentId: newPayment.id,
        createdBy: user.id,
      })
    }

    // The migration 055 trigger has already synced deals.repayment_amount.
    // Refetch the deal so the caller gets the fresh total.
    const { data: updatedDeal } = await supabase
      .from('deals')
      .select('*, brokerage_payments(*)')
      .eq('id', input.dealId)
      .single()

    const newTotal = sumConfirmedPayments(updatedDeal?.brokerage_payments || [])

    await logAuditEvent({
      action: 'brokerage_payment.record',
      entityType: 'deal',
      entityId: input.dealId,
      metadata: {
        payment_id: newPayment.id,
        amount: input.amount,
        date: input.date,
        new_total: newTotal,
        expected: deal.amount_due_from_brokerage,
        ...(isIntentionalOverpayment ? { overpayment: true } : {}),
      },
    })

    // NOTE: Late settlement strikes are NOT auto-recorded here. Admin reviews
    // each overdue deal manually and records a strike via recordLateStrike()
    // if appropriate (e.g., to allow for in-transit wires admin hasn't logged yet).
    return { success: true, data: updatedDeal }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Brokerage payment error:', _msg)
    return { success: false, error: _msg || 'An unexpected error occurred' }
  }
}

export async function removeBrokeragePayment(input: {
  dealId: string
  paymentId: string
}): Promise<ActionResult> {
  const { error: authErr, user, supabase } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.paymentId) return { success: false, error: 'Payment id is required' }

  try {
    const removed = await deletePayment(input.paymentId, supabase)
    if (removed.deal_id !== input.dealId) {
      // Defensive: caller passed mismatched ids. Audit log captures the truth.
      console.warn('[removeBrokeragePayment] deal_id mismatch', { input, removedDealId: removed.deal_id })
    }

    // Trigger has already synced deals.repayment_amount.
    const { data: updatedDeal } = await supabase
      .from('deals')
      .select('*, brokerage_payments(*)')
      .eq('id', removed.deal_id)
      .single()

    await logAuditEvent({
      action: 'brokerage_payment.remove',
      entityType: 'deal',
      entityId: removed.deal_id,
      severity: 'critical',
      metadata: { payment_id: input.paymentId, removed_payment: removed },
    })

    return { success: true, data: updatedDeal }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    return { success: false, error: message }
  }
}

// ============================================================================
// Admin: Confirm or reject a brokerage payment claim
//
// Brokerage-submitted claims land in deals.brokerage_payments with status='pending'.
// Admin reviews their bank deposits and confirms or rejects each claim.
// Confirmed claims count toward the repayment total; pending/rejected do not.
// ============================================================================

async function reviewBrokeragePaymentClaim(
  paymentId: string,
  decision: 'confirmed' | 'rejected',
  rejectionReason: string | null,
  reviewerUserId: string,
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<ActionResult> {
  const updated = await reviewPayment(paymentId, decision, reviewerUserId, rejectionReason, supabase)
  if (!updated) {
    // Row was either missing or already reviewed (status != pending).
    return { success: false, error: 'This payment is missing or has already been reviewed' }
  }

  // Trigger keeps deals.repayment_amount in sync. Refetch deal for the caller.
  const { data: updatedDeal } = await supabase
    .from('deals')
    .select('*, brokerage_payments(*)')
    .eq('id', updated.deal_id)
    .single()

  const newTotal = sumConfirmedPayments(updatedDeal?.brokerage_payments || [])

  // On confirmation, post the informational "Repayment received" entry to the
  // agent's statement (balance-neutral, best-effort). Rejections post nothing.
  if (decision === 'confirmed' && updatedDeal?.agent_id) {
    await postDealRepaymentEntry(supabase, {
      agentId: updatedDeal.agent_id,
      dealId: updated.deal_id,
      amount: Number(updated.amount),
      propertyAddress: updatedDeal.property_address ?? null,
      paymentId: paymentId,
      createdBy: reviewerUserId,
    })
  }

  await logAuditEvent({
    action: decision === 'confirmed' ? 'brokerage_payment.claim_confirmed' : 'brokerage_payment.claim_rejected',
    entityType: 'deal',
    entityId: updated.deal_id,
    metadata: {
      payment_id: paymentId,
      claim: updated,
      new_total: newTotal,
      ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
    },
  })

  return { success: true, data: updatedDeal }
}

export async function confirmBrokeragePaymentClaim(input: {
  dealId: string
  paymentId: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }
  if (!input.paymentId) return { success: false, error: 'Payment id is required' }
  return reviewBrokeragePaymentClaim(
    input.paymentId,
    'confirmed',
    null,
    user.id,
    createServiceRoleClient(),
  )
}

export async function rejectBrokeragePaymentClaim(input: {
  dealId: string
  paymentId: string
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }
  if (!input.paymentId) return { success: false, error: 'Payment id is required' }
  const reason = (input.reason || '').trim()
  if (!reason) return { success: false, error: 'Rejection reason is required' }
  return reviewBrokeragePaymentClaim(
    input.paymentId,
    'rejected',
    reason.slice(0, 1000),
    user.id,
    createServiceRoleClient(),
  )
}

// ============================================================================
// Admin: Reset a brokerage's late-payment strikes and optionally clear the
// auto-bump back to 7-day settlement. Required because the 5-strike auto-bump
// is permanent unless an admin resets it.
// ============================================================================

export async function resetBrokerageLateStrikes(input: {
  brokerageId: string
  clearAutoBump: boolean
  reason: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  const reason = (input.reason || '').trim()
  if (!reason) return { success: false, error: 'A reason is required for the audit log' }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: brokerage, error: getErr } = await serviceClient
      .from('brokerages')
      .select('id, late_strike_count, auto_bumped_to_14_days_at')
      .eq('id', input.brokerageId)
      .single()
    if (getErr || !brokerage) return { success: false, error: 'Brokerage not found' }

    const patch: Record<string, unknown> = {
      late_strike_count: 0,
      last_strike_reset_at: new Date().toISOString(),
    }
    if (input.clearAutoBump) patch.auto_bumped_to_14_days_at = null

    const { error: updateErr } = await serviceClient
      .from('brokerages')
      .update(patch)
      .eq('id', input.brokerageId)

    if (updateErr) return { success: false, error: updateErr.message }

    await logAuditEvent({
      action: 'brokerage.late_strikes_reset',
      entityType: 'brokerage',
      entityId: input.brokerageId,
      severity: 'warning',
      metadata: {
        reason: reason.slice(0, 500),
        prior_strike_count: brokerage.late_strike_count || 0,
        prior_auto_bumped_at: brokerage.auto_bumped_to_14_days_at,
        cleared_auto_bump: input.clearAutoBump,
      },
    })

    return { success: true, data: { brokerageId: input.brokerageId } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('resetBrokerageLateStrikes error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Admin: Reset any user's password (agent or brokerage admin)
// ============================================================================

export async function adminResetUserPassword(input: {
  userId?: string   // user_profiles.id (auth user id) — use for brokerage admins
  agentId?: string  // agents.id — use for agents (looks up user_profiles.id from agent_id)
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('users.credentials')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const serviceClient = createServiceRoleClient()

    // Resolve user profile ID — either direct or via agent_id lookup
    type TargetProfile = {
      id: string
      email: string | null
      full_name: string | null
      role: string
      agent_id: string | null
      brokerage_id: string | null
    }
    let targetProfile: TargetProfile | null = null
    if (input.userId) {
      const { data, error } = await serviceClient
        .from('user_profiles')
        .select('id, email, full_name, role, agent_id, brokerage_id')
        .eq('id', input.userId)
        .single()
      if (error || !data) return { success: false, error: 'User not found' }
      targetProfile = data
    } else if (input.agentId) {
      const { data, error } = await serviceClient
        .from('user_profiles')
        .select('id, email, full_name, role, agent_id, brokerage_id')
        .eq('agent_id', input.agentId)
        .single()
      if (error || !data) return { success: false, error: 'No login found for this agent. They may not have been invited yet.' }
      targetProfile = data
    } else {
      return { success: false, error: 'Either userId or agentId is required' }
    }

    // Generate temp password and reset
    const tempPassword = generateTempPassword()
    const { error: pwError } = await serviceClient.auth.admin.updateUserById(targetProfile.id, {
      password: tempPassword,
    })

    if (pwError) {
      return { success: false, error: `Failed to reset password: ${pwError.message}` }
    }

    // Set must_reset_password flag
    await serviceClient
      .from('user_profiles')
      .update({ must_reset_password: true })
      .eq('id', targetProfile.id)

    // Clear password_changed metadata
    await serviceClient.auth.admin.updateUserById(targetProfile.id, {
      user_metadata: { password_changed: false },
    })

    // Generate magic link token
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

    await serviceClient
      .from('invite_tokens')
      .insert({
        token: inviteToken,
        user_id: targetProfile.id,
        agent_id: targetProfile.agent_id,
        email: targetProfile.email,
        expires_at: expiresAt,
      })

    // Determine role name for email
    const roleName = targetProfile.role === 'brokerage_admin' ? 'Brokerage Admin' : 'Agent'

    // Send reset email — pass brokerage/agent IDs so the brokerage's logo
    // shows in the email header (migration 096). Falls back to FF default
    // when neither ID is on the profile (e.g. FF admin password reset).
    await sendPasswordResetNotification({
      recipientName: targetProfile.full_name?.split(' ')[0] || 'User',
      recipientEmail: targetProfile.email ?? '',
      inviteToken,
      roleName,
      brokerageId: targetProfile.brokerage_id,
      agentId: targetProfile.agent_id,
    })

    await logAuditEvent({
      action: 'admin.reset_user_password',
      entityType: 'user',
      entityId: targetProfile.id,
      severity: 'critical',
      metadata: {
        target_email: targetProfile.email,
        target_name: targetProfile.full_name,
        target_role: targetProfile.role,
        reset_by: user.id,
      },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Admin reset password error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Admin: Change any user's login email
// ============================================================================

export async function adminChangeUserEmail(input: {
  userId?: string   // user_profiles.id (auth user id)
  agentId?: string  // agents.id — for agents
  newEmail: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('users.credentials')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(input.newEmail)) {
      return { success: false, error: 'Invalid email address' }
    }

    const serviceClient = createServiceRoleClient()

    // Resolve user profile
    type TargetProfile2 = {
      id: string
      email: string | null
      full_name: string | null
      role: string
      agent_id: string | null
      brokerage_id: string | null
    }
    let targetProfile: TargetProfile2 | null = null
    if (input.userId) {
      const { data, error } = await serviceClient
        .from('user_profiles')
        .select('id, email, full_name, role, agent_id, brokerage_id')
        .eq('id', input.userId)
        .single()
      if (error || !data) return { success: false, error: 'User not found' }
      targetProfile = data
    } else if (input.agentId) {
      const { data, error } = await serviceClient
        .from('user_profiles')
        .select('id, email, full_name, role, agent_id, brokerage_id')
        .eq('agent_id', input.agentId)
        .single()
      if (error || !data) return { success: false, error: 'No login found for this agent' }
      targetProfile = data
    } else {
      return { success: false, error: 'Either userId or agentId is required' }
    }

    const oldEmail = targetProfile.email
    const newEmail = input.newEmail.toLowerCase()

    if (oldEmail && oldEmail.toLowerCase() === newEmail) {
      return { success: false, error: 'New email is the same as the current email' }
    }

    // Update in Supabase Auth (admin can change directly without confirmation)
    const { error: authUpdateError } = await serviceClient.auth.admin.updateUserById(targetProfile.id, {
      email: newEmail,
      email_confirm: true, // Auto-confirm so user doesn't need to verify
    })

    if (authUpdateError) {
      return { success: false, error: `Failed to update auth email: ${authUpdateError.message}` }
    }

    // Update user_profiles
    await serviceClient
      .from('user_profiles')
      .update({ email: newEmail })
      .eq('id', targetProfile.id)

    // If this is an agent, update the agents table too
    if (targetProfile.agent_id) {
      await serviceClient
        .from('agents')
        .update({ email: newEmail })
        .eq('id', targetProfile.agent_id)
    }

    // Send notification to old email — include brokerage/agent IDs so the
    // header shows the brokerage's generated logo (migration 096).
    await sendEmailChangeNotification({
      recipientName: targetProfile.full_name?.split(' ')[0] || 'User',
      oldEmail: oldEmail ?? '',
      newEmail,
      brokerageId: targetProfile.brokerage_id,
      agentId: targetProfile.agent_id,
    })

    await logAuditEvent({
      action: 'admin.change_user_email',
      entityType: 'user',
      entityId: targetProfile.id,
      severity: 'critical',
      metadata: {
        old_email: oldEmail,
        new_email: newEmail,
        target_name: targetProfile.full_name,
        target_role: targetProfile.role,
        changed_by: user.id,
      },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Admin change email error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Admin: Get user profiles for a brokerage (for user management)
// ============================================================================

export async function getBrokerageUserProfiles(brokerageId: string): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedAdmin()
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const serviceClient = createServiceRoleClient()

    // Get the brokerage admin profile
    const { data: brokerageAdminProfiles } = await serviceClient
      .from('user_profiles')
      .select('id, email, full_name, role, is_active, last_login, created_at')
      .eq('brokerage_id', brokerageId)
      .eq('role', 'brokerage_admin')

    // Get all agent profiles for this brokerage
    const { data: agentProfiles } = await serviceClient
      .from('user_profiles')
      .select('id, email, full_name, role, agent_id, is_active, last_login, created_at')
      .eq('brokerage_id', brokerageId)
      .eq('role', 'agent')

    return {
      success: true,
      data: {
        brokerageAdmins: brokerageAdminProfiles || [],
        agents: agentProfiles || [],
      },
    }
  } catch {
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Invite Brokerage Admin (create login + send magic link setup email)
// ============================================================================

export async function inviteBrokerageAdmin(input: {
  brokerageId: string
  fullName: string
  email: string
  /**
   * Optional free-form title persisted on user_profiles.staff_title.
   * Drives Referral Fees tab visibility via canViewBrokerageReferralFees()
   * in lib/access.ts: 'Broker of Record' and 'Brokerage Manager' see the
   * tab; anything else (including null) does not.
   */
  staffTitle?: string | null
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('brokerage.manage')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const serviceClient = createServiceRoleClient()

    // Get brokerage info
    const { data: brokerage } = await serviceClient
      .from('brokerages')
      .select('id, name')
      .eq('id', input.brokerageId)
      .single()

    if (!brokerage) return { success: false, error: 'Brokerage not found' }

    // Check if this email already exists as a brokerage admin
    const { data: existingProfile } = await serviceClient
      .from('user_profiles')
      .select('id')
      .eq('email', input.email)
      .eq('role', 'brokerage_admin')
      .maybeSingle()

    if (existingProfile) {
      return { success: false, error: 'This email already has a brokerage admin account.' }
    }

    // Create auth user with temp password (they'll set their own via magic link)
    //    If the email already exists in Supabase Auth (e.g. previously deleted brokerage
    //    whose auth user wasn't fully cleaned up), delete the old user and retry
    const tempPassword = generateTempPassword()

    let { data: authData, error: signUpError } = await serviceClient.auth.admin.createUser({
      email: input.email,
      password: tempPassword,
      email_confirm: true,
    })

    if (signUpError && signUpError.message?.includes('already been registered')) {
      // Email exists in Supabase Auth — clean up the orphaned auth user and retry
      const { data: oldProfile } = await serviceClient
        .from('user_profiles')
        .select('id')
        .eq('email', input.email)
        .maybeSingle()

      if (oldProfile?.id) {
        try {
          await serviceClient.auth.admin.deleteUser(oldProfile.id)
        } catch (delErr: unknown) {
          const _msg = delErr instanceof Error ? delErr.message : "Unknown error"
          console.error('Failed to delete old auth user via admin API:', _msg)
        }
        await serviceClient.from('user_profiles').delete().eq('id', oldProfile.id)
      } else {
        // No profile found — search auth users by email
        const { data: { users = [] } = {} } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 1000 })
        const match = users.find((u: { id: string; email?: string }) => u.email === input.email)
        if (match) {
          try {
            await serviceClient.auth.admin.deleteUser(match.id)
          } catch (delErr: unknown) {
            const _msg = delErr instanceof Error ? delErr.message : "Unknown error"
            console.error('Failed to delete orphaned auth user:', _msg)
          }
        }
      }

      // Retry user creation
      const retry = await serviceClient.auth.admin.createUser({
        email: input.email,
        password: tempPassword,
        email_confirm: true,
      })

      if (retry.error || !retry.data?.user) {
        return { success: false, error: `Failed to create login on retry: ${retry.error?.message || 'Unknown error'}` }
      }

      authData = retry.data
      signUpError = retry.error
    }

    if (signUpError || !authData?.user) {
      return { success: false, error: `Failed to create login: ${signUpError?.message || 'Unknown error'}` }
    }

    // Create user_profile.
    // staff_title is the gating field for the Referral Fees tab — see
    // canViewBrokerageReferralFees() in lib/access.ts.
    const normalizedStaffTitle = input.staffTitle?.trim() || null
    const { error: profileError } = await serviceClient
      .from('user_profiles')
      .insert({
        id: authData.user.id,
        email: input.email,
        role: 'brokerage_admin',
        full_name: input.fullName,
        brokerage_id: input.brokerageId,
        staff_title: normalizedStaffTitle,
        is_active: true,
        must_reset_password: true,
      })

    if (profileError) {
      console.error('Brokerage profile create error:', profileError.message)
      return { success: false, error: `Login created but profile failed: ${profileError.message}` }
    }

    // Migration 087/098: seed brokerage_admins junction row so the multi-admin
    // pool tracks every admin invited via this legacy path. If this is the
    // FIRST admin for the brokerage, mark them broker_of_record so they can
    // manage the pool themselves. Junction-table failures are non-fatal — the
    // legacy user_profile.brokerage_id link is still the source of truth for now.
    let seededAsPrimary = false
    try {
      const { count: existingPoolCount } = await serviceClient
        .from('brokerage_admins')
        .select('*', { count: 'exact', head: true })
        .eq('brokerage_id', input.brokerageId)

      const role = existingPoolCount && existingPoolCount > 0 ? 'brokerage_admin' : 'broker_of_record'
      seededAsPrimary = role === 'broker_of_record'

      const { error: junctionErr } = await serviceClient
        .from('brokerage_admins')
        .insert({
          brokerage_id: input.brokerageId,
          user_id: authData.user.id,
          role,
          invited_at: new Date().toISOString(),
          created_by: user.id,
        })
      if (junctionErr) {
        console.warn('[inviteBrokerageAdmin] brokerage_admins seed failed (non-fatal):', junctionErr.message)
      }
    } catch (junctionErr: unknown) {
      const junctionMessage = junctionErr instanceof Error ? junctionErr.message : 'Unknown error'
      console.warn('[inviteBrokerageAdmin] brokerage_admins seed threw (non-fatal):', junctionMessage)
    }

    // Generate magic link token (72-hour expiry)
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

    await serviceClient
      .from('invite_tokens')
      .insert({
        token: inviteToken,
        user_id: authData.user.id,
        email: input.email,
        expires_at: expiresAt,
      })

    // Send branded invite email
    await sendBrokerageInviteNotification({
      adminName: input.fullName.split(' ')[0],
      adminEmail: input.email,
      brokerageName: brokerage.name,
      inviteToken,
    })

    await logAuditEvent({
      action: 'brokerage_admin.invite',
      entityType: 'user',
      entityId: authData.user.id,
      metadata: {
        brokerage_id: input.brokerageId,
        brokerage_name: brokerage.name,
        admin_name: input.fullName,
        admin_email: input.email,
        admin_staff_title: normalizedStaffTitle,
        invited_by: user.id,
        invite_method: 'magic_link',
        seeded_as_primary: seededAsPrimary,
      },
    })

    // Auto-send BCA to Broker of Record if BOR info is available
    // Non-blocking — failure here never prevents the invite from succeeding
    try {
      const { data: fullBrokerage } = await serviceClient
        .from('brokerages')
        .select('broker_of_record_name, broker_of_record_email, bca_signed_at')
        .eq('id', input.brokerageId)
        .single()

      if (fullBrokerage?.broker_of_record_email && fullBrokerage?.broker_of_record_name && !fullBrokerage?.bca_signed_at) {
        // Check if there's already a pending BCA envelope
        const { data: existingBca } = await serviceClient
          .from('esignature_envelopes')
          .select('id')
          .eq('brokerage_id', input.brokerageId)
          .eq('document_type', 'bca')
          .in('status', ['sent', 'delivered'])
          .maybeSingle()

        if (!existingBca) {
          const { sendBcaForSignature } = await import('@/lib/actions/esign-actions')
          const bcaResult = await sendBcaForSignature(input.brokerageId)
          if (bcaResult.success) {
            console.log(`BCA auto-sent to ${fullBrokerage.broker_of_record_email} for brokerage ${brokerage.name}`)
          } else {
            console.warn(`BCA auto-send failed for brokerage ${brokerage.name}: ${bcaResult.error}`)
          }
        }
      }
    } catch (bcaErr: unknown) {
      const bcaMessage = bcaErr instanceof Error ? bcaErr.message : 'Unknown error'
      console.warn('BCA auto-send skipped (non-blocking):', bcaMessage)
    }

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Invite brokerage admin error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Invite Brokerage Onboarding Contacts (bulk)
// ============================================================================
// Used by the FF admin "New Brokerage" flow after a brokerage is created to
// fan out invites to the five canonical contacts:
//   - Broker of Record       -> staff_title: 'Broker of Record'
//   - Brokerage Manager      -> staff_title: 'Brokerage Manager'
//   - Admin 1 / 2 / 3        -> staff_title: null
//
// The first two titles match canViewBrokerageReferralFees() in lib/access.ts
// (case-insensitive). Admin 1/2/3 deliberately store NULL so they don't
// see the Referral Fees tab.
//
// Each non-blank email triggers an inviteBrokerageAdmin() call. Individual
// failures are collected and returned in `errors[]` so the create flow can
// surface a partial-success message rather than rolling back the brokerage
// itself.
// ============================================================================

export interface OnboardingContactInput {
  /** Free-form full name. Falls back to the role label if blank. */
  fullName?: string | null
  /** Login email. Blank entries are skipped silently. */
  email?: string | null
  /**
   * Value written to user_profiles.staff_title. Pass 'Broker of Record' or
   * 'Brokerage Manager' to grant the Referral Fees tab; pass null for
   * generic admins.
   */
  staffTitle: string | null
  /**
   * Human-readable label used in error messages and as the fallback
   * fullName ('Broker of Record', 'Admin 1', etc).
   */
  roleLabel: string
}

export async function inviteBrokerageOnboardingContacts(input: {
  brokerageId: string
  contacts: OnboardingContactInput[]
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('brokerage.manage')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  let sent = 0
  let failed = 0
  let skipped = 0
  const errors: Array<{ roleLabel: string; email: string; error: string }> = []

  for (const contact of input.contacts) {
    const email = (contact.email || '').trim()
    if (!email) {
      skipped += 1
      continue
    }
    const fullName = (contact.fullName || '').trim() || contact.roleLabel
    const result = await inviteBrokerageAdmin({
      brokerageId: input.brokerageId,
      fullName,
      email,
      staffTitle: contact.staffTitle,
    })
    if (result.success) {
      sent += 1
    } else {
      failed += 1
      errors.push({
        roleLabel: contact.roleLabel,
        email,
        error: result.error || 'Failed to invite',
      })
    }
  }

  return { success: true, data: { sent, failed, skipped, errors } }
}

// ============================================================================
// Resend Brokerage Admin Setup Link
// ============================================================================

export async function resendBrokerageSetupLink(input: {
  userId: string
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('brokerage.manage')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  try {
    const serviceClient = createServiceRoleClient()

    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('id, email, full_name, brokerage_id, role')
      .eq('id', input.userId)
      .single()

    if (!profile || profile.role !== 'brokerage_admin') {
      return { success: false, error: 'Brokerage admin not found' }
    }

    const { data: brokerage } = await serviceClient
      .from('brokerages')
      .select('name')
      .eq('id', profile.brokerage_id)
      .single()

    // Reset password to temp
    const tempPassword = generateTempPassword()
    await serviceClient.auth.admin.updateUserById(profile.id, {
      password: tempPassword,
    })

    // Set must_reset_password
    await serviceClient
      .from('user_profiles')
      .update({ must_reset_password: true })
      .eq('id', profile.id)

    await serviceClient.auth.admin.updateUserById(profile.id, {
      user_metadata: { password_changed: false },
    })

    // Generate new magic link
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()

    await serviceClient
      .from('invite_tokens')
      .insert({
        token: inviteToken,
        user_id: profile.id,
        email: profile.email,
        expires_at: expiresAt,
      })

    // Send email
    await sendBrokerageInviteNotification({
      adminName: profile.full_name?.split(' ')[0] || 'Admin',
      adminEmail: profile.email,
      brokerageName: brokerage?.name || 'Your Brokerage',
      inviteToken,
    })

    await logAuditEvent({
      action: 'brokerage_admin.resend_setup',
      entityType: 'user',
      entityId: profile.id,
      metadata: {
        email: profile.email,
        name: profile.full_name,
        resent_by: user.id,
      },
    })

    return { success: true }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('Resend brokerage setup link error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

export async function getAgentPreauthFormSignedUrl(input: {
  agentId: string
}): Promise<ActionResult> {
  const { error: authErr } = await getAuthenticatedCapable('pii.banking')
  if (authErr) return { success: false, error: authErr }
  if (!input.agentId) return { success: false, error: 'Agent id is required' }

  try {
    const serviceClient = createServiceRoleClient()
    const { data: agent, error: lookupErr } = await serviceClient
      .from('agents')
      .select('id, first_name, last_name, email, preauth_form_path')
      .eq('id', input.agentId)
      .single()

    if (lookupErr || !agent) return { success: false, error: 'Agent not found' }
    if (!agent.preauth_form_path) return { success: false, error: 'No pre-auth form found for this agent' }
    if (!agent.preauth_form_path.startsWith(`${agent.id}/`) || agent.preauth_form_path.includes('..')) {
      return { success: false, error: 'Pre-auth form path is invalid' }
    }

    const { data, error } = await serviceClient.storage
      .from('agent-preauth-forms')
      .createSignedUrl(agent.preauth_form_path, 300, { download: false })

    if (error || !data?.signedUrl) {
      return { success: false, error: 'Failed to generate pre-auth form link' }
    }

    await logAuditEvent({
      action: 'agent.preauth_form_view',
      entityType: 'agent',
      entityId: agent.id,
      metadata: {
        agent_email: agent.email,
        agent_name: `${agent.first_name} ${agent.last_name}`,
      },
    })

    return { success: true, data: { signedUrl: data.signedUrl } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('getAgentPreauthFormSignedUrl error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

/**
 * Signed URL for a brokerage's signed BCA PDF. The signed copy is stored by the
 * DocuSign webhook at brokerage-bca/{brokerageId}/... in the deal-documents
 * bucket and recorded on brokerages.bca_signed_pdf_path (migration 107). Gated
 * to Owner (brokerage.manage), consistent with sending/voiding the BCA.
 */
export async function getSignedBcaUrl(input: {
  brokerageId: string
}): Promise<ActionResult> {
  const { error: authErr } = await getAuthenticatedCapable('brokerage.manage')
  if (authErr) return { success: false, error: authErr }
  if (!input.brokerageId) return { success: false, error: 'Brokerage id is required' }

  try {
    const serviceClient = createServiceRoleClient()
    const { data: brokerage, error: lookupErr } = await serviceClient
      .from('brokerages')
      .select('id, name, bca_signed_pdf_path')
      .eq('id', input.brokerageId)
      .single()

    if (lookupErr || !brokerage) return { success: false, error: 'Brokerage not found' }
    if (!brokerage.bca_signed_pdf_path) return { success: false, error: 'No signed BCA on file yet' }
    if (
      !brokerage.bca_signed_pdf_path.startsWith(`brokerage-bca/${brokerage.id}/`) ||
      brokerage.bca_signed_pdf_path.includes('..')
    ) {
      return { success: false, error: 'Signed BCA path is invalid' }
    }

    const { data, error } = await serviceClient.storage
      .from('deal-documents')
      .createSignedUrl(brokerage.bca_signed_pdf_path, 3600, { download: false })

    if (error || !data?.signedUrl) {
      return { success: false, error: 'Failed to generate signed BCA link' }
    }

    await logAuditEvent({
      action: 'brokerage.bca_view',
      entityType: 'brokerage',
      entityId: brokerage.id,
      metadata: { brokerage_name: brokerage.name },
    })

    return { success: true, data: { signedUrl: data.signedUrl } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('getSignedBcaUrl error:', _msg)
    return { success: false, error: 'An unexpected error occurred' }
  }
}

// ============================================================================
// Early Closing: Record actual closing date earlier than scheduled and refund
// the prepaid discount fee for the days the agent didn't actually hold the
// funds. Backed by migration 085 (actual_closing_date, discount_refund_amount).
//
// Formula (mirrors lib/calculations.ts $0.80 per $1000 per day):
//   days_saved      = closing_date - actual_closing_date
//   refund_per_day  = advance_amount / 1000 * DISCOUNT_RATE_PER_1000_PER_DAY
//   refund_total    = days_saved * refund_per_day
//
// The refund credits the agent's balance via apply_agent_balance_delta (negative
// delta = credit). The deal STAYS 'funded' — recording an early closing does NOT
// complete the deal. A deal only completes once the brokerage's payment has been
// recorded (see updateDealStatus), so this just trues-up the prepaid discount fee
// and records the actual closing date. Optimistic-lock on deals.version
// (migration 083) so two concurrent recordEarlyClosing calls can't both apply the credit.
// ============================================================================

export async function recordEarlyClosing(input: {
  dealId: string
  actualClosingDate: string  // YYYY-MM-DD
  expectedVersion?: number   // Optimistic lock — pass deals.version read by caller
}): Promise<ActionResult> {
  const { error: authErr, user } = await getAuthenticatedCapable('money.write')
  if (authErr || !user) return { success: false, error: authErr || 'Authentication failed' }

  if (!input.dealId) return { success: false, error: 'Deal ID is required' }
  if (!input.actualClosingDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.actualClosingDate)) {
    return { success: false, error: 'actualClosingDate must be a YYYY-MM-DD date string' }
  }

  const serviceClient = createServiceRoleClient()

  try {
    const { data: deal, error: dealErr } = await serviceClient
      .from('deals')
      .select('id, status, closing_date, advance_amount, agent_id, property_address, actual_closing_date, discount_refund_amount, version')
      .eq('id', input.dealId)
      .single()

    if (dealErr || !deal) return { success: false, error: 'Deal not found' }
    if (deal.status !== 'funded') {
      return { success: false, error: 'Early closing can only be recorded on funded deals' }
    }
    if (deal.actual_closing_date) {
      return { success: false, error: 'Early closing has already been recorded for this deal' }
    }
    if (!deal.closing_date) {
      return { success: false, error: 'Deal is missing a scheduled closing date' }
    }
    if (!deal.advance_amount || deal.advance_amount <= 0) {
      return { success: false, error: 'Deal has no advance amount to refund against' }
    }
    if (!deal.agent_id) {
      return { success: false, error: 'Deal has no agent assigned' }
    }

    // Compare dates as YYYY-MM-DD strings (no timezone math needed).
    const scheduledStr = (deal.closing_date as string).slice(0, 10)
    const actualStr = input.actualClosingDate
    if (actualStr >= scheduledStr) {
      return {
        success: false,
        error: 'Actual closing date must be earlier than the scheduled closing date',
      }
    }

    // Days saved = scheduled - actual (positive integer).
    const scheduledMs = new Date(scheduledStr + 'T00:00:00Z').getTime()
    const actualMs = new Date(actualStr + 'T00:00:00Z').getTime()
    const daysSaved = Math.round((scheduledMs - actualMs) / (24 * 60 * 60 * 1000))
    if (daysSaved <= 0) {
      return { success: false, error: 'Days saved must be greater than zero' }
    }

    // Refund formula mirrors calculateDeal: rate is per $1000 per day.
    const refundPerDay = (Number(deal.advance_amount) / 1000) * DISCOUNT_RATE_PER_1000_PER_DAY
    const refundTotal = Math.round(daysSaved * refundPerDay * 100) / 100

    if (refundTotal <= 0.005) {
      return { success: false, error: 'Computed refund is zero — nothing to record' }
    }

    // Optimistic lock + claim. CAS on (id, version, actual_closing_date IS NULL,
    // status='funded') so two concurrent calls can't both pass the precheck and
    // both apply the credit. NOTE: we do NOT set status here — the deal stays
    // 'funded' and only completes once the brokerage payment is recorded. The
    // status='funded' clause is the claim guard, not a transition.
    let claimQuery = serviceClient
      .from('deals')
      .update({
        actual_closing_date: actualStr,
        discount_refund_amount: refundTotal,
      })
      .eq('id', deal.id)
      .eq('status', 'funded')
      .is('actual_closing_date', null)

    if (typeof input.expectedVersion === 'number') {
      claimQuery = claimQuery.eq('version', input.expectedVersion)
    }

    const { data: claimed, error: claimErr } = await claimQuery
      .select('id, version')
      .maybeSingle()

    if (claimErr) {
      console.error('recordEarlyClosing claim error:', claimErr.message)
      return { success: false, error: `Failed to record early closing: ${claimErr.message}` }
    }
    if (!claimed) {
      return {
        success: false,
        error: 'Deal was modified by another session. Refresh and try again.',
      }
    }

    // Credit the agent via the atomic RPC. Negative delta = credit (reduces
    // what the agent owes). Failure here leaves the deal with actual_closing_date
    // + the refund column set but no ledger entry — admin can re-run the balance
    // adjustment manually via the manual-adjustment flow if so.
    const { error: rpcErr } = await serviceClient.rpc('apply_agent_balance_delta', {
      p_agent_id: deal.agent_id,
      p_delta: -refundTotal,
      p_type: 'credit',
      p_description: `Early closing refund: ${daysSaved} day${daysSaved === 1 ? '' : 's'} saved (${deal.property_address}, actual closing ${actualStr})`,
      p_deal_id: deal.id,
      p_created_by: user.id,
      p_reference_id: `early_closing:${deal.id}`,
    })

    if (rpcErr) {
      console.error('recordEarlyClosing balance RPC error:', rpcErr.message)
      // Don't rollback the deal flip — the refund column is the source of
      // truth that we owe the agent. Surface the error so admin can retry.
      return {
        success: false,
        error: `Early closing recorded but credit failed: ${rpcErr.message}. Apply the credit manually.`,
      }
    }

    await logAuditEvent({
      action: 'deal.early_closing_recorded',
      entityType: 'deal',
      entityId: deal.id,
      severity: 'critical',
      metadata: {
        scheduled_closing_date: scheduledStr,
        actual_closing_date: actualStr,
        days_saved: daysSaved,
        advance_amount: deal.advance_amount,
        refund_amount: refundTotal,
        agent_id: deal.agent_id,
        property_address: deal.property_address,
      },
    })

    return { success: true, data: { refund_amount: refundTotal, days_saved: daysSaved } }
  } catch (err: unknown) {
    const _msg = err instanceof Error ? err.message : "Unknown error"
    console.error('recordEarlyClosing error:', _msg)
    return { success: false, error: _msg || 'An unexpected error occurred' }
  }
}
