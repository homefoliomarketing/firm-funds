-- =============================================================================
-- 101_agent_kyc_bucket_limits.sql
-- =============================================================================
-- Codifies the agent-kyc storage bucket's size and MIME-type limits in SQL so
-- they cannot drift and are enforced even on the signed-URL direct-upload path
-- (kyc-mobile-upload / kyc-desktop-upload), which uploads straight to Supabase
-- Storage and therefore bypasses the app's per-request file validation.
--
-- Values mirror lib/constants.ts exactly:
--   MAX_KYC_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024  (10 MiB = 10485760 bytes)
--   ALLOWED_KYC_MIME_TYPES    = image/jpeg, image/png, application/pdf
--
-- This matches the limits already set on the agent-preauth-forms bucket
-- (migration 021) and closes the gap left by 011_fintrac_kyc.sql, which only
-- left a comment to configure the bucket manually in the dashboard.
-- =============================================================================

UPDATE storage.buckets
   SET file_size_limit = 10485760,
       allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'application/pdf']
 WHERE id = 'agent-kyc';
