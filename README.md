# Firm Funds

Real estate commission advance platform. Firm Funds buys a real estate agent's pending commission at a discount and advances the cash before closing, then collects the full commission from the brokerage at settlement.

**Live:** [firmfunds.ca](https://firmfunds.ca) (Netlify, auto-deploys from `main`)

## What it does

- Agents (or brokerage admins on their behalf) request an advance against a firm deal.
- Firm Funds underwrites the deal against a 12-item checklist, then funds it by EFT.
- The discount fee is $0.80 per $1,000 per day until closing. At settlement the brokerage remits the full commission.
- Failed-to-close deals run through a remediation and cure flow with 24%/yr late interest after a 30-day grace.
- Firm deals are detected automatically from brokerage-shared spreadsheets and matched to agents, who receive an offer by email and SMS magic link.

## Tech stack

- **Next.js 16.2.1** (App Router, Turbopack) on **Netlify** serverless functions
- **Supabase** PostgreSQL with Row Level Security as the primary security boundary
- **DocuSign** for contract signing, **Resend** for transactional email, **Twilio** for SMS
- Dark-mode-only UI

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
npx tsc --noEmit     # type-check before pushing
npm run build        # Netlify checks are stricter than local
```

Environment variables and local setup are documented in [docs/development/setup.md](docs/development/setup.md).

## Documentation

Full documentation lives in [`docs/`](docs/README.md). Read the relevant doc before digging through source code.

- [Architecture](docs/architecture/overview.md): system overview, auth, database, directory structure
- [Business logic](docs/business/financial-model.md): financial model, deal lifecycle, firm deals
- [API reference](docs/api/rest-endpoints.md): REST endpoints, cron jobs, webhooks
- [Integrations](docs/integrations/docusign.md): DocuSign, Resend email, ParcLabs
- [Development](docs/development/setup.md): setup, deployment, conventions

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The core rule: any change that alters behavior must update the matching doc in the same commit. A stale doc is a bug in the change that made it stale.

## Git workflow

Work on `main` and push directly; there is no pull request process. Confirm with the owner before pushing. Do not commit secrets (`.env.local` and credentials stay out of source control).
