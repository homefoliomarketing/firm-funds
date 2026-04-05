# Session 10 Prompt — Firm Funds (firmfunds.ca)

Paste this into your next chat session to get the new agent up to speed.

---

You are continuing development on **Firm Funds** (firmfunds.ca), a commission advance platform for Ontario real estate agents. I am Bud, the non-technical founder. This is Session 10.

## Read These First
1. **`HANDOFF.md`** in the project root — contains everything: tech stack, critical rules, what was completed, what's pending, file map, and the underwriting checklist (DO NOT CHANGE IT).
2. **`AGENTS.md`** in the project root — contains rules about Next.js 16 breaking changes. You MUST read `node_modules/next/dist/docs/` before writing any code.

## Critical Rules
- **Next.js 16.2.1** — `params` are Promises, `'use server'` files only export async functions, `useSearchParams()` needs `<Suspense>` boundary. This is NOT the Next.js you know from training data.
- **Supabase RLS** — Use `createServiceRoleClient()` for ALL server-side mutations. This is the #1 source of bugs.
- **Dark mode locked** — `colors.gold` is green (#5FA873), not gold.
- **Discount rate** — $0.75 per $1,000 per day, +1 processing day offset. Late closing uses same rate with 5-day grace period.
- **PowerShell on Windows** — Use semicolons not `&&`.
- **TypeScript check** — `npx tsc --noEmit` (can't run `next build` in sandbox due to missing SWC binaries).
- **Underwriting checklist** — DO NOT MODIFY the 12 items in 3 categories. Migration 017 is definitive. This has been broken and fixed across sessions 6-9. Don't touch it.

## How I Work
- Walk me through testing **one feature at a time**. Do NOT give me a list of things to test all at once. I will get pissed.
- **Paste SQL directly in chat** when I need to run migrations. Don't create files and tell me to open them.
- I like to **push all changes at once** at the end of a session after testing.
- I'm casual. Swearing, sarcasm, humor — all good. Just don't be lazy or take shortcuts.
- I'm non-technical. Don't dump jargon on me. Explain things simply when needed.

## Session 10 Priorities

### Priority 1: Agent Notifications & Dedicated Messages Page
The current messaging system works (admin sends messages from deal page, agent can reply, emails work, deep-linking works) but messages are buried in the deal detail page. I want:
- A **dedicated Messages page** for agents (not just inside each deal)
- A **notification system** — tab or indicator at the top showing agents they have new messages or returned documents
- Messages should still be tied to deals but accessible from a central location
- This needs proper UX thinking — not just cramming more stuff onto existing pages

### Priority 2: Admin Deal Page Redesign
The admin deal page has too much going on: underwriting checklist, documents, document viewer, messages, document returns, late closing interest. It needs to be reorganized — tabs, collapsible sections, or multi-panel layout. Discuss approach with me before building.

### Priority 3: Late Closing Interest Polish
- Show calculated amount and ask for confirmation BEFORE applying the charge
- Warn or prevent charging interest multiple times on same deal
- I'm still figuring out how to handle additional commission charges so we may need to discuss this

### Lower Priority (if time permits)
- Agent Profiles (large feature: personal info, banking details, block deal approval if banking missing)
- Drag-drop documents to underwriting categories
- Agent-side returned docs section design improvement

## DB State
All migrations through 018 are applied. Tables exist for: `agent_transactions`, `agent_invoices`, `deal_messages`, `document_returns`. The `agents` table has `account_balance`. The `deals` table has `actual_closing_date`, `late_interest_charged`, `late_interest_calculated_at`.

## What's Working (Don't Break These)
- Underwriting checklist (12 items, 3 categories, optimistic toggles, N/A support, auto-check for flagged agents)
- Admin ↔ Agent messaging (thread UI, email notifications, deep-linking with hash anchors, auto-scroll)
- Document returns (↩ button, reason form, email notification, agent alert, deep-linking)
- Late closing interest (basic — charges to agent balance, but needs the polish work above)
- Login redirect from email links (preserves URL through auth flow)
- Session timeout modal
- Brokerage payment tracking
- KYC flow with approval emails
- Inline document viewer with Ctrl+scroll zoom
