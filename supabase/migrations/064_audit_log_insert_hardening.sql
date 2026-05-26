-- Migration 064: harden audit_log INSERT policy
--
-- AUDIT FINDING #22 (MEDIUM): the original INSERT policy from migration 003 is
-- WITH CHECK (auth.uid() IS NOT NULL) — any authenticated session can insert
-- an audit_log row with arbitrary user_id and metadata. A logged-in agent can
-- forge entries claiming an admin approved their deal, polluting the trail.
-- During incident investigation, false events drown the real ones; FINTRAC
-- examiner sees garbage.
--
-- Fix: require user_id to match auth.uid() (or be NULL for system events
-- inserted from service-role-bypassed paths, which are unaffected by RLS).
-- Service role still inserts arbitrary user_id values for backend events.

DROP POLICY IF EXISTS "Authenticated users can insert audit logs" ON audit_log;

CREATE POLICY "Authenticated users insert own audit rows" ON audit_log
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
  );

COMMENT ON TABLE audit_log IS
  'Append-only audit trail. Authenticated INSERTs must set user_id = auth.uid() (migration 064). Backend system events use service role and may set user_id to any value or NULL.';
