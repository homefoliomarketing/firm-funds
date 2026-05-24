-- =============================================================================
-- Session 2: Atomic agent-balance + strike-increment RPCs
-- =============================================================================
-- Replaces the read-modify-write pattern at 9+ call sites that mutate
-- agents.account_balance and write to agent_transactions in two separate
-- statements. Concurrent runs (e.g. cron + admin click) could overwrite each
-- other and silently drift the ledger. The RPC below does both in one
-- transaction with a row lock on agents.
--
-- Similarly, recordLateStrike's increment of brokerages.late_strike_count
-- was racy: two concurrent strikes could both read 4, both write 5. The
-- record_brokerage_late_strike RPC below serializes via FOR UPDATE.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- apply_agent_balance_delta
-- ---------------------------------------------------------------------------
-- Atomically updates an agent's account_balance and inserts a matching ledger
-- row. Returns the new transaction row including its running_balance so the
-- caller can confirm the post-update state.
--
-- p_delta is signed: positive = balance goes up (agent owes more), negative =
-- balance goes down (agent paid / credit applied).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_agent_balance_delta(
  p_agent_id uuid,
  p_delta numeric,
  p_type text,
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
  v_old_balance numeric;
  v_new_balance numeric;
  v_txn public.agent_transactions;
BEGIN
  -- Lock the agent row to serialize concurrent balance updates.
  SELECT COALESCE(account_balance, 0)
    INTO v_old_balance
    FROM public.agents
    WHERE id = p_agent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent % not found', p_agent_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_new_balance := v_old_balance + p_delta;

  UPDATE public.agents
    SET account_balance = v_new_balance,
        updated_at = NOW()
    WHERE id = p_agent_id;

  INSERT INTO public.agent_transactions (
    agent_id, deal_id, type, amount, running_balance, description, created_by, reference_id
  ) VALUES (
    p_agent_id, p_deal_id, p_type, p_delta, v_new_balance, p_description, p_created_by, p_reference_id
  )
  RETURNING * INTO v_txn;

  RETURN v_txn;
END;
$$;

REVOKE ALL ON FUNCTION apply_agent_balance_delta(uuid, numeric, text, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_agent_balance_delta(uuid, numeric, text, text, uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION apply_agent_balance_delta(uuid, numeric, text, text, uuid, uuid, text) IS
  'Atomically updates agents.account_balance by p_delta and inserts the matching agent_transactions row. Returns the new transaction.';

-- ---------------------------------------------------------------------------
-- record_brokerage_late_strike
-- ---------------------------------------------------------------------------
-- Atomically increments brokerages.late_strike_count by 1 and conditionally
-- sets auto_bumped_to_14_days_at if the new count crosses the threshold and
-- the brokerage was not already bumped. Returns the new count and whether
-- THIS call performed the bump.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_brokerage_late_strike(
  p_brokerage_id uuid,
  p_strike_threshold int
)
RETURNS TABLE(new_strike_count int, bumped_now boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_count int;
  v_old_bumped timestamptz;
  v_should_bump boolean;
BEGIN
  SELECT COALESCE(late_strike_count, 0), auto_bumped_to_14_days_at
    INTO v_old_count, v_old_bumped
    FROM public.brokerages
    WHERE id = p_brokerage_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Brokerage % not found', p_brokerage_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_should_bump := (v_old_bumped IS NULL AND (v_old_count + 1) >= p_strike_threshold);

  UPDATE public.brokerages
  SET late_strike_count = v_old_count + 1,
      auto_bumped_to_14_days_at = CASE
        WHEN v_should_bump THEN NOW()
        ELSE v_old_bumped
      END,
      updated_at = NOW()
  WHERE id = p_brokerage_id;

  new_strike_count := v_old_count + 1;
  bumped_now := v_should_bump;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION record_brokerage_late_strike(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_brokerage_late_strike(uuid, int) TO service_role;

COMMENT ON FUNCTION record_brokerage_late_strike(uuid, int) IS
  'Atomically increments brokerages.late_strike_count and conditionally sets auto_bumped_to_14_days_at. Returns new count and whether this call caused the bump.';

-- ---------------------------------------------------------------------------
-- apply_remediation_remittance
-- ---------------------------------------------------------------------------
-- Single-transaction wrapper for a Remediation IDP remittance. Posts the
-- unposted-interest catch-up row (if any) AND the credit row in one
-- transaction, then updates account_balance. Replaces the two-step pattern
-- that would otherwise post a phantom credit when applyToUnposted > 0
-- (Finding 12 — the original code debited the full credit amount but never
-- credited the matching interest, leaving the agent's balance permanently
-- short by applyToUnposted).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_remediation_remittance(
  p_agent_id uuid,
  p_credit_amount numeric,
  p_unposted_interest_amount numeric,
  p_failed_deal_id uuid,
  p_credit_description text,
  p_created_by uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_balance numeric;
  v_after_interest numeric;
  v_after_credit numeric;
BEGIN
  SELECT COALESCE(account_balance, 0)
    INTO v_old_balance
    FROM public.agents
    WHERE id = p_agent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent % not found', p_agent_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_after_interest := v_old_balance;
  IF p_unposted_interest_amount > 0.005 THEN
    v_after_interest := v_old_balance + p_unposted_interest_amount;
    INSERT INTO public.agent_transactions (
      agent_id, deal_id, type, amount, running_balance, description, created_by
    ) VALUES (
      p_agent_id, p_failed_deal_id, 'failed_deal_interest',
      p_unposted_interest_amount, v_after_interest,
      'Failed-deal interest catch-up at remediation',
      p_created_by
    );
  END IF;

  v_after_credit := v_after_interest - p_credit_amount;
  INSERT INTO public.agent_transactions (
    agent_id, deal_id, type, amount, running_balance, description, created_by
  ) VALUES (
    p_agent_id, p_failed_deal_id, 'credit',
    -p_credit_amount, v_after_credit,
    p_credit_description,
    p_created_by
  );

  UPDATE public.agents
    SET account_balance = v_after_credit,
        updated_at = NOW()
    WHERE id = p_agent_id;

  RETURN json_build_object(
    'old_balance', v_old_balance,
    'interest_posted', CASE WHEN p_unposted_interest_amount > 0.005 THEN p_unposted_interest_amount ELSE 0 END,
    'credit_posted', p_credit_amount,
    'new_balance', v_after_credit
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_remediation_remittance(uuid, numeric, numeric, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_remediation_remittance(uuid, numeric, numeric, uuid, text, uuid) TO service_role;

COMMENT ON FUNCTION apply_remediation_remittance(uuid, numeric, numeric, uuid, text, uuid) IS
  'Atomic remediation remittance: posts unposted-interest catch-up + credit in one transaction. Returns json with old_balance, interest_posted, credit_posted, new_balance.';
