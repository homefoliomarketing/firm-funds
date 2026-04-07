-- =============================================================================
-- Deletion Safeguards: Prevent deletion of agents/brokerages with deal history
-- =============================================================================
-- Once launched, agents and brokerages with deals cannot be deleted.
-- They can only be archived. This is a hard DB constraint — not bypassable from UI.
-- =============================================================================

-- 1. Add 'archived' status to brokerages
ALTER TABLE brokerages DROP CONSTRAINT IF EXISTS brokerages_status_check;
ALTER TABLE brokerages ADD CONSTRAINT brokerages_status_check
  CHECK (status IN ('active', 'suspended', 'inactive', 'archived'));

-- 2. Trigger: prevent deleting agents with deals
CREATE OR REPLACE FUNCTION prevent_agent_delete_with_deals()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM deals WHERE agent_id = OLD.id LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot delete agent with deal history. Archive the agent instead.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_agent_delete_with_deals
  BEFORE DELETE ON agents
  FOR EACH ROW
  EXECUTE FUNCTION prevent_agent_delete_with_deals();

-- 3. Trigger: prevent deleting brokerages with deals
CREATE OR REPLACE FUNCTION prevent_brokerage_delete_with_deals()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM deals WHERE brokerage_id = OLD.id LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot delete brokerage with deal history. Archive the brokerage instead.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_brokerage_delete_with_deals
  BEFORE DELETE ON brokerages
  FOR EACH ROW
  EXECUTE FUNCTION prevent_brokerage_delete_with_deals();
