/**
 * Brokerage logo generator — Variant B (F-mark crown + wordmark + Powered by Firm Funds)
 *
 * Pure function. Takes a brokerage name and returns an SVG string suitable for
 * uploading to the brokerage-logos Supabase storage bucket and using as the
 * brokerage's logo_url.
 *
 * Layout:
 *   [F-arrow mark]
 *   BROKERAGE NAME (wrapped to 2 lines if long, green)
 *   POWERED BY FIRM FUNDS (small tagline)
 *
 * Colors by background:
 *   - dark:  F-mark light grey, tagline light grey, name Firm Funds green
 *   - light: F-mark black, tagline brand grey, name Firm Funds green
 *   - transparent: same as dark (light grey works on any dark/transparent)
 */

export type LogoBackground = 'dark' | 'light' | 'transparent'

export interface BrokerageLogoOptions {
  /** Background the logo will be displayed on. Affects F-mark and tagline color. */
  background?: LogoBackground
  /** Max width in px for wrap/font-size calculations. Default 480. */
  maxWidth?: number
  /**
   * Big Shoulders Display weight for the brokerage wordmark. Default
   * NAME_FONT_WEIGHT. Lower = thinner strokes. Exposed so callers can override
   * the weight (e.g. to render side-by-side comparisons) without editing here.
   */
  nameFontWeight?: number
}

// Wordmark stroke weight. History: started at 900, narrowed to 700, then to
// 500 (Bud still found 700 too thick). Big Shoulders Display supports 100-900.
export const NAME_FONT_WEIGHT = 500

// ============================================================================
// Color palette (matches Firm Funds brand: see public/brand/svg file.svg and
// lib/constants.ts BRAND_GREEN_HEX)
// ============================================================================

const FF_GREEN = '#5FA873'      // brokerage name
const FF_BLACK = '#0a0a0a'      // F-mark on white backgrounds (per Bud's preference)
const FF_GREY_DARK = '#636361'  // tagline on light backgrounds (matches original logo)
const FF_GREY_LIGHT = '#d4d4d4' // F-mark + tagline on dark backgrounds

// ============================================================================
// Character-width approximation for Big Shoulders Display
// ============================================================================
// Measured empirically from rendered samples. Returns width in em units
// (multiply by font-size to get pixel width). Lighter weights are slightly
// narrower, so at weight 500 this table marginally overestimates width — which
// is the safe direction (it errs toward a smaller font / earlier wrap, never an
// overflow). Kept stable so wrap behavior doesn't shift between weights.

function charWidthEm(ch: string): number {
  if (ch === ' ') return 0.25
  const c = ch.toUpperCase()
  if ('MW'.includes(c)) return 0.74
  if ('IJ'.includes(c)) return 0.27
  if ('1'.includes(c)) return 0.36
  if ('FLT'.includes(c)) return 0.44
  if ('BCDGHKNOPQRSUVXYZ23456789'.includes(c)) return 0.52
  if ('AER'.includes(c)) return 0.55
  return 0.49
}

// Tracking applied to the wordmark (em units). Mirrors the inline CSS on the
// <text> element so the wrap math stays in sync if either changes.
const NAME_TRACKING_EM = 0.03

function approxLineWidth(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) width += charWidthEm(ch)
  // Account for letter-spacing: each glyph contributes one tracking gap, and
  // the gap between glyphs adds (n-1) extra em widths. Approximating with n
  // is close enough at this scale.
  width += text.length * NAME_TRACKING_EM
  return width * fontSize
}

// ============================================================================
// Name wrapping
// ============================================================================
// Rules:
//   - 1 word: never wrap
//   - 2 words: wrap only if doesn't fit single-line at largest size
//   - 3+ words: try single line first, then split with last word alone,
//     then split balanced
//
// Returns the lines and the chosen font-size that fits maxWidth.

function fitName(name: string, maxWidth: number, maxFontSize = 84, minFontSize = 48): {
  lines: string[]
  fontSize: number
} {
  const cleaned = name.trim().replace(/\s+/g, ' ')
  const words = cleaned.split(' ')
  const fitsAt = (line: string, fs: number) => approxLineWidth(line, fs) <= maxWidth

  // Try single line at max font size, shrink as needed
  for (let fs = maxFontSize; fs >= minFontSize; fs -= 1) {
    if (fitsAt(cleaned, fs)) return { lines: [cleaned], fontSize: fs }
  }

  // Single line doesn't fit even at min size — wrap
  if (words.length === 1) {
    // Single very long word — clamp at min font size
    return { lines: [cleaned], fontSize: minFontSize }
  }

  // Generate candidate splits (for 2+ words)
  const candidateSplits: string[][] = []
  if (words.length === 2) {
    candidateSplits.push(words)
  } else {
    // 3+ words: prefer last-word-alone, then balanced split, then first-word-alone
    candidateSplits.push([words.slice(0, -1).join(' '), words[words.length - 1]])
    const mid = Math.ceil(words.length / 2)
    candidateSplits.push([words.slice(0, mid).join(' '), words.slice(mid).join(' ')])
    candidateSplits.push([words[0], words.slice(1).join(' ')])
  }

  for (let fs = maxFontSize; fs >= minFontSize; fs -= 1) {
    for (const lines of candidateSplits) {
      if (lines.every(l => fitsAt(l, fs))) {
        return { lines, fontSize: fs }
      }
    }
  }

  // Last resort: take the first split candidate at min font size
  return { lines: candidateSplits[0], fontSize: minFontSize }
}

