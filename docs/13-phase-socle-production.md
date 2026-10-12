# 13 — Phase « Socle de production : CI, documents, sauvegardes, observabilité »

> Contrat de phase (2026-10-11, questions du §13 **arbitrées le 2026-10-11** conformément aux recommandations), branche `feat/socle-production`. Phase P13 de `12-schema-de-travail.md`. Référence commune des équipes **CI** (pipeline, qualité, chaîne d'approvisionnement), **DOC** (stockage objet, documents du patient, API et web) et **EXP** (sauvegardes, restauration, observabilité, topologie de déploiement), qui travaillent **en parallèle sans se parler**. Conforme à `01-architecture.md` (§7 à §9), `04-securite-rbac-audit.md` (§8, §9.8 à §9.11), `05-saas-notifications.md` (quotas), `07-conventions-dev.md` et `11-phase-durcissement-securite.md`. **En cas d'écart, ce document prime pour cette phase.** Chemins réels de l'API : `/api/v1/…`. Dates en ISO 8601 UTC.

## 0. Socle, phase 0 et règles du travail parallèle

### 0.1 Socle déjà en place (à réutiliser, ne pas réécrire)
| Élément | Fichier | Usage dans cette phase |
|---|---|---|
| `TenantDb.run / runAs`, RLS forcée | `src/infrastructure/prisma/tenant-db.service.ts` | Table `tenant.files` (DOC). |
| `AuditService.record` | `src/common/audit/audit.service.ts` | Dépôt, téléchargement et suppression d'un document (DOC). |
| `FieldCrypto` (AES-256-GCM, AAD liée au tenant) | `src/common/crypto/field-crypto.service.ts` | Nom d'origine chiffré ; enveloppe des clés de fichier (DOC, D4). |
| Droits du plan, `plan_limit_reached` | `src/common/authz/entitlement-rules.ts`, limite `storageGb` (`packages/shared/src/schemas/subscriptions.ts`) | Quota de stockage (DOC, D6). |
| Catalogue de permissions | `packages/shared/src/permissions/catalog.ts` (`patients:identity_doc:read|create`) | Documents administratifs du patient (DOC, D7). |
| Journaux Pino et masquage | `src/app.module.ts`, `src/common/logging/redact.ts` | Corrélation `traceId` (EXP, D11). |
| Sondes `/health` et `/health/ready` | `src/health.controller.ts` | Ajout des états `storage` et `antivirus` (DOC, contrat figé §5.1). |
| Topologie de référence | `infra/deploy/` (Traefik, secrets Docker, `entrypoint-secrets.sh`) | Nouveaux services et secrets (EXP). |
| Contrôle des digests | `infra/deploy/check-pinned-images.sh` | Exécuté par la CI (CI). |
| BFF, actions serveur, CSP à nonces | `apps/web/src/proxy.ts`, `apps/web/src/actions/*` | Dépôt et téléchargement via le BFF (DOC, D3). |

### 0.2 Phase 0 — exécutée par l'orchestrateur **avant** le lancement des équipes (un seul commit)
1. Variables d'environnement du §8 dans `env.ts` et `.env.example` (valeurs par défaut sûres, fonctionnalités désactivées si non configurées), et leurs tests.
2. `infra/docker-compose.yml` : service de stockage objet S3 (D2) et `clamav` épinglés par digest ; script d'init `infra/postgres/init/02-test-database.sql` (crée `ghmt_test` avec les mêmes droits que `ghmt`, dev uniquement).
3. Permission `patients:identity_doc:delete` ajoutée au catalogue et aux modèles de rôles (§4), test du catalogue ; migration `20261012000000_identity_doc_permissions` (permission et rattrapage des rôles système des établissements existants, idempotente).
4. Squelette vide `src/modules/files/files.module.ts` enregistré dans `app.module.ts`, et `src/infrastructure/storage/` (interface `ObjectStorage`, sans implémentation).
5. Plages de migrations réservées : DOC `20261012000100` à `20261012000199`, EXP `20261012000200` à `20261012000299`.

### 0.3 Règles du travail parallèle
- Chaque équipe ne modifie que les fichiers de sa colonne au §10. Un fichier commun est modifié par la phase 0 seulement.
- Les contrats figés (§5, §6, §7, §8) ne changent pas pendant la phase sans arbitrage de l'orchestrateur.
- TDD obligatoire (test d'abord), suites vertes à chaque commit d'équipe, pas de commit ni de push sans accord de l'utilisateur.

## 1. Objectif et périmètre

### 1.1 Objectif
Rendre la plateforme **exploitable en production** : aucune modification n'entre dans `main` sans pipeline vert, les données sont sauvegardées et la restauration est prouvée, les documents ont un stockage sûr et isolé par établissement, et l'équipe voit ce qui se passe en production.

### 1.2 Périmètre
| Volet | Livrable | Équipe |
|---|---|---|
| CI | GitHub Actions : installation figée, lint, typecheck, tests unitaires et e2e sur PostgreSQL 17 + Redis 7, build des images, contrôle des digests, contrôle des migrations, gitleaks, `pnpm audit`, Trivy, CodeQL | CI |
| Qualité | ESLint sur `apps/api` et `packages/shared` (règles de sécurité : interdiction de `$queryRawUnsafe`, `$executeRawUnsafe`, `eval`) ; correction des violations | CI |
| Chaîne d'approvisionnement | Images publiées sur GHCR depuis `main` avec SBOM et signature cosign ; mises à jour de dépendances automatisées (§13 Q6) | CI |
| Stockage objet | Adaptateur S3 (`@aws-sdk/client-s3`), buckets `quarantine` et `documents`, chiffrement d'enveloppe par fichier | DOC |
| Documents du patient | Dépôt, liste, téléchargement et suppression des documents administratifs (pièce d'identité, carte d'assurance, justificatif) ; antivirus ClamAV ; quota `storageGb` ; audit ; écran dans la fiche patient | DOC |
| Sauvegardes | Rôle `ghmt_backup`, sauvegarde logique quotidienne chiffrée (`age`) vers un bucket immuable, script de restauration et test de restauration automatisé avec rapport | EXP |
| Observabilité | OpenTelemetry (traces HTTP, PostgreSQL, Redis, Prisma), `traceId` dans les journaux, métriques Prometheus sur un port interne, Collector, règles d'alerte des SLO de `01` §8.2 ; profil `observability` (Prometheus, Grafana, Loki, Tempo) | EXP |
| Topologie | `compose.prod.yml` : stockage objet externe (secrets), `clamav`, Collector ; runbook sauvegarde et restauration | EXP |

### 1.3 Hors périmètre (renvoyé à la roadmap)
- Dossier clinique et documents médicaux (comptes rendus, résultats) : P17, qui réutilisera le module `files`.
- PDF générés (Gotenberg), vignettes d'images, DICOM : avec leurs modules.
- KMS ou Vault et rotation des clés : P14 (seul l'enveloppement change, D4).
- Ancrage WORM du journal d'audit : P14.
- Export logique **par établissement** et restauration ciblée d'un tenant (`04` §8.5) : P14, avec les droits du patient (portabilité).
- Environnement de préproduction et déploiement continu : absence d'hébergement cible (§13 Q8).
- Sentry et suivi d'erreurs côté navigateur : localisation des données à arbitrer (`01` §9.5).
- Tests e2e Playwright et tests de charge k6 : P16.

## 2. Décisions d'architecture

| # | Décision |
|---|---|
| D1 | **CI GitHub Actions** sur `pull_request` et `push` sur `main`. Les tests e2e tournent contre la pile `infra/docker-compose.yml` démarrée dans le job (pas de services GitHub : l'init des rôles doit être montée). Le `.env.test` est généré dans le job avec des secrets aléatoires ; aucun secret de dépôt n'est nécessaire pour les PR. Le dépôt étant public, aucune étape n'affiche de variable d'environnement. Branche `main` protégée : CI verte obligatoire. |
| D2 | **Stockage objet** : le code ne dépend que de l'API S3 (`ObjectStorage`, chemin de style « path » configurable). Fournisseur de dev et de test, et fournisseur de production : §13 Q1. |
| D3 | **Dépôt et téléchargement via le BFF et l'API**, sans URL pré-signée exposée au navigateur (écart assumé avec `01` §7.2) : le navigateur ne parle jamais qu'au BFF, la CSP reste `connect-src 'self'`, le stockage n'a aucun port public. Dépôt en multipart en flux continu, 10 Mo maximum, contrôlé au BFF, à Traefik et à l'API. Téléchargement en flux par l'API avec `Content-Disposition: attachment`, `Content-Type` fixé par le serveur et `X-Content-Type-Options: nosniff`. |
| D4 | **Chiffrement d'enveloppe par fichier** : une clé de données AES-256-GCM aléatoire par fichier, chiffrée par `FieldCrypto` (AAD `tenant:files:<id>`) et stockée dans `tenant.files.wrapped_key`. L'objet stocké est chiffré ; le stockage ne voit jamais de contenu en clair. En P14, seul l'enveloppement passe au KMS, sans réécrire les objets. Le chiffrement côté serveur du fournisseur reste activé en plus. |
| D5 | **Antivirus** : le fichier est d'abord écrit (chiffré) dans `quarantine`, puis analysé par `clamd` (INSTREAM, sur le flux en clair, délai 30 s). Sain : copie vers `documents`, statut `available`. Infecté, ou type réel hors liste blanche : suppression, statut `rejected`, événement d'audit `files.file.rejected`. `clamd` indisponible : statut `pending`, une tâche planifiée réessaie toutes les 5 min pendant 24 h, puis `rejected` (`scan_unavailable`). Un fichier qui n'est pas `available` n'est **jamais** servi. |
| D6 | **Quota** : avant tout dépôt, somme des `size_bytes` des fichiers `pending` et `available` du tenant, comparée à `storageGb` du plan ; dépassement : `403 plan_limit_reached` `{ limit, current }` (règle existante). Pas de table de compteurs au MVP (index sur `(tenant_id, status)`). |
| D7 | **Premier usage : documents administratifs du patient** (`purpose` : `identity`, `insurance_card`, `administrative`), permissions existantes `patients:identity_doc:read|create` et nouvelle `patients:identity_doc:delete`. Les documents cliniques arrivent en P17 avec leurs propres `purpose` et permissions. |
| D8 | **Type et nom** : type réel détecté sur le contenu (`file-type`), liste blanche PDF, JPEG, PNG, WebP ; le type déclaré ne fait pas foi. PDF contenant du JavaScript (`/JS`, `/JavaScript`) : refusé. Métadonnées EXIF retirées des images avant stockage. Nom d'origine assaini, chiffré en base, jamais utilisé dans la clé d'objet (`t/{tenantId}/files/{yyyy}/{mm}/{fileId}`). |
| D9 | **Sauvegardes** : la base de production étant gérée (topologie de référence), le PITR relève du fournisseur ; GHMT ajoute une **sauvegarde logique quotidienne** indépendante du fournisseur : `pg_dump -Fc` avec le rôle `ghmt_backup` (`BYPASSRLS`, lecture seule), chiffrée avec une clé publique `age` (clé privée hors ligne, jamais sur l'hôte), déposée dans un bucket à verrouillage d'objet avec des identifiants distincts de ceux de l'application. Rétention : 35 quotidiennes, 12 mensuelles. Pour une base auto-hébergée, pgBackRest est documenté dans le runbook. Les documents relèvent du versionnage et de la réplication du bucket. |
| D10 | **Test de restauration automatisé** : `infra/backup/restore-test.sh` restaure la dernière sauvegarde dans un PostgreSQL jetable, applique les contrôles (comptage par table, `prisma migrate status`, vérification de la chaîne d'audit de chaque tenant, RLS toujours forcée), mesure la durée et écrit un rapport JSON. Exécuté par la CI chaque nuit sur un aller-retour sauvegarde puis restauration de la base de test, et chaque semaine en production (cron de l'hôte). Un échec déclenche une alerte. |
| D11 | **Observabilité** : `@opentelemetry/sdk-node` démarré avant Nest (`src/instrumentation.ts`), exportation OTLP vers le Collector, échantillonnage 10 % et 100 % des erreurs ; `traceId` et `spanId` injectés dans chaque ligne Pino. Métriques `prom-client` sur `METRICS_PORT` (9464), **jamais routé par Traefik**. `tenantId` présent dans les traces et journaux, jamais comme label de métrique. Le Collector masque les attributs sensibles (`http.request.header.authorization`, corps, paramètres de requête). |
| D12 | **Alertes initiales** (règles Prometheus) : disponibilité API, p95 `GET` > 500 ms pendant 10 min, p95 `POST` > 800 ms, taux de 5xx, limiteur en repli mémoire (`checks.rateLimit`), file de notifications en retard, sauvegarde absente depuis plus de 26 h, test de restauration en échec, antivirus indisponible, certificat < 14 jours. Destination : e-mail de l'astreinte (`ALERT_EMAIL`). |

## 3. Modèle de données

### 3.1 Équipe DOC — `prisma/schema/files.prisma`, migration `20261012000100_files`
`tenant.files` (RLS activée **et forcée**, politique `tenant_id = current_setting('app.tenant_id')::uuid`, droits DML à `ghmt_app`) :

| Colonne | Type | Règle |
|---|---|---|
| `id` | uuid (v7) | clé primaire |
| `tenant_id` | uuid | FK `platform.tenants`, non nul |
| `purpose` | enum `file_purpose` (`identity`, `insurance_card`, `administrative`) | non nul |
| `patient_id` | uuid nullable | FK `tenant.patients` ; obligatoire pour les trois `purpose` actuels (contrainte CHECK) |
| `status` | enum `file_status` (`pending`, `available`, `rejected`, `deleted`) | non nul, défaut `pending` |
| `reject_reason` | enum (`infected`, `type_not_allowed`, `active_content`, `scan_unavailable`) nullable | non nul si et seulement si `rejected` |
| `object_key` | text | unique ; jamais de nom ni de donnée patient |
| `wrapped_key` | bytea | clé de données chiffrée (D4) |
| `original_name` | bytea | chiffré (`FieldCrypto`) |
| `mime_type` | text | type **détecté** |
| `size_bytes` | bigint | > 0 et ≤ 10 Mo |
| `sha256` | char(64) | empreinte du contenu en clair |
| `created_by` | uuid | FK `tenant.users` |
| `created_at`, `available_at`, `deleted_at` | timestamptz | `deleted_at` non nul si et seulement si `deleted` |
| `scan_attempts` | smallint | défaut 0 |

Index : `(tenant_id, patient_id, created_at DESC) WHERE status = 'available'`, `(tenant_id, status)`.

### 3.2 Équipe EXP — migration `20261012000200_backup_role`
Rôle `ghmt_backup` : `LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`, `CONNECT` et `USAGE` sur les schémas, `SELECT` sur toutes les tables et séquences, privilèges par défaut pour les tables futures. Mot de passe fixé hors migration (secret `backup_database_url`). La migration n'accorde **aucune** écriture.

## 4. Permissions
| Permission | Sensible | Rôles système qui la reçoivent |
|---|---|---|
| `patients:identity_doc:read` (existante) | oui | réceptionniste, agent administratif, médecin, infirmier, sage-femme, caissier (§13 Q5) |
| `patients:identity_doc:create` (existante) | non | réceptionniste, agent administratif |
| `patients:identity_doc:delete` (nouvelle) | oui | agent administratif |

Le téléchargement d'un document est une lecture de donnée sensible : il est audité (`files.file.downloaded`) comme la lecture d'un dossier patient.

## 5. Contrats d'API — Équipe DOC (`modules/files`, contrôleur `patients/:patientId/documents`)

| Méthode et chemin | Permission | Corps et réponse | Erreurs |
|---|---|---|---|
| `POST /patients/:patientId/documents` | `patients:identity_doc:create` | multipart : `file` (≤ 10 Mo), `purpose` ; 201 `PatientDocumentView` (`status` `available`, ou `pending` si l'antivirus est indisponible) | 404 `patient_not_found`, 413 `file_too_large`, 415 `type_not_allowed`, 422 `active_content` ou `infected`, 403 `plan_limit_reached`, 503 `storage_unavailable` |
| `GET /patients/:patientId/documents` | `patients:identity_doc:read` | 200 `{ items: PatientDocumentView[] }` (statuts `available` et `pending`, 100 au plus, plus récents d'abord) | 404 `patient_not_found` |
| `GET /patients/:patientId/documents/:id/content` | `patients:identity_doc:read` | 200 flux binaire, `Content-Disposition: attachment; filename*=…`, `Cache-Control: no-store` | 404 `document_not_found` (y compris non `available`) |
| `DELETE /patients/:patientId/documents/:id` | `patients:identity_doc:delete` | corps `{ reason }` (5 à 500 caractères) ; 204 ; objet supprimé du stockage, ligne passée à `deleted` | 404 `document_not_found` |

`PatientDocumentView` : `{ id, purpose, status, originalName, mimeType, sizeBytes, createdAt, createdBy: { id, fullName } }`. Événements d'audit : `files.file.uploaded`, `files.file.rejected`, `files.file.downloaded`, `files.file.deleted` (motif en `changes`, jamais le contenu).

### 5.1 Sonde `/health/ready` (contrat figé)
Ajout de `checks.storage` (`up`, `down`, `disabled`) et `checks.antivirus` (`up`, `down`, `disabled`). La sonde publique `/health` reste `{ status }`.

## 6. Contrats d'exploitation — Équipe EXP

### 6.1 Scripts (`infra/backup/`)
| Script | Rôle | Sortie |
|---|---|---|
| `backup.sh` | `pg_dump -Fc` (rôle `ghmt_backup`), chiffrement `age -r "$BACKUP_AGE_RECIPIENT"`, dépôt `s3://$BACKUP_BUCKET/postgres/{yyyy}/{mm}/{dd}/ghmt-{horodatage}.dump.age` avec somme SHA-256 | Code de sortie et une ligne JSON `{ status, key, bytes, sha256, durationMs }` |
| `restore-test.sh` | Récupère la dernière sauvegarde, déchiffre (clé privée fournie par fichier, jamais en argument), restaure dans un PostgreSQL jetable, contrôles de D10 | Rapport JSON `{ status, backupKey, restoreMs, checks: {…} }` ; code non nul si un contrôle échoue |
| `prune.sh` | Applique la rétention de D9 quand le fournisseur n'a pas de règle de cycle de vie | — |

Les scripts n'affichent jamais de secret ni de chaîne de connexion ; ils lisent les secrets depuis des fichiers (`*_FILE`), comme `entrypoint-secrets.sh`.

### 6.2 Topologie (`infra/deploy/compose.prod.yml`)
- Services ajoutés : `clamav` (réseau `data`, aucun port), `otel-collector` (réseaux `edge` et `egress`), tâche `backup` (profil `tools`, lancée par le cron de l'hôte).
- Profil `observability` : Prometheus, Grafana, Loki, Tempo sur un réseau interne (exposition de Grafana : §13 Q7).
- Secrets ajoutés : `s3_access_key_id`, `s3_secret_access_key`, `backup_database_url`, `backup_s3_access_key_id`, `backup_s3_secret_access_key`, `backup_age_recipient`.
- Traefik : limite de corps de 11 Mo sur le routeur `web` (middleware `buffering`).

## 7. Schémas Zod partagés (`packages/shared/src/schemas/files.ts`, DOC)
`filePurposeSchema`, `fileStatusSchema`, `patientDocumentViewSchema`, `deleteDocumentSchema` (`reason`), constantes `MAX_UPLOAD_BYTES = 10 * 1024 * 1024` et `ALLOWED_UPLOAD_TYPES`. Exportés par `schemas/index.ts` (la phase 0 ajoute la ligne d'export).

## 8. Variables d'environnement (phase 0)
| Variable | Défaut | Règle |
|---|---|---|
| `FILES_ENABLED` | `false` | `true` exige les variables `S3_*` ; en production, `true` exige aussi `CLAMAV_HOST` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | —, `us-east-1`, `true` | `https` obligatoire en production |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | secrets (`*_FILE` en production) |
| `S3_BUCKET_QUARANTINE`, `S3_BUCKET_DOCUMENTS` | `ghmt-dev-quarantine`, `ghmt-dev-documents` | distincts |
| `CLAMAV_HOST`, `CLAMAV_PORT` | —, `3310` | absent hors production : analyse ignorée avec avertissement au démarrage ; **refus** au démarrage en production |
| `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | `false`, —, `ghmt-api` | `true` exige l'endpoint |
| `METRICS_PORT` | `9464` | port interne, distinct de `PORT` |
| `ALERT_EMAIL` | — | utilisé par Alertmanager (infra), pas par l'API |

## 9. Front — Équipe DOC (`apps/web`)
- Fiche patient : bloc « Documents » (liste, dépôt, téléchargement, suppression avec motif), affiché selon les permissions.
- Dépôt par action serveur qui relaie le flux à l'API (D3) ; contrôle de taille côté client et côté BFF ; messages : « Fichier trop volumineux (10 Mo au plus) », « Type de fichier non accepté (PDF, JPEG, PNG, WebP) », « Fichier refusé par l'analyse antivirus », « Espace de stockage de votre abonnement atteint ».
- Téléchargement par une route du BFF (`/patients/[id]/documents/[docId]/contenu`) qui relaie le flux et ses en-têtes ; aucune URL de stockage dans le HTML.
- Statut `pending` affiché « Analyse en cours », sans lien de téléchargement.

## 10. Répartition des fichiers (aucun chevauchement)
| Équipe CI | Équipe DOC | Équipe EXP |
|---|---|---|
| `.github/workflows/*`, `.github/dependabot.yml`, `.gitleaks.toml` | `src/modules/files/**`, `src/infrastructure/storage/**` (implémentations S3 et ClamAV) | `src/instrumentation.ts`, `src/common/metrics/**`, `src/common/logging/trace-context.ts` |
| `apps/api/eslint.config.mjs`, `packages/shared/eslint.config.mjs`, scripts `lint` des deux paquets | `prisma/schema/files.prisma`, migration `20261012000100_files` | migration `20261012000200_backup_role` |
| Corrections de lint dans `apps/api/src/**` **hors** dossiers des autres équipes ; un fichier d'une autre équipe concerné est signalé à l'orchestrateur | `packages/shared/src/schemas/files.ts` (+ tests) | `infra/backup/**`, `infra/deploy/compose.prod.yml`, `infra/deploy/traefik/**`, `infra/observability/**` |
| `scripts/ci/**` (génération de `.env.test`, contrôle des migrations) | `apps/web/src/**/documents/**`, `apps/web/src/actions/patient-documents.ts`, bloc de la fiche patient | `infra/deploy/README.md` (runbook sauvegarde, restauration, observabilité) |
| | `src/health.controller.ts` (états `storage`, `antivirus`) | |

## 11. Ordre TDD et critères de vérification

### 11.1 Équipe CI
1. Workflow `ci.yml` : `pnpm install --frozen-lockfile`, `turbo lint typecheck test build` ; e2e contre la pile de dev ; le job échoue si une suite échoue.
2. Contrôle des migrations : `prisma migrate diff --from-migrations --to-schema` vide, et chaque table `tenant.*` a RLS activée et forcée (requête sur `pg_class`).
3. `security.yml` : gitleaks (liste d'exclusion documentée pour les valeurs de développement), `pnpm audit --audit-level=high`, Trivy FS, CodeQL.
4. `images.yml` : build API, migration et web à chaque PR ; sur `main`, publication GHCR, SBOM et signature cosign sans clé (OIDC).
5. Lint de l'API : zéro erreur ; règle interdisant `$queryRawUnsafe` et `$executeRawUnsafe` prouvée par un test de règle.
- **Vérification** : une PR qui casse un test, un type ou une migration, ou qui introduit un secret factice, est bloquée (démontré sur une PR d'essai).

### 11.2 Équipe DOC
1. Adaptateur S3 : `put`, `get` en flux, `copy`, `delete` contre le stockage de dev (test d'intégration).
2. Chiffrement d'enveloppe : aller-retour, clé de données unique par fichier, objet stocké illisible sans `wrapped_key`, AAD liée au tenant (un autre tenant ne déchiffre pas).
3. Détection de type, refus des types hors liste, PDF à contenu actif, retrait EXIF.
4. ClamAV : fichier EICAR rejeté (`infected`), fichier sain accepté ; `clamd` coupé : `pending` puis reprise par la tâche.
5. Quota : refus `plan_limit_reached` au-delà de `storageGb`.
6. API : permissions, 404 pour un patient d'un autre tenant, audit de chaque opération, téléchargement d'un `pending` : 404.
7. **Isolation** : un utilisateur du tenant B ne liste ni ne télécharge un document du tenant A, même en connaissant son `id`.
8. Web : bloc Documents (rendu selon les permissions, messages d'erreur, statut « Analyse en cours »).
- **Vérification** : couverture ≥ 80 % sur `modules/files` et `infrastructure/storage`.

### 11.3 Équipe EXP
1. Migration du rôle `ghmt_backup` : lecture de toutes les tables d'un tenant sans contexte, refus de toute écriture.
2. `backup.sh` puis `restore-test.sh` sur la base de test : rapport `status: ok`, comptages identiques, chaîne d'audit valide.
3. Corruption volontaire (sauvegarde tronquée) : `restore-test.sh` échoue avec un code non nul.
4. OpenTelemetry : une requête produit une trace dont le `traceId` figure dans la ligne de journal ; aucun en-tête `authorization` ni corps dans les attributs exportés.
5. `/metrics` sur `METRICS_PORT` : histogramme de latence par route, sans label `tenantId` ; injoignable via Traefik.
6. Règles d'alerte validées par `promtool test rules`.

## 12. Test de fumée réel (fin de phase)
1. **CI** : PR d'essai rouge (test cassé) bloquée ; PR verte fusionnable ; image publiée sur GHCR et signature vérifiée par `cosign verify`.
2. **Documents**, dans un navigateur : dépôt d'un PDF et d'une photo d'identité, téléchargement, contenu identique (SHA-256) ; fichier EICAR refusé avec le bon message ; PDF de 12 Mo refusé ; fichier `.exe` renommé en `.pdf` refusé.
3. **Isolation** : l'identifiant d'un document du tenant A, demandé par un utilisateur du tenant B, renvoie 404 ; l'objet lu directement dans le bucket est chiffré.
4. **Quota** : plan réduit à une limite basse, dépôt refusé avec le message d'abonnement.
5. **Antivirus coupé** : dépôt en « Analyse en cours », puis disponible après redémarrage de `clamd` et passage de la tâche.
6. **Sauvegarde** : `backup.sh` en topologie de prod, objet chiffré dans le bucket immuable (suppression refusée) ; `restore-test.sh` vert, durée consignée.
7. **Observabilité** : une connexion apparaît comme trace dans Tempo et sa ligne de journal dans Loki partage le `traceId` ; une alerte de test arrive par e-mail ; aucun secret, jeton ni nom de patient dans les traces et les journaux (`grep`).
8. **Topologie** : `web`, `api`, `clamav`, le stockage et `METRICS_PORT` ne sont pas joignables depuis l'extérieur ; seul Traefik publie des ports.

## 13. Questions ouvertes
Toutes arbitrées par l'utilisateur le 2026-10-11, conformément aux recommandations ci-dessous. Elles valent décisions pour la phase.

1. **Fournisseur S3.** *Essai de la phase 0 (2026-10-11)* : SeaweedFS 4.48 réussit écriture, lecture en flux, copie, suppression et verrouillage d'objet (suppression d'une version verrouillée refusée) ; Garage v2.1.0 accepte l'en-tête de verrouillage sans l'appliquer (`ListObjectVersions` non implémenté). **SeaweedFS est retenu** pour le dev et la CI. Recommandation : en dev et en test, un serveur S3 libre et léger (Garage ou SeaweedFS, choix final après un essai de la phase 0 sur `PutObject`, `GetObject` en flux, `CopyObject` et le verrouillage d'objet) ; en production, le stockage objet du fournisseur de la cellule, dans la même juridiction. MinIO n'est pas réintroduit.
2. **Dépôt via le BFF (D3) plutôt que par URL pré-signée.** Recommandation : oui pour les documents administratifs (≤ 10 Mo) ; l'URL pré-signée sera réexaminée en P17 pour les gros fichiers (imagerie).
3. **Antivirus dès P13 (D5).** Recommandation : oui. ClamAV demande environ 1,5 Go de mémoire, mais c'est une exigence de `04` §9.8, et un fichier non analysé n'est jamais servi.
4. **Sauvegarde logique en plus du PITR du fournisseur (D9).** Recommandation : oui, pour ne pas dépendre d'un seul fournisseur et prouver la restauration nous-mêmes.
5. **Qui lit les documents administratifs.** Recommandation : accueil, agents administratifs, soignants et caissier (vérification de la carte d'assurance) ; pas l'administrateur ni le directeur. *Révisé le 2026-10-11* : la suppression est réservée aux agents administratifs ; l'administrateur, qui n'a pas la lecture, ne la reçoit pas (il ne verrait pas les documents).
6. **Mises à jour des dépendances.** Recommandation : Dependabot (natif GitHub, aucune application à installer), regroupé par écosystème, hebdomadaire ; Renovate si un regroupement plus fin devient nécessaire.
7. **Exposition de Grafana.** Recommandation : pas d'exposition publique au MVP, accès par tunnel SSH ; exposition derrière Traefik avec SSO à partir de P16.
8. **Préproduction.** Recommandation : hors P13 tant qu'aucun hébergement n'est choisi ; la CI publie des images signées prêtes à déployer, et le test de fumée se joue en topologie de prod locale, comme au §12 de `11`.

## 14. Revues de fin de phase (2026-10-12)
Revues sécurité et santé du diff complet : aucun constat critique, 2 hauts, 5 moyens. Arbitrages de l'utilisateur, le 2026-10-12 (ils valent décisions pour la phase) :

1. **Contenu actif des PDF (D8 durci).** Analyse en une passe, bornée en nombre de flux et en volume décompressé, en **échec fermé** : refus d'un PDF chiffré, d'un flux illisible ou trop volumineux, d'un filtre non géré (les filtres d'image sont acceptés sans décodage), et des noms `/JS`, `/JavaScript`, `/Launch`, `/EmbeddedFile(s)`, `/RichMedia`, `/XFA`, y compris sous forme encodée. `/OpenAction` et `/AA` restent acceptés (PDF scannés légitimes). Aucune bibliothèque de désinfection ajoutée.
2. **Suppression d'un document.** Effacement cryptographique : la clé enveloppée est effacée de la ligne `deleted` (contrainte en base) ; les objets sont supprimés après la validation de la transaction ; le bucket `documents` reçoit une règle d'expiration des versions non courantes (30 jours). Les clés des documents supprimés subsistent dans les sauvegardes pendant leur rétention.
3. **Authenticité des sauvegardes.** Le test de restauration est isolé dès P13 (PostgreSQL jetable sans secret ni variable S3, clé privée `age` lue seulement pendant le déchiffrement) ; la **signature du manifeste** par une clé hors ligne est reportée en **P14**, avec l'ancrage WORM du journal d'audit.
4. **Réseaux d'observabilité.** Collector et services d'observabilité sur le seul réseau `observability`, rejoint par l'API ; `web`, `traefik`, `clamav` et les tâches de sauvegarde n'y ont pas accès. Pas de jeton sur `/metrics` ni sur OTLP au MVP.
5. **Messages d'erreur dans les traces.** Les événements `exception` ne gardent que le type et le message de statut est générique, dans l'API et dans le Collector.
6. **Publication des images.** Le digest publié est analysé par Trivy (HIGH et CRITICAL corrigeables) avant la signature cosign.
