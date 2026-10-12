#!/usr/bin/env bash
# Rétention des sauvegardes (docs/13 D9, §6.1) quand le fournisseur n'offre pas de règle de cycle de vie :
# conserve les 35 derniers jours (BACKUP_DAILY_RETENTION_DAYS) et, au-delà, la PREMIÈRE sauvegarde réussie de chaque mois (celle
# qui a un manifeste ; le 1er peut avoir échoué) pendant 366 jours (BACKUP_MONTHLY_RETENTION_DAYS, soit 12 mensuelles). Supprime les VERSIONS expirées (dump et manifeste) ;
# une version encore verrouillée est refusée par le stockage : elle est comptée, jamais contournée.
# BACKUP_PRUNE_DRY_RUN=true : liste sans supprimer. Sortie : une ligne JSON { status, deleted, kept, refused, dryRun }.
set -Eeuo pipefail

TOOLS_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib.sh
. "$TOOLS_DIR/lib.sh"

WORK_DIR=""
trap 'jq -cn "{ status: \"error\" }"; exit 1' ERR
trap '[ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"' EXIT

make_work_dir
setup_s3
daily_days="${BACKUP_DAILY_RETENTION_DAYS:-35}"
monthly_days="${BACKUP_MONTHLY_RETENTION_DAYS:-366}"
dry_run="${BACKUP_PRUNE_DRY_RUN:-false}"
now="$(date -u +%s)"

# Première sauvegarde réussie de chaque mois, d'après les manifestes présents (le manifeste est déposé en dernier) :
# tableau « aaaamm » -> radical de clé (sans .dump.age ni .manifest.json). Les radicaux triés se trient chronologiquement.
declare -A monthly_first=()
s3api list-object-versions --bucket "$BACKUP_BUCKET" --prefix "$BACKUP_PREFIX" --output json \
  | jq -r '(.Versions // [])[] | "\(.Key)\t\(.VersionId)"' > "$WORK_DIR/versions"
while IFS= read -r stem; do
  [[ "$stem" =~ ghmt-([0-9]{6})[0-9]{2}T[0-9]{6}Z$ ]] || continue
  [ -n "${monthly_first[${BASH_REMATCH[1]}]:-}" ] || monthly_first[${BASH_REMATCH[1]}]="$stem"
done < <(cut -f1 "$WORK_DIR/versions" | grep '\.manifest\.json$' | sed 's/\.manifest\.json$//' | sort -u)

# Âge en jours d'une clé postgres/aaaa/mm/jj/ghmt-aaaammjjThhmmssZ.(dump.age|manifest.json) ; vide si format inconnu.
age_days() {
  [[ "$1" =~ ghmt-([0-9]{8})T[0-9]{6}Z\.(dump\.age|manifest\.json)$ ]] || return 0
  printf '%s' $(( (now - $(date -u -d "${BASH_REMATCH[1]}" +%s)) / 86400 ))
}
expired() { # clé
  local days stem month
  days="$(age_days "$1")"
  [ -n "$days" ] || return 1
  [ "$days" -gt "$daily_days" ] || return 1
  # Sauvegarde mensuelle : la première réussie du mois (le dump et son manifeste).
  stem="${1%.dump.age}"
  stem="${stem%.manifest.json}"
  [[ "$stem" =~ ghmt-([0-9]{6})[0-9]{2}T[0-9]{6}Z$ ]] && month="${BASH_REMATCH[1]}" || return 0
  if [ "${monthly_first[$month]:-}" = "$stem" ] && [ "$days" -le "$monthly_days" ]; then return 1; fi
  return 0
}

deleted=0 kept=0 refused=0
while IFS=$'\t' read -r key version; do
  if ! expired "$key"; then kept=$((kept + 1)); continue; fi
  if [ "$dry_run" = "true" ]; then deleted=$((deleted + 1)); log "à supprimer : ${key}"; continue; fi
  if s3api delete-object --bucket "$BACKUP_BUCKET" --key "$key" --version-id "$version" > /dev/null 2> "$WORK_DIR/err"; then
    deleted=$((deleted + 1))
  else
    refused=$((refused + 1))
    log "suppression refusée (verrouillage en cours ?) : ${key}"
  fi
done < "$WORK_DIR/versions"

jq -cn --argjson deleted "$deleted" --argjson kept "$kept" --argjson refused "$refused" --argjson dryRun "$dry_run" \
  '{ status: "ok", deleted: $deleted, kept: $kept, refused: $refused, dryRun: $dryRun }'
