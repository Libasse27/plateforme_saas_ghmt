#!/usr/bin/env bash
# Test automatisé de la sauvegarde et de la restauration (docs/13 §11.3, points 2 et 3) contre la pile de développement
# (infra/docker-compose.yml : postgres et s3 démarrés) et la base de TEST désignée par TEST_DATABASE (défaut : celle de
# apps/api/.env.test). Jamais la base de développement `ghmt`.
#   infra/backup/test/roundtrip.sh            (construit l'image ghmt-backup:test, SKIP_BUILD=1 pour la réutiliser)
# Vérifie : ligne JSON de backup.sh, objet chiffré et verrouillé dans le bucket, rapport `ok` de restore-test.sh
# (comptages, migrations, chaîne d'audit, RLS), l'échec (code non nul) sur une sauvegarde tronquée, l'isolation de la
# restauration (sauvegarde forgée exécutant du SQL : environnement de PostgreSQL vide, diagnostic sans valeur, purge des
# répertoires résiduels), la rétention (prune.sh en simulation, première sauvegarde réussie du mois) et lib.sh.
set -Eeuo pipefail

ici="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
racine="$(cd "$ici/../../.." && pwd)"
image="${BACKUP_TEST_IMAGE:-ghmt-backup:test}"
reseau="${BACKUP_TEST_NETWORK:-ghmt_default}"
bucket="ghmt-backup-test-$(date +%s)"
travail="$racine/infra/backup/.work/test-$$"
# Identifiants S3 de DÉVELOPPEMENT (infra/docker-compose.yml) ; mot de passe de dev du rôle (infra/postgres/init/01-roles.sql).
s3_cle="ghmt-dev" s3_secret="ghmt-dev-s3-secret"
base="${TEST_DATABASE:-$(sed -n 's#^DATABASE_URL=.*/\([A-Za-z0-9_]*\)$#\1#p' "$racine/apps/api/.env.test")}"
case "$base" in ghmt_test*) ;; *) echo "Base de test invalide : $base" >&2; exit 2 ;; esac

echo "== 0. lib.sh (tests unitaires)"
bash "$ici/lib.test.sh"

echecs=0
ok() { printf '  ok   %s\n' "$1"; }
ko() { printf '  ÉCHEC %s\n' "$1" >&2; echecs=$((echecs + 1)); }
verifie() { # description, expression jq, JSON
  if jq -e "$2" <<< "$3" > /dev/null; then ok "$1"; else ko "$1 : $3"; fi
}

mkdir -p "$travail"
chmod 700 "$travail"
nettoie() {
  # Les objets sont verrouillés en mode GOVERNANCE pour le test : suppression avec contournement, puis du bucket.
  aws_dev s3api list-object-versions --bucket "$bucket" --output json 2>/dev/null \
    | jq -r '(.Versions // [])[], (.DeleteMarkers // [])[] | "\(.Key)\t\(.VersionId)"' \
    | while IFS=$'\t' read -r cle version; do
        aws_dev s3api delete-object --bucket "$bucket" --key "$cle" --version-id "$version" --bypass-governance-retention > /dev/null 2>&1 || true
      done
  # Un bucket non supprimé garde ses volumes SeaweedFS (nombre limité sur la pile de dev) : le signaler.
  aws_dev s3api delete-bucket --bucket "$bucket" > /dev/null 2>&1 || echo "ATTENTION : bucket $bucket non supprimé" >&2
  rm -rf "$travail"
}
trap nettoie EXIT

# aws-cli de l'image, sur le réseau de la pile de développement (aucun outil installé sur l'hôte). Sans `-i` : appelé
# dans des boucles `while read`, le conteneur ne doit pas consommer l'entrée standard.
aws_dev() {
  docker run --rm --network "$reseau" -e AWS_ACCESS_KEY_ID="$s3_cle" -e AWS_SECRET_ACCESS_KEY="$s3_secret" \
    -e AWS_DEFAULT_REGION=us-east-1 -e AWS_EC2_METADATA_DISABLED=true -v "$travail:/w" -w /w --entrypoint aws "$image" \
    --endpoint-url http://s3:8333 "$@"
}

