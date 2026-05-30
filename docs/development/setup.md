# Local Development Setup

_Last updated: 2026-05-29_

This guide gets a developer from a fresh clone to a running local instance of Firm Funds.

## Prerequisites

- Node.js 20 or newer.
- npm (ships with Node).
- Access to the Supabase project (URL, anon key, service role key, and database connection string).
- Credentials for DocuSign, Resend, and ParcLabs if you need those features locally.

The owner develops on Windows using PowerShell from `C:\Users\randi\Dev\firm-funds`. Commands below work in PowerShell and in a POSIX shell unless noted.

## Install and run

```bash
npm install
npm run dev
```

The dev server runs on http://localhost:3000 using Turbopack.

Other scripts:

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start the local dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Run eslint |
| `npx tsc --noEmit` | Type check (exclude `.next/` errors) |

## Environment variables

Create `.env.local` in the repo root. The application reads the following variables. Never commit this file.

### Supabase

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (client and server) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key for browser client |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for server-side mutations that bypass RLS. Server only, never expose to the browser |
| `SUPABASE_DB_URL` | Direct Postgres connection string, used by `npx supabase db query` for migrations and ad hoc SQL |
| `NEXT_PUBLIC_SITE_URL` | Canonical site URL, used for magic link and callback redirects |

> Connection note: `SUPABASE_DB_URL` uses the session pooler host `aws-1-ca-central-1.pooler.supabase.com:5432` with username `postgres.<project-ref>`. The direct `db.*` hostname no longer resolves without the IPv4 add-on.

### DocuSign

| Variable | Purpose |
|----------|---------|
| `DOCUSIGN_CLIENT_ID` | Integration key (client id) |
| `DOCUSIGN_ACCOUNT_ID` | DocuSign account id |
| `DOCUSIGN_IMPERSONATED_USER_ID` | User id for JWT impersonation |
| `DOCUSIGN_PRIVATE_KEY` | RSA private key for JWT grant |
| `DOCUSIGN_BASE_PATH` | API base path (production vs demo) |
| `DOCUSIGN_WEBHOOK_HMAC_KEY` | HMAC key to verify inbound Connect webhooks |

### Resend (email)

| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Resend API key |
| `RESEND_FROM_EMAIL` | From address for transactional email |

### ParcLabs (firm-deal detection)

| Variable | Purpose |
|----------|---------|
| `PARCLLABS_API_KEY` | ParcLabs API key for polling property events |
| `PARCLLABS_WEBHOOK_SECRET` | Shared secret to verify inbound ParcLabs webhooks |

### Cron

| Variable | Purpose |
|----------|---------|
| `CRON_SECRET` | Shared secret required by every `/api/cron/*` endpoint. The external scheduler must send it |

## Running database migrations and SQL

Migrations live in `supabase/migrations/` as numbered SQL files. Run SQL against the database with:

```bash
npx supabase db query --db-url "$(grep SUPABASE_DB_URL .env.local | cut -d= -f2-)" "YOUR SQL HERE"
```

See [docs/architecture/database.md](../architecture/database.md) for the schema and the migration history.

## Test accounts

Test login credentials for admin, brokerage, and agent roles are kept out of the repository. They are stored in the project memory system, not in source control. Ask the owner if you need them.

## Verifying changes

For any UI change, run the dev server and verify in a browser before considering the work done. Type checking and tests confirm code correctness, not feature correctness.
