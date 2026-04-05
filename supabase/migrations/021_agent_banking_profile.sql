-- Migration 021: Agent Banking & Profile Fields
-- Adds banking info (admin-entered), address fields, and preauthorized form upload path

-- Banking fields (entered by admin after reviewing preauthorized form)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bank_transit_number TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bank_institution_number TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_verified_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS banking_verified_by UUID REFERENCES auth.users(id);

-- Preauthorized debit form upload (agent uploads, admin reviews)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS preauth_form_path TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS preauth_form_uploaded_at TIMESTAMPTZ;

-- Profile address fields
ALTER TABLE agents ADD COLUMN IF NOT EXISTS address_street TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS address_city TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS address_province TEXT DEFAULT 'Ontario';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS address_postal_code TEXT;

-- Add CHECK constraints for banking field formats
ALTER TABLE agents ADD CONSTRAINT chk_transit_number
  CHECK (bank_transit_number IS NULL OR (LENGTH(bank_transit_number) = 5 AND bank_transit_number ~ '^\d{5}$'));

ALTER TABLE agents ADD CONSTRAINT chk_institution_number
  CHECK (bank_institution_number IS NULL OR (LENGTH(bank_institution_number) = 3 AND bank_institution_number ~ '^\d{3}$'));

ALTER TABLE agents ADD CONSTRAINT chk_account_number
  CHECK (bank_account_number IS NULL OR (LENGTH(bank_account_number) BETWEEN 7 AND 12 AND bank_account_number ~ '^\d{7,12}$'));

-- Create storage bucket for preauth forms (if not exists)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'agent-preauth-forms',
  'agent-preauth-forms',
  false,
  10485760, -- 10MB
  ARRAY['application/pdf', 'image/jpeg', 'image/png']
)
ON CONFLICT (id) DO NOTHING;

-- Storage policy: agents can upload their own preauth form
CREATE POLICY "Agents can upload own preauth form"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'agent-preauth-forms'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Storage policy: agents can view their own preauth form
CREATE POLICY "Agents can view own preauth form"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'agent-preauth-forms'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Storage policy: admins can view all preauth forms
CREATE POLICY "Admins can view all preauth forms"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'agent-preauth-forms'
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('super_admin', 'firm_funds_admin')
    )
  );
