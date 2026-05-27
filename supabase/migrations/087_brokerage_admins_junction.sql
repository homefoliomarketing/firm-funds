-- ============================================================================
-- Migration 087: brokerage_admins junction table (multi-admin per brokerage)
-- ============================================================================
-- Today user_profiles.brokerage_id is a single foreign key — a user belongs
-- to exactly one brokerage and a brokerage's admin list is derived by
-- scanning user_profiles WHERE role='brokerage_admin' AND brokerage_id=$1.
-- That works for the 1-admin case but blocks the (very common) case where
-- a brokerage has an office manager, a primary BoR, and a billing contact
-- all needing the same level of portal access.
--
-- New shape:
--   brokerage_admins (brokerage_id, user_id, role, invited_at, accepted_at)
--   - role: 'admin' or 'primary_admin' (one per brokerage by convention)
--   - UNIQUE(brokerage_id, user_id) prevents accidental double-grants
--
-- Backfill: each existing user_profiles row with role='brokerage_admin' and
-- a non-null brokerage_id becomes a 'primary_admin' in this junction. The
-- original user_profiles.brokerage_id column stays for backwards-compat —
-- routes can keep reading it during the rollout.
-- ============================================================================

CREATE TABLE IF NOT EXISTS brokerage_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'admin'
    CHECK (role IN ('admin', 'primary_admin')),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  UNIQUE (brokerage_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_brokerage_admins_brokerage_id
  ON brokerage_admins(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_brokerage_admins_user_id
  ON brokerage_admins(user_id);

COMMENT ON TABLE brokerage_admins IS
  'Multi-admin junction table — replaces the implicit "user_profiles.brokerage_id + role=brokerage_admin" linkage. A brokerage may have many admins; convention is exactly one with role=primary_admin. See migration 087.';

-- RLS
ALTER TABLE brokerage_admins ENABLE ROW LEVEL SECURITY;

-- Admins can see their own brokerage's admin list (themselves OR anyone else
-- who shares their brokerage). Firm Funds super-admins can see everything.
DROP POLICY IF EXISTS brokerage_admins_select ON brokerage_admins;
CREATE POLICY brokerage_admins_select ON brokerage_admins
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR brokerage_id IN (
      SELECT brokerage_id FROM brokerage_admins WHERE user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- Only the service role inserts/deletes (invite + accept flows). Authenticated
-- users get no write access — no UPDATE policy either.
DROP POLICY IF EXISTS brokerage_admins_no_insert ON brokerage_admins;
CREATE POLICY brokerage_admins_no_insert ON brokerage_admins
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS brokerage_admins_no_delete ON brokerage_admins;
CREATE POLICY brokerage_admins_no_delete ON brokerage_admins
  FOR DELETE TO authenticated USING (false);

DROP POLICY IF EXISTS brokerage_admins_no_update ON brokerage_admins;
CREATE POLICY brokerage_admins_no_update ON brokerage_admins
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

-- ============================================================================
-- Backfill: turn every existing brokerage_admin user_profile into a
-- primary_admin row. RAISE NOTICE the count for the audit trail.
-- ============================================================================
DO $$
DECLARE
  inserted_count INTEGER;
BEGIN
  INSERT INTO brokerage_admins (brokerage_id, user_id, role, invited_at, accepted_at)
  SELECT
    up.brokerage_id,
    up.id,
    'primary_admin',
    COALESCE(up.created_at, NOW()),
    COALESCE(up.last_login, up.last_active_at, up.created_at, NOW())
  FROM user_profiles up
  WHERE up.role = 'brokerage_admin'
    AND up.brokerage_id IS NOT NULL
  ON CONFLICT (brokerage_id, user_id) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RAISE NOTICE 'brokerage_admins backfill: % rows inserted', inserted_count;
END $$;
