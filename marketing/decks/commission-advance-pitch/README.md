# Commission Advance Partnership Pitch Deck

A self-contained HTML presentation that pitches the Firm Funds Commission Advance program to prospective brokerages. Dark-mode aesthetic, matches the live firmfunds.ca app. 10 slides, keyboard nav, Chart.js, no build step.

## How to open it

Double-click `index.html`. It opens in your default browser. That is the whole install.

No server, no Node, no npm. Everything is inline or loaded from public CDNs (fonts, Chart.js).

### Recommended viewing

- **Best:** present in fullscreen on a 1080p or higher display. Press `F11` (Windows) or `Ctrl + Cmd + F` (Mac) after opening.
- **Works fine:** any modern browser at any reasonable window size. The deck is locked to a 16:9 stage and letterboxes black if the window does not match.

### Navigation

| Key                       | Action                  |
| ------------------------- | ----------------------- |
| Right arrow / Space / PgDn| Next slide              |
| Left arrow / PgUp         | Previous slide          |
| Home                      | Jump to title slide     |
| End                       | Jump to CTA slide       |
| Click anywhere            | Next slide              |
| Click the bottom-right pill | Use the prev / next buttons explicitly |

The URL hash (`#3`, `#6`, etc.) deep-links to any slide. Bookmark `index.html#6` to jump straight to the revenue chart.

## How to personalize for a target brokerage

There are 4 placeholder zones to swap. All are plain text in `index.html`. Use Find-and-Replace.

### 1. Brokerage name

Replace **`[BROKERAGE NAME]`** (title slide "Prepared for" line) and **`[BROKERAGE]`** (the endorsement card, the brand stack on slide 3, and the CTA headline on slide 10).

You can do both at once with Find-and-Replace (no regex):

```
Find: [BROKERAGE NAME]
Replace: Acme Realty Group

Find: [BROKERAGE]
Replace: Acme Realty
```

### 2. Date

Replace **`[MONTH YEAR]`** on the title slide with the month and year of the pitch.

### 3. Brokerage logo (optional)

The title slide has an "endorsement mark" preview that says `[BROKERAGE]` `ADVANCES`. To swap in the brokerage's real wordmark, find the `.brokerage-slot` block in `index.html` (Ctrl+F for `brokerage-slot`) and replace the inner `.placeholder-title` div with an `<img>` tag pointing to a logo file you drop into `assets/`. Keep the image height under about 80px so it fits the slot.

Example:

```html
<div class="brokerage-slot" style="padding: 24px;">
  <img src="assets/acme-logo.svg" alt="Acme Realty" style="max-width: 100%; max-height: 80px;">
</div>
```

### 4. Contact details (CTA slide)

On slide 10, replace **`[CONFIRM WITH BUD: primary contact name & title]`** and **`[CONFIRM WITH BUD: contact email]`** with the actual contact for that pitch.

### Complete placeholder list

Search the file for `[CONFIRM WITH BUD` to find every spot Bud still needs to confirm a real number or piece of copy. As of the current build these are:

- Title slide: `[BROKERAGE NAME]`, `[MONTH YEAR]`
- Endorsement card: `[BROKERAGE]` `ADVANCES`
- Slide 3 brand stack: `[BROKERAGE] Advances`
- Slide 6 chart footnote: average advance size `$20,000 [CONFIRM WITH BUD]`, brokerage profit share `[CONFIRM WITH BUD]`
- Slide 6 side-stat: "First advance can fund in your first week live. `[CONFIRM WITH BUD: typical 1 week?]`"
- Slide 8 lede: `[CONFIRM WITH BUD: typical 1 week?]`
- Slide 10 headline: `[BROKERAGE] Advances.`
- Slide 10 contact: `[CONFIRM WITH BUD: primary contact name & title]`, `[CONFIRM WITH BUD: contact email]`

## Real product screenshots

Slides 5 and 7 include placeholder boxes labeled with each surface name:

- `brokerage-branded-portal`, `brokerage-branded-email` (slide 5)
- `brokerage-dashboard`, `profit-revenue`, `agent-management`, `deal-pipeline`, `agent-ledger`, `branded-notifications` (slide 7)

To swap in real screenshots, find each `<div class="screenshot-placeholder" data-surface="...">` and replace its inner content with an `<img src="assets/screenshot-name.png">`. The placeholder boxes use a 16/10 aspect ratio on slide 5 and 16/8 on slide 7, so match those if possible.

## How to print or export to PDF

The deck has a print stylesheet that produces one slide per landscape page.

### Chrome / Edge (cleanest output)

1. Open `index.html` in Chrome or Edge.
2. Press `Ctrl + P` (or `Cmd + P`).
3. Set Destination to **Save as PDF**.
4. Set Layout to **Landscape**.
5. Under More settings:
   - Paper size: **Tabloid** (or any 16:9-ish ratio, "A3 landscape" works too)
   - Margins: **None**
   - Scale: **Default** or **Custom 100**
   - Background graphics: **enabled** (critical, this is how the dark theme renders)
6. Click Save.

The result: a 10-page PDF, one slide per page, dark background preserved.

### Manual screenshot route (for one or two slides)

Open the deck in the browser, navigate to the slide you want, take a fullscreen screenshot (Windows: `Win + Shift + S`, Mac: `Cmd + Shift + 4`).

## File map

```
commission-advance-pitch/
├── index.html        the deck, all 10 slides inline
├── README.md         this file
└── assets/
    ├── firm-funds-logo.svg        primary brand mark (vector)
    ├── firm-funds-logo-white.png  white wordmark, raster fallback
    └── sample-endorsement-mark.svg  example "Brokerage Advances + powered by Firm Funds" lockup
```

## Slide list

1. Title (with brokerage name + endorsement mark slot)
2. The problem
3. The opportunity
4. The deal (zero investment)
5. What the brokerage gets (branded portal preview)
6. The revenue (Chart.js, illustrative numbers)
7. Software walkthrough (six surface screenshots)
8. Onboarding (week-one timeline)
9. Compliance and trust
10. Call to action (next steps + contact)

## Notes

- All copy is plain English, no jargon, no em dashes.
- All numbers on the revenue chart are illustrative. The assumptions block on slide 6 spells out the math. Mark this clearly in any verbal pitch.
- The chart math uses the standard Firm Funds rate card: $0.80 per $1,000 per day. If a target brokerage has a custom rate, edit the constants near the bottom of `index.html` (look for `discountPerKPerDay`).
- The deck is dark-mode only by design, matching the live firmfunds.ca app.
