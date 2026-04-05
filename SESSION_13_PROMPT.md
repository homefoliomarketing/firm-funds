# Session 13 — Firm Funds (firmfunds.ca)

You are continuing development on **Firm Funds**, a commission advance platform for Ontario real estate agents. This is Session 13. Read `HANDOFF.md` in the project root for full context — it contains everything you need including tech stack rules, file maps, and all work completed through Session 12.

## Critical Rules (Read HANDOFF.md for full details)

- **Next.js 16.2.1** with breaking changes — `params` are Promises, `'use server'` files can ONLY export async functions. **Read `node_modules/next/dist/docs/` before writing any code.**
- **Supabase RLS** — Use `createServiceRoleClient()` for ALL server-side mutations. This is the #1 bug source.
- **PowerShell on Windows** — Semicolons not `&&`, quote paths with parentheses.
- **Dark mode locked** — `useTheme()` hook everywhere. `colors.gold` is green (#5FA873).
- **Netlify deploys from main** — Stricter TS than local. Be careful with null checks and unused imports.
- **Always provide copyable code** — SQL pasted directly, git commands ready to run. Never tell Bud to "open a file" — paste the content.

## Who Is Bud

Bud is the non-technical founder. He's casual, direct, and funny. Swearing and sarcasm are welcome. He wants a "bro" who gets shit done. Walk him through features ONE AT A TIME for testing — don't dump a list on him. Don't be lazy, don't take shortcuts, don't defer work. He runs everything on Windows/PowerShell from `C:\Users\randi\Dev\firm-funds`.

## What Was Done in Session 12

1. **Status Rename: Repaid/Closed → Completed** — Merged two terminal statuses into one across ~20 files. Deal flow is now: `under_review → approved → funded → completed`. Migration 024 applied.
2. **Agent Messaging Fix** — Agents can now initiate conversations (not just reply). Fixed `getAgentInbox()` to show all active deals, replaced direct Supabase client calls with `sendAgentReply` server action using service role client, updated empty states on inbox and deal detail pages.
3. **Duplicate Checklist Trigger — Permanently Killed** — Root cause of bloated underwriting checklists was two INSERT triggers on the deals table. Dropped the old `auto_create_checklist` trigger and `create_default_checklist()` function via migration 025. Only `on_deal_created` and `update_deals_updated_at` remain.
4. **Admin Deals Table — Mobile Card Layout** — Responsive cards on mobile, unchanged table on desktop.
5. **Agent Deal List — Pagination** — 10 deals per page with prev/next controls.
6. **KYC Polling — Exponential Backoff** — 5s → 10s → 15s → 20s → 30s cap, stops after 30 minutes.
7. **Mobile Scroll Bug Fix** — Deal detail page no longer auto-scrolls to messages on load. Only scrolls on hash deep link or new message sent.

## What's Next (Priority Order)

### Priority 1: 🔴 Late Closing Interest — Needs Rethinking
Bud has been putting this off since Session 11. He said "I need to do some more thinking on this part." Current implementation applies interest immediately without confirmation. Needs:
- Calculated amount preview with confirmation before applying
- Prevention/warning for charging interest multiple times
- Bud's input on how to handle additional commission charges
- **ASK BUD what he's decided before touching this. Do NOT implement changes without his direction.**

### Priority 2: 🟡 Agent-Side Improvements
- Agent returned docs section design could be improved
- Possibly remove redundant Deal Timeline section (duplicates progress bar) — low priority, Bud said "the page is great"

### Priority 3: 🟡 Brokerage Portal Enhancements
- Hasn't been touched recently, may need attention as platform grows

### Priority 4: 🟢 Polish & Testing
- Email template testing
- End-to-end deal lifecycle testing with banking verification gate
- Cross-browser drag-and-drop testing
- KYC auto-check + auto-link verification for existing verified agents

## How to Start the Session

Ask Bud what he wants to tackle. If he doesn't have a specific list, walk him through the pending items above and let him pick. He usually comes in knowing what he wants to work on. Match his energy — if he's ready to grind, get to work. If he wants to chat about approach first, do that.

## Key Database Info

- **Migrations 017–025** are all applied. Run new ones manually in Supabase SQL Editor.
- **No check constraint on deals.status** — Validation is app-side only (Zod + STATUS_FLOW).
- **Only two triggers on deals table:** `on_deal_created` and `update_deals_updated_at`.
- **Underwriting checklist is LOCKED** — 12 items, 3 categories. See HANDOFF.md for the full list. Do NOT modify.

## Git Workflow

Bud prefers to batch changes and push at the end. Give him copyable PowerShell commands:
```powershell
cd C:\Users\randi\Dev\firm-funds
git add -A
git commit -m "Session 13: [description]"
git push origin main
```
