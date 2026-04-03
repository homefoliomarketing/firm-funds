-- ============================================================================
-- Migration 014: Add 'archived' to agents status check constraint
-- ============================================================================
-- The archive feature requires 'archived' as a valid status.
-- ============================================================================

-- Drop the existing check constraint and recreate with 'archived' included
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('active', 'inactive', 'suspended', 'archived'));
