-- ============================================================================
-- Migration 023: Auto-check KYC checklist item when agent KYC is verified
-- ============================================================================
-- Updates the create_underwriting_checklist trigger to also auto-check
-- "Agent ID - FINTRAC Verification" when the agent's kyc_status = 'verified'.
-- This means new deals submitted by KYC-verified agents get that item
-- checked automatically, just like "Agent in good standing" works.
-- ============================================================================

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
  agent_kyc_verified BOOLEAN := FALSE;
BEGIN
  -- Check agent status for auto-check logic
  SELECT
    COALESCE(flagged_by_brokerage, FALSE),
    COALESCE(kyc_status = 'verified', FALSE)
  INTO agent_flagged, agent_kyc_verified
  FROM agents WHERE id = NEW.agent_id;

  FOR i IN 1..array_length(items, 1)
  LOOP
    INSERT INTO underwriting_checklist (deal_id, category, checklist_item, is_checked, is_na, sort_order)
    VALUES (
      NEW.id,
      items[i][1],
      items[i][2],
      CASE
        -- Auto-check "good standing" if agent is NOT flagged
        WHEN items[i][2] = 'Agent in good standing with Brokerage (Not flagged)' AND NOT agent_flagged
          THEN TRUE
        -- Auto-check "FINTRAC Verification" if agent KYC is already verified
        WHEN items[i][2] = 'Agent ID - FINTRAC Verification' AND agent_kyc_verified
          THEN TRUE
        ELSE FALSE
      END,
      FALSE,
      i
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
