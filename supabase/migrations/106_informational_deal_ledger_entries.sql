-- ============================================================================
-- Migration 106: Informational deal-advance / deal-repayment ledger entries
-- ============================================================================
-- Makes an agent's ledger read like a statement. When a deal is funded we post
-- a 'deal_advance' charge for the outstanding balance (amount_due_from_brokerage);
-- when a brokerage payment is confirmed received we post a 'deal_repayment'
-- payment. On a clean deal the two net to zero.
--
-- CRITICAL: these entries DO NOT move agents.account_balance. That number stays
-- the "money owed outside a clean advance" figure that drives late-interest
-- accrual (migration 066) and next-advance netting (deal-actions funded branch).
-- A funded advance the brokerage repays on the agent's behalf is NOT agent debt,
-- so it must never trigger interest or be deducted from a future advance.
-- record_agent_statement_entry inserts the row with running_balance frozen at
-- the current account_balance and leaves account_balance untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Allow the two new informational types on the ledger.
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
    'failed_deal_interest',
    'deal_advance',
    'deal_repayment'
  ]));

-- ---------------------------------------------------------------------------
-- 2. record_agent_statement_entry — balance-neutral informational insert.
-- ---------------------------------------------------------------------------
-- Mirrors apply_agent_balance_delta's shape but DELIBERATELY does not change
-- account_balance. running_balance is stamped with the current balance so the
-- ledger UI shows the line did not move what the agent owes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_agent_statement_entry(
  p_agent_id uuid,
  p_type text,
  p_amount numeric,
  p_description text,
  p_deal_id uuid DEFAULT NULL,
  p_created_by uuid DEFAULT NULL,
  p_reference_id text DEFAULT NULL
)
RETURNS agent_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_balance numeric;
  v_txn public.agent_transactions;
BEGIN
  -- Guard: this RPC is ONLY for informational entries. Routing a
  -- balance-affecting type through here would post a row whose running_balance
  -- disagrees with account_balance and silently corrupt reconciliation.
  IF p_type NOT IN ('deal_advance', 'deal_repayment') THEN
    RAISE EXCEPTION 'record_agent_statement_entry only accepts informational types, got %', p_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock the agent row so the frozen running_balance we stamp matches a balance
  -- no concurrent balance delta can change underneath us.
  SELECT COALESCE(account_balance, 0)
    INTO v_balance
    FROM public.agents
    WHERE id = p_agent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent % not found', p_agent_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Insert WITHOUT touching account_balance. running_balance is frozen at the
  -- current balance to signal "this line did not move it".
  INSERT INTO public.agent_transactions (
    agent_id, deal_id, type, amount, running_balance, description, created_by, reference_id
  ) VALUES (
    p_agent_id, p_deal_id, p_type, p_amount, v_balance, p_description, p_created_by, p_reference_id
  )
  RETURNING * INTO v_txn;

  RETURN v_txn;
END;
$$;

REVOKE ALL ON FUNCTION record_agent_statement_entry(uuid, text, numeric, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_agent_statement_entry(uuid, text, numeric, text, uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION record_agent_statement_entry(uuid, text, numeric, text, uuid, uuid, text) IS
  'Inserts an informational agent_transactions row (deal_advance / deal_repayment) WITHOUT changing agents.account_balance. running_balance is frozen at the current balance. service_role only.';
