-- ============================================================================
-- Migration 092: Unsubscribe preferences + signed token table
-- ============================================================================
-- CASL/CAN-SPAM compliance requires a one-click unsubscribe path on every
-- transactional notification (settlement reminders, monthly statements,
-- firm-deal offers...). Two pieces:
--
-- 1. PREFERENCE FLAG. agents.email_notifications_enabled and
--    brokerages.email_notifications_enabled, both NOT NULL DEFAULT true.
--    Email-send code (lib/email.ts) checks this before sending. Default
--    true preserves existing behaviour.
--
-- 2. SIGNED TOKEN TABLE. Each outbound email embeds a one-shot or
--    deterministic token that maps back to (entity_type, entity_id). The
--    unsubscribe endpoint flips the flag and confirms in plaintext — no
--    login required.
-- ============================================================================

-- 1. Preference flags on the two notification subjects.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN agents.email_notifications_enabled IS
  'Master kill-switch for outbound emails to this agent. Toggled via /api/unsubscribe?token=... See migration 092.';

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN brokerages.email_notifications_enabled IS
  'Master kill-switch for outbound emails to this brokerage''s primary email. Operational/legal emails (BoR, KYC) bypass this. See migration 092.';

-- 2. Token table.
CREATE TABLE IF NOT EXISTS email_unsubscribe_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('agent', 'brokerage')),
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_unsubscribe_tokens_entity
  ON email_unsubscribe_tokens(entity_type, entity_id);

ALTER TABLE email_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
-- No policies → service role only (token mint + redemption happen in
-- service-role API routes).

COMMENT ON TABLE email_unsubscribe_tokens IS
  'Signed unsubscribe tokens. Service-role only — minted by lib/email.ts when sending an unsub-eligible email, redeemed by the /api/unsubscribe route which flips the corresponding entity''s email_notifications_enabled. See migration 092.';
