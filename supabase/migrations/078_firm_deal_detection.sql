-- ============================================================================
-- Migration 078: Firm Deal Detection System
-- ============================================================================
-- Three new tables that power the automated firm-deal pipeline:
--   1. brokerage_pipes        per-brokerage intake config (sheet OR email)
--   2. firm_deal_events       every raw event ingested, parsed, matched, acted on
--   3. brokerage_name_mapping learned shorthand-to-agent mappings (review queue)
--
-- Plan reference: firm-deal-detection-plan.md
-- All three tables are admin-internal. RLS allows only firm_funds_admin /
-- super_admin reads and writes. Service role bypasses RLS as usual.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. brokerage_pipes
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brokerage_pipes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  pipe_type TEXT NOT NULL CHECK (pipe_type IN ('spreadsheet', 'email')),

  -- pipe-specific config (varies by pipe_type)
  -- spreadsheet: { sheet_id, sheet_url, trigger_type, conditional_tab, month_tab_pattern, column_mapping }
  -- email:       { bcc_local_part, dns_verified, allowed_senders }
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- white-label branding for outbound email + SMS
  brand_name TEXT,
  brand_tagline TEXT DEFAULT 'Powered by Firm Funds',

  -- operational mode: when false, parsed events queue for manual approval
  auto_fire_enabled BOOLEAN NOT NULL DEFAULT false,

  enabled BOOLEAN NOT NULL DEFAULT true,
  last_polled_at TIMESTAMPTZ,
  last_poll_state JSONB,  -- snapshot used for diff detection (row hashes etc.)

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- one active pipe per type per brokerage (you can disable old ones)
  CONSTRAINT brokerage_pipes_unique_active_type
    UNIQUE NULLS NOT DISTINCT (brokerage_id, pipe_type, enabled)
);

COMMENT ON TABLE brokerage_pipes IS
  'Per-brokerage intake configuration. Each brokerage can have a spreadsheet pipe, an email pipe, or both.';
COMMENT ON COLUMN brokerage_pipes.config IS
  'Pipe-specific settings as JSON. Spreadsheet: sheet_id, column_mapping, conditional_tab, month_tab_pattern. Email: bcc_local_part.';
COMMENT ON COLUMN brokerage_pipes.auto_fire_enabled IS
  'When false (default), parsed events land in a manual review queue. Flip to true once parser is trusted for this brokerage.';
COMMENT ON COLUMN brokerage_pipes.last_poll_state IS
  'Snapshot of last successful poll (row hashes by tab) so we only fire on new rows.';

CREATE INDEX IF NOT EXISTS idx_brokerage_pipes_brokerage
  ON brokerage_pipes(brokerage_id) WHERE enabled = true;

-- ----------------------------------------------------------------------------
-- 2. firm_deal_events
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS firm_deal_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  brokerage_pipe_id UUID NOT NULL REFERENCES brokerage_pipes(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('spreadsheet', 'email')),

  -- raw input as received (full email payload, full spreadsheet row, etc.)
  raw_payload JSONB NOT NULL,

  -- structured extract from the AI parser
  parsed JSONB NOT NULL DEFAULT '{}'::jsonb,
  parser_confidence TEXT CHECK (parser_confidence IN ('high', 'medium', 'low')),

  -- dedup hash: sha256(normalized_address + closing_date + price_bucket)
  deal_hash TEXT NOT NULL,

  status TEXT NOT NULL CHECK (status IN (
    'new',                -- just received, not yet parsed
    'parsed',             -- AI parse done
    'duplicate',          -- dedup hash matches an earlier event
    'unmatched',          -- name not in enrolled agents AND not in known-others
    'awaiting_approval',  -- in manual review queue (auto_fire_enabled = false)
    'approved',           -- admin clicked send
    'offer_sent',         -- notification (email + SMS) dispatched
    'rejected',           -- admin rejected in review queue
    'errored'             -- parsing or send failed
  )),

  -- matched agents (up to 2 for dual-side same-office deals)
  matched_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  second_matched_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

  -- once an offer is created, link to the advance deal record
  offer_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  second_offer_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,

  -- notification dispatch tracking
  email_sent_at TIMESTAMPTZ,
  sms_sent_at TIMESTAMPTZ,
  nudge_email_sent_at TIMESTAMPTZ,
  nudge_sms_sent_at TIMESTAMPTZ,

  -- error context
  error_message TEXT,

  -- manual review audit trail
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,

  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