// ============================================================================
// F-arrow mark polygons (from public/brand/svg file.svg)
// ============================================================================

const F_MARK_POLYGONS = [
  '213.6,291.7 254.3,269.3 254.3,232.2',
  '262,325.8 286.9,294.2 286.9,277 316.3,262.5 321.7,232.2 262,264.8',
  '262,256.6 262,220.9 321.7,190.6 311.8,179.7 356.1,183.3 337.1,224.5 331.2,211.4 286.4,232.2 286.4,243.5',
]
// ============================================================================
// Main generator
// ============================================================================

export function generateBrokerageLogoSvg(
  brokerageName: string,
  opts: BrokerageLogoOptions = {}
): string {
  const background: LogoBackground = opts.background ?? 'dark'
  const maxWidth = opts.maxWidth ?? 480
  const nameFontWeight = opts.nameFontWeight ?? NAME_FONT_WEIGHT

  // Colors per background
  const fMarkColor = background === 'light' ? FF_BLACK : FF_GREY_LIGHT
  const taglineColor = background === 'light' ? FF_GREY_DARK : FF_GREY_LIGHT
  const nameColor = FF_GREEN

  // Fit the name. Padding shrunk from 40 to 24 each side so longer wordmarks
  // (e.g. "CHOICE ADVANCES", "ROYAL LEPAGE COMMUNITY") have room to stay on a
  // single line at a larger font, which scales to a more legible size when
  // the SVG is rendered into the portal header at h-20/h-24.
  const padding = 24
  const nameMaxWidth = maxWidth - padding * 2
  const { lines, fontSize } = fitName(brokerageName, nameMaxWidth)

  // Layout coordinates (top-down). The aim is a tight vertical stack so that
  // when the SVG is `object-contain`-scaled to the portal header height, the
  // wordmark and tagline render at readable sizes. Earlier values inflated
  // padding to ~265px total, which scaled the 13px tagline down to ~4px in
  // an 80px-tall header. Tighter padding + larger source font sizes give the
  // wordmark and tagline three to four times the rendered size.
  const totalWidth = maxWidth
  const centerX = totalWidth / 2

  // F-mark sits proportionally to the wordmark. We size it relative to font
  // size so it doesn't visually dominate small names or get lost behind big
  // ones.
  const fMarkH = Math.round(fontSize * 1.05)
  const fMarkW = Math.round(fMarkH * 0.9)
  const fMarkY = 16

  const nameLineHeight = fontSize * 0.95
  const nameBlockTopY = fMarkY + fMarkH + 18
  const nameBlockHeight = lines.length * nameLineHeight

  // Tagline ~24% of the wordmark size keeps "POWERED BY FIRM FUNDS" readable
  // at every rendered scale instead of disappearing.
  const taglineFontSize = Math.max(16, Math.round(fontSize * 0.24))
  const taglineY = nameBlockTopY + nameBlockHeight + Math.round(fontSize * 0.30)

  const totalHeight = taglineY + taglineFontSize + 18

  // Escape any reserved XML chars in the name
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // Compute uppercase versions
  const upperLines = lines.map(l => escapeXml(l.toUpperCase()))

  // Build SVG
  // Notes on rendering portability:
  //   - We declare a font-family stack with system-fallback (Impact / Arial Black)
  //     so the SVG renders acceptably even when the Google Font can't be loaded
  //     (PDF exports, some email clients).
  //   - We *also* @import Big Shoulders Display via Google Fonts so browser
  //     previews get the exact typeface.
  //   - Tracking on the wordmark matches the live mockup (-1%).

  const nameStartY = nameBlockTopY + nameLineHeight * 0.75 // baseline of first line

  const fMarkScale = fMarkW / 150 // viewBox width is 150
  const fMarkX = centerX - fMarkW / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" role="img" aria-label="${escapeXml(brokerageName)}, Powered by Firm Funds">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@${nameFontWeight}&amp;family=Inter:wght@500;800&amp;display=swap');
    .ff-name { font-family: 'Big Shoulders Display', Impact, 'Arial Black', sans-serif; font-weight: ${nameFontWeight}; }
    .ff-tagline { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-weight: 500; letter-spacing: 0.32em; }
    .ff-tagline-bold { font-weight: 800; letter-spacing: 0.22em; }
  </style>
  <g transform="translate(${fMarkX} ${fMarkY}) scale(${fMarkScale})" fill="${fMarkColor}">
    <g transform="translate(-210 -175)">
      ${F_MARK_POLYGONS.map(pts => `<polygon points="${pts}" />`).join('\n      ')}
    </g>
  </g>
  <text x="${centerX}" y="${nameStartY}" text-anchor="middle" font-size="${fontSize}" fill="${nameColor}" class="ff-name" style="letter-spacing:${NAME_TRACKING_EM}em">
    ${upperLines.map((l, i) => `<tspan x="${centerX}" ${i === 0 ? `y="${nameStartY}"` : `dy="${nameLineHeight}"`}>${l}</tspan>`).join('\n    ')}
  </text>
  <text x="${centerX}" y="${taglineY}" text-anchor="middle" font-size="${taglineFontSize}" fill="${taglineColor}" class="ff-tagline" dominant-baseline="hanging">
    POWERED BY <tspan class="ff-tagline-bold">FIRM FUNDS</tspan>
  </text>
</svg>`
}

// ============================================================================
// Convenience: turn the SVG into a File for upload (browser only)
// ============================================================================

export function svgToFile(svg: string, filename = 'logo.svg'): File {
  return new File([svg], filename, { type: 'image/svg+xml' })
}
