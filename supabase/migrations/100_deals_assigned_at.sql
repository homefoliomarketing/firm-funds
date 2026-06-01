-- =============================================================================
-- 100_deals_assigned_at.sql
-- =============================================================================
-- Adds a dedicated deals.assigned_at column to track WHEN an underwriter was
-- assigned. Previously getOverdueAssignments() approximated this with
-- updated_at, so any unrelated edit reset the "how long has this been sitting"
-- clock and could hide a genuinely stale deal. assignDealToUnderwriter() now
-- stamps this column on assign and clears it on unassign.
-- =============================================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

COMMENT ON COLUMN deals.assigned_at IS
  'Timestamp the deal was assigned to an underwriter (set when assigned_to_user_id is set, NULL when unassigned). Used for overdue-assignment tracking instead of updated_at.';

-- Best-effort backfill for any deal already assigned at migration time: use
-- updated_at as the starting point. (Verified 0 assigned deals at apply time,
-- so this is effectively a no-op, but it keeps the migration correct if re-run
-- against an environment that does have assignments.)
UPDATE deals
   SET assigned_at = updated_at
 WHERE assigned_to_user_id IS NOT NULL
   AND assigned_at IS NULL;
