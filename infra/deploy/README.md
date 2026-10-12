# Topologie de déploiement de référence (docs/11 D11, §6.6)

Objectif : **l'IP cliente ne peut pas être usurpée**. L'API fonde sur elle le MFA hors réseau de confiance des soignants (docs/11 D4, D6) et la limitation de débit. Elle n'est fiable que si un accès direct au BFF ou à l'API est impossible.

```
Internet ──► Traefik (80/443, seul port publié) ──► web   (réseau interne `edge`, aucun `ports:`)
                    │  X-Ghmt-Edge-Auth injecté        │
                    └──► api (/api/v1) ◄───────────────┘ API_URL=http://api:3000/api/v1
                                   │
                                   ├── redis (réseau interne `data`)
                                   └── base PostgreSQL gérée, SMTP (réseau `egress`)
```

**Réseau `observability` (interne, `172.29.0.0/24`)** : seuls y sont rattachés l'`api` (adresse fixe `172.29.0.10`), le Collector et les services du profil `observability` (Prometheus, Alertmanager, Grafana, Loki, Tempo, exportateurs). `web`, `traefik`, `clamav`, `redis` et les tâches `backup`/`restore-test`/`prune` n'y sont **pas** : ils ne peuvent joindre ni le Collector ni les métriques. Qui joint quoi :

- **`api:9464` (métriques)** : l'API n'écoute que sur `METRICS_HOST=172.29.0.10` (son adresse sur `observability`), pas sur `edge` ni `data` ; seul Prometheus (et tout autre service de `observability`) peut donc la joindre, même si le `web` partage le réseau `edge` avec l'API. `METRICS_HOST` vaut `0.0.0.0` par défaut (développement, tests).
- **Collector `otel-collector:4318` (OTLP)** : joint par l'API (qui y envoie traces et journaux) et par Prometheus (`:8888`, ses propres métriques) ; il n'est que sur `observability` et n'exporte que vers Tempo et Loki, sur ce réseau. Pour exporter vers un service externe (`OTEL_TRACES_ENDPOINT`, `OTEL_LOGS_ENDPOINT`), il faut lui ajouter le réseau `egress` par une surcharge de compose : ce n'est pas le cas par défaut, pour que le seul service qui voit tous les journaux et toutes les traces n'ait pas de sortie.
- **`web`** n'envoie pas de traces (aucune instrumentation OpenTelemetry côté Next.js dans cette phase) : il n'a donc pas besoin du Collector. Si cela change, lui donner un jeton d'ingestion et un réseau dédié plutôt que de le rattacher à `observability`.
- `infra/observability/test/check.sh` vérifie ces rattachements (aucun de `web`, `traefik`, `clamav`, `redis`, `backup`, `restore-test`, `prune` sur `observability`, Collector seul sur `observability`).

