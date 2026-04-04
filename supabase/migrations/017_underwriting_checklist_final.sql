-- ============================================================================
-- Migration 017: Underwriting Checklist — FINAL (Bud-approved items)
-- ============================================================================
-- This migration WIPES all existing checklist items and replaces them with
-- the correct, Bud-approved list. The trigger function is also replaced
-- so all future deals get the correct items.
--
-- DO NOT MODIFY THIS LIST unless Bud explicitly asks for changes.
-- ============================================================================

-- Step 1: Wipe ALL existing checklist items
DELETE FROM underwriting_checklist;

-- Step 2: Replace the trigger function with Bud's approved items
-- Now includes auto-check logic for "Agent in good standing" based on
-- the agent's flagged_by_brokerage status.
CREATE OR REPLACE FUNCTION create_underwriting_checklist()
RETURNS TRIGGER AS $$
DECLARE
  items TEXT[][] := ARRAY[
    -- Agent Verification
    ARRAY['Agent Verification', 'Agent ID - FINTRAC Verification'],
    ARRAY['Agent Verification', 'Agent has no outstanding recovery balance from previous fallen-through deals'],
    ARRAY['Agent Verification', 'Agent in good standing with Brokerage (Not flagged)'],
    -- Deal Verification
    ARRAY['Deal Verification', 'Agreement of Purchase and Sale, Schedules and Confirmation of Co-Operation'],
    ARRAY['Deal Verification', 'Amendments'],
    ARRAY['Deal Verification', 'Notices of Fulfillment/Waivers'],
    ARRAY['Deal Verification', 'Trade Record - Agent/Brokerage Split verified'],
    ARRAY['Deal Verification', 'Deal verified as unconditional'],
    ARRAY['Deal Verification', 'Address verification on Google & Street View'],
    ARRAY['Deal Verification', 'Double-check Discount Fee and Referral Fee Calculated Correctly'],
    -- Firm Fund Documents
    ARRAY['Firm Fund Documents', 'Commission Purchase Agreement - Signed and Executed'],
    ARRAY['Firm Fund Documents', 'Irrevocable Direction to Pay - Signed and Executed']
  ];
  i INT;
  agent_flagged BOOLEAN := FALSE;
BEGIN
  -- Check if agent is flagged by brokerage (for auto-check logic)
  SELECT COALESCE(flagged_by_brokerage, FALSE) INTO agent_flagged
  FROM agents WHERE id = NEW.agent_id;

  FOR i IN 1..array_length(items, 1)
  LOOP
    INSERT INTO underwriting_checklist (deal_id, category, checklist_item, is_checked, is_na, sort_order)
    VALUES (
      NEW.id,
      items[i][1],
      items[i][2],
      -- Auto-check "good standing" item if agent is NOT flagged
      CASE WHEN items[i][2] = 'Agent in good standing with Brokerage (Not flagged)' AND NOT agent_flagged
           THEN TRUE ELSE FALSE END,
      FALSE,
      i
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 3: Re-create checklist items for ALL existing deals with correct items
DO $$
DECLARE
  deal RECORD;
  items TEXT[][] := ARRAY[
    ARRAY['Agent Verification', 'Agent ID - FINTRAC Verification'],
    ARRAY['Agent Verification', 'Agent has no outstanding recovery balance from previous fallen-through deals'],
    ARRAY['Agent Verification', 'Agent in good standing with Brokerage (Not flagged)'],
    ARRAY['Deal Verification', 'Agreement of Purchase and Sale, Schedules and Confirmation of Co-Operation'],
    ARRAY['Deal Verification', 'Amendments'],
    ARRAY['Deal Verification', 'Notices of Fulfillment/Waivers'],
    ARRAY['Deal Verification', 'Trade Record - Agent/Brokerage Split verified'],
    ARRAY['Deal Verification', 'Deal verified as unconditional'],
    ARRAY['Deal Verification', 'Address verification on Google & Street View'],
    ARRAY['Deal Verification', 'Double-check Discount Fee and Referral Fee Calculated Correctly'],
    ARRAY['Firm Fund Documents', 'Commission Purchase Agreement - Signed and Executed'],
    ARRAY['Firm Fund Documents', 'Irrevocable Direction to Pay - Signed and Executed']
  ];
  i INT;
  agent_flagged BOOLEAN;
BEGIN
  FOR deal IN SELECT d.id, d.agent_id FROM deals d LOOP
    -- Check agent flag status for this deal's agent
    SELECT COALESCE(flagged_by_brokerage, FALSE) INTO agent_flagged
    FROM agents WHERE id = deal.agent_id;

    FOR i IN 1..array_length(items, 1) LOOP
      INSERT INTO underwriting_checklist (deal_id, category, checklist_item, is_checked, is_na, sort_order)
      VALUES (
        deal.id,
        items[i][1],
        items[i][2],
        CASE WHEN items[i][2] = 'Agent in good standing with Brokerage (Not flagged)' AND NOT COALESCE(agent_flagged, FALSE)
             THEN TRUE ELSE FALSE END,
        FALSE,
        i
      );
    END LOOP;
  END LOOP;
END $$;
