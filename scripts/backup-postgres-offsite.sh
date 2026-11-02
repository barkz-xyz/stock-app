#!/usr/bin/env bash
set -euo pipefail
umask 077

# Read credentials from a protected environment file or the scheduler's secret
# environment. Never enable shell tracing, embed credentials in URLs passed to
# commands, or store the age private identity on this backup worker.
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] || fail 'BACKUP_AGE_RECIPIENT must contain the age public recipient.'
[[ "${BACKUP_REMOTE:-}" =~ ^[A-Za-z0-9_-]+:[^[:cntrl:]?]+$ && "${BACKUP_REMOTE:-}" != *"://"* ]] || fail 'BACKUP_REMOTE must be a named rclone remote and directory, without query credentials.'
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_binary="${NODE_PATH_EXECUTABLE:-node}"
age_binary="${AGE_PATH:-age}"
rclone_binary="${RCLONE_PATH:-rclone}"

metadata="$("$node_binary" "$script_directory/backup-postgres.js")"
archive="$(printf '%s' "$metadata" | "$node_binary" --input-type=module -e 'let text=""; for await (const chunk of process.stdin) text+=chunk; console.log(JSON.parse(text).file)')"
backup_directory="$(dirname -- "$archive")"
base="$(basename -- "$archive")"
sealed="$(mktemp "$archive.XXXXXX.tar.age")"
complete=false
cleanup() { if [[ "$complete" != true ]]; then rm -f -- "$sealed"; fi; }
trap cleanup EXIT

# Only the public recipient appears in argv. Pipeline failures fail the run.
if ! tar -C "$backup_directory" -cf - "$base" "$base.sha256" "$base.manifest.json" 2>/dev/null |
  "$age_binary" --encrypt --recipient "$BACKUP_AGE_RECIPIENT" > "$sealed" 2>/dev/null; then
  fail 'Backup encryption failed; the protected local database archive was retained.'
fi
sealed_base="$(basename -- "$sealed")"
remote_directory="${BACKUP_REMOTE%/}"
if ! "$rclone_binary" copyto "$sealed" "$remote_directory/$sealed_base" --immutable >/dev/null 2>&1; then
  fail 'Encrypted backup upload failed; the protected local database archive was retained.'
fi
# --download verifies actual remote bytes even without a shared hash algorithm.
if ! "$rclone_binary" check "$backup_directory" "$remote_directory" --include "/$sealed_base" --one-way --download >/dev/null 2>&1; then
  fail 'Uploaded backup verification failed; the run did not complete successfully.'
fi
complete=true
printf '%s\n' 'Encrypted offsite backup uploaded and verified.'
