-- Migration 063: add soft-delete columns to agents and brokerages
--
-- AUDIT FINDING #16 (HIGH): permanentlyDeleteAgent / permanentlyDeleteBrokerage
-- hard-DELETE records with no undo. Combined with FK cascades (partially fixed
-- in migration 062), an admin misclick can permanently destroy an agent, all
-- their ledger history, and any related auth users — with no recovery path
-- short of restoring from backup.
--
-- Fix: add a deleted_at TIMESTAMPTZ column to both tables and migrate the
-- 'archived' status to a soft-delete pattern. Code updates (see commit) make
-- the delete actions set deleted_at instead of issuing DELETE; queries that
-- list active agents/brokerages filter deleted_at IS NULL.
--
-- Hard-deletion is preserved as an explicit purge path for the
-- already-soft-deleted (>30d), gated by a cron job.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agents_active_idx
  ON agents(id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS brokerages_active_idx
  ON brokerages(id) WHERE deleted_at IS NULL;

COMMENT ON COLUMN agents.deleted_at IS
  'Soft-delete timestamp. NULL = active. Code that lists active agents must filter deleted_at IS NULL. Hard purge happens via a separate cron after 30 days.';

COMMENT ON COLUMN brokerages.deleted_at IS
  'Soft-delete timestamp. NULL = active. Code that lists active brokerages must filter deleted_at IS NULL. Hard purge happens via a separate cron after 30 days.';
