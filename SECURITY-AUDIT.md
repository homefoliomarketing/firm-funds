# Firm Funds — Security Audit Report

**Date:** April 3, 2026 (Session 4)
**Scope:** Full application codebase, configuration, and architecture
**Context:** Financial services app handling commission advances, KYC documents (government IDs), personal financial data, and money movement for Ontario real estate agents. Subject to FINTRAC and PIPEDA regulations.

---

## How Financial Companies Protect Data (Industry Context)

Before the findings, here's what companies handling millions in transactions typically have in place:

**Data Protection:** Encryption at rest (AES-256) and in transit (TLS 1.2+). Field-level encryption for PII like government IDs. Key management via HSM or cloud KMS (AWS KMS, Google Cloud KMS). Regular key rotation.

**Backup & Disaster Recovery:** Automated daily database backups with point-in-time recovery. Backups replicated to a geographically separate region. Regular backup restoration tests (not just "we have backups" but "we've proven we can restore them"). RPO (Recovery Point Objective) of 1 hour or less, RTO (Recovery Time Objective) of 4 hours or less. Immutable backups that can't be deleted even by admins.

**Access Controls:** Principle of least privilege everywhere. Multi-factor authentication (MFA) mandatory for all internal users. IP whitelisting for admin access. Role-based access enforced at the database level (not just app level). Separate environments (dev/staging/prod) with no shared credentials.

**Monitoring & Compliance:** Real-time alerting on suspicious activity. Immutable audit logs (append-only, cannot be modified). Penetration testing at least annually. SOC 2 Type II or equivalent compliance program. FINTRAC reporting and record-keeping for 5+ years.

**What Firm Funds has today:** Supabase provides automated daily backups, TLS in transit, and JWT-based auth. This is a solid foundation, but there are gaps. The findings below identify them.

---

## Summary

| Severity | Count | Description |
|:--------:|:-----:|-------------|
| CRITICAL | 6 | Must fix before handling real money |
| HIGH | 8 | Fix within 1-2 weeks |
| MEDIUM | 6 | Fix within 1 month |
| LOW | 4 | Fix when convenient |
| **TOTAL** | **24** | |

---

## CRITICAL Findings

---

### C1. Seed Route Exposes Full Database Destruction in Production

**File:** `app/api/seed/route.ts` (line 15)
**Impact:** An attacker can DELETE all brokerages, agents, deals, and audit logs from production.

The seed route is protected only by a hardcoded query parameter `?key=firmfunds-seed-2026` visible in source code. The DELETE handler wipes all seeded data, but if `[SEED]` tags were removed from records, it could destroy real data too. More critically, this endpoint exists in production at all.

**Remediation:**
- Immediately: Add `if (process.env.NODE_ENV === 'production') return Response.json({ error: 'Not available' }, { status: 403 })` at the top of both handlers
- Better: Delete the route entirely from production. Use a separate local script for seeding.
- If kept: Move key to `process.env.SEED_SECRET` (never hardcode secrets)

---

### C2. Cron Route Auth Bypassed When CRON_SECRET Is Not Set

**File:** `app/api/cron/closing-date-alerts/route.ts` (lines 21-25)
**Impact:** Anyone can trigger the cron job, causing email spam to admins and revealing deal data.

The current logic: `if (cronSecret && authHeader !== ...)` — if `CRON_SECRET` env var is not set (undefined/empty), the entire auth check is skipped. The route becomes fully public.

**Remediation:**
```typescript
const cronSecret = process.env.CRON_SECRET
if (!cronSecret) {
  return Response.json({ error: 'Cron not configured' }, { status: 500 })
}
if (authHeader !== `Bearer ${cronSecret}`) {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}
```

---

### C3. No Brute Force Protection on Login

**File:** `app/(auth)/login/page.tsx`
**Impact:** Unlimited login attempts. Attacker can credential-stuff every agent account.

There is zero rate limiting on `signInWithPassword()`. An attacker can try thousands of passwords per minute with no lockout, delay, or CAPTCHA.

