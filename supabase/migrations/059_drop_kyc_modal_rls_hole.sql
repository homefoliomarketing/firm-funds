-- Migration 059: drop the dangerous agents UPDATE RLS policy from 035
--
-- AUDIT FINDING #9 (CRITICAL): migration 035 added a policy intended to let
-- agents flip a single boolean (kyc_verified_modal_seen). The policy is
-- FOR UPDATE with USING/WITH CHECK only on the row identity; PostgreSQL RLS
-- has no column-level restriction in this form, so any authenticated agent
-- can UPDATE every column of their own agents row from the browser —
-- including bank_account_number, kyc_status, banking_approval_status,
-- outstanding_recovery, flagged_by_brokerage, etc.
--
-- The app already calls a server action (markKycModalSeen in profile-actions)
-- to flip the modal-seen flag via the service-role client, so the RLS policy
-- is unused by app code. Dropping it eliminates the exploit with no
-- functional change.
--
-- Defense in depth: also REVOKE direct UPDATE on agents from the
-- authenticated role so that even if a similar policy is re-introduced by
-- accident, the underlying GRANT is gone. Service role bypasses GRANTs.

DROP POLICY IF EXISTS "agents_can_mark_kyc_modal_seen" ON agents;

REVOKE UPDATE ON agents FROM authenticated;

COMMENT ON COLUMN agents.kyc_verified_modal_seen IS
  'Flipped by the markKycModalSeen server action via service-role client. Authenticated users do NOT have RLS UPDATE on agents — see migration 059.';
