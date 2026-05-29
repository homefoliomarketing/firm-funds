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
}

// ============================================================================
// Color palette (matches Firm Funds brand: see public/brand/svg file.svg and
// lib/constants.ts BRAND_GREEN_HEX)
// ============================================================================

const FF_GREEN = '#5FA873'      // brokerage name
const FF_BLACK = '#0a0a0a'      // F-mark on white backgrounds (per Bud's preference)
const FF_GREY_DARK = '#636361'  // tagline on light backgrounds (matches original logo)
const FF_GREY_LIGHT = '#d4d4d4' // F-mark + tagline on dark backgrounds

// ============================================================================
// Character-width approximation for Big Shoulders Display 900
// ============================================================================
// Measured empirically from rendered samples. Returns width in em units
// (multiply by font-size to get pixel width).

function charWidthEm(ch: string): number {
  if (ch === ' ') return 0.27
  const c = ch.toUpperCase()
  if ('MW'.includes(c)) return 0.78
  if ('IJ'.includes(c)) return 0.30
  if ('1'.includes(c)) return 0.40
  if ('FLT'.includes(c)) return 0.48
  if ('BCDGHKNOPQRSUVXYZ23456789'.includes(c)) return 0.55
  if ('AER'.includes(c)) return 0.58
  return 0.52
}

function approxLineWidth(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) width += charWidthEm(ch)
  // -1% letter-spacing per the mockup CSS
  return width * fontSize * 0.99
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

function fitName(name: string, maxWidth: number, maxFontSize = 64, minFontSize = 32): {
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
// The F-mark in source coordinates spans roughly x:213-356 (width 143), y:180-326 (height 146)
const F_MARK_VIEWBOX = '210 175 150 160'

// ============================================================================
// Main generator
// ============================================================================

export function generateBrokerageLogoSvg(
  brokerageName: string,
  opts: BrokerageLogoOptions = {}
): string {
  const background: LogoBackground = opts.background ?? 'dark'
  const maxWidth = opts.maxWidth ?? 480

  // Colors per background
  const fMarkColor = background === 'light' ? FF_BLACK : FF_GREY_LIGHT
  const taglineColor = background === 'light' ? FF_GREY_DARK : FF_GREY_LIGHT
  const nameColor = FF_GREEN

  // Fit the name
  const padding = 40 // outer padding each side reserved
  const nameMaxWidth = maxWidth - padding * 2
  const { lines, fontSize } = fitName(brokerageName, nameMaxWidth)

  // Layout coordinates (top-down)
  const totalWidth = maxWidth
  const centerX = totalWidth / 2

  const fMarkW = 72
  const fMarkH = 80
  const fMarkY = 32

  const nameLineHeight = fontSize * 0.95
  const nameBlockTopY = fMarkY + fMarkH + 28
  const nameBlockHeight = lines.length * nameLineHeight

  const dividerY = nameBlockTopY + nameBlockHeight + 22
  // No actual divider line — just spacing — but kept for symmetry

  const taglineFontSize = 13
  const taglineY = dividerY + 8

  const totalHeight = taglineY + taglineFontSize + 32

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

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" role="img" aria-label="${escapeXml(brokerageName)} — Powered by Firm Funds">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@900&amp;family=Inter:wght@500;800&amp;display=swap');
    .ff-name { font-family: 'Big Shoulders Display', Impact, 'Arial Black', sans-serif; font-weight: 900; }
    .ff-tagline { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-weight: 500; letter-spacing: 0.32em; }
    .ff-tagline-bold { font-weight: 800; letter-spacing: 0.22em; }
  </style>
  <g transform="translate(${fMarkX} ${fMarkY}) scale(${fMarkScale})" fill="${fMarkColor}">
    <g transform="translate(-210 -175)">
      ${F_MARK_POLYGONS.map(pts => `<polygon points="${pts}" />`).join('\n      ')}
    </g>
  </g>
  <text x="${centerX}" y="${nameStartY}" text-anchor="middle" font-size="${fontSize}" fill="${nameColor}" class="ff-name" style="letter-spacing:-0.01em">
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
