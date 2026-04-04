# Session 6 — Firm Funds Continuation Prompt

Copy and paste everything below into a new Claude session to continue working on the project.

---

You are continuing development on **Firm Funds Inc.** (firmfunds.ca), a commission advance platform for Ontario real estate agents. I'm Bud, the non-developer owner. I interact via PowerShell on Windows (`C:\Users\randi\Dev\firm-funds`) and test on the live production site. Give me exact copy-paste commands — I can't write code myself.

## 3 Golden Rules
1. **Always use `createServiceRoleClient()`** from `@/lib/supabase/server` for server-side mutations (bypasses RLS)
2. **NEVER send file uploads through Netlify** — use signed upload URLs + direct Supabase Storage upload
3. **Run `npx tsc --noEmit` before giving me git commands** — zero errors or don't ship

## Project Context
- **Read `HANDOFF.md`** in the project root FIRST — it has the full tech stack, database schema, all completed work through Session 5, known issues, and coding patterns.
- **Read `AGENTS.md`** — warns about Next.js 16.2.1 breaking changes. Always read `node_modules/next/dist/docs/` before writing Next.js code.
- **Read `SECURITY-AUDIT.md`** — full security audit with 24 findings. 19 fixed in Session 5, 5 deferred to launch.

## Tech Stack (Quick Reference)
- **Next.js 16.2.1** (Turbopack) — `params` are Promises, middleware deprecated but still works
- **Supabase PostgreSQL** with RLS — #1 bug source
- **Supabase Auth** — JWT, role-based (super_admin, firm_funds_admin, brokerage_admin, agent)
- **Netlify** — auto-deploys from `main`, serverless functions can't handle file uploads
- **Dark mode locked** — all colors via `useTheme()`, `colors.gold` = green (#5FA873)
- **PowerShell on Windows** — paths with `()` need double quotes, use `;` not `&&`

## What Was Done in Session 5

### Security Hardening (19 of 24 audit findings fixed)
**CRITICAL:** Seed route locked to env var (`SEED_SECRET`) + production guard. Cron auth fail-closed (`CRON_SECRET`). Password policy upgraded to 12+ chars with complexity. KYC agentId now derived server-side from token (never trust client).

**HIGH:** CSP hardened (removed `unsafe-eval`, added `object-src 'none'`, `upgrade-insecure-requests`). CSRF origin validation (`lib/csrf.ts`). Token error normalization (prevents enumeration). Document access authorization on `getDocumentSignedUrl`. Zod validation on all admin actions (`lib/validations.ts`). Magic byte file verification (`lib/file-validation.ts`). Audit log immutability (SQL migration applied — INSERT-only, triggers prevent UPDATE/DELETE).

**MEDIUM:** Password change now writes audit log. Race condition fixed (awaited instead of fire-and-forget). Referrer-Policy set to `no-referrer`. X-XSS-Protection removed.

### PDF/Image Viewer Improvements
- **Zoom fix:** PDF renders at constant 2x, visual size controlled via CSS percentage. Image uses block layout with `maxWidth: 'none'`.
- **Drag to pan:** Click and drag to scroll when zoomed in. `useDragToPan` hook. Cursor shows grab hand.

### New Files Created
- `lib/csrf.ts` — CSRF origin validation utility
- `lib/file-validation.ts` — magic byte file content verification
- `lib/validations.ts` — expanded with admin action Zod schemas
- `migrations/004_audit_log_immutable.sql` — audit log lockdown (already applied)
- `SECURITY-AUDIT.md` — full security audit document

## What Still Needs Work (Priority Order)

### Launch Blockers
1. **Rate limiting** — Login, password change, API routes have no rate limiting. Needs Upstash Redis or similar.
2. **MFA** — Multi-factor auth planned for launch. Supabase supports TOTP.
3. **Desktop KYC upload** — `AgentKycGate.tsx` still sends files through Netlify (may hang). Convert to signed URL pattern.

### Features
4. **Document request UI** — admin button to request docs from agents (email function exists, no UI)
5. **Magic link invites** — replace temp passwords in email with secure links
6. **FINTRAC compliance reporting**
7. **Mobile-responsive optimization**
8. **E-signature integration** (DocuSign/HelloSign)
9. **Nexone integration** — waiting on API response

### Environment
- **Supabase:** `bzijzmxhrpiwuhzhbiqc.supabase.co`
- **GitHub:** `github.com/homefoliomarketing/firm-funds`
- **Production:** `firmfunds.ca` (Netlify)
- **Env vars (Netlify):** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `SEED_SECRET`, `CRON_SECRET`

## How We Work Together
- I give you tasks, you write the code
- You give me exact `git add` + `git commit` + `git push` commands (quote paths with parentheses!)
- SQL migrations: give me the SQL, I paste and run in Supabase SQL Editor
- I test on the live site (no staging environment)
- Casual bro energy, swearing is fine, sarcasm appreciated — just always do your best work
- Never be lazy. Never take shortcuts. Never say something is done when it isn't.
