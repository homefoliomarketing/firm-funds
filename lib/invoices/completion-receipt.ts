// =============================================================================
// Deal completion receipt orchestrator.
// -----------------------------------------------------------------------------
// One reusable entry point, generateAndStoreCompletionReceipt(), that:
//   1. loads the deal + agent (name/email) + brokerage (name) + branding,
//   2. DEDUPES on an existing completion_invoice deal_documents row (idempotent
//      so a re-completion or a retried call never issues a second receipt),
//   3. builds the one-page receipt PDF (lib/invoices/completion-receipt-pdf.ts),
//   4. uploads it to the 'deal-documents' storage bucket,
//   5. inserts a deal_documents row (document_type 'completion_invoice'),
//   6. emails the agent the receipt with the PDF attached.
//
// Best-effort by contract: the caller (updateDealStatus, after the completed CAS
// has already won) wraps this in its own try/catch, AND this function never lets
// a PDF/storage/email failure propagate as a thrown error that could be mistaken
// for a completion failure. Specifically, an EMAIL failure still leaves the
// stored PDF in place (the email is the last step and its failure is swallowed).
// It does NOT touch any money math, balance, or ledger RPC.
//
// This is NOT marked 'use server' on purpose: it is a plain library module that
// takes an already-constructed service-role client, so it can be called from a
// server action or a cron route without the 'use server' export constraints.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildDealCompletionReceiptPdf, type CompletionReceiptData } from './completion-receipt-pdf'

// The storage upload + deal_documents insert require the service role; the
// caller must pass a service-role client (createServiceRoleClient()).
type ServiceClient = SupabaseClient

// System actor for app-generated documents, matching the SignWell webhook.
const SYSTEM_UUID = '00000000-0000-0000-0000-000000000000'

// Explicit row shapes for the three reads. The service-role client is untyped
// (no DB generics), so we cast its column projections to these instead of
// fighting the supabase string-projection inference.
interface DealReceiptRow {
  id: string
  deal_number: string | null
  property_address: string | null
  closing_date: string | null
  funding_date: string | null
  repayment_date: string | null
  advance_amount: number | string | null
  net_commission: number | string | null
  discount_fee: number | string | null
  settlement_period_fee: number | string | null
  amount_due_from_brokerage: number | string | null
  repayment_amount: number | string | null
  settlement_days_at_funding: number | string | null
  agent_id: string
  brokerage_id: string
}

interface AgentReceiptRow {
  first_name: string | null
  last_name: string | null
  email: string | null
}

interface BrokerageReceiptRow {
  name: string | null
}

export interface CompletionReceiptResult {
  /** True when a receipt was newly generated + stored on this call. */
  generated: boolean
  /** True when an existing receipt already covered this deal (deduped, no-op). */
  alreadyExisted: boolean
  /** True when the agent receipt email was dispatched (best-effort). */
  emailed: boolean
  /** Non-fatal reason this was a no-op or partial, for logging. */
  reason?: string
}

/**
 * Format a stored date value (a 'YYYY-MM-DD' DATE string or an ISO timestamp)
 * into a friendly display string like "Jun 9, 2026". Returns null on empty.
 * Parsed at UTC noon so a date-only value never drifts a day across timezones.
 */
