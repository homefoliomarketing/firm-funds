# Audit Remediation Report - 2026-05-28

## Plain-English Summary

This branch ports the remaining security audit fixes onto the current `origin/main` codebase without force-pushing old history. The work was done on a separate branch named `audit-port-current-main`.

The main risk areas fixed here are:

- vulnerable/unneeded dependencies
- browser-side access to sensitive audit/document operations
- document signed URL generation that trusted caller-provided paths
- missing active/suspended/flagged account checks in auth and storage policy layers
- stale Next.js `middleware.ts` convention
- script CSP hardening

Production verification was later completed against `firmfunds.ca`; see the final production verification section at the end of this report.

## Code Changes

### Dependency Hardening

- Removed the vulnerable `xlsx` dependency path and replaced spreadsheet import with CSV import handled by a server action.
- Removed unused project-audit dependencies: `shadcn`, `@tanstack/react-query`, `react-hook-form`, `@hookform/resolvers`, and `zustand`.
- Upgraded and pinned `next` and `eslint-config-next` to `16.2.6`.
- Upgraded and pinned `resend` to `6.12.4`.
- Pinned package versions exactly in `package.json`.
- Added package overrides for vulnerable transitive packages: `postcss`, `qs`, `ws`, and `brace-expansion`.

### Server-Side Sensitive Operations

- Added `lib/actions/auth-actions.ts` for server-side login/logout audit logging.
- Removed browser-side direct writes to `audit_log` from login/logout components.
- Changed agent deal document upload to use the existing server action instead of browser Storage upload plus browser DB insert.
- Changed deal document signed URL generation to use trusted database records by `documentId`, not caller-supplied file paths.
- Changed deal document deletion to load the trusted file path server-side before deleting storage.
- Added server-side signed URL action for agent pre-authorized debit forms.
- Replaced browser `agent-preauth-forms.createSignedUrl` calls in admin pages.
- Added server-side signed URL action for brokerage documents.

### Auth, RLS, and Storage Hardening

- Added shared access helpers in `lib/access.ts`.
- Updated `lib/auth-helpers.ts` so active profile, active agent, flagged-agent, and active brokerage checks are enforced consistently.
- Added `supabase/migrations/094_active_status_rls_and_storage.sql`.
- Migration 094 updates RLS helper functions and storage policies so direct Supabase calls also respect inactive/suspended/flagged states.
- Migration 094 removes direct authenticated inserts into `audit_log`; audit writes should go through service-role server paths.
- Tightened brokerage-logo storage writes to active internal admins.
- Fixed the preauth storage policy so paths are checked against `agent_id`, not `auth.uid()`.

### Next.js and Security Headers

- Moved `middleware.ts` to `proxy.ts` for Next 16.
- Added nonce-based script CSP in `proxy.ts`.
- Removed CSP from `next.config.ts` so per-request nonce CSP is applied dynamically.
- Kept strict static headers in `next.config.ts`.
- Made `app/layout.tsx` dynamic with `connection()` so nonce CSP can work correctly.

### Cleanup

- Removed stale `shadcn/tailwind.css` import after uninstalling `shadcn`.
- Removed dead light-theme state from `lib/theme.tsx`.
- Fixed DocuSign config validation so local/CI builds do not fail during route analysis, while production DocuSign calls still fail closed if required env vars are missing or sandbox URLs are configured.

## Verification

Commands run from `C:\tmp\firm-funds-audit-port`:

- `npx.cmd tsc --noEmit --incremental false` - passed.
- `npm.cmd audit --json` - passed with 0 vulnerabilities.
- `npm.cmd audit --omit=dev --json` - passed with 0 vulnerabilities.
- `npm.cmd run build` - passed with Next 16.2.6.
- `git diff --check` - passed.
- Focused grep checks - passed:
  - no browser direct `audit_log` inserts in `app` or `components`
  - no browser `agent-preauth-forms.createSignedUrl` calls
  - no browser direct `deal-documents` upload/signing calls
- Focused lint on new security helper files passed:
  - `lib/access.ts`
  - `lib/actions/auth-actions.ts`
  - `proxy.ts`

`npm.cmd run lint` still fails because the repository has a broad existing lint baseline: 513 errors and 182 warnings, mostly `no-explicit-any`, hook dependency, and image warnings across many files. This branch did not attempt a full lint cleanup because that would be a separate large refactor.

