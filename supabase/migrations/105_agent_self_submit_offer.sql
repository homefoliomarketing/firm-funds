-- =============================================================================
-- 105_agent_self_submit_offer.sql
-- =============================================================================
-- Lets an agent who accepted a firm-deal offer take it over and submit the
-- advance themselves, instead of waiting on their brokerage. When this flag is
-- set, the brokerage is PAUSED on that offer: it disappears from their
-- "submit on behalf" queue, the convert/decline actions refuse it, and the
-- nudge crons skip it. This prevents duplicate submissions (the agent and the
-- brokerage both submitting the same offer).
--
-- The agent can hand the offer back to their brokerage (clearing this flag),
-- which resumes the normal brokerage-submits flow and the nudge cadence.
-- =============================================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS agent_self_submit_at timestamptz;

COMMENT ON COLUMN deals.agent_self_submit_at IS
  'Set when the agent took an ''offered'' firm-deal over to submit it themselves (the brokerage is paused on it: hidden from the submit-on-behalf queue, convert/decline refused, nudge crons skip it). NULL means the brokerage still owns the submission. Cleared if the agent hands the offer back.';
