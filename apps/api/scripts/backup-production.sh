#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# backup-production.sh — Railway production database backup
#
# Usage:
#   ./apps/api/scripts/backup-production.sh
#   ./apps/api/scripts/backup-production.sh pre-google-auth-migration
#
# The optional argument is a label appended to the filename so you know
# what triggered the backup:
#   production_20260410_143000_pre-google-auth-migration.sql
#
# Prerequisites:
#   - Railway CLI installed: npm install -g @railway/cli
#   - Logged in: railway login
#   - Linked to project: railway link  (run once per machine)
#   - pg_dump available: usually ships with Postgres client tools
#
# Backups are saved to ./backups/ (gitignored — never committed).
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

LABEL="${1:-manual}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="$(git rev-parse --show-toplevel)/backups"
BACKUP_FILE="${BACKUP_DIR}/production_${TIMESTAMP}_${LABEL}.sql"

mkdir -p "$BACKUP_DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RouteFlow — Production Database Backup"
echo "  File:  $BACKUP_FILE"
echo "  Label: $LABEL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Use Railway CLI to run pg_dump inside the Railway environment
# (the DATABASE_URL is never exposed to your shell)
railway run pg_dump --no-password --format=plain --no-acl --no-owner > "$BACKUP_FILE"

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
LINES=$(wc -l < "$BACKUP_FILE")

echo ""
echo "✔ Backup complete"
echo "  Size:  $SIZE"
echo "  Lines: $LINES"
echo "  Path:  $BACKUP_FILE"
echo ""
echo "  To restore:"
echo "  railway run psql < $BACKUP_FILE"
echo ""

# Sanity check — a real backup should have at least a few hundred lines
if [ "$LINES" -lt 100 ]; then
  echo "⚠ WARNING: Backup file has fewer than 100 lines — it may be empty or corrupted."
  echo "  Open $BACKUP_FILE and verify it contains actual SQL before relying on it."
fi
