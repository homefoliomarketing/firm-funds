-- Migration 024: Merge "repaid" and "closed" deal statuses into single "completed" status
-- This is NOT a loan, so "repaid" terminology is incorrect.
-- "Closed" was a redundant terminal state after "repaid" — now both are just "completed".

-- Step 1: Update all existing "repaid" and "closed" deals to "completed"
UPDATE deals SET status = 'completed' WHERE status IN ('repaid', 'closed');

-- Step 2: Update the check constraint on the status column
-- First drop the old constraint, then add the new one
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE deals ADD CONSTRAINT deals_status_check
  CHECK (status IN ('under_review', 'approved', 'funded', 'completed', 'denied', 'cancelled'));

-- Step 3: Update the trigger function that creates underwriting checklist
-- (The trigger references status values for auto-check logic — no changes needed
--  since it only checks 'under_review' on new deal creation, not repaid/closed)

-- Verify: Count deals by status after migration
-- SELECT status, COUNT(*) FROM deals GROUP BY status ORDER BY status;
