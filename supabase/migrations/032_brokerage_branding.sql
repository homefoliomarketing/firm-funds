-- Migration 032: Brokerage white-label branding
-- Adds logo and brand color fields for brokerage-specific agent portal branding

ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS brand_color text DEFAULT '#5FA873';

-- Storage bucket for brokerage logos (public, 2MB, images only)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('brokerage-logos', 'brokerage-logos', true, 2097152, '{image/jpeg,image/png,image/svg+xml,image/webp}')
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read brokerage logos" ON storage.objects FOR SELECT USING (bucket_id = 'brokerage-logos');
CREATE POLICY "Admin upload brokerage logos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'brokerage-logos');
