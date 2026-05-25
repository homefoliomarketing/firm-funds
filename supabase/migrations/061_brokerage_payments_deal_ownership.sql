-- Migration 061: brokerage_payments INSERT must verify deal_id belongs to brokerage_id
--
-- AUDIT FINDING #14 (HIGH): the brokerage_payments_brokerage_insert policy
-- from migration 055 only checks that the new row's brokerage_id matches the
-- caller's brokerage_id. It does NOT check that the deal_id actually belongs
-- to that brokerage. A malicious brokerage admin can insert a fake payment
-- claim against ANOTHER brokerage's deal, and once a Firm Funds admin
-- confirms it (mistaking it for legit), the recompute_deal_repayment_amount
-- trigger credits the wrong brokerage's deal — wiping the real brokerage's
-- outstanding balance.
--
-- Fix: add an EXISTS clause that ties deal_id to brokerage_id at INSERT time.

DROP POLICY IF EXISTS brokerage_payments_brokerage_insert ON brokerage_payments;

CREATE POLICY brokerage_payments_brokerage_insert ON brokerage_payments
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.brokerage_id = brokerage_payments.brokerage_id
    )
    AND submitted_by_role = 'brokerage_admin'
    AND status = 'pending'
    AND EXISTS (
      SELECT 1 FROM deals d
      WHERE d.id = brokerage_payments.deal_id
        AND d.brokerage_id = brokerage_payments.brokerage_id
    )
  );
