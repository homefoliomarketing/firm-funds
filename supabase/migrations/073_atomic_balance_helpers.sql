-- Migration 073: atomic-helper RPCs for the remaining read-modify-write code paths,
-- plus the new agent_transactions type value used by the funded->approved reversal.
--
-- AUDIT FINDINGS (session 12 follow-up):
--   - deductBalanceFromAdvance (account-actions.ts ~360-390): reads agent.account_balance
--     to clamp the deduct amount BEFORE calling apply_agent_balance_delta. Concurrent
--     interest accrual between the read and the RPC could yield an over- or
--     under-clamped deduction. Fix: do clamp + balance delta in one RPC under FOR UPDATE.
--   - markInvoicePaid (account-actions.ts ~600-625): UPDATE agent_invoices SET status='paid'
--     and apply_agent_balance_delta are two separate writes. A failure between them leaves
--     the invoice marked paid with no ledger entry, or vice versa. Fix: combine in one
--     PL/pgSQL transaction.
--   - The funded->approved refund path posts via apply_agent_balance_delta with
--     p_type='credit' because the agent_transactions.type CHECK constraint doesn't
--     include 'balance_deduction_reversed'. Adding the semantic value makes the ledger
--     legible for audit and reconciliation.

-- ---------------------------------------------------------------------------
-- Add 'balance_deduction_reversed' to agent_transactions.type
-- ---------------------------------------------------------------------------

ALTER TABLE agent_transactions DROP CONSTRAINT IF EXISTS agent_transactions_type_check;
ALTER TABLE agent_transactions ADD CONSTRAINT agent_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'late_closing_interest',
    'late_payment_interest',
    'balance_deduction',
    'balance_deduction_reversed',
    'invoice_payment',
    'adjustment',
    'credit',
    'failed_deal_balance',
    'failed_deal_interest'
  ]));

-- ---------------------------------------------------------------------------
-- apply_agent_balance_delta_capped
-- ---------------------------------------------------------------------------
-- Atomic clamp + deduct. Locks the agent row, reads current balance, clamps
-- p_delta_magnitude to min(p_delta_magnitude, current_balance), writes the new
-- balance, inserts the ledger row, returns the actual deducted amount and new
-- balance.
--
-- p_delta_magnitude is the absolute value of the desired deduction (positive).
-- The RPC applies it as a negative delta to account_balance.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_agent_balance_delta_capped(
  p_agent_id uuid,
  p_delta_magnitude numeric,
  p_type text,
  p_description text,
  p_deal_id uuid DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_balance numeric;
  v_actual_deduction numeric;
  v_new_balance numeric;
BEGIN
  IF p_delta_magnitude <= 0 THEN
    RAISE EXCEPTION 'p_delta_magnitude must be positive (got %)', p_delta_magnitude
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(account_balance, 0)
    INTO v_current_balance
    FROM public.agents
    WHERE id = p_agent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent % not found', p_agent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_current_balance <= 0 THEN
    RETURN json_build_object(
      'deducted', 0,
      'new_balance', v_current_balance,
      'skipped', true,
      'reason', 'No outstanding balance'
    );
  END IF;

  v_actual_deduction := LEAST(p_delta_magnitude, v_current_balance);
  v_new_balance := v_current_balance - v_actual_deduction;

  UPDATE public.agents
    SET account_balance = v_new_balance,
        updated_at = NOW()
    WHERE id = p_agent_id;

  INSERT INTO public.agent_transactions (
    agent_id, deal_id, type, amount, running_balance, description, created_by
  ) VALUES (
    p_agent_id, p_deal_id, p_type, -v_actual_deduction, v_new_balance, p_description, p_created_by
  );

  RETURN json_build_object(
    'deducted', v_actual_deduction,
    'new_balance', v_new_balance,
    'skipped', false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION apply_agent_balance_delta_capped(uuid, numeric, text, text, uuid, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION apply_agent_balance_delta_capped(uuid, numeric, text, text, uuid, uuid) TO service_role;

COMMENT ON FUNCTION apply_agent_balance_delta_capped(uuid, numeric, text, text, uuid, uuid) IS
  'Atomic clamp + deduct under FOR UPDATE. Caller passes desired magnitude; RPC deducts min(magnitude, current_balance). service-role only.';

-- ---------------------------------------------------------------------------
-- mark_invoice_paid_atomic
-- ---------------------------------------------------------------------------
-- Combines UPDATE agent_invoices + apply_agent_balance_delta semantics in one
-- transaction. Idempotent: if the invoice is already paid, returns without
-- re-posting. Uses CAS on invoice.status to serialize concurrent mark-paid clicks.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_invoice_paid_atomic(
  p_invoice_id uuid,
  p_paid_amount numeric,
  p_created_by uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_agent_id uuid;
  v_invoice_number text;
  v_invoice_amount numeric;
  v_prior_status text;
  v_claimed int;
  v_old_balance numeric;
  v_new_balance numeric;
BEGIN
  -- CAS: only mark paid if currently unpaid. Lock the row.
  UPDATE public.agent_invoices
     SET status = 'paid',
         paid_at = NOW(),
         paid_amount = p_paid_amount
   WHERE id = p_invoice_id
     AND status <> 'paid'
  RETURNING agent_id, invoice_number, amount, 'pending' INTO v_agent_id, v_invoice_number, v_invoice_amount, v_prior_status;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;

  IF v_claimed = 0 THEN
    -- Either invoice doesn't exist or it's already paid. Differentiate.
    SELECT agent_id INTO v_agent_id FROM public.agent_invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found', p_invoice_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN json_build_object('skipped', true, 'reason', 'Invoice already paid');
  END IF;

  -- Lock the agent row and post the credit.
  SELECT COALESCE(account_balance, 0)
    INTO v_old_balance
    FROM public.agents
    WHERE id = v_agent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- Roll back invoice flip; the trigger raises and aborts the transaction.
    RAISE EXCEPTION 'Agent % not found', v_agent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_new_balance := v_old_balance - p_paid_amount;

  UPDATE public.agents
    SET account_balance = v_new_balance,
        updated_at = NOW()
    WHERE id = v_agent_id;

  INSERT INTO public.agent_transactions (
    agent_id, deal_id, type, amount, running_balance, description, created_by, reference_id
  ) VALUES (
    v_agent_id, NULL, 'invoice_payment',
    -p_paid_amount, v_new_balance,
    'Invoice payment - ' || v_invoice_number,
    p_created_by, p_invoice_id::text
  );

  RETURN json_build_object(
    'skipped', false,
    'paid_amount', p_paid_amount,
    'new_balance', v_new_balance,
    'invoice_number', v_invoice_number
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION mark_invoice_paid_atomic(uuid, numeric, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION mark_invoice_paid_atomic(uuid, numeric, uuid) TO service_role;

COMMENT ON FUNCTION mark_invoice_paid_atomic(uuid, numeric, uuid) IS
  'Atomic UPDATE invoice + post ledger credit. CAS on status prevents double-payment. service-role only.';
