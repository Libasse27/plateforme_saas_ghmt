#!/usr/bin/env bash
# Tests unitaires de lib.sh (sans Docker ni réseau) : décodage d'URL, purge des répertoires de travail résiduels.
#   infra/backup/test/lib.test.sh      (appelé aussi par roundtrip.sh)
set -Eeuo pipefail

ici="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$ici/../lib.sh" 2> /dev/null

echecs=0
ok() { printf '  ok   %s\n' "$1"; }
ko() { printf '  ÉCHEC %s\n' "$1" >&2; echecs=$((echecs + 1)); }
egal() { # description, attendu, obtenu
  if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 : attendu [$2], obtenu [$3]"; fi
}

echo "== lib.sh : url_decode (seules les séquences %XX sont décodées)"
egal "séquences %XX" 'p@ss:w/rd?' "$(url_decode 'p%40ss%3Aw%2Frd%3F')"
egal "hexadécimal en majuscules et minuscules" 'JJ' "$(url_decode '%4a%4A')"
egal "antislash littéral conservé" 'a\nb\x41\\c' "$(url_decode 'a\nb\x41\\c')"
egal "antislash et séquence %XX mêlés" 'a\n@' "$(url_decode 'a\n%40')"
egal "pour cent isolé ou incomplet conservé" '100% sûr %4' "$(url_decode '100% sûr %4')"
egal "séquence UTF-8 (octets %C3%A9)" 'é' "$(url_decode '%C3%A9')"
egal "chaîne vide" '' "$(url_decode '')"
egal "plus conservé (pas un espace)" 'a+b' "$(url_decode 'a+b')"
egal "%25 ne se décode qu'une fois" '%41' "$(url_decode '%2541')"

echo "== lib.sh : purge_stale_work_dirs"
racine="$(mktemp -d)"
trap 'rm -rf "$racine"' EXIT
mkdir -p "$racine/ghmt-backup.AAAAAA/pgdata" "$racine/ghmt-backup.BBBBBB" "$racine/autre"
touch "$racine/ghmt-backup.AAAAAA/pgdata/PG_VERSION" "$racine/fichier"
BACKUP_WORK_DIR="$racine" purge_stale_work_dirs 2> /dev/null
if [ ! -e "$racine/ghmt-backup.AAAAAA" ] && [ ! -e "$racine/ghmt-backup.BBBBBB" ]; then ok "répertoires de travail résiduels supprimés"; else ko "répertoires résiduels conservés"; fi
if [ -d "$racine/autre" ] && [ -f "$racine/fichier" ]; then ok "autres entrées conservées"; else ko "une autre entrée a été supprimée"; fi

echo "== lib.sh : month_prefix"
egal "préfixe aaaa/mm d'un horodatage" 'postgres/2026/10/' "$(backup_month_prefix 20261012T021500Z)"

[ "$echecs" -eq 0 ] || { echo "ÉCHEC : $echecs vérification(s)." >&2; exit 1; }
echo "SUCCÈS : lib.sh."