# Lance un script de l'image avec la configuration de test (durcissement de compose.prod.yml : racine en lecture seule,
# aucune capacité) ; arguments supplémentaires : options docker (-e …). `no-new-privileges` est ajouté par
# BACKUP_TEST_NO_NEW_PRIVILEGES=1 (certains hôtes de développement refusent alors tout exec, y compris l'image node).
lance() { # script, [options docker…]
  local script="$1"; shift
  # shellcheck disable=SC2054 # options de --tmpfs séparées par des virgules
  local durcissement=(--read-only --tmpfs /tmp:rw,size=512m --cap-drop ALL)
  [ "${BACKUP_TEST_NO_NEW_PRIVILEGES:-}" = "1" ] && durcissement+=(--security-opt no-new-privileges:true)
  docker run --rm --network "$reseau" "${durcissement[@]}" \
    -v "$travail/secrets:/run/secrets:ro" \
    -e BACKUP_DATABASE_URL_FILE=/run/secrets/backup_database_url \
    -e BACKUP_AGE_RECIPIENT_FILE=/run/secrets/backup_age_recipient \
    -e BACKUP_S3_ACCESS_KEY_ID_FILE=/run/secrets/backup_s3_access_key_id \
    -e BACKUP_S3_SECRET_ACCESS_KEY_FILE=/run/secrets/backup_s3_secret_access_key \
    -e BACKUP_S3_ENDPOINT=http://s3:8333 -e BACKUP_BUCKET="$bucket" \
    -e BACKUP_LOCK_MODE=GOVERNANCE -e BACKUP_DAILY_RETENTION_DAYS=1 -e BACKUP_MONTHLY_RETENTION_DAYS=1 \
    "$@" "$image" "$script"
}

echo "== Préparation (image $image, base $base, bucket $bucket)"
[ "${SKIP_BUILD:-}" = "1" ] || docker build -q --build-context prisma="$racine/apps/api/prisma" -t "$image" "$racine/infra/backup" > /dev/null
mkdir -p "$travail/secrets"
docker run --rm --entrypoint age-keygen "$image" 2> /dev/null > "$travail/secrets/backup_age_identity"
sed -n 's/^# public key: //p' "$travail/secrets/backup_age_identity" > "$travail/secrets/backup_age_recipient"
printf 'postgresql://ghmt_backup:ghmt_backup_dev@postgres:5432/%s' "$base" > "$travail/secrets/backup_database_url"
printf '%s' "$s3_cle" > "$travail/secrets/backup_s3_access_key_id"
printf '%s' "$s3_secret" > "$travail/secrets/backup_s3_secret_access_key"
chmod 644 "$travail/secrets/"*
aws_dev s3api create-bucket --bucket "$bucket" --object-lock-enabled-for-bucket > /dev/null

echo "== 1. backup.sh"
# Rétentions distinctes (2 j / 40 j) : la première sauvegarde du mois reçoit la rétention « mensuelle ».
sortie="$(lance backup.sh -e BACKUP_DAILY_RETENTION_DAYS=2 -e BACKUP_MONTHLY_RETENTION_DAYS=40)"
verifie "une seule ligne JSON status=ok" '.status == "ok"' "$sortie"
verifie "clé postgres/aaaa/mm/jj/ghmt-<horodatage>.dump.age" '.key | test("^postgres/[0-9]{4}/[0-9]{2}/[0-9]{2}/ghmt-[0-9]{8}T[0-9]{6}Z\\.dump\\.age$")' "$sortie"
verifie "taille, empreinte SHA-256 et durée" '(.bytes > 0) and (.sha256 | test("^[0-9a-f]{64}$")) and (.durationMs >= 0)' "$sortie"
cle="$(jq -r .key <<< "$sortie")"
if grep -q "ghmt_backup_dev" <<< "$sortie"; then ko "la sortie contient un secret"; else ok "aucun secret dans la sortie"; fi

