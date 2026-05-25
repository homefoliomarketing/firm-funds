-- Migration 076: brokerage contact_email confirmation token
--
-- Audit finding #40 follow-up. Previously updateBrokerageContactEmail in
-- lib/actions/settings-actions.ts flipped brokerages.contact_email immediately
-- on the admin's request, then notified the OLD address. A stolen brokerage
-- admin session could silently redirect ALL brokerage notifications (deal
-- status, invoices, settlement reminders, KYC requests) to an attacker-owned
-- inbox; the legitimate admin would see the notification but only AFTER the
-- redirect was already in place.
--
-- New flow: write the requested address to pending_contact_email + a hash of
-- a single-use confirmation token + an expiry. Send the raw token only to
-- the NEW address. Only when the recipient of the new address clicks the
-- confirmation link does contact_email actually flip. The notification to
-- the OLD address ("change requested by ...") still fires immediately so
-- the legitimate owner gets early warning even before the new address acts.
--
-- Token storage uses sha256(token) so a read-only leak of brokerages
-- (or a backup) does not grant the ability to confirm pending changes.

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS pending_contact_email          text,
  ADD COLUMN IF NOT EXISTS pending_contact_email_token_hash text,
  ADD COLUMN IF NOT EXISTS pending_contact_email_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_contact_email_expires_at   timestamptz;

-- Lookup is by hash, not by brokerage id, so the route doesn't need to know
-- which brokerage the click is for. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS brokerages_pending_contact_email_token_hash_idx
  ON brokerages (pending_contact_email_token_hash)
  WHERE pending_contact_email_token_hash IS NOT NULL;

COMMENT ON COLUMN brokerages.pending_contact_email IS
  'Unverified new contact_email pending confirmation. Wiped on confirm or expiry.';
COMMENT ON COLUMN brokerages.pending_contact_email_token_hash IS
  'sha256 hex of the single-use confirmation token sent to pending_contact_email. Raw token never stored.';
