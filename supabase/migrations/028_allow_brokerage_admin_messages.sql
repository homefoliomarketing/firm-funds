-- ============================================================================
-- Allow brokerage_admin as a sender_role in deal_messages
-- ============================================================================

-- Drop the existing CHECK constraint and replace with one that includes brokerage_admin
ALTER TABLE deal_messages DROP CONSTRAINT IF EXISTS deal_messages_sender_role_check;
ALTER TABLE deal_messages ADD CONSTRAINT deal_messages_sender_role_check
  CHECK (sender_role IN ('admin', 'agent', 'brokerage_admin'));

-- Add RLS policy for brokerage admins to read messages on their brokerage's deals
CREATE POLICY deal_messages_brokerage_read ON deal_messages
  FOR SELECT USING (
    deal_id IN (
      SELECT id FROM deals WHERE brokerage_id IN (
        SELECT brokerage_id FROM user_profiles WHERE id = auth.uid() AND role = 'brokerage_admin'
      )
    )
  );

-- Add RLS policy for brokerage admins to insert messages on their brokerage's deals
CREATE POLICY deal_messages_brokerage_insert ON deal_messages
  FOR INSERT WITH CHECK (
    sender_role = 'brokerage_admin' AND
    deal_id IN (
      SELECT id FROM deals WHERE brokerage_id IN (
        SELECT brokerage_id FROM user_profiles WHERE id = auth.uid() AND role = 'brokerage_admin'
      )
    )
  );