aws_dev s3api get-object --bucket "$bucket" --key "$cle" sauvegarde.age > /dev/null
if head -c 21 "$travail/sauvegarde.age" | grep -q '^age-encryption.org/v1'; then ok "objet chiffré (en-tête age)"; else ko "objet non chiffré"; fi
if grep -qa "PGDMP" "$travail/sauvegarde.age"; then ko "en-tête pg_dump en clair dans l'objet"; else ok "aucun contenu pg_dump en clair"; fi
version="$(aws_dev s3api head-object --bucket "$bucket" --key "$cle" --output json | jq -r '.VersionId')"
retention="$(aws_dev s3api head-object --bucket "$bucket" --key "$cle" --output json | jq -c '{mode: .ObjectLockMode, until: .ObjectLockRetainUntilDate}')"
verifie "verrouillage d'objet posé" '.mode == "GOVERNANCE" and (.until != null)' "$retention"
jours_verrou() { echo $(( ($(date -d "$(jq -r .until <<< "$1")" +%s) - $(date +%s)) / 86400 )); }
jours_1="$(jours_verrou "$retention")"
[ "$jours_1" -ge 39 ] && [ "$jours_1" -le 40 ] && ok "première sauvegarde du mois : verrouillage « mensuel » (${jours_1} j)" || ko "première sauvegarde du mois : verrouillage de ${jours_1} j (attendu 40)"
if aws_dev s3api delete-object --bucket "$bucket" --key "$cle" --version-id "$version" > /dev/null 2>&1; then
  ko "suppression d'une version verrouillée acceptée"
else
  ok "suppression d'une version verrouillée refusée"
fi

echo "== 2. restore-test.sh (dernière sauvegarde)"
# Répertoire de travail persistant (comme le volume restore-work) contenant un résidu d'une exécution tuée.
mkdir -p "$travail/work/ghmt-backup.RESIDU/pgdata" "$travail/work/autre"
touch "$travail/work/ghmt-backup.RESIDU/pgdata/PG_VERSION" "$travail/work/fichier"
chmod -R 777 "$travail/work"
set +e
rapport="$(lance restore-test.sh -e BACKUP_AGE_IDENTITY_FILE=/run/secrets/backup_age_identity -v "$travail/work:/work" -e BACKUP_WORK_DIR=/work)"
code=$?
set -e
if [ ! -e "$travail/work/ghmt-backup.RESIDU" ]; then ok "répertoire de travail résiduel purgé au démarrage"; else ko "répertoire résiduel conservé"; fi
if [ -d "$travail/work/autre" ] && [ -f "$travail/work/fichier" ]; then ok "autres entrées du volume de travail conservées"; else ko "entrée étrangère supprimée"; fi
if [ -z "$(find "$travail/work" -maxdepth 1 -name 'ghmt-backup.*')" ]; then ok "aucun répertoire de travail après l'exécution (pas de copie en clair)"; else ko "répertoire de travail restant"; fi
if [ -n "${BACKUP_TEST_SHOW_REPORT:-}" ]; then jq -c "del(.checks.counts.mismatches)" <<< "$rapport" >&2; fi
[ "$code" -eq 0 ] && ok "code de sortie 0" || ko "code de sortie $code"
verifie "rapport status=ok, clé de la dernière sauvegarde" ".status == \"ok\" and .backupKey == \"$cle\"" "$rapport"
verifie "durée de restauration mesurée" '.restoreMs >= 0' "$rapport"
verifie "intégrité (taille et SHA-256 du manifeste)" '.checks.integrity.ok' "$rapport"
verifie "comptages identiques pour chaque table" '.checks.counts.ok and .checks.counts.tables >= 20 and (.checks.counts.mismatches | length) == 0' "$rapport"
verifie "prisma migrate status : à jour" '.checks.migrations.ok' "$rapport"
verifie "chaîne d'audit valide pour chaque tenant" '.checks.auditChain.ok and .checks.auditChain.tenants >= 1 and .checks.auditChain.rows >= 1' "$rapport"
verifie "RLS activée et forcée sur chaque table tenant" '.checks.rls.ok and .checks.rls.tables >= 15' "$rapport"
if grep -q "ghmt_backup_dev\|AGE-SECRET-KEY" <<< "$rapport"; then ko "le rapport contient un secret"; else ok "aucun secret dans le rapport"; fi

