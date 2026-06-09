-- ============================================================================
-- Migration 104: brokerages.og_image_url
-- ============================================================================
-- Public PNG of the brokerage's white-label logo, sized for social / SMS
-- link-preview cards (Open Graph). Needed because the auto-generated logo_url
-- is an SVG, and messaging apps (iMessage, Google Messages / RCS, WhatsApp)
-- will not render an SVG as an og:image. The firm-deal offer link
-- (app/agent/firm-deal/[token]) serves this as og:image so the SMS / email
-- preview card shows the brokerage's own brand instead of generic Firm Funds.
--
-- Raster companion to logo_url. Populated by scripts/generate-og-logo.mts
-- (and, going forward, by brokerage onboarding). Nullable: when absent the
-- offer page falls back to the Firm Funds icon.
-- ============================================================================
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS og_image_url text;

COMMENT ON COLUMN brokerages.og_image_url IS
  'Public PNG of the white-label logo for social/SMS link-preview cards (Open Graph). Raster companion to logo_url (SVG). Used by app/agent/firm-deal/[token] as og:image.';
