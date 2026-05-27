-- ============================================================================
-- Migration 093: remediation_deals.escalation_level for overdue-cron use
-- ============================================================================
-- Companion to app/api/cron/remediation-overdue-escalation. The cron bumps
-- escalation_level each pass (1, 2, 3...) so the digest email can sort by
-- "how many times have we already chased this" and we can stop chasing
-- after some threshold without losing history.
--
-- Starts at 0 for all rows (no escalation). NOT NULL DEFAULT 0 so the cron
-- can blindly UPDATE escalation_level = escalation_level + 1.
-- ============================================================================

ALTER TABLE remediation_deals
  ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN remediation_deals.escalation_level IS
  'Number of times the remediation-overdue-escalation cron has flagged this row in a digest. Auto-incremented each cron pass once the row is past its escalation threshold (idp_signed + >14 days). See migration 093 and app/api/cron/remediation-overdue-escalation.';

CREATE INDEX IF NOT EXISTS idx_remediation_deals_escalation_level
  ON remediation_deals(escalation_level)
  WHERE escalation_level > 0;
