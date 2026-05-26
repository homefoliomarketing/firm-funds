-- Migration 066: atomic late-payment + failed-deal interest RPCs
--
-- AUDIT FINDING #7 (CRITICAL): chargeLatePaymentInterest and
-- autoChargeMonthlyLatePaymentInterest both follow this pattern:
--   1. SELECT late_interest_charged from deal
--   2. Compute interest = totalThroughDate - alreadyCharged
--   3. apply_agent_balance_delta(+interest)
--   4. UPDATE deal SET late_interest_charged = totalInterestOwed
--
-- Two concurrent calls (admin click + cron retry, two parallel cron URLs,
-- etc.) both read alreadyCharged=X, both compute the same delta, both post
-- the delta to the agent's balance, then both write totalInterestOwed. The
-- agent is double-charged. Same problem in autoChargeMonthlyFailedDealInterest
-- for failed-deal interest accrual.
--
-- Fix: move steps 1, 3, and 4 inside a single PL/pgSQL function that takes
-- FOR UPDATE on the deal row. The caller passes the *desired total interest
-- through a date* and the function computes the delta server-side under the
-- lock, so a concurrent caller blocks until the first finishes, then
-- recomputes (delta likely 0) and is a safe no-op.

-- ---------------------------------------------------------------------------
-- apply_late_payment_interest
-- ---------------------------------------------------------------------------
-- Posts the difference between p_total_interest_owed_through and the deal's
-- current late_interest_charged. Returns the posted delta (0 if already
-- up-to-date or higher) plus the new late_interest_charged value.
--
-- The deal row is locked FOR UPDATE so that two concurrent calls serialize:
-- the second observes the first's late_interest_charged update and posts
-- delta=0.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_late_payment_interest(
  p_deal_id uuid,
  p_total_interest_owed_through numeric,
  p_through_date date,
  p_agent_id uuid,
  p_created_by uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_already_charged numeric;
  v_deal_status text;
  v_delta numeric;
  v_new_balance numeric;
  v_old_balance numeric;
BEGIN
  -- Lock the deal row.
  SELECT COALESCE(late_interest_charged, 0), status
    INTO v_already_charged, v_deal_status
    FROM public.deals
    WHERE id = p_deal_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deal % not found', p_deal_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_deal_status NOT IN ('funded', 'completed') THEN
    RAISE EXCEPTION 'Deal % is in status %; late interest can only be charged on funded/completed deals',
      p_deal_id, v_deal_status
      USING ERRCODE = 'check_violation';
  END IF;

  v_delta := GREATEST(0, p_total_interest_owed_through - v_already_charged);

  IF v_delta < 0.01 THEN
    RETURN json_build_object(
      'delta_posted', 0,
      'already_charged', v_already_charged,
      'total_after', v_already_charged,
      'skipped', true
    );
  END IF;

  -- Lock the agent row (same FOR UPDATE pattern apply_agent_balance_delta uses).
  SELECT COALESCE(account_balance, 0)
    INTO v_old_balance
    FROM public.agents
    WHERE id = p_agent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent % not found', p_agent_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_new_balance := v_old_balance + v_delta;

  UPDATE public.agents
    SET account_balance = v_new_balance,
        updated_at = NOW()
    WHERE id = p_agent_id;

  INSERT INTO public.agent_transactions (
    agent_id, deal_id, type, amount, running_balance, description, created_by
  ) VALUES (
    p_agent_id, p_deal_id, 'late_payment_interest',
    v_delta, v_new_balance,
    'Late-payment interest accrual through ' || p_through_date::text,
    p_created_by
  );

  UPDATE public.deals
    SET late_interest_charged = p_total_interest_owed_through,
        updated_at = NOW()
    WHERE id = p_deal_id;

  RETURN json_build_object(
    'delta_posted', v_delta,
    'already_charged', v_already_charged,
    'total_after', p_total_interest_owed_through,
    'skipped', false
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_late_payment_interest(uuid, numeric, date, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_late_payment_interest(uuid, numeric, date, uuid, uuid) TO service_role;

COMMENT ON FUNCTION apply_late_payment_interest(uuid, numeric, date, uuid, uuid) IS
  'Atomic late-payment interest accrual. Locks the deal + agent, posts only the missing delta, updates late_interest_charged. Concurrent callers serialize and the second one is a no-op.';

-- ---------------------------------------------------------------------------
-- apply_failed_deal_interest
-- ---------------------------------------------------------------------------
-- Same shape as above but for failed-deal interest (failed_deal_interest_charged column).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_failed_deal_interest(
  p_deal_id uuid,
  p_total_interest_owed_through numeric,
  p_through_date date,
  p_agent_id uuid,
  p_created_by uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_already_charged numeric;
  v_deal_status text;
  v_delta numeric;
  v_new_balance numeric;
  v_old_balance numeric;
BEGIN
  SELECT COALESCE(failed_deal_interest_charged, 0), status
    INTO v_already_charged, v_deal_status
    FROM public.deals
    WHERE id = p_deal_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deal % not found', p_deal_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_deal_status NOT IN ('failed_to_close', 'cured') THEN
    RAISE EXCEPTION 'Deal % is in status %; failed-deal interest can only be charged on failed/cured deals',
      p_deal_id, v_deal_status
      USING ERRCODE = 'check_violation';
  END IF;

  v_delta := GREATEST(0, p_total_interest_owed_through - v_already_charged);

  IF v_delta < 0.01 THEN
    RETURN json_build_object(
      'delta_posted', 0,
      'already_charged', v_already_charged,
      'total_after', v_already_charged,
      'skipped', true
    );
  END IF;

  SELECT COALESCE(account_balance, 0)
    INTO v_old_balance
    FROM public.agents
    WHERE id = p_agent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent % not found', p_agent_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_new_balance := v_old_balance + v_delta;

  UPDATE public.agents
    SET account_balance = v_new_balance,
        updated_at = NOW()
    WHERE id = p_agent_id;

  INSERT INTO public.agent_transactions (
    agent_id, deal_id, type, amount, running_balance, description, created_by
  ) VALUES (
    p_agent_id, p_deal_id, 'failed_deal_interest',
    v_delta, v_new_balance,
    'Failed-deal interest accrual through ' || p_through_date::text,
    p_created_by
  );

  UPDATE public.deals
    SET failed_deal_interest_charged = p_total_interest_owed_through,
        updated_at = NOW()
    WHERE id = p_deal_id;

  RETURN json_build_object(
    'delta_posted', v_delta,
    'already_charged', v_already_charged,
    'total_after', p_total_interest_owed_through,
    'skipped', false
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_failed_deal_interest(uuid, numeric, date, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_failed_deal_interest(uuid, numeric, date, uuid, uuid) TO service_role;

COMMENT ON FUNCTION apply_failed_deal_interest(uuid, numeric, date, uuid, uuid) IS
  'Atomic failed-deal interest accrual. Locks the deal + agent, posts only the missing delta, updates failed_deal_interest_charged.';
