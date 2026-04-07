-- Add kyc_verified_modal_seen column to agents table
-- This tracks whether the agent has seen the "Identity Verified" celebration modal
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kyc_verified_modal_seen BOOLEAN DEFAULT FALSE;

-- Allow agents to update ONLY this column on their own record
-- (They need this to dismiss the modal)
CREATE POLICY "agents_can_mark_kyc_modal_seen" ON agents
  FOR UPDATE
  USING (
    id = (SELECT agent_id FROM user_profiles WHERE id = auth.uid())
  )
  WITH CHECK (
    id = (SELECT agent_id FROM user_profiles WHERE id = auth.uid())
  );
