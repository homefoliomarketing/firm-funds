# Firm Funds Database Architecture

_Last updated: 2026-06-10_

This document describes the Supabase Postgres data layer for Firm Funds: the tables, status enums, stored procedures, Row Level Security model, and the full migration history that produced the schema.

## 1. Overview

Firm Funds runs on Supabase-hosted Postgres. Row Level Security (RLS) is the primary security boundary, not the application layer. Every table that holds tenant data has RLS enabled, and policies decide what each role (super_admin, firm_funds_admin, brokerage_admin, agent) can read or write. Server-side mutations deliberately bypass RLS by using the service-role client (`createServiceRoleClient()` in `lib/supabase/server.ts`); the browser-side client (`createClient()`) is always subject to RLS.

### Migration numbering convention

Migrations live in `supabase/migrations/` and are numbered with a three-digit prefix. The first applied file in this repository is `003_audit_log.sql`. The base tables (`user_profiles`, `agents`, `brokerages`, `deals`, `deal_documents`, `underwriting_checklist`) were created directly in the Supabase dashboard before migration tracking began, so there is no `001`/`002` file in the repository; those tables are referenced (via `ALTER TABLE`, `REFERENCES`, and RLS policies) from `003` onward. Read `003` and `004` together to see the earliest in-repo definitions and the original RLS hardening.

The numbering groups roughly into feature batches:

| Range | Theme |
| --- | --- |
| 003 to 029 | Core schema hardening, audit log, underwriting checklist, FINTRAC KYC, agent ledger, messaging, banking/profile fields, e-signature envelopes |
| 030 to 049 | DocuSign envelopes, branding, white-label, closing-date amendments, failed-to-close / cure election, settlement overhaul, delete safeguards, FK CASCADE-to-RESTRICT |
| 050 to 069 | Idempotency and atomic RPCs (balance, strikes, remediation, interest), ledger immutability, storage policy tightening, soft delete, audit-log hardening |
| 070 to 079 | Concurrency uniqueness constraints, cron idempotency log, DocuSign linkage, atomic admin-note append, firm-deal detection pipeline |
| 080 to 099 | Firm-deal magic links, offer acceptance, optimistic locking, failed-funding recovery, early closing, multi-admin junction, unsubscribe, active-status RLS, brokerage admin sub-roles, co-agent split |
| 100 to 108 | Underwriter assigned_at, KYC bucket limits, staff least-privilege roles, look-only impersonation, brokerage OG image, agent self-submit, informational statement ledger, signed-BCA path / welcome flag / deposit-auth consent, human-readable deal numbers |

There is no `095_firm_deal_offer_expiry.sql` in the repository. The actual `095` file is `095_fix_brokerage_admins_recursion.sql`. The highest-numbered migration on disk is `108_deal_numbers.sql`.

**Duplicate migration numbers.** Two prefixes are used twice: `008_audit_fixes.sql` and `008_underwriting_checklist_cleanup.sql`, plus `096_brokerage_logo_includes_tagline.sql` and `096_manual_brokerage_nudge.sql`. For these, apply order is by full filename (alphabetical), so the `008_audit_fixes` file runs before `008_underwriting_checklist_cleanup`, and `096_brokerage_logo_includes_tagline` runs before `096_manual_brokerage_nudge`. This is a historical accident, not a pattern to copy: never reuse a migration number going forward. Always pick the next unused prefix above the current highest file.

### Naming note

This data layer does not contain a `parcllabs_events` table, a `help_content` table, a `settings`/`app_settings` table, an `email_log` table, or a `brokerage_users` table. Where the task brief referenced those names:

- The firm-deal detection pipeline uses `firm_deal_events`, `brokerage_pipes`, and `brokerage_name_mapping` (migration 078), not `parcllabs_events`.
- Help Center content is stored as TSX modules under `content/help/`, not in a database table.
- The multi-admin link table is `brokerage_admins` (migration 087), not `brokerage_users`.
- Email failures are captured in `cron_email_failures` (migration 088); there is no general `email_log`.
- Business constants (discount rate, settlement days, interest rate) live in code (`lib/constants.ts`), not in a settings table.

## 2. Entity model

The core entities and how they relate:

- **`user_profiles`** is the identity row, one per `auth.users` row. It carries `role`, optional `agent_id`, and optional `brokerage_id` linking the login to a domain entity. Helper SQL functions (`get_user_role()`, `get_user_agent_id()`, `get_user_brokerage_id()`, `is_admin()`) read from this table to drive RLS.
- **`brokerages`** is the firm. It owns agents, deals, branding, KYC/RECO verification fields, settlement-strike tracking, and white-label profit-share configuration.
- **`agents`** belong to a brokerage. An agent carries KYC status, banking info, a running `account_balance`, and activation gates. Agents are the borrowers whose commissions are advanced.
- **`brokerage_admins`** is a junction table (migration 087) linking `auth.users` to a brokerage with a sub-role (broker_of_record / brokerage_manager / brokerage_admin after migration 098). It supersedes the older single `user_profiles.brokerage_id` link for multi-admin brokerages.
- **`deals`** is the central record: one advance request per row, owned by an `agent_id` and a `brokerage_id`. Deals progress through a status lifecycle and carry the financial snapshot (gross commission, fees, settlement days at funding, balances, broker-share fields).
- **`deal_documents`** stores uploaded files for a deal (APS, trade record, KYC, etc.). `document_returns` and `closing_date_amendments` hang off deals/documents.
- **`agent_transactions`** is the agent ledger: an append-only running balance of interest, deductions, credits, and invoice payments. `agents.account_balance` is the materialized running total. `agent_invoices` are billable items against an agent.
- **`brokerage_payments`** (migration 055) and **`eft_transfers`** (migration 058) are real tables that replaced JSONB arrays on the deal: brokerage repayments in, Firm Funds wire-outs out.
- **`remediation_deals`** (migration 046) are admin-entered future commission assignments used to cure a failed deal under CPA 5.5(b).
- **Firm-deal detection** (migration 078): `brokerage_pipes` configure intake, `firm_deal_events` capture each detected deal trigger, and `brokerage_name_mapping` learns shorthand-to-agent resolutions. `firm_deal_magic_links` (migration 080) carry one-shot agent login tokens for offer CTAs.
- **`esignature_envelopes`** + **`docusign_tokens`** + **`docusign_webhook_events`** support DocuSign contract flows (CPA, IDP, BCA, Remediation IDP).
- **`audit_log`** records all significant actions; it is immutable (no UPDATE/DELETE policy).
- Operational tables: `cron_run_log` (idempotency), `cron_email_failures` (dead-letter retry queue), `email_unsubscribe_tokens` (CASL compliance), `kyc_upload_tokens` (mobile KYC), `deal_messages` + `message attachments` (admin/agent chat).

Relationship summary:

| Parent | Child | Cardinality | FK behavior |
| --- | --- | --- | --- |
| brokerages | agents | 1 to many | (agents.brokerage_id) |
| brokerages | brokerage_admins | 1 to many | ON DELETE CASCADE |
| brokerages | deals | 1 to many | (deals.brokerage_id) |
| agents | deals | 1 to many | (deals.agent_id) |
| agents | agent_transactions | 1 to many | ON DELETE CASCADE (guarded by trigger, migration 062) |
| agents | agent_invoices | 1 to many | ON DELETE CASCADE |
| deals | deal_documents | 1 to many | ON DELETE CASCADE |
| deals | brokerage_payments | 1 to many | ON DELETE RESTRICT |
| deals | eft_transfers | 1 to many | ON DELETE RESTRICT |
| deals | esignature_envelopes | 1 to many | ON DELETE CASCADE |
| deals | closing_date_amendments | 1 to many | ON DELETE CASCADE |
| deals (failed) | remediation_deals | 1 to many | ON DELETE CASCADE |
| brokerages | brokerage_pipes | 1 to many | ON DELETE CASCADE |
| brokerage_pipes | firm_deal_events | 1 to many | ON DELETE CASCADE |
| firm_deal_events | firm_deal_magic_links | 1 to many | ON DELETE CASCADE |

## 3. Table reference

Column lists below capture the significant columns (keys, status/enum fields, financial fields, lifecycle timestamps). Trivial audit-timestamp columns (`created_at`, `updated_at`) are present on most tables and omitted unless load-bearing.

### deals

The central advance record. Base columns predate migration tracking; the columns below are assembled from migrations 006, 008, 011 (no), 018, 039, 043, 044, 046, 047, 081, 083, 084, 085, 108, and the validation schema in `lib/validations.ts`.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Deal identifier |
| deal_number | TEXT (UNIQUE, nullable) | Human-readable tracking number stamped at submission, format `NNNN-MMDD-YY` (e.g. `0001-0609-26` = first deal submitted on the Toronto day June 9, 2026; the `NNNN` daily sequence resets each Toronto day). NULL for unsubmitted firm-deal offers. Assigned by the `assign_deal_number()` trigger, never by app code (migration 108) |
| submitted_at | TIMESTAMPTZ | When the deal was first submitted (its status first left `offered`); set alongside `deal_number` by the same trigger (migration 108) |
| agent_id | UUID FK agents | Owning agent |
| brokerage_id | UUID FK brokerages | Owning brokerage |
| status | TEXT (CHECK) | Lifecycle state (see section 4) |
| source | TEXT (CHECK) | `nexone_auto`, `manual_portal`, or `firm_deal_offer` (migration 081) |
| property_address | TEXT | Subject property |
| closing_date | DATE | Scheduled closing |
| actual_closing_date | DATE | Real closing date if it differed (migration 018) |
| gross_commission | NUMERIC(12,2) | Commission before brokerage split |
| brokerage_split_pct | numeric | Whole-number percent (5 = 5%); do not multiply by 100 |
| discount_fee | NUMERIC(12,2) | Primary advance fee |
| settlement_period_fee | NUMERIC(12,2) | Flat non-refundable settlement fee (migration 039) |
| settlement_days_at_funding | integer | Snapshot of brokerage settlement window at funding (migration 047) |
| late_strike_recorded | boolean | Idempotency guard so a brokerage is struck at most once per deal (migration 047) |
| due_date | DATE | closing_date + 14 days (migration 039) |
| brokerage_referral_pct | NUMERIC(5,4) | Per-deal referral snapshot, 0 to 1 decimal (migration 039) |
| payment_status | TEXT (CHECK) | `pending`, `paid`, `overdue`, `not_applicable` (migration 039) |
| repayment_amount | NUMERIC(12,2) | Sum of confirmed brokerage payments, kept in sync by trigger (migrations 008, 055) |
| balance_deducted | NUMERIC(12,2) | Amount of advance applied to the agent's outstanding balance (migration 039) |
| late_interest_charged | NUMERIC(12,2) | Cumulative late-payment interest posted (migration 018) |
| late_interest_calculated_at | TIMESTAMPTZ | Last late-interest run (migration 018) |
| failed_deal_interest_charged | NUMERIC(12,2) | Cumulative failed-deal interest (migrations 045, 066) |
| failed_to_close_at | TIMESTAMPTZ | When the deal failed (migration 044) |
| failure_reason | TEXT | Free text (migration 044) |
| failure_type | TEXT (CHECK) | `non_closing` (CPA 5.1) or `commission_deficiency` (CPA 5.2) (migration 044) |
| outstanding_balance | NUMERIC(12,2) | Amount owed on a failed deal (migration 044) |
| cure_election | TEXT (CHECK) | `cash_repayment` or `commission_assignment`, NULL until elected (migrations 044, 050) |
| cure_election_at | TIMESTAMPTZ | When the agent elected (migration 044) |
| cure_election_deadline | TIMESTAMPTZ | 15 days after failure; deemed cash if missed (migration 044) |
| broker_share_pct_at_funding | NUMERIC(5,2) | White-label profit-share snapshot (migration 043) |
| broker_share_amount | NUMERIC(12,2) | Computed broker share at completion (migration 043) |
| broker_share_remitted | BOOLEAN | Whether the broker share was short-paid (migration 043) |
| offered_at | TIMESTAMPTZ | Agent clicked the firm-deal offer CTA (migration 081) |
| offered_event_id | UUID FK firm_deal_events | Back-link to the detection event (migration 081) |
| brokerage_notified_at | TIMESTAMPTZ | First brokerage notification on an offered deal (migration 081) |
| brokerage_nudge_2h_at | TIMESTAMPTZ | 2-hour nudge (migration 081) |
| internal_alert_4h_at | TIMESTAMPTZ | 4-hour internal escalation (migration 081) |
| brokerage_declined_at / brokerage_declined_reason | TIMESTAMPTZ / TEXT | Brokerage declined the offer (migration 081) |
| agent_self_submit_at | TIMESTAMPTZ | Agent took an `offered` deal over to submit it themselves; pauses the brokerage on it (hidden from submit-on-behalf queue, convert/decline refused, nudge crons skip it). NULL = brokerage still owns the submission. Cleared if the agent hands it back (migration 105) |
| funding_failure_reason / funding_failed_at | TEXT / TIMESTAMPTZ | EFT bounce or banking-rejection recovery (migration 084) |
| revised_from_deal_id | UUID FK deals | Resubmission lineage (migration 084) |
| version | INTEGER | Optimistic-lock counter, auto-bumped by trigger (migration 083) |
| assigned_to_user_id | UUID FK auth.users | Underwriter who owns the deal in the queue (migration 083) |
| admin_notes / admin_notes_timeline | TEXT / JSONB | Internal underwriting notes (migrations 006, 008) |
| brokerage_payments_legacy_jsonb | JSONB | Deprecated; backfilled into `brokerage_payments` table (migration 055) |
| eft_transfers_legacy_jsonb | JSONB | Deprecated; backfilled into `eft_transfers` table (migration 058) |

### deal_number_counters (migration 108)

Atomic per-day sequence source for `deals.deal_number`: one row per Toronto calendar date, holding the highest sequence handed out that day. Written **only** by the `assign_deal_number()` trigger; no API client (or even the service role through normal code paths) touches it directly. RLS is enabled with **no policies**, so it denies all access except the SECURITY DEFINER trigger that bypasses RLS.

| Column | Type | Purpose |
| --- | --- | --- |
| date_key | date PK | Toronto calendar date |
| last_seq | integer (NOT NULL, default 0) | Highest `NNNN` sequence issued for that date |
| updated_at | timestamptz | Last increment time |

The trigger increments the day's row via an `INSERT ... ON CONFLICT (date_key) DO UPDATE` upsert, which row-locks the `date_key` row so two concurrent submissions on the same day always get distinct sequences. See `assign_deal_number()` in section 5.

### agents

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Agent identifier |
| brokerage_id | UUID FK brokerages | Owning brokerage |
| first_name / last_name | TEXT | Name |
| email | TEXT (nullable) | Intentionally nullable; many agents have no email on file (by design) |
| status | TEXT (CHECK) | `active`, `inactive`, `archived` (migration 014) |
| account_balance | NUMERIC(12,2) | Running ledger balance; positive = agent owes Firm Funds, negative = credit (migration 018) |
| flagged_by_brokerage | boolean | Brokerage flag that blocks access (used in active-status RLS, migration 094) |
| kyc_status | TEXT (CHECK) | `pending`, `submitted`, `verified`, `rejected` (migration 011) |
| kyc_submitted_at / kyc_verified_at / kyc_verified_by | timestamptz / text | KYC review trail (migration 011) |
| kyc_document_path / kyc_document_type / kyc_rejection_reason | text | FINTRAC ID details (migration 011) |
| bank_transit_number / bank_institution_number / bank_account_number | TEXT (CHECK format) | Banking, admin-entered, format-checked (migration 021) |
| banking_verified / banking_verified_at / banking_verified_by | boolean / timestamptz / uuid | Banking verification (migration 021) |
| banking_approval_status | text | Self-service banking approval gate (migration 031) |
| preauth_form_path / preauth_form_uploaded_at | TEXT / timestamptz | Void cheque / direct deposit authorization form, in the `agent-preauth-forms` bucket. Required at onboarding before banking can be submitted; admin reviews it via the "View void cheque / direct deposit" button (migration 021) |
| deposit_authorized_at / deposit_authorized_by | TIMESTAMPTZ / UUID FK auth.users | Records the mandatory "I authorize Firm Funds Inc. to deposit payments into this account" consent the agent gives during onboarding; stamped by `submitAgentBanking` when the `authorizeDeposit` flag is set (migration 107) |
| address_street / address_city / address_province / address_postal_code | TEXT | Address, province defaults to Ontario (migration 021) |
| welcome_email_sent_at | TIMESTAMPTZ | Welcome email tracking (migration 043) |
| account_activated_at | TIMESTAMPTZ | Auto-set when KYC verified AND banking approved, via trigger (migration 043) |
| email_notifications_enabled | BOOLEAN (default true) | Outbound-email kill switch (migration 092) |

### brokerages

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Brokerage identifier |
| name | TEXT | Legal/display name |
| brand / logo_url / logo_includes_tagline / brand_color | TEXT / BOOLEAN | Branding for the white-label agent portal (migrations 032, 096). `logo_url` is auto-populated with a generated SVG on brokerage creation when the admin doesn't supply one (`createBrokerage` → `generateAndStoreBrokerageLogo`), so `logo_includes_tagline` is then `true`. If `logo_url` is ever null/empty, the agent + brokerage headers still render a generated logo on the fly from `name` (`brokerageLogoDataUri` fallback in `components/AgentHeader.tsx` + `components/BrokerageBrandLogo.tsx`) so a brokerage's advance-division logo is never replaced by the bare Firm Funds wordmark. Backfill existing nulls with `scripts/backfill-brokerage-logos.mts` |
| og_image_url | TEXT | Public PNG of the white-label logo for social / SMS link-preview cards (Open Graph). Raster companion to `logo_url` (SVG); served by `app/agent/firm-deal/[token]` as og:image. Generated by `scripts/generate-og-logo.mts` (migration 104) |
| email | TEXT | Primary contact; default notification recipient |
| address / city / province / postal_code / phone | TEXT | Contact details (migrations 029, 038) |
| status | TEXT | `active`, `inactive`, `suspended` |
| referral_fee_percentage | numeric (0 to 1) | Brokerage's cut of the fees. Kept in lockstep with `profit_share_pct` by the admin form's single "Profit Share %" field (this = profit_share_pct / 100). See financial-model.md |
| transaction_system | TEXT | NexOne/other transaction-management system |
| broker_of_record_name / broker_of_record_email | TEXT | BoR signatory for the BCA (migration 029) |
| bca_signed_at | timestamptz | Brokerage Cooperation Agreement signed timestamp |
| bca_signed_pdf_path | TEXT | Storage path of the signed BCA PDF in the `deal-documents` bucket (`brokerage-bca/{brokerageId}/...`), recorded by the DocuSign webhook so the signed BCA can be viewed/downloaded from the admin Brokerages page via `getSignedBcaUrl` (migration 107). A BCA is brokerage-level (no deal_id), so the one signed file lives here rather than in `deal_documents` |
| kyc_verified / kyc_verified_at / kyc_verified_by | boolean / timestamptz / text | FINTRAC verification (migration 011) |
| reco_registration_number / reco_verification_date / reco_verification_notes | text / date | RECO public-register check (migration 011) |
| is_white_label_partner | BOOLEAN | White-label flag (migration 043) |
| profit_share_pct | NUMERIC(5,2) (0 to 100) | Negotiated profit share, whole number (migration 043). Mirror of `referral_fee_percentage` (this = referral_fee_percentage x 100); set together by the admin form's single "Profit Share %" field |
| late_strike_count | integer (default 0) | Running count of missed 7-day settlements (migration 047). Internal: never exposed to the brokerage |
| auto_bumped_to_14_days_at | timestamptz | Non-null once auto-bumped to 14-day settlement (migration 047). Internal |
| last_strike_reset_at | timestamptz | Last admin strike reset (migration 047). Internal |
| settlement_days_override | integer | Optional manual settlement-window override (migration 047). Internal |
| email_notifications_enabled | BOOLEAN (default true) | Outbound-email kill switch; operational/legal emails bypass it (migration 092) |

Note: the late-strike columns and the override are internal and excluded from `BROKERAGE_PUBLIC_COLUMNS` (`lib/constants.ts`). Non-admin queries must use that column allowlist rather than `select('*')`.

### brokerage_admins (junction, migration 087)

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Row id |
| brokerage_id | UUID FK brokerages | ON DELETE CASCADE |
| user_id | UUID FK auth.users | ON DELETE CASCADE |
| role | TEXT (CHECK) | After migration 098: `broker_of_record`, `brokerage_manager`, `brokerage_admin` (was `admin` / `primary_admin` in 087) |
| invited_at / accepted_at | TIMESTAMPTZ | Invite-accept lifecycle |
| created_by | UUID FK auth.users | Who invited |

`UNIQUE (brokerage_id, user_id)` prevents double grants. Writes are service-role only (authenticated INSERT/UPDATE/DELETE policies all deny). Membership checks from other policies go through the `is_user_brokerage_admin_of()` SECURITY DEFINER helper to avoid RLS recursion (migration 095).

### agent_transactions (the ledger, migration 018)

Append-only ledger. Balance writes must go through RPCs (section 5), never read-modify-write.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Ledger row id |
| agent_id | UUID FK agents | Owning agent (ON DELETE CASCADE, guarded by trigger 062) |
| deal_id | UUID FK deals | Related deal, nullable (ON DELETE SET NULL) |
| type | TEXT (CHECK) | See type set below |
| amount | NUMERIC(12,2) | Signed delta applied to the balance |
| running_balance | NUMERIC(12,2) | Balance after this row |
| description | TEXT | Human-readable reason |
| reference_id | TEXT | Optional external reference (e.g. invoice id) |
| created_by | UUID | Actor |

`type` values (assembled across migrations 018, 039, 044, 073, 106): `late_closing_interest`, `late_payment_interest`, `balance_deduction`, `balance_deduction_reversed`, `invoice_payment`, `adjustment`, `credit`, `failed_deal_balance`, `failed_deal_interest`, `deal_advance`, `deal_repayment`. The ledger is immutable past insertion (migration 054).

`deal_advance` and `deal_repayment` (migration 106) are **informational** entries: a charge posted when a deal is funded (for `amount_due_from_brokerage`) and a payment posted when a brokerage payment is confirmed received. They make the ledger read like a statement (advance issued -> repayment received, netting to zero on a clean deal) but DO NOT change `account_balance` — they are written via `record_agent_statement_entry`, which freezes `running_balance` at the current balance. Because they never move the owed balance, they never trigger late-payment interest accrual or get netted against a future advance.

### agent_invoices (migration 018)

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Invoice id |
| agent_id | UUID FK agents | Billed agent |
| invoice_number | TEXT UNIQUE | Sequential (FF-YYYY-NNNN), via `invoice_number_seq` |
| amount | NUMERIC(12,2) | Invoice total |
| status | TEXT (CHECK) | `pending`, `paid`, `overdue`, `cancelled` |
| due_date | DATE | Payment due |
| paid_at / paid_amount / sent_at | TIMESTAMPTZ / NUMERIC / TIMESTAMPTZ | Lifecycle |
| line_items | JSONB | Snapshot of charges |
| agent_name / agent_email / agent_phone | TEXT | Snapshot at creation |

### brokerage_payments (migration 055)

Real table that replaced the `deals.brokerage_payments` JSONB array. A trigger keeps `deals.repayment_amount` in sync with the sum of confirmed payments.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Payment id |
| deal_id | UUID FK deals | ON DELETE RESTRICT |
| brokerage_id | UUID FK brokerages | ON DELETE RESTRICT |
| amount | NUMERIC(12,2) CHECK > 0 | Payment amount |
| payment_date | DATE | Date of payment |
| method | TEXT (CHECK) | `eft`, `wire`, `cheque`, `cash`, `other` |
| status | TEXT (CHECK) | `pending`, `confirmed`, `rejected` |
| submitted_by_role | TEXT (CHECK) | `admin` or `brokerage_admin` |
| submitted_by_user_id / reviewed_by_user_id | UUID FK auth.users | Submit/review actors |
| reviewed_at / rejection_reason | TIMESTAMPTZ / TEXT | Admin review |

### eft_transfers (migration 058)

Outbound EFT/wire transfers Firm Funds sends to fund a deal. Admin-only; not visible to brokerages or agents.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Transfer id |
| deal_id | UUID FK deals | ON DELETE RESTRICT |
| amount | NUMERIC(12,2) CHECK > 0 AND <= 25000 | Single-transfer cap |
| transfer_date | DATE | Date sent |
| confirmed / confirmed_at / confirmed_by_user_id | BOOLEAN / TIMESTAMPTZ / UUID | Confirmation |
| recorded_by_user_id / recorded_at | UUID / TIMESTAMPTZ | Recording actor |

### remediation_deals (migration 046)

Admin-entered future commission assignments to cure a failed deal under CPA 5.5(b). Service-role only (no RLS policies).

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Record id |
| failed_deal_id | UUID FK deals | The failed deal being cured (ON DELETE CASCADE) |
| agent_id | UUID FK agents | Agent making the assignment |
| property_address / mls_number | TEXT | The upcoming transaction |
| brokerage_id | UUID FK brokerages | Nullable; agent may have transferred (ON DELETE SET NULL) |
| brokerage_legal_name / brokerage_address / broker_of_record_name / broker_of_record_email | TEXT | Manually entered details |
| expected_commission / expected_closing_date / expected_payment_date | NUMERIC / DATE | Expectations |
| directed_amount | NUMERIC(12,2) CHECK > 0 | Dollars directed to Firm Funds |
| status | TEXT (CHECK) | `pending`, `idp_sent`, `idp_signed`, `remitted`, `cancelled` |
| remitted_at / remitted_amount | TIMESTAMPTZ / NUMERIC | Outcome |
| escalation_level | added in migration 093 | Overdue-cron escalation tier |
| signed_at | added in migration 099 | DocuSign Remediation IDP signed flip |

`UNIQUE` per (failed_deal, property) prevents duplicates (migration 090).

### firm_deal_events (migration 078)

Every raw event ingested by a pipe; one row per detected deal trigger.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Event id |
| brokerage_pipe_id | UUID FK brokerage_pipes | Source pipe (ON DELETE CASCADE) |
| brokerage_id | UUID FK brokerages | Owning brokerage |
| source | TEXT (CHECK) | `spreadsheet` or `email` |
| raw_payload | JSONB | Full input as received |
| parsed | JSONB | AI parser extract |
| parser_confidence | TEXT (CHECK) | `high`, `medium`, `low` |
| deal_hash | TEXT | sha256(normalized_address + closing_date + price_bucket) for dedup |
| status | TEXT (CHECK) | `new`, `parsed`, `duplicate`, `unmatched`, `awaiting_approval`, `approved`, `offer_sent`, `rejected`, `errored` |
| matched_agent_id / second_matched_agent_id | UUID FK agents | Up to two agents (dual-side or co-agent split) |
| co_agent_split | BOOLEAN (default false) | True when both matched agents share one side, e.g. "Kyle/Tricia" (migration 097) |
| offer_deal_id / second_offer_deal_id | UUID FK deals | Linked advance deal(s) once an offer is created |
| email_sent_at / sms_sent_at / nudge_email_sent_at / nudge_sms_sent_at | TIMESTAMPTZ | Dispatch tracking |
| reviewed_by / reviewed_at | UUID / TIMESTAMPTZ | Manual review trail |
| error_message | TEXT | Failure context |
| received_at / processed_at | TIMESTAMPTZ | Ingest and processing times |

Side tracking (which agent is buy-side vs sell-side) was added in migration 079. `UNIQUE` constraint preventing duplicate offered deals per (event, agent) is in migration 089.

### brokerage_pipes (migration 078)

Per-brokerage intake configuration (spreadsheet or email).

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Pipe id |
| brokerage_id | UUID FK brokerages | Owning brokerage (ON DELETE CASCADE) |
| pipe_type | TEXT (CHECK) | `spreadsheet` or `email` |
| config | JSONB | Pipe-specific settings (sheet_id, column_mapping, bcc_local_part, etc.) |
| brand_name / brand_tagline | TEXT | White-label branding for outbound email/SMS |
| auto_fire_enabled | BOOLEAN (default false) | When false, parsed events queue for manual approval |
| enabled | BOOLEAN (default true) | Active flag |
| last_polled_at / last_poll_state | TIMESTAMPTZ / JSONB | Diff-detection snapshot |
| notification_recipients | JSONB | { include_broker_of_record, extra_emails[] } (migration 082) |

### brokerage_name_mapping (migration 078)

Learned shorthand-to-resolution map, built through the admin review queue.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Mapping id |
| brokerage_id | UUID FK brokerages | Owning brokerage |
| shorthand / shorthand_lower | TEXT (generated lower) | The name as it appears on the sheet |
| resolution | TEXT (CHECK) | `agent`, `team`, `outside` |
| agent_id | UUID FK agents | Set when resolution = agent |
| team_agent_ids | UUID[] | Set (>=2) when resolution = team |

A CHECK constraint enforces exactly one of `agent_id` / `team_agent_ids` based on `resolution`. Case-insensitive uniqueness per (brokerage, shorthand). Note from project memory: a "team" mapping here is a one-off split, not a persisted team entity.

### firm_deal_magic_links (migration 080)

One-shot login tokens embedded in firm-deal offer CTAs so an unauthenticated agent auto-signs-in.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Row id |
| token | TEXT UNIQUE | URL-safe identifier sent in email/SMS |
| firm_deal_event_id | UUID FK firm_deal_events | The offer to surface (ON DELETE CASCADE) |
| agent_id | UUID FK agents | The agent (ON DELETE CASCADE) |
| expires_at | TIMESTAMPTZ | 7-day default TTL |
| used_at | TIMESTAMPTZ | Set atomically on consume; NULL = valid |

Locked down with an explicit deny-all RLS policy (migration 091); only the service role reads/writes.

### esignature_envelopes (migration 030)

DocuSign envelope tracking for CPA, IDP, BCA, and Remediation IDP.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Envelope row id |
| deal_id | UUID FK deals | Deal-scoped envelope (nullable for BCA / remediation) |
| brokerage_id | UUID FK brokerages | Brokerage-scoped (BCA), added migration 037 |
| remediation_deal_id | UUID FK remediation_deals | Remediation IDP scope, added migration 046 |
| envelope_id / envelope_uri | TEXT | DocuSign identifiers |
| document_type | TEXT (CHECK) | `cpa`, `idp` originally; BCA and remediation_idp added later |
| status | TEXT (CHECK) | `sent`, `delivered`, `signed`, `declined`, `voided` |
| agent_signer_status / agent_signed_at | TEXT / TIMESTAMPTZ | Agent signer progress |
| brokerage_signer_status / brokerage_signed_at | TEXT / TIMESTAMPTZ | Brokerage signer progress |
| sent_by / completed_at / voided_at / void_reason | UUID / TIMESTAMPTZ / TEXT | Lifecycle |

A `chk_envelope_scope` CHECK ensures exactly one of (deal_id, brokerage_id, remediation_deal_id) is set (migration 046). At most one active envelope per (deal, document_type) is enforced in migration 071. Service-role only (no policies). Companion tables: `docusign_tokens` (single-row OAuth token store) and `docusign_webhook_events` (event dedup, migration 067).

### closing_date_amendments (migration 041)

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Amendment id |
| deal_id | UUID FK deals | Affected deal |
| requested_by | UUID | Requesting agent |
| old_closing_date / new_closing_date | DATE | Proposed change |
| status | TEXT (CHECK) | `pending`, `approved`, `rejected` |
| amendment_document_id | UUID FK deal_documents | Executed amendment upload |
| reviewed_by / reviewed_at / rejection_reason | UUID / TIMESTAMPTZ / TEXT | Admin review |
| old/new_discount_fee, old/new_settlement_period_fee, old/new_advance_amount, old/new_due_date | NUMERIC / DATE | Fee recalculation before/after |

At most one pending amendment per deal (migration 070).

### deal_documents

Base table (predates migration tracking). The `document_type` CHECK constraint is widened across migrations 041 (closing_date_amendment) and 042 (banking_info). The canonical type list lives in `lib/constants.ts` (`DOCUMENT_TYPES`): aps, amendment, trade_record, mls_listing, commission_agreement, direction_to_pay, notice_of_fulfillment, kyc_fintrac, id_verification, brokerage_cooperation_agreement, closing_date_amendment, banking_info, other. Upload source is `nexone_auto` or `manual_upload`. Related: `document_returns` (migration 018) for returning incorrect docs to agents.

### audit_log (migration 003)

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Entry id |
| user_id | UUID FK auth.users | Actor (ON DELETE SET NULL) |
| action | TEXT | e.g. `deal.status_change`, `document.upload` |
| entity_type / entity_id | TEXT / UUID | Affected entity |
| metadata | JSONB | Context (old/new status, etc.) |
| impersonated_target_id | UUID (nullable) | When set, the row was written while the actor was viewing-as this target (migration 103). The actor columns (`user_id` / `actor_email` / `actor_role`) always stay the real staffer; this is the only place the target is recorded. Partial index `WHERE impersonated_target_id IS NOT NULL` |
| ip_address | INET | Request IP |
| created_at | TIMESTAMPTZ | Time |

Immutable: only admins can SELECT, authenticated users can INSERT, and there are no UPDATE/DELETE policies. INSERT hardened in migration 064.

### impersonation_sessions (migration 103)

Look-only "view as user" sessions. An Owner views the app as a specific agent or brokerage user; this table is the source of truth for "is someone being viewed-as right now?". An active row (`ended_at IS NULL` and `expires_at` in the future) keyed by `real_user_id` means that Owner is currently viewing as `target_user_id`. See [authentication.md](./authentication.md#impersonation-view-as-user) and `lib/impersonation.ts`.

| Column | Type | Purpose |
| --- | --- | --- |
| id | UUID PK | Session id |
| real_user_id | UUID FK auth.users | The Owner doing the viewing; bound to the verified auth user (ON DELETE CASCADE) |
| real_email / real_role | TEXT (nullable) | Snapshot of the real staffer at start |
| target_user_id | UUID FK auth.users | The user being viewed (ON DELETE CASCADE) |
| target_email | TEXT (nullable) | Target email snapshot |
| target_role | TEXT NOT NULL | `agent` or `brokerage_admin` |
| target_agent_id / target_brokerage_id | UUID (nullable) | Denormalized for reporting |
| reason | TEXT (nullable) | Optional free-text note |
| started_at | TIMESTAMPTZ | Session start (default now) |
| expires_at | TIMESTAMPTZ | Hard cap; the on-screen banner counts down to it (30 min, `IMPERSONATION_MAX_DURATION_MS`) |
| ended_at | TIMESTAMPTZ (nullable) | NULL while active |
| ended_reason | TEXT (nullable) | `manual`, `expired`, `logout`, `switched`, or `revoked` |
| ip_address / user_agent | INET / TEXT (nullable) | Request context at start |
| created_at | TIMESTAMPTZ | Row creation |

A partial **UNIQUE** index on `real_user_id WHERE ended_at IS NULL` enforces at most one active session per staffer (starting a new view-as ends the previous one first, and the index guards the invariant under a race). A second index on `target_user_id` powers "everything done while viewing target X". RLS is enabled with a single SELECT policy (`real_user_id = auth.uid() OR is_admin()`) so the owning staffer and any internal admin can read sessions; there are **no** user-scoped INSERT/UPDATE/DELETE policies, because every write goes through the service-role client, so even the Owner cannot fabricate or tamper with a session via the anon client. The migration is additive and idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`); it changes no existing table's RLS, so RLS stays the real boundary and is still evaluated on the real `auth.uid()`.

### Operational and supporting tables

| Table | Migration | Purpose |
| --- | --- | --- |
| user_profiles | base + 015, 026, 036, 102, 107 | Identity row; `role`, `agent_id`, `brokerage_id`, `must_reset_password`, `staff_title`, `staff_role` (owner/manager/staff least-privilege tier, migration 102), `notification_preferences` JSONB, `welcomed_at` (first-login greeting flag; NULL until the dashboard greets the user once, then "Welcome, {name}" becomes "Welcome back, {name}", migration 107) |
| underwriting_checklist | base + 008/009/012/016/017/022/023/027 | 12-item, 3-category underwriting checklist; rows auto-created by `create_underwriting_checklist()` trigger function |
| brokerage_documents | 008 | **Deprecated / unused.** Formerly backed a manual brokerage document-upload section (BCA/KYC/etc.) on the admin Brokerages page. That UI and its server actions (`uploadBrokerageDocument`, `deleteBrokerageDocument`, `getBrokerageDocumentSignedUrl`) were removed; the only brokerage-level document is now the signed BCA, auto-attached after signing (`brokerages.bca_signed_pdf_path`). The table is left in place (not dropped) but nothing reads or writes it |
| kyc_upload_tokens | 013 (RLS in 040, 065) | One-time mobile KYC upload tokens |
| deal_messages | 018 (28 adds brokerage_admin, 056 tightens) | Admin/agent/brokerage chat per deal |
| document_returns | 018 | Returning incorrect documents to agents |
| cron_run_log | 074 | (job_name, period) idempotency log for cron jobs |
| cron_email_failures | 088 | Dead-letter queue for failed cron emails with retry/backoff |
| email_unsubscribe_tokens | 092 | CASL one-click unsubscribe tokens mapping to (entity_type, entity_id) |
| docusign_tokens | 030 | Single-row DocuSign OAuth token store |
| docusign_webhook_events | 067 | DocuSign webhook event dedup (event_id PK) |
| invite_tokens | root `migrations/006` | One-time magic-link invite tokens (32 hex bytes, 72h expiry, single-use); replaces temp passwords. Service-role only, no public RLS. See `app/api/magic-link/route.ts` |

`user_profiles` also carries `last_active_at` (root `migrations/007`), a heartbeat timestamp updated by `/api/session-heartbeat` for server-side session-timeout checks.

## 4. Status enums and lifecycle fields

### deals.status

The canonical flow and its terminal/recovery branches, enforced by the `deals_status_check` constraint (last rewritten in migration 084):

```
offered -> under_review -> approved -> funded -> completed
```

Full allowed set: `offered`, `under_review`, `approved`, `funded`, `funding_failed`, `completed`, `denied`, `cancelled`, `failed_to_close`, `cured`.

| Status | Meaning | Introduced |
| --- | --- | --- |
| offered | Agent accepted a firm-deal offer; brokerage notified to submit on their behalf. Financials are 0 placeholders until the brokerage submits | migration 081 |
| under_review | Submitted, in underwriting | base |
| approved | Underwriting passed, ready to fund | base |
| funded | Funds disbursed to the agent | base |
| funding_failed | EFT bounced or banking wrong; recoverable | migration 084 |
| completed | Brokerage remitted; deal closed out (renamed from repaid/closed in migration 024) | migration 024 |
| denied | Underwriting rejected | base |
| cancelled | Withdrawn or declined | base |
| failed_to_close | Funded deal that did not close (CPA 5.1) or came up short (CPA 5.2); agent owes a balance | migration 044 |
| cured | A failed deal whose outstanding balance plus accrued interest has been fully satisfied | migration 046 |

Related lifecycle fields on deals: `payment_status` (`pending`/`paid`/`overdue`/`not_applicable`), `failure_type` (`non_closing`/`commission_deficiency`), `cure_election` (`cash_repayment`/`commission_assignment`), `source` (`nexone_auto`/`manual_portal`/`firm_deal_offer`).

### agents.kyc_status

`pending`, `submitted`, `verified`, `rejected` (migration 011; mirrored in `lib/constants.ts` `KYC_STATUSES`).

### agents.status

`active`, `inactive`, `archived` (migration 014).

### firm_deal_events.status

`new`, `parsed`, `duplicate`, `unmatched`, `awaiting_approval`, `approved`, `offer_sent`, `rejected`, `errored` (migration 078). The firm-deal offer side (the brokerage-submits flow) lives on the `deals` row in the `offered` status, not on the event.

### remediation_deals.status

`pending`, `idp_sent`, `idp_signed`, `remitted`, `cancelled` (migration 046).

### brokerage_payments.status

`pending`, `confirmed`, `rejected` (migration 055).

### esignature_envelopes.status

`sent`, `delivered`, `signed`, `declined`, `voided` (migration 030).

### brokerage_admins.role (sub-role within a brokerage)

After migration 098: `broker_of_record`, `brokerage_manager`, `brokerage_admin`. The application-level `user_profiles.role` remains `brokerage_admin` for all three tiers; the split is purely a junction sub-role.

### Application roles (user_profiles.role)

`super_admin`, `firm_funds_admin`, `brokerage_admin`, `agent` (`lib/constants.ts` `ROLES`). The first two are admin roles with full access.

## 5. Stored procedures and RPCs

All balance and strike mutations go through SECURITY DEFINER functions that lock the target row (`FOR UPDATE`) so concurrent callers serialize. These functions are granted to `service_role` only and revoked from `anon`/`authenticated`/`PUBLIC` (migration 072 makes this explicit across the set). The hard rule:

> Never read-modify-write `agents.account_balance`, `agent_transactions`, `brokerages.late_strike_count`, or interest columns directly. Always call the RPC. The discount/settlement/interest constants in `lib/constants.ts` and CLAUDE.md require this.

### Balance and ledger RPCs

| Function | Migration | What it does |
| --- | --- | --- |
| `apply_agent_balance_delta(p_agent_id, p_delta, p_type, p_description, p_deal_id, p_created_by, p_reference_id)` | 052 | Atomically adjusts `agents.account_balance` by a signed delta and inserts the matching `agent_transactions` row. Returns the new transaction. The mandatory entry point for any balance write |
| `apply_agent_balance_delta_capped(p_agent_id, p_delta_magnitude, p_type, p_description, p_deal_id, p_created_by)` | 073 | Atomic clamp-and-deduct: deducts min(magnitude, current_balance) under lock. Used by advance-time balance deductions |
| `record_agent_statement_entry(p_agent_id, p_type, p_amount, p_description, p_deal_id, p_created_by, p_reference_id)` | 106 | Inserts an **informational** `deal_advance`/`deal_repayment` ledger row WITHOUT changing `account_balance` (`running_balance` frozen at current balance). Rejects any non-informational type. Used by funding (advance issued) and brokerage-payment confirmation (repayment received) |
| `mark_invoice_paid_atomic(p_invoice_id, p_paid_amount, p_created_by)` | 073 | CAS-on-status invoice payment plus the matching ledger credit in one transaction. Idempotent if already paid |

### Strike and interest RPCs

| Function | Migration | What it does |
| --- | --- | --- |
| `record_brokerage_late_strike(p_brokerage_id, p_strike_threshold)` | 052 | Atomically increments `late_strike_count` and conditionally sets `auto_bumped_to_14_days_at` once the threshold is crossed. Returns new count and whether this call caused the bump |
| `apply_late_payment_interest(p_deal_id, p_total_interest_owed_through, p_through_date, p_agent_id, p_created_by)` | 066 | Locks the deal and agent, posts only the missing interest delta, updates `late_interest_charged`. Concurrent callers no-op. Requires funded/completed status |
| `apply_failed_deal_interest(p_deal_id, p_total_interest_owed_through, p_through_date, p_agent_id, p_created_by)` | 066 | Same pattern for `failed_deal_interest_charged`; requires failed_to_close/cured status |

### Remediation RPC

| Function | Migration | What it does |
| --- | --- | --- |
| `apply_remediation_remittance(p_agent_id, p_credit_amount, p_unposted_interest_amount, p_failed_deal_id, p_credit_description, p_created_by)` | 052/053 | Single-transaction remediation remittance: posts the unposted-interest catch-up row (if any) and the credit row, then updates the balance. Fixes the phantom-credit bug where a credit was applied without its matching interest |

### Other definer functions and triggers

| Function | Migration | Purpose |
| --- | --- | --- |
| `get_user_role()`, `get_user_agent_id()`, `get_user_brokerage_id()`, `is_admin()` | 004 (re-defined 094) | RLS helper lookups against `user_profiles` |
| `is_user_brokerage_admin_of(p_user_id, p_brokerage_id)` | 095 | RLS-bypassing brokerage_admins membership check; avoids policy recursion |
| `append_admin_note(...)` | 077 | Atomic append to a deal's admin-notes timeline |
| `delete_brokerage_atomic(p_brokerage_id)` | 069 | Atomic permanent brokerage delete |
| `recompute_deal_repayment_amount()` (trigger) | 055 | Keeps `deals.repayment_amount` = sum of confirmed `brokerage_payments` |
| `recompute_active_deal_days_until_closing()` | 057 | Batched recompute of days-until-closing |
| `set_agent_account_activated()` (trigger) | 043 | Sets `account_activated_at` when KYC verified AND banking approved |
| `deals_bump_version()` (trigger) | 083 | Auto-increments `deals.version` for optimistic locking |
| `assign_deal_number()` (trigger) | 108 | `BEFORE INSERT OR UPDATE OF status ON deals`. Stamps `deal_number` (`NNNN-MMDD-YY`, Toronto day) and `submitted_at` the first time a deal's status is not `offered`. Idempotent (never overwrites an existing number) and concurrency-safe via the `deal_number_counters` upsert row lock. SECURITY DEFINER, `search_path=''`. Covers every creation path (agent self-submit, brokerage submit-on-behalf, offer conversion, seed) so no app code assigns the number |
| `prevent_agent_delete_with_deals()`, `prevent_brokerage_delete_with_deals()`, `prevent_financial_deal_delete()`, `prevent_agent_delete_with_history()`, `prevent_confirmed_eft_delete()`, `prevent_confirmed_brokerage_payment_delete()` | 034, 048, 060, 062 | Delete guards protecting financial history |
| `create_underwriting_checklist()` (trigger) | 008/009/012/017/023/027 | Seeds the 12-item underwriting checklist for a new deal |
| `set_updated_at_now()`, `update_updated_at_column()` | 078 / earlier | Generic updated_at triggers |

## 6. Row Level Security notes

RLS is enabled on every table holding tenant data and segments rows by role:

- **Agents** see only their own records: their `agents` row, their `deals` (`agent_id = get_user_agent_id()`), documents/messages/transactions/invoices tied to those deals, and read-only visibility into `brokerage_payments` on their deals. They never see internal brokerage strike data or `eft_transfers`.
- **Brokerage admins** see their brokerage's `brokerages` row (public columns only by convention), agents, deals, and brokerage payments. Multi-admin access is resolved through the `brokerage_admins` junction via `is_user_brokerage_admin_of()` to avoid recursion (migration 095). Active-status checks (agent `status='active'`, not flagged, not soft-deleted; brokerage `status='active'`, not deleted) gate document access in migration 094.
- **Admins** (`super_admin`, `firm_funds_admin`) have broad access via `is_admin()`-based policies. Several internal-only tables (`remediation_deals`, `esignature_envelopes`, `docusign_tokens`, `firm_deal_magic_links`) carry no policies at all, so only the service role can touch them.
- **Immutable/append-only**: `audit_log` and `agent_transactions` (migration 054) have no UPDATE/DELETE policies; financial history is protected by delete-guard triggers (migrations 048, 060, 062).

Because RLS is the security boundary, all server-side mutations run through `createServiceRoleClient()` (`lib/supabase/server.ts`), which uses the service-role key and bypasses RLS entirely. Authorization for those paths is enforced in the server-action code (role checks) rather than by the policies. The browser client (`createClient()`) is always RLS-constrained, so a compromised or malicious browser session can read only what the policies allow. Storage buckets (`deal-documents`, `agent-kyc`, `agent-preauth-forms`) have their own storage.objects policies, tightened in migrations 005, 021, 053, and 094/095.

## 7. Migration history

Chronological list of every file in `supabase/migrations/`. Base tables (`user_profiles`, `agents`, `brokerages`, `deals`, `deal_documents`, `underwriting_checklist`) were created in the Supabase dashboard before `003` and have no migration file.

> **Second migration directory.** There is also a separate, hand-applied set at the repo root in `migrations/` (distinct from `supabase/migrations/`). These four files were run manually in the Supabase SQL Editor rather than through the numbered pipeline, and their numbers are independent of it:
> - `004_audit_log_immutable.sql`: restrictive `audit_log` RLS; no UPDATE/DELETE except service_role (FINTRAC tamper-proofing)
> - `005_audit_log_enhanced.sql`: adds `severity`, `actor_email`, `actor_role`, `old_value`, `new_value`, `user_agent`, `session_id` columns + audit-explorer indexes
> - `006_invite_tokens.sql`: `invite_tokens` table (magic-link auth)
> - `007_user_profiles_last_active_at.sql`: `user_profiles.last_active_at` column (session heartbeat)
>
> When changing audit_log, invite_tokens, or session-heartbeat behavior, check this directory too.

| File | Adds |
| --- | --- |
| 003_audit_log.sql | Immutable `audit_log` table + admin-read/authenticated-insert RLS |
| 004_rls_hardening.sql | RLS helper functions and per-role policies on deals, documents, agents, brokerages, profiles |
| 005_fix_storage_policies.sql | Fix storage policies for the `deal-documents` bucket |
| 006_add_admin_notes.sql | `deals.admin_notes` column |
| 007_document_requests.sql | Document-requests table + updated_at function |
| 008_underwriting_checklist_cleanup.sql | Underwriting checklist cleanup (item set v1) |
| 008_audit_fixes.sql | `deals.repayment_amount`, `admin_notes_timeline`; `brokerage_documents` table |
| 009_checklist_cleanup_v2.sql | Underwriting checklist cleanup v2 |
| 010_brokerage_payments.sql | `deals.brokerage_payments` JSONB array (later replaced by table in 055) |
| 011_fintrac_kyc.sql | FINTRAC KYC fields on brokerages and agents; agent-kyc bucket notes |
| 012_checklist_categories.sql | Category column on the underwriting checklist |
| 013_kyc_upload_tokens.sql | `kyc_upload_tokens` table for mobile KYC uploads |
| 014_agent_archived_status.sql | Adds `archived` to `agents.status` |
| 015_must_reset_password.sql | `user_profiles.must_reset_password` flag |
| 016_checklist_na_option.sql | N/A option on the underwriting checklist |
| 017_underwriting_checklist_final.sql | Final Bud-approved 12-item checklist |
| 018_account_balance_messages_doc_returns.sql | `agents.account_balance`; `agent_transactions`, `agent_invoices`, `deal_messages`, `document_returns`; late-closing fields on deals |
| 019_agent_message_reads.sql | Agent message read tracking |
| 020_admin_message_dismissals.sql | Admin message dismissals |
| 021_agent_banking_profile.sql | Agent banking fields, address fields, preauth-form bucket and policies |
| 022_checklist_document_linking.sql | Link documents to checklist items |
| 023_checklist_auto_check_kyc.sql | Auto-check the KYC checklist item on verification |
| 024_status_completed_rename.sql | Merge repaid/closed into `completed` |
| 025_kill_duplicate_checklist_trigger.sql | Remove a duplicate checklist trigger |
| 026_notification_preferences.sql | `user_profiles.notification_preferences` JSONB |
| 027_swap_agent_checklist_order.sql | Reorder agent-verification checklist items |
| 028_allow_brokerage_admin_messages.sql | Allow `brokerage_admin` as a deal-message sender_role |
| 029_broker_of_record.sql | Broker-of-record fields on brokerages |
| 030_esignature_envelopes.sql | `esignature_envelopes` and `docusign_tokens` tables |
| 031_agent_banking_self_service.sql | Agent self-service banking submission fields |
| 032_brokerage_branding.sql | Brokerage logo/brand-color branding fields |
| 033_message_attachments.sql | File attachments on deal messages |
| 034_deletion_safeguards.sql | Triggers preventing delete of agents/brokerages with deal history |
| 035_kyc_modal_seen.sql | `agents.kyc_verified_modal_seen` flag |
| 036_brokerage_staff.sql | `user_profiles.staff_title` |
| 037_bca_esignature.sql | Brokerage-level (BCA) envelope support on esignature_envelopes |
| 038_brokerage_address_fields.sql | Brokerage city/province/postal; temporary agent-email-optional |
| 039_fees_overhaul.sql | Settlement-period fee, due_date, per-deal referral pct, payment_status; new ledger types |
| 040_kyc_tokens_rls.sql | Enable RLS on `kyc_upload_tokens` |
| 041_closing_date_amendments.sql | `closing_date_amendments` table; new document type |
| 042_add_banking_info_deal_document_type.sql | Add `banking_info` to deal_documents type CHECK |
| 043_white_label_brokerage.sql | White-label flag + profit_share_pct; agent activation trigger; broker-share fields on deals |
| 044_failed_to_close_cure_election.sql | `failed_to_close` status; failure + cure-election columns; ledger type |
| 045_remediation_idp_and_failed_deal_interest.sql | Remediation IDP scaffolding + 24%/yr failed-deal interest accrual |
| 046_remediation_deals.sql | `remediation_deals` table; `cured` status; envelope scope rework |
| 047_settlement_overhaul.sql | 7-day standard settlement, 5-strike auto-bump columns; settlement snapshot on deals |
| 048_deal_delete_safeguards.sql | Financial-deal delete guard; soft delete; backup-script RPC |
| 049_cascade_to_restrict.sql | Switch financial FKs from CASCADE to RESTRICT |
| 050_cure_election_rename.sql | Rename `cash` to `cash_repayment` cure election |
| 051_backfill_settlement_days.sql | Backfill `settlement_days_at_funding` for legacy deals |
| 052_atomic_balance_and_strike.sql | `apply_agent_balance_delta`, `record_brokerage_late_strike`, `apply_remediation_remittance` RPCs |
| 053_storage_bucket_policies.sql | Tighten deal-documents storage policies |
| 054_ledger_immutability.sql | Make `agent_transactions` immutable |
| 055_brokerage_payments_table.sql | `brokerage_payments` table replacing the JSONB array; sync trigger |
| 056_admin_rls_tightening.sql | Tighten admin RLS on invoices, amendments, messages |
| 057_recompute_days_until_closing.sql | Batched recompute of days-until-closing |
| 058_eft_transfers_table.sql | `eft_transfers` table replacing the JSONB array |
| 059_drop_kyc_modal_rls_hole.sql | Drop the dangerous agents UPDATE RLS policy from 035 |
| 060_confirmed_payment_delete_guards.sql | Prevent delete of confirmed EFT transfers and brokerage payments |
| 061_brokerage_payments_deal_ownership.sql | Brokerage-payment INSERT must match deal to brokerage |
| 062_protect_agent_ledger.sql | Guard against cascade-delete wiping the agent ledger |
| 063_soft_delete_agents_brokerages.sql | Soft-delete columns on agents and brokerages |
| 064_audit_log_insert_hardening.sql | Harden the `audit_log` INSERT policy |
| 065_kyc_tokens_rls_split.sql | Split kyc_upload_tokens admin FOR ALL into SELECT + INSERT |
| 066_atomic_interest_rpcs.sql | `apply_late_payment_interest`, `apply_failed_deal_interest` RPCs |
| 067_docusign_webhook_dedup.sql | `docusign_webhook_events` dedup table |
| 068_jsonb_legacy_drop_audit.sql | Verify the JSONB-to-table backfills dropped no financial rows |
| 069_delete_brokerage_atomic.sql | `delete_brokerage_atomic` RPC |
| 070_one_pending_amendment_per_deal.sql | At most one pending closing-date amendment per deal |
| 071_one_active_envelope_per_deal.sql | At most one active envelope per (deal, document_type) |
| 072_lock_down_definer_rpcs.sql | Revoke EXECUTE on definer RPCs from anon + authenticated |
| 073_atomic_balance_helpers.sql | `apply_agent_balance_delta_capped`, `mark_invoice_paid_atomic`; new ledger type |
| 074_cron_idempotency_log.sql | `cron_run_log` idempotency table |
| 075_docusign_linked_by.sql | Track which admin completed DocuSign OAuth link |
| 076_brokerage_contact_email_confirmation.sql | Brokerage contact-email confirmation token |
| 077_append_admin_note_atomic.sql | `append_admin_note` atomic RPC |
| 078_firm_deal_detection.sql | `brokerage_pipes`, `firm_deal_events`, `brokerage_name_mapping` |
| 079_firm_deal_side_tracking.sql | Buy/sell side tracking on firm-deal events |
| 080_firm_deal_magic_links.sql | `firm_deal_magic_links` one-shot login tokens |
| 081_firm_deal_offer_acceptance.sql | `offered` status, `firm_deal_offer` source, offered-lifecycle columns on deals |
| 082_pipe_notification_recipients.sql | Per-pipe offer notification recipients JSONB |
| 083_optimistic_locking.sql | `deals.version` optimistic lock + `assigned_to_user_id` underwriter |
| 084_failed_funding_recovery.sql | `funding_failed` status, funding-failure columns, resubmission lineage |
| 085_early_closing.sql | Early-closing discount refund |
| 086_brokerage_required_fields.sql | Tighten brokerage email + broker-of-record email requirements |
| 087_brokerage_admins_junction.sql | `brokerage_admins` multi-admin junction table |
| 088_cron_email_failures.sql | `cron_email_failures` dead-letter retry queue |
| 089_unique_offered_per_event.sql | Prevent duplicate `offered` deals per (event, agent) |
| 090_unique_remediation_per_failed_deal.sql | Prevent duplicate remediation deals per (failed_deal, property) |
| 091_firm_deal_magic_links_deny_all.sql | Explicit deny-all RLS on `firm_deal_magic_links` |
| 092_unsubscribe_preferences.sql | Email-notification flags + `email_unsubscribe_tokens` |
| 093_remediation_escalation_level.sql | `remediation_deals.escalation_level` for overdue cron |
| 094_active_status_rls_and_storage.sql | Active-status-aware RLS/storage hardening; re-defined helper functions |
| 095_fix_brokerage_admins_recursion.sql | `is_user_brokerage_admin_of` helper; fix 094 policy recursion |
| 096_brokerage_logo_includes_tagline.sql | `logo_includes_tagline` flag on brokerages |
| 096_manual_brokerage_nudge.sql | Track agent-triggered manual brokerage nudges |
| 097_firm_deal_co_agent_split.sql | `firm_deal_events.co_agent_split` flag for delimiter-separated co-agent cells |
| 098_brokerage_admin_sub_roles.sql | Expand `brokerage_admins.role` to broker_of_record / brokerage_manager / brokerage_admin |
| 099_remediation_signed_at.sql | `remediation_deals.signed_at` for Remediation IDP signed flip |
| 100_deals_assigned_at.sql | `deals.assigned_at` timestamp for underwriter assignment |
| 101_agent_kyc_bucket_limits.sql | Size/type limits on the agent KYC storage bucket |
| 102_staff_roles.sql | `user_profiles.staff_role` (owner/manager/staff) for least-privilege internal staff roles; no RLS change |
| 103_impersonation.sql | `impersonation_sessions` table (look-only "view as user"); `audit_log.impersonated_target_id` column. Additive and idempotent; no existing RLS policy changed |
| 104_brokerage_og_image.sql | `brokerages.og_image_url` (PNG of the white-label logo for SMS / social link-preview cards). Additive; nullable |
| 105_agent_self_submit_offer.sql | `deals.agent_self_submit_at` — set when an agent takes an `offered` firm-deal over to submit it themselves (pauses the brokerage on it). Additive; nullable |
| 106_informational_deal_ledger_entries.sql | `deal_advance`/`deal_repayment` ledger types + `record_agent_statement_entry` RPC (balance-neutral statement entries). Additive |
| 107_bca_path_welcome_deposit_auth.sql | `brokerages.bca_signed_pdf_path` (storage path of the signed BCA so it is viewable/downloadable), `user_profiles.welcomed_at` (first-login greeting flag), `agents.deposit_authorized_at` + `agents.deposit_authorized_by` (mandatory deposit-authorization consent during agent onboarding). Additive; all nullable |
| 108_deal_numbers.sql | `deals.deal_number` (UNIQUE, nullable) + `deals.submitted_at`; `deal_number_counters` per-day sequence table (RLS on, no policies); `assign_deal_number()` SECURITY DEFINER trigger function + `trg_assign_deal_number` BEFORE INSERT OR UPDATE OF status trigger; backfill of existing non-offered deals. Additive |

Note: there are two files numbered `008` (`008_underwriting_checklist_cleanup.sql` and `008_audit_fixes.sql`) and two numbered `096` (`096_brokerage_logo_includes_tagline.sql` and `096_manual_brokerage_nudge.sql`). There is no `001`, `002`, or `097`-as-a-single-file gap beyond what is noted: the base tables predate migration tracking, and `097_firm_deal_co_agent_split.sql` exists and sets `firm_deal_events.co_agent_split` true when two enrolled agents appear in one delimiter-separated cell.
