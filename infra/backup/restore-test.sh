#!/usr/bin/env bash
# Test de restauration automatisé (docs/13 D10, §6.1) : récupère la DERNIÈRE sauvegarde (ou BACKUP_KEY), vérifie son
# intégrité (taille et SHA-256 du manifeste), la déchiffre en flux et la restaure dans une instance PostgreSQL JETABLE
# (initdb dans un répertoire privé, écoute sur 127.0.0.1 seulement, détruite à la fin), puis contrôle :
#   counts      comptage de chaque table identique à celui du manifeste (même instantané que le dump) ;
#   migrations  `prisma migrate status` à jour avec les migrations de l'image ;
#   auditChain  chaîne d'audit de chaque tenant intacte (empreintes recalculées) ;
#   rls         RLS activée ET forcée, avec au moins une politique, sur chaque table du schéma tenant.
#
# Entrées : variables BACKUP_S3_* et BACKUP_BUCKET (comme backup.sh), BACKUP_AGE_IDENTITY_FILE (clé privée age, fichier
# seulement, jamais en argument ni en variable), BACKUP_KEY (facultatif), RESTORE_PG_PORT (54329),
# RESTORE_REPORT_FILE (facultatif, copie du rapport), BACKUP_METRICS_DIR (facultatif).
#
# Isolation (une sauvegarde forgée rejouée par pg_restore en superutilisateur pourrait exécuter du SQL, p. ex. COPY TO
# PROGRAM) : la clé privée age n'est lue qu'à l'étape de déchiffrement (vers un fichier du répertoire de travail 0700) ;
# les secrets S3 sont retirés de l'environnement dès le téléchargement fait ; PostgreSQL et pg_restore démarrent avec un
# environnement VIDÉ (`env -i`, PATH et HOME seulement). Risque résiduel : le serveur jetable tourne sous le même uid que
# ce script, donc un fichier de /run/secrets lisible par cet uid resterait lisible par du SQL forgé. Le conteneur ne
# doit monter aucun autre secret que la clé age et les identifiants de lecture du bucket (README) ; la signature du
# manifeste, qui écartera une sauvegarde forgée, est prévue en P14.
# Un répertoire de travail résiduel (SIGKILL, redémarrage) est purgé au démarrage : une seule exécution à la fois.
# Sortie : rapport JSON { status, backupKey, restoreMs, durationMs, checks } ; code non nul si un contrôle échoue.
set -Eeuo pipefail

TOOLS_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib.sh
. "$TOOLS_DIR/lib.sh"

readonly RESTORE_DB=ghmt_restore
START_MS="$(now_ms)"
STAGE=configuration
WORK_DIR=""
PG_STARTED=""
KEY=""
RESTORE_MS=null
CHECKS='{}'

# Ajoute (ou remplace) le résultat d'un contrôle : nom, objet JSON contenant au moins { ok }.
set_check() { CHECKS="$(jq -c --arg name "$1" --argjson value "$2" '.[$name] = $value' <<< "$CHECKS")"; }

# Rapport final, sur stdout (et RESTORE_REPORT_FILE), et métriques textfile ; code 0 seulement si tout est vert.
finish() { # statut
  trap - ERR
  local status="$1" duration report
  duration=$(( $(now_ms) - START_MS ))
  report="$(jq -cn --arg status "$status" --arg key "$KEY" --arg stage "$STAGE" --argjson restoreMs "$RESTORE_MS" \
    --argjson durationMs "$duration" --argjson checks "$CHECKS" \
    '{ status: $status, backupKey: (if $key == "" then null else $key end), restoreMs: $restoreMs, durationMs: $durationMs, checks: $checks }
     + (if $status == "ok" then {} else { failedStage: $stage } end)')"
  if [ -n "${RESTORE_REPORT_FILE:-}" ]; then printf '%s\n' "$report" > "$RESTORE_REPORT_FILE"; fi
  local success=0
  if [ "$status" = "ok" ]; then success=1; fi
  write_metrics ghmt_restore_test.prom "$(
    gauge ghmt_restore_test_last_run_timestamp_seconds 'Horodatage du dernier test de restauration.' "$(date +%s)"
    gauge ghmt_restore_test_last_run_success '1 si le dernier test de restauration a réussi.' "$success"
    gauge ghmt_restore_test_last_duration_seconds 'Durée totale du dernier test de restauration.' "$((duration / 1000))"
  )" || true
  printf '%s\n' "$report"
  if [ "$status" = "ok" ]; then exit 0; fi
  exit 1
}
on_error() { log "échec du test de restauration à l'étape « ${STAGE} »"; finish failed; }
cleanup() {
  if [ -n "$PG_STARTED" ]; then pg_ctl -D "$WORK_DIR/pgdata" -m immediate -s stop > /dev/null 2>&1 || true; fi
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
}
trap on_error ERR
trap cleanup EXIT

