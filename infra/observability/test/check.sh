#!/usr/bin/env bash
# Vérifications statiques de l'observabilité et de la topologie (docs/13 §11.3 point 6, §6.2), sans démarrer la pile :
# un seul conteneur jetable à la fois (images épinglées de compose.prod.yml).
#   promtool check config + check rules + test rules ; amtool check-config ; otelcol validate ;
#   docker compose config (profils observability et tools) ; images épinglées par digest.
set -Eeuo pipefail

ici="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
obs="$(cd "$ici/.." && pwd)"
racine="$(cd "$obs/../.." && pwd)"
compose="$racine/infra/deploy/compose.prod.yml"

# Image d'un service, lue dans compose.prod.yml (même digest que la production).
image_de() { sed -n "/^  $1:/,/^  [a-z]/s/^    image: //p" "$compose" | head -n 1; }

etape() { printf '\n== %s\n' "$1"; }

etape "promtool : configuration, règles et tests unitaires des alertes"
docker run --rm -v "$obs/prometheus:/etc/prometheus:ro" --entrypoint promtool "$(image_de prometheus)" check rules /etc/prometheus/rules/ghmt-alerts.rules.yml
docker run --rm -v "$obs/prometheus:/etc/prometheus:ro" -w /etc/prometheus/tests --entrypoint promtool "$(image_de prometheus)" test rules ghmt-alerts.test.yml
docker run --rm -v "$obs/prometheus:/etc/prometheus:ro" --entrypoint promtool "$(image_de prometheus)" check config --syntax-only /etc/prometheus/prometheus.yml

etape "amtool : configuration d'Alertmanager (modèle rendu avec une adresse factice)"
# Sous le dépôt (ignoré par git) : le démon Docker doit voir le répertoire monté.
mkdir -p "$obs/.work"
rendu="$(mktemp -d "$obs/.work/check.XXXXXX")"
chmod 755 "$rendu"
trap 'rm -rf "$rendu"' EXIT
sed 's/__ALERT_EMAIL__/astreinte@example.invalid/; s/__SMTP_HOST__/smtp.example.invalid:587/; s/__MAIL_FROM__/alertes@example.invalid/; s/__SMTP_USER__/alertes/' \
  "$obs/alertmanager/alertmanager.yml.tmpl" > "$rendu/alertmanager.yml"
printf 'factice' > "$rendu/smtp_password"
chmod 644 "$rendu/"*
sed -i 's#/run/secrets/alertmanager_smtp_password#/rendu/smtp_password#' "$rendu/alertmanager.yml"
docker run --rm -v "$rendu:/rendu:ro" --entrypoint amtool "$(image_de alertmanager)" check-config /rendu/alertmanager.yml

etape "otelcol : configuration du Collector"
docker run --rm -v "$obs/otel-collector.yaml:/etc/otelcol/config.yaml:ro" "$(image_de otel-collector)" validate --config=/etc/otelcol/config.yaml
echo "OK : configuration du Collector valide."

etape "docker compose config (tous les profils)"
# Variables non secrètes d'un essai local : .env.example, plus celles introduites par docs/13 (stockage, sauvegarde,
# astreinte) tant qu'elles n'y figurent pas.
env_tmp="$rendu/.env"
cat "$racine/infra/deploy/.env.example" > "$env_tmp"
for defaut in S3_ENDPOINT=https://s3.example.invalid S3_BUCKET_QUARANTINE=ghmt-quarantine S3_BUCKET_DOCUMENTS=ghmt-documents \
  BACKUP_BUCKET=ghmt-backups BACKUP_S3_ENDPOINT=https://s3.example.invalid ALERT_EMAIL=astreinte@example.invalid \
  ALERT_SMTP_USER=alertes SMTP_HOST=smtp.example.invalid; do
  grep -q "^${defaut%%=*}=." "$env_tmp" || printf '%s\n' "$defaut" >> "$env_tmp"
done
docker compose -f "$compose" --env-file "$env_tmp" --profile observability --profile tools config --quiet
echo "OK : compose.prod.yml valide."

etape "aucun port publié hors Traefik (tous les profils)"
publies="$(docker compose -f "$compose" --env-file "$env_tmp" --profile observability --profile tools config --format json \
  | jq -r '.services | to_entries[] | select(.value.ports != null and (.value.ports | length) > 0) | .key')"
if [ "$publies" = "traefik" ]; then echo "OK : seul traefik publie des ports."; else echo "ERREUR : ports publiés par : $publies" >&2; exit 1; fi

etape "réseau observability : ni web, ni traefik, ni clamav, ni tâches de sauvegarde ; le Collector n'y est que lui"
reseaux="$(docker compose -f "$compose" --env-file "$env_tmp" --profile observability --profile tools config --format json)"
sur_observability="$(jq -r '.services | to_entries[] | select(.value.networks != null and (.value.networks | has("observability"))) | .key' <<< "$reseaux" | sort | tr '\n' ' ')"
interdits="$(jq -r '.services | to_entries[] | select(.key | IN("web", "traefik", "clamav", "redis", "backup", "restore-test", "prune")) | select(.value.networks != null and (.value.networks | has("observability"))) | .key' <<< "$reseaux")"
if [ -n "$interdits" ]; then echo "ERREUR : sur le réseau observability : $interdits" >&2; exit 1; fi
collecteur="$(jq -r '.services["otel-collector"].networks | keys | join(",")' <<< "$reseaux")"
if [ "$collecteur" != "observability" ]; then echo "ERREUR : le Collector est sur : $collecteur (attendu : observability seul)" >&2; exit 1; fi
echo "OK : réseau observability = ${sur_observability}"

etape "images épinglées par digest (tous les profils)"
# check-pinned-images.sh lit `docker compose config` : les variables et les profils doivent être fournis.
# shellcheck disable=SC1090 # fichier de variables généré ci-dessus
(set -a; . <(grep -E '^[A-Z0-9_]+=' "$env_tmp" | sed -E "s/=(.*)$/='\1'/"); export COMPOSE_PROFILES=observability,tools
 "$racine/infra/deploy/check-pinned-images.sh" "$racine/infra/docker-compose.yml" "$compose")
