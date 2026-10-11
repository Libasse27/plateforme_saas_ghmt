#!/bin/sh
# Charge les secrets Docker (docs/11 §14.3.2) : pour chaque variable NOM_FILE=/run/secrets/x, exporte NOM avec le contenu
# du fichier, puis lance la commande. Les valeurs ne sont jamais affichées ni passées en argument.
set -eu
for variable in $(env | sed -n 's/^\([A-Z][A-Z0-9_]*\)_FILE=.*/\1/p'); do
  eval "fichier=\${${variable}_FILE}"
  if [ ! -r "$fichier" ]; then
    echo "Secret illisible pour ${variable} : ${fichier}" >&2
    exit 1
  fi
  valeur="$(cat "$fichier")"
  export "${variable}=${valeur}"
  unset "${variable}_FILE"
done
exec "$@"