echo "== 3. sauvegarde tronquée"
manifeste="${cle%.dump.age}.manifest.json"
aws_dev s3api get-object --bucket "$bucket" --key "$manifeste" manifeste.json > /dev/null
taille="$(stat -c %s "$travail/sauvegarde.age")"
head -c $((taille / 2)) "$travail/sauvegarde.age" > "$travail/tronquee.age"
# a) Objet tronqué, manifeste d'origine : l'intégrité échoue.
cle_a="$(dirname "$cle")/ghmt-29991231T000001Z.dump.age"
aws_dev s3api put-object --bucket "$bucket" --key "$cle_a" --body tronquee.age > /dev/null
aws_dev s3api put-object --bucket "$bucket" --key "${cle_a%.dump.age}.manifest.json" --body manifeste.json > /dev/null
set +e
rapport_a="$(lance restore-test.sh -e BACKUP_AGE_IDENTITY_FILE=/run/secrets/backup_age_identity)"
code_a=$?
set -e
[ "$code_a" -ne 0 ] && ok "tronquée (manifeste d'origine) : code non nul ($code_a)" || ko "tronquée (manifeste d'origine) : code 0"
verifie "tronquée (manifeste d'origine) : rapport failed, la plus récente est testée, intégrité en échec" \
  ".status == \"failed\" and .backupKey == \"$cle_a\" and (.checks.integrity.ok | not)" "$rapport_a"
# b) Objet tronqué ET manifeste cohérent avec lui : le déchiffrement authentifié ou pg_restore échoue.
cle_b="$(dirname "$cle")/ghmt-29991231T000002Z.dump.age"
jq --arg k "$cle_b" --arg s "$(sha256sum "$travail/tronquee.age" | cut -d' ' -f1)" --argjson b "$((taille / 2))" \
  '.key = $k | .sha256 = $s | .bytes = $b' "$travail/manifeste.json" > "$travail/manifeste-b.json"
aws_dev s3api put-object --bucket "$bucket" --key "$cle_b" --body tronquee.age > /dev/null
aws_dev s3api put-object --bucket "$bucket" --key "${cle_b%.dump.age}.manifest.json" --body manifeste-b.json > /dev/null
set +e
rapport_b="$(lance restore-test.sh -e BACKUP_AGE_IDENTITY_FILE=/run/secrets/backup_age_identity)"
code_b=$?
set -e
[ "$code_b" -ne 0 ] && ok "tronquée (manifeste cohérent) : code non nul ($code_b)" || ko "tronquée (manifeste cohérent) : code 0"
verifie "tronquée (manifeste cohérent) : intégrité ok mais restauration en échec" \
  ".status == \"failed\" and .backupKey == \"$cle_b\" and .checks.integrity.ok and (.checks.restore.ok | not)" "$rapport_b"

echo "== 4. prune.sh (simulation)"
# Rétention négative : toute sauvegarde datée d'aujourd'hui est « expirée » ; les clés factices de 2999 restent.
elagage="$(lance prune.sh -e BACKUP_PRUNE_DRY_RUN=true -e BACKUP_DAILY_RETENTION_DAYS=-1 -e BACKUP_MONTHLY_RETENTION_DAYS=-1)"
verifie "simulation : la sauvegarde du jour et son manifeste à supprimer, les clés futures gardées, rien supprimé" \
  '.status == "ok" and .dryRun and .deleted == 2 and .kept == 4 and .refused == 0' "$elagage"

