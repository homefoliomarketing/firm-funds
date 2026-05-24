# Firm Funds Security & Data Integrity Remediation Plan

**Created:** 2026-05-24
**Source:** Three-agent skeptical audit (data integrity, security/auth, financial correctness)
**Status:** Plan approved, awaiting Session 0 kickoff

---

## Why this plan exists

Three skeptical-engineer audits identified 18+ findings across data destruction risk, authorization gaps, and financial correctness. Several are launch blockers. This plan sequences fixes by risk class so we do not introduce regressions into a system that will handle real customer money.

Three principles drive the order:

1. **Backup before you touch anything.** Every session begins with a `pg_dump` snapshot.
2. **Fix bugs that corrupt existing data first.** Cure-election string mismatch and CPA arithmetic are bleeding wounds even at zero customer volume.
3. **Group changes by risk class.** Server-action auth fixes are low-risk. RLS / storage policy changes can lock people out. Atomic balance refactors touch every financial code path. Each is a separate session, tested in isolation, rollback-able.

---

## Solo vs Bud-required work

**Solo (no logins required from Bud):**
- All code changes
- All SQL migrations via Supabase CLI (`.env.local` has `SUPABASE_DB_URL`)
- Storage bucket policy changes via SQL
- Local `pg_dump` backups
- Testing via dev server + test accounts in memory

**Needs Bud (external account access):**
- DocuSign Connect HMAC setup (5 min in DocuSign admin)
- Adding `DOCUSIGN_HMAC_SECRET` to Netlify env (1 min)
- Supabase plan / PITR confirmation (check billing dashboard)
- S3 or R2 bucket for off-site backups (~15 min, deferred)
- Lawyer re-review after CPA arithmetic fix
- All pushes to main (per CLAUDE.md)

---

## Branch strategy

One worktree branch per session, branched off `main`. Naming: `claude/fix-session-N-shortname`. Merge to main only after testing passes and Bud reviews the diff.

---

## Session catalog

| # | Title | Solo? | Time | Risk | Status |
|---|-------|-------|------|------|--------|
| 0 | Initial snapshot | Yes | 10 min | None | Pending |
| 1 | Backup foundation + delete safety rails | Yes | ~2 hr | Low | Pending |
| 2 | Financial correctness | Yes | ~3 hr | Medium | Pending |
| 3 | Server-action authorization | Yes | ~2 hr | Low | Pending |
| 4 | Database layer hardening (RLS, storage) | Yes | ~2 hr | **HIGH** | Pending |
| 5 | DocuSign webhook HMAC | Coordinated | ~1 hr | Medium | Pending (blocks on Bud) |
| 6 | MEDIUM + LOW cleanup | Yes | ~3 hr | Low | Pending |

Total: ~13 hours of focused work across 6 sessions.

---

## Session 0: Initial snapshot (10 min)

Take a single anchor snapshot before any remediation work begins.

**Tasks:**
1. Run `pg_dump` against prod, gzip output, save to `backups/pre-remediation-YYYY-MM-DD.sql.gz` (gitignored).
2. Record row counts for `deals`, `agent_transactions`, `brokerages`, `remediation_deals`, `esignature_envelopes`. Save as `backups/pre-remediation-rowcounts.txt`.
3. Test the dump is valid: `pg_restore --list backups/pre-remediation-*.sql.gz | head`.

This snapshot is the "restore to here if everything goes wrong" anchor for the entire remediation.

---

## Session 1: Backup foundation + delete safety rails (~2 hr)

**Goal:** Make data destruction harder, make recovery possible.

**Branch:** `claude/fix-session-1-backups`

