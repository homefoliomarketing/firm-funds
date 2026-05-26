-- Migration 074: cron-run idempotency log
--
-- AUDIT FINDING (session 12 follow-up): cron endpoints
-- /api/cron/closing-date-alerts and /api/cron/monthly-broker-statements have
-- no idempotency. If Netlify retries on a transient 5xx (or someone with
-- CRON_SECRET manually re-fires), emails re-send and the period-based
-- statement endpoint can re-bill any past month. The monthly-statements
-- handler explicitly admits this in a comment.
--
-- Fix: a (job_name, period) keyed log. Each cron handler INSERTs first;
-- if the row already exists for today's period, the handler returns
-- 200 { already_ran: true } without doing work.

CREATE TABLE IF NOT EXISTS cron_run_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  period TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  outcome TEXT,
  details JSONB,
  CONSTRAINT cron_run_log_job_period_unique UNIQUE (job_name, period)
);

CREATE INDEX IF NOT EXISTS cron_run_log_started_at_idx
  ON cron_run_log(started_at);

ALTER TABLE cron_run_log ENABLE ROW LEVEL SECURITY;

-- Admin-only SELECT (debugging cron behaviour). INSERT/UPDATE happen via
-- service-role inside the cron handlers.
CREATE POLICY cron_run_log_admin_select ON cron_run_log
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

COMMENT ON TABLE cron_run_log IS
  'Idempotency log for cron jobs. Each handler INSERTs (job_name, period) at start; on 23505 the run has already happened. See migration 074 and app/api/cron/*/route.ts.';
