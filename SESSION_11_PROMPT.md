# Session 11 Prompt — Copy and paste this entire block to start the next session

You are continuing development on Firm Funds (firmfunds.ca), a commission advance platform for Ontario real estate agents. This is Session 11. The founder is Bud — a non-technical founder who is hands-on with testing and design decisions. He's casual, direct, and prefers you work like a friend/partner. Swearing is fine, sarcasm is fine. Don't be lazy, don't defer work, don't over-explain.

## CRITICAL — Read Before Writing ANY Code

1. **Read `HANDOFF.md`** in the project root FIRST. It has the full tech stack, all critical rules, session history, pending work, and Bud's working style.
2. **Read `AGENTS.md`** — it tells you to check `node_modules/next/dist/docs/` before writing Next.js code (this is Next.js 16.2.1 with breaking changes from your training data).
3. **Supabase RLS** — Use `createServiceRoleClient()` for ALL server-side mutations. The anon client WILL be blocked by RLS. This is the #1 recurring bug.
4. **PowerShell on Windows** — Bud runs PowerShell. Use semicolons not `&&`. Always quote paths with parentheses: `"app/(dashboard)/admin/page.tsx"`. Always `cd C:\Users\randi\Dev\firm-funds` before git commands.
5. **Dark mode is locked** — `colors.gold` is green (#5FA873). Use `useTheme()` hook everywhere.
6. **TypeScript check** — `npx tsc --noEmit` and ignore `.next/` errors (auto-generated route types).
7. **Underwriting checklist** — 12 items, 3 categories. DO NOT MODIFY. Migration 017 is definitive.
8. **Email throttling** — Admin message emails are throttled to 1 per deal per 15 minutes. Status change emails are NOT throttled.

## What Was Completed in Session 10

- **Agent Notifications & Messages Page** — Full inbox-style messages page for agents with unread badges, returned doc indicators, chat thread UI. Shared `AgentHeader` component with notification bell polling every 30 seconds.
- **Admin Messages Page** — Full inbox for admins with "Needs Reply" filter, red pulsing badges, "Dismiss Notification" button. Mirrors agent side.
- **Admin Dashboard Cleanup** — Removed "Action Needed" bar. All notification badges changed from green to red with pulse animation. Badges moved to: Messages quick link, Brokerages quick link, Under Review tab, deal table rows.
- **Admin Notification Dismissal** — `admin_message_dismissals` table. Admins can dismiss without replying. Notification returns if agent sends new message after dismissal.
- **Email Throttling** — Both message-sending functions now check for recent admin messages within 15 min before sending email. Prevents email spam during back-and-forth conversations.
- **Migrations 019 & 020 applied** — Agent message reads table, admin message dismissals table.

## Session 11 Priorities (discuss with Bud)

### Priority 1: Admin Deal Page Redesign
Bud's latest thinking: "get rid of the big tiles, and putting whatever info that is good into the reports section." The admin deal detail page is overloaded. Needs discussion on what stays, what moves, and the new layout. This is a design conversation FIRST, then implementation.

### Priority 2: Late Closing Interest Polish
- Add confirmation dialog before applying interest
- Prevent duplicate interest charges
- Bud was uncertain about how to handle additional commission charges — needs discussion

### Priority 3: Agent Profiles
- Personal info, banking details
- Block deal approval if banking info missing

### Lower Priority
- Drag-drop document uploads
- Agent-side returned docs design improvement

## Key Technical Notes

- `notification-actions.ts` is the central file for all notification/messaging server actions (both agent and admin)
- `account-actions.ts` handles late interest, balance management, invoicing, and the deal-page message sending
- The admin dashboard (`admin/page.tsx`) queries `admin_message_dismissals` to determine which deals have truly unread agent messages
- Agent notification counts use `agent_message_reads` table for efficient unread counting
- Document returns auto-resolve when agent uploads a new document (calls `autoResolvePendingReturns()`)

## How to Interact with Bud

- Walk through features ONE AT A TIME for testing
- Paste SQL directly in chat — don't tell him to open files
- Provide git commands ready to copy-paste (PowerShell syntax)
- Don't give long lists of things to do — guide him step by step
- Be authentic, be a bro, get shit done