echo "== 5. sauvegarde forgée : SQL exécuté par pg_restore, environnement vidé, diagnostic sans valeur"
mkdir -p "$travail/out"
chmod 777 "$travail/out"
# Archive forgée dans une instance jetable : un déclencheur d'événement (levé par le REFRESH de la vue matérialisée, rejoué en dernier) exécute `env` via COPY TO PROGRAM puis échoue
# avec un message citant une valeur (« Dupont-SECRET »). Sans propriétaire (--no-owner) : le rôle de restauration l'exécute.
docker run --rm --read-only --tmpfs /tmp:rw,size=256m --cap-drop ALL -v "$travail/out:/out" -v "$travail/secrets:/run/secrets:ro" \
  --entrypoint bash "$image" -c '
  set -e; d="$(mktemp -d)"
  initdb -D "$d/pg" -U postgres -A trust --no-sync > /dev/null
  pg_ctl -D "$d/pg" -l "$d/log" -w -s -o "-c listen_addresses= -k $d" start
  export PGHOST="$d" PGUSER=postgres
  psql -qX -v ON_ERROR_STOP=1 -c "CREATE DATABASE forge" > /dev/null
  psql -qX -v ON_ERROR_STOP=1 -d forge > /dev/null <<"SQL"
CREATE TABLE patients (id int PRIMARY KEY, nom text);
CREATE MATERIALIZED VIEW vue AS SELECT nom FROM patients;
INSERT INTO patients VALUES (1, $$Dupont-SECRET$$);
CREATE FUNCTION evil() RETURNS event_trigger LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE $q$COPY (SELECT 1) TO PROGRAM $p$env > /out/env-postgres.txt$p$$q$;
  RAISE EXCEPTION $m$valeur saisie: Dupont-SECRET$m$;
END $f$;
CREATE EVENT TRIGGER evil ON ddl_command_end EXECUTE FUNCTION evil();
SQL
  pg_dump -Fc --no-owner -d forge -f /out/forge.dump
  pg_ctl -D "$d/pg" -m immediate -s stop
  age -r "$(cat /run/secrets/backup_age_recipient)" -o /out/forge.dump.age /out/forge.dump
  rm -rf "$d"'
cle_f="$(dirname "$cle")/ghmt-29991231T000003Z.dump.age"
jq -n --arg k "$cle_f" --arg s "$(sha256sum "$travail/out/forge.dump.age" | cut -d' ' -f1)" --argjson b "$(stat -c %s "$travail/out/forge.dump.age")" \
  '{ format: 1, key: $k, bytes: $b, sha256: $s, createdAt: "2999-12-31T00:00:03Z", counts: {}, roles: [] }' > "$travail/out/forge.manifest.json"
aws_dev s3api put-object --bucket "$bucket" --key "$cle_f" --body out/forge.dump.age > /dev/null
aws_dev s3api put-object --bucket "$bucket" --key "${cle_f%.dump.age}.manifest.json" --body out/forge.manifest.json > /dev/null
set +e
rapport_f="$(lance restore-test.sh -e BACKUP_AGE_IDENTITY_FILE=/run/secrets/backup_age_identity -e BACKUP_KEY="$cle_f" -e GHMT_CANARI=canari-secret-de-test -v "$travail/out:/out")"
code_f=$?
set -e
[ "$code_f" -ne 0 ] && ok "forgée : code non nul ($code_f)" || ko "forgée : code 0"
if [ -s "$travail/out/env-postgres.txt" ]; then
  ok "forgée : le SQL forgé a bien été exécuté par PostgreSQL (COPY TO PROGRAM)"
  if grep -qE 'AWS_|BACKUP_|GHMT_CANARI|canari-secret|ghmt-dev-s3-secret|AGE-SECRET-KEY' "$travail/out/env-postgres.txt"; then
    ko "forgée : l'environnement de PostgreSQL contient un secret ou une variable héritée : $(cut -d= -f1 "$travail/out/env-postgres.txt" | tr '\n' ' ')"
  else
    ok "forgée : environnement de PostgreSQL vidé (aucun secret S3, aucune variable BACKUP_*)"
  fi
