# Directory Structure

_Last updated: 2026-06-09_

This document is an annotated map of the important directories in the Firm Funds repository, so you can find where any given piece of behavior lives.

## Top-level layout

```
firm-funds/
  proxy.ts                 Request middleware (Next.js 16 names this proxy.ts, function "proxy")
  app/                     Next.js App Router: pages, layouts, route handlers
  components/              Shared React components (UI primitives, feature components)
  lib/                     Business logic, server actions, integrations, helpers
  types/                   Shared TypeScript types (database.ts holds the domain types)
  supabase/migrations/     Ordered SQL migrations (schema, RLS, RPCs, triggers)
  migrations/              Separate hand-applied SQL set (audit_log hardening, invite_tokens, session heartbeat); run manually in the Supabase SQL Editor, numbered independently of supabase/migrations/
  scripts/                 One-off and operational scripts (seeding, verification, checks)
  docs/                    Project documentation (this folder lives here)
  public/                  Static assets and generated mockups
  marketing/               Pitch deck and marketing assets
```

`proxy.ts` is the request middleware. In Next.js 16 this file replaces the older `middleware.ts`, and its exported function is `proxy`. It handles CSRF, session validation, the `PUBLIC_PATHS` allowlist, role gating, and the Content Security Policy. See [authentication.md](./authentication.md).

## app/

The App Router tree. Route groups in parentheses organize files without adding URL segments.

```
app/
  page.tsx                       Root landing page
  (auth)/                        Unauthenticated pages (group not in URL)
    login/                       /login
    change-password/             /change-password (forced reset after invite)
  (dashboard)/                   Authenticated, role-segmented dashboards
    layout.tsx                   Resolves auth server-side, mounts session timeout
    admin/                       /admin  (Firm Funds staff: super_admin, firm_funds_admin)
    agent/                       /agent  (agents)
    brokerage/                   /brokerage  (brokerage_admin)
    help/                        /help  (role-aware Help Center, shared by all roles)
  agent/
    firm-deal/[token]/           Public magic-link firm-deal offer page (NOT in (dashboard); token-authed, in PUBLIC_PATHS)
  auth/
    email-confirmed/route.ts     Email-change confirmation callback
  invite/[token]/                Invite redemption landing page
  kyc-upload/[token]/            Token-authenticated KYC upload page
  unsubscribe/                   CASL unsubscribe landing page
  api/                           Route handlers (see below)
```

### Route groups

| Group | URL prefix | Purpose |
| --- | --- | --- |
| `(auth)` | none | Pre-login pages: `login`, `change-password`. |
| `(dashboard)` | none | All authenticated dashboards, gated by role in `proxy.ts`. |

### Role-segmented dashboard structure

Under `app/(dashboard)/`:

| Segment | Route prefix | Allowed roles | Highlights |
| --- | --- | --- | --- |
| `admin/` | `/admin` | `super_admin`, `firm_funds_admin` | Deal review (`deals/[id]`), agent profile with ledger (`agents/[id]`, read-only, linked from the agent name on a deal), portfolio, payments, brokerages and their firm-deal pipes, assignments, balance adjustment, firm-deal review, pending elections, reports, audit, settings. |
| `agent/` | `/agent` | `agent` | New deal, deal detail (`deals/[id]`), failed deals, cure election, account and ledger, profile, settings, setup, messages. |
| `brokerage/` | `/brokerage` | `brokerage_admin` | Submit deal on behalf of agents (`deals/new`), agents, brokerage admins, amendments, failed deals, settings. |
| `help/` | `/help` | all authenticated | Role-aware Help Center: sidebar IA, FAQ, dynamic `[role]/[slug]` articles, live fee worksheet. |

### app/api/

Route handlers grouped by concern. Several are reachable without a session and appear in `PUBLIC_PATHS` (see [authentication.md](./authentication.md)).

```
app/api/
  magic-link/route.ts                  Invite token validate (POST) and password set (PUT)
  kyc-validate-token/route.ts          Validate a KYC upload token
  kyc-mobile-upload/route.ts           KYC document upload (mobile)
  kyc-desktop-upload/route.ts          KYC document upload (desktop)
  preauth-upload/route.ts              Signed-URL upload helper
  docusign/
    connect/route.ts                   DocuSign account connect
    callback/route.ts                  DocuSign OAuth callback
    webhook/route.ts                   DocuSign Connect webhook (HMAC verified)
  brokerage/confirm-contact-email/     Token-confirm a brokerage contact email
  unsubscribe/route.ts                 RFC 8058 one-click unsubscribe
  rate-limit/route.ts                  Rate-limit pre-check for change-password
  clear-reset-flag/route.ts            Clears must_reset_password
  session-heartbeat/route.ts           Keeps session alive during password reset
  reports/referral-fees/route.ts       Referral-fee report export
  audit/export/route.ts                Audit log export
  admin/test-settlement-reminder/      Admin test utility
  seed/route.ts                        Seed endpoint
  cron/                                Scheduled jobs (triggered by cron-job.org)
    firm-deal-poller/route.ts          Poll brokerage Google Sheets for firm deals
    firm-deal-processor/route.ts       Process detected firm-deal events
    firm-deal-dispatcher/route.ts      Dispatch firm-deal notifications
    firm-deal-offer-nudges/route.ts    Nudge / escalate unanswered offers
    closing-date-alerts/route.ts       Closing-date reminders
    monthly-broker-statements/route.ts Monthly brokerage statements
    remediation-overdue-escalation/    Escalate overdue remediation balances
    retry-failed-emails/route.ts       Retry failed email sends
    webhook-dedup-cleanup/route.ts     Clean up DocuSign webhook dedup rows
```

