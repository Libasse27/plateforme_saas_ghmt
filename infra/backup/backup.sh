#!/usr/bin/env bash
# Sauvegarde logique quotidienne (docs/13 D9, §6.1) : pg_dump -Fc avec le rôle ghmt_backup (BYPASSRLS, lecture seule),
# chiffrée pour la clé publique age, déposée dans un bucket à verrouillage d'objet avec un manifeste (taille, SHA-256,
# comptage de chaque table dans le MÊME instantané que le dump, rôles référencés).
#
# Entrées (secrets par fichier, jamais en clair dans l'environnement du compose) :
#   BACKUP_DATABASE_URL_FILE           postgresql://ghmt_backup:…@hôte:port/base?sslmode=…
#   BACKUP_AGE_RECIPIENT_FILE          clé publique age (age1…) ; la clé privée reste hors ligne
#   BACKUP_S3_ACCESS_KEY_ID_FILE, BACKUP_S3_SECRET_ACCESS_KEY_FILE   identifiants dédiés (écriture seule si possible)
#   BACKUP_BUCKET, BACKUP_S3_ENDPOINT, BACKUP_S3_REGION (us-east-1), BACKUP_S3_FORCE_PATH_STYLE (true)
#   BACKUP_LOCK_MODE (COMPLIANCE | GOVERNANCE | none), BACKUP_DAILY_RETENTION_DAYS (35), BACKUP_MONTHLY_RETENTION_DAYS (366)
#   BACKUP_METRICS_DIR (facultatif) : fichiers .prom pour le collecteur textfile de node_exporter
# Sortie : une ligne JSON { status, key, bytes, sha256, durationMs } ; code non nul en cas d'échec ({ status: "error", stage }).
set -Eeuo pipefail

TOOLS_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib.sh
. "$TOOLS_DIR/lib.sh"

readonly SNAPSHOT_TIMEOUT_S=60
START_MS="$(now_ms)"
STAGE=configuration
WORK_DIR=""

# Résultat de la dernière exécution (1 réussite, 0 échec) ; le fichier « success » n'est écrit qu'en cas de réussite.
write_run_metrics() {
  write_metrics ghmt_backup_run.prom "$(
    gauge ghmt_backup_last_run_timestamp_seconds 'Horodatage de la dernière exécution de backup.sh.' "$(date +%s)"
    gauge ghmt_backup_last_run_success '1 si la dernière exécution de backup.sh a réussi.' "$1"
  )"
}

on_error() {
  trap - ERR
  local duration=$(( $(now_ms) - START_MS ))
  log "échec de la sauvegarde à l'étape « ${STAGE} »"
  write_run_metrics 0 || true
  jq -cn --arg stage "$STAGE" --argjson durationMs "$duration" '{ status: "error", stage: $stage, durationMs: $durationMs }'
  exit 1
}
cleanup() {
  if [ -n "${PSQL_PID:-}" ]; then kill "$PSQL_PID" 2> /dev/null || true; fi
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
}
trap on_error ERR
trap cleanup EXIT

make_work_dir
load_secret BACKUP_DATABASE_URL
load_secret BACKUP_AGE_RECIPIENT
require_vars BACKUP_DATABASE_URL BACKUP_AGE_RECIPIENT
if [[ ! "$BACKUP_AGE_RECIPIENT" =~ ^age1[0-9a-z]{58}$ ]]; then log "BACKUP_AGE_RECIPIENT n'est pas une clé publique age (age1…)"; false; fi
lock_mode="${BACKUP_LOCK_MODE:-COMPLIANCE}"
case "$lock_mode" in COMPLIANCE | GOVERNANCE | none) ;; *) log "BACKUP_LOCK_MODE invalide : ${lock_mode}"; false ;; esac
setup_s3
export_pg_env_from_url "$BACKUP_DATABASE_URL"
unset BACKUP_DATABASE_URL

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
key="${BACKUP_PREFIX}${stamp:0:4}/${stamp:4:2}/${stamp:6:2}/ghmt-${stamp}.dump.age"
manifest_key="$(manifest_key_for "$key")"

