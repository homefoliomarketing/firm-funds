-- ============================================================================
-- Migration 095: hotfix for migration 094 recursion
-- ============================================================================
-- Migration 094's new policies (brokerage_documents_brokerage_select_active,
-- deal_documents_select_scoped, deal_documents_insert_scoped) contain an inline
--
--   EXISTS (SELECT 1 FROM public.brokerage_admins ba WHERE ...)
--
-- The pre-existing brokerage_admins_select policy on public.brokerage_admins
-- self-references brokerage_admins inside its USING expression. When any other
-- policy joins to brokerage_admins, Postgres detects the recursion and the
-- whole query 500s with "infinite recursion detected in policy for relation
-- brokerage_admins" for every authenticated role (admin, brokerage_admin, agent).
--
-- Fix: introduce a SECURITY DEFINER helper that bypasses RLS to perform the
-- membership lookup, and rewrite the 094 policies to call it.
--
-- Migration 094 also had a latent column-name-shadowing bug in the two
-- deal-documents storage policies: the inner EXISTS subquery joins brokerages
-- (which has a `name` column), so the bare `name` reference in
-- (storage.foldername(name))[1] resolved to brokerages.name instead of
-- storage.objects.name. Once the recursion cleared, the bug surfaced as 0
-- visible deal-documents for active agents/brokerage admins. Qualified with
-- storage.objects.name to disambiguate.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_user_brokerage_admin_of(p_user_id uuid, p_brokerage_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.brokerage_admins ba
    WHERE ba.user_id = p_user_id
      AND ba.brokerage_id = p_brokerage_id
  )
$$;

COMMENT ON FUNCTION public.is_user_brokerage_admin_of(uuid, uuid) IS
  'Bypasses RLS to check brokerage_admins junction membership. Used by policies that would otherwise recurse through brokerage_admins_select. Added in migration 095.';

-- ---------------------------------------------------------------------------
-- Replace recursive subqueries inside 094 storage policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "deal_documents_select_scoped" ON storage.objects;
DROP POLICY IF EXISTS "deal_documents_insert_scoped" ON storage.objects;

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
      WHERE d.id::text = (storage.foldername(storage.objects.name))[1]
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
              OR public.is_user_brokerage_admin_of(up.id, d.brokerage_id)
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
      WHERE d.id::text = (storage.foldername(storage.objects.name))[1]
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
              OR public.is_user_brokerage_admin_of(up.id, d.brokerage_id)
            )
          )
        )
    )
  )
);

-- ---------------------------------------------------------------------------
-- Replace recursive subquery inside 094 brokerage_documents policy
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS brokerage_documents_brokerage_select_active ON public.brokerage_documents;

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
        OR public.is_user_brokerage_admin_of(up.id, brokerage_documents.brokerage_id)
      )
  )
);
