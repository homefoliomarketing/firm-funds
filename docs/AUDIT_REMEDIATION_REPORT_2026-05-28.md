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

Nothing in this report proves production Supabase or Netlify are already updated. Those systems still need the new branch deployed and migration `094_active_status_rls_and_storage.sql` applied.

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

These cannot be proven from local files alone:

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
- Fix the flagged-agent login UX follow-up: Claude reported access is correctly blocked, but the login button can remain stuck on `Signing in...` instead of showing a clear rejection message.
- Separately confirm Supabase backup/PITR and Storage encryption posture from the Supabase dashboard or another authorized production source.
