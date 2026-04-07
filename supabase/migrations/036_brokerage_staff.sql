-- Add staff_title to user_profiles for brokerage staff roles
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS staff_title TEXT;