## Still Required Outside This Branch

Historical note: these were the required external checks before production verification. They are superseded by the final production verification section below.

- Deploy this branch before treating the fixes as live.
- Apply `supabase/migrations/094_active_status_rls_and_storage.sql` to the production Supabase database.
- Confirm production Netlify has required environment variables:
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `CRON_SECRET`
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`
  - DocuSign variables if DocuSign is live: `DOCUSIGN_HMAC_SECRET`, `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_SECRET_KEY`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_AUTH_URL`, `DOCUSIGN_BASE_URL`, `DOCUSIGN_REDIRECT_URI`
- Confirm DocuSign Connect has HMAC enabled and matches `DOCUSIGN_HMAC_SECRET`.
- Confirm Supabase production backup/PITR and Storage encryption posture.
- Walk through admin, agent, and brokerage happy-path flows after deployment.

## Deployment Recommendation

Historical note: this was the recommended sequence before the branch was merged and deployed. Production is now on commit `8ad5813a63b7e6f09262150c635dc14010018527`.

Do not force-push `main`.

Recommended sequence:

1. Push branch `audit-port-current-main`.
2. Open a pull request into `main`.
3. Have Claude or another reviewer inspect this branch and this report.
4. Deploy the branch/PR preview.
5. Apply migration 094 to Supabase.
6. Run post-deploy smoke tests.
7. Merge only after the smoke tests pass.

## 2026-05-28 Production Smoke Update

This update records the follow-up run that required production Netlify and Supabase access. The Netlify/Supabase details below are based on Claude's reported run from 2026-05-28. The local code state was independently verified after pulling the branch update.

### Claude-Reported Production/Preview Results

- Production Supabase migration `094_active_status_rls_and_storage.sql` was applied in a transaction.
- Netlify production environment variable names were reported present for Supabase, Upstash/cron, and DocuSign.
- DocuSign URLs were reported as production URLs, not demo/sandbox URLs.
- A Netlify branch preview was deployed at `https://audit-port-current-main--unique-faloodeh-288d13.netlify.app`.
- Smoke tests passed for admin login, admin preauth viewing, brokerage admin login, brokerage document viewing, agent login, agent deal document viewing, agent deal document upload, and inactive/flagged access denial.
- Smoke test fixtures were reported cleaned up after verification.

### Required Hotfix Discovered During Smoke Testing

Applying migration 094 exposed a real production RLS regression:

- Policies created in 094 queried `public.brokerage_admins` directly.
- The existing `brokerage_admins_select` policy self-references that same table.
- Authenticated reads that evaluated those new policies could fail with Postgres RLS infinite-recursion errors.
- The storage policies also had a column-shadowing bug: inside joins that included `brokerages`, the unqualified `name` in `storage.foldername(name)` could resolve to `brokerages.name` instead of `storage.objects.name`.

Claude added, applied, committed, and pushed `supabase/migrations/095_fix_brokerage_admins_recursion.sql` in commit `d541892`.

Migration 095 is mandatory with migration 094. Do not apply or ship 094 without 095.

Migration 095:

- Adds `public.is_user_brokerage_admin_of(user_id, brokerage_id)` as a `SECURITY DEFINER` helper for brokerage-admin membership checks that must bypass RLS recursion.
- Recreates the affected `deal-documents` storage policies using that helper.
- Qualifies `storage.objects.name` inside the storage folder checks.
- Recreates the affected `brokerage_documents` brokerage-admin select policy using the helper.

### Local Verification After Pulling 095

After fast-forwarding local branch `audit-port-current-main` to `d541892`, these commands passed from `C:\tmp\firm-funds-audit-port`:

- `npx.cmd tsc --noEmit --incremental false`
- `npm.cmd audit --json`
- `npm.cmd run build`

Full-repository lint is still not clean; this remains the existing broad lint baseline noted earlier in this report.

### Remaining Items

- Merge `audit-port-current-main` only with both migrations 094 and 095 included.
- After merge/deploy to production, run one final production smoke test on `firmfunds.ca`.
- Separately confirm Supabase backup/PITR and Storage encryption posture from the Supabase dashboard or another authorized production source.

### Follow-Up Login UX Fix

