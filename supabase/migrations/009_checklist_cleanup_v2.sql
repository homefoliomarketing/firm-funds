-- ============================================================
-- Migration 009: Underwriting Checklist Cleanup v2
-- Removes redundant items now handled by submission flow
-- Run this in Supabase SQL Editor
-- ============================================================

-- Step 1: Delete ALL existing checklist items for all deals
DELETE FROM underwriting_checklist;

-- Step 2: Replace the trigger function with the cleaned-up checklist
CREATE OR REPLACE FUNCTION create_underwriting_checklist()
RETURNS TRIGGER AS $$
DECLARE
  checklist_items TEXT[] := ARRAY[
    -- Agent Verification
    'Agent ID & KYC/FINTRAC verification',
    'Agent has no outstanding recovery amounts from fallen-through deals',
    'Agent is in good standing (not flagged by brokerage)',
    -- Deal Document Review
    'Amendments reviewed (if applicable)',
    'Notice of Fulfillment/Waiver received (if applicable)',
    'Closing date is confirmed and within acceptable range',
    'Commission amount matches APS and trade record',
    'Discount fee calculated correctly',
    -- Financial
    'Void cheque or banking information on file',
    -- Firm Funds Documents
    'Commission Purchase Agreement - Signed',
    'Irrevocable Direction to Pay - Signed'
  ];
  item TEXT;
  sort_order INT := 1;
BEGIN
  FOREACH item IN ARRAY checklist_items
  LOOP
    INSERT INTO underwriting_checklist (deal_id, checklist_item, is_checked, sort_order)
    VALUES (NEW.id, item, FALSE, sort_order);
    sort_order := sort_order + 1;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 3: Re-create checklist items for all existing deals
DO $$
DECLARE
  deal RECORD;
  checklist_items TEXT[] := ARRAY[
    'Agent ID & KYC/FINTRAC verification',
    'Agent has no outstanding recovery amounts from fallen-through deals',
    'Agent is in good standing (not flagged by brokerage)',
    'Amendments reviewed (if applicable)',
    'Notice of Fulfillment/Waiver received (if applicable)',
    'Closing date is confirmed and within acceptable range',
    'Commission amount matches APS and trade record',
    'Discount fee calculated correctly',
    'Void cheque or banking information on file',
    'Commission Purchase Agreement - Signed',
    'Irrevocable Direction to Pay - Signed'
  ];
  item TEXT;
  sort_order INT;
BEGIN
  FOR deal IN SELECT id FROM deals LOOP
    sort_order := 1;
    FOREACH item IN ARRAY checklist_items LOOP
      INSERT INTO underwriting_checklist (deal_id, checklist_item, is_checked, sort_order)
      VALUES (deal.id, item, FALSE, sort_order);
      sort_order := sort_order + 1;
    END LOOP;
  END LOOP;
END $$;
