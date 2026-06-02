-- 102_staff_roles.sql
-- ============================================================================
-- Least-privilege internal staff roles: Owner / Manager / General Staff.
-- ============================================================================
-- WHY THIS IS THE SAFE SHAPE:
--   * It does NOT touch the existing `user_profiles_role_check` constraint
--     (which lives only in the live DB and is the #1 lockout risk).
--   * It does NOT change any RLS policy. RLS continues to treat
--     super_admin + firm_funds_admin as the single internal read bucket,
--     exactly as before, so nobody loses dashboard access on day one.
--   * The capability layer (who can DO what) is enforced in application code
--     (lib/access.ts + server actions + proxy + in-page checks). That is the
--     real boundary because every mutation runs through the service-role
--     client, which bypasses RLS anyway.
--
-- MODEL:
--   user_profiles.role        -> coarse identity (unchanged): agent /
--                                brokerage_admin / firm_funds_admin / super_admin
--   user_profiles.staff_role  -> NEW. internal staff tier: owner / manager / staff
--                                NULL for non-internal users (agents, brokerage admins).
--   super_admin is ALWAYS treated as owner in code regardless of this column.
-- ============================================================================

-- 1. Add the column (idempotent).
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS staff_role TEXT;

-- 2. Constrain it to the three tiers (or NULL). New constraint we fully own;
--    does not touch the pre-existing role constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_staff_role_check'
  ) THEN
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_staff_role_check
      CHECK (staff_role IS NULL OR staff_role IN ('owner', 'manager', 'staff'));
  END IF;
END $$;

-- 3. Backfill existing internal admins so nothing breaks on day one.
--    super_admin -> owner (full power; no change to their effective access).
UPDATE public.user_profiles
  SET staff_role = 'owner'
  WHERE role = 'super_admin' AND staff_role IS NULL;

--    Any pre-existing firm_funds_admin (currently zero in production) ->
--    manager: a safe, non-owner default that keeps dashboard access without
--    the dangerous capabilities (money, deletes, role management, view-as).
UPDATE public.user_profiles
  SET staff_role = 'manager'
  WHERE role = 'firm_funds_admin' AND staff_role IS NULL;

-- 4. Index for the (rare) capability lookups that filter by tier.
CREATE INDEX IF NOT EXISTS idx_user_profiles_staff_role
  ON public.user_profiles (staff_role)
  WHERE staff_role IS NOT NULL;

COMMENT ON COLUMN public.user_profiles.staff_role IS
  'Least-privilege internal staff tier: owner | manager | staff. NULL for non-internal users (agents, brokerage admins). Drives the application capability layer in lib/access.ts. super_admin is always treated as owner.';
