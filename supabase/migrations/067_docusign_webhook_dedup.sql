-- Migration 067: DocuSign webhook event deduplication table
--
-- AUDIT FINDING #10 (CRITICAL): /api/docusign/webhook has no idempotency
-- protection. DocuSign Connect retries any delivery the listener doesn't ACK
-- in ~100s; aggregate mode legitimately sends recipient-completed AND
-- envelope-completed for the same envelope. Every retry re-downloads the
-- PDF (new path each time via Date.now() + uuid, so upsert never collides),
-- inserts a duplicate deal_documents row, and re-stamps signature timestamps.
-- A fast retry could race auto-checklist updates with manual admin actions.
--
-- Fix: persist DocuSign's event_id in a dedup table. The webhook handler
-- INSERTs at the start of processing; if the INSERT fails with unique
-- violation, the event has already been processed and the handler returns 200
-- immediately. Successful events are kept for 30 days for audit and idempotency
-- replay protection.

CREATE TABLE IF NOT EXISTS docusign_webhook_events (
  event_id TEXT PRIMARY KEY,
  envelope_id TEXT,
  event_type TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_result TEXT,
  payload_summary JSONB
);

CREATE INDEX IF NOT EXISTS docusign_webhook_events_envelope_idx
  ON docusign_webhook_events(envelope_id);

CREATE INDEX IF NOT EXISTS docusign_webhook_events_received_idx
  ON docusign_webhook_events(received_at);

ALTER TABLE docusign_webhook_events ENABLE ROW LEVEL SECURITY;

-- Admin-only SELECT (for debugging webhook delivery issues).
-- INSERTs only happen via the service-role client in the webhook handler.
CREATE POLICY docusign_webhook_events_admin_select ON docusign_webhook_events
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

COMMENT ON TABLE docusign_webhook_events IS
  'Idempotency log for DocuSign webhook deliveries. The handler inserts on first receipt of an event_id; subsequent retries with the same event_id are no-ops. See migration 067 and /api/docusign/webhook/route.ts.';
