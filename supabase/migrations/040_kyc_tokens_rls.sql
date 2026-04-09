-- ============================================================================
-- Migration 040: Enable RLS on kyc_upload_tokens
-- ============================================================================
-- This table was created without RLS, exposing tokens via the public API.
-- Supabase flagged it as a critical security issue on 2026-04-07.
-- ============================================================================

ALTER TABLE public.kyc_upload_tokens ENABLE ROW LEVEL SECURITY;

-- Admins can manage all tokens
CREATE POLICY kyc_tokens_admin_all ON kyc_upload_tokens
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- Agents can read their own tokens (needed for mobile KYC upload flow)
CREATE POLICY kyc_tokens_agent_read ON kyc_upload_tokens
  FOR SELECT USING (
    agent_id IN (
      SELECT agent_id FROM user_profiles WHERE id = auth.uid() AND role = 'agent'
    )
  );
