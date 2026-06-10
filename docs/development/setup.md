# Local Development Setup

_Last updated: 2026-06-09_

This guide gets a developer from a fresh clone to a running local instance of Firm Funds.

## Prerequisites

- Node.js 20 or newer.
- npm (ships with Node).
- Access to the Supabase project (URL, anon key, service role key, and database connection string).
- Credentials for DocuSign, Resend, Twilio, and the Google Sheets service account if you need those features locally.

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
| `npm run typecheck` | Type check (`tsc --noEmit`) |
| `npm test` | Run the Vitest unit tests once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run check` | Typecheck then lint |
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
| `DOCUSIGN_INTEGRATION_KEY` | Integration key (client id) |
| `DOCUSIGN_SECRET_KEY` | OAuth secret key for the auth-code grant |
| `DOCUSIGN_ACCOUNT_ID` | DocuSign account id |
| `DOCUSIGN_AUTH_URL` | OAuth base URL (account-d.docusign.com for demo, account.docusign.com for production) |
| `DOCUSIGN_BASE_URL` | REST API base URL (production vs demo) |
| `DOCUSIGN_REDIRECT_URI` | OAuth callback URL registered with DocuSign |
| `DOCUSIGN_HMAC_SECRET` | HMAC key to verify inbound Connect webhooks |
| `DOCUSIGN_HMAC_DEV_BYPASS` | Set to `true` only in local dev to skip webhook HMAC verification |

### Resend (email)

| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Resend API key for transactional email |

### Firm-deal detection (Google Sheets + Anthropic)

There is no ParcLabs integration in the codebase. Proactive deal detection polls each partner brokerage's deal-tracking Google Sheet and parses new rows with Claude. See [docs/integrations/parcllabs.md](../integrations/parcllabs.md) for the full picture.

| Variable | Purpose |
|----------|---------|
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` | Read-only service-account credentials JSON (stored as a JSON string) for the Sheets client |
| `ANTHROPIC_API_KEY` | Used by the row parser to call Claude when reading new sheet rows |
| `FIRM_DEAL_FROM_ADDRESS` | From address for firm-deal notification emails |
| `FIRM_FUNDS_OFFER_INBOX` | Inbox that receives brokerage offer and escalation emails (default `bud@firmfunds.ca`) |

### Twilio (firm-deal SMS notifications)

| Variable | Purpose |
|----------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_API_KEY_SID` | Twilio API key SID |
| `TWILIO_API_KEY_SECRET` | Twilio API key secret |
| `TWILIO_PHONE_NUMBER` | Twilio sender phone number (E.164) |

### Upstash Redis (rate limiting)

| Variable | Purpose |
|----------|---------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |

### Google Maps (address autocomplete)

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Maps (Places) JS API key for the `AddressAutocomplete` field. Used for deal property addresses and now also in the agent "My Info"/profile and onboarding forms (the component takes an optional `label`, defaulting to "Property address" and shown as "Home address" for agents) |

### Cron

| Variable | Purpose |
|----------|---------|
| `CRON_SECRET` | Shared secret required by every `/api/cron/*` endpoint. The external scheduler must send it |
| `CRON_BACKFILL_SECRET` | Separate secret for the monthly-broker-statements backfill path |

### Seed (local/dev only)

| Variable | Purpose |
|----------|---------|
| `SEED_SECRET` | Guards the `/api/seed` route. Leave unset in production |

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
