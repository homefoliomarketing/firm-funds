-- 038: Brokerage address breakdown (city, province, postal code)
-- + temporarily allow agents without email for testing

-- Brokerage address fields
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS province TEXT;
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS postal_code TEXT;

-- ⚠️ TEMPORARY FOR TESTING: Allow agents without email
-- REVERT BEFORE GO-LIVE: ALTER TABLE agents ALTER COLUMN email SET NOT NULL;
ALTER TABLE agents ALTER COLUMN email DROP NOT NULL;
