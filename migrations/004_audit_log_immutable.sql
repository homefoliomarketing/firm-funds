-- =============================================================================
-- Migration 004: Make audit_log table immutable (H8 security fix)
--
-- Prevents UPDATE and DELETE on audit_log for ALL roles except service_role.
-- This ensures audit trails cannot be tampered with, even by authenticated
-- admins who gain direct DB access. FINTRAC requires tamper-proof records.
--
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- =============================================================================

-- Step 1: Enable RLS on audit_log (if not already enabled)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Step 2: Drop any existing permissive policies that allow UPDATE/DELETE
-- (Safe to run even if they don't exist — wrapped in DO block)
DO $$
BEGIN
  -- Drop all existing policies on audit_log to start clean
  DROP POLICY IF EXISTS "Allow insert for authenticated users" ON audit_log;
  DROP POLICY IF EXISTS "Allow insert for service role" ON audit_log;
  DROP POLICY IF EXISTS "Allow select for admins" ON audit_log;
  DROP POLICY IF EXISTS "Allow all for service role" ON audit_log;
  DROP POLICY IF EXISTS "audit_log_insert" ON audit_log;
  DROP POLICY IF EXISTS "audit_log_select" ON audit_log;
  DROP POLICY IF EXISTS "audit_log_update" ON audit_log;
  DROP POLICY IF EXISTS "audit_log_delete" ON audit_log;
END
$$;

-- Step 3: Create restrictive policies

-- INSERT: Only allow inserts (server actions use service_role which bypasses RLS,
-- but this also allows authenticated users' server actions to insert via RLS)
CREATE POLICY "audit_log_insert_only"
  ON audit_log
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- SELECT: Only admins can read audit logs
CREATE POLICY "audit_log_select_admins"
  ON audit_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- NO UPDATE policy = updates are denied for all authenticated users
-- NO DELETE policy = deletes are denied for all authenticated users
-- service_role bypasses RLS entirely, so server-side operations still work

-- Step 4: Add a database-level trigger to prevent DELETE even via service_role
-- This is belt-and-suspenders: even if someone uses the service role key directly
CREATE OR REPLACE FUNCTION prevent_audit_log_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log records cannot be deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_audit_log_delete ON audit_log;
CREATE TRIGGER no_audit_log_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_delete();

-- Step 5: Prevent UPDATE on audit_log via trigger
CREATE OR REPLACE FUNCTION prevent_audit_log_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log records cannot be modified';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_audit_log_update ON audit_log;
CREATE TRIGGER no_audit_log_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_update();

-- =============================================================================
-- VERIFY: After running, test with:
--   INSERT INTO audit_log (action, entity_type) VALUES ('test', 'test'); -- Should work
--   UPDATE audit_log SET action = 'hacked' WHERE id = (SELECT id FROM audit_log LIMIT 1); -- Should fail
--   DELETE FROM audit_log WHERE id = (SELECT id FROM audit_log LIMIT 1); -- Should fail
-- =============================================================================