function formatDisplayDate(value: string | null | undefined): string | null {
  if (!value) return null
  // Date-only values get an explicit noon-UTC time so the local-timezone render
  // can't roll back to the previous day.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * Generate, store, and email the deal-completion receipt. Idempotent and
 * fail-soft. Returns a small status object; only throws for a truly unexpected
 * programming error (the caller still wraps it in try/catch as a backstop).
 */
export async function generateAndStoreCompletionReceipt(
  serviceClient: ServiceClient,
  dealId: string
): Promise<CompletionReceiptResult> {
  // ---------------------------------------------------------------------------
  // 0. DEDUPE: if a completion_invoice already exists for this deal, do nothing.
  // ---------------------------------------------------------------------------
  const { data: existing, error: existingErr } = await serviceClient
    .from('deal_documents')
    .select('id')
    .eq('deal_id', dealId)
    .eq('document_type', 'completion_invoice')
    .limit(1)

  if (existingErr) {
    console.error('[completion-receipt] dedupe check failed:', existingErr.message)
    return { generated: false, alreadyExisted: false, emailed: false, reason: 'dedupe_check_failed' }
  }
  if (existing && existing.length > 0) {
    return { generated: false, alreadyExisted: true, emailed: false, reason: 'already_exists' }
  }

  // ---------------------------------------------------------------------------
  // 1. LOAD the deal (all fields the receipt needs are already snapshotted).
  // The service-role client carries no DB generics, so we cast the row to an
  // explicit shape (the supabase parser otherwise types a column projection as
  // GenericStringError, breaking every field access below).
  // ---------------------------------------------------------------------------
  const { data: dealRaw, error: dealErr } = await serviceClient
    .from('deals')
    .select(
      'id, deal_number, property_address, closing_date, funding_date, repayment_date, ' +
      'advance_amount, net_commission, discount_fee, settlement_period_fee, ' +
      'amount_due_from_brokerage, repayment_amount, settlement_days_at_funding, ' +
      'agent_id, brokerage_id'
    )
    .eq('id', dealId)
    .single()

  if (dealErr || !dealRaw) {
    console.error('[completion-receipt] deal load failed:', dealErr?.message)
    return { generated: false, alreadyExisted: false, emailed: false, reason: 'deal_load_failed' }
  }
  const deal = dealRaw as unknown as DealReceiptRow

  // Agent (name + email; email is intentionally nullable).
  const { data: agentRaw } = await serviceClient
    .from('agents')
    .select('first_name, last_name, email')
    .eq('id', deal.agent_id)
    .single()
  const agent = agentRaw as unknown as AgentReceiptRow | null

  // Brokerage (name only; the email's logo/branding is resolved separately via
  // getBrandingForBrokerage(brokerage_id) inside sendDealCompletionReceipt).
  const { data: brokerageRaw } = await serviceClient
    .from('brokerages')
    .select('name')
    .eq('id', deal.brokerage_id)
    .single()
  const brokerage = brokerageRaw as unknown as BrokerageReceiptRow | null

  const agentName = agent
    ? `${agent.first_name ?? ''} ${agent.last_name ?? ''}`.trim() || 'Agent'
    : 'Agent'
  const brokerageName = brokerage?.name || 'Your brokerage'
  // White-label brand name on the PDF header: the brokerage name when on file.
  const brandName = brokerage?.name || 'Firm Funds'

  // Money breakdown (plain dollars). The "service fee" the agent effectively
  // paid is the discount fee + the settlement-period fee; fall back to
  // (net_commission - advance_amount) when the fee columns are null. The total
  // the brokerage repaid is amount_due_from_brokerage (preferred), else the
  // recorded repayment_amount.
  const netCommission = Number(deal.net_commission ?? 0)
  const advanceAmount = Number(deal.advance_amount ?? 0)
  const feeFromColumns = Number(deal.discount_fee ?? 0) + Number(deal.settlement_period_fee ?? 0)
  const serviceFee = feeFromColumns > 0 ? feeFromColumns : Math.max(0, netCommission - advanceAmount)
  const totalRepaid = deal.amount_due_from_brokerage != null
    ? Number(deal.amount_due_from_brokerage)
    : Number(deal.repayment_amount ?? 0)

  const receiptData: CompletionReceiptData = {
    brandName,
    dealNumber: deal.deal_number ?? null,
    propertyAddress: deal.property_address ?? null,
    agentName,
    brokerageName,
    fundedDate: formatDisplayDate(deal.funding_date),
    closingDate: formatDisplayDate(deal.closing_date),
    repaidDate: formatDisplayDate(deal.repayment_date),
    settlementDays: deal.settlement_days_at_funding != null ? Number(deal.settlement_days_at_funding) : null,
    netCommission,
    advanceAmount,
    serviceFee,
    totalRepaid,
    issuedDate: new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Toronto' }),
  }

  // ---------------------------------------------------------------------------
  // 2. BUILD the PDF.
  // ---------------------------------------------------------------------------
  let pdf: Buffer
  try {
    pdf = await buildDealCompletionReceiptPdf(receiptData)
  } catch (err) {
    console.error('[completion-receipt] PDF build failed:', err instanceof Error ? err.message : err)
    return { generated: false, alreadyExisted: false, emailed: false, reason: 'pdf_build_failed' }
  }

  const safeNumber = (deal.deal_number ?? dealId).toString().replace(/[^A-Za-z0-9_-]/g, '_')
  const fileName = `Receipt_${safeNumber}.pdf`

  // ---------------------------------------------------------------------------
  // 3. UPLOAD to the 'deal-documents' bucket (deal-scoped path, same convention
  //    as the SignWell webhook).
  // ---------------------------------------------------------------------------
  const storagePath = `${dealId}/${Date.now()}_${crypto.randomUUID()}.pdf`
  const { error: uploadErr } = await serviceClient.storage
    .from('deal-documents')
    .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: false })

  if (uploadErr) {
    console.error('[completion-receipt] storage upload failed:', uploadErr.message)
    return { generated: false, alreadyExisted: false, emailed: false, reason: 'upload_failed' }
  }

  // ---------------------------------------------------------------------------
  // 4. INSERT the deal_documents row.
  // ---------------------------------------------------------------------------
  const { error: insertErr } = await serviceClient
    .from('deal_documents')
    .insert({
      deal_id: dealId,
      document_type: 'completion_invoice',
      file_name: fileName,
      file_path: storagePath,
      file_size: pdf.length,
      upload_source: 'system',
      uploaded_by: SYSTEM_UUID,
      notes: 'Deal completion receipt (auto-generated)',
    })

  if (insertErr) {
    console.error('[completion-receipt] deal_documents insert failed:', insertErr.message)
    // The PDF is uploaded but unlinked. We deliberately do NOT delete it; an
    // admin can reconcile. Treat as a non-fatal failure (the completion stands).
    return { generated: false, alreadyExisted: false, emailed: false, reason: 'insert_failed' }
  }

  // ---------------------------------------------------------------------------
  // 5. EMAIL the agent the receipt (best-effort). An email failure must NOT
  //    undo the stored PDF, so it is wrapped and swallowed here, after the row
  //    is already committed above. Skip entirely when no email is on file.
  // ---------------------------------------------------------------------------
  let emailed = false
  if (agent?.email) {
    try {
      const { sendDealCompletionReceipt } = await import('@/lib/email')
      await sendDealCompletionReceipt({
        agentEmail: agent.email,
        agentName,
        agentId: deal.agent_id,
        dealNumber: deal.deal_number ?? null,
        propertyAddress: deal.property_address ?? null,
        brokerageId: deal.brokerage_id,
        netCommission,
        advanceAmount,
        serviceFee,
        totalRepaid,
        pdf,
        pdfFileName: fileName,
      })
      emailed = true
    } catch (err) {
      console.error('[completion-receipt] receipt email failed (PDF still stored):', err instanceof Error ? err.message : err)
    }
  }

  return {
    generated: true,
    alreadyExisted: false,
    emailed,
    reason: agent?.email ? undefined : 'no_agent_email',
  }
}
