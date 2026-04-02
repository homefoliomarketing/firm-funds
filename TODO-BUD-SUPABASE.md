# Supabase Tasks for Bud

These are things you need to do manually in the Supabase dashboard.
Do them IN ORDER — each step builds on the previous one.

---

## 1. Run the Audit Log Migration

Go to: **Supabase Dashboard > SQL Editor**

Open and run the contents of:
`supabase/migrations/003_audit_log.sql`

This creates the `audit_log` table that tracks all deal status changes,
document uploads/deletes, and deal submissions.

---

## 2. Run the RLS Hardening Migration

Go to: **Supabase Dashboard > SQL Editor**

Open and run the contents of:
`supabase/migrations/004_rls_hardening.sql`

This tightens Row Level Security so:
- Agents can ONLY see their own deals, documents, and brokerage info
- Admins can see everything
- Brokerage admins can only see their brokerage's deals/agents
- Nobody can modify audit logs

---

## 3. Enable MFA (Multi-Factor Authentication)

Go to: **Supabase Dashboard > Authentication > Settings > Multi-Factor Authentication**

- Toggle ON "Enable Multi-Factor Authentication"
- Set it to "TOTP" (time-based one-time password — works with Google Authenticator, Authy, etc.)
- Consider making MFA REQUIRED for admin accounts

---

## 4. Rate Limiting (Already Built-In)

Supabase has built-in rate limiting on their Auth endpoints (login, signup, etc.).
The defaults are usually fine, but you can check:

Go to: **Supabase Dashboard > Authentication > Rate Limits**

Recommended settings:
- Rate limit for email sign-in: 30 per hour (default is fine)
- Rate limit for token refresh: 360 per hour (default is fine)

For API-level rate limiting on your edge functions, you'd need a Supabase Pro plan
or implement it at the Netlify level (Netlify has built-in DDoS protection).

---

## 5. Check SSL Certificate (REMINDER)

If you haven't already, go to:
**Netlify Dashboard > Domain Management > HTTPS**

Make sure the SSL certificate for firmfunds.ca is active and auto-renewing.

---

## 6. Delete the Stale /src Directory

On your computer, manually delete the `/src` folder from the project root.
It's a leftover from an older project structure and contains duplicate files.

In PowerShell:
```
cd "C:\Users\randi\OneDrive\Desktop\Claude Folder\firm-funds"
Remove-Item -Recurse -Force src
```
