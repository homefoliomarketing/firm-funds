-- Migration 031: Agent banking self-service submission fields
-- Allows agents to submit their own banking info for admin approval

ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_submitted_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_submitted_transit text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_submitted_institution text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_submitted_account text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_approval_status text DEFAULT 'none';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_rejection_reason text;

ALTER TABLE agents ADD CONSTRAINT agents_banking_approval_status_check
  CHECK (banking_approval_status IN ('none', 'pending', 'approved', 'rejected'));
