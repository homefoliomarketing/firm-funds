-- ============================================================================
-- Migration 083: Optimistic locking + underwriter assignment on deals
-- ============================================================================
-- Two related concerns:
--
-- 1. OPTIMISTIC LOCKING. Multiple admins routinely edit the same deal in
--    parallel (one approves, one updates funding, one writes a note). Today
--    we read-modify-write blindly — the last write wins and silently clobbers
--    the loser's changes. Add a monotonic `version` column auto-incremented
--    on every UPDATE so the app can do `WHERE id = $1 AND version = $expected`
--    and surface a conflict to the user instead of corrupting state.
--
-- 2. UNDERWRITER OWNERSHIP. We're moving to a queue-style underwriting
--    workflow: deals are claimed by an underwriter and worked end-to-end by
--    that person. Add a nullable assigned_to_user_id pointing at auth.users
--    so the queue dashboard can filter "my deals" and we can audit who
--    decided what.
-- ============================================================================

-- 1. Optimistic locking version column.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN deals.version IS
  'Optimistic-lock counter. Auto-incremented by trg_deals_bump_version on every UPDATE. Server actions should pass the version they read and abort on mismatch. See migration 083.';

-- BEFORE-UPDATE trigger that bumps version on every row mutation. Cheap and
-- always safe — even idempotent UPDATEs that change no other columns bump the
-- version, which is exactly what we want for conflict detection.
CREATE OR REPLACE FUNCTION deals_bump_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Don't bump the version if the version column itself was the only change
  -- (e.g. a manual reset). Otherwise increment.
  IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deals_bump_version ON deals;
CREATE TRIGGER trg_deals_bump_version
  BEFORE UPDATE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION deals_bump_version();

COMMENT ON FUNCTION deals_bump_version() IS
  'BEFORE-UPDATE trigger that auto-increments deals.version unless the caller already changed it. See migration 083.';

-- 2. Underwriter assignment.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS assigned_to_user_id UUID REFERENCES auth.users(id);

COMMENT ON COLUMN deals.assigned_to_user_id IS
  'Underwriter who owns this deal in the queue. NULL = unclaimed. References auth.users.id (not user_profiles). See migration 083.';

-- Queue dashboard hot path: SELECT ... WHERE assigned_to_user_id = $me.
CREATE INDEX IF NOT EXISTS idx_deals_assigned_to_user_id
  ON deals(assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;
