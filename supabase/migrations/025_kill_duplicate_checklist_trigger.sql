-- Migration 025: Remove duplicate checklist trigger
-- ============================================================================
-- ROOT CAUSE: Two triggers were firing on deals INSERT:
--   1. auto_create_checklist → create_default_checklist() (OLD, bloated items)
--   2. on_deal_created → create_underwriting_checklist() (CORRECT, 12 items)
--
-- Every new deal got BOTH sets of checklist items — the old garbage plus the
-- correct 12. Old deals looked fine because migration 017 wiped and regenerated
-- them, but any deal created AFTER that got doubled up.
--
-- This migration drops the old trigger and function permanently.
-- ============================================================================

-- Drop the old trigger (may already be dropped manually)
DROP TRIGGER IF EXISTS auto_create_checklist ON deals;

-- Drop the old function so it can never be re-attached
DROP FUNCTION IF EXISTS create_default_checklist();
