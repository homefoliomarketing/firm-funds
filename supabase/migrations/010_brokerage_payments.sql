-- Migration 010: Add brokerage_payments JSONB column to deals
-- Tracks individual brokerage payments as an array of objects
-- Each object: { amount, date, reference?, method? }

ALTER TABLE deals
ADD COLUMN IF NOT EXISTS brokerage_payments JSONB DEFAULT '[]';

COMMENT ON COLUMN deals.brokerage_payments IS 'Array of brokerage payment objects: [{amount, date, reference?, method?}]';
