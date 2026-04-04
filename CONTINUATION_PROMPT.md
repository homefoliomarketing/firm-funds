# Continuation Prompt — Paste This Into Your New Chat

**Copy everything below the line and paste it as your first message in the new chat.**

Also make sure the new chat has access to your project folder at `C:\Users\randi\Dev\firm-funds` so it can read HANDOFF.md directly.

---

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
- Keep it casual and friendly — I like working with someone who's real, not robotic. Swearing and sarcasm are welcome.

**The 3 golden rules of this codebase:**
1. **Always use `createServiceRoleClient()`** for server-side mutations. Regular Supabase clients are blocked by RLS — this has caused most of our bugs.
2. **NEVER send file uploads through Netlify.** Server actions AND API routes hang with file payloads. Use signed upload URLs → direct Supabase Storage upload → lightweight JSON API to update DB.
3. **Update the CSP in `next.config.ts`** whenever you add external scripts/resources. Silent CSP blocks have wasted hours of debugging.

**What was just completed (April 3, 2026):**
- ✅ Password change page fixed (fully client-side)
- ✅ PDF document viewer fixed (pdf.js canvas rendering + zoom)
- ✅ Mobile KYC upload fixed (signed URL pattern)
- ✅ Desktop auto-refresh after mobile upload (polling)
- ✅ CSP + middleware updates

**Top priority next:** Desktop KYC upload in `AgentKycGate.tsx` still uses a server action that could hang — needs to be converted to the signed URL pattern.

Read HANDOFF.md thoroughly, then let me know you're up to speed and let's keep building!
