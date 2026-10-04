#!/usr/bin/env bash
set -euo pipefail
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required and must point to an empty database}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
backup="${1:?encrypted backup path is required}"
count="$(psql "$RESTORE_DATABASE_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [ "$count" != "0" ]; then printf '%s\n' 'restore target is not empty' >&2; exit 1; fi
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$backup" \
  | pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname "$RESTORE_DATABASE_URL"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT version FROM schema_migrations ORDER BY version"
