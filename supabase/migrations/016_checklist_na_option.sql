-- ============================================================================
-- Migration 016: Add N/A option to underwriting checklist
-- ============================================================================
-- Allows admins to mark checklist items as "Not Applicable" instead of
-- checked/unchecked. N/A items count as complete for approval blocking.
-- ============================================================================

ALTER TABLE underwriting_checklist
  ADD COLUMN IF NOT EXISTS is_na BOOLEAN DEFAULT FALSE;
