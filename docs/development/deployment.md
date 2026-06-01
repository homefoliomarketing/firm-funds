# Deployment

_Last updated: 2026-05-29_

How Firm Funds ships to production and how the scheduled jobs run.

## Hosting

The app is hosted on Netlify and serves [firmfunds.ca](https://firmfunds.ca). Netlify auto-deploys on every push to the `main` branch. There is no separate staging environment; `main` is production.

## Build configuration

The build is defined in `netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = ".next"

[build.environment]
  NODE_OPTIONS = "--max-old-space-size=4096"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

Notes:

- `NODE_OPTIONS=--max-old-space-size=4096` raises the Node heap to avoid out-of-memory failures during the Next.js build. Do not remove it.
- The `@netlify/plugin-nextjs` plugin maps Next.js App Router routes and API routes onto Netlify serverless functions.

## Serverless function constraints

API routes run as Netlify serverless functions. Two rules matter:

1. **Always `await` asynchronous work.** If a function returns before its async operations finish, Netlify kills the process and the work is silently lost. This is the most common production-only bug class here.
2. **File uploads must use signed URLs.** Do not stream large uploads through the function body.

Netlify TypeScript checking is stricter than a local `tsc --noEmit`. Be careful with null checks and unused imports, since they can pass locally and fail the deploy.

## Environment variables

Production environment variables are configured in the Netlify dashboard, not in the repo. They mirror the list in [docs/development/setup.md](setup.md): Supabase, DocuSign, Resend, ParcLabs, `CRON_SECRET`, and `NEXT_PUBLIC_SITE_URL`.

## Scheduled jobs (cron)

There is no built-in scheduler. Cron jobs are external HTTP calls made by cron-job.org (account `bud@firmfunds.ca`) to the `/api/cron/*` endpoints. Each call must include the `CRON_SECRET`. See [docs/api/cron-jobs.md](../api/cron-jobs.md) for the full list of endpoints and their schedules.

When you add a new cron endpoint, you must also add the schedule in the cron-job.org dashboard. Deploying the code alone does not start the job.

## Middleware and public routes

Any new API route that accepts an external POST (a webhook or callback) must be added to the `PUBLIC_PATHS` allowlist in `proxy.ts` (the Next.js 16 request middleware at the repo root, function `proxy`), or the middleware will redirect it (302) to `/login`. See [docs/architecture/authentication.md](../architecture/authentication.md).

## Deploy checklist

Before pushing to `main`:

1. `npx tsc --noEmit` passes (watch for null and unused-import errors that Netlify will catch).
2. `npm run build` succeeds locally.
3. UI changes verified in a browser.
4. Any new external POST route added to `PUBLIC_PATHS`.
5. Any new cron endpoint scheduled in cron-job.org.
6. New environment variables added in the Netlify dashboard.
7. Docs updated to match the change (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).
