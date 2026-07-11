#!/usr/bin/env bash
# RouteFlow production DB backup — runs as a Railway cron service.
#
# MODE=backup (default): pg_dump | gzip → Cloudflare R2 (db-backups/), prune
#   objects older than RETENTION_DAYS, ping the healthchecks.io dead-man's
#   switch. A missed ping (container never ran) or a /fail ping (any step
#   errored) alerts — the exact failure mode that silently killed the old
#   GitHub Actions backup can no longer go unnoticed.
# MODE=verify (monthly cron, second Railway service on this same image):
#   restore the LATEST R2 dump into an ephemeral in-container Postgres and
#   assert row-count floors on core tables. Proves the backups actually restore.
#
# Required env (backup + verify):
#   DATABASE_URL       — ${{ Postgres.DATABASE_URL }} reference var (backup only)
#   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BACKUP_BUCKET
# Optional:
#   HEALTHCHECK_URL    — healthchecks.io ping URL (strongly recommended)
#   BACKUP_LABEL       — filename suffix (default "railway")
#   RETENTION_DAYS     — R2 prune horizon (default 30)
#   MIN_DUMP_LINES     — sanity floor for the dump (default 100)

set -euo pipefail

ping_hc() { # $1 = "" (success) or "/fail"
  if [ -n "${HEALTHCHECK_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}${1}" >/dev/null || true
  fi
}
trap 'echo "[db-backup] FAILED at line $LINENO" >&2; ping_hc /fail' ERR

MODE="${MODE:-backup}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
MIN_DUMP_LINES="${MIN_DUMP_LINES:-100}"

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
BUCKET="$R2_BACKUP_BUCKET"
S3_PREFIX="s3://${BUCKET}/db-backups"

if [ "$MODE" = "backup" ]; then
  : "${DATABASE_URL:?DATABASE_URL is required}"

  # pg_dump refuses servers NEWER than itself — fail with a clear message.
  # (No `| head` in pipelines here: under pipefail, head's early exit SIGPIPEs
  # the producer and trips the ERR trap.)
  SERVER_MAJ=$(psql "$DATABASE_URL" -Atc "SHOW server_version" | cut -d. -f1)
  CLIENT_MAJ=$(pg_dump --version | awk '{print $NF}' | cut -d. -f1)
  if [ "$SERVER_MAJ" -gt "$CLIENT_MAJ" ]; then
    echo "[db-backup] server is PG ${SERVER_MAJ} but pg_dump is ${CLIENT_MAJ} — bump the Dockerfile base image" >&2
    exit 1
  fi

  TS=$(date -u +"%Y%m%d_%H%M%S")
  FILE="/tmp/production_${TS}_${BACKUP_LABEL:-railway}.sql.gz"
  echo "[db-backup] dumping (PG ${SERVER_MAJ}) → ${FILE}"
  pg_dump "$DATABASE_URL" --no-password --format=plain --no-acl --no-owner | gzip >"$FILE"

  gzip -t "$FILE"
  LINES=$(gunzip -c "$FILE" | wc -l)
  echo "[db-backup] $(du -sh "$FILE" | cut -f1) compressed, ${LINES} lines"
  if [ "$LINES" -lt "$MIN_DUMP_LINES" ]; then
    echo "[db-backup] dump has fewer than ${MIN_DUMP_LINES} lines — refusing to upload" >&2
    exit 1
  fi

  aws s3 cp "$FILE" "${S3_PREFIX}/$(basename "$FILE")" --endpoint-url "$ENDPOINT" --no-progress
  echo "[db-backup] uploaded ${S3_PREFIX}/$(basename "$FILE")"

  # Prune objects older than RETENTION_DAYS (by the YYYYMMDD in the filename).
  # `|| true` because grep exits 1 when nothing matches (nothing to prune).
  CUTOFF=$(date -u -d "@$(( $(date -u +%s) - RETENTION_DAYS * 86400 ))" +%Y%m%d)
  KEYS=$(aws s3 ls "${S3_PREFIX}/" --endpoint-url "$ENDPOINT" | awk '{print $4}' | grep "^production_" || true)
  for key in $KEYS; do
    FDATE=$(echo "$key" | grep -oE -m1 "[0-9]{8}" || true)
    if [ -n "$FDATE" ] && [ "$FDATE" -lt "$CUTOFF" ]; then
      echo "[db-backup] pruning ${key}"
      aws s3 rm "${S3_PREFIX}/${key}" --endpoint-url "$ENDPOINT"
    fi
  done

  ping_hc ""
  echo "[db-backup] OK"

elif [ "$MODE" = "verify" ]; then
  # Restore the latest dump into an ephemeral in-container Postgres.
  LATEST=$(aws s3 ls "${S3_PREFIX}/" --endpoint-url "$ENDPOINT" | awk '{print $4}' |
    { grep "^production_" || true; } | sort | tail -1)
  if [ -z "$LATEST" ]; then
    echo "[db-verify] no backups found in ${S3_PREFIX}/" >&2
    exit 1
  fi
  echo "[db-verify] restoring ${LATEST}"
  aws s3 cp "${S3_PREFIX}/${LATEST}" /tmp/latest.sql.gz --endpoint-url "$ENDPOINT" --no-progress
  gzip -t /tmp/latest.sql.gz

  export PGDATA=/tmp/verify-pgdata
  SOCKET_DIR=/var/run/postgresql
  mkdir -p "$PGDATA" && chown -R postgres:postgres "$PGDATA" "$SOCKET_DIR"
  su-exec postgres initdb --auth=trust --username=postgres >/dev/null
  su-exec postgres pg_ctl -D "$PGDATA" -o "-c listen_addresses='' -c unix_socket_directories=${SOCKET_DIR}" -w start >/dev/null
  su-exec postgres createdb -h "$SOCKET_DIR" verifydb
  # --no-owner plain dump; tolerate per-statement noise (missing roles etc.),
  # the row-count floors below are the actual gate.
  gunzip -c /tmp/latest.sql.gz | su-exec postgres psql -h "$SOCKET_DIR" -d verifydb -q >/dev/null 2>&1 || true

  FAIL=0
  for T in Tenant User Order Invoice; do
    COUNT=$(su-exec postgres psql -h "$SOCKET_DIR" -d verifydb -Atc "SELECT count(*) FROM \"$T\"" 2>/dev/null || echo "ERR")
    echo "[db-verify] ${T}: ${COUNT} rows"
    case "$COUNT" in
      ERR | 0) FAIL=1 ;;
    esac
  done
  su-exec postgres pg_ctl -D "$PGDATA" -m immediate stop >/dev/null || true
  if [ "$FAIL" -ne 0 ]; then
    echo "[db-verify] restore verification FAILED — a core table is missing or empty" >&2
    exit 1
  fi

  ping_hc ""
  echo "[db-verify] OK — ${LATEST} restores cleanly"

else
  echo "[db-backup] unknown MODE=${MODE} (expected backup|verify)" >&2
  exit 1
fi
