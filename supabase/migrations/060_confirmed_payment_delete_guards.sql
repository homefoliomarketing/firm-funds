-- Migration 060: prevent DELETE of confirmed EFT transfers and brokerage payments
--
-- AUDIT FINDING #4 (CRITICAL): removeEftTransfer in admin-actions performs a
-- plain DELETE on eft_transfers with no check that confirmed=false. A
-- confirmed $25k wire can be erased silently. The audit log captures the
-- event, but deals.repayment_amount (computed via trigger on
-- brokerage_payments) and deal funding state derived from eft_transfers
-- desync immediately.
--
-- Defense in depth: enforce the rule in the database so a refactor that
-- removes the JS-side check (or a misclick on a stale tab) can't get past it.
-- Confirmed financial records require an explicit reversal flow, not a hard
-- DELETE. The trigger below RAISEs on any DELETE of a confirmed row from
-- either table.
--
-- Service role can still bypass this trigger? NO — triggers fire regardless
-- of the caller. Even service-role mutations must respect this rule. If a
-- genuine void is needed, add a 'voided_at' column and flip it via UPDATE.

CREATE OR REPLACE FUNCTION prevent_confirmed_eft_delete() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.confirmed = TRUE THEN
    RAISE EXCEPTION
      'Cannot DELETE confirmed eft_transfers row %. Confirmed transfers must be voided via UPDATE, not deleted.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS prevent_confirmed_eft_delete_trigger ON eft_transfers;
CREATE TRIGGER prevent_confirmed_eft_delete_trigger
  BEFORE DELETE ON eft_transfers
  FOR EACH ROW EXECUTE FUNCTION prevent_confirmed_eft_delete();

COMMENT ON FUNCTION prevent_confirmed_eft_delete() IS
  'Blocks DELETE on eft_transfers rows where confirmed=true. See migration 060.';

-- Same protection for brokerage_payments — once a payment is confirmed it
-- represents money received and cannot be erased. The deals.repayment_amount
-- trigger from migration 055 also depends on these rows being immutable
-- after confirmation.
CREATE OR REPLACE FUNCTION prevent_confirmed_brokerage_payment_delete() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION
      'Cannot DELETE confirmed brokerage_payments row %. Confirmed payments must be voided via UPDATE, not deleted.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS prevent_confirmed_brokerage_payment_delete_trigger ON brokerage_payments;
CREATE TRIGGER prevent_confirmed_brokerage_payment_delete_trigger
  BEFORE DELETE ON brokerage_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_confirmed_brokerage_payment_delete();

COMMENT ON FUNCTION prevent_confirmed_brokerage_payment_delete() IS
  'Blocks DELETE on brokerage_payments rows where status=confirmed. See migration 060.';
