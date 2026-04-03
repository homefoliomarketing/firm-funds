-- ============================================================================
-- Migration 011: FINTRAC KYC Fields for Brokerages and Agents
-- ============================================================================
-- Adds KYC verification tracking to brokerages and agents for FINTRAC
-- compliance as a reporting entity (factoring company) under the PCMLTFA.
-- ============================================================================

-- ---- Brokerage KYC fields ----
ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS kyc_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS kyc_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_verified_by text,
  ADD COLUMN IF NOT EXISTS reco_registration_number text,
  ADD COLUMN IF NOT EXISTS reco_verification_date date,
  ADD COLUMN IF NOT EXISTS reco_verification_notes text;

-- ---- Agent KYC fields ----
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS kyc_status text DEFAULT 'pending'
    CHECK (kyc_status IN ('pending', 'submitted', 'verified', 'rejected')),
  ADD COLUMN IF NOT EXISTS kyc_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_verified_by text,
  ADD COLUMN IF NOT EXISTS kyc_document_path text,
  ADD COLUMN IF NOT EXISTS kyc_document_type text,
  ADD COLUMN IF NOT EXISTS kyc_rejection_reason text;

-- ---- Create agent-kyc storage bucket (if not exists) ----
-- NOTE: This needs to be run separately in Supabase Dashboard > Storage
-- or via the Supabase API. SQL doesn't directly create storage buckets.
-- The bucket name should be: agent-kyc
-- Public: NO (private bucket)
-- File size limit: 10MB
-- Allowed MIME types: image/jpeg, image/png, application/pdf

-- ---- RLS policies for agent KYC access ----
-- Agents can read their own KYC document
-- Admins can read all KYC documents
-- These will be applied to the agent-kyc storage bucket via Supabase Dashboard

COMMENT ON COLUMN agents.kyc_status IS 'FINTRAC KYC status: pending (not started), submitted (ID uploaded, awaiting review), verified (approved by admin), rejected (admin rejected, needs re-upload)';
COMMENT ON COLUMN agents.kyc_document_path IS 'Supabase Storage path to the uploaded government photo ID (in agent-kyc bucket)';
COMMENT ON COLUMN agents.kyc_document_type IS 'Type of government ID: drivers_license, passport, ontario_photo_card, permanent_resident_card, citizenship_card';
COMMENT ON COLUMN brokerages.kyc_verified IS 'Whether brokerage has been verified on the RECO public register';
