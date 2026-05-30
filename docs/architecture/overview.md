# Firm Funds System Overview

_Last updated: 2026-05-29_

This document describes what Firm Funds does, who uses it, the technology it runs on, and how a commission advance moves through the system from submission to completion.

## What Firm Funds does

Firm Funds is a real estate commission advance platform. When a real estate agent has a sale that is firm (the deal has gone unconditional) but has not yet closed, the agent is owed a commission that will not be paid until closing day. Firm Funds advances that commission early, minus a discount fee, so the agent gets their money sooner. Firm Funds collects the full commission from the brokerage at closing.

The platform handles the full lifecycle: intake of an advance request, underwriting against a fixed checklist, approval, electronic signing of the commission purchase agreement, funding by electronic transfer, and settlement after the deal closes. It also handles the unhappy path when a deal fails to close, including a mandatory cure election and a remediation balance that accrues interest.

## The three user roles

The role enum lives in `types/database.ts` as `UserRole`. There are four database role values but three logical user types, because the two admin roles share the same dashboard and permissions.

| Logical role | `UserRole` value(s) | Dashboard prefix | What they do |
| --- | --- | --- | --- |
| Admin (Firm Funds staff) | `super_admin`, `firm_funds_admin` | `/admin` | Underwrite and approve deals, fund advances, manage brokerages and agents, run reports, handle failed deals and remediation. |
| Agent | `agent` | `/agent` | Submit advance requests, sign contracts, track deal status, view their ledger balance, complete KYC. |
| Brokerage admin | `brokerage_admin` | `/brokerage` | Submit advance requests on behalf of their agents, manage agents and other brokerage admins, record brokerage payments, accept firm-deal offers. |

How the roles interact:

- An **agent** belongs to one **brokerage**. The agent submits an advance request, or a **brokerage admin** submits it on the agent's behalf (the common case in practice).
- A **Firm Funds admin** underwrites the request, approves or declines it, and funds approved deals.
- The **brokerage** is the counterparty that owes the commission and repays Firm Funds at closing. Brokerages also earn a referral fee.

Role determination and the per-role access rules are documented in [authentication.md](./authentication.md).

## Tech stack

Versions are taken from `package.json`.

| Area | Technology | Version | Notes |
| --- | --- | --- | --- |
| Framework | Next.js (App Router) + Turbopack | 16.2.6 | App Router with route groups, server components, server actions. In Next.js 16 the request middleware file is named `proxy.ts` (function `proxy`), not `middleware.ts`. |
| UI runtime | React / React DOM | 19.2.4 | Server components by default. |
| Database, auth, storage | Supabase (`@supabase/supabase-js`, `@supabase/ssr`) | 2.101.1 / 0.10.0 | Postgres with Row Level Security, Supabase Auth, Supabase Storage. |
| Styling | Tailwind CSS | 4.2.2 | Via `@tailwindcss/postcss`. Theme is dark-mode locked. |
| UI primitives | Base UI (`@base-ui/react`) | 1.3.0 | Local `components/ui/*` wrappers built on it. |
| Command palette | `cmdk` | 1.1.1 | Powers help and search palettes. |
| Email | Resend | 6.12.4 | All transactional email, with CASL footer and unsubscribe headers (`lib/email.ts`). |
| Electronic signatures | DocuSign (custom REST integration) | n/a | Implemented directly in `lib/docusign.ts` using `pg` and DocuSign's REST API. There is no `docusign-esign` dependency. |
| Firm-deal detection | Google Sheets (`googleapis`) + Twilio (`twilio`) | 172.0.0 / 6.0.2 | Polls brokerage-shared Google Sheets for newly-firm deals, then notifies by email and SMS (`lib/firm-deal-detection/`). |
| Documents | `pdf-lib`, `docx` | 1.17.1 / 9.6.1 | Contract and statement generation. |
| Rate limiting | Upstash Redis + Ratelimit | 1.37.0 / 2.0.8 | Protects sensitive endpoints. |
| Validation | Zod | 4.3.6 | Server action and API input validation. |
| Hosting | Netlify | n/a | Auto-deploys from `main`. Serverless functions. |

> Note: the firm-deal detection pipeline reads from Google Sheets, not from a third-party data vendor. If you see references to an external deal-data provider elsewhere, treat this document and the code in `lib/firm-deal-detection/` as the source of truth.

## High-level architecture