**Tasks:**
1. Take Session 1 pre-snapshot to `backups/pre-session-1-YYYY-MM-DD.sql.gz`.
2. Create `scripts/backup-db.ps1`: runs `pg_dump`, gzips, timestamps, retains last 14 days locally. Document Windows Task Scheduler setup.
3. Document restore procedure in `scripts/RESTORE.md` (one page).
4. **Migration 048**: Postgres trigger blocking `DELETE` on `deals` rows in statuses `funded` / `completed` / `failed_to_close` / `cured`. Mirror pattern from `034_prevent_agent_delete_with_deals.sql`.
5. Same migration: add `deleted_at TIMESTAMPTZ` column to `deals`.
6. Update `deleteDeal` in `lib/actions/deal-actions.ts:1427`: status guard at top (allow only `under_review` / `cancelled` / `denied`), switch to soft delete (set `deleted_at` instead of hard delete). Remove `// TEMPORARY for testing` comment.
7. **Migration 049**: change `remediation_deals.failed_deal_id` and `esignature_envelopes.deal_id` from `ON DELETE CASCADE` to `ON DELETE RESTRICT`.

**Verification:**
- Attempt to delete a funded test deal via SQL: trigger should block.
- Attempt delete via admin UI: server action should reject.
- Restore drill: load the snapshot into a local Postgres (or staging Supabase project if available).
- `npx tsc --noEmit` clean.

**Copy-paste prompt for fresh session:**

```
You're picking up Session 1 of the Firm Funds remediation plan in docs/REMEDIATION_PLAN.md.
Goal: backup foundation + delete safety rails.

Read docs/REMEDIATION_PLAN.md for full context. Then:

1. Take pg_dump snapshot to backups/pre-session-1-YYYY-MM-DD.sql.gz (gitignored).
2. Create scripts/backup-db.ps1 (pg_dump + gzip + timestamp + 14-day retention).
3. Create scripts/RESTORE.md (one-page restore procedure).
4. Migration 048: Postgres trigger blocking DELETE on deals in funded/completed/failed_to_close/cured (mirror 034_prevent_agent_delete_with_deals.sql). Add deleted_at TIMESTAMPTZ column to deals.
5. Update deleteDeal in lib/actions/deal-actions.ts:1427: status guard, soft delete via deleted_at. Remove "TEMPORARY for testing" comment.
6. Migration 049: change remediation_deals.failed_deal_id and esignature_envelopes.deal_id from ON DELETE CASCADE to ON DELETE RESTRICT.

Verification:
- Delete a funded test deal via SQL (should fail).
- Delete a funded test deal via UI (should fail).
- npx tsc --noEmit clean.

Use branch claude/fix-session-1-backups off main. Confirm with Bud before pushing to main.
```

---

## Session 2: Financial correctness (~3 hr)

**Goal:** Every dollar reconciles. No code path can mis-charge, double-charge, or lose a ledger entry to a race.

**Branch:** `claude/fix-session-2-financial`

**Tasks:**
1. Pre-snapshot to `backups/pre-session-2-YYYY-MM-DD.sql.gz`.
2. **CPA arithmetic (Finding 6)**: in `lib/contract-docx.ts:296`, substitute `{{NUMBER_OF_DAYS}}` with `getChargeDays(deal.days_until_closing)` so printed math reconciles. Add unit test asserting `printedDiscount === rate × face × printedDays`.
3. **Cure-election string (Finding 7)**: rename `'cash'` → `'cash_repayment'` everywhere. **Migration 050**: update DB CHECK constraint + `UPDATE deals SET cure_election='cash_repayment' WHERE cure_election='cash'`. Update writers in `lib/actions/deal-actions.ts:2001,2040`, readers in `app/(dashboard)/admin/pending-elections/page.tsx`, `lib/actions/cure-actions.ts:22`.
4. **Atomic balance updates (Finding 9)**: **Migration 052** creates Postgres function `apply_agent_balance_delta(agent_id uuid, delta numeric, txn_type text, description text, deal_id uuid, metadata jsonb) RETURNS agent_transactions`. Function does atomic UPDATE on `agents.account_balance` and INSERT on `agent_transactions` in same transaction. Switch all 9 call sites:
   - `lib/actions/account-actions.ts:78, 208, 366, 429, 489, 692`
   - `lib/actions/deal-actions.ts:660, 1942`
   - `lib/actions/remediation-actions.ts:318`
