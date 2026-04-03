-- ============================================================================
-- Migration 012: Add category column to underwriting_checklist
-- ============================================================================
-- Stores checklist category directly in DB instead of fragile UI keyword matching.
-- This eliminates items moving between categories on every render.
-- ============================================================================

-- Step 1: Add category column
ALTER TABLE underwriting_checklist
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'Agent Verification';

-- Step 2: Delete ALL existing checklist items (they'll be recreated with categories)
DELETE FROM underwriting_checklist;

-- Step 3: Replace the trigger function with category-aware version
CREATE OR REPLACE FUNCTION create_underwriting_checklist()
RETURNS TRIGGER AS $$
DECLARE
  items TEXT[][] := ARRAY[
    -- category, checklist_item
    ARRAY['Agent Verification', 'Agent ID & KYC/FINTRAC verification'],
    ARRAY['Agent Verification', 'Agent has no outstanding recovery amounts from fallen-through deals'],
    ARRAY['Agent Verification', 'Agent is in good standing (not flagged by brokerage)'],
    ARRAY['Deal Document Review', 'Agreement of Purchase and Sale (APS) received and reviewed'],
    ARRAY['Deal Document Review', 'APS is fully executed (signed by all parties)'],
    ARRAY['Deal Document Review', 'Property address verified against MLS listing'],
    ARRAY['Deal Document Review', 'Brokerage split percentage confirmed via trade record'],
    ARRAY['Deal Document Review', 'Brokerage is an active partner in good standing'],
    ARRAY['Deal Document Review', 'Deal status is firm/unconditional (no outstanding conditions)'],
    ARRAY['Deal Document Review', 'Trade record received confirming agent commission split'],
    ARRAY['Deal Document Review', 'Closing date is confirmed and within acceptable range'],
    ARRAY['Deal Document Review', 'Commission amount matches APS and trade record'],
    ARRAY['Deal Document Review', 'Discount fee calculated correctly'],
    ARRAY['Financial', 'Void cheque or banking information on file'],
    ARRAY['Firm Funds Documents', 'Commission Purchase Agreement - Signed'],
    ARRAY['Firm Funds Documents', 'Irrevocable Direction to Pay - Signed']
  ];
  i INT;
BEGIN
  FOR i IN 1..array_length(items, 1)
  LOOP
    INSERT INTO underwriting_checklist (deal_id, category, checklist_item, is_checked, sort_order)
    VALUES (NEW.id, items[i][1], items[i][2], FALSE, i);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Re-create checklist items for all existing deals WITH categories
DO $$
DECLARE
  deal RECORD;
  items TEXT[][] := ARRAY[
    ARRAY['Agent Verification', 'Agent ID & KYC/FINTRAC verification'],
    ARRAY['Agent Verification', 'Agent has no outstanding recovery amounts from fallen-through deals'],
    ARRAY['Agent Verification', 'Agent is in good standing (not flagged by brokerage)'],
    ARRAY['Deal Document Review', 'Agreement of Purchase and Sale (APS) received and reviewed'],
    ARRAY['Deal Document Review', 'APS is fully executed (signed by all parties)'],
    ARRAY['Deal Document Review', 'Property address verified against MLS listing'],
    ARRAY['Deal Document Review', 'Brokerage split percentage confirmed via trade record'],
    ARRAY['Deal Document Review', 'Brokerage is an active partner in good standing'],
    ARRAY['Deal Document Review', 'Deal status is firm/unconditional (no outstanding conditions)'],
    ARRAY['Deal Document Review', 'Trade record received confirming agent commission split'],
    ARRAY['Deal Document Review', 'Closing date is confirmed and within acceptable range'],
    ARRAY['Deal Document Review', 'Commission amount matches APS and trade record'],
    ARRAY['Deal Document Review', 'Discount fee calculated correctly'],
    ARRAY['Financial', 'Void cheque or banking information on file'],
    ARRAY['Firm Funds Documents', 'Commission Purchase Agreement - Signed'],
    ARRAY['Firm Funds Documents', 'Irrevocable Direction to Pay - Signed']
  ];
  i INT;
BEGIN
  FOR deal IN SELECT id FROM deals LOOP
    FOR i IN 1..array_length(items, 1) LOOP
      INSERT INTO underwriting_checklist (deal_id, category, checklist_item, is_checked, sort_order)
      VALUES (deal.id, items[i][1], items[i][2], FALSE, i);
    END LOOP;
  END LOOP;
END $$;