# 1. Instantané exporté : comptages, rôles et pg_dump voient exactement les mêmes données.
STAGE=snapshot
coproc PSQL { psql -X -q -A -t -v ON_ERROR_STOP=1 --no-password 2>&1; }
psql_line() { # requête (une ligne de résultat attendue)
  printf '%s\n' "$1" >&"${PSQL[1]}"
  local line
  IFS= read -r -t "$SNAPSHOT_TIMEOUT_S" line <&"${PSQL[0]}" || { log "pas de réponse de PostgreSQL"; return 1; }
  if [[ "$line" == psql:* || "$line" == ERROR:* ]]; then log "erreur PostgreSQL pendant l'instantané"; return 1; fi
  printf '%s' "$line"
}
psql_line "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" > "$WORK_DIR/snapshot"
snapshot="$(cat "$WORK_DIR/snapshot")"
[[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || { log "identifiant d'instantané inattendu"; false; }
counts="$(psql_line "$(count_tables_sql | tr '\n' ' ')")"
roles="$(psql_line "$(referenced_roles_sql | tr '\n' ' ')")"
server_version="$(psql_line "SHOW server_version_num;")"
jq -e 'type == "object"' <<< "$counts" > /dev/null
jq -e 'type == "array"' <<< "$roles" > /dev/null

# 2. Dump au format custom, chiffré à la volée : aucun octet en clair n'est écrit sur disque.
STAGE=dump
pg_dump -Fc --no-password --snapshot="$snapshot" | age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK_DIR/dump.age"
printf 'COMMIT;\n' >&"${PSQL[1]}"
# Fin de l'entrée de psql (descripteur numérique du coprocessus).
eval "exec ${PSQL[1]}>&-"
wait "$PSQL_PID" 2> /dev/null || true
PSQL_PID=""

bytes="$(stat -c %s "$WORK_DIR/dump.age")"
sha256="$(sha256_hex "$WORK_DIR/dump.age")"
jq -n --arg key "$key" --argjson bytes "$bytes" --arg sha256 "$sha256" --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg database "$PGDATABASE" --arg serverVersionNum "$server_version" --arg pgDump "$(pg_dump --version)" \
  --argjson counts "$counts" --argjson roles "$roles" \
  '{ format: 1, key: $key, bytes: $bytes, sha256: $sha256, createdAt: $createdAt, database: $database,
     serverVersionNum: $serverVersionNum, pgDump: $pgDump, counts: $counts, roles: $roles }' > "$WORK_DIR/manifest.json"

# 3. Dépôt : verrouillage d'objet (35 jours, 366 jours pour la première sauvegarde réussie du mois), empreinte SHA-256 vérifiée
#    par le stockage (x-amz-checksum-sha256) et conservée en métadonnée.
STAGE=upload
lock_args=()
if [ "$lock_mode" != "none" ]; then
  days="${BACKUP_DAILY_RETENTION_DAYS:-35}"
  # « Mensuelle » : la PREMIÈRE sauvegarde réussie du mois (pas celle du 1er, qui peut avoir échoué). Si le listage est
  # refusé, on suppose qu'aucune n'existe : verrouillage long, jamais plus court que prévu.
  month_status=0
  month_has_successful_backup "$(backup_month_prefix "$stamp")" || month_status=$?
  case "$month_status" in
    0) ;;
    1) days="${BACKUP_MONTHLY_RETENTION_DAYS:-366}"; log "première sauvegarde du mois : verrouillée ${days} jours" ;;
    *) days="${BACKUP_MONTHLY_RETENTION_DAYS:-366}"; log "listage du mois impossible (droit ListBucket ?) : verrouillée ${days} jours par précaution" ;;
  esac
  lock_args=(--object-lock-mode "$lock_mode" --object-lock-retain-until-date "$(date -u -d "+${days} days" +%Y-%m-%dT%H:%M:%SZ)")
fi
put_object() { # fichier, clé, type
  local checksum
  checksum="$(sha256_base64 "$1")"
  s3api put-object --bucket "$BACKUP_BUCKET" --key "$2" --body "$1" --content-type "$3" \
    --checksum-algorithm SHA256 --checksum-sha256 "$checksum" --metadata "sha256=$(sha256_hex "$1")" \
    "${lock_args[@]}" --output json > /dev/null
}
put_object "$WORK_DIR/dump.age" "$key" application/octet-stream
put_object "$WORK_DIR/manifest.json" "$manifest_key" application/json
remote_bytes="$(s3api head-object --bucket "$BACKUP_BUCKET" --key "$key" --output json | jq -r '.ContentLength')"
[ "$remote_bytes" = "$bytes" ] || { log "taille de l'objet déposé inattendue"; false; }

duration=$(( $(now_ms) - START_MS ))
write_metrics ghmt_backup_success.prom "$(
  gauge ghmt_backup_last_success_timestamp_seconds 'Horodatage de la dernière sauvegarde réussie.' "$(date +%s)"
  gauge ghmt_backup_last_success_bytes 'Taille de la dernière sauvegarde chiffrée.' "$bytes"
  gauge ghmt_backup_last_success_duration_seconds 'Durée de la dernière sauvegarde réussie.' "$((duration / 1000))"
)"
write_run_metrics 1
log "sauvegarde déposée (${bytes} octets)"
jq -cn --arg key "$key" --argjson bytes "$bytes" --arg sha256 "$sha256" --argjson durationMs "$duration" \
  '{ status: "ok", key: $key, bytes: $bytes, sha256: $sha256, durationMs: $durationMs }'