Fichiers : `compose.prod.yml` (référence), `traefik/dynamic.yml` (routeurs, secret de bordure, limite d'entrée), `entrypoint-secrets.sh` et `init-secrets.sh` (secrets Docker), `check-pinned-images.sh` (images épinglées par digest, exécuté en CI).

**Routage public** : le routeur `web` sert tout le site ; le routeur `api` est limité à `/api/v1/webhooks` (webhooks des fournisseurs, signés) et à `/api/v1/health` (sonde minimale `{ status }`). Le BFF joint l'API en interne (`http://api:3000`) : `/api/v1/auth/*`, `/api/v1/health/ready` (détail) et le reste de l'API ne sont **jamais** routés publiquement.

## Chaîne des proxys et valeurs de `TRUSTED_PROXY_HOPS`

Chaque proxy de confiance **ajoute** l'adresse de son appelant à la fin de `X-Forwarded-For`. Le BFF retient l'entrée `longueur − n` : tout ce qui précède vient du client et n'est jamais cru.

| Topologie | `TRUSTED_PROXY_HOPS` | Réglage associé |
|---|---|---|
| Traefik seul devant le BFF (référence) | `1` | `forwardedHeaders.trustedIPs` vide : Traefik n'accorde aucune confiance à un amont |
| CDN ou répartiteur de charge + Traefik | `2` | déclarer les plages du CDN dans `trustedIPs` de Traefik |
| Accès direct au BFF (sans proxy) | **interdit** | `0` n'est pas accepté en production |

`X-Real-IP` n'est plus lu. L'API (`TRUSTED_PROXIES`) ne fait confiance qu'au sous-réseau du réseau `edge` (`172.30.0.0/24`, fixé dans le compose) : seul le BFF lui parle.

## Règles à ne jamais enfreindre

1. **Ne jamais publier `web` ni `api`** (`ports:` interdit, y compris en `127.0.0.1` sur un hôte partagé). Sans la garde ci-dessous, un accès direct permettrait d'envoyer `X-Forwarded-For: <IP de l'hôpital>` et de contourner le MFA hors réseau.
2. **Secret de bordure** : Traefik injecte `X-Ghmt-Edge-Auth: $EDGE_PROXY_SECRET` en écrasant toute valeur reçue (middleware `edge-auth`). Le BFF (`proxy.ts`, `isFromTrustedEdge`) répond `403` à toute requête sans secret valide en production, le compare en temps constant et ne retient aucune IP sans lui. Le secret n'est jamais transmis à l'API ni journalisé.
3. `EDGE_PROXY_SECRET` : 32 caractères ou plus (`openssl rand -base64 48`), fourni comme **secret Docker** (`secrets/edge_proxy_secret`), jamais dans une image, une variable du compose ni un fichier versionné. Le BFF refuse de démarrer en production sans lui ni sans `TRUSTED_PROXY_HOPS` (`instrumentation.ts`).
4. La base est gérée : trois chaînes de connexion distinctes, en secrets (`database_url` rôle `ghmt_app`, `platform_database_url` rôle `ghmt_platform`, `migration_database_url` rôle `ghmt_migrator` réservé à la tâche de migration).
5. `RATE_LIMIT_STORE=redis` est obligatoire en production (refus au démarrage de l'API) ; le Redis du compose est interne **et protégé par mot de passe** (`redis_password`, `REDIS_URL` authentifiée en secret `redis_url`).
6. Durcissement des conteneurs : `read_only`, `cap_drop: [ALL]` (Traefik ne conserve que `NET_BIND_SERVICE`), `no-new-privileges`, `tmpfs` pour les écritures temporaires.

## Mise en service

```bash
cp infra/deploy/.env.example infra/deploy/.env     # variables non secrètes
infra/deploy/init-secrets.sh                         # génère les secrets aléatoires (jamais d'écrasement)
# Fournir depuis le coffre : secrets/database_url, secrets/platform_database_url, secrets/migration_database_url
docker compose -f infra/deploy/compose.prod.yml --env-file infra/deploy/.env build
# Migrations : tâche ponctuelle, rôle propriétaire (jamais au démarrage de l'API)
docker build -f apps/api/Dockerfile --target migrate -t ghmt-api-migrate .
docker run --rm -e MIGRATION_DATABASE_URL="$(cat infra/deploy/secrets/migration_database_url)" ghmt-api-migrate
docker compose -f infra/deploy/compose.prod.yml --env-file infra/deploy/.env up -d
```

Essai local : `DOMAIN=ghmt.localhost`, `ACME_ENABLED` vide (certificat auto-signé de Traefik, `curl -k`). En production : `ACME_ENABLED=true`, `ACME_EMAIL` renseigné, DNS pointant sur l'hôte.

## Rotation du secret de bordure

1. Générer un nouveau secret et le placer dans le coffre.
2. Redéployer **ensemble** `traefik` et `web` (`docker compose up -d traefik web`) : une courte fenêtre de `403` est attendue (quelques secondes). Il n'y a pas de double secret : la rotation à chaud n'est volontairement pas prise en charge, pour garder la comparaison unique et en temps constant.
3. Vérifier (ci-dessous), puis révoquer l'ancien secret dans le coffre.

## Vérifications post-déploiement

```bash
# 1. Aucun port publié par web ni api
docker compose -f infra/deploy/compose.prod.yml config | awk '/^  (web|api):/{s=$1} /ports:/{print s" publie des ports"}'   # attendu : aucune sortie
# 2. Le BFF n'est pas joignable depuis l'hôte
curl -m 3 http://localhost:3001/connexion    # attendu : échec de connexion
# 3. Accès direct au BFF depuis le réseau interne, sans secret : 403
docker compose -f infra/deploy/compose.prod.yml exec api wget -qO- http://web:3001/connexion   # attendu : 403 Forbidden
# 4. Via Traefik, une IP forgée n'est pas retenue : l'audit de connexion porte l'IP réelle du client
curl -k -H 'X-Forwarded-For: 203.0.113.50' https://$DOMAIN/connexion -o /dev/null -w '%{http_code}\n'
#    puis se connecter et vérifier dans `GET /audit-logs` que l'IP n'est pas 203.0.113.50
# 5. En-têtes de sécurité (CSP à nonce différent à chaque appel, COOP, CORP, Cache-Control: no-store)
curl -kI https://$DOMAIN/connexion
# 6. Journaux : ni jeton ni secret de bordure
docker compose -f infra/deploy/compose.prod.yml logs api web | grep -c "$EDGE_PROXY_SECRET"   # attendu : 0
# 7. Images épinglées
COMPOSE_PROFILES=observability,tools infra/deploy/check-pinned-images.sh infra/docker-compose.yml infra/deploy/compose.prod.yml
```

Le health check de l'API est `GET /api/v1/health` ; celui du BFF présente le secret de bordure (sinon `proxy.ts` répondrait 403).

## Socle de production (docs/13) : stockage, antivirus, sauvegardes, observabilité

```
api ──► clamav            (réseau interne `data`, aucun port ; `egress` pour freshclam seulement)
api ──► stockage objet    (EXTERNE, https, secrets s3_access_key_id / s3_secret_access_key)
api ──► otel-collector    (OTLP http://otel-collector:4318, réseau `observability`) ──► Tempo, Loki (profil observability)
api:9464 ◄── Prometheus   (réseau interne `observability`, JAMAIS routé par Traefik) ──► Alertmanager ──► ALERT_EMAIL
backup / restore-test / prune (profil tools, cron de l'hôte) ──► base gérée + bucket de sauvegarde (réseau `egress`)
```

Fichiers : `compose.prod.yml` (services `clamav`, `otel-collector`, profils `tools` et `observability`), `traefik/dynamic.yml` (middleware `upload-limit` : corps limité à 11 Mo sur le routeur `web`), `../backup/` (scripts et image des sauvegardes), `../observability/` (Collector, Prometheus et règles d'alerte, Alertmanager, Loki, Tempo, Grafana, sondes blackbox).

### Secrets et variables ajoutés

| Secret (`secrets/…`) | Contenu | Fourni par |
|---|---|---|
| `s3_access_key_id`, `s3_secret_access_key` | identifiants S3 de l'application (buckets `quarantine` et `documents`) | fournisseur de stockage |
| `backup_database_url` | `postgresql://ghmt_backup:…@hôte:5432/ghmt?sslmode=verify-full` | coffre (rôle ci-dessous) |
| `backup_s3_access_key_id`, `backup_s3_secret_access_key` | identifiants S3 **distincts**, limités au bucket de sauvegarde | fournisseur de stockage |
| `backup_age_recipient` | clé **publique** age (`age1…`) | `age-keygen` sur le poste hors ligne |
| `backup_age_identity` | clé **privée** age : **uniquement** sur l'hôte de vérification (jamais en production) | poste hors ligne |
| `alertmanager_smtp_password` | mot de passe SMTP de l'astreinte | coffre |
| `grafana_admin_password` | `openssl rand -base64 32` | exploitant |

Variables non secrètes (`.env`) : `S3_ENDPOINT` (https), `S3_REGION`, `S3_BUCKET_QUARANTINE`, `S3_BUCKET_DOCUMENTS`, `BACKUP_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `ALERT_EMAIL`, `ALERT_SMTP_USER` ; facultatives : `FILES_ENABLED` (défaut `true`), `BACKUP_LOCK_MODE` (`COMPLIANCE`), `OTEL_TRACES_ENDPOINT`, `OTEL_LOGS_ENDPOINT` (Tempo et Loki du profil par défaut).

### Rôle `ghmt_backup` (avant la migration `20261012000200_backup_role`)

`BYPASSRLS` ne peut être attribué que par un superutilisateur : l'administrateur de la base gérée crée le rôle, **avant** `prisma migrate deploy`, avec un mot de passe tiré du coffre (jamais dans une migration ni un fichier versionné) :

```sql
CREATE ROLE ghmt_backup LOGIN PASSWORD '<coffre>' BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE ghmt TO ghmt_backup;
```

La migration vérifie ces attributs (elle échoue sinon) et n'accorde que `USAGE` sur les schémas et `SELECT` sur les tables et séquences, présentes et futures : aucune écriture. Si le fournisseur refuse `BYPASSRLS`, ne pas affaiblir la RLS : utiliser son rôle d'export dédié et le signaler (la sauvegarde logique serait sinon vide pour les tables à RLS forcée). En dev et en CI, le rôle est créé par `infra/postgres/init/01-roles.sql`.

### Bucket de sauvegarde

1. Créer le bucket **avec verrouillage d'objet** (impossible à activer après coup) et le versionnage, rétention par défaut `COMPLIANCE` 35 jours, dans la même juridiction que la base.
2. Trois jeux d'identifiants, aucun partagé avec l'application : écriture (`backup` : `PutObject`, `GetObject` pour le contrôle de taille, `ListBucket` pour savoir si le mois a déjà une sauvegarde réussie ; sans ce droit, chaque sauvegarde reçoit le verrou long de 366 jours par précaution), lecture (`restore-test` : `ListBucket`, `GetObject`), rétention (`prune`, seulement sans règle de cycle de vie : `ListBucketVersions`, `DeleteObjectVersion`).
3. Chaque sauvegarde dépose `postgres/aaaa/mm/jj/ghmt-<horodatage>.dump.age` (dump `-Fc` chiffré age, SHA-256 vérifié par le stockage) et `….manifest.json` (taille, SHA-256, comptage de chaque table dans le même instantané que le dump, rôles référencés). La **première sauvegarde réussie** de chaque mois (celle dont le manifeste existe ; pas forcément celle du 1er, qui peut avoir échoué) est verrouillée 366 jours (12 mensuelles) ; `prune.sh` applique la même règle.
4. Les documents des patients ne passent pas par ces scripts : versionnage et réplication du bucket `documents` (voir « Effacement des documents » ci-dessous : le versionnage impose une règle de cycle de vie).

### Effacement des documents : cycle de vie obligatoire du bucket `documents`

Le bucket `documents` est **versionné** : `DeleteObject` ne pose qu'un marqueur de suppression, la version courante reste lisible par son identifiant de version. Sans règle de cycle de vie, un document « effacé » ne l'est donc jamais. **Règle obligatoire** (à poser avant la mise en production, et à vérifier à chaque revue d'exploitation) : expiration des versions non courantes après 30 jours, et nettoyage des marqueurs orphelins.

```json
{
  "Rules": [
    {
      "ID": "expire-versions-non-courantes",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
      "Expiration": { "ExpiredObjectDeleteMarker": true },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration --bucket "$S3_BUCKET_DOCUMENTS" --lifecycle-configuration file://documents-lifecycle.json
aws s3api get-bucket-lifecycle-configuration --bucket "$S3_BUCKET_DOCUMENTS"   # à consigner dans le registre d'exploitation
```

Si la réplication du bucket est active, appliquer la même règle au bucket répliqué. L'**effacement cryptographique** complète le dispositif : à la suppression d'un document, l'API efface en base la clé enveloppée de ce document, de sorte que les octets chiffrés restants (versions non courantes pendant 30 jours, réplicas) deviennent illisibles. Les **sauvegardes** de la base conservent en revanche cette clé enveloppée pendant leur rétention (35 jours, jusqu'à 366 jours pour les mensuelles) : un document supprimé reste donc théoriquement récupérable par restauration d'une sauvegarde pendant cette durée, tant que ses octets existent encore dans le bucket (30 jours au plus après la suppression). Le délai d'effacement effectif annoncé aux établissements est celui de la rétention des sauvegardes.

### Sauvegarde quotidienne (cron de l'hôte de production)

```bash
docker compose -f infra/deploy/compose.prod.yml --env-file infra/deploy/.env --profile tools build backup
# /etc/cron.d/ghmt-backup (utilisateur de déploiement) : sauvegarde à 02:15 UTC, rétention à 03:30
15 2 * * * deploy cd /opt/ghmt && docker compose -f infra/deploy/compose.prod.yml --env-file infra/deploy/.env --profile tools run --rm backup >> /var/log/ghmt/backup.log 2>&1
30 3 * * * deploy cd /opt/ghmt && docker compose -f infra/deploy/compose.prod.yml --env-file infra/deploy/.env --profile tools run --rm prune  >> /var/log/ghmt/backup.log 2>&1
```

Sortie : une ligne JSON `{ status, key, bytes, sha256, durationMs }` (ou `{ status: "error", stage }` et un code non nul). Le résultat est aussi écrit pour Prometheus (volume `backup-metrics`, collecteur textfile de `node-exporter`) : l'alerte `GhmtBackupMissing` se déclenche sans sauvegarde réussie depuis plus de 26 h. Aucun secret ni chaîne de connexion n'est affiché.

### Test de restauration (D10)

`restore-test.sh` prend la dernière sauvegarde (ou `BACKUP_KEY`), refuse une taille ou une empreinte différente du manifeste, déchiffre (vers un fichier du répertoire de travail `0700`), restaure dans un PostgreSQL **jetable interne au conteneur** (127.0.0.1, détruit à la fin) et contrôle : comptage de chaque table (égal au manifeste), `prisma migrate status` (à jour), chaîne d'audit de chaque tenant (empreintes recalculées), RLS activée et forcée avec politique sur chaque table `tenant.*`. Rapport JSON `{ status, backupKey, restoreMs, durationMs, checks }`, code non nul au moindre échec. En cas d'échec de `pg_restore`, le rapport ne reprend que la catégorie de l'erreur (p. ex. `could not execute query`, `COPY failed for table "…"`), jamais le message du serveur, qui peut citer des valeurs de données.

**Isolation de la restauration.** Une sauvegarde forgée rejouée par `pg_restore` en superutilisateur pourrait exécuter du SQL (`COPY … TO PROGRAM`). Le script limite l'exposition : la clé privée age n'est lue que pendant le déchiffrement ; les identifiants S3 sont retirés de l'environnement dès la sauvegarde téléchargée ; PostgreSQL jetable et `pg_restore` démarrent avec un environnement **vidé** (`env -i`, seulement `PATH`, `HOME`, `TMPDIR`) ; `roundtrip.sh` le vérifie avec une archive forgée (le SQL s'exécute, son environnement ne contient aucun secret). **Risque résiduel** : le PostgreSQL jetable tourne sous le même uid que le script (conteneur non root, sans capacité pour changer d'uid) ; un fichier de `/run/secrets` lisible par cet uid resterait donc lisible par du SQL forgé. En conséquence : le conteneur `restore-test` ne monte **que** `backup_age_identity` et les identifiants de **lecture** du bucket (c'est le cas dans `compose.prod.yml`) ; ne jamais y ajouter d'autre secret ni d'autre volume, ni l'exécuter sur l'hôte de production. La **signature du manifeste** (qui fera refuser toute sauvegarde non émise par `backup.sh`) est reportée en **P14** : d'ici là, la protection repose sur le contrôle d'accès en écriture du bucket de sauvegarde (jeu d'identifiants d'écriture distinct, verrouillage d'objet).

- **Chaque nuit, en CI** : aller-retour sur la base de test (`infra/backup/test/roundtrip.sh`, qui vérifie aussi l'échec sur une sauvegarde tronquée).
- **Chaque semaine, production** : la clé privée ne doit jamais se trouver sur l'hôte de production (D9). Le test tourne donc sur l'**hôte de vérification** qui détient `secrets/backup_age_identity` (même dépôt, mêmes identifiants de **lecture** du bucket) :

```bash
# hôte de vérification, dimanche 05:00 UTC ; MAILTO envoie la sortie en échec à l'astreinte
MAILTO=astreinte@exemple
0 5 * * 0 verif cd /opt/ghmt && docker compose -f infra/deploy/compose.prod.yml --env-file infra/deploy/.env --profile tools run --rm restore-test > /var/log/ghmt/restore-test.json || cat /var/log/ghmt/restore-test.json
```

  Consigner `restoreMs` (durée de restauration) dans le registre d'exploitation. Si l'hôte de vérification exécute aussi le profil `observability` (ou si l'on monte ponctuellement la clé depuis un support hors ligne sur l'hôte de production), les alertes `GhmtRestoreTestFailed` et `GhmtRestoreTestStale` (plus de 8 jours) s'appliquent ; sans métrique, elles restent muettes et `MAILTO` fait foi.
- Espace et confidentialité : le dump déchiffré **et** la base restaurée sont écrits en clair dans le volume `restore-work` (prévoir 3 fois la taille de la base). Ce volume doit résider sur le **disque chiffré de l'hôte de vérification** (ou être un `tmpfs` dimensionné : `driver_opts: { type: tmpfs, device: tmpfs, o: size=…g }`). Le script supprime ces fichiers à la sortie et **purge au démarrage** tout répertoire `ghmt-backup.*` résiduel de `BACKUP_WORK_DIR` (exécution tuée par SIGKILL, redémarrage de l'hôte) ; une seule exécution à la fois par volume.

### Restauration réelle (incident)

1. Geler les écritures (arrêter `api`), ouvrir un incident, prévenir la direction des établissements concernés.
2. Sur l'hôte de vérification : `restore-test.sh` sur la sauvegarde choisie (`BACKUP_KEY=postgres/…`) pour prouver qu'elle est saine.
3. Base cible neuve chez le fournisseur ; créer les rôles (`ghmt_migrator`, `ghmt_app`, `ghmt_platform`, `ghmt_backup`) avec de **nouveaux** mots de passe, puis :
   `age -d -i backup_age_identity ghmt-….dump.age | pg_restore --exit-on-error --no-password -d "<URL de ghmt_migrator ou du propriétaire>"`
4. `prisma migrate status` (tâche de migration), contrôles du rapport (comptages, chaîne d'audit via la console, RLS), puis bascule des secrets `database_url`, `platform_database_url`, `migration_database_url`, `backup_database_url` et redémarrage.
5. Le PITR du fournisseur reste la voie de reprise la plus fine (perte de données minimale) ; la sauvegarde logique est le recours indépendant du fournisseur.

**Base auto-hébergée** (hors topologie de référence) : ajouter pgBackRest (sauvegarde complète hebdomadaire, différentielle quotidienne, archivage WAL continu vers un dépôt S3 chiffré `repo1-cipher-type=aes-256-cbc`, `repo1-retention-full=5`), en plus de `backup.sh` ; tester `pgbackrest restore --type=time` chaque trimestre.

### Observabilité (profil `observability`)

```bash
docker compose -f infra/deploy/compose.prod.yml --env-file infra/deploy/.env --profile observability up -d
# Grafana n'est PAS publié (docs/13 Q7) : tunnel SSH vers son adresse fixe du réseau `admin`, puis http://localhost:3000
ssh -N -L 3000:172.31.0.10:3000 deploy@<hôte>
```

- **Traces** : l'API démarre OpenTelemetry avant Nest (`node --require ./dist/instrumentation.js dist/main.js`) ; HTTP, Express, Nest, PostgreSQL, Redis, Prisma ; jamais d'en-tête, de corps, de query string, ni de valeur de paramètre SQL ; `ghmt.tenant.id` en attribut. **Messages d'erreur** : jamais exportés (une erreur pg ou Prisma cite des valeurs saisies) : le statut d'un span en erreur est ramené à `error`, un événement `exception` ne garde que `exception.type` (assaini par l'API, puis une seconde fois par le Collector). Le Collector masque une seconde fois et garde 100 % des traces en erreur, 10 % des autres.
- **Journaux** : chaque ligne Pino porte `traceId`, `spanId` et `tenantId` ; envoyée aussi au Collector, puis à Loki (30 jours). Dans Grafana, un `traceId` de Loki ouvre la trace dans Tempo. Les journaux d'erreur 500 de l'API ne portent que le nom, le code et un message tronqué (jamais celui d'une erreur Prisma ni d'une erreur pg brute, reconnue à son code SQLSTATE : `summarizeError`) ; le Collector ne pouvant pas masquer un corps de journal, ce filtrage est fait par l'API.
- **Métriques** : `api:9464/metrics` (`METRICS_PORT`, écoute sur `METRICS_HOST`), serveur distinct de l'API, jamais routé par Traefik ; latence par **gabarit** de route (`http_server_request_duration_seconds`), jamais de label `tenantId`.
- **Alertes** (`../observability/prometheus/rules/ghmt-alerts.rules.yml`, tests `promtool test rules`) vers `ALERT_EMAIL` : API injoignable, budget d'erreur (5xx > 1 % sur 1 h), taux de 5xx, p95 `GET` > 500 ms et `POST` > 800 ms pendant 10 min, limiteur en repli mémoire, file de notifications jamais vidée en 10 min, antivirus `down` (sonde de `/health/ready`), certificat < 14 jours, sauvegarde absente > 26 h, test de restauration en échec ou absent.
- **Alerte de test** : `docker compose … exec alertmanager amtool alert add GhmtTest severity=warning --annotation=summary="Alerte de test" --alertmanager.url=http://localhost:9093`, puis vérifier la réception de l'e-mail.

Vérifications (en plus de celles ci-dessus) :

```bash
infra/observability/test/check.sh          # promtool (règles et tests), amtool, otelcol validate, compose, ports, réseau observability, digests
infra/backup/test/roundtrip.sh             # lib.sh, sauvegarde -> restauration -> tronquée -> forgée, rétention (pile de dev)
# Le port de métriques n'est joignable ni depuis l'hôte ni via Traefik
curl -m 3 http://localhost:9464/metrics    # attendu : échec de connexion
curl -k -o /dev/null -w '%{http_code}\n' https://$DOMAIN/metrics   # attendu : réponse du BFF (pas de métriques)
# Aucun secret, jeton ni nom de patient dans les journaux et les traces (Loki, Tempo) : recherche par motif dans Grafana Explore
```

## Astreinte : téléphone perdu ou second facteur inaccessible (docs/11 §14.3.5)

Un soignant dont le téléphone est perdu (la nuit, en garde) ne peut pas s'enrôler seul hors du réseau de l'établissement. Prévoir **avant** la mise en production :

1. **Au moins deux administrateurs avec un TOTP actif** par établissement (le principal et un second) : la console l'affiche. Un seul administrateur est un point de défaillance.
2. Le soignant utilise d'abord un **code de secours** (remis à l'enrôlement). Sans code de secours : il appelle l'administrateur d'astreinte.
3. L'administrateur **vérifie l'identité de la personne en face à face ou par rappel sur un numéro connu** (jamais par le numéro qui appelle), puis utilise « Réinitialiser le second facteur » avec un **motif** (obligatoire, journalisé). Les sessions de la personne sont coupées ; elle s'enrôle de nouveau, sur le réseau de l'établissement ou avec le code reçu par e-mail.
4. Si la personne n'a pas non plus accès à son e-mail : **code d'enrôlement remis en main propre** (sur site, réseau de confiance) ou changement d'adresse par un administrateur après la même vérification d'identité.
5. Si aucun administrateur n'est joignable : transfert du principal (ci-dessous), puis réinitialisation.

## Transfert de l'administrateur principal (départ ou indisponibilité)

Le transfert normal se fait dans la console (`/administration/securite`, principal + code TOTP). Si le principal est parti ou injoignable, procédure **hors console**, par un opérateur de la plateforme sur un terminal de l'infrastructure :

1. **Demande écrite de la direction** de l'établissement (courrier ou e-mail signé du directeur, conservé), nommant le nouvel administrateur principal. Aucune demande par téléphone seul.
2. **Second opérateur** : une deuxième personne de l'exploitation contrôle la demande, l'identité du demandeur (rappel sur un numéro connu) et l'adresse du nouveau principal avant l'exécution.
3. Exécution (rôle de migration, terminal interactif obligatoire ; la sortie ne doit pas être redirigée) :

```bash
cd apps/api && node scripts/transfer-tenant-owner.mts \
  --tenant <slug> --email <nouveau-principal@exemple> \
  --operator <identifiant-opérateur> --reason "<référence de la demande écrite>"
```

   - Le nouvel administrateur doit être un administrateur actif **avec un TOTP actif** ; `--allow-without-totp` n'est à utiliser qu'en dernier recours (journalisé).
   - `--grant-admin` : crée l'affectation `tenant_admin` (auditée) si aucun administrateur n'existe plus.
   - Opérateur, utilisateur du système d'exploitation et hôte sont inscrits dans l'audit (`iam.owner.transferred`, `via: cli`) ; les directeurs sont notifiés.
4. Contrôler l'audit de l'établissement et informer la direction par écrit.
