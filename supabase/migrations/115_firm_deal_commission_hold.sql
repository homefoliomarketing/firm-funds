-- 115_firm_deal_commission_hold.sql
--
-- "Wait one poll cycle for a missing commission."
--
-- When the firm-deal poller detects a deal that is matched and has a closing
-- date but NO commission amount yet, and the pipe maps commission columns, the
-- processor now parks the event in status 'commission_hold' instead of sending
-- immediately. One poll cycle later the poller re-reads the same row; if the
-- brokerage has since entered the commission the agent gets the richer Tier C
-- offer, otherwise the offer is released and sent without it (sparse).
--
-- This migration adds the 'commission_hold' status value and a timestamp
-- marking when the hold began (used to enforce the one-cycle wait and to let a
-- safety sweep release holds left behind by a disabled pipe).
--
-- See: lib/firm-deal-detection/commission-hold.ts, process-event.ts,
--      poll-spreadsheet.ts, app/api/cron/firm-deal-poller/route.ts.

ALTER TABLE firm_deal_events
  DROP CONSTRAINT IF EXISTS firm_deal_events_status_check;

ALTER TABLE firm_deal_events
  ADD CONSTRAINT firm_deal_events_status_check CHECK (status IN (
    'new',                -- just received, not yet parsed
    'parsed',             -- AI parse done
    'duplicate',          -- dedup hash matches an earlier event
    'unmatched',          -- name not in enrolled agents AND not in known-others
    'commission_hold',    -- matched + dateful but no commission; parked 1 cycle
    'awaiting_approval',  -- in manual review queue (auto_fire_enabled = false)
    'approved',           -- ready to dispatch (admin sent, or auto-fire)
    'offer_sent',         -- notification (email + SMS) dispatched
    'rejected',           -- admin rejected in review queue
    'errored'             -- parsing or send failed
  ));

ALTER TABLE firm_deal_events
  ADD COLUMN IF NOT EXISTS commission_hold_since TIMESTAMPTZ;

COMMENT ON COLUMN firm_deal_events.commission_hold_since IS
  'When a matched, dateful, commission-less firm deal was parked to wait one poll cycle for the brokerage to enter the commission (migration 115). NULL once released. See lib/firm-deal-detection/commission-hold.ts.';
