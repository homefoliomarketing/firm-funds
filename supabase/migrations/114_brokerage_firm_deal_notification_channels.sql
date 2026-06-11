-- ============================================================================
-- Migration 114: Per-brokerage firm-deal notification channel toggles
-- ============================================================================
-- Lets each brokerage independently turn the EMAIL and TEXT (SMS) channels for
-- firm-deal notifications on or off (e.g. "send me the emails but no texts").
-- Two flags, both NOT NULL DEFAULT true so existing behaviour is preserved:
-- today every brokerage's agents get the offer email + SMS, and the brokerage
-- gets the submission-reminder emails.
--
-- What each flag gates (see lib/firm-deal-detection/dispatch-notification.ts
-- and lib/firm-deal-detection/dispatch-brokerage-offer.ts):
--   firm_deal_email_enabled = false -> suppress ALL firm-deal EMAILS tied to
--       this brokerage: the agent offer email, the brokerage submit-reminder +
--       2h nudge, and the agent decline notice. Does NOT suppress the 4h
--       INTERNAL Firm Funds escalation -- that is our own ops alert and must
--       always fire so a stalled deal still reaches us.
--   firm_deal_sms_enabled = false   -> suppress firm-deal TEXT (Twilio SMS)
--       offers to this brokerage's agents.
--
-- These are SEPARATE from brokerages.email_notifications_enabled (migration
-- 092), which is the master email kill-switch the firm-deal dispatchers do not
-- consult. This pair is the firm-deal-specific control surfaced on the admin
-- firm-deal pipe settings page.
-- ============================================================================

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS firm_deal_email_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS firm_deal_sms_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN brokerages.firm_deal_email_enabled IS
  'When false, suppress firm-deal EMAIL notifications for this brokerage (agent offer email + brokerage submit-reminder/2h-nudge + agent decline notice). The 4h internal Firm Funds escalation is NOT gated. Default true. See migration 114.';

COMMENT ON COLUMN brokerages.firm_deal_sms_enabled IS
  'When false, suppress firm-deal TEXT/SMS offers to this brokerage''s agents (Twilio). Default true. See migration 114.';
