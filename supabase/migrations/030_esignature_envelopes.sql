-- 030: E-signature envelope tracking
-- Tracks DocuSign envelopes sent for each deal (CPA + IDP)

CREATE TABLE esignature_envelopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  envelope_id TEXT NOT NULL,                          -- DocuSign envelope ID
  document_type TEXT NOT NULL CHECK (document_type IN ('cpa', 'idp')),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'signed', 'declined', 'voided')),
  -- Signer tracking
  agent_signer_status TEXT DEFAULT 'pending' CHECK (agent_signer_status IN ('pending', 'sent', 'delivered', 'signed', 'declined')),
  agent_signed_at TIMESTAMPTZ,
  brokerage_signer_status TEXT CHECK (brokerage_signer_status IN ('pending', 'sent', 'delivered', 'signed', 'declined')),
  brokerage_signed_at TIMESTAMPTZ,
  -- Metadata
  sent_by UUID REFERENCES auth.users(id),             -- Admin who triggered the send
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  envelope_uri TEXT,                                   -- DocuSign URI for fetching envelope
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast deal lookups
CREATE INDEX idx_esignature_envelopes_deal_id ON esignature_envelopes(deal_id);
CREATE INDEX idx_esignature_envelopes_envelope_id ON esignature_envelopes(envelope_id);

-- Updated_at trigger
CREATE TRIGGER update_esignature_envelopes_updated_at
  BEFORE UPDATE ON esignature_envelopes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- DocuSign OAuth token storage (single row — admin account)
CREATE TABLE docusign_tokens (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),    -- Force single row
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  expires_at TIMESTAMPTZ NOT NULL,
  account_id TEXT NOT NULL,                            -- DocuSign account ID
  base_uri TEXT NOT NULL,                              -- DocuSign base URI for API calls
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: Only service role should access these tables
ALTER TABLE esignature_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE docusign_tokens ENABLE ROW LEVEL SECURITY;

-- No RLS policies = only service role can access (which is what we want)
