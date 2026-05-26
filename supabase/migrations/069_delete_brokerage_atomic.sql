-- Migration 069: atomic brokerage permanent-delete RPC
--
-- AUDIT FINDING #17 (HIGH): permanentlyDeleteBrokerage performs 8 sequential
-- DELETE/UPDATE statements with no rollback. A partial failure (network drop,
-- statement timeout, RLS trip, FK violation on a stale row) leaves the system
-- corrupt: brokerage gone but agents orphaned, user_profiles still pointing
-- at vanished agents, esignature_envelopes leaked, etc.
--
-- Fix: wrap every SQL-side mutation in a single PL/pgSQL function. Postgres
-- treats the function body as one implicit transaction: either every row is
-- removed or none of them are. auth.users live outside Postgres and stay in
-- the JS caller as best-effort cleanup after this function returns.
--
-- Order is significant because some FKs are NO ACTION (not CASCADE):
--   1. user_profiles for this brokerage's agents (agent FK)
--   2. agents (brokerage FK)
--   3. user_profiles for this brokerage (brokerage FK)
--   4. esignature_envelopes (brokerage FK)
--   5. invite_tokens by email of any profiles we removed
--   6. brokerages (the row itself)

CREATE OR REPLACE FUNCTION delete_brokerage_atomic(p_brokerage_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_agent_ids uuid[];
  v_profile_emails text[];
BEGIN
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_agent_ids
    FROM public.agents
    WHERE brokerage_id = p_brokerage_id;

  SELECT COALESCE(array_agg(email), ARRAY[]::text[])
    INTO v_profile_emails
    FROM public.user_profiles
    WHERE (brokerage_id = p_brokerage_id OR agent_id = ANY(v_agent_ids))
      AND email IS NOT NULL;

  -- 1. profiles linked to agents under this brokerage
  IF array_length(v_agent_ids, 1) IS NOT NULL THEN
    DELETE FROM public.user_profiles WHERE agent_id = ANY(v_agent_ids);
  END IF;

  -- 2. the agents themselves
  DELETE FROM public.agents WHERE brokerage_id = p_brokerage_id;

  -- 3. any remaining profiles attached at the brokerage level (admins, etc.)
  DELETE FROM public.user_profiles WHERE brokerage_id = p_brokerage_id;

  -- 4. envelopes (belt + suspenders with CASCADE)
  DELETE FROM public.esignature_envelopes WHERE brokerage_id = p_brokerage_id;

  -- 5. pending invites for emails we just removed
  IF array_length(v_profile_emails, 1) IS NOT NULL THEN
    DELETE FROM public.invite_tokens WHERE email = ANY(v_profile_emails);
  END IF;

  -- 6. the brokerage row
  DELETE FROM public.brokerages WHERE id = p_brokerage_id;
END;
$$;

REVOKE ALL ON FUNCTION delete_brokerage_atomic(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_brokerage_atomic(uuid) TO service_role;

COMMENT ON FUNCTION delete_brokerage_atomic(uuid) IS
  'Atomic permanent delete of a brokerage and all SQL-side children. Caller must separately purge auth.users afterward. Either every row goes or none do, no half-delete state.';
