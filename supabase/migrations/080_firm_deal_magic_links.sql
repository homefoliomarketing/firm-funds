-- 080_firm_deal_magic_links.sql
--
-- One-shot login tokens embedded in firm-deal offer email + SMS so the
-- agent does not hit the password wall on a phone they last logged in
-- on weeks ago. The agent clicks the link, the route validates the token,
-- mints a short-lived Supabase magic link for their email, and redirects
-- to /agent/dashboard?firm_deal=<id> already authenticated.
--
-- Lifecycle:
--   - dispatch-notification.ts inserts one row per (firm_deal_event_id,
--     agent_id) when sending the offer; the token is embedded in the
--     URL sent to the agent.
--   - The /agent/firm-deal/[token] route validates expires_at > now()
--     and used_at IS NULL, then atomically marks used_at on consume.
--   - 7-day TTL by default. After that the agent must use /login.
--
-- Why a separate table and not invite_tokens or kyc_upload_tokens:
--   - invite_tokens is tied to the password-reset flow (sets a password,
--     clears must_reset_password). We do not want that side effect here.
--   - kyc_upload_tokens does not sign anyone in; it just unlocks the
--     mobile-upload page.
--   - Firm-deal CTAs need their own thing because they tie a token to a
--     specific firm_deal_event_id so the resulting dashboard load knows
--     which offer to surface.

CREATE TABLE firm_deal_magic_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  firm_deal_event_id UUID NOT NULL REFERENCES firm_deal_events(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_firm_deal_magic_links_token ON firm_deal_magic_links(token);
CREATE INDEX idx_firm_deal_magic_links_event ON firm_deal_magic_links(firm_deal_event_id);
CREATE INDEX idx_firm_deal_magic_links_agent_expiry
  ON firm_deal_magic_links(agent_id, expires_at);

-- Lock the table down. Only the service role (dispatcher + route handler)
-- touches it. Agents never query it directly.
ALTER TABLE firm_deal_magic_links ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE firm_deal_magic_links IS
  'One-shot signed tokens embedded in firm-deal offer CTAs so unauthenticated agents auto-sign-in via Supabase magic link and land on the dashboard with the firm_deal param. 7-day TTL, single-use via used_at CAS.';
COMMENT ON COLUMN firm_deal_magic_links.token IS
  'Random URL-safe identifier (32+ chars). Sent in the email/SMS link.';
COMMENT ON COLUMN firm_deal_magic_links.expires_at IS
  'Absolute UTC expiry. Defaults to now() + 7 days at insert time.';
COMMENT ON COLUMN firm_deal_magic_links.used_at IS
  'Set atomically when the token is consumed. NULL means still valid.';
