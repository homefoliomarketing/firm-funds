-- Migration 019: Agent message read tracking for notifications
-- Tracks when agents last viewed messages for each deal

CREATE TABLE IF NOT EXISTS agent_message_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, deal_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_message_reads_agent ON agent_message_reads(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_message_reads_deal ON agent_message_reads(deal_id);

ALTER TABLE agent_message_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view own read status"
  ON agent_message_reads FOR SELECT
  USING (agent_id IN (
    SELECT agent_id FROM user_profiles WHERE id = auth.uid()
  ));

CREATE POLICY "Agents can upsert own read status"
  ON agent_message_reads FOR INSERT
  WITH CHECK (agent_id IN (
    SELECT agent_id FROM user_profiles WHERE id = auth.uid()
  ));

CREATE POLICY "Agents can update own read status"
  ON agent_message_reads FOR UPDATE
  USING (agent_id IN (
    SELECT agent_id FROM user_profiles WHERE id = auth.uid()
  ));

CREATE POLICY "Admins can view all read status"
  ON agent_message_reads FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('firm_funds_admin', 'super_admin')
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'deal_messages' AND column_name = 'sender_name'
  ) THEN
    ALTER TABLE deal_messages ADD COLUMN sender_name TEXT;
  END IF;
END $$;
