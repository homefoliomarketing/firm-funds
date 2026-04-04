-- ============================================================================
-- Migration 006: Invite Tokens for Magic Link Invites
-- ============================================================================
-- Replaces temp passwords with secure, one-time magic link tokens.
-- Tokens are 32 random hex bytes, expire in 72 hours, and can only be used once.
-- ============================================================================

CREATE TABLE IF NOT EXISTS invite_tokens (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens(token);

-- Index for finding tokens by user
CREATE INDEX IF NOT EXISTS idx_invite_tokens_user_id ON invite_tokens(user_id);

-- RLS: only service_role should interact with this table
ALTER TABLE invite_tokens ENABLE ROW LEVEL SECURITY;

-- No public access — all operations go through service_role client
-- (which bypasses RLS anyway, but this prevents accidental anon access)
