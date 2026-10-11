#!/usr/bin/env bash
# Vérifie que chaque image des fichiers compose passés en argument est épinglée par digest (docs/11 §6.5, §11.2).
# Usage : infra/deploy/check-pinned-images.sh [fichier.yml ...]   (défaut : compose de développement)
set -euo pipefail

racine="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fichiers=("$@")
[ ${#fichiers[@]} -eq 0 ] && fichiers=("$racine/infra/docker-compose.yml")

echec=0
for fichier in "${fichiers[@]}"; do
  rendu="$(docker compose -f "$fichier" config | grep -E '^\s+image:' | sed -E 's/^\s+image:\s*//')"
  [ -z "$rendu" ] && { echo "ERREUR : aucune image trouvée dans $fichier" >&2; echec=1; continue; }
  while IFS= read -r image; do
    if [[ ! "$image" =~ @sha256:[0-9a-f]{64}$ ]]; then
      echo "ERREUR : image non épinglée dans $fichier : $image" >&2
      echec=1
    fi
  done <<< "$rendu"
done
[ "$echec" -eq 0 ] && echo "OK : toutes les images sont épinglées par digest."
exit "$echec"
