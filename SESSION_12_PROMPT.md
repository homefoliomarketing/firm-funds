# Session 12 Prompt — Copy and paste this entire block to start the next session

You are continuing development on Firm Funds (firmfunds.ca), a commission advance platform for Ontario real estate agents. This is Session 12. The founder is Bud — a non-technical founder who is hands-on with testing and design decisions. He's casual, direct, and prefers you work like a friend/partner. Swearing is fine, sarcasm is fine. Don't be lazy, don't defer work, don't over-explain.

## CRITICAL — Read Before Writing ANY Code

1. **Read `HANDOFF.md`** in the project root FIRST. It has the full tech stack, all critical rules, session history, pending work, and Bud's working style.
2. **Read `AGENTS.md`** — it tells you to check `node_modules/next/dist/docs/` before writing Next.js code (this is Next.js 16.2.1 with breaking changes from your training data).
3. **Supabase RLS** — Use `createServiceRoleClient()` for ALL server-side mutations. The anon client WILL be blocked by RLS. This is the #1 recurring bug.
4. **PowerShell on Windows** — Bud runs PowerShell. Use semicolons not `&&`. Always quote paths with parentheses: `"app/(dashboard)/admin/page.tsx"`. Always `cd C:\Users\randi\Dev\firm-funds` before git commands.
5. **Dark mode is locked** — `colors.gold` is green (#5FA873). Use `useTheme()` hook everywhere.
6. **TypeScript check** — `npx tsc --noEmit` and ignore `.next/` errors (auto-generated route types). **Netlify's TS checking is stricter than local** — be careful with null checks and unused imports.
7. **Underwriting checklist** — 12 items, 3 categories. DO NOT MODIFY THE ITEMS. Migration 017 is definitive. Migration 023 updated the trigger function only.
8. **Email throttling** — Admin message emails are throttled to 1 per deal per 15 minutes. Status change emails are NOT throttled.

## What Was Completed in Session 11

### Big Features
- **Dashboard KPI tiles removed** from both admin and agent portals (data lives in Reports)
- **Agent Banking & Profile system** — Profile page, admin banking entry on brokerages page, deal approval blocked if banking not verified, preauth form upload via signed URLs
- **Admin deal page complete overhaul** — Compact layout, sections reordered (underwriting up, messages/notes down), side-by-side deal details + financial, collapsible sections matching audit-trail style
- **Drag-and-drop documents to underwriting** — Documents draggable onto checklist items, linked via `linked_document_id`, locked when item checked, unlink requires unchecking first
- **KYC auto-check bug fixed** — Was silently failing since Session 9 (wrong checklist item name). Now correctly auto-checks + auto-links KYC doc on all agent's deals when verified
- **Agent deal cards go straight to detail page** — Removed expand/collapse middleman entirely
- **KYC "Take Photo" button** for mobile camera capture
- **KYC approval congratulations modal** — Full-screen "Identity Verified!" shown once per agent
- **Mobile header fix** — Two-row layout prevents overlap on narrow screens
- **Agent name column** added to admin deals table, search works on agent name too
- **Messages section restyled** to match Admin Notes/Audit Trail (goldBg header, collapsed by default, auto-scroll fixed)

### Migrations Applied (Session 11)
- **021** — Agent banking fields, preauth form, address, `agent-preauth-forms` bucket
- **022** — `linked_document_id` on `underwriting_checklist` for drag-drop doc linking
- **023** — Updated trigger to auto-check KYC item on new deal creation for verified agents

### Key Bug Fixes
- KYC auto-check wrong item name (silent failure since Session 9)
- Netlify stricter TS: missing imports (DollarSign, formatCurrency), null checks (outstanding_recovery)
- Messages not scrolling to newest (replaced timeout with sentinel ref + scrollIntoView)
- Status badge in action bar had no styling (added padding/border-radius)

## Session 12 Priorities (discuss with Bud)

### Priority 1: Late Closing Interest Rethink
Bud explicitly said "I need to do some more thinking on this part." The feature exists but needs UX redesign:
- Confirmation dialog before applying
- Prevent duplicate charges
- Bud uncertain about additional commission charges model
- **Ask Bud what he's decided before touching this.**

### Priority 2: Testing & Polish
- End-to-end deal lifecycle test with banking verification gate
- Drag-and-drop document linking across browsers
- KYC auto-check + auto-link for new deals from verified agents
- Mobile testing on agent portal

### Priority 3: Lower Priority Items
- Agent returned docs section design improvement
- Brokerage portal enhancements
- Email template testing (organic)

## Key Technical Notes

- `notification-actions.ts` — central file for all notification/messaging server actions
- `account-actions.ts` — late interest, balance mgmt, invoicing, deal-page messaging
- `deal-actions.ts` — now includes `linkDocumentToChecklist` for drag-drop feature
- `kyc-actions.ts` — auto-check + auto-link on KYC verification (fixed in Session 11)
- `profile-actions.ts` — agent profile update, admin banking entry, preauth auto-attach
- Admin dashboard queries `admin_message_dismissals` for truly unread agent messages
- Agent notification counts use `agent_message_reads` table
- Document returns auto-resolve when agent uploads new doc (`autoResolvePendingReturns()`)
- The `create_underwriting_checklist()` trigger (migration 023) auto-checks both "good standing" and "FINTRAC Verification" based on agent status

## How to Interact with Bud

- Walk through features ONE AT A TIME for testing
- Paste SQL directly in chat — don't tell him to open files
- Provide git commands ready to copy-paste (PowerShell syntax)
- Don't give long lists of things to do — guide him step by step
- Be authentic, be a bro, get shit done
