# Session 7 — Firm Funds Continuation Prompt

Copy and paste everything below this line into your new chat:

---

You are continuing work on **Firm Funds** (firmfunds.ca), a commission advance platform for Ontario real estate agents. This is Session 7. I am Bud, the non-developer owner. I run commands you give me in PowerShell on Windows. I test on the live production site. Give me exact copy-paste commands — I cannot write code.

**Read `HANDOFF.md` in the project root first.** It contains the full tech stack, critical patterns, project structure, database schema, all completed work from Sessions 1-6, known issues, and planned future work. It is your bible for this project.

## What Happened in Session 6 (Most Recent)

### 1. Full Audit Trail System Built
- Enhanced audit_log table with 7 new columns (severity, actor_email, actor_role, old_value, new_value, user_agent, session_id)
- Migration: `migrations/005_audit_log_enhanced.sql` (already applied to production DB)
- Rewrote `lib/audit.ts` (server actions) + created `lib/audit-labels.ts` (client-safe labels/types)
- **Critical Next.js 16 lesson:** `'use server'` files can ONLY export async functions. Constants, types, and sync functions that client components need MUST go in a separate file without `'use server'`. This caused 7 Turbopack build errors that we fixed by splitting audit.ts into audit.ts + audit-labels.ts.
- Created `lib/actions/audit-actions.ts` for query/filter/export server actions
- Created `components/AuditTimeline.tsx` — visual timeline with severity dots, diffs, expandable entries
- Created `app/(dashboard)/admin/audit/page.tsx` — full audit explorer with search, filters, pagination, CSV/JSON export
- Created `app/api/audit/export/route.ts` — export endpoint with auth + CSRF
- Instrumented 10+ audit events across login, logout, deal edits, status changes, checklist toggles, EFT operations, document views, brokerage payment removals

### 2. Middleware Redirect Loop Fix
After wiping test data, users with auth sessions but no user_profiles row caused infinite redirects. Fixed middleware to sign out users with missing profiles.

### 3. Test Data Wiped Clean
All brokerages, agents, deals, documents, and audit logs deleted. Only Bud (super_admin) and James (super_admin) accounts remain. Fresh start for real data.

### 4. Admin Dashboard Cleanup
- Removed redundant "Registered Agents" KPI tile and "Manage Brokerages" quick link
- 3-column KPI layout: Total Deals | Total Advanced | Partner Brokerages
- Quick links: Reports, Audit Trail

## Key Technical Reminders
- **Next.js 16.2.1** with Turbopack — read `node_modules/next/dist/docs/` before writing code. `params` in dynamic routes are Promises.
- **NEVER send file uploads through Netlify** — use signed upload URLs + direct Supabase Storage
- **Dark mode locked** — all colors via `useTheme()`, `colors.gold` = green (#5FA873)
- **Service role client** (`createServiceRoleClient()`) for all server-side mutations
- **PowerShell:** use semicolons (`;`) not `&&`, wrap paths with parentheses in quotes
- **Audit log is immutable** — INSERT-only, DB triggers prevent UPDATE/DELETE
- **`'use server'` gotcha** — only async function exports allowed; shared types/constants go in separate files

## Upcoming Priorities

### E-Signature Integration
Need to integrate e-signatures (DocuSign, HelloSign, or similar) so agents can digitally sign commission purchase agreements. Needs an account + API key setup.

### Nexone Integration (Strategic Priority)
Nexone is a trade record management platform used by Ontario brokerages. Agents use it to complete trade records, fill out commissions, and submit deal documents. We want to build a seamless integration:

**Desired flow:**
1. Agent finishes trade record in Nexone
2. Sees "Get Paid Tomorrow with Firm Funds" button
3. Clicks → redirects to Firm Funds login
4. After auth, Firm Funds pulls trade data + documents from Nexone automatically
5. Deal created with docs attached, pipeline begins
6. Agent chooses: $X tomorrow (minus split) or full amount at closing

**Integration paths (preference order):**
1. Nexone REST/OAuth API (gold standard)
2. Nexone partner/embed program
3. Webhook + brokerage bridge (brokerage exports, Firm Funds ingests)

**Fully manual is NOT acceptable** — must be seamless. The login step is critical for identity + consent.

**First step:** Research what Nexone actually offers. Look into their API docs, partner programs, or webhook capabilities.

### Other Priorities
- Rate limiting (Upstash Redis) — login, password change, API routes unprotected
- MFA (Supabase TOTP)
- Convert desktop KYC upload to signed URL pattern
- Document request UI (email function exists, no admin button yet)
- Magic link invites (replace temp passwords in emails)

---

Start by reading `HANDOFF.md`, then ask me what I want to work on.
