# New Chat Startup Prompt for Firm Funds Development

**Copy and paste everything below the line into a new chat session. Attach the file `Firm_Funds_Handoff_v3.docx` alongside this message.**

---

I'm Bud, and I'm building Firm Funds Incorporated (firmfunds.ca) — a commission advance company for Ontario real estate agents. The attached handoff document (Firm_Funds_Handoff_v3.docx) has EVERYTHING you need: business model, technical architecture, database schema, file structure, what's built, what's not, known issues, future roadmap, and how to work with me.

READ THAT DOCUMENT THOROUGHLY BEFORE DOING ANYTHING. It's your bible for this project.

Here's the quick version:

## What this is
A Next.js 16.2.1 + Supabase portal where real estate agents submit commission advance requests, I (as admin) underwrite and fund them, and partner brokerages earn referral fees. It's deployed on Netlify, auto-deploys from the main branch on GitHub.

## Critical technical notes
- **Next.js 16.2.1 has BREAKING CHANGES** from what you know. Read `AGENTS.md` and the docs in `node_modules/next/dist/docs/` before writing any Next.js code.
- **Theme system**: All colors come from `lib/theme.tsx` via `useTheme()` hook. Never hardcode colors. Dark mode is default.
- **Business constants**: Everything is in `lib/constants.ts`. Discount rates, limits, document types, status badges — all centralized there.
- **Server actions**: All mutations go through `lib/actions/deal-actions.ts`. Always authenticate, validate with Zod, then act.
- **Financial calculations**: Centralized in `lib/calculations.ts`. Integer-cents rounding. The formulas are in the handoff doc.

## Test accounts
- **Admin**: homefoliomarketing@gmail.com / FirmFunds123! → /admin
- **Brokerage**: admin@testrealty.ca / TestAdmin123! → /brokerage
- **Agent**: agent@testrealty.ca / TestAgent123! → /agent

## How to work with me
- I'm NOT a developer. Give me copy-paste commands. Wrap file paths in double quotes for Windows PowerShell.
- I want casual, friendly conversation. Think two bros working on a project. Humor, sarcasm welcome.
- DO NOT be lazy. Do your absolute best on every output. Never take shortcuts or say something is done when it isn't.
- Always run `npx tsc --noEmit` before telling me to push.
- Always verify your work visually when possible.

## What's working right now
Login, admin dashboard + deal detail with underwriting checklist, agent dashboard + deal submission + deal detail with doc upload, brokerage dashboard with agent flagging and deal viewing. Dark mode across everything. Real logo in headers.

## What's NOT built yet (in rough priority)
1. Email notifications (no SMTP integration yet)
2. E-signature integration for legal documents
3. Agent/brokerage self-registration or invite system
4. Admin management panel for brokerages/agents (CRUD)
5. EFT transfer tracking UI
6. Nexone integration (waiting on their API response)
7. FINTRAC/AML automated verification
8. Reporting/analytics dashboard

Let me know you've read the handoff doc and we'll get to work. What questions do you have?
