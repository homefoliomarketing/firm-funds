-- Migration 015: Add must_reset_password flag to user_profiles
-- Forces users to change their password on first login after invite

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS must_reset_password boolean NOT NULL DEFAULT false;

-- Set existing invited agents to false (they've already been using the system)
-- New invites going forward will set this to true
