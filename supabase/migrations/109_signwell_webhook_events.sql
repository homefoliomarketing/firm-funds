-- Migration 109: SignWell webhook event deduplication table
--
-- Mirrors migration 067 (docusign_webhook_events) for the SignWell e-sign
-- pilot. SignWell retries any webhook delivery the listener doesn't ACK with a
-- 2xx, and legitimately emits multiple events over a document's lifetime
-- (document_sent, document_viewed, document_signed per-signer, then a final
-- document_completed). The handler must process the terminal events exactly
-- once: re-downloading the merged signed PDF, inserting deal_documents rows,
-- and re-stamping signature timestamps on every retry would duplicate storage
-- objects and rows.
--
-- SignWell, unlike DocuSign Connect, does NOT send a stable per-delivery event
-- id. We therefore synthesize a dedup key from the (event.type, event.time,
-- document id) triple — the same triple SignWell HMAC-signs — which is unique
-- per logical event. The handler INSERTs that key at the start of processing;
-- if the INSERT fails with a unique violation (23505), the event has already
-- been processed and the handler returns 200 immediately. A transient
-- downstream failure DELETEs the dedup row and returns 503 so SignWell
-- redelivers. Successful events are retained for audit / replay protection.

CREATE TABLE IF NOT EXISTS signwell_webhook_events (
  event_id TEXT PRIMARY KEY,
  document_id TEXT,
  event_type TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_result TEXT,
  payload_summary JSONB
);

CREATE INDEX IF NOT EXISTS signwell_webhook_events_document_idx
  ON signwell_webhook_events(document_id);

CREATE INDEX IF NOT EXISTS signwell_webhook_events_received_idx
  ON signwell_webhook_events(received_at);

ALTER TABLE signwell_webhook_events ENABLE ROW LEVEL SECURITY;

-- Admin-only SELECT (for debugging webhook delivery issues).
-- INSERTs only happen via the service-role client in the webhook handler.
CREATE POLICY signwell_webhook_events_admin_select ON signwell_webhook_events
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('super_admin', 'firm_funds_admin')
    )
  );

COMMENT ON TABLE signwell_webhook_events IS
  'Idempotency log for SignWell webhook deliveries. SignWell sends no stable per-delivery event id, so event_id is the synthesized "${event.type}@${event.time}@${document id}" triple. The handler inserts on first receipt; subsequent retries with the same key are no-ops. See migration 109 and /api/signwell/webhook/route.ts.';
