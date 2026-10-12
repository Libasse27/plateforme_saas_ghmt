#!/usr/bin/env bash
# Fonctions communes des scripts de sauvegarde (docs/13 §6.1). Sourcé, jamais exécuté seul.
# Règles : aucun secret ni chaîne de connexion n'est affiché ; les secrets sont lus depuis des fichiers (NOM_FILE),
# comme infra/deploy/entrypoint-secrets.sh ; les messages de diagnostic vont sur stderr, la sortie standard ne porte
# que la ligne (ou le rapport) JSON.

# Préfixe des objets de sauvegarde dans le bucket.
readonly BACKUP_PREFIX="postgres/"
# Schémas applicatifs comptés et vérifiés.
readonly APP_SCHEMAS_SQL="'platform', 'tenant', 'public'"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

now_ms() { date +%s%3N; }

# Charge NOM depuis NOM_FILE si NOM_FILE est défini (le fichier doit être lisible). Ne l'affiche jamais.
load_secret() {
  local name="$1" file_var="${1}_FILE"
  local file="${!file_var:-}"
  if [ -n "$file" ]; then
    if [ ! -r "$file" ]; then
      log "secret illisible pour ${name} (${file_var})"
      return 1
    fi
    # Le contenu est retiré de son saut de ligne final ; la valeur reste hors de toute sortie.
    printf -v "$name" '%s' "$(cat "$file")"
    export "${name?}"
  fi
}

# Échoue si l'une des variables est vide (le nom seulement est affiché).
require_vars() {
  local missing=() name
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    log "variables manquantes : ${missing[*]}"
    return 1
  fi
}

# Décodage « pour cent » d'un composant d'URL (identifiant, mot de passe, nom de base). Seules les séquences %XX sont
# décodées : un antislash, un « % » isolé ou incomplet d'un mot de passe restent littéraux (jamais interprétés par printf).
url_decode() {
  local rest="$1" decoded="" octet
  while [[ "$rest" =~ ^([^%]*)%([0-9A-Fa-f]{2})(.*)$ ]]; do
    # Le format de printf n'est composé que d'un antislash, de « x » et de deux chiffres hexadécimaux validés ci-dessus.
    printf -v octet '\\x%s' "${BASH_REMATCH[2]}"
    printf -v octet "$octet"
    decoded+="${BASH_REMATCH[1]}${octet}"
    rest="${BASH_REMATCH[3]}"
  done
  printf '%s' "${decoded}${rest}"
}

# Exporte les variables libpq (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE…) depuis une URL
# postgresql://utilisateur:motdepasse@hôte:port/base?sslmode=… : la chaîne de connexion n'apparaît jamais en argument
# de commande (liste des processus) ni dans les journaux.
export_pg_env_from_url() {
  local url="$1" auth hostport query pair key value
  if [[ ! "$url" =~ ^postgres(ql)?://([^@/]*)@([^/?]+)(/([^?]*))?(\?(.*))?$ ]]; then
    log "chaîne de connexion PostgreSQL invalide (format attendu : postgresql://utilisateur:motdepasse@hôte:port/base)"
    return 1
  fi
  auth="${BASH_REMATCH[2]}" hostport="${BASH_REMATCH[3]}" query="${BASH_REMATCH[7]}"
  export PGDATABASE PGUSER PGHOST PGPORT
  PGDATABASE="$(url_decode "${BASH_REMATCH[5]}")"
  PGUSER="$(url_decode "${auth%%:*}")"
  if [[ "$auth" == *:* ]]; then export PGPASSWORD; PGPASSWORD="$(url_decode "${auth#*:}")"; fi
  if [[ "$hostport" == *:* ]]; then PGHOST="${hostport%:*}" PGPORT="${hostport##*:}"; else PGHOST="$hostport" PGPORT=5432; fi
  local IFS='&'
  for pair in $query; do
    key="${pair%%=*}" value="$(url_decode "${pair#*=}")"
    case "$key" in
      sslmode) export PGSSLMODE="$value" ;;
      sslrootcert) export PGSSLROOTCERT="$value" ;;
      connect_timeout) export PGCONNECT_TIMEOUT="$value" ;;
      application_name) export PGAPPNAME="$value" ;;
    esac
  done
}

# Configure le client S3 (aws-cli) à partir des variables BACKUP_S3_* ; identifiants distincts de ceux de l'application.
setup_s3() {
  load_secret BACKUP_S3_ACCESS_KEY_ID
  load_secret BACKUP_S3_SECRET_ACCESS_KEY
  require_vars BACKUP_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
  export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
  export AWS_EC2_METADATA_DISABLED=true AWS_PAGER="" AWS_SHARED_CREDENTIALS_FILE=/dev/null
  # Style « path » (SeaweedFS, la plupart des fournisseurs compatibles) sauf BACKUP_S3_FORCE_PATH_STYLE=false.
  local style=virtual
  if [ "${BACKUP_S3_FORCE_PATH_STYLE:-true}" = "true" ]; then style=path; fi
  printf '[default]\ns3 =\n  addressing_style = %s\n' "$style" > "$WORK_DIR/aws-config"
  export AWS_CONFIG_FILE="$WORK_DIR/aws-config"
  S3_ENDPOINT_ARGS=()
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then S3_ENDPOINT_ARGS=(--endpoint-url "$BACKUP_S3_ENDPOINT"); fi
  return 0
}

# aws s3api avec l'endpoint configuré ; la sortie d'erreur d'aws-cli ne contient jamais les identifiants.
s3api() { aws "${S3_ENDPOINT_ARGS[@]}" s3api "$@"; }

