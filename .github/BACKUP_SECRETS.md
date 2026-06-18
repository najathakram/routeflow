# GitHub Secrets Required for db-backup.yml

Add these in: **GitHub → Settings → Secrets and variables → Actions → New repository secret**

| Secret name               | Where to get it                                                   | Example                                                         |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `PRODUCTION_DATABASE_URL` | Railway dashboard → Postgres service → Variables → `DATABASE_URL` | `postgresql://user:pass@gondola.proxy.rlwy.net:41006/routeflow` |
| `R2_ACCOUNT_ID`           | Cloudflare dashboard → R2 → Account ID (top right)                | `abc123def456`                                                  |
| `R2_ACCESS_KEY_ID`        | Cloudflare → R2 → Manage API tokens → Create token                | `abc...`                                                        |
| `R2_SECRET_ACCESS_KEY`    | Same token creation step (shown once only)                        | `xyz...`                                                        |
| `R2_BACKUP_BUCKET`        | Create a dedicated R2 bucket named `routeflow-backups`            | `routeflow-backups`                                             |

## Steps

1. **Create the R2 bucket**: Cloudflare dashboard → R2 → Create bucket → name it `routeflow-backups`

2. **Create an R2 API token**: Cloudflare → R2 → Manage R2 API Tokens → Create API Token
   - Permissions: **Object Read & Write** on `routeflow-backups` bucket only
   - Copy the **Access Key ID** and **Secret Access Key** — shown once

3. **Add all 5 secrets** to GitHub (link above)

4. **Test the workflow**: GitHub → Actions → Production DB Backup → Run workflow → label: `first-test`

   The backup will appear in:
   - Cloudflare R2 → `routeflow-backups` bucket → `db-backups/` folder
   - GitHub Actions → the workflow run → Artifacts section

## Restore procedure

```bash
# Download backup from R2
aws s3 cp s3://routeflow-backups/db-backups/production_YYYYMMDD_HHMMSS_label.sql ./restore.sql \
  --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com

# Restore to Railway (opens a shell — paste the psql command there)
railway connect postgres
# then inside the shell:
# \i /path/to/restore.sql
```
