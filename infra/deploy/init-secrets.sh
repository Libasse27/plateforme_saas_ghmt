#!/usr/bin/env bash
# Génère les secrets aléatoires de infra/deploy/secrets/ (fichiers lus par les secrets Docker de compose.prod.yml).
# Ne remplace jamais un fichier existant. Les secrets externes (base de données, SMTP) sont à fournir par l'exploitant :
# database_url, platform_database_url et migration_database_url ne sont pas générés ; voir README.md.
set -euo pipefail
dossier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/secrets"
mkdir -p "$dossier"
# Dossier 0700 : seul l'exploitant y accède côté hôte ; les fichiers (0644) sont lisibles par l'utilisateur non root des
# conteneurs, car un secret Docker de compose est un montage de fichier qui conserve les droits de l'hôte.
chmod 700 "$dossier"

genere() { # nom, commande
  local fichier="$dossier/$1"
  if [ -e "$fichier" ]; then echo "existe déjà : $1"; return; fi
  ( umask 022; eval "$2" > "$fichier" )
  echo "créé : $1"
}

genere edge_proxy_secret 'openssl rand -base64 48 | tr -d "\n"'
genere jwt_access_secret 'openssl rand -base64 48 | tr -d "\n"'
genere jwt_platform_secret 'openssl rand -base64 48 | tr -d "\n"'
genere data_encryption_key 'openssl rand -base64 32 | tr -d "\n"'
genere blind_index_key 'openssl rand -base64 32 | tr -d "\n"'
genere redis_password 'openssl rand -hex 32 | tr -d "\n"'
# REDIS_URL authentifiée, dérivée du mot de passe (hex : aucun caractère à échapper).
if [ ! -e "$dossier/redis_url" ]; then
  ( umask 022; printf 'redis://:%s@redis:6379/0' "$(cat "$dossier/redis_password")" > "$dossier/redis_url" )
  echo "créé : redis_url"
fi
for requis in database_url platform_database_url migration_database_url; do
  [ -e "$dossier/$requis" ] || echo "À FOURNIR : $dossier/$requis"
done
