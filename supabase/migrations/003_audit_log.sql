-- =============================================================================
-- Audit Log Table
-- =============================================================================
-- Tracks all significant actions: deal status changes, document operations,
-- admin actions, login events, etc.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,              -- e.g. 'deal.status_change', 'document.upload', 'deal.submit'
  entity_type   TEXT NOT NULL,              -- e.g. 'deal', 'document', 'agent', 'brokerage'
  entity_id     UUID,                       -- ID of the affected entity
  metadata      JSONB DEFAULT '{}',         -- Additional context (old_status, new_status, etc.)
  ip_address    INET,                       -- Request IP (populated by app layer)
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying by entity
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- Index for querying by user
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

-- Index for querying by action
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);

-- =============================================================================
-- RLS Policies: Only admins can read audit logs, only service role can insert
-- =============================================================================

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Admins can read all audit logs
CREATE POLICY "Admins can view audit logs"
  ON audit_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- App inserts via authenticated user (server actions run as the user)
CREATE POLICY "Authenticated users can insert audit logs"
  ON audit_log FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- No updates or deletes — audit logs are immutable
-- (No UPDATE or DELETE policies = no one can modify or remove entries)
