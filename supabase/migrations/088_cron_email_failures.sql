-- ============================================================================
-- Migration 088: cron_email_failures dead-letter queue
-- ============================================================================
-- Email sends inside cron handlers (settlement reminders, offer decline
-- notifications, monthly statements, etc.) currently fail silently when
-- Resend/Mailgun blip. The handler logs to cron_run_log.details.failures
-- and the email is lost forever — no retry, no operator visibility past
-- the next overnight run.
--
-- Fix: capture every failed send into a dedicated table with enough payload
-- to re-execute, and run a retry cron (see app/api/cron/retry-failed-emails)
-- on a 15-minute cadence with exponential backoff via attempt_count.
--
-- A row's lifecycle:
--   insert            attempt_count=1, last_attempted_at=now()
--   retry success     succeeded_at set, gave_up_at NULL
--   retry repeated    attempt_count++, last_attempted_at refreshed
--   permanent fail    gave_up_at set after 5 attempts (configurable in cron)
-- ============================================================================

CREATE TABLE IF NOT EXISTS cron_email_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_job TEXT NOT NULL,                          -- e.g. 'closing-date-alerts'
  email_type TEXT NOT NULL,                        -- e.g. 'settlement_reminder'
  recipient TEXT NOT NULL,
  subject TEXT,
  payload JSONB,                                   -- full context for retry
  error TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  succeeded_at TIMESTAMPTZ,
  gave_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The retry cron's hot path: WHERE succeeded_at IS NULL AND gave_up_at IS
-- NULL AND last_attempted_at < NOW() - INTERVAL '15 minutes'. Partial index
-- keeps it tiny (only "still in retry" rows ever populate it).
CREATE INDEX IF NOT EXISTS idx_cron_email_failures_retryable
  ON cron_email_failures(last_attempted_at)
  WHERE succeeded_at IS NULL AND gave_up_at IS NULL;

-- Admin dashboard / ops queries — "show me every email that has permanently
-- failed since X". Cheap because gave_up_at is sparse.
CREATE INDEX IF NOT EXISTS idx_cron_email_failures_gave_up
  ON cron_email_failures(gave_up_at)
  WHERE gave_up_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cron_email_failures_succeeded
  ON cron_email_failures(succeeded_at)
  WHERE succeeded_at IS NOT NULL;

ALTER TABLE cron_email_failures ENABLE ROW LEVEL SECURITY;
-- No policies → only service role can read/write. Operators query via
-- service-role admin tools, not the portal.

COMMENT ON TABLE cron_email_failures IS
  'Dead-letter queue for cron email sends. Inserted by every cron handler that catches an email send failure; drained by /api/cron/retry-failed-emails on a 15-min cadence. Service-role only. See migration 088.';

COMMENT ON COLUMN cron_email_failures.payload IS
  'JSONB blob containing the full email function call context. Retry handler must look up by email_type and re-invoke the matching sender. New email_types require adding a case in the retry cron.';

COMMENT ON COLUMN cron_email_failures.gave_up_at IS
  'Set when the retry cron exhausts attempt_count (default 5). After this, an operator must intervene — the row stays for audit but no further retries fire.';
