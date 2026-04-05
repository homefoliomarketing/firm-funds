# Session 15 Continuation Prompt

Copy and paste this entire block as your first message in the new session:

---

You are continuing development on Firm Funds (firmfunds.ca), a commission advance platform for real estate agents in Ontario, Canada. This is Session 15.

## CRITICAL: Read before doing ANYTHING
1. Read `HANDOFF.md` in the project root — it has every feature completed, every migration applied, every known gotcha, and the planned next steps.
2. Read `AGENTS.md` — this Next.js version (16.2.1) has breaking changes. Read the docs in `node_modules/next/dist/docs/` before writing any code.
3. Use `createServiceRoleClient()` for ALL server-side mutations (Supabase RLS will block regular client calls).
4. Always run `npx tsc --noEmit` after changes — ignore `.next/` errors, fix everything else.
5. Always `await` async operations in server actions (especially email sends) — Netlify serverless kills unawaited promises.

## About Bud (the user)
- Casual, direct, doesn't get offended. Swearing and sarcasm are fine. Be a bro.
- ALWAYS paste SQL migrations directly in chat — never make him ask for them.
- ALWAYS provide git commands ready to copy-paste (PowerShell — use semicolons not &&, quote paths with parentheses).
- Don't over-explain. Don't be lazy. Do the work, give him the result.
- Dark mode only. `colors.gold` is green (#5FA873).

## What was just completed (Sessions 13-14)
- Brokerage admin invite flow with magic links (create login + send setup email)
- Settings pages on all 3 portals (agent, admin, brokerage)
- Admin can reset passwords and change emails for all users
- Permanent delete for archived agents
- Notification badges with counts (not `!`) on admin and brokerage portals
- Brokerage messaging fixed (CHECK constraint, RLS policies, await on email, error feedback)
- Password visibility toggle on login page
- Brokerage KPI tiles removed
- Underwriting UI fixes (dark headers, swapped checklist order)
- Enhanced referral fee reporting with chart + CSV export
- Manage Logins button styling + email change refresh bug fixes

## Planned next steps (discussed with Bud)
1. **E-Signature Integration** — Agents/brokerages need to sign Commission Purchase Agreement and Irrevocable Direction to Pay digitally before funding. DocuSign or equivalent.
2. **Funding Workflow / Commission Calculator** — "Funded" is currently just a status change. Need: fee calculation engine ($0.75/$1,000/day), breakdown visible before funding (agent gets X, fee is Y, brokerage referral is Z), disbursement tracking.
3. **Portfolio / Collections Dashboard** — Outstanding advances, aging, upcoming closings, capital deployed overview.
4. **White-Label Branding** — Brokerage-specific logos/colors on the agent-facing experience.

## NOT doing
- PPSA registration tracking — Bud decided the cost doesn't justify it per transaction.

## Business prerequisites (in progress on Bud's end, not blocking dev)
- Legal contracts (Commission Purchase Agreement, Irrevocable Direction to Pay, Brokerage Cooperation Agreement)
- FINTRAC registration
- Banking with EFT capability

## Key technical notes
- Migration files go in `supabase/migrations/` — next one is `029_*.sql`
- `deal_messages.sender_role` CHECK constraint: `('admin', 'agent', 'brokerage_admin')` — migration 028
- Magic link flow: `lib/actions/admin-actions.ts` → `inviteBrokerageAdmin`, `resendBrokerageSetupLink`
- Email templates: `lib/email.ts` (Resend, FROM: notifications@firmfunds.ca, ADMIN: bud@firmfunds.ca)
- There is a `commission-advance-startup` skill available — use it when Bud asks about business formation, compliance, or operational questions.

Ask Bud what he wants to work on today.
