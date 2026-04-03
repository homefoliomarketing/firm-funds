-- ============================================================================
-- Migration 008: Audit Fix Improvements
-- Run this in Supabase SQL Editor
-- ============================================================================

-- 1. Add repayment_amount column to deals (Step 4: Repayment Tracking)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS repayment_amount NUMERIC(12,2) DEFAULT NULL;

-- 2. Add admin_notes_timeline JSONB column to deals (Step 8: Notes Timeline)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS admin_notes_timeline JSONB DEFAULT '[]'::jsonb;

-- 3. Create brokerage_documents table (Step 5: Brokerage Document Storage)
CREATE TABLE IF NOT EXISTS brokerage_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES auth.users(id),
  document_type TEXT NOT NULL CHECK (document_type IN (
    'cooperation_agreement', 'white_label_agreement', 'banking_info', 'kyc_business', 'other'
  )),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups by brokerage
CREATE INDEX IF NOT EXISTS idx_brokerage_documents_brokerage_id
  ON brokerage_documents(brokerage_id);

-- RLS policies for brokerage_documents
ALTER TABLE brokerage_documents ENABLE ROW LEVEL SECURITY;

-- Super admins and firm funds admins can do everything
CREATE POLICY "Admins full access on brokerage_documents"
  ON brokerage_documents
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- Brokerage admins can view their own brokerage's documents
CREATE POLICY "Brokerage admins view own docs"
  ON brokerage_documents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'brokerage_admin'
      AND user_profiles.brokerage_id = brokerage_documents.brokerage_id
    )
  );

-- 4. Add storage policy for brokerage documents path in deal-documents bucket
-- (Brokerage docs are stored under brokerages/{id}/ in the existing bucket)
-- Note: If you need to add a storage policy, do it via Supabase Dashboard > Storage > Policies

-- ============================================================================
-- Verification queries (run these after the migration to confirm)
-- ============================================================================
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'deals' AND column_name IN ('repayment_amount', 'admin_notes_timeline');
-- SELECT * FROM information_schema.tables WHERE table_name = 'brokerage_documents';
