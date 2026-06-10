/**
 * Shared e-signature provider configuration.
 *
 * Firm Funds is migrating from DocuSign to SignWell. To make the cutover safe
 * and reversible, the active provider is chosen at runtime by the ESIGN_PROVIDER
 * env var. DocuSign remains the default until a real SignWell send has been
 * validated in production; flip ESIGN_PROVIDER=signwell to switch.
 *
 * This module is intentionally tiny and dependency-free so both the contract
 * generator (lib/contract-docx.ts) and the SignWell client (lib/signwell.ts)
 * can import it without a circular dependency.
 */

export type EsignProvider = 'signwell' | 'docusign'

/** Active e-signature provider. Defaults to 'docusign' unless explicitly set to 'signwell'. */
export function getEsignProvider(): EsignProvider {
  return process.env.ESIGN_PROVIDER?.toLowerCase() === 'signwell' ? 'signwell' : 'docusign'
}

/**
 * Pixel sizes for SignWell hidden text-tag fields.
 *
 * SignWell sizes a field to the rendered footprint of its placeholder text. Our
 * tags are hidden (white, 1-2pt), so without an explicit size the field would be
 * a tiny unusable dot. Positions 7 and 8 of the text-tag grammar
 * ({{Type:Signer:Required:Label:Prefill:ApiID:Width:Height}}) override the size.
 * Signatures/initials are capped at 200px tall by SignWell. These match the
 * sizes visually confirmed as good in the SignWell POC (scripts/signwell-poc.mts).
 */
export const SIGNWELL_FIELD_SIZE = {
  signature: { w: 240, h: 48 },
  initial: { w: 80, h: 40 },
  date: { w: 150, h: 34 },
} as const
