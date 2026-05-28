-- ============================================================================
-- Migration 094: active-status-aware RLS/storage hardening
-- ============================================================================
-- App middleware/server actions now block inactive profiles, suspended/flagged
-- agents, and inactive brokerages. This migration gives the database/storage
-- layer the same trust boundary so direct Supabase client calls cannot keep
-- working after an account is disabled.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Common RLS helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT up.role::text
  FROM public.user_profiles up
  LEFT JOIN public.agents a ON a.id = up.agent_id
  LEFT JOIN public.brokerages agent_b ON agent_b.id = a.brokerage_id
  LEFT JOIN public.brokerages profile_b ON profile_b.id = up.brokerage_id
  WHERE up.id = auth.uid()
    AND up.is_active IS TRUE
    AND (
      up.role IN ('super_admin', 'firm_funds_admin')
      OR (
        up.role = 'agent'
        AND a.id IS NOT NULL
        AND a.status = 'active'
        AND COALESCE(a.flagged_by_brokerage, false) = false
        AND a.deleted_at IS NULL
        AND agent_b.status = 'active'
        AND agent_b.deleted_at IS NULL
      )
      OR (
        up.role = 'brokerage_admin'
        AND (
          (
            profile_b.id IS NOT NULL
            AND profile_b.status = 'active'
            AND profile_b.deleted_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM public.brokerage_admins ba
            JOIN public.brokerages b ON b.id = ba.brokerage_id
            WHERE ba.user_id = up.id
              AND b.status = 'active'
              AND b.deleted_at IS NULL
          )
        )
      )
    )
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.get_user_agent_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT up.agent_id
  FROM public.user_profiles up
  JOIN public.agents a ON a.id = up.agent_id
  JOIN public.brokerages b ON b.id = a.brokerage_id
  WHERE up.id = auth.uid()
    AND up.is_active IS TRUE
    AND up.role = 'agent'
    AND a.status = 'active'
    AND COALESCE(a.flagged_by_brokerage, false) = false
    AND a.deleted_at IS NULL
    AND b.status = 'active'
    AND b.deleted_at IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.get_user_brokerage_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT active_brokerages.brokerage_id
  FROM (
    SELECT up.brokerage_id, 0 AS priority
    FROM public.user_profiles up
    JOIN public.brokerages b ON b.id = up.brokerage_id
    WHERE up.id = auth.uid()
      AND up.is_active IS TRUE
      AND up.role = 'brokerage_admin'
      AND b.status = 'active'
      AND b.deleted_at IS NULL

    UNION ALL

    SELECT ba.brokerage_id, 1 AS priority
    FROM public.user_profiles up
    JOIN public.brokerage_admins ba ON ba.user_id = up.id
    JOIN public.brokerages b ON b.id = ba.brokerage_id
    WHERE up.id = auth.uid()
      AND up.is_active IS TRUE
      AND up.role = 'brokerage_admin'
      AND b.status = 'active'
      AND b.deleted_at IS NULL
  ) active_brokerages
  ORDER BY priority
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.is_active IS TRUE
      AND up.role IN ('super_admin', 'firm_funds_admin')
  )
$$;

COMMENT ON FUNCTION public.get_user_role() IS
  'Returns role only for active, non-suspended account contexts. Updated in migration 094.';
COMMENT ON FUNCTION public.get_user_agent_id() IS
  'Returns agent_id only when the profile, agent, and brokerage are active and the agent is not flagged. Updated in migration 094.';
COMMENT ON FUNCTION public.get_user_brokerage_id() IS
  'Returns an active brokerage_admin brokerage_id only when the profile and brokerage are active. Updated in migration 094.';
COMMENT ON FUNCTION public.is_admin() IS
  'True only for active Firm Funds internal admin profiles. Updated in migration 094.';

-- ---------------------------------------------------------------------------
-- Audit log: service-role-only writes
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Authenticated users can insert audit logs" ON public.audit_log;
DROP POLICY IF EXISTS "Authenticated users insert own audit rows" ON public.audit_log;

COMMENT ON TABLE public.audit_log IS
  'Append-only audit trail. Authenticated users have no direct INSERT/UPDATE/DELETE policy as of migration 094; application code writes through service-role server paths.';

-- ---------------------------------------------------------------------------
-- deal-documents bucket: scoped direct storage access, no broad UPDATE policy
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Authenticated users can view deal documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload deal documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update deal documents" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete deal documents" ON storage.objects;
DROP POLICY IF EXISTS "deal_documents_select_scoped" ON storage.objects;
DROP POLICY IF EXISTS "deal_documents_insert_scoped" ON storage.objects;
DROP POLICY IF EXISTS "deal_documents_delete_admin_only" ON storage.objects;

