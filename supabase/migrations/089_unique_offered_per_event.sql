-- ============================================================================
-- Migration 089: Prevent duplicate 'offered' deals per (event, agent)
-- ============================================================================
-- Race condition surfaced in firm-deal-offer-actions: when an agent
-- double-clicks the offer CTA the server action can insert two 'offered'
-- deals against the same firm_deal_event_id + agent_id. Downstream we end
-- up emailing the brokerage twice and showing two "New Deal" cards in the
-- portal.
--
-- A partial UNIQUE index keyed on (offered_event_id, agent_id) WHERE
-- status='offered' makes the second insert hard-fail with a 23505 the
-- action can swallow and treat as success ("already offered").
--
-- Why partial: once a deal transitions out of 'offered' (to under_review
-- after the brokerage submits, or cancelled if declined) we WANT to allow
-- a future re-offer if the original is cancelled. Restricting to status=
-- 'offered' lets us re-attempt cleanly.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS deals_unique_offered_per_event_and_agent
  ON deals (offered_event_id, agent_id)
  WHERE status = 'offered';

COMMENT ON INDEX deals_unique_offered_per_event_and_agent IS
  'Partial unique index: at most one offered deal per (firm_deal_event, agent). Acceptance handler relies on this to swallow double-click races. See migration 089.';
