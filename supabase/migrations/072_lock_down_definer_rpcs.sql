-- Migration 072: explicitly revoke EXECUTE on SECURITY DEFINER RPCs from anon + authenticated
--
-- AUDIT FINDING (NEW — verified live 2026-05-24): Supabase's default schema-level
-- privileges grant EXECUTE on every function created in `public` to BOTH `anon`
-- and `authenticated`. The `REVOKE ALL ... FROM PUBLIC` in migrations 052/066/069
-- only removes the PUBLIC pseudo-role grant; the direct grants to `anon` and
-- `authenticated` remain.
--
-- Live probe (scripts/verify-rpc-exploit2.mjs) confirmed an authenticated
-- session can call `apply_agent_balance_delta(any_agent_id, +1000, 'credit', ...)`
-- to credit themselves arbitrary money. Same exposure on the other RPCs:
--   - delete_brokerage_atomic: nuke any brokerage
--   - apply_remediation_remittance: forge remediation credits
--   - apply_late_payment_interest / apply_failed_deal_interest: charge any deal
--   - record_brokerage_late_strike: penalize any brokerage
--
-- Fix: explicitly REVOKE from each role. Also ALTER DEFAULT PRIVILEGES so any
-- future functions created in `public` by the postgres role default to no-grant
-- on anon/authenticated; callers must use the service-role client.

REVOKE EXECUTE ON FUNCTION apply_agent_balance_delta(uuid, numeric, text, text, uuid, uuid, text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_late_payment_interest(uuid, numeric, date, uuid, uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_failed_deal_interest(uuid, numeric, date, uuid, uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_remediation_remittance(uuid, numeric, numeric, uuid, text, uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION record_brokerage_late_strike(uuid, int) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_brokerage_atomic(uuid) FROM anon, authenticated, PUBLIC;

-- Default-privilege block for FUTURE functions created in public schema.
-- This applies to functions created BY the postgres role going forward.
-- (Existing functions are covered by the explicit REVOKEs above.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, PUBLIC;

COMMENT ON FUNCTION apply_agent_balance_delta(uuid, numeric, text, text, uuid, uuid, text) IS
  'service-role only. Authenticated/anon REVOKEd in migration 072. Callers must use createServiceRoleClient().';
COMMENT ON FUNCTION apply_late_payment_interest(uuid, numeric, date, uuid, uuid) IS
  'service-role only. Authenticated/anon REVOKEd in migration 072. Callers must use createServiceRoleClient().';
COMMENT ON FUNCTION apply_failed_deal_interest(uuid, numeric, date, uuid, uuid) IS
  'service-role only. Authenticated/anon REVOKEd in migration 072. Callers must use createServiceRoleClient().';
COMMENT ON FUNCTION apply_remediation_remittance(uuid, numeric, numeric, uuid, text, uuid) IS
  'service-role only. Authenticated/anon REVOKEd in migration 072. Callers must use createServiceRoleClient().';
COMMENT ON FUNCTION record_brokerage_late_strike(uuid, int) IS
  'service-role only. Authenticated/anon REVOKEd in migration 072. Callers must use createServiceRoleClient().';
COMMENT ON FUNCTION delete_brokerage_atomic(uuid) IS
  'service-role only. Authenticated/anon REVOKEd in migration 072. Callers must use createServiceRoleClient().';
