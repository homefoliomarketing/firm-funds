# Bug Fixes — to manually re-test

Running log of fixes shipped so Bud can go back and confirm each one in the live app.
Newest batch on top. Check off each item once you have verified it yourself.

---

## 2026-06-09 — "Re-send" button on Firm Deal Review

- **New:** on the Firm Deal Review page (`/admin/firm-deal-review`), each
  already-sent offer in the "Recently resolved" list now has a **Re-send**
  button. Clicking it (after a confirm) re-fires the offer email AND text to the
  matched agent(s), with a fresh magic link. Use it when an agent says they
  never got the offer, deleted it, or only one channel landed.
- **Safe by design:** a re-send does not change the deal's status or its
  original sent date, and a failed re-send will never flip a sent offer back to
  "error". It only appears on offers that were actually sent (last 7 days of
  resolved items).
- **Files:** `app/(dashboard)/admin/firm-deal-review/page.tsx`,
  `lib/actions/firm-deal-review-actions.ts`,
  `lib/firm-deal-detection/dispatch-notification.ts`
- **How to test:** go to `/admin/firm-deal-review`, find a sent offer under
  "Recently resolved", click **Re-send**, confirm. The matched test agent should
  get the offer email + text again. (Heads up: this sends a REAL email and text,
  so use a test agent.)

---

## 2026-06-09 — Firm-deal emails, white-label logos, agent self-submit

Shipped to `main` (Netlify auto-deploys). One database change was applied:
migration `105_agent_self_submit_offer.sql` added a `deals.agent_self_submit_at`
column (already run against the live DB).

### 1. Brokerage advance-request email said "trade record" instead of all docs
- **Was:** the email sent to a brokerage when an agent requests an advance said
  "fill in the commission split and upload the trade record."
- **Now:** "fill in the commission split and upload the **required documents**."
  (They need to submit everything, not just the trade record.)
- **File:** `lib/firm-deal-detection/render-brokerage-offer-email.ts`
- **How to test:** as an agent, accept a firm-deal offer so the brokerage gets
  the notification email. Read the body near the button. It should say "required
  documents."

### 2. Portal pages showed "Firm Funds" instead of the white-label logo
- **Was:** on the agent deal page (Your Deals -> click a deal), the top logo
  switched to plain Firm Funds instead of Choice Advances. That page had the
  Firm Funds wordmark hard-coded in its header.
- **Now:** the deal page (both the "offered" view and the normal view) and the
  agent new-deal page use the shared white-label logo component, so they show
  the brokerage's own logo (and fall back to Firm Funds only when a brokerage
  has no logo). I also swept the rest of the agent and brokerage portal pages
  for the same hard-coded logo.
- **Files:** `app/(dashboard)/agent/deals/[id]/page.tsx`,
  `app/(dashboard)/agent/new-deal/page.tsx`
- **How to test (VISUAL — please confirm on your end):** log in as a Choice
  Advances agent, open a deal from Your Deals, and confirm the top-left logo is
  Choice Advances, not Firm Funds. Click into the new-deal form too.

### 3. Agent can now submit the advance themselves after asking the brokerage
- **New behavior:** on an offered deal that is waiting on the brokerage, the
  agent now has an "I'll submit this myself" button. Clicking it takes the offer
  over and sends the agent to a pre-filled advance form. While the agent has
  taken it over, the brokerage is **paused** on that deal so there is never a
  duplicate submission:
  - it disappears from the brokerage's "submit on behalf" list (shows a quiet
    "this agent is submitting it themselves" note instead, with no buttons),
  - the brokerage's submit and decline actions refuse it,
  - the automatic reminder/escalation emails skip it.
  The agent can also "Hand this back to my brokerage," which clears the pause
  and returns it to the normal brokerage flow.
- **No-duplicate guarantee:** when the agent submits, the SAME offered deal row
  is converted in place to "under review" (not a new row), with a guard so two
  clicks cannot create two deals.
- **Files:** `lib/actions/firm-deal-offer-actions.ts`,
  `lib/actions/deal-actions.ts`, `app/(dashboard)/agent/deals/[id]/page.tsx`,
  `app/(dashboard)/agent/new-deal/page.tsx`, `app/(dashboard)/brokerage/page.tsx`,
  `components/brokerage/OfferedDealsBanner.tsx`,
  `app/(dashboard)/brokerage/deals/new/page.tsx`,
  `app/api/cron/firm-deal-offer-nudges/route.ts`,
  `supabase/migrations/105_agent_self_submit_offer.sql`