```
Browser (agent / brokerage admin / Firm Funds admin)
  |
  v
Next.js App Router (Netlify)
  |-- proxy.ts                  CSRF + auth gating + role routing + CSP
  |-- app/(auth)/*              login, change-password
  |-- app/(dashboard)/*         role-segmented dashboards (admin / agent / brokerage / help)
  |-- app/api/*                 route handlers (cron, docusign, kyc, magic-link, etc.)
  |-- lib/actions/*             server actions ('use server')
  |
  v
Supabase
  |-- Postgres + RLS            primary data store and security boundary
  |-- Auth                      sessions, magic links, password reset
  |-- Storage                   KYC documents, signed contracts, attachments
  |
External integrations
  |-- DocuSign                  contract signing (lib/docusign.ts)
  |-- Resend                    transactional email (lib/email.ts)
  |-- Google Sheets + Twilio    firm-deal detection and notification
  |-- Upstash Redis             rate limiting

Cron jobs (hosted on cron-job.org) hit /api/cron/* on a schedule.
```

Key structural points:

- **Route groups.** `app/(auth)/` holds unauthenticated pages, `app/(dashboard)/` holds authenticated role dashboards. Parentheses mean the group name is not part of the URL. See [directory-structure.md](./directory-structure.md).
- **Server components and server actions.** Pages resolve auth and load data server-side. Mutations run through `'use server'` files in `lib/actions/`, which use the service-role Supabase client for writes.
- **Cron jobs.** Scheduled work (closing-date alerts, monthly statements, firm-deal polling and dispatch, remediation escalation, email retry) is exposed as `app/api/cron/*` route handlers and triggered externally by cron-job.org. These endpoints are exempt from CSRF and authenticated by a bearer `CRON_SECRET` in the handler.

## Request and data flow: a commission advance

The happy path for a single advance, from submission to completion:

1. **Submission.** An agent (or a brokerage admin on the agent's behalf) fills out the new-deal form (`app/(dashboard)/agent/new-deal/` or `app/(dashboard)/brokerage/deals/new/`). A server action validates the input with Zod and inserts a `deals` row with status `under_review`. The settlement window (7 days standard) is snapshotted onto the deal at submission.
2. **Underwriting.** A Firm Funds admin opens the deal (`app/(dashboard)/admin/deals/[id]/`) and works the fixed 12-item underwriting checklist (three categories). KYC documents and the agreement of purchase and sale are reviewed here.
3. **Approval.** When the checklist passes, the admin approves the deal. Status moves `under_review -> approved`. The discount fee is computed in `lib/calculations.ts` at $0.80 per $1,000 per day over the chargeable days (days until closing minus one, since closing day is not charged).
4. **Contract.** A DocuSign envelope is created for the commission purchase agreement (`lib/docusign.ts`). The agent signs electronically. DocuSign calls back to `app/api/docusign/webhook/` (HMAC-verified) to record completion.
5. **Funding.** Once the contract is signed, the admin funds the advance by electronic transfer. Status moves `approved -> funded`. The agent's ledger balance is updated through the `apply_agent_balance_delta` RPC (never by read-modify-write).
6. **Completion.** After the deal closes and the brokerage remits the commission within the settlement window, the deal is settled. Status moves `funded -> completed`.

The failure path: if a funded deal does not close, status moves `funded -> failed_to_close`. The agent must complete a mandatory cure election. A Remediation IDP balance is created and accrues late interest at 24% per annum true APR (compounded daily, with a 30-day grace from closing). Once the remediation balance is fully paid, the deal moves to `cured`. The financial rules behind all of this are specified in `CLAUDE.md` and implemented in `lib/calculations.ts`.

## Cross-cutting concerns

- **Row Level Security (RLS).** RLS in Postgres is the primary security boundary, not application code. Server-side mutations use the service-role client (`createServiceRoleClient` in `lib/supabase/server.ts`), which bypasses RLS, and must therefore verify the caller themselves before writing. Details in [authentication.md](./authentication.md).
- **Middleware auth gating.** `proxy.ts` runs on every matched request. It enforces CSRF on state-changing API calls, validates the Supabase session, gates routes by role, and redirects unauthenticated users to `/login`. External POST endpoints (webhooks, callbacks, one-click unsubscribe) must be added to the `PUBLIC_PATHS` allowlist (and, for non-browser callers, to the CSRF exemption list) or they will be blocked.
- **Dark-mode-locked theme.** The app is permanently dark mode. Use the `useTheme()` hook. Note that `colors.gold` is green (`#5FA873`).
- **No em dashes in user-facing copy.** A project style rule. Use commas, colons, or parentheses instead.