# Environnement des processus qui exécutent le contenu de la sauvegarde : aucune variable héritée (ni AWS_*, ni *_FILE).
clean_env() { env -i "PATH=$PATH" "HOME=$WORK_DIR" "TMPDIR=$WORK_DIR" "$@"; }

# Diagnostic d'un échec de pg_restore SANS valeur de donnée : la première ligne d'erreur, coupée avant le message du
# serveur (`: ERROR:  …` peut citer des valeurs saisies), ne garde que la catégorie et, le cas échéant, le nom de table.
safe_pg_restore_diagnostic() { # fichier
  { grep -m 1 -E '^pg_restore: error' "$1" || true; } \
    | sed -E 's/^pg_restore: error: //; s/: ERROR:.*$//; s/: (FATAL|DETAIL|CONTEXT|LINE|HINT):.*$//' \
    | tr -cd '[:print:]' | head -c 120
}

purge_stale_work_dirs
make_work_dir
if [ -z "${BACKUP_AGE_IDENTITY_FILE:-}" ] || [ ! -r "$BACKUP_AGE_IDENTITY_FILE" ]; then
  log "BACKUP_AGE_IDENTITY_FILE doit désigner le fichier lisible de la clé privée age"
  false
fi
setup_s3

# 1. Dernière sauvegarde et son manifeste.
STAGE=download
KEY="${BACKUP_KEY:-$(latest_backup_key)}"
if [ -z "$KEY" ]; then log "aucune sauvegarde trouvée dans le bucket"; false; fi
s3api get-object --bucket "$BACKUP_BUCKET" --key "$KEY" "$WORK_DIR/dump.age" > /dev/null
s3api get-object --bucket "$BACKUP_BUCKET" --key "$(manifest_key_for "$KEY")" "$WORK_DIR/manifest.json" > /dev/null
jq -e '.format == 1 and (.counts | type == "object") and (.roles | type == "array")' "$WORK_DIR/manifest.json" > /dev/null

# 2. Intégrité : une sauvegarde tronquée ou altérée est refusée avant tout déchiffrement.
STAGE=integrity
bytes="$(stat -c %s "$WORK_DIR/dump.age")"
sha256="$(sha256_hex "$WORK_DIR/dump.age")"
integrity="$(jq -c --arg key "$KEY" --argjson bytes "$bytes" --arg sha256 "$sha256" \
  '{ ok: (.key == $key and .bytes == $bytes and .sha256 == $sha256), bytes: $bytes, expectedBytes: .bytes,
     sha256Match: (.sha256 == $sha256), backupCreatedAt: .createdAt }' "$WORK_DIR/manifest.json")"
set_check integrity "$integrity"
jq -e '.ok' <<< "$integrity" > /dev/null || { log "taille ou empreinte de la sauvegarde différente du manifeste"; false; }

# 3. Déchiffrement : SEULE étape qui lit la clé privée age. Le dump déchiffré va dans le répertoire de travail (0700).
STAGE=decrypt
decrypt_start="$(now_ms)"
if ! age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$WORK_DIR/dump" "$WORK_DIR/dump.age" 2> "$WORK_DIR/age.log"; then
  RESTORE_MS=$(( $(now_ms) - decrypt_start ))
  set_check restore "$(jq -cn --arg age "$(head -n 1 "$WORK_DIR/age.log" | tr -cd '[:print:]' | head -c 200)" '{ ok: false, ageError: $age }')"
  log "déchiffrement en échec"
  false
fi
rm -f "$WORK_DIR/dump.age"
decrypt_ms=$(( $(now_ms) - decrypt_start ))
# Plus aucun secret dans l'environnement du script : ce qui suit exécute du SQL tiré de la sauvegarde.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY \
  BACKUP_S3_ACCESS_KEY_ID_FILE BACKUP_S3_SECRET_ACCESS_KEY_FILE BACKUP_AGE_IDENTITY_FILE

# 4. Instance PostgreSQL jetable (environnement vidé) : répertoire privé, écoute sur 127.0.0.1 seulement, rôles
#    référencés recréés NOLOGIN ; puis restauration (propriétaires et droits rejoués), toute erreur l'arrête.
STAGE=disposable_postgres
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE PGSSLROOTCERT
clean_env initdb -D "$WORK_DIR/pgdata" -U postgres -A trust -E UTF8 --no-sync > "$WORK_DIR/initdb.log" 2>&1
port="${RESTORE_PG_PORT:-54329}"
clean_env pg_ctl -D "$WORK_DIR/pgdata" -l "$WORK_DIR/postgres.log" -w -s \
  -o "-c listen_addresses=127.0.0.1 -p $port -k $WORK_DIR -c fsync=off -c full_page_writes=off -c synchronous_commit=off" start