# Clé de la sauvegarde la plus récente (les clés horodatées se trient chronologiquement), vide si aucune.
latest_backup_key() {
  s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix "$BACKUP_PREFIX" --output json \
    | jq -r '[.Contents[]?.Key | select(endswith(".dump.age"))] | sort | last // empty'
}

# Manifeste associé à une sauvegarde : même nom, suffixe .manifest.json.
manifest_key_for() { printf '%s' "${1%.dump.age}.manifest.json"; }

# Crée le répertoire de travail privé (0700) ; l'appelant le supprime à la sortie (il peut contenir des données).
make_work_dir() {
  umask 077
  WORK_DIR="$(mktemp -d "${BACKUP_WORK_DIR:-/tmp}/ghmt-backup.XXXXXX")"
  export WORK_DIR
}

# Supprime tout répertoire de travail résiduel de BACKUP_WORK_DIR (ghmt-backup.*) : après un SIGKILL ou un redémarrage
# du conteneur, `cleanup` n'a pas tourné et un pgdata restauré (copie en clair des données) y subsisterait. À appeler
# AVANT make_work_dir ; une seule exécution à la fois par volume de travail.
purge_stale_work_dirs() {
  local dir="${BACKUP_WORK_DIR:-/tmp}" stale
  while IFS= read -r -d '' stale; do
    log "répertoire de travail résiduel supprimé : $(basename "$stale")"
    rm -rf "$stale"
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -name 'ghmt-backup.*' -print0 2> /dev/null)
}

# Préfixe du bucket des sauvegardes d'un mois, depuis un horodatage aaaammjjThhmmssZ : postgres/aaaa/mm/.
backup_month_prefix() { printf '%s%s/%s/' "$BACKUP_PREFIX" "${1:0:4}" "${1:4:2}"; }

# Vrai (0) si une sauvegarde RÉUSSIE existe déjà dans ce préfixe de mois : le manifeste est déposé en dernier, il sert de
# preuve de réussite (un dump sans manifeste est une tentative échouée). Code 2 si le listage échoue (droit manquant).
month_has_successful_backup() { # préfixe de mois
  local listing
  listing="$(s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix "$1" --output json 2> /dev/null)" || return 2
  jq -e '[.Contents[]?.Key | select(endswith(".manifest.json"))] | length > 0' <<< "$listing" > /dev/null
}

# Écrit, de façon atomique, un fichier texte Prometheus (collecteur « textfile » de node_exporter) si
# BACKUP_METRICS_DIR est défini : alertes « sauvegarde absente » et « test de restauration en échec » (D12).
write_metrics() { # nom du fichier, contenu
  [ -n "${BACKUP_METRICS_DIR:-}" ] || return 0
  local target="$BACKUP_METRICS_DIR/$1" tmp
  tmp="$(mktemp "$BACKUP_METRICS_DIR/.$1.XXXXXX")"
  printf '%s\n' "$2" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$target"
}

# Une jauge au format texte de Prometheus : nom, aide, valeur.
gauge() { printf '# HELP %s %s\n# TYPE %s gauge\n%s %s\n' "$1" "$2" "$1" "$1" "$3"; }

# Empreinte SHA-256 d'un fichier : hexadécimale (sha256_hex) ou base64 (sha256_base64, format de x-amz-checksum-sha256).
sha256_hex() { sha256sum "$1" | cut -d' ' -f1; }
sha256_base64() { printf '%b' "$(sha256_hex "$1" | sed 's/../\\x&/g')" | base64; }

# Comptage de toutes les tables des schémas applicatifs, en lecture seule (aucune fonction créée) :
# objet JSON { "schema.table": nombre }. Utilisé à la sauvegarde (même instantané que pg_dump) et après restauration.
count_tables_sql() {
  cat <<SQL
SELECT coalesce(json_object_agg(t.rel, t.n ORDER BY t.rel), '{}'::json)
FROM (
  SELECT format('%s.%s', n.nspname, c.relname) AS rel,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN (${APP_SCHEMAS_SQL}) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
) t;
SQL
}

# Rôles propriétaires ou bénéficiaires de droits sur les objets sauvegardés (hors rôles système et PUBLIC) : ils sont
# recréés (NOLOGIN) dans l'instance jetable pour que la restauration rejoue propriétaires et droits à l'identique.
referenced_roles_sql() {
  cat <<SQL
WITH objs AS (
  SELECT nspowner AS owner, nspacl AS acl FROM pg_namespace WHERE nspname IN (${APP_SCHEMAS_SQL})
  UNION ALL SELECT c.relowner, c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN (${APP_SCHEMAS_SQL})
  UNION ALL SELECT p.proowner, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN (${APP_SCHEMAS_SQL})
  UNION ALL SELECT t.typowner, t.typacl FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname IN (${APP_SCHEMAS_SQL})
  UNION ALL SELECT d.defaclrole, d.defaclacl FROM pg_default_acl d
), ids AS (
  SELECT owner AS oid FROM objs
  UNION SELECT (aclexplode(acl)).grantee FROM objs WHERE acl IS NOT NULL
  UNION SELECT (aclexplode(acl)).grantor FROM objs WHERE acl IS NOT NULL
)
SELECT coalesce(json_agg(r.rolname ORDER BY r.rolname), '[]'::json)
FROM pg_roles r WHERE r.oid IN (SELECT oid FROM ids) AND r.oid >= 16384;
SQL
}
