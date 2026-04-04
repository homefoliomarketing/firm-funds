# Prompt for Next Chat Session

Copy and paste everything below the line into your next Claude chat to pick up right where we left off.

---

## START OF PROMPT

Hey! You're picking up where my last Claude session left off. I'm Bud, the non-developer owner of Firm Funds Inc. (firmfunds.ca) — a commission advance platform for Ontario real estate agents built with Next.js 16.2.1, Supabase, and deployed on Netlify.

**CRITICAL: Before writing any code, read these files in the project root:**
1. `HANDOFF.md` — the master document. Full tech stack, project structure, database schema, ALL completed work, known issues, patterns, and how to work with me.
2. `AGENTS.md` — warns about Next.js 16 breaking changes (params are Promises, read `node_modules/next/dist/docs/` before writing any dynamic route code).

**How we work together:**
- I can't write code — you write it, I run the commands you give me
- I run git commands in **PowerShell on Windows** at `C:\Users\randi\Dev\firm-funds` (paths with parentheses need double quotes; use `;` not `&&`)
- I run SQL migrations in the **Supabase SQL Editor** (you give me the exact SQL)
- Every push to `main` auto-deploys to Netlify production — there's no staging
- Always run `npx tsc --noEmit` before telling me to push — zero TypeScript errors or don't ship
- Keep it casual and friendly — I like working with someone who's real, not robotic

**The 3 golden rules of this codebase:**
1. **Always use `createServiceRoleClient()`** for server-side mutations. Regular Supabase clients are blocked by RLS — this has caused most of our bugs.
2. **NEVER send file uploads through Netlify.** Server actions AND API routes hang with file payloads. Use signed upload URLs → direct Supabase Storage upload → lightweight JSON API to update DB. See HANDOFF.md for the pattern.
3. **Update the CSP in `next.config.ts`** whenever you add external scripts/resources. Silent CSP blocks have wasted hours.

**Styling:** There's no `colors.accent` — use `colors.gold` (which is actually green #5FA873). All colors come from `useTheme()`. Dark mode is permanently locked.

**What was just completed (Session 3, April 3 2026):**
- ✅ Password change page — fully client-side, bypasses Netlify entirely
- ✅ Document viewer PDF rendering — pdf.js 3.x canvas approach with zoom controls
- ✅ Mobile KYC upload — 3-step signed URL pattern, bypasses Netlify for files
- ✅ Desktop auto-refresh after mobile KYC upload — 5-second polling
- ✅ Image and PDF zoom controls in document viewer panel
- ✅ CSP updated for pdf.js CDN and web workers
- ✅ Middleware updated for public /api/kyc-* routes

**What needs attention next (priority order):**
1. **Desktop KYC upload may hang** — `AgentKycGate.tsx` still uses `submitAgentKyc` server action which sends files through Netlify. Should be converted to the signed URL pattern like mobile was.
2. **Document request UI** — admin button to request documents from agents (email function exists, no UI yet)
3. **FINTRAC compliance reporting** — needs legal guidance
4. **Clean up dead code** — delete unused agents page, unused API routes
5. **Mobile-responsive optimization**

Read HANDOFF.md, then let's get to work!

## END OF PROMPT