5. **Remediation phantom credit (Finding 12)**: in `markRemediationDealRemitted` (`lib/actions/remediation-actions.ts:283`), post `failed_deal_interest` ledger entry for `applyToUnposted` BEFORE applying the credit. Update `failed_deal_interest_charged`. Wrap both in one transaction (use the new RPC).
6. **Strike race (Finding 15)**: `lib/actions/admin-actions.ts:70-87`, replace read-modify-write with atomic `UPDATE brokerages SET late_strike_count = late_strike_count + 1, auto_bumped_to_14_days_at = COALESCE(auto_bumped_to_14_days_at, CASE WHEN late_strike_count + 1 >= 5 THEN NOW() END) WHERE id = $1 RETURNING ...`.
7. **Late-payment cron paid-deal check (Finding 13)**: `lib/actions/account-actions.ts:158`, sum confirmed `brokerage_payments` and skip if `total >= amount_due_from_brokerage - 0.01`.
8. **Settlement reminder per-deal (Finding 14)**: `app/api/cron/closing-date-alerts/route.ts:169,174`, use `deal.settlement_days_at_funding` instead of global constant.
9. **Migration 051**: backfill `settlement_days_at_funding = 14` for legacy under-review deals where the column is null.

**Verification:**
- Reconciliation script: for demo agent (`ef1bd077-b7c2-44f7-b46f-e5d9df688fd6`), assert `agent.account_balance === SUM(agent_transactions.amount)`. Run before and after.
- Manually generate a CPA via the admin UI, open the DOCX, verify `rate × face × printed_days == printed_discount`.
- Flip a test deal to `failed_to_close`, elect `cash_repayment`, verify it shows on `/admin/pending-elections`.
- Run late-payment cron locally against a "paid in full" deal: should NOT charge interest.
- `npx tsc --noEmit` clean.

**Copy-paste prompt:**

```
You're picking up Session 2 of the Firm Funds remediation plan in docs/REMEDIATION_PLAN.md.
Goal: financial correctness.

Read docs/REMEDIATION_PLAN.md Session 2 section for full task list, then:

Pre-work: pg_dump to backups/pre-session-2-YYYY-MM-DD.sql.gz.

Tasks (see plan doc for file paths and line numbers):
1. CPA arithmetic in lib/contract-docx.ts:296.
2. Cure-election string rename 'cash' → 'cash_repayment' (migration 050 + writers + UI).
3. Atomic balance updates via Postgres function (migration 052), update 9 call sites.
4. Remediation phantom credit fix in remediation-actions.ts:283.
5. Strike race fix via atomic UPDATE in admin-actions.ts:70-87.
6. Late-payment cron: skip paid deals in account-actions.ts:158.
7. Settlement reminder: use per-deal window in closing-date-alerts/route.ts:169,174.
8. Migration 051: backfill settlement_days_at_funding for under-review legacy deals.

Verification per plan: reconciliation script, CPA arithmetic check, cure-election dashboard, late-payment cron test.

Use branch claude/fix-session-2-financial off main. Confirm with Bud before pushing to main.
```

---

## Session 3: Server-action authorization (~2 hr)

**Goal:** Close every "any logged-in user can call this and get/change something they shouldn't" hole.

**Branch:** `claude/fix-session-3-authorization`

**Tasks:**
1. Pre-snapshot.
2. **Banking info leak (Finding 10)**: `lib/actions/profile-actions.ts:815` (`getAgentProfile`), add role + ownership check. Agent role: require `profile.agent_id === agentId`. Brokerage admin: require same brokerage. Admin: allowed.
3. **E-sign status auth (Finding 11)**: `lib/actions/esign-actions.ts:352-366, 584-599` (`getDealSignatureStatus`, `getBcaSignatureStatus`), call `getAuthenticatedUser()` first, verify ownership before returning envelope data.
4. **KYC PUT auth (Finding 3)**: `app/api/kyc-mobile-upload/route.ts:75-138`, re-check `expires_at` and `used_at` on the token, add `checkApiRateLimit`, validate every `filePath` in the request starts with `${tokenRecord.agent_id}/`.
5. **/api/seed hardening (Finding 16)**: `app/api/seed/route.ts`, remove the `ENABLE_SEED` env-var bypass entirely. Remove the hardcoded `TestPass123!` password. If seed is needed in dev, require local CLI invocation, never HTTP.
6. **cancelDeal document deletion order**: `lib/actions/deal-actions.ts:1365`, read `file_path` list BEFORE deleting `deal_documents` rows.
7. **deleteDocument order**: `lib/actions/deal-actions.ts:951`, swap order: DB delete first, then storage file.

