-- ============================================================================
-- Migration 110: Optional brokerage flat fee on deals
-- ============================================================================
-- Some brokerages charge a flat transaction/admin fee instead of (or in
-- addition to) a percentage split. This adds a per-deal flat dollar fee that is
-- deducted from the commission alongside the percentage split:
--
--   net_commission = gross_commission * (1 - brokerage_split_pct/100)
--                    - brokerage_flat_fee
--
-- Defaults to 0 so every existing deal and every percentage-only deal is
-- completely unchanged. The split percentage stays the primary control; the
-- flat fee is purely additive (set the split to 0 for a flat-fee-only brokerage).
-- ============================================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS brokerage_flat_fee numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN deals.brokerage_flat_fee IS
  'Optional flat dollar fee the brokerage deducts IN ADDITION to brokerage_split_pct. Subtracted from net commission in lib/calculations.ts. 0 = none. Captured per-deal at submission, NOT a brokerage default.';
