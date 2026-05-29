-- ============================================================================
-- Migration 096: Track agent-triggered manual brokerage nudges
-- ============================================================================
-- The offered-deal flow already nudges the brokerage automatically at 2 hours
-- (sendBrokerageOfferNudge2h, stamped in deals.brokerage_nudge_2h_at). When
-- an agent is anxious that their brokerage hasn't acted yet, the agent deal
-- detail page exposes a "Remind my brokerage" button that fires the same
-- nudge email manually.
--
-- This column records when the agent last fired that manual nudge, so the
-- server action can rate-limit (one manual nudge per 6 hours per deal). The
-- automated 2h cron is independent and keeps using brokerage_nudge_2h_at as
-- its single-fire gate.
--
-- Nullable: most offered deals will never see a manual nudge fired.
-- ============================================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS last_manual_nudge_at TIMESTAMPTZ;

COMMENT ON COLUMN deals.last_manual_nudge_at IS
  'When the agent last manually fired the brokerage nudge from the offered-deal page. Used to rate-limit manual nudges to at most once per 6 hours. Independent of brokerage_nudge_2h_at (automated 2h cron).';