**Remediation:**
- Add server-side rate limiting (5 attempts per 15 minutes per email)
- Options: Upstash Ratelimit, Supabase Edge Functions rate limiting, or a lightweight API route that tracks attempts in DB
- Lock accounts after 10 failed attempts (require admin unlock)
- Add CAPTCHA after 3 failed attempts
- Log all failed login attempts to audit_log

---

### C4. Weak Password Policy

**File:** `app/(auth)/change-password/page.tsx` (line 21)
**Impact:** Agents protecting financial accounts with passwords like "12345678".

Only enforces 8-character minimum. No requirements for uppercase, lowercase, numbers, or special characters. For a financial app handling government IDs and commission advances, this is unacceptable.

**Remediation:**
```typescript
const hasUpper = /[A-Z]/.test(newPassword)
const hasLower = /[a-z]/.test(newPassword)
const hasNumber = /\d/.test(newPassword)
const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword)

if (newPassword.length < 12 || !hasUpper || !hasLower || !hasNumber || !hasSpecial) {
  setError('Password must be at least 12 characters with uppercase, lowercase, number, and special character.')
  return
}
```

---

### C5. Temporary Passwords Sent in Plaintext Email

**File:** `lib/email.ts` (sendAgentInviteNotification function)
**Impact:** Every agent invite email contains a plaintext password. Email is not encrypted in transit between mail servers. Resend (the email service) can see every password.

The current flow creates a Supabase auth user with a known temp password, then emails that password to the agent. Anyone who intercepts the email (including the email provider) has credentials.

**Remediation:**
- Switch to Supabase Auth magic links or invite links (passwordless first login)
- If temp passwords must exist: generate them randomly, set 4-hour expiry, and send via a separate secure channel (not the same email with the login URL)
- At minimum: force password change on first login (this part already works via `must_reset_password`)

---

### C6. KYC Upload API Trusts Client-Provided agentId

**File:** `app/api/kyc-mobile-upload/route.ts` (PUT handler, line ~78)
**Impact:** If an attacker obtains a valid KYC upload token, they can modify any agent's KYC records by changing the `agentId` in the request body.

The PUT endpoint accepts `agentId` from the client and validates it matches the token record. But the fix should be: derive agentId FROM the token on the server, never trust client input for this.

**Remediation:**
```typescript
// CURRENT (vulnerable):
const { token, filePaths, documentType, tokenRecordId, agentId } = await request.json()
// ...
if (tokenRecord.agent_id !== agentId) // Client could match this

// FIXED:
const { token, filePaths, documentType, tokenRecordId } = await request.json()
const agentId = tokenRecord.agent_id // Server-derived, not client-provided
```

---

## HIGH Findings

---

### H1. CSP Allows unsafe-inline and unsafe-eval

**File:** `next.config.ts` (lines 42-43)
**Impact:** XSS protection from CSP is largely negated.

`unsafe-inline` allows injected `<script>` tags to execute. `unsafe-eval` allows `eval()` and similar. Together, they mean a successful XSS attack has full JavaScript execution despite having CSP.

`unsafe-eval` is likely present because of a framework or library requirement. `unsafe-inline` is needed because the app uses inline styles extensively.

**Remediation:**
- Remove `unsafe-eval` — test if pdf.js or Next.js actually needs it. If pdf.js requires it, isolate pdf.js to a sandboxed iframe.
- For `unsafe-inline` on styles: this is harder to remove with Tailwind + inline styles, but document why it's needed.
- Add `object-src 'none'` to prevent plugin-based attacks.
- Add `upgrade-insecure-requests` to force HTTPS.

---

### H2. No CSRF Protection on State-Changing API Routes

**Files:** `app/api/clear-reset-flag/route.ts`, `app/api/kyc-mobile-upload/route.ts`
**Impact:** A malicious website could trigger actions on behalf of a logged-in user.

POST/PUT endpoints don't validate request origin or use CSRF tokens. If an admin visits a malicious site while logged in, that site could call these endpoints using the admin's session cookies.

**Remediation:**
- Validate `Origin` or `Referer` header matches `firmfunds.ca` on all state-changing endpoints
- Next.js server actions have built-in CSRF protection, but custom API routes do not
- Add origin check middleware for all `/api/*` routes

---

### H3. KYC Token Validation Returns Different Error Messages

