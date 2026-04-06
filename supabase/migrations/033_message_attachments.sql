-- Migration 033: Message file attachments
-- Allows files to be sent alongside messages in deal conversations

ALTER TABLE deal_messages ADD COLUMN IF NOT EXISTS file_path text;
ALTER TABLE deal_messages ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE deal_messages ADD COLUMN IF NOT EXISTS file_size integer;
ALTER TABLE deal_messages ADD COLUMN IF NOT EXISTS file_type text;
