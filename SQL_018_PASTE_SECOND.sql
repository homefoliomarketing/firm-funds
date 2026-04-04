-- ============================================================================
-- Migration 018: Agent Account Balances, Transaction Ledger, Invoices,
--                Deal Messages, and Document Returns
-- ============================================================================

-- ============================================================================
-- 1. Agent Account Balance (add to agents table)
-- ============================================================================
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS account_balance NUMERIC(12,2) DEFAULT 0;

COMMENT ON COLUMN agents.account_balance IS 'Running account balance for the agent. Positive = agent owes Firm Funds. Negative = credit.';

-- ============================================================================
-- 2. Agent Transaction Ledger
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN (
    'late_closing_interest',
    'balance_deduction',
    'invoice_payment',
    'adjustment',
    'credit'
  )),
  amount NUMERIC(12,2) NOT NULL,
  running_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  reference_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_transactions_agent ON agent_transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_transactions_deal ON agent_transactions(deal_id);
CREATE INDEX IF NOT EXISTS idx_agent_transactions_type ON agent_transactions(type);

-- RLS: Agents see their own transactions, admins see all
ALTER TABLE agent_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_transactions_agent_read ON agent_transactions
  FOR SELECT USING (
    agent_id IN (
      SELECT agent_id FROM user_profiles WHERE id = auth.uid() AND role = 'agent'
    )
  );

CREATE POLICY agent_transactions_admin_all ON agent_transactions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- ============================================================================
-- 3. Agent Invoices
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL UNIQUE,
  amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue', 'cancelled')),
  due_date DATE NOT NULL,
  paid_at TIMESTAMPTZ,
  paid_amount NUMERIC(12,2),
  sent_at TIMESTAMPTZ,
  notes TEXT,
  -- Invoice details (snapshot at time of creation)
  agent_name TEXT NOT NULL,
  agent_email TEXT NOT NULL,
  agent_phone TEXT,
  line_items JSONB NOT NULL DEFAULT '[]',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_invoices_agent ON agent_invoices(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_invoices_status ON agent_invoices(status);

ALTER TABLE agent_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_invoices_agent_read ON agent_invoices
  FOR SELECT USING (
    agent_id IN (
      SELECT agent_id FROM user_profiles WHERE id = auth.uid() AND role = 'agent'
    )
  );

CREATE POLICY agent_invoices_admin_all ON agent_invoices
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- Sequence for invoice numbers (FF-2026-0001, FF-2026-0002, etc.)
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- ============================================================================
-- 4. Deal Messages (admin→agent communication with email triggers)
-- ============================================================================
CREATE TABLE IF NOT EXISTS deal_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  sender_id UUID,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('admin', 'agent')),
  sender_name TEXT,
  message TEXT NOT NULL,
  is_email_reply BOOLEAN DEFAULT FALSE,
  email_message_id TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_messages_deal ON deal_messages(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_messages_sender ON deal_messages(sender_id);

ALTER TABLE deal_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY deal_messages_agent_read ON deal_messages
  FOR SELECT USING (
    deal_id IN (
      SELECT id FROM deals WHERE agent_id IN (
        SELECT agent_id FROM user_profiles WHERE id = auth.uid() AND role = 'agent'
      )
    )
  );

CREATE POLICY deal_messages_agent_insert ON deal_messages
  FOR INSERT WITH CHECK (
    sender_role = 'agent' AND
    deal_id IN (
      SELECT id FROM deals WHERE agent_id IN (
        SELECT agent_id FROM user_profiles WHERE id = auth.uid() AND role = 'agent'
      )
    )
  );

CREATE POLICY deal_messages_admin_all ON deal_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- ============================================================================
-- 5. Document Returns (return incorrect/incomplete docs to agents)
-- ============================================================================
CREATE TABLE IF NOT EXISTS document_returns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES deal_documents(id) ON DELETE CASCADE,
  returned_by UUID NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  resolved_at TIMESTAMPTZ,
  resolved_document_id UUID REFERENCES deal_documents(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_returns_deal ON document_returns(deal_id);
CREATE INDEX IF NOT EXISTS idx_document_returns_status ON document_returns(status);

ALTER TABLE document_returns ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_returns_agent_read ON document_returns
  FOR SELECT USING (
    deal_id IN (
      SELECT id FROM deals WHERE agent_id IN (
        SELECT agent_id FROM user_profiles WHERE id = auth.uid() AND role = 'agent'
      )
    )
  );

CREATE POLICY document_returns_admin_all ON document_returns
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('super_admin', 'firm_funds_admin')
    )
  );

-- ============================================================================
-- 6. Late closing tracking fields on deals
-- ============================================================================
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS actual_closing_date DATE,
  ADD COLUMN IF NOT EXISTS late_interest_charged NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_interest_calculated_at TIMESTAMPTZ;

COMMENT ON COLUMN deals.actual_closing_date IS 'The real closing date (may differ from original closing_date if deal closed late)';
COMMENT ON COLUMN deals.late_interest_charged IS 'Total late closing interest charged for this deal';