**File:** `app/api/kyc-validate-token/route.ts`
**Impact:** An attacker can distinguish between non-existent, expired, and used tokens — enabling token enumeration.

**Remediation:** Return identical error message for all failure modes: `{ success: false, error: 'Invalid or expired link' }`

---

### H4. No Rate Limiting on Any API Route

**Files:** All API routes
**Impact:** Every public-facing endpoint can be hammered without consequence. KYC token brute-forcing, deal submission spam, report generation abuse.

**Remediation:**
- Implement rate limiting at the Netlify level (Netlify has built-in rate limiting for serverless functions)
- Or use Upstash Redis for per-IP/per-user rate limits
- Priority routes: login, KYC upload, KYC validate, deal submission

---

### H5. Missing Authorization Checks on Document Access

**File:** `lib/actions/deal-actions.ts` (getDocumentSignedUrl)
**Impact:** Any authenticated agent could potentially generate signed URLs for another agent's deal documents by guessing/knowing the deal ID.

The function checks that the caller has an allowed role (agent, admin, etc.) but doesn't verify the agent actually owns the deal whose documents they're accessing.

**Remediation:**
```typescript
if (profile.role === 'agent') {
  const { data: deal } = await supabase
    .from('deals')
    .select('agent_id')
    .eq('id', input.dealId)
    .single()
  if (deal?.agent_id !== profile.agent_id) {
    return { success: false, error: 'Access denied' }
  }
}
```

---

### H6. Admin Actions Missing Input Validation with Zod

**File:** `lib/actions/admin-actions.ts`
**Impact:** Brokerage/agent creation accepts loosely validated input. No email format validation, no phone format validation, no XSS prevention on text fields like `notes`, `brand`, `address`.

**Remediation:** Apply Zod schemas to all admin mutation inputs, similar to how `DealSubmissionSchema` validates deal submissions.

---

### H7. File Upload Content Not Verified (Magic Bytes)

**Files:** `lib/actions/kyc-actions.ts`, `lib/actions/deal-actions.ts`
**Impact:** MIME types can be spoofed. A malicious file renamed to `.pdf` with `Content-Type: application/pdf` would pass validation even if it contains executable code.

**Remediation:** Add server-side magic byte verification using the `file-type` npm package to confirm file content matches the declared type.

---

### H8. Audit Log Not Immutable

**File:** `lib/audit.ts`
**Impact:** If an attacker gains DB access (or an insider acts maliciously), audit logs can be modified or deleted, destroying the evidence trail. FINTRAC requires tamper-proof records.

**Remediation:**
- Set RLS on `audit_log` table: `INSERT` only for service role, `SELECT` for admins, no `UPDATE` or `DELETE` for anyone.
- Consider: Replicate audit events to an external immutable store (e.g., append-only S3 bucket with Object Lock).

---

## MEDIUM Findings

---

### M1. Password Changes Not Logged to Audit Trail

**File:** `app/(auth)/change-password/page.tsx`
**Impact:** No record of who changed their password and when. Makes it impossible to investigate account takeover.

**Remediation:** Add audit log entry in the `/api/clear-reset-flag` route (since it runs server-side after password change).

---

### M2. Session Timeout Is Client-Side Only

**File:** `components/SessionTimeout.tsx`
**Impact:** An attacker who steals a JWT can use it indefinitely — the timeout only runs in the browser. Server-side, the JWT is valid until its Supabase expiry (typically 1 hour).

**Remediation:**
- Track `last_active_at` in the database, check it in middleware
- Supabase JWT refresh already handles token expiry, but middleware should additionally check for inactivity

---

### M3. Password Reset Flow Has Race Condition

**File:** `app/(auth)/change-password/page.tsx` (lines 35-82)
**Impact:** The fire-and-forget `fetch('/api/clear-reset-flag').catch(() => {})` could fail silently. If it fails, the DB still thinks the user needs to reset, but the JWT metadata says they already did. This creates an inconsistent state.

**Remediation:** Don't fire-and-forget. Await the response and handle failure.

---

### M4. Referral Fee Report Has Weak Authorization

**File:** `app/api/reports/referral-fees/route.ts`
**Impact:** The report endpoint checks if the user is a `brokerage_admin` but doesn't verify they can only access their own brokerage's report data.

