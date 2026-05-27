-- ============================================================================
-- Migration 086: Tighten brokerages.email + broker_of_record_email
-- ============================================================================
-- Confirmed via pre-flight (2026-05-27 session):
--   SELECT name, email, broker_of_record_email FROM brokerages
--   WHERE email IS NULL OR broker_of_record_email IS NULL OR email = '' OR broker_of_record_email = '';
--   → 0 rows
--
-- So we can safely add NOT NULL on both columns without backfill.
-- Also add lightweight email-shape CHECK constraints. The regex is
-- intentionally permissive (no RFC-5322 chase) — it just rejects obviously
-- bad values like "homefoliomarketing" or "x@" that would silently fail at
-- send time.
-- ============================================================================

-- 1. NOT NULL on the two contact columns. Pre-flight verified zero null rows.
ALTER TABLE brokerages
  ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN broker_of_record_email SET NOT NULL;

-- 2. Email-shape CHECK on brokerages.email. Required, must look like an email.
ALTER TABLE brokerages
  DROP CONSTRAINT IF EXISTS brokerages_email_format_check;
ALTER TABLE brokerages
  ADD CONSTRAINT brokerages_email_format_check
  CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- 3. Email-shape CHECK on brokerages.broker_of_record_email. NOT NULL above
--    makes the IS NULL guard redundant but leaving it in keeps the constraint
--    forward-compatible if the column ever goes nullable again.
ALTER TABLE brokerages
  DROP CONSTRAINT IF EXISTS brokerages_bor_email_format_check;
ALTER TABLE brokerages
  ADD CONSTRAINT brokerages_bor_email_format_check
  CHECK (broker_of_record_email IS NULL OR broker_of_record_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');

COMMENT ON COLUMN brokerages.email IS
  'Primary contact email for the brokerage. Used for invoices, settlement reminders, firm-deal notifications. NOT NULL + email-shape CHECK (migration 086).';
COMMENT ON COLUMN brokerages.broker_of_record_email IS
  'Broker of Record contact email — receives compliance/regulatory notifications. NOT NULL + email-shape CHECK (migration 086).';
