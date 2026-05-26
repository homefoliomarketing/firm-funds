# Database Restore Runbook

If you are reading this in an emergency, breathe. Snapshots exist. Recovery is procedural.

## TL;DR (the most common case: one table got nuked)

```bash
# 1. Take a safety snapshot of the current (broken) state, in case you need to roll back the restore.
node scripts/backup-db.mjs --label pre-restore-emergency

# 2. Find the most recent good backup.
ls -lt backups/db-*.json.gz | head -5

# 3. Generate a restore SQL file for the affected table.
#    The script REQUIRES --confirm <hostname>, prompts you to re-type the hostname,
#    and on production also requires --i-understand-this-is-production.
TARGET=$(grep '^SUPABASE_DB_URL=' .env.local | cut -d= -f2- | sed -E 's|.*@([^:/]+).*|\1|')
node scripts/restore-db.mjs backups/db-<chosen>.json.gz --table <table_name> \
  --confirm "$TARGET" --i-understand-this-is-production

# 4. READ the generated SQL. Look for surprising INSERTs.
code backups/restore-<table>-<timestamp>.sql

# 5. Apply, one statement at a time if the file is large (Supabase CLI limitation).
DBURL=$(grep '^SUPABASE_DB_URL=' .env.local | cut -d= -f2-)
npx supabase db query --db-url "$DBURL" --file backups/restore-<table>-<timestamp>.sql

# 6. Verify.
npx supabase db query --db-url "$DBURL" "SELECT COUNT(*) FROM <table_name>"
```

## What's in a backup

`backups/db-<label>-<ISO>.json.gz` is a gzipped JSON dump of every row in every table in the `public` schema. Created by `scripts/backup-db.mjs` via the Supabase JS client using the service role key. Schema is not captured (it lives in `supabase/migrations/`).

`backups/db-<label>-<ISO>.rowcounts.txt` is a sidecar with row counts per table for quick sanity-checking.

`backups/backup-log.txt` is the rolling log from `scripts/backup-db.ps1` (the scheduled wrapper).

## Disaster scenarios

### One table corrupted or wiped
Use the TL;DR above. Single-table restore is the safest because it doesn't touch unrelated data.

### Multiple tables wiped (e.g. cascade gone wrong)
Same as TL;DR, but generate the restore for all tables: omit `--table`.

```bash
TARGET=$(grep '^SUPABASE_DB_URL=' .env.local | cut -d= -f2- | sed -E 's|.*@([^:/]+).*|\1|')
node scripts/restore-db.mjs backups/db-<chosen>.json.gz \
  --confirm "$TARGET" --i-understand-this-is-production
```

The generated SQL will TRUNCATE CASCADE every table then re-insert. **Read it carefully.** The `SET session_replication_role = replica` line temporarily disables triggers and FK checks for a clean restore; it is reset to `origin` at the end of the transaction.

The restore script will: (1) require `--confirm <hostname>` matching SUPABASE_DB_URL, (2) print a production warning banner when targeting `bzijzmxhrpiwuhzhbiqc` and require `--i-understand-this-is-production`, (3) interactively prompt you to type the hostname again, then (4) show a summary (tables, rows, mode) and require typing `yes`. Only then is the SQL file written. Nothing connects to the database; apply the SQL yourself with `npx supabase db query`.

### Entire database wiped
1. Recreate the schema by running every migration in `supabase/migrations/` in order. Supabase Dashboard or `npx supabase db push` (if linked).
2. Then run the full restore SQL from above.

### Schema-and-data both wrong (very rare)
Restore from Supabase's built-in point-in-time recovery (PITR). This requires the Pro plan and a retention window of at least 7 days. Confirm in the Supabase dashboard. If PITR is available:
1. Supabase Dashboard → Database → Backups → Restore to point in time.
2. Pick a timestamp before the corruption.
3. Wait for restore (can take minutes to hours).

If PITR is NOT available and the local JSON backups are also unavailable, recovery may be impossible. This is why we run `backup-db.ps1` daily.

## Pre-flight checks before any destructive restore

1. **Make a safety snapshot of current state.** Even if current state is "broken", it captures what the broken state looked like for forensics. `node scripts/backup-db.mjs --label pre-restore-emergency`.
2. **Verify the source backup's integrity.** `node -e "JSON.parse(require('zlib').gunzipSync(require('fs').readFileSync('backups/<file>')))"` should not throw.
3. **Check row counts.** The `.rowcounts.txt` sidecar should match approximately what you expect (compare to a more recent good snapshot or to the rowcounts file from the moment of disaster).
4. **Confirm you're targeting the right DB.** `grep SUPABASE_DB_URL .env.local | head -c 80`. Should match the project you intend to restore.

## What the restore SQL does

`scripts/restore-db.mjs` produces SQL with this structure:
```
BEGIN;
SET session_replication_role = replica;

-- ===== table_name (N rows) =====
TRUNCATE TABLE public.table_name CASCADE;
INSERT INTO public.table_name (cols...) VALUES (...);
INSERT ...

SET session_replication_role = origin;
COMMIT;
```

`session_replication_role = replica` disables triggers and FK checks during the restore so insertion order doesn't matter and the trigger you added in migration 048 (which blocks delete on funded deals) doesn't fire during TRUNCATE. The setting is per-session; it resets at COMMIT.

## After the restore

1. Re-run `npx supabase db query` on a few key tables to confirm counts match expectations.
2. Take a fresh backup labeled `post-restore-<incident>`.
3. Smoke-test the app: log in, view a deal, view the dashboard. If anything looks off, restore again from the safety snapshot you made in step 1 of pre-flight.

## Routine schedule

`backup-db.ps1` should run daily via Windows Task Scheduler. Retention is 14 days locally. Old backups are auto-deleted on each run.

For long-term off-site backup, configure an additional task or copy to S3/R2 weekly. (Not yet set up — see plan doc.)

## Test the restore process at least once before you need it

Right now, in a fresh non-prod database (a temporary Supabase project on the free tier, or local Docker), run:
```bash
node scripts/restore-db.mjs backups/db-pre-remediation-*.json.gz --table agents
```
Apply the resulting SQL. Verify the agents table now contains the 46 rows from the pre-remediation snapshot. Document any quirks here.