**Remediation:** After auth check, verify `profile.brokerage_id` matches the brokerage being queried.

---

### M5. Dependencies Not Pinned to Exact Versions

**File:** `package.json`
**Impact:** Caret ranges (`^`) allow automatic minor/patch updates that could introduce vulnerabilities or breaking changes.

**Remediation:** Pin exact versions for production. Use `npm audit` regularly. Consider enabling GitHub Dependabot.

---

### M6. KYC Document Storage Encryption Not Verified

**File:** Supabase Storage configuration (not in codebase)
**Impact:** Government IDs (driver's licenses, passports) may be stored unencrypted at rest. FINTRAC and PIPEDA require protection of PII.

**Remediation:**
- Verify in Supabase dashboard: Storage > Settings > Encryption at rest is enabled
- Supabase uses encrypted storage by default on paid plans, but VERIFY this
- Consider application-level encryption for KYC documents specifically (encrypt before upload, decrypt on view)

---

## LOW Findings

---

### L1. Referrer-Policy Could Be Stricter

**File:** `next.config.ts` (line 32)
Current: `strict-origin-when-cross-origin`. For a financial app, `no-referrer` is more appropriate to prevent any URL leakage.

### L2. X-XSS-Protection Header Is Obsolete

**File:** `next.config.ts` (line 28)
This header is deprecated in modern browsers. CSP replaces it. Remove to reduce noise.

### L3. ALLOWED_UPLOAD_EXTENSIONS Defined But Not Validated

**File:** `lib/constants.ts`
Extensions are defined but only MIME types are checked during upload. Add extension validation alongside MIME checks.

### L4. Admin Notes Stored in Plaintext

**File:** `types/database.ts`
Admin underwriting notes may contain sensitive reasoning. Stored unencrypted. Low priority since DB access should be restricted, but field-level encryption would be ideal for compliance.

---

## Backup & Disaster Recovery Recommendations

Bud asked: "What if something happens to Supabase?"

**What Supabase provides today:**
- Daily automated backups (on Pro plan)
- Point-in-time recovery up to 7 days (on Pro plan)
- Data stored in AWS data centers with encryption at rest

**What you should add:**

1. **Automated external backups** — Don't rely solely on Supabase. Set up a daily `pg_dump` to an external location (e.g., AWS S3 bucket in a different region, or Backblaze B2). This protects against Supabase outages, account suspension, or provider failure.

2. **Backup testing** — Once a month, restore a backup to a test environment to prove it actually works. Untested backups are not backups.

3. **KYC document backup** — Supabase Storage files should also be backed up externally. Use the Supabase API to sync files to a separate S3 bucket.

4. **Immutable backups** — Enable Object Lock on your backup S3 bucket so backups can't be deleted even if your AWS credentials are compromised.

5. **Documented recovery procedure** — Write a step-by-step runbook for "how to restore Firm Funds if Supabase goes down." Include: restore DB from backup, point DNS to new provider, verify data integrity.

6. **Multi-region consideration** — For handling millions daily, consider Supabase's regional replicas or a hot standby database in a different cloud provider.

---

## Prioritized Action Plan

### This Week (Before Handling Real Money)
1. Fix the seed route (C1) — 5 minutes, add production guard or delete
2. Fix cron auth bypass (C2) — 5 minutes, fix the conditional logic
3. Fix KYC agentId trust (C6) — 15 minutes, derive from token server-side
4. Strengthen password policy (C4) — 15 minutes, add complexity requirements
5. Fix token error messages (H3) — 5 minutes, return generic error

### This Month
6. Add login rate limiting (C3)
7. Add CSRF/origin validation to API routes (H2)
8. Add authorization check on document access (H5)
9. Add Zod validation to admin actions (H6)
10. Make audit log immutable via RLS (H8)
11. Switch to magic links for agent invites (C5)
12. Set up external database backups

### This Quarter
13. Remove unsafe-eval from CSP (H1)
14. Add file content verification (H7)
15. Add rate limiting to all API routes (H4)
16. Server-side session timeout enforcement (M2)
17. Verify KYC storage encryption (M6)
18. Pin dependency versions (M5)
19. Conduct professional penetration test
