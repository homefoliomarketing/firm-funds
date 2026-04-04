-- =============================================================================
-- Migration 005: Enhance audit_log for full event ledger
--
-- Adds: severity, actor_email, actor_role, old_value, new_value,
--        user_agent, session_id columns
-- Adds: composite + partial + GIN indexes for audit explorer queries
--
-- SAFE: ALTER TABLE ADD COLUMN works even with immutability triggers
-- (triggers only prevent UPDATE/DELETE on rows, not schema changes)
--
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- =============================================================================

-- Step 1: Add new columns
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'info';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_email TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_role TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS old_value JSONB;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS new_value JSONB;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Step 2: Add CHECK constraint on severity
ALTER TABLE audit_log ADD CONSTRAINT audit_log_severity_check
  CHECK (severity IN ('info', 'warning', 'critical'));

-- Step 3: New indexes for audit explorer queries

-- Composite index for deal timeline: "show all events for entity X, newest first"
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_time
  ON audit_log(entity_type, entity_id, created_at DESC);

-- Partial index for critical events (compliance queries)
CREATE INDEX IF NOT EXISTS idx_audit_log_critical
  ON audit_log(created_at DESC) WHERE severity = 'critical';

-- Index on actor_email for "show everything this person did"
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_email
  ON audit_log(actor_email, created_at DESC);

-- GIN index on metadata for JSONB searching
CREATE INDEX IF NOT EXISTS idx_audit_log_metadata_gin
  ON audit_log USING GIN (metadata);

-- GIN index on old_value and new_value for change tracking searches
CREATE INDEX IF NOT EXISTS idx_audit_log_old_value_gin
  ON audit_log USING GIN (old_value) WHERE old_value IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_new_value_gin
  ON audit_log USING GIN (new_value) WHERE new_value IS NOT NULL;

-- Index on severity for filtered queries
CREATE INDEX IF NOT EXISTS idx_audit_log_severity
  ON audit_log(severity, created_at DESC);

-- Step 4: Update the SELECT RLS policy to also allow brokerage_admin
-- (they should see audit entries for their own brokerage's deals/agents)
DROP POLICY IF EXISTS "audit_log_select_admins" ON audit_log;

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

-- =============================================================================
-- VERIFY: After running, check columns exist:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'audit_log' ORDER BY ordinal_position;
-- =============================================================================
