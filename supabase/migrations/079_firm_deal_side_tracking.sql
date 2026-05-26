-- 079_firm_deal_side_tracking.sql
--
-- Adds listing_matched_agent_id and selling_matched_agent_id columns to
-- firm_deal_events. The original schema only had matched_agent_id and
-- second_matched_agent_id with no side information, so the review-queue
-- UI could not tell which agent was on which side. With these columns
-- the matcher writes side-aware results and the UI shows them correctly.
--
-- matched_agent_id is kept as the dispatch-primary (the agent we actually
-- email + SMS). It is derived: the listing side wins when both sides have
-- an enrolled agent, otherwise whichever side has one. This way the
-- existing dispatcher does not need to change.

ALTER TABLE firm_deal_events
  ADD COLUMN listing_matched_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN selling_matched_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_firm_deal_events_listing_matched_agent
  ON firm_deal_events(listing_matched_agent_id) WHERE listing_matched_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_firm_deal_events_selling_matched_agent
  ON firm_deal_events(selling_matched_agent_id) WHERE selling_matched_agent_id IS NOT NULL;

COMMENT ON COLUMN firm_deal_events.listing_matched_agent_id IS
  'The enrolled agent matched to the listing side of the deal. NULL if listing side was outside / unresolved / empty.';

COMMENT ON COLUMN firm_deal_events.selling_matched_agent_id IS
  'The enrolled agent matched to the selling side of the deal. NULL if selling side was outside / unresolved / empty.';

COMMENT ON COLUMN firm_deal_events.matched_agent_id IS
  'Dispatch-primary agent (who we email + SMS). Derived from listing_matched_agent_id / selling_matched_agent_id by the matcher.';
