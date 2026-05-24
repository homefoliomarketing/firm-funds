-- =============================================================================
-- Session 4: Tighten deal-documents storage bucket policies (Finding 2)
-- =============================================================================
-- Previously: any authenticated user could SELECT/INSERT/DELETE any object
-- in deal-documents. Meant a fresh-onboarded agent could enumerate and
-- download every signed CPA, banking PDF, and Remediation IDP across the
-- entire platform via direct Supabase storage API calls.
--
-- New policy: admin role has full access; otherwise the caller must own
-- the deal whose UUID is the first path segment (agent_id or brokerage_id
-- match). DELETE is admin-only.
-- =============================================================================

DROP POLICY IF EXISTS "Authenticated users can view deal documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload deal documents" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete deal documents" ON storage.objects;

CREATE POLICY "deal_documents_select_scoped"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'deal-documents' AND (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
    OR EXISTS (
      SELECT 1 FROM public.deals d
      JOIN public.user_profiles up ON up.id = auth.uid()
      WHERE d.id::text = (storage.foldername(name))[1]
        AND (
          (up.role = 'agent' AND d.agent_id = up.agent_id)
          OR (up.role = 'brokerage_admin' AND d.brokerage_id = up.brokerage_id)
        )
    )
  )
);

CREATE POLICY "deal_documents_insert_scoped"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'deal-documents' AND (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('super_admin', 'firm_funds_admin')
    )
    OR EXISTS (
      SELECT 1 FROM public.deals d
      JOIN public.user_profiles up ON up.id = auth.uid()
      WHERE d.id::text = (storage.foldername(name))[1]
        AND (
          (up.role = 'agent' AND d.agent_id = up.agent_id)
          OR (up.role = 'brokerage_admin' AND d.brokerage_id = up.brokerage_id)
        )
    )
  )
);

CREATE POLICY "deal_documents_delete_admin_only"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'deal-documents' AND
  EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.role IN ('super_admin', 'firm_funds_admin')
  )
);

-- agent-kyc bucket: no SELECT/INSERT/DELETE policies = default deny for
-- authenticated users. The app reads/writes this bucket via signed URLs
-- created by the service role (kyc-mobile-upload route, getDocumentSignedUrl
-- with admin auth). Confirmed safe by inspection — no change needed.
