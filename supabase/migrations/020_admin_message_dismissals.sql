-- Migration 020: Admin message dismissals
-- Allows admins to dismiss/acknowledge agent messages without replying.
-- If the agent sends a NEW message after dismissal, the notification returns.

CREATE TABLE IF NOT EXISTS admin_message_dismissals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(admin_id, deal_id)
);

-- RLS
ALTER TABLE admin_message_dismissals ENABLE ROW LEVEL SECURITY;

-- Admins can read/upsert their own dismissals
CREATE POLICY "Admins can view own dismissals"
  ON admin_message_dismissals FOR SELECT
  USING (admin_id = auth.uid());

CREATE POLICY "Admins can insert own dismissals"
  ON admin_message_dismissals FOR INSERT
  WITH CHECK (admin_id = auth.uid());

CREATE POLICY "Admins can update own dismissals"
  ON admin_message_dismissals FOR UPDATE
  USING (admin_id = auth.uid());

CREATE POLICY "Admins can delete own dismissals"
  ON admin_message_dismissals FOR DELETE
  USING (admin_id = auth.uid());