**Verification:**
- Log in as a test agent. Attempt `getAgentProfile('some-other-agent-uuid')`. Should fail.
- Attempt `getDealSignatureStatus('not-your-deal-id')`. Should fail.
- Confirm `/api/seed` is unreachable in production regardless of env vars.
- Cancel a test deal, confirm storage files removed (not orphaned).
- `npx tsc --noEmit` clean.

**Copy-paste prompt:**

```
You're picking up Session 3 of the Firm Funds remediation plan in docs/REMEDIATION_PLAN.md.
Goal: server-action authorization.

Read docs/REMEDIATION_PLAN.md Session 3 section. Pre-snapshot to backups/pre-session-3-YYYY-MM-DD.sql.gz.

Tasks (file paths in plan doc):
1. getAgentProfile role + ownership check.
2. getDealSignatureStatus + getBcaSignatureStatus: require auth + ownership.
3. KYC mobile-upload PUT: re-check token expiry/used, rate-limit, validate filePath ownership.
4. /api/seed: remove ENABLE_SEED bypass + hardcoded password.
5. cancelDeal: read document paths before deleting rows.
6. deleteDocument: swap order (DB first, then storage).

Verification per plan: cross-agent profile fetch fails, cross-deal envelope fetch fails, seed route unreachable, no orphaned storage files.

Use branch claude/fix-session-3-authorization. Confirm with Bud before pushing.
```

---

## Session 4: Database layer hardening (~2 hr) **HIGH RISK**

**Goal:** Lock down storage buckets, make ledger immutable.

**Why this is high risk:** RLS and storage policy changes can lock users out of legitimate workflows. Tested via dev/staging first if possible. Session 3's app-layer auth fixes are belt-and-suspenders backup if a policy is too restrictive.

**Branch:** `claude/fix-session-4-rls`

**Tasks:**
1. Pre-snapshot. Verify integrity: `pg_restore --list backups/pre-session-4-*.sql.gz | head`.
2. **Storage bucket policy (Finding 2)**: **Migration 053** replaces the `deal-documents` "any authenticated user" policy with deal-ownership scoping. Skeleton:
   ```sql
   DROP POLICY "Authenticated users can view deal documents" ON storage.objects;
   CREATE POLICY "Deal-scoped read on deal-documents" ON storage.objects FOR SELECT TO authenticated USING (
     bucket_id = 'deal-documents' AND (
       EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = auth.uid() AND up.role IN ('super_admin','firm_funds_admin'))
       OR EXISTS (
         SELECT 1 FROM deals d JOIN user_profiles up ON up.id = auth.uid()
         WHERE d.id = ((storage.foldername(name))[1])::uuid
           AND (d.agent_id = up.agent_id OR d.brokerage_id = up.brokerage_id)
       )
     )
   );
   ```
3. Same migration: audit and tighten storage policies on `agent-kyc` bucket. If `011_fintrac_kyc.sql:28-43` comment is correct that dashboard is needed, attempt SQL first; if rejected, flag for Bud to apply via Supabase Dashboard.
4. **Ledger immutability (Finding 8)**: **Migration 054** splits `agent_transactions_admin_all` (FOR ALL) into `agent_transactions_admin_select` (FOR SELECT) and `agent_transactions_admin_insert` (FOR INSERT WITH CHECK). Remove UPDATE/DELETE.
5. Same treatment for `agent_invoices`, `deal_messages`, `document_returns`, `closing_date_amendments`, `audit_log`.

