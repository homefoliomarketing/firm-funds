-- ============================================================================
-- Migration 082: Per-pipe firm-deal offer notification recipients
-- ============================================================================
-- When an agent accepts a firm-deal offer, the brokerage admin team gets an
-- email. Until now the recipient list was hard-coded to:
--   - brokerages.email              (always)
--   - FIRM_FUNDS_OFFER_INBOX env    (always)
--
-- Some brokerages will want the Broker of Record CC'd, or extra office-admin
-- emails copied (the person who actually does submissions isn't always the
-- one whose email is on brokerages.email). Migration 081 left this for a
-- follow-up; this is the follow-up.
--
-- Storage shape: a JSONB blob on brokerage_pipes (it varies with the pipe
-- and is the natural home alongside brand_name + auto_fire_enabled):
--   {
--     "include_broker_of_record": false,
--     "extra_emails": ["jane@brokerage.com", "office@brokerage.com"]
--   }
--
-- The two always-included recipients (brokerages.email + FF inbox) are still
-- computed in code, not stored here, so they can't accidentally be removed
-- by a misclick. extra_emails is the only free-form list — kept short via a
-- length cap that the server action enforces (we don't trust JSONB depth
-- alone to keep the row small).
-- ============================================================================

ALTER TABLE brokerage_pipes
  ADD COLUMN IF NOT EXISTS notification_recipients JSONB NOT NULL
    DEFAULT '{"include_broker_of_record": false, "extra_emails": []}'::jsonb;

COMMENT ON COLUMN brokerage_pipes.notification_recipients IS
  'Per-pipe firm-deal offer notification config. Shape: { include_broker_of_record: bool, extra_emails: string[] }. brokerages.email and FIRM_FUNDS_OFFER_INBOX are always included by the dispatcher and not stored here.';

-- Backfill: any existing pipes get the default. The ADD COLUMN ... DEFAULT
-- already applied that, but make it explicit so future migrations can rely
-- on every row having a non-null value.
UPDATE brokerage_pipes
SET notification_recipients = '{"include_broker_of_record": false, "extra_emails": []}'::jsonb
WHERE notification_recipients IS NULL;
