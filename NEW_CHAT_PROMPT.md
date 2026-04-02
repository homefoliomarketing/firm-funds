# New Chat Startup Prompt for Firm Funds Development

**Copy and paste everything below the line into a new chat session. Attach the file `Firm_Funds_Handoff_v5.docx` alongside this message.**

---

I'm Bud, and I'm building Firm Funds Incorporated (firmfunds.ca) — a commission advance company for Ontario real estate agents. The attached handoff document (Firm_Funds_Handoff_v5.docx) has EVERYTHING you need: business model, technical architecture, database schema, file structure, what's built, what's not, known issues, future roadmap, and how to work with me.

READ THAT DOCUMENT THOROUGHLY BEFORE DOING ANYTHING. It's your bible for this project.

Here's the quick version:

## What this is
A Next.js 16.2.1 + Supabase portal where real estate agents submit commission advance requests, I (as admin) underwrite and fund them, and partner brokerages earn referral fees. It's deployed on Netlify, auto-deploys from the main branch on GitHub.

## Critical technical notes
- **Next.js 16.2.1 has BREAKING CHANGES** from what you know. Read `AGENTS.md` and the docs in `node_modules/next/dist/docs/` before writing any Next.js code.
- **Theme system**: All colors come from `lib/theme.tsx` via `useTheme()` hook. Never hardcode colors. Dark mode is default.
- **Business constants**: Everything is in `lib/constants.ts`. Discount rates, limits, document types, status badges — all centralized there.
- **Server actions**: All mutations go through `lib/actions/deal-actions.ts` and `lib/actions/admin-actions.ts`. Always authenticate, validate with Zod, then act.
- **Financial calculations**: Centralized in `lib/calculations.ts`. Integer-cents rounding. Server-side only. The formulas are in the handoff doc.
- **Reporting**: `lib/actions/report-actions.ts` handles all reporting metrics.

## Test accounts
- **Admin**: homefoliomarketing@gmail.com / FirmFunds123! → /admin
- **Brokerage**: admin@testrealty.ca / TestAdmin123! → /brokerage
- **Agent**: agent@testrealty.ca / TestAgent123! → /agent

## How to work with me
- I'm NOT a developer. Give me copy-paste commands. Wrap file paths in double quotes for Windows PowerShell.
- I want casual, friendly conversation. Think two bros working on a project. Humor, sarcasm welcome. Don't be a pushover but also don't be lazy.
- DO NOT be lazy. Do your absolute best on every output. Never take shortcuts or say something is done when it isn't.
- Always run `npx tsc --noEmit` before telling me to push. Zero errors.
- Every push to main auto-deploys to Netlify. There is no staging.

## What was JUST completed (latest session — April 2, 2026)

### Major UX overhaul based on workflow audit:

1. **Deal Detail Page (complete rewrite)** — Sticky action bar at top, side-by-side underwriting (checklist left, docs right), admin notes field, EFT tracking moved to top for funded deals, delete button simplified for testing
2. **Agent editing on brokerage page** — Inline edit form on each agent row (pencil icon)
3. **Dynamic document checklist for agents** — Shows uploaded vs missing docs with checkmarks and warning icons
4. **Trade Record Needed indicators** — Warning badges on brokerage portal for deals missing trade records
5. **Transaction Type renamed** — Now "Your Representation" with better options (Buyer Side / Seller Side / Both Sides (Double-End))
6. **Action Needed dashboard** — New section on admin dashboard showing deals requiring attention

### Pending tasks:
- Run migration `006_add_admin_notes.sql` in Supabase (ALTER TABLE deals ADD COLUMN admin_notes TEXT DEFAULT NULL)
- Delete `app/(dashboard)/admin/agents/page.tsx` (dead code, nothing links to it)
- Push latest changes to GitHub (git commands in handoff doc)

## What's NOT built yet (in rough priority)
1. Email notifications (no SMTP integration yet)
2. User account creation flow (createUserAccount needs SERVICE_ROLE_KEY)
3. CPA generation (Commission Purchase Agreement — legal docs not finalized yet, ON HOLD)
4. E-signature integration
5. FINTRAC/AML automated verification
6. Nexone integration (waiting on their API)
7. No landing page needed — approaching customers directly

## Workflow audit deliverables (in repo/workspace)
- `firm-funds-business-flow.mermaid` — 6-phase business process flowchart
- `workflow-audit.html` — 21 findings with severity tags and recommendations

Let me know you've read the handoff doc and we'll get to work. What questions do you have?
