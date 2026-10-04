#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
output_dir="${BACKUP_OUTPUT:-./backups}"
mkdir -p "$output_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$output_dir/dongi-$stamp.dump.enc"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY -out "$target"
printf '%s\n' "$target"