Cron handlers are CSRF-exempt (prefix `/api/cron/`) and authenticated by a bearer `CRON_SECRET` in the handler.

## components/

Shared React components.

```
components/
  ui/                  Base UI primitives (button, dialog, table, select, etc.)
  help/                Help Center shell, sidebar, FAQ, search palette, fee worksheet
  messaging/           In-app messaging (thread, bubble, input, attachments)
  admin/               Admin feature components (assignments, balance adjustment, etc.)
  brokerage/           Brokerage feature components (offers banner, record payment, etc.)
  remediation/         Remediation (failed-deal) components
  AgentHeader.tsx, SessionTimeout.tsx, AuditTimeline.tsx, ...  Cross-cutting components
```

`components/ui/` holds the local design-system wrappers built on Base UI. Feature folders (`admin/`, `brokerage/`, `help/`, `messaging/`, `remediation/`) group components by the area they serve.

## lib/

Business logic, server actions, and integrations. This is where the rules live.

```
lib/
  calculations.ts          Financial math: discount fee, chargeable days, late interest (CAD, integer cents)
  constants.ts             Rates, limits, settlement windows (single source for tunable numbers)
  validations.ts           Zod schemas for inputs
  access.ts                Role and status predicates (admin roles, agent/brokerage status)
  auth-helpers.ts          getAuthenticatedUser / getAuthenticatedAdmin (auth + status gate)
  csrf.ts                  Origin allowlist for CSRF
  rate-limit.ts            Upstash-backed rate limiting
  audit.ts, audit-labels.ts  Audit logging
  email.ts                 Resend wrapper with CASL footer and unsubscribe headers
  email-reconcile.ts       Mirror auth.users.email into user_profiles
  docusign.ts              DocuSign REST integration (envelopes, signing) via pg
  contract-docx.ts         Contract document generation
  brokerage-payments.ts    Brokerage payment logic
  roster-import.ts         Agent roster parsing (.csv/.xlsx) for the bulk importer
  brokerage-admin-roles.ts, brokerage-logo-generator.ts  Brokerage helpers
  formatting.ts, utils.ts, request-helpers.ts, file-validation.ts, cron-auth.ts  Helpers
  supabase/
    client.ts              Browser Supabase client (sync, RLS enforced)
    server.ts              Server client (async cookies) + createServiceRoleClient (bypasses RLS)
  actions/                 Server actions ('use server'), one file per domain area
    deal-actions.ts, admin-actions.ts, brokerage-actions.ts, agent/account-actions.ts,
    kyc-actions.ts, esign-actions.ts, cure-actions.ts, remediation-actions.ts,
    firm-deal-*-actions.ts, report-actions.ts, settings-actions.ts, profile-actions.ts,
    amendment-actions.ts, assignment-actions.ts, audit-actions.ts,
    balance-adjustment-actions.ts, notification-actions.ts, auth-actions.ts
  firm-deal-detection/     Google Sheets polling + matching + notification pipeline
    sheets-client.ts, poll-spreadsheet.ts, parse-event.ts, match-agents.ts,
    process-event.ts, dispatch-notification.ts, dispatch-brokerage-offer.ts,
    render-email.ts, render-sms.ts, render-brokerage-offer-email.ts,
    render-agent-decline-email.ts, magic-link.ts, twilio-client.ts,
    row-hash.ts, deal-hash.ts
```

Key areas:

- **`lib/supabase/`** holds the three client factories. Picking the right one is the most common source of RLS bugs (see [authentication.md](./authentication.md)).
- **`lib/actions/`** holds server actions, the write path for the app. Each file covers one domain area and verifies the caller before mutating.
- **`lib/calculations.ts` and `lib/constants.ts`** implement the financial rules (discount fee, chargeable days, late interest). The canonical spec for these numbers is in `CLAUDE.md`.
- **`lib/firm-deal-detection/`** is the pipeline that polls brokerage-shared Google Sheets, detects newly-firm deals, matches them to agents, and dispatches email and SMS offers.

## supabase/migrations/

Ordered SQL migrations, numbered `003` through `099` (and counting). They define the schema, RPCs, triggers, and the large body of Row Level Security policies that form the app's primary security boundary. The numbering is roughly chronological; a few numbers are duplicated across two files where parallel work landed, so read by filename, not by assuming a strict integer sequence. Run migrations against Supabase using the `SUPABASE_DB_URL` connection string per `CLAUDE.md`.

## migrations/ (root)

A separate, hand-applied SQL set distinct from `supabase/migrations/`. These four files (`004_audit_log_immutable`, `005_audit_log_enhanced`, `006_invite_tokens`, `007_user_profiles_last_active_at`) were run directly in the Supabase SQL Editor and are numbered independently of the main pipeline. They cover audit_log tamper-proofing, the `invite_tokens` table behind magic-link auth, and the `user_profiles.last_active_at` session-heartbeat column. See [database.md](./database.md#7-migration-history).

## scripts/

Operational and one-off scripts (`.mjs` and `.mts`): seeding test data, verifying Google Sheets access, applying or checking specific migrations, parser tests, and smoke tests. These are run by hand or during development, not part of the deployed app.

## docs/

Project documentation, including this `architecture/` folder. Related architecture docs: [overview.md](./overview.md) and [authentication.md](./authentication.md). Other docs in `docs/` cover audit remediation, planning notes, and multi-province expansion research.