else
  ko "forgée : le SQL forgé n'a pas été exécuté (test sans portée)"
fi
verifie "forgée : rapport failed à l'étape de restauration, diagnostic réduit à la catégorie" \
  '.status == "failed" and (.checks.restore.ok | not) and (.checks.restore.pgRestoreError | test("^could not execute query$"))' "$rapport_f"
if grep -q "Dupont-SECRET" <<< "$rapport_f"; then ko "forgée : une valeur de donnée figure dans le rapport"; else ok "forgée : aucune valeur de donnée dans le rapport"; fi

echo "== 6. première sauvegarde réussie du mois (prune.sh en simulation)"
# Mars 2025 : le 1er a échoué (dump sans manifeste), le 2 et le 3 ont réussi. Seule la première réussie (le 2) est mensuelle.
printf 'x' > "$travail/factice"
for jour in 01 02 03; do
  base_cle="postgres/2025/03/$jour/ghmt-202503${jour}T021500Z"
  aws_dev s3api put-object --bucket "$bucket" --key "${base_cle}.dump.age" --body factice > /dev/null
  [ "$jour" = "01" ] || aws_dev s3api put-object --bucket "$bucket" --key "${base_cle}.manifest.json" --body factice > /dev/null
done
elagage_m="$(lance prune.sh -e BACKUP_PRUNE_DRY_RUN=true -e BACKUP_DAILY_RETENTION_DAYS=1 -e BACKUP_MONTHLY_RETENTION_DAYS=100000 2> "$travail/prune-mois.err")"
verifie "à supprimer : le dump échoué du 1er et la sauvegarde du 3 ; gardée : la première réussie (le 2), les clés futures et du jour" \
  '.status == "ok" and .deleted == 3 and .kept == 10 and .refused == 0' "$elagage_m"
if grep -q "20250301T021500Z.dump.age" "$travail/prune-mois.err" && grep -q "20250303T021500Z.dump.age" "$travail/prune-mois.err" \
  && ! grep -q "20250302T021500Z" "$travail/prune-mois.err"; then ok "mensuelle = première sauvegarde réussie du mois (le 2), pas celle du 1er"; else ko "mauvaise sélection mensuelle : $(cat "$travail/prune-mois.err")"; fi

echo "== 7. backup.sh : deuxième sauvegarde du mois, verrouillage « quotidien »"
sortie_2="$(lance backup.sh -e BACKUP_DAILY_RETENTION_DAYS=2 -e BACKUP_MONTHLY_RETENTION_DAYS=40)"
retention_2="$(aws_dev s3api head-object --bucket "$bucket" --key "$(jq -r .key <<< "$sortie_2")" --output json | jq -c '{until: .ObjectLockRetainUntilDate}')"
jours_2="$(jours_verrou "$retention_2")"
[ "$jours_2" -ge 1 ] && [ "$jours_2" -le 2 ] && ok "deuxième sauvegarde du mois : verrouillage « quotidien » (${jours_2} j)" || ko "deuxième sauvegarde : verrouillage de ${jours_2} j (attendu 2)"

echo
if [ "$echecs" -eq 0 ]; then echo "SUCCÈS : aller-retour sauvegarde/restauration vérifié."; else echo "ÉCHEC : $echecs vérification(s)." >&2; fi
exit $((echecs > 0))
