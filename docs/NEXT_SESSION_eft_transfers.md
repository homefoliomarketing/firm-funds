# Next Session: eft_transfers JSONB → real table

## Why this exists

Firm Funds tracks outbound EFT transfers (the wires Bud sends out to fund a
deal) in `deals.eft_transfers`, a JSONB array. The session 9 audit found
the same race pattern that already broke `brokerage_payments` in session 7
before we migrated that to a real table:

`recordEftTransfer`, `confirmEftTransfer`, and `removeEftTransfer` all read
the JSONB array, mutate it in JavaScript, and write the whole array back.
Two admins (or one admin with two browser tabs) recording transfers
concurrently both read `[a, b]`, both compute `[a, b, c]` vs `[a, b, d]`,
and the last writer wins, one transfer disappears silently. Worse,
`confirmEftTransfer` and `removeEftTransfer` index into the array by
integer position, so a concurrent insert + confirm at the same time can
confirm or delete a row the admin did not intend.

`removeEftTransfer` is already tagged `severity: 'critical'` in its own
audit-log call. That tag exists because Bud already knew this code is
risky. We are doing the same fix we did for `brokerage_payments`: convert
it to a real table with stable UUIDs.

The precedent migration is
[supabase/migrations/055_brokerage_payments_table.sql](../supabase/migrations/055_brokerage_payments_table.sql).
Copy the structure.

## What to build

### 1. Migration 058: `eft_transfers` table

Skeleton (mirror migration 055):

```sql
CREATE TABLE IF NOT EXISTS eft_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0 AND amount <= 25000),
  transfer_date DATE NOT NULL,
  reference TEXT,
  confirmed BOOLEAN NOT NULL DEFAULT false,
  confirmed_at TIMESTAMPTZ,
  confirmed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recorded_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX eft_transfers_deal_id_idx ON eft_transfers(deal_id);
```

Backfill from `deals.eft_transfers`:

```sql
INSERT INTO eft_transfers (deal_id, amount, transfer_date, reference, confirmed, recorded_at)
SELECT
  d.id,
  COALESCE((t->>'amount')::numeric, 0),
  COALESCE((t->>'date')::date, CURRENT_DATE),
  NULLIF(t->>'reference', ''),
  COALESCE((t->>'confirmed')::boolean, false),
  d.updated_at
FROM deals d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.eft_transfers, '[]'::jsonb)) AS t;
```

Rename the JSONB column to `eft_transfers_legacy_jsonb` (rollback safety
net, same pattern session 7 used for `brokerage_payments`). Don't drop it.

Enable RLS and add an admin-only policy mirroring the
`brokerage_payments_admin_select` / `brokerage_payments_admin_insert` /
`brokerage_payments_admin_update` / `brokerage_payments_admin_delete`
pattern from migration 055. EFT transfers are admin-only, no agent or
brokerage RLS needed.

`pg_dump`-friendly tip: this migration has multiple statements, so it
cannot run via `npx supabase db query -f file.sql`. Use the pg client
pattern documented in `docs/REMEDIATION_PLAN.md` (or `scripts/backup-db.mjs`
as a starting point), open a connection, `BEGIN`, run the SQL, `COMMIT`.

### 2. Rewrite the three actions in `lib/actions/admin-actions.ts`

Currently at lines 1696–1850. Replace each with a real-table call:

- `recordEftTransfer({ dealId, amount, date, reference })`:
  `INSERT INTO eft_transfers (deal_id, amount, transfer_date, reference, recorded_by_user_id)`
  returning the inserted row.
- `confirmEftTransfer({ transferId })`:
  `UPDATE eft_transfers SET confirmed = true, confirmed_at = now(), confirmed_by_user_id = $1 WHERE id = $2 AND confirmed = false`
  using `.select().maybeSingle()` so a 0-row result returns a clean
  "already confirmed" error (same CAS guard pattern as the amendment
  approve fix in session 9).
- `removeEftTransfer({ transferId })`:
  `DELETE FROM eft_transfers WHERE id = $1` (use UUID, not integer index).
  Audit log keeps the row contents via a SELECT-then-DELETE if you want
  the metadata preserved in `audit_log.metadata`, otherwise just log the
  ID.

Keep the `severity: 'critical'` tags on confirm/remove and add one to
`record` too (the auditor pointed out it was missing).

Keep the `$25,000 per-day` cap. The check can stay in JS for clear error
messages, but mirror it in the DB CHECK constraint as belt-and-suspenders
(it's in the skeleton above).

### 3. Update the readers

- `types/database.ts:149`: replace `eft_transfers: EftTransfer[] | null` on
  the `Deal` interface. EFT transfers are no longer embedded on the deal;
  they are a separate row set. Either delete the field and have the admin
  deal page query `eft_transfers` separately, or expose them through an
  embed: `.select('*, eft_transfers(*)')`. The embed is fewer code
  changes.
- `app/(dashboard)/admin/deals/[id]/page.tsx` lines 352, 1732, 1737,
  1756, 1758: update to expect the embedded row shape (`{ id,
  transfer_date, amount, confirmed, reference }`) and key the React
  `<li>` / `<tr>` elements on `eft.id`, not the array index. The "confirm"
  and "remove" buttons should pass `eft.id` to the actions instead of the
  loop index.

### 4. Verification before pushing

- Reconciliation drift = 0 against agents (run the SQL in `CLAUDE.md`).
- `npx tsc --noEmit` clean.
- `next build` clean (Netlify TS is stricter than tsc, careful with
  null checks on the new embed).
- Manually confirm via the admin UI: record an EFT, confirm it, remove
  it. Each step should round-trip correctly and show in the audit log.
- After the migration is applied, query: `SELECT COUNT(*) FROM eft_transfers`
  should equal the count of array elements summed across
  `deals.eft_transfers_legacy_jsonb`. If they match, the backfill worked.

### 5. Pre-session housekeeping

```bash
# Take a snapshot first, financial code, take no chances.
node scripts/backup-db.mjs --label pre-session-N-eft-transfers
```

Branch off `main` (currently at session 9 commit `24ac915`). Match the
existing branch pattern: `claude/<some-name>` is fine.

## Why this matters for launch

EFT transfers are how Bud actually moves money to the agent. If a confirm
race silently flips the wrong transfer's `confirmed` flag, an unconfirmed
transfer reads as paid in admin UIs, Bud thinks he sent the wire when he
didn't. Or vice versa: a confirmed transfer reads as unsent and gets sent
twice. Either is a real-money loss.

This is a launch blocker for any meaningful concurrent admin activity. At
current 0-deal volume it doesn't matter; at 50 funded deals with two
admins it's a guaranteed disaster within a month.

## What's NOT in scope for this session

- Don't touch the funded-deal amendment fee math. Session 9 already
  rewrote that.
- Don't drop the `eft_transfers_legacy_jsonb` column, leave it as
  rollback safety net. A separate migration can drop it after we've
  verified the table is the source of truth in production for a few
  weeks.
- Don't refactor the related `brokerage_payments` code; that's already
  done (migration 055).