COMMENT ON TABLE firm_deal_events IS
  'Every raw event ingested by any pipe. One row per detected deal trigger. Lifecycle: new -> parsed -> (matched|unmatched|duplicate) -> (awaiting_approval|offer_sent|rejected).';
COMMENT ON COLUMN firm_deal_events.deal_hash IS
  'sha256(normalized_address + closing_date + price_bucket_5k). Used to dedup multiple inputs (email + sheet) about the same firm deal.';

CREATE INDEX IF NOT EXISTS idx_firm_deal_events_hash
  ON firm_deal_events(deal_hash);
CREATE INDEX IF NOT EXISTS idx_firm_deal_events_status_recent
  ON firm_deal_events(status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_firm_deal_events_pipe
  ON firm_deal_events(brokerage_pipe_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_firm_deal_events_pending_review
  ON firm_deal_events(brokerage_id, status)
  WHERE status IN ('awaiting_approval', 'unmatched', 'errored');
CREATE INDEX IF NOT EXISTS idx_firm_deal_events_agent
  ON firm_deal_events(matched_agent_id) WHERE matched_agent_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. brokerage_name_mapping
-- ----------------------------------------------------------------------------
-- Learned mapping from a shorthand (as it appears on the sheet) to either:
--   - a single in-office agent     (resolution='agent', agent_id set)
--   - a multi-agent team           (resolution='team', team_agent_ids set)
--   - an outside brokerage / skip  (resolution='outside')
-- Built up over time through the review queue, not via upfront config.
CREATE TABLE IF NOT EXISTS brokerage_name_mapping (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  shorthand TEXT NOT NULL,
  shorthand_lower TEXT GENERATED ALWAYS AS (lower(shorthand)) STORED,

  resolution TEXT NOT NULL CHECK (resolution IN ('agent', 'team', 'outside')),

  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  team_agent_ids UUID[],

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- exactly one of agent_id / team_agent_ids must be set based on resolution
  CONSTRAINT brokerage_name_mapping_resolution_consistent CHECK (
    (resolution = 'agent'   AND agent_id IS NOT NULL AND team_agent_ids IS NULL) OR
    (resolution = 'team'    AND team_agent_ids IS NOT NULL AND array_length(team_agent_ids, 1) >= 2) OR
    (resolution = 'outside' AND agent_id IS NULL AND team_agent_ids IS NULL)
  )
);

-- case-insensitive uniqueness: one mapping per (brokerage, shorthand)
CREATE UNIQUE INDEX IF NOT EXISTS idx_brokerage_name_mapping_unique
  ON brokerage_name_mapping(brokerage_id, shorthand_lower);

CREATE INDEX IF NOT EXISTS idx_brokerage_name_mapping_agent
  ON brokerage_name_mapping(agent_id) WHERE agent_id IS NOT NULL;

COMMENT ON TABLE brokerage_name_mapping IS
  'Learned shorthand-to-resolution map per brokerage. Populated through the admin review queue, not upfront onboarding config.';

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at_now()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_brokerage_pipes_updated_at ON brokerage_pipes;
CREATE TRIGGER trg_brokerage_pipes_updated_at
  BEFORE UPDATE ON brokerage_pipes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_now();

DROP TRIGGER IF EXISTS trg_brokerage_name_mapping_updated_at ON brokerage_name_mapping;
CREATE TRIGGER trg_brokerage_name_mapping_updated_at
  BEFORE UPDATE ON brokerage_name_mapping
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_now();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- All three tables are admin-internal. Service role bypasses RLS.
-- ----------------------------------------------------------------------------
ALTER TABLE brokerage_pipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_deal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE brokerage_name_mapping ENABLE ROW LEVEL SECURITY;

CREATE POLICY brokerage_pipes_admin_all ON brokerage_pipes
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_profiles
            WHERE id = auth.uid()
              AND role IN ('super_admin', 'firm_funds_admin'))
  );

CREATE POLICY firm_deal_events_admin_all ON firm_deal_events
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_profiles
            WHERE id = auth.uid()
              AND role IN ('super_admin', 'firm_funds_admin'))
  );

CREATE POLICY brokerage_name_mapping_admin_all ON brokerage_name_mapping
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_profiles
            WHERE id = auth.uid()
              AND role IN ('super_admin', 'firm_funds_admin'))
  );
