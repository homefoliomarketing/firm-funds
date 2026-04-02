-- =============================================================================
-- FIX: Supabase Storage Policies for 'deal-documents' bucket
-- =============================================================================
-- PASTE THIS INTO SUPABASE SQL EDITOR (one block at a time if needed)
-- This fixes the silent upload failure by ensuring proper storage policies.
-- =============================================================================

-- Step 1: Make sure the bucket exists and is configured correctly
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'deal-documents',
  'deal-documents',
  false,
  10485760,  -- 10MB limit
  ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'image/jpeg',
    'image/png',
    'image/gif'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'image/jpeg',
    'image/png',
    'image/gif'
  ];

-- Step 2: Drop any existing storage policies (clean slate)
DROP POLICY IF EXISTS "Authenticated users can upload deal documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can view deal documents" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete deal documents" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can upload" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view" ON storage.objects;
DROP POLICY IF EXISTS "Give users access to own folder" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated reads" ON storage.objects;

-- Step 3: Create correct storage policies

-- UPLOAD: Any authenticated user can upload to the deal-documents bucket
CREATE POLICY "Authenticated users can upload deal documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'deal-documents');

-- VIEW/DOWNLOAD: Any authenticated user can view/download from deal-documents
CREATE POLICY "Authenticated users can view deal documents"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'deal-documents');

-- UPDATE: Any authenticated user can update their uploads (needed for upsert)
CREATE POLICY "Authenticated users can update deal documents"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'deal-documents');

-- DELETE: Only admins can delete documents
CREATE POLICY "Admins can delete deal documents"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'deal-documents'
  AND EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
    AND role IN ('super_admin', 'firm_funds_admin')
  )
);