**Verification:**
- Log in as a test agent in a fresh browser. Use Supabase client directly (bypass app) to fetch another deal's signed CPA from `deal-documents`. Should fail.
- As admin SQL: attempt `UPDATE agent_transactions SET amount = 0 WHERE id = '...'`. Should fail.
- Confirm admin can still record payments via app (which routes through service role and RPC).
- Walk through admin / agent / brokerage flows in dev. Confirm no inadvertent lockouts.
- `npx tsc --noEmit` clean.

**Copy-paste prompt:**

```
You're picking up Session 4 of the Firm Funds remediation plan in docs/REMEDIATION_PLAN.md.
Goal: database layer hardening. HIGH RISK session (can lock users out).

Read docs/REMEDIATION_PLAN.md Session 4 section. Pre-snapshot to backups/pre-session-4-YYYY-MM-DD.sql.gz.
Verify backup integrity: pg_restore --list on the snapshot.

Tasks:
1. Migration 053: replace storage.objects deal-documents policy with deal-ownership scoping (SQL skeleton in plan doc).
2. Same migration: audit agent-kyc bucket policies. If SQL rejected, flag for Bud.
3. Migration 054: split agent_transactions_admin_all into separate SELECT and INSERT policies. Remove UPDATE/DELETE.
4. Same treatment for agent_invoices, deal_messages, document_returns, closing_date_amendments, audit_log.

Verification per plan: cross-agent storage read fails, admin SQL UPDATE on agent_transactions fails, app workflows unaffected.

Use branch claude/fix-session-4-rls. Confirm with Bud before pushing AND walk through staging if available.
```

---

## Session 5: DocuSign webhook HMAC (~1 hr, coordinated with Bud)

**Goal:** Stop the unauthenticated webhook fraud vector.

**Pre-requisite (Bud, 5 min):**
1. Log in to DocuSign admin → Connect → Configuration → enable HMAC Security.
2. Copy the generated HMAC secret.
3. In Netlify, add env var `DOCUSIGN_HMAC_SECRET=<that secret>` to production environment.

**Branch:** `claude/fix-session-5-docusign-hmac`

