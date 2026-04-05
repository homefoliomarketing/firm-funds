-- Add notification_preferences JSONB column to user_profiles
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{"email_deal_updates": true, "email_new_messages": true, "email_status_changes": true, "email_document_requests": true}'::jsonb;

-- Allow users to read/update their own notification preferences
-- (existing RLS already lets users read their own profile row)
