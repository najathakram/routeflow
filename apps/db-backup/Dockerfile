# Production DB backup cron service (Railway).
#
# postgres:17-alpine supplies pg_dump/psql; pg_dump can dump any server major
# <= its own (backup.sh hard-fails with a clear error if the server is ever
# NEWER than the client — bump this base image in that case).
FROM postgres:17-alpine

RUN apk add --no-cache aws-cli bash curl

# Railway builds with the repo root as context (see apps/api/Dockerfile).
COPY apps/db-backup/backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