CREATE POLICY "deal_documents_select_scoped"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'deal-documents'
  AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.deals d
      JOIN public.agents a ON a.id = d.agent_id
      JOIN public.brokerages b ON b.id = d.brokerage_id
      JOIN public.user_profiles up ON up.id = auth.uid()
      WHERE d.id::text = (storage.foldername(name))[1]
        AND up.is_active IS TRUE
        AND (
          (
            up.role = 'agent'
            AND d.agent_id = up.agent_id
            AND a.status = 'active'
            AND COALESCE(a.flagged_by_brokerage, false) = false
            AND a.deleted_at IS NULL
            AND b.status = 'active'
            AND b.deleted_at IS NULL
          )
          OR (
            up.role = 'brokerage_admin'
            AND b.status = 'active'
            AND b.deleted_at IS NULL
            AND (
              d.brokerage_id = up.brokerage_id
              OR EXISTS (
                SELECT 1
                FROM public.brokerage_admins ba
                WHERE ba.user_id = up.id
                  AND ba.brokerage_id = d.brokerage_id
              )
            )
          )
        )
    )
  )
);

CREATE POLICY "deal_documents_insert_scoped"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'deal-documents'
  AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.deals d
      JOIN public.agents a ON a.id = d.agent_id
      JOIN public.brokerages b ON b.id = d.brokerage_id
      JOIN public.user_profiles up ON up.id = auth.uid()
      WHERE d.id::text = (storage.foldername(name))[1]
        AND up.is_active IS TRUE
        AND (
          (
            up.role = 'agent'
            AND d.agent_id = up.agent_id
            AND a.status = 'active'
            AND COALESCE(a.flagged_by_brokerage, false) = false
            AND a.deleted_at IS NULL
            AND b.status = 'active'
            AND b.deleted_at IS NULL
          )
          OR (
            up.role = 'brokerage_admin'
            AND b.status = 'active'
            AND b.deleted_at IS NULL
            AND (
              d.brokerage_id = up.brokerage_id
              OR EXISTS (
                SELECT 1
                FROM public.brokerage_admins ba
                WHERE ba.user_id = up.id
                  AND ba.brokerage_id = d.brokerage_id
              )
            )
          )
        )
    )
  )
);

CREATE POLICY "deal_documents_delete_admin_only"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'deal-documents'
  AND public.is_admin()
);

-- ---------------------------------------------------------------------------
-- agent-preauth-forms bucket: paths are agent_id-prefixed, not auth.uid-prefixed
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Agents can upload own preauth form" ON storage.objects;
DROP POLICY IF EXISTS "Agents can view own preauth form" ON storage.objects;
DROP POLICY IF EXISTS "Admins can view all preauth forms" ON storage.objects;
DROP POLICY IF EXISTS "agent_preauth_insert_own_active" ON storage.objects;
DROP POLICY IF EXISTS "agent_preauth_select_own_active" ON storage.objects;
DROP POLICY IF EXISTS "agent_preauth_admin_select" ON storage.objects;

CREATE POLICY "agent_preauth_insert_own_active"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'agent-preauth-forms'
  AND (storage.foldername(name))[1] = public.get_user_agent_id()::text
);

CREATE POLICY "agent_preauth_select_own_active"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'agent-preauth-forms'
  AND (storage.foldername(name))[1] = public.get_user_agent_id()::text
);

CREATE POLICY "agent_preauth_admin_select"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'agent-preauth-forms'
  AND public.is_admin()
);

-- ---------------------------------------------------------------------------
-- brokerage-logos bucket: public read, internal admin writes only
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admin upload brokerage logos" ON storage.objects;
DROP POLICY IF EXISTS "brokerage_logos_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "brokerage_logos_admin_update" ON storage.objects;

CREATE POLICY "brokerage_logos_admin_insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'brokerage-logos'
  AND public.is_admin()
);

CREATE POLICY "brokerage_logos_admin_update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'brokerage-logos'
  AND public.is_admin()
)
WITH CHECK (
  bucket_id = 'brokerage-logos'
  AND public.is_admin()
);

-- ---------------------------------------------------------------------------
-- brokerage_documents table: active admin/profile-aware reads
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins full access on brokerage_documents" ON public.brokerage_documents;
DROP POLICY IF EXISTS "Brokerage admins view own docs" ON public.brokerage_documents;
DROP POLICY IF EXISTS brokerage_documents_admin_all_active ON public.brokerage_documents;
DROP POLICY IF EXISTS brokerage_documents_brokerage_select_active ON public.brokerage_documents;

CREATE POLICY brokerage_documents_admin_all_active
ON public.brokerage_documents
FOR ALL
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY brokerage_documents_brokerage_select_active
ON public.brokerage_documents
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    JOIN public.brokerages b ON b.id = brokerage_documents.brokerage_id
    WHERE up.id = auth.uid()
      AND up.is_active IS TRUE
      AND up.role = 'brokerage_admin'
      AND b.status = 'active'
      AND b.deleted_at IS NULL
      AND (
        up.brokerage_id = brokerage_documents.brokerage_id
        OR EXISTS (
          SELECT 1
          FROM public.brokerage_admins ba
          WHERE ba.user_id = up.id
            AND ba.brokerage_id = brokerage_documents.brokerage_id
        )
      )
  )
);