After the main audit branch was merged, `lib/actions/auth-actions.ts` was updated so password login now checks agent status, brokerage status, and brokerage flags before returning a successful login result. Blocked users are signed back out, an `auth.login_blocked` audit event is recorded, and the login page receives a normal error response instead of hanging on `Signing in...`.

Verified after this follow-up:

- `npx.cmd tsc --noEmit --incremental false`
- `npx.cmd eslint -- lib/actions/auth-actions.ts`
- `npm.cmd run build`

## Final Production Verification - 2026-05-28

This section records Claude's production dashboard/browser verification after `main` was updated to commit `8ad5813a63b7e6f09262150c635dc14010018527`.

### Netlify

- Deploy ID: `6a188b93f92e5f0009808a62`
- Production URL: `https://firmfunds.ca`
- Branch: `main`
- Commit: `8ad5813a63b7e6f09262150c635dc14010018527`
- Commit message: `fix(auth): block inactive agent login before redirect`
- Status: published production deploy.
- Deploy time: 2026-05-28 at 2:38 PM ET, deployed in 1m 41s.

### Production Smoke Tests

Claude reported these production smoke-test results:

- Admin login: passed.
- Admin brokerage page/agent-list load: passed.
- Admin preauth form view: not interactively exercised because production has no uploaded preauth forms.
- Brokerage admin login: passed.
- Brokerage document access: passed for `deal_documents`; `brokerage_documents` had no production rows to click, but the 095 policy body was verified.
- Agent login: passed.
- Agent deal document view: passed.
- Agent document upload: passed, then cleanup completed.
- Inactive-agent login denial: passed; the page showed a visible inactive-account error and did not hang on `Signing in...`.
- No 5xx responses, RLS recursion errors, or infinite-recursion policy errors were observed during the smoke test.

### Supabase Migrations And Policies

Claude reported production project ref `bzijzmxhrpiwuhzhbiqc`.

Migration `094_active_status_rls_and_storage.sql` was verified applied:

- Helper functions present: `public.get_user_role()`, `public.get_user_agent_id()`, `public.get_user_brokerage_id()`, `public.is_admin()`.
- Storage policies present for scoped deal documents, active agent preauth forms, admin preauth reads, and admin brokerage logo writes.
- Table policies present for active admin brokerage-document access and active brokerage-admin brokerage-document reads.

Migration `095_fix_brokerage_admins_recursion.sql` was verified applied:

- Helper present: `public.is_user_brokerage_admin_of(p_user_id uuid, p_brokerage_id uuid)`.
- `deal_documents_select_scoped` uses the helper and qualified `storage.foldername(objects.name)`.
- `brokerage_documents_brokerage_select_active` uses the helper.
- No `brokerage_admins` RLS recursion was observed during smoke testing.

### Environment And DocuSign

Claude reported all required production Netlify environment variable names present. Values were not exposed.

Required names confirmed:

- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `CRON_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `DOCUSIGN_HMAC_SECRET`
- `DOCUSIGN_ACCOUNT_ID`
- `DOCUSIGN_AUTH_URL`
- `DOCUSIGN_BASE_URL`
- `DOCUSIGN_INTEGRATION_KEY`
- `DOCUSIGN_REDIRECT_URI`
- `DOCUSIGN_SECRET_KEY`

DocuSign URLs were reported as production URLs:

- `DOCUSIGN_AUTH_URL`: `account.docusign.com`, not demo.
- `DOCUSIGN_BASE_URL`: Canadian production host `ca.docusign.net`, not demo.

### Cleanup

Claude reported the smoke-test upload row/object was deleted, local scratch files were removed, and the test agent `is_active` flag was restored.

### Remaining Operational Risks

These are not code defects in the deployed commit; they are production account/infrastructure settings to address before handling meaningful funds:

- Supabase is on the Free plan, so scheduled backups are not available.
- Supabase Point-in-Time Recovery is not available on the current plan.
- Supabase incoming Postgres SSL enforcement is disabled.
- Supabase database network restrictions/IP allowlisting are not configured.
- Admin preauth-form viewing still needs a live-data smoke test once at least one production agent uploads a preauth form.

Recommended priority:

1. Upgrade Supabase to a plan that supports scheduled backups.
2. Enable PITR if the business risk justifies the add-on cost.
3. Enable `Enforce SSL on incoming connections`.
4. Add a database IP allowlist once all legitimate direct database clients are known.
5. Retest the admin preauth-form viewer after the first real preauth upload exists.