**Tasks (after Bud's pre-req):**
1. In `app/api/docusign/webhook/route.ts`: read raw body. Compute `HMAC-SHA256(body, DOCUSIGN_HMAC_SECRET)`, base64-encode. Constant-time compare against `X-DocuSign-Signature-1` header. Reject with 401 on mismatch.
2. **Fail closed** if `DOCUSIGN_HMAC_SECRET` is unset (return 401, log warning). Do NOT fall back to current behavior.
3. Add helper that redacts envelope IDs to first/last 4 chars in all `console.log` calls. Apply at lines 49, 130, 192, 261, 290, 301 of the webhook handler.
4. Add `DOCUSIGN_HMAC_DEV_BYPASS=1` env flag for local testing (never set in prod).

**Verification:**
- Local: POST a payload with computed HMAC, returns 200. Without HMAC, returns 401.
- After deploy: trigger a real DocuSign envelope completion, confirm webhook still processes correctly.
- Logs show only redacted envelope IDs.
- `npx tsc --noEmit` clean.

**Copy-paste prompt:**

```
You're picking up Session 5 of the Firm Funds remediation plan in docs/REMEDIATION_PLAN.md.
Goal: DocuSign webhook HMAC verification.

PRE-REQUISITE: Bud must have enabled HMAC in DocuSign Connect Configuration and set 
DOCUSIGN_HMAC_SECRET in Netlify env. CONFIRM with Bud before deploying.

Read docs/REMEDIATION_PLAN.md Session 5 section.

Tasks:
1. app/api/docusign/webhook/route.ts: HMAC-SHA256 verification of raw body against X-DocuSign-Signature-1.
2. Fail closed if DOCUSIGN_HMAC_SECRET is unset (return 401).
3. Redact envelope IDs to first/last 4 chars in all console.log calls (lines 49, 130, 192, 261, 290, 301).
4. Add DOCUSIGN_HMAC_DEV_BYPASS=1 dev escape hatch.

Verification: local payload test, real DocuSign sign test after deploy, log redaction confirmed.

Use branch claude/fix-session-5-docusign-hmac. Coordinate deploy with Bud (secret must be in Netlify FIRST).
```

---

## Session 6: MEDIUM + LOW cleanup (~3 hr)

**Goal:** Tighten remaining edges.

**Branch:** `claude/fix-session-6-cleanup`

**Tasks (most are 15-30 min each):**
1. Pre-snapshot.
2. **Rate limiter boot-time assert** (`lib/rate-limit.ts:13`): production throw if Upstash env vars missing. Login API fail-closed (503) when limiter unreachable.
3. **CSRF require Origin/Referer** (`lib/csrf.ts:39`): reject state-changing requests if neither header present.
4. **Audit export sanitization** (`app/api/audit/export/route.ts:74`): strip `, . ( ) %` from search param before PostgREST `or()` filter.
5. **PII logging cleanup**: grep `console.log` / `console.error`, redact envelope IDs, emails, deal IDs to first/last 4 chars.
6. **Compound interest formula decision (NEEDS BUD INPUT)**: either change `lib/calculations.ts:235` to `dailyRate = Math.pow(1.24, 1/365) - 1` (true 24% APR), OR amend CPA Article 6.3 in `lib/contract-docx.ts` to disclose "approximately 27.1% effective APR". Recommendation: change the code for cleaner customer story.
7. **`removeBrokeragePayment` refactor** (`lib/actions/admin-actions.ts:1928`): **Migration 055** converts `brokerage_payments` from JSONB array to a real table with stable UUIDs. Update all readers.
8. **Middleware exact-match exclusions** (`middleware.ts:42`): replace `startsWith('/api/kyc-')` with explicit allowlist of exact paths.
9. **Doc updates**: find-replace `$0.75` → `$0.80` in CLAUDE.md, HANDOFF.md, session notes. Code is already correct.
10. **CSP nonce** (`next.config.ts:38`): replace `'unsafe-inline'` for scripts with nonce-based CSP.

**Verification:**
- All previous test flows still work end-to-end.
- Login API returns 503 when Upstash unreachable.
- POST without Origin header rejected.
- `npx tsc --noEmit` clean.

**Copy-paste prompt:**

```
You're picking up Session 6 of the Firm Funds remediation plan in docs/REMEDIATION_PLAN.md.
Goal: MEDIUM + LOW cleanup.

Read docs/REMEDIATION_PLAN.md Session 6 section. Pre-snapshot to backups/pre-session-6-YYYY-MM-DD.sql.gz.

Tasks (file paths in plan doc):
1. Rate limiter boot-time assert + login 503 on Upstash failure.
2. CSRF require Origin or Referer.
3. Audit export search param sanitization.
4. PII log redaction (envelope IDs, emails, deal IDs).
5. ASK BUD: compound interest formula (code change vs CPA amendment).
6. Refactor brokerage_payments JSONB → real table (migration 055).
7. Middleware exact-match exclusions.
8. Doc find-replace $0.75 → $0.80.
9. CSP nonce-based replacement for 'unsafe-inline' scripts.

Verification: full flow regression, login 503 test, POST-without-Origin rejection, npx tsc --noEmit clean.

Use branch claude/fix-session-6-cleanup. Confirm with Bud before pushing.
```

---

## Bud's external action checklist

These run in parallel with solo sessions. None are urgent until launch except DocuSign HMAC.

| Action | Where | Time | Blocks |
|--------|-------|------|--------|
| Confirm Supabase plan tier and PITR retention | Supabase Dashboard → Billing | 2 min | Off-site backup urgency |
| Enable DocuSign Connect HMAC, copy secret | DocuSign Admin → Connect → Configuration | 5 min | Session 5 |
| Add `DOCUSIGN_HMAC_SECRET` to Netlify env | Netlify Dashboard → Site Settings → Env Vars | 1 min | Session 5 |
| (Optional) S3 or R2 bucket for off-site backups | AWS or Cloudflare | 15 min | Long-term backup robustness |
| (Optional) Add S3/R2 creds to env | Netlify Dashboard | 2 min | Backup automation upgrade |
| Lawyer review of CPA fix (Session 2) | After Session 2 | varies | Go-live |
| Lawyer review of full pricing/settlement restructure | (already in handoff) | varies | Go-live |
| Upgrade DocuSign to Business Pro | DocuSign billing | 5 min | Branded envelopes pre-launch |
| Source 45 missing agent emails | Brokerage liaison | varies | Go-live |

---

## Findings cross-reference

For each finding, the session that fixes it.

### Catastrophic
| # | Finding | Session |
|---|---------|---------|
| 1 | DocuSign webhook has no signature verification | 5 |
| 2 | `deal-documents` bucket: any authenticated user reads everything | 4 |
| 3 | KYC mobile-upload PUT accepts attacker file paths, no expiry check | 3 |
| 4 | `deleteDeal` hard-deletes funded deals with cascade wipe | 1 |
| 5 | No documented backups | 1 |
| 6 | CPA Article 3.2 arithmetic doesn't reconcile | 2 |
| 7 | Cure-election filter mismatch (`cash` vs `cash_repayment`) | 2 |

### High
| # | Finding | Session |
|---|---------|---------|
| 8 | `agent_transactions` admin RLS is FOR ALL (mutable ledger) | 4 |
| 9 | All balance updates are non-atomic read-modify-write | 2 |
| 10 | `getAgentProfile` returns banking info to any authenticated user | 3 |
| 11 | E-sign status server actions have no auth | 3 |
| 12 | Remediation remittance creates phantom credits | 2 |
| 13 | Late-payment cron charges paid brokerages | 2 |
| 14 | Settlement reminder hardcodes 7 days, breaks for 14-day brokerages | 2 |
| 15 | `recordLateStrike` race condition | 2 |
| 16 | `/api/seed` exposable in production via env flag | 3 |
| 17 | Cascade-delete chains can wipe IDP / BCA / envelope history | 1 |

### Medium / Low
| # | Finding | Session |
|---|---------|---------|
| - | Rate limiter fails open silently | 6 |
| - | CSRF allows no-Origin requests | 6 |
| - | `cancelDeal` deletes documents before reading paths | 3 |
| - | PostgREST filter injection on audit export search | 6 |
| - | PII (envelope IDs, deal IDs, emails) logged to console | 6 |
| - | Daily compounding formula yields ~27.1% effective APR | 6 |
| - | `removeBrokeragePayment` mutates JSON array by index | 6 |
| - | `deleteDocument` removes storage file before DB row | 3 |
| - | Funding-time fallback bypasses lock-at-submission | 2 (backfill) |
| - | Middleware `startsWith('/api/kyc-')` foot-gun | 6 |
| - | Hardcoded seed admin password in source | 3 |
| - | Closing-date alerts cron row-by-row UPDATE | (deferred) |
| - | CSP `'unsafe-inline'` for scripts | 6 |
| - | Docs reference $0.75 (code is correct $0.80) | 6 |

---

## What was NOT audited (next time)

From the original three audits, agents flagged these as "needs deeper review":

- `lib/actions/admin-actions.ts` lines outside the spot-checked sections (~2,500 lines unread)
- `lib/actions/notification-actions.ts`, `amendment-actions.ts`, `settings-actions.ts`, `audit-actions.ts`
- `agent-kyc` bucket policies in the live Supabase project (only SQL was read)
- Whether `SUPABASE_SERVICE_ROLE_KEY` has ever been logged historically
- DocuSign OAuth callback CSRF state validation
- `is_active = false` enforcement at middleware
- Whether secondary migration tree `./migrations/` (not `./supabase/migrations/`) is dead code
- DocuSign token refresh concurrency in `lib/docusign.ts`

Schedule a second-pass audit after launch volume reaches ~50 funded deals.
