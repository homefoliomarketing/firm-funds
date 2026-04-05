-- 029: Add broker of record fields to brokerages
-- The Broker of Record is the legal authority who signs the Brokerage Cooperation Agreement.
-- Distinct from brokerage admin users who manage day-to-day portal operations.

ALTER TABLE brokerages
  ADD COLUMN broker_of_record_name TEXT,
  ADD COLUMN broker_of_record_email TEXT;

COMMENT ON COLUMN brokerages.broker_of_record_name IS 'Legal name of the Broker of Record — signs BCA, receives legal/compliance communications';
COMMENT ON COLUMN brokerages.broker_of_record_email IS 'Email for the Broker of Record — used for BCA signing, IDP copy notifications, compliance matters';
