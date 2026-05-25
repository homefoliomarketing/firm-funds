import type { SupabaseClient } from '@supabase/supabase-js'

// Canonical row shape for the brokerage_payments table (migration 055).
// Reader sites still use the legacy `date` field; convert via toLegacyShape().
export interface BrokeragePaymentRow {
  id: string
  deal_id: string
  brokerage_id: string
  amount: number
  payment_date: string
  reference: string | null
  method: 'eft' | 'wire' | 'cheque' | 'cash' | 'other' | null
  notes: string | null
  status: 'pending' | 'confirmed' | 'rejected'
  submitted_by_role: 'admin' | 'brokerage_admin' | null
  submitted_by_user_id: string | null
  submitted_at: string
  reviewed_by_user_id: string | null
  reviewed_at: string | null
  rejection_reason: string | null
}

// Legacy shape for backward compat with reader code that hasn't been
// migrated to the table columns yet.
export interface BrokeragePaymentLegacyShape {
  id: string
  amount: number
  date: string
  reference?: string
  method?: string
  notes?: string
  status: 'pending' | 'confirmed' | 'rejected'
  submitted_by_role?: 'admin' | 'brokerage_admin'
  submitted_by_user_id?: string
  submitted_at?: string
  reviewed_by_user_id?: string
  reviewed_at?: string
  rejection_reason?: string
}

export function toLegacyShape(row: BrokeragePaymentRow): BrokeragePaymentLegacyShape {
  return {
    id: row.id,
    amount: Number(row.amount),
    date: row.payment_date,
    ...(row.reference ? { reference: row.reference } : {}),
    ...(row.method ? { method: row.method } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    status: row.status,
    ...(row.submitted_by_role ? { submitted_by_role: row.submitted_by_role } : {}),
    ...(row.submitted_by_user_id ? { submitted_by_user_id: row.submitted_by_user_id } : {}),
    submitted_at: row.submitted_at,
    ...(row.reviewed_by_user_id ? { reviewed_by_user_id: row.reviewed_by_user_id } : {}),
    ...(row.reviewed_at ? { reviewed_at: row.reviewed_at } : {}),
    ...(row.rejection_reason ? { rejection_reason: row.rejection_reason } : {}),
  }
}

export function sumConfirmedPayments(
  rows: Array<Pick<BrokeragePaymentRow, 'amount' | 'status'>> | null | undefined,
): number {
  if (!rows) return 0
  return rows
    .filter((r) => r.status === 'confirmed')
    .reduce((s, r) => s + Number(r.amount || 0), 0)
}

export async function fetchPaymentsForDeal(
  dealId: string,
  supabase: SupabaseClient,
): Promise<BrokeragePaymentRow[]> {
  const { data, error } = await supabase
    .from('brokerage_payments')
    .select('*')
    .eq('deal_id', dealId)
    .order('submitted_at', { ascending: true })
  if (error) throw new Error(`fetchPaymentsForDeal: ${error.message}`)
  return (data as BrokeragePaymentRow[]) || []
}

export interface InsertPaymentInput {
  dealId: string
  brokerageId: string
  amount: number
  paymentDate: string
  reference?: string | null
  method?: 'eft' | 'wire' | 'cheque' | 'cash' | 'other' | null
  notes?: string | null
  status: 'pending' | 'confirmed'
  submittedByRole: 'admin' | 'brokerage_admin'
  submittedByUserId: string
}

export async function insertPayment(
  input: InsertPaymentInput,
  supabase: SupabaseClient,
): Promise<BrokeragePaymentRow> {
  const { data, error } = await supabase
    .from('brokerage_payments')
    .insert({
      deal_id: input.dealId,
      brokerage_id: input.brokerageId,
      amount: input.amount,
      payment_date: input.paymentDate,
      reference: input.reference || null,
      method: input.method || null,
      notes: input.notes || null,
      status: input.status,
      submitted_by_role: input.submittedByRole,
      submitted_by_user_id: input.submittedByUserId,
    })
    .select()
    .single()
  if (error) throw new Error(`insertPayment: ${error.message}`)
  return data as BrokeragePaymentRow
}

export async function deletePayment(
  paymentId: string,
  supabase: SupabaseClient,
): Promise<BrokeragePaymentRow> {
  // audit finding #21: .eq('status', 'pending') precondition catches a
  // concurrent confirm/reject between the caller's read and this DELETE.
  // Migration 060 also blocks confirmed-row DELETE at the DB layer.
  const { data, error } = await supabase
    .from('brokerage_payments')
    .delete()
    .eq('id', paymentId)
    .eq('status', 'pending')
    .select()
    .maybeSingle()
  if (error) throw new Error(`deletePayment: ${error.message}`)
  if (!data) throw new Error('deletePayment: payment is missing or no longer pending')
  return data as BrokeragePaymentRow
}

export async function reviewPayment(
  paymentId: string,
  decision: 'confirmed' | 'rejected',
  reviewerUserId: string,
  rejectionReason: string | null,
  supabase: SupabaseClient,
): Promise<BrokeragePaymentRow | null> {
  const update: Record<string, unknown> = {
    status: decision,
    reviewed_by_user_id: reviewerUserId,
    reviewed_at: new Date().toISOString(),
    rejection_reason: decision === 'rejected' ? rejectionReason : null,
  }
  // Only flip status from pending — block double-reviews atomically.
  const { data, error } = await supabase
    .from('brokerage_payments')
    .update(update)
    .eq('id', paymentId)
    .eq('status', 'pending')
    .select()
    .maybeSingle()
  if (error) throw new Error(`reviewPayment: ${error.message}`)
  return (data as BrokeragePaymentRow) || null
}
