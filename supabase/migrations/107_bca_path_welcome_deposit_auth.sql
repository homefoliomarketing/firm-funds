-- ============================================================================
-- Migration 107: signed-BCA storage path, first-login welcome flag,
--                deposit-authorization consent
-- ============================================================================
-- Three small, independent additions that back three UI fixes:
--
-- 1. brokerages.bca_signed_pdf_path
--    The DocuSign webhook already uploads the signed BCA PDF to storage but
--    never recorded WHERE, so it was unretrievable. A BCA is brokerage-level
--    (no deal_id), so it can't live in deal_documents. Store the one signed
--    file directly on the brokerage row.
--
-- 2. user_profiles.welcomed_at
--    Lets the dashboard say "Welcome, {name}" on a user's first visit and
--    "Welcome back, {name}" thereafter. NULL = never welcomed yet. Stamped once
--    by a server action after the first dashboard render (same pattern as the
--    KYC modal "seen" flag).
--
-- 3. agents.deposit_authorized_at / deposit_authorized_by
--    Records the mandatory "I authorize Firm Funds Inc. to deposit payments into
--    this account" consent the agent must give during onboarding alongside their
--    void cheque / direct deposit authorization upload (reuses the existing
--    preauth_form_path column + agent-preauth-forms bucket for the file itself).
-- ============================================================================

-- 1. Signed BCA PDF path (brokerage-level "one file")
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS bca_signed_pdf_path TEXT;

-- 2. First-login welcome flag
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS welcomed_at TIMESTAMPTZ;

-- 3. Deposit-authorization consent (banking direct-deposit)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deposit_authorized_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deposit_authorized_by UUID REFERENCES auth.users(id);
