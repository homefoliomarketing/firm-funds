-- =============================================================================
-- Migration 108: Human-readable Deal Numbers
-- =============================================================================
-- Every submitted deal gets a sequential, date-stamped tracking number in the
-- format NNNN-MMDD-YY. Example: 0001-0609-26 is the first deal submitted on
-- June 9, 2026; 0003-0610-26 is the third deal submitted on June 10, 2026.
-- The NNNN sequence resets every day. The date is the Toronto
-- (America/Toronto) calendar date at the moment of submission, matching the
-- timezone convention used everywhere else in the app (see lib/calculations.ts).
--
-- "Submitted" = the moment a deal's status becomes anything other than
-- 'offered' (i.e. under_review and onward). Firm-deal OFFERS (status='offered')
-- are leads, not deals, and deliberately get NO number until actually
-- submitted, so an offer the brokerage never acts on never burns a number and
-- the number's date always matches the real submission date.
--
-- Assignment is done by a BEFORE INSERT OR UPDATE trigger so EVERY creation
-- path (agent self-submit, brokerage submit-on-behalf, firm-deal offer
-- conversion, the seed route, and any future path) is covered automatically.
-- A dedicated per-day counter table makes concurrent submissions collision-proof.
-- =============================================================================

-- 1. Columns on deals -----------------------------------------------------------
ALTER TABLE deals ADD COLUMN IF NOT EXISTS deal_number TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

COMMENT ON COLUMN deals.deal_number IS
  'Human-readable tracking number assigned at submission, format NNNN-MMDD-YY (daily sequence resets each Toronto day). NULL for unsubmitted firm-deal offers.';
COMMENT ON COLUMN deals.submitted_at IS
  'Timestamp the deal was first submitted (status left ''offered''); set alongside deal_number by the assign_deal_number trigger.';

-- Unique index. Postgres UNIQUE allows multiple NULLs, so unsubmitted offers
-- (deal_number IS NULL) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS deals_deal_number_key ON deals (deal_number);

-- 2. Per-day counter table ------------------------------------------------------
-- One row per Toronto calendar date; last_seq is the highest sequence handed
-- out that day. Written only by the assign_deal_number() trigger.
CREATE TABLE IF NOT EXISTS deal_number_counters (
  date_key   date PRIMARY KEY,
  last_seq   integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE deal_number_counters IS
  'Atomic daily sequence source for deals.deal_number. One row per Toronto calendar date. Written only by the assign_deal_number() trigger; never touched directly by clients.';

-- Lock it down: no API client touches this directly. The SECURITY DEFINER
-- trigger function below bypasses RLS, so leaving it with no policies = deny all.
ALTER TABLE deal_number_counters ENABLE ROW LEVEL SECURITY;

-- 3. Trigger function: stamp deal_number + submitted_at atomically ---------------
CREATE OR REPLACE FUNCTION assign_deal_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_date_key date;
  v_seq integer;
BEGIN
  -- Never overwrite an existing number (idempotent across re-updates).
  IF NEW.deal_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Firm-deal OFFERS are leads, not submitted deals: no number yet.
  IF NEW.status = 'offered' THEN
    RETURN NEW;
  END IF;

  -- Toronto calendar date at the moment of submission.
  v_date_key := (now() AT TIME ZONE 'America/Toronto')::date;

  -- Atomic per-day increment. The upsert row-locks the date_key row, so two
  -- concurrent submissions on the same day always get distinct sequences.
  INSERT INTO public.deal_number_counters AS c (date_key, last_seq, updated_at)
  VALUES (v_date_key, 1, now())
  ON CONFLICT (date_key)
  DO UPDATE SET last_seq = c.last_seq + 1, updated_at = now()
  RETURNING c.last_seq INTO v_seq;

  NEW.deal_number :=
       lpad(v_seq::text, 4, '0')
    || '-' || to_char(v_date_key, 'MMDD')
    || '-' || to_char(v_date_key, 'YY');

  IF NEW.submitted_at IS NULL THEN
    NEW.submitted_at := now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION assign_deal_number() FROM PUBLIC;

COMMENT ON FUNCTION assign_deal_number() IS
  'BEFORE INSERT/UPDATE OF status trigger on deals: stamps deal_number (NNNN-MMDD-YY, Toronto day) and submitted_at the first time a deal is non-offered. Idempotent; concurrency-safe via the deal_number_counters upsert row lock.';

-- 4. Trigger --------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_assign_deal_number ON deals;
CREATE TRIGGER trg_assign_deal_number
  BEFORE INSERT OR UPDATE OF status ON deals
  FOR EACH ROW
  EXECUTE FUNCTION assign_deal_number();

-- 5. Backfill any pre-existing submitted deals ----------------------------------
-- Safe no-op when the table is empty. Assigns numbers to existing non-offered
-- deals in created_at order, partitioned by their Toronto creation day. Writes
-- deal_number directly (does not touch status, so the trigger does not fire).
WITH ordered AS (
  SELECT
    id,
    (created_at AT TIME ZONE 'America/Toronto')::date AS d,
    row_number() OVER (
      PARTITION BY (created_at AT TIME ZONE 'America/Toronto')::date
      ORDER BY created_at, id
    ) AS seq
  FROM deals
  WHERE deal_number IS NULL
    AND status <> 'offered'
)
UPDATE deals dl
SET deal_number = lpad(o.seq::text, 4, '0')
              || '-' || to_char(o.d, 'MMDD')
              || '-' || to_char(o.d, 'YY'),
    submitted_at = COALESCE(dl.submitted_at, dl.created_at)
FROM ordered o
WHERE dl.id = o.id;

-- Seed the counter so the next deal submitted on a backfilled day continues
-- that day's sequence instead of restarting at 0001.
INSERT INTO deal_number_counters (date_key, last_seq, updated_at)
SELECT (created_at AT TIME ZONE 'America/Toronto')::date AS d,
       count(*) AS last_seq,
       now()
FROM deals
WHERE deal_number IS NOT NULL
GROUP BY (created_at AT TIME ZONE 'America/Toronto')::date
ON CONFLICT (date_key) DO UPDATE
  SET last_seq = GREATEST(deal_number_counters.last_seq, EXCLUDED.last_seq);
