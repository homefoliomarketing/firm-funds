-- Migration 007: Add last_active_at column to user_profiles
-- Used for server-side session timeout tracking (defense-in-depth)
-- Updated periodically by the client via /api/session-heartbeat

ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN user_profiles.last_active_at IS 'Last activity timestamp, updated by session heartbeat. Used for server-side session validation.';

-- Index for quick lookups (e.g. middleware checking stale sessions)
CREATE INDEX IF NOT EXISTS idx_user_profiles_last_active_at
ON user_profiles (last_active_at)
WHERE last_active_at IS NOT NULL;
