-- ============================================================
-- Migration 008: Underwriting Checklist Cleanup
-- Run this in Supabase SQL Editor
-- ============================================================

-- Step 1: Delete ALL existing checklist items for all deals
-- We'll re-create them with the clean list
DELETE FROM underwriting_checklist;

-- Step 2: Replace the trigger function with the new clean checklist
CREATE OR REPLACE FUNCTION create_underwriting_checklist()
RETURNS TRIGGER AS $$
DECLARE
  checklist_items TEXT[] := ARRAY[
    -- Agent Verification
    'Agent ID & KYC/FINTRAC verification',
    'Agent has no outstanding recovery amounts from fallen-through deals',
    'Agent is in good standing (not flagged by brokerage)',
    -- Deal Document Review
    'Agreement of Purchase and Sale, Schedules, Confirmation of Co-op - Signed by all parties',
    'Amendments reviewed (if applicable)',
    'Notice of Fulfillment/Waiver received (if applicable)',
    'Confirm deal is firm (no outstanding conditions)',
    'Closing date is confirmed and within acceptable range',
    'Trade Record Sheet received confirming Agent/Brokerage Splits',
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
    'Agreement of Purchase and Sale, Schedules, Confirmation of Co-op - Signed by all parties',
    'Amendments reviewed (if applicable)',
    'Notice of Fulfillment/Waiver received (if applicable)',
    'Confirm deal is firm (no outstanding conditions)',
    'Closing date is confirmed and within acceptable range',
    'Trade Record Sheet received confirming Agent/Brokerage Splits',
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
