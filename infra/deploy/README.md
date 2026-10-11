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
infra/deploy/check-pinned-images.sh infra/docker-compose.yml infra/deploy/compose.prod.yml
```

Le health check de l'API est `GET /api/v1/health` ; celui du BFF présente le secret de bordure (sinon `proxy.ts` répondrait 403).

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
