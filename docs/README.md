# Firm Funds Documentation

_Last updated: 2026-06-10_

The canonical reference for how Firm Funds works. Read these docs before digging into source code, and update them whenever you change behavior. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the doc-to-code mapping.

Firm Funds is a real estate commission advance platform. For a one-page overview and quick start, see the root [README](../README.md).

## Architecture

| Doc | What it covers |
|-----|----------------|
| [Overview](architecture/overview.md) | System overview, tech stack, roles, and end-to-end data flow |
| [Authentication](architecture/authentication.md) | Supabase Auth, magic links, roles, middleware gating, RLS, KYC |
| [Database](architecture/database.md) | Schema, tables, enums, RPCs, RLS, and full migration history |
| [Directory structure](architecture/directory-structure.md) | Annotated tree of the repository |

## Business logic

| Doc | What it covers |
|-----|----------------|
| [Financial model](business/financial-model.md) | Fee and discount math, late interest, brokerage splits, worked examples |
| [Deal lifecycle](business/deal-lifecycle.md) | Deal status state machine, underwriting, settlement, remediation and cure |
| [Firm deals](business/firm-deals.md) | ParcLabs detection pipeline, agent matching, co-agent splits, offer flow |
| [Agent roster import](business/agent-roster-import.md) | Bulk agent import from .csv/.xlsx rosters, parsing pipeline, guards |

## API reference

| Doc | What it covers |
|-----|----------------|
| [REST endpoints](api/rest-endpoints.md) | Every `/api` route: method, auth, purpose, and parameters |
| [Cron jobs](api/cron-jobs.md) | The `/api/cron/*` scheduled endpoints and their schedules |
| [Webhooks](api/webhooks.md) | Inbound DocuSign and ParcLabs webhooks and their verification |

## Integrations

| Doc | What it covers |
|-----|----------------|
| [DocuSign](integrations/docusign.md) | Contract generation, signing flow, Connect webhook, env vars (default provider) |
| [SignWell](integrations/signwell.md) | Pilot DocuSign replacement: text-tag fields, per-page initials, webhook, `ESIGN_PROVIDER` flag |
| [Email (Resend)](integrations/email.md) | Transactional email templates and the email log |
| [ParcLabs](integrations/parcllabs.md) | Property data API, event ingestion, and firm-deal feed |

## Development

| Doc | What it covers |
|-----|----------------|
| [Setup](development/setup.md) | Local environment, dependencies, and environment variables |
| [Deployment](development/deployment.md) | Netlify build, serverless constraints, and cron scheduling |
| [Conventions](development/conventions.md) | Coding standards, Next.js 16 changes, and known gotchas |

## Related material

The `docs/` directory also contains strategic research that is not part of the system reference:

- `multi-province-expansion-research.md`
- `multi-province-readiness-playbook.md`
