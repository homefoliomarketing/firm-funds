-- ============================================================================
-- Migration 098: expand brokerage_admins.role to the three named brokerage tiers
-- ============================================================================
-- Migration 087 created brokerage_admins with role in ('admin','primary_admin').
-- That works for the technical multi-admin case but doesn't model the
-- regulatory + day-to-day split that brokerages actually use:
--
--   broker_of_record     Regulatory signatory. Signs the BCA, owns the
--                        compliance posture. Can manage other admins, can
--                        only be removed by Firm Funds.
--   brokerage_manager    Day-to-day owner of the Firm Funds relationship.
--                        Can manage other admins (invite/remove plain admins
--                        and other managers) but cannot remove the BoR.
--   brokerage_admin      Plain portal admin. Submits deals, manages agents,
--                        no team-management privileges.
--
-- This migration:
--   1. Renames the existing values: primary_admin -> broker_of_record,
--      admin -> brokerage_admin. brokerage_manager is the new middle tier
--      and there are no existing rows to migrate into it.
--   2. Replaces the CHECK constraint so the three values are the only legal
--      ones going forward.
--   3. Leaves user_profiles.role unchanged (still 'brokerage_admin' for all
--      three tiers). The split is purely junction-table sub-role.
-- ============================================================================

-- Step 1: drop the old CHECK so we can update the rows without violating it.
ALTER TABLE brokerage_admins
  DROP CONSTRAINT IF EXISTS brokerage_admins_role_check;

-- Step 2: rename existing values in place.
UPDATE brokerage_admins SET role = 'broker_of_record' WHERE role = 'primary_admin';
UPDATE brokerage_admins SET role = 'brokerage_admin'  WHERE role = 'admin';

-- Step 3: add the new CHECK constraint covering all three tiers.
ALTER TABLE brokerage_admins
  ADD CONSTRAINT brokerage_admins_role_check
  CHECK (role IN ('broker_of_record', 'brokerage_manager', 'brokerage_admin'));

-- Step 4: switch the column default so newly-seeded rows that don't specify
-- a role land in the plain-admin tier (matching the safest default).
ALTER TABLE brokerage_admins
  ALTER COLUMN role SET DEFAULT 'brokerage_admin';

COMMENT ON COLUMN brokerage_admins.role IS
  'Sub-role inside the brokerage pool. One of broker_of_record (regulatory signatory, removable only by Firm Funds), brokerage_manager (day-to-day owner, can manage admins but not BoR), or brokerage_admin (plain portal admin, no team-management rights). user_profiles.role remains brokerage_admin for all three.';