PG_STARTED=1
export PGHOST="$WORK_DIR" PGPORT="$port" PGUSER=postgres PGDATABASE=postgres
psql -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${RESTORE_DB}" > /dev/null
psql -X -q -v ON_ERROR_STOP=1 -v roles="$(jq -c '.roles' "$WORK_DIR/manifest.json")" > /dev/null <<'SQL'
SELECT format('CREATE ROLE %I NOLOGIN', r) FROM json_array_elements_text(:'roles'::json) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
SQL
export PGDATABASE="$RESTORE_DB"

STAGE=restore
restore_start="$(now_ms)"
if clean_env "PGHOST=$WORK_DIR" "PGPORT=$port" PGUSER=postgres \
  pg_restore --exit-on-error --no-password -d "$RESTORE_DB" "$WORK_DIR/dump" 2> "$WORK_DIR/pg_restore.log"; then
  RESTORE_MS=$(( decrypt_ms + $(now_ms) - restore_start ))
  set_check restore "$(jq -cn --argjson ms "$RESTORE_MS" '{ ok: true, restoreMs: $ms }')"
else
  RESTORE_MS=$(( decrypt_ms + $(now_ms) - restore_start ))
  # Diagnostic borné, sans valeur de donnée : catégorie de l'erreur et nom de table (jamais le message du serveur).
  set_check restore "$(jq -cn --arg pgRestore "$(safe_pg_restore_diagnostic "$WORK_DIR/pg_restore.log")" '{ ok: false, pgRestoreError: $pgRestore }')"
  log "restauration en échec"
  false
fi
rm -f "$WORK_DIR/dump"

# 5. Contrôles de la base restaurée (chacun est consigné, même si un précédent a échoué).
STAGE=checks
all_ok=true
fail_check() { all_ok=false; log "contrôle en échec : $1"; }

actual_counts="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$(count_tables_sql)")"
counts="$(jq -c --argjson actual "$actual_counts" '
  .counts as $expected
  | ([($expected | keys[]), ($actual | keys[])] | unique) as $tables
  | [ $tables[] | select($expected[.] != $actual[.]) | { table: ., expected: $expected[.], actual: $actual[.] } ] as $mismatches
  | { ok: ($mismatches | length == 0), tables: ($tables | length), rows: ([$actual[]] | add // 0), mismatches: $mismatches }' \
  "$WORK_DIR/manifest.json")"
set_check counts "$counts"
jq -e '.ok' <<< "$counts" > /dev/null || fail_check counts

migrations_ok=false
if (cd "$TOOLS_DIR" && RESTORE_DATABASE_URL="postgresql://postgres@127.0.0.1:${port}/${RESTORE_DB}" \
  node_modules/.bin/prisma migrate status > "$WORK_DIR/migrate-status.log" 2>&1); then migrations_ok=true; fi
applied="$(psql -X -q -A -t -c "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" 2> /dev/null || echo 0)"
set_check migrations "$(jq -cn --argjson ok "$migrations_ok" --argjson applied "${applied:-0}" \
  --arg summary "$(grep -m 1 -E 'up to date|not yet been applied|failed|differ' "$WORK_DIR/migrate-status.log" || true)" \
  '{ ok: $ok, applied: $applied, summary: $summary }')"
[ "$migrations_ok" = true ] || fail_check migrations

if chain="$(node "$TOOLS_DIR/verify-audit-chain.mjs" 2> "$WORK_DIR/chain.log")"; then
  chain="$(jq -c '{ ok: (.broken | length == 0) } + .' <<< "$chain")"
else
  chain='{"ok":false,"error":"vérification impossible"}'
fi
set_check auditChain "$chain"
jq -e '.ok' <<< "$chain" > /dev/null || fail_check auditChain

rls="$(psql -X -q -A -t -v ON_ERROR_STOP=1 <<'SQL'
SELECT json_build_object(
  'ok', count(*) FILTER (WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity AND p.n > 0)) = 0 AND count(*) > 0,
  'tables', count(*),
  'violations', coalesce(json_agg(c.relname ORDER BY c.relname) FILTER (WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity AND p.n > 0)), '[]'::json))
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL (SELECT count(*) AS n FROM pg_policy WHERE polrelid = c.oid) p
WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p') AND NOT c.relispartition;
SQL
)"
set_check rls "$rls"
jq -e '.ok' <<< "$rls" > /dev/null || fail_check rls

if [ "$all_ok" = true ]; then
  log "restauration vérifiée (${RESTORE_MS} ms)"
  finish ok
fi
finish failed
