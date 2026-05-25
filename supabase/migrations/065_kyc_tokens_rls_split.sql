-- Migration 065: split kyc_upload_tokens admin FOR ALL into SELECT + INSERT
--
-- AUDIT FINDING #25 (MEDIUM): migration 040 added a FOR ALL admin policy on
-- kyc_upload_tokens granting INSERT/SELECT/UPDATE/DELETE. The app only reads
-- and inserts via the user-scoped client (UPDATE/DELETE happens via the
-- service role inside upload routes). A compromised admin session could
-- DELETE all pending KYC tokens, blocking onboarding for the entire
-- pipeline.
--
-- Fix: drop the FOR ALL and split into SELECT + INSERT, matching the pattern
-- migration 056 applied to agent_invoices, closing_date_amendments, and
-- deal_messages. Service-role mutations are unaffected.

DROP POLICY IF EXISTS "kyc_tokens_admin_all" ON kyc_upload_tokens;
DROP POLICY IF EXISTS kyc_tokens_admin_all ON kyc_upload_tokens;

CREATE POLICY kyc_tokens_admin_select ON kyc_upload_tokens
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

CREATE POLICY kyc_tokens_admin_insert ON kyc_upload_tokens
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );
