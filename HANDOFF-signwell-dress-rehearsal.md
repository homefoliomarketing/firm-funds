# HANDOFF — SignWell full dress rehearsal (end-to-end live test)

_Created 2026-06-10. Goal of the next session: run ONE real deal through the live app from "send for signature" to "signed + recorded + brokerage notified" and confirm every leg works in production._

## Current state (already done — do not redo)

SignWell is **LIVE in production** (firmfunds.ca). DocuSign is retained behind a flag.

- Provider flag: `ESIGN_PROVIDER=signwell` is set in the Netlify **production** context. (`getEsignProvider()` in `lib/esign-config.ts`; default is `docusign`.)
- All code is on `main` (commits `8378e98` integration, `d758495` cutover scripts, `d215216` brokerage executed-IDP email). Working tree clean.
- Migration `109_signwell_webhook_events.sql` is **applied** to the DB (dedup table for the webhook).
- Webhook is **registered** with SignWell, callback `https://firmfunds.ca/api/signwell/webhook`, scoped to the "Firm Funds" API App (`api_application_id 045510cd-b609-4c84-88b3-6a752599185c`). The HMAC key is `SIGNWELL_WEBHOOK_ID` (value is in `.env.local` and Netlify prod env, and in memory `project_esign_signwell_pilot.md` — do not paste it into committed files).
- Netlify production context has all 4 SignWell vars: `ESIGN_PROVIDER`, `SIGNWELL_API_KEY`, `SIGNWELL_API_APPLICATION_ID`, `SIGNWELL_WEBHOOK_ID`. NOTE: Netlify env is **per-context** — these live in the `production` context, not the default `dev` context shown by a bare `netlify env:list`. Use `netlify env:list --context production`.

**Already verified (no need to re-test):** the send path through the production client, field placement (one initial on every page + a signature at the end — CPA 8pg, IDP 3pg, BCA 7pg, confirmed via test_mode), the green branding (Bud confirmed in a real branded email), and `tsc --noEmit` clean.

**NOT yet verified (this is the whole point of the dress rehearsal):** a real signature firing the completion webhook + the brokerage executed-IDP email. The code is reviewed and type-checks but has never run against a real `document_completed` event.

Full background: memory file `project_esign_signwell_pilot.md`.

## Success criteria (what the dress rehearsal must confirm)

1. Admin clicks "Send for Signature" on an approved test deal → a SignWell document is created and the agent is emailed.
2. The email is branded (green Firm Funds logo) and the signing screen shows an **initial on every page** and a **signature at the end** of both the CPA and the IDP.
3. The agent signs.
4. The completion webhook fires end-to-end:
   - a row lands in `signwell_webhook_events`,
   - the deal's `esignature_envelopes` rows flip to `status='signed'` with `completed_at`/`agent_signed_at` set,
   - the merged signed PDF is stored in the `deal-documents` bucket, `deal_documents` rows are created, and the underwriting checklist item is checked,
   - the deal shows as signed in the admin app.
5. The **brokerage** (broker of record + brokerage admin email) receives an "Executed Direction to Pay" email **with the signed PDF attached** (`sendBrokerageExecutedIdpNotification` in `lib/email.ts`).

## Setup

**A. Create a controlled test deal.** The earlier test data was wiped; only the Choice Advances brokerage and its ~47 agents remain — **do not** send to real Choice agents. Create a fresh, clearly-fake test brokerage + agent + an `approved` deal:
- Test **agent email** = an inbox Bud can sign from (e.g. homefoliomarketing@gmail.com).
- Test **brokerage `broker_of_record_email`** = an inbox Bud can check for the executed-IDP delivery. It can be the same Gmail (Bud will just receive both the signing email and, after signing, the executed-IDP email). Using a *second* inbox makes the brokerage-delivery proof cleaner if Bud has one.
- Deal `status='approved'` with the usual money/date fields (property_address, net_commission, advance_amount, discount_fee, settlement_period_fee, closing_date, due_date, days_until_closing, brokerage_split_pct, etc.).
- Options to create it: adapt an existing seed script under `scripts/` (e.g. `create-verify-deal.mjs`, `seed-test-data.mjs`), insert via SQL with `node scripts/apply-sql-file.mjs <file.sql>` or `npx supabase db query`, or — most realistic — submit a deal through the app and approve it (this also assigns `deal_number` via the migration-108 trigger). If you insert directly, the contract just prints `deal_number || 'N/A'`, which is harmless for a test.

**B. Send it (the real production path).** Log into firmfunds.ca as admin (credentials in memory `reference_admin_password.md` / `reference_auth_testing.md` — do not paste them anywhere). Open the test deal and click **Send for Signature**. This calls the real `sendForSignature` server action, which now routes through SignWell.

> NOTE: production sends are **not** test_mode — this creates a real SignWell document (1 of the 25 free/month) and a real (legally-formatted) signed PDF. That is intended for a true end-to-end test; the deal itself is fake. If you would rather not spend a real document, you can instead re-run `scripts/verify-signwell-fields.mts` (free, draft+test_mode) for the field check, but that does NOT exercise the webhook or the brokerage email — only a real send does.

## Verify

- **Inbox:** agent receives the branded SignWell email. Open it; confirm initials on every page + signature at the end; sign it.
- **After signing** (allow 1–2 min; SignWell occasionally has a slow send, up to ~10 min — delayed is not failed):
  - `SELECT * FROM signwell_webhook_events ORDER BY received_at DESC LIMIT 5;`
  - `SELECT document_type, status, completed_at, agent_signed_at FROM esignature_envelopes WHERE deal_id = '<deal id>';` (expect `status='signed'`)
  - `SELECT document_type, file_path FROM deal_documents WHERE deal_id = '<deal id>';` (expect the signed PDF rows)
  - Confirm the deal shows signed in the admin app and the signed document is viewable.
  - Confirm the **brokerage inbox** received "Executed Direction to Pay: <address> (<agent>)" with the signed PDF attached.

## Gotchas / troubleshooting

- **Webhook not firing / no `signwell_webhook_events` row:** confirm the route is reachable (`GET https://firmfunds.ca/api/signwell/webhook` returns 405 = deployed). Check Netlify function logs for the SignWell webhook. A 401 means HMAC failed — verify `SIGNWELL_WEBHOOK_ID` in Netlify prod matches the registered hook id (`node scripts/signwell-register-webhook.mjs` lists it). HMAC = HMAC-SHA256, key = the webhook id, message = `` `${event.type}@${event.time}` ``, compared to `event.hash` in the body.
- **Brokerage email didn't arrive:** it's best-effort (logs but never fails the webhook), so check Netlify function logs for "failed to email executed Direction to Pay". Confirm `RESEND_API_KEY` is set in Netlify prod (it is) and the test brokerage actually has a `broker_of_record_email`/`email`. The attachment is the **merged** completed PDF (currently contains both the CPA and IDP — matches the old DocuSign CC; can be narrowed to IDP-only later via `completed_pdf?file_format=zip`).
- **SignWell field parsing is async** — only relevant to the validation scripts (they poll until the parsed-field count stabilizes); the real send/sign flow is unaffected.
- **Rollback** (if anything is wrong): set `ESIGN_PROVIDER=docusign` in the Netlify **production** context (`netlify env:set ESIGN_PROVIDER docusign --context production`) and trigger a redeploy (push any commit). DocuSign is untouched and resumes immediately.

## Key files / scripts

- `lib/signwell.ts` — SignWell API client (send, cancel, completed-pdf, HMAC verify).
- `app/api/signwell/webhook/route.ts` — completion webhook (stores signed PDF, updates DB, emails the brokerage).
- `lib/contract-docx.ts` — provider-aware contract generator (footer `{{initial}}` per page + end `{{signature}}`/`{{autofill_date_signed}}`).
- `lib/actions/esign-actions.ts` — `sendForSignature` / BCA / amendment / remediation send actions (branch on the flag).
- `lib/email.ts` — `sendBrokerageExecutedIdpNotification` (Resend, with PDF attachment).
- `docs/integrations/signwell.md` — full integration doc.
- `scripts/verify-signwell-fields.mts` — free draft+test_mode field validator (no email).
- `scripts/signwell-test-send.mts` — fires a branded test_mode packet to an email.
- `scripts/signwell-register-webhook.mjs` — list/register the webhook.
- `scripts/apply-sql-file.mjs` — run a `.sql` file against the DB.

## Minor open items (not blockers for the rehearsal)

- Send-time (pre-signing) brokerage CC is not implemented — only the post-signing executed-IDP delivery. Add later if Bud wants the brokerage notified when the request goes out.
- Merged completed PDF includes the CPA alongside the IDP (could narrow to IDP-only).
