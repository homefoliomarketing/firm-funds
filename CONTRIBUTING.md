# Contributing to Firm Funds

_Last updated: 2026-06-09_

This guide covers how to work in the repository and, most importantly, how to keep the documentation current.

## Documentation-first principle

The `docs/` directory is the canonical description of how Firm Funds works. When you need to understand a part of the system, read the relevant doc before digging through source code. This preserves context and keeps everyone (humans and AI agents) working from the same mental model.

The flip side of that principle: **documentation is only useful if it is current.** Every change that alters behavior must update the matching doc in the same commit. Treat a stale doc as a bug in the change that made it stale.

## When you change X, update Y

| If you change... | Update this doc |
|------------------|-----------------|
| A database migration, table, column, enum, or RPC (`supabase/migrations/`) | [docs/architecture/database.md](docs/architecture/database.md) |
| An API route (`app/api/**/route.ts`) | [docs/api/rest-endpoints.md](docs/api/rest-endpoints.md) |
| A cron endpoint (`app/api/cron/**`) | [docs/api/cron-jobs.md](docs/api/cron-jobs.md) |
| A webhook (`app/api/docusign/webhook/route.ts`) | [docs/api/webhooks.md](docs/api/webhooks.md) |
| Financial math (`lib/calculations.ts`, `lib/constants.ts`) | [docs/business/financial-model.md](docs/business/financial-model.md) |
| Deal status flow, underwriting, settlement, remediation | [docs/business/deal-lifecycle.md](docs/business/deal-lifecycle.md) |
| Firm-deal detection, matching, offer flow (`lib/firm-deal-detection/`) | [docs/business/firm-deals.md](docs/business/firm-deals.md) |
| Agent roster import (`lib/roster-import.ts`, `bulkImportAgentsRoster`) | [docs/business/agent-roster-import.md](docs/business/agent-roster-import.md) |
| DocuSign integration (`lib/docusign.ts`) | [docs/integrations/docusign.md](docs/integrations/docusign.md) |
| Email templates or Resend logic (`lib/email.ts`) | [docs/integrations/email.md](docs/integrations/email.md) |
| Firm-deal data source (Google Sheets, no ParcLabs: `lib/firm-deal-detection/sheets-client.ts`) | [docs/integrations/parcllabs.md](docs/integrations/parcllabs.md) |
| Auth, middleware, roles, Supabase clients | [docs/architecture/authentication.md](docs/architecture/authentication.md) |
| Directory structure, new top-level areas | [docs/architecture/directory-structure.md](docs/architecture/directory-structure.md) |
| A new environment variable | [docs/development/setup.md](docs/development/setup.md) |
| Build or deploy config (`next.config.ts`, `netlify.toml`) | [docs/development/deployment.md](docs/development/deployment.md) |
| A coding convention or a newly discovered gotcha | [docs/development/conventions.md](docs/development/conventions.md) |

When you add a whole new feature area, add a new doc and link it from [docs/README.md](docs/README.md).

Every doc carries a `_Last updated: YYYY-MM-DD_` line near the top. Refresh it when you edit the doc.

## Code conventions

Read [docs/development/conventions.md](docs/development/conventions.md) before writing code. Highlights:

- Next.js 16: `params` are Promises, `'use server'` files export only async functions.
- Use `createServiceRoleClient()` for server-side mutations; balance writes go through RPCs.
- Add external POST routes to `PUBLIC_PATHS` in `proxy.ts` (the Next.js 16 request middleware, function `proxy`).
- Always `await` async work in serverless functions.
- No em dashes in copy or docs. No emojis unless requested.

## Git workflow

- Work on `main` and push directly. There is no pull request process.
- Confirm with the owner before pushing.
- Match the commit message style in `git log` (for example `feat(help): ...`, `fix(cron): ...`, `docs(api): ...`).
- Do not commit secrets. `.env.local` and credentials stay out of source control.

## Before you push

1. `npx tsc --noEmit` passes.
2. `npm run build` succeeds (Netlify checks are stricter than local).
3. UI changes verified in a browser.
4. Docs updated per the table above.
5. New external POST routes added to `PUBLIC_PATHS`; new crons scheduled in cron-job.org; new env vars added in Netlify.
