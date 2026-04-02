-- Add admin_notes column to deals table for internal underwriting/admin notes
ALTER TABLE deals ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT NULL;

-- Allow admins to update admin_notes
COMMENT ON COLUMN deals.admin_notes IS 'Internal admin/underwriter notes, not visible to agents or brokerage admins';
