# Production DB backup & restore runbook

Daily `pg_dump` of the production Postgres runs as a **Railway cron service** built from this
directory (schedule `0 2 * * *` UTC — see [`railway.toml`](railway.toml)). Dumps are gzipped and
uploaded to Cloudflare R2 under `db-backups/`, pruned after 30 days. This replaced the GitHub
Actions workflow, which silently failed every day the repo was private ($0 Actions budget).

## Service setup (one-time, Railway dashboard)

1. **New service** in the RouteFlow project → _Deploy from GitHub repo_ → this repo.
   Set **Root Directory** = leave at repo root; Railway picks up `apps/db-backup/railway.toml`
   via **Config-as-code path** = `apps/db-backup/railway.toml` (Settings → Config-as-code).
2. **Variables**:
   - `DATABASE_URL` = `${{ Postgres.DATABASE_URL }}` (reference variable → internal hostname,
     no public proxy needed)
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BACKUP_BUCKET`
     (same values as the old GitHub secrets; use a **bucket-scoped** R2 API token)
   - `HEALTHCHECK_URL` = a [healthchecks.io](https://healthchecks.io) check ping URL
     (free tier; set the check's schedule to `0 2 * * *` with ~2h grace). This is the
     dead-man's switch: it alerts when a backup **fails** _or never runs at all_.
3. **First run**: cron services only run on schedule — trigger one immediately with the
   service's _"Run"_ action (or temporarily set `cronSchedule` to a near-future time), then
   confirm:
   - a `production_<ts>_railway.sql.gz` object appears in R2 `db-backups/`
   - the healthcheck received a ping
4. **After the first verified green run + one verified restore** (below): delete
   `.github/workflows/db-backup.yml` and the now-unused GitHub secrets
   (`PRODUCTION_DATABASE_URL`, `PRODUCTION_DB_PASSWORD` — rotate first, see the
   password-rotation runbook).

## Monthly restore verification (optional second service)

Same image, second Railway cron service with `MODE=verify`, schedule `0 4 1 * *`, its own
`HEALTHCHECK_URL`. It downloads the **latest** dump from R2, restores it into an ephemeral
in-container Postgres, and fails unless `Tenant`, `User`, `Order`, and `Invoice` all restore
with ≥1 row. A backup that doesn't restore is not a backup.

## Restoring a backup

> **Never restore over the production database.** Restore into a scratch DB, inspect, then
> copy forward only what's needed (or promote deliberately, with the team's sign-off).

```bash
# 1. Pick + download a dump (aws CLI with the R2 endpoint)
export AWS_ACCESS_KEY_ID=<R2 key> AWS_SECRET_ACCESS_KEY=<R2 secret> AWS_DEFAULT_REGION=auto
ENDPOINT="https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com"
aws s3 ls s3://<bucket>/db-backups/ --endpoint-url "$ENDPOINT"
aws s3 cp s3://<bucket>/db-backups/production_<ts>.sql.gz . --endpoint-url "$ENDPOINT"

# 2. Restore into a scratch database (local docker or a scratch Railway PG)
gunzip -c production_<ts>.sql.gz | psql "<scratch-database-url>"

# 3. Sanity-check row counts before trusting it
psql "<scratch-database-url>" -c 'SELECT
  (SELECT count(*) FROM "Tenant")  AS tenants,
  (SELECT count(*) FROM "User")    AS users,
  (SELECT count(*) FROM "Order")   AS orders,
  (SELECT count(*) FROM "Invoice") AS invoices;'
```

## Notes

- The dump is `--format=plain --no-acl --no-owner` gzipped SQL — restorable with plain `psql`,
  no `pg_restore` needed.
- `backup.sh` refuses to upload dumps under 100 lines (empty-dump guard) and fails loudly if
  the server's Postgres major ever exceeds the image's `pg_dump` (bump the `Dockerfile` base).
- Manual ad-hoc backup from a workstation still works: `railway run --service postgres node apps/api/scripts/backup-production.mjs <label>` (owner-run; verifies the dump before blessing it).
