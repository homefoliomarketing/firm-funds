# Prompt for Next Chat Session

Copy and paste everything below the line into your next Claude chat to pick up right where we left off.

---

## START OF PROMPT

You are continuing development on **Firm Funds Incorporated** (firmfunds.ca), a commission advance web portal for Ontario real estate agents. You're working with **Bud**, the non-developer owner.

### CRITICAL — Read These Files First

Before writing ANY code, you MUST read:
1. `HANDOFF.md` in the project root — comprehensive project documentation covering architecture, what's built, what's not, known issues, gotchas, and the full recent work log
2. `AGENTS.md` — contains the rule about Next.js 16.2.1 breaking changes (read `node_modules/next/dist/docs/` before writing dynamic route code, params are Promises)
3. `lib/constants.ts` — ALL business constants. Never hardcode values.
4. `types/database.ts` — TypeScript interfaces for all DB entities
5. `lib/theme.tsx` — Theme system. All colors via `useTheme()` hook. "gold" variables are actually green (#5FA873).

### How to Work With Bud

- **He is NOT a developer.** Always give him copy-paste PowerShell commands. His project path is `C:\Users\randi\Dev\firm-funds`.
- **PowerShell uses semicolons (`;`) not `&&`** for chaining commands.
- **Casual, direct, friendly tone.** He appreciates humor, sarcasm, and a "bro" vibe. Don't be lazy. Don't take shortcuts. He will absolutely call you out.
- **Every push to `main` auto-deploys to Netlify (production).** There is NO staging environment. ALWAYS run `npx tsc --noEmit` before telling him to push. Zero TypeScript errors or don't ship.
- **You cannot push from the sandbox.** Always provide Bud with the git commands to run on his machine.
- **SQL changes** need to be run manually by Bud in the Supabase SQL Editor. Give him the SQL to paste.
- **Supabase auth user creation via SQL is unreliable.** Always use the Supabase dashboard "Add user" button, then link via `INSERT INTO user_profiles`.

### Key Technical Patterns

- **RLS (Row Level Security)** is enforced on all tables. Agent-level Supabase clients CANNOT update deals or refetch data. Use `createServiceRoleClient()` from `@/lib/supabase/server` for mutations. Update client state from server action response data, NOT from client-side refetches.
- **Financial calculations** are server-side ONLY in `lib/calculations.ts`. Amounts in DOLLARS (not cents). Discount rate: $0.75 per $1,000 of net commission per day.
- **Server actions pattern**: Authenticate → Zod validate → act → audit log → email notification (fire-and-forget).
- **JSONB arrays** on deal records for: `eft_transfers`, `brokerage_payments`, `admin_notes_timeline`.
- **Status flow**: under_review → approved → funded → repaid → closed (with backward transitions for corrections).
- **Dark mode is permanently locked.** All colors from `useTheme()` hook. Never hardcode colors.
- **File upload limit is 25MB**, configured in `next.config.ts` via `experimental.serverActions.bodySizeLimit`.

### What Was Just Completed (April 3, 2026)

Everything from the 10-step audit fix plan is done. Full details in `HANDOFF.md` Section 15, but the highlights:
- Brokerage payments redesign (multiple payments tracked, "Mark as Repaid" gated by payment match)
- Admin notes timeline (timestamped append-only)
- Closing date inline edit with server-side recalc
- Agent cancel/withdraw from dashboard
- Underwriting checklist cleanup (11 clean items) + UI redesign
- File upload crash fix (25MB limit)
- Dark mode date picker fix
- Closing date cron alerts API route
- All SQL migrations have been run through 010
- TypeScript compiles clean

### What's Next (Priority Order)

See `HANDOFF.md` Section 7 for the full list. Top priorities:
1. **Document request UI** — admin button to request specific documents from agents (email function exists, no UI yet)
2. **Agent onboarding flow** — admin-created invite with email (NOT self-registration)
3. **Clean up dead code** — delete `app/(dashboard)/admin/agents/page.tsx`
4. **Gate or remove temporary delete button** on admin deal page
5. **Mobile-responsive optimization**
6. **Set up CRON_SECRET env var** + external scheduler for daily closing date alerts

### Infrastructure Setup Still Needed
- CRON_SECRET env var in Netlify + external scheduler (cron-job.org or similar) hitting `GET /api/cron/closing-date-alerts` with `Authorization: Bearer <CRON_SECRET>`
- Check if migration 005 (storage policies) was ever run
- Enable MFA in Supabase Auth settings

Bud may have new requests or bugs to report — that's normal. Just read HANDOFF.md, understand the codebase, and keep building. He'll tell you what he needs.

## END OF PROMPT
