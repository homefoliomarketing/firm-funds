-- ============================================================================
-- Migration 013: KYC mobile upload tokens
-- ============================================================================
-- Allows agents on desktop to send a secure one-time link to their phone
-- for uploading government photo ID (camera capture).
-- ============================================================================

CREATE TABLE IF NOT EXISTS kyc_upload_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz DEFAULT NULL,
  created_at timestamptz DEFAULT now()
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_kyc_upload_tokens_token ON kyc_upload_tokens(token);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_kyc_upload_tokens_expires ON kyc_upload_tokens(expires_at);
