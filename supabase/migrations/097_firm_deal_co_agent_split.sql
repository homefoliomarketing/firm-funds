-- ============================================================================
-- Migration 097: Track co-agent splits on firm_deal_events
-- ============================================================================
-- When the matcher detects a delimiter-separated cell like "Kyle/Tricia" on
-- one side of a deal, both agents go into matched_agent_id and
-- second_matched_agent_id. The dispatcher needs to know this so it picks
-- the generic email/SMS variant for both agents — we don't know how the
-- side's commission splits between the co-agents, so quoting numbers
-- would be wrong.
--
-- A single boolean on the event is enough: per Phase 1 the split case
-- always means "both matched agents share one side of the deal". If we
-- ever add a 3+ agent path we can extend with per-agent metadata.
--
-- Default false so existing rows (legitimately matched single agents or
-- dual-agency with different agents on each side) preserve their current
-- detailed/per-side variant selection.
-- ============================================================================

ALTER TABLE firm_deal_events
  ADD COLUMN IF NOT EXISTS co_agent_split BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN firm_deal_events.co_agent_split IS
  'true when the match step found 2+ enrolled agents in a single delimiter-separated cell (Kyle/Tricia etc). Both agents land in matched_agent_id + second_matched_agent_id and the dispatcher uses the generic email/SMS variant for both. See lib/firm-deal-detection/match-agents.ts matchEvent().';