- **How to test:**
  1. As a Choice agent, accept a firm-deal offer (now "offered", waiting on the
     brokerage).
  2. Open the deal, click "I'll submit this myself." You should land on a
     pre-filled new-deal form.
  3. In another browser as the Choice brokerage admin: that offer should now be
     greyed out with "this agent is submitting it themselves," no Submit/Decline.
  4. Back as the agent, finish and submit the form. Confirm success.
  5. Check there is exactly ONE deal for that property, now "under review"
     (no duplicate, no leftover "offered" row).
  6. Optional: instead of submitting, click "Hand this back to my brokerage" and
     confirm the brokerage's Submit/Decline buttons come back.

### 4. "Remind my brokerage" message overstated the recipient count
- **Was:** "Reminder sent to 2 recipients at your brokerage..." (the 2 included a
  Firm Funds inbox, so it was misleading).
- **Now:** "Reminder has been sent to your brokerage. We'll let you know if they
  submit."
- **File:** `app/(dashboard)/agent/deals/[id]/page.tsx`
- **How to test:** on an offered deal, click "Remind my brokerage" and read the
  confirmation. No number should appear.

### 5. Firm-deal email to the agent: real logo, new wording, two buttons
- **Was:** a plain green banner with the text "Choice Advances," the line
  "instead of waiting weeks," and "Get paid TODAY" was non-clickable text.
- **Now:**
  - the header shows the brokerage's actual white-label **logo image** (falls
    back to the green text banner if a brokerage has no logo on file),
  - the opening line reads "**Congratulations on your recent deal at [address]!**"
  - the body reads "You're already onboarded, so **you're only a few steps away
    from getting paid**,"
  - "**Get paid TODAY**" is now a tappable button that opens their portal (the
    existing button below it stays, so there are two ways in),
  - "instead of waiting weeks" is removed (dual-agency emails still say "Both
    sides, both commissions").
- **Files:** `lib/firm-deal-detection/render-email.ts`,
  `lib/firm-deal-detection/dispatch-notification.ts`
- **How to test (VISUAL — please confirm):** trigger a firm-deal email for a
  Choice agent whose brokerage has a logo. Confirm the logo shows, the two
  buttons both open the portal, the congratulations line and "a few steps away"
  wording are there, and there is no "instead of waiting weeks."

### 6. White-label logo cut off on mobile (FIXED PROPERLY + verified this time)
- **Was:** on a phone, the brokerage logo in the top header was clipped at the
  left edge. Four prior attempts over two sessions did not fix it.
- **Real root cause (finally found, with the actual numbers):** the generated
  brokerage logo is a wide image (480 x 195, so ~2.5 times wider than tall). On
  the deal page and the "New Advance Request" page, the header rendered it at a
  tall height (~157px wide) inside a cramped single row (logo + divider + back
  arrow + title + Sign out). Mobile Chrome refused to shrink that image, so the
  row grew wider than the phone screen and the logo got pushed off the left
  edge. (Earlier fixes only touched `AgentHeader`, but these two pages use their
  own header, which is why it kept coming back.)
- **Now:** the logo is pinned to a small, fixed, fully-visible size on phones
  (about 98px wide) so the row fits without relying on any shrinking, the
  divider is hidden on mobile, the page title shrinks/truncates, and any stray
  horizontal overflow is clipped so the sticky header can't slide. Desktop is
  unchanged (full-size logo + divider return at tablet/desktop widths).
- **Files:** `components/BrokerageBrandLogo.tsx`,
  `app/(dashboard)/agent/new-deal/page.tsx`,
  `app/(dashboard)/agent/deals/[id]/page.tsx`
- **Verified:** I rendered the real header geometry in a browser and measured it
  at 320px, 360px, and 412px wide (your phone is ~412px). At every width the
  logo sits fully on screen (left edge >= 0, right edge within the viewport)
  with zero horizontal overflow, and at desktop width the full-size logo +
  divider come back. This is the first time the fix was measured rather than
  guessed.
- **How to test (please still glance on your phone):** open the "New Advance
  Request" page and a deal from Your Deals on your phone. The Choice Advances
  logo should sit fully on screen, nothing clipped at the left edge, no sideways
  scroll.

---

**Notes on verification:** item 6 (the mobile logo) was measured in a real
browser at phone widths this time, so it is verified, not guessed. Items 2 and 5
(in-app logo + the email) are verified by type-check and a clean production
build, but I could not log in to screenshot them because I do not have your
password and the rule is to never reset it. A quick glance on a real device is
still worth it for 2 and 5. If you want, share a test login (or approve a
one-time magic link) and I will screenshot them too.
