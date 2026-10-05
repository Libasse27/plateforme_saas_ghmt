# 10 — Phase « Notifications + console d'administration de l'établissement »

> Contrat de phase (2026-10-05), branche `feat/notifications-admin`. Référence commune des équipes **N** (notifications), **A** (API d'administration) et **W** (web), qui travaillent **en parallèle sans se parler**. Ce document est conforme à `05-saas-notifications.md` (partie B et A9 « Relances »), `06-roadmap-mvp.md` (E4, E7, E8, E11, E13, US-130 à US-135, US-156), `04-securite-rbac-audit.md` (§3 et §7), `03-api.md` et `07-conventions-dev.md`. **En cas d'écart, ce document prime pour cette phase.** Chemins réels de l'API : `/api/v1/…`. Dates en ISO 8601 UTC. Montants en chaînes décimales.

## 0. Socle, phase 0 et règles du travail parallèle

### 0.1 Socle déjà en place (à réutiliser, ne pas réécrire)
| Élément | Fichier | Usage dans cette phase |
|---|---|---|
| `TenantDb.run / runAs / runWithoutTenant` | `src/infrastructure/prisma/tenant-db.service.ts` | Tout accès aux tables tenant. Les jobs utilisent `runAs(tenantId)`. |
| `PlatformDb` | `src/infrastructure/prisma/platform-db.service.ts` | Liste des établissements (`platform.tenants`), factures SaaS, table `platform.sms_recipient_tenants`. |
| `AuditService.record` / `auditPayload` / `verifyChain` / `GENESIS_HASH` | `src/common/audit/*` | Audit dans la transaction (acteur `system` pour les jobs). Vérification de chaîne (A, **import en lecture seule**). |
| `MAILER` (`SmtpMailer` / `MemoryMailer`) | `src/common/mail/*` | Canal e-mail. L'invitation (`buildInvitationEmail`) reste **inchangée**. |
| `FieldCrypto` | `src/common/crypto/field-crypto.service.ts` | `decrypt(tenantId, phone_enc / email_enc)` au moment de l'envoi. `blindIndex(tenantId, e164)` pour STOP. |
| `EntitlementService.getInTx(tx)` | `src/common/authz/entitlement.service.ts` | Lecture de `limits.smsMonthly` (`null` = illimité, tenant sans abonnement = illimité). |
| `scopesFor`, `buildPatientScopeFilter` | `src/common/authz/authorization.service.ts`, `src/modules/patients/domain/patient-scope.ts` | Portées (import en lecture seule). |
| `DomainEventBus` | `src/common/events/domain-event-bus.ts` | N s'abonne à `payment.succeeded`. Aucun nouvel événement de bus. |
| `Clock`, `MutableClock` | `src/common/time/clock.ts`, `test/helpers/mutable-clock.ts` | Toute règle datée. |
| `loadTenantProfile(tx)` | `src/infrastructure/tenancy/tenant-profile.ts` | Nom, fuseau, devise du tenant. |
| `Page.fromRows`, `decodeUuidCursor` | `src/common/pagination/page.ts` | Curseurs validés (A ajoute son propre décodeur de `chainSeq` dans son module). |
| `@AuthenticatedOnly`, `@RequirePermission`, `@Public`, `@AllowWhenSuspended` | `src/common/decorators/*` | Refus par défaut. |
| `readRawBody` | `src/modules/payments/controllers/raw-body.ts` | Corps brut des webhooks SMS (import en lecture seule ; `bootstrap.ts` conserve déjà le corps brut de tout `/api/v1/webhooks/*`). |
| Endpoints IAM, organisation, praticiens | `modules/iam`, `modules/org`, `modules/appointments` | Utilisés tels quels par W (§9.4). |

### 0.2 Phase 0 — exécutée par l'orchestrateur **avant** le lancement des équipes (un seul commit)
Commit `chore: socle de la phase notifications et administration`, qui contient :
1. `packages/shared/src/permissions/catalog.ts` : `settings.notification_log: ['read']`.
2. `packages/shared/src/permissions/role-templates.ts` : ajout de `'audit:log:export'` aux motifs de `tenant_admin`. `settings:notification_log:read` est déjà couvert par `settings:*:*` (tenant_admin) et `settings:*:read` (director).
3. `packages/shared/src/schemas/notifications.ts` et `packages/shared/src/schemas/admin.ts` : fichiers vides (commentaire d'en-tête + `export {};`), exportés depuis `packages/shared/src/schemas/index.ts` (`export * from './notifications'; export * from './admin';`).
4. `apps/api/src/modules/notifications/notifications.module.ts` et `apps/api/src/modules/admin/admin.module.ts` : `@Module({})` vides, importés dans `apps/api/src/app.module.ts`.
5. Vérification : `pnpm --filter @ghmt/shared build && pnpm --filter @ghmt/shared test && pnpm --filter api typecheck`.

Après la phase 0, **aucune équipe ne modifie** `catalog.ts`, `role-templates.ts`, `schemas/index.ts` ni `app.module.ts`. Une équipe qui croit en avoir besoin s'arrête et le signale dans son compte rendu.

### 0.3 Règles du travail parallèle
1. Chaque équipe n'écrit **que** dans les fichiers listés pour elle au §10. Les autres fichiers ne sont lus qu'en lecture seule (imports compris).
2. **Schéma Prisma** : N seule ajoute un fichier, `apps/api/prisma/schema/notifications.prisma`. Il ne contient aucun champ de relation vers `core.prisma`, `billing.prisma` ou `platform-saas.prisma` (FK en SQL). Le fichier reste valide à chaque sauvegarde (`prisma validate`), car les autres équipes régénèrent le client. A n'a pas de modèle Prisma.
3. **Migrations** (plages réservées, sans collision) :

   | Équipe | Migration | Plage des correctifs |
   |---|---|---|
   | N | `20261005000400_notifications` | `20261005000410` à `20261005000490` |
   | A | `20261005000500_admin_console` | `20261005000510` à `20261005000590` |
   | W | aucune | — |

   Procédure : DDL produit par `prisma migrate diff --from-schema <tmp base+core+platform-saas+billing> --to-schema <tmp + son fichier> --script`, complété en SQL (RLS, GRANT, CHECK, fonctions), puis validé sur une base jetable. Le dossier n'est déposé dans `prisma/migrations/` qu'une fois complet, car la base `ghmt_test` est partagée entre les équipes. Une migration déposée n'est **jamais** modifiée : un correctif se fait par une nouvelle migration dans sa plage.
4. Toute table `tenant.*` porte `tenant_id`, RLS ENABLE + FORCE et la politique `tenant_isolation` (boucle de `20261004000200`). Le test `test/core/rls-coverage.e2e-spec.ts` doit rester vert.
5. **W code contre les contrats de ce document sans attendre N ni A.** Il n'importe aucun schéma ni type des fichiers `schemas/notifications.ts` et `schemas/admin.ts` pendant la phase : validations de formulaire locales, mappeurs tolérants (modèle `lib/domain/raw.ts`), API simulée dans ses tests.
6. Les tests e2e n'exécutent jamais de job en tâche de fond : `NOTIFICATIONS_WORKER_ENABLED=false` dans `.env.test`, et chaque job expose `runOnce(now, { tenantIds })`.

## 1. Objectif et périmètre

### 1.1 Objectif
Livrer un socle de notifications fiable et sans donnée de santé (outbox transactionnelle, e-mail, SMS, in-app, rappels de rendez-vous, relances SaaS), plus la console web d'administration de l'établissement : organisation, utilisateurs, rôles, praticiens, journal d'audit, tableau de bord et boîte de notifications.

### 1.2 Périmètre
- **N** : E13 (US-130 à US-135) et US-156. Outbox, dispatcher, canaux e-mail / SMS (sandbox + HTTP générique) / in-app, modèles FR/EN versionnés, linter de confidentialité bloquant, consentement patient et STOP, plages silencieuses, déduplication, retries, journal de livraison, quota SMS, rappels J-1 et H-2, relances de factures SaaS.
- **A** : consultation, export CSV et vérification d'intégrité du journal d'audit (US-042, et la partie API de US-041). Tableau de bord de l'établissement. Rattrapage des permissions des rôles système existants.
- **W** : console web d'administration (§9) et boîte de notifications in-app avec préférences.

### 1.3 Hors périmètre (renvoyé à la roadmap, annexe de `06-roadmap-mvp.md`, rédigée par A)
- **Canaux** :
  - push mobile, Web Push, WebSocket in-app ;
  - disjoncteur et fournisseur SMS de repli ; statut `unknown` faute d'accusé de réception (DLR) sous 24 h ;
  - packs SMS, post-payé, Sender ID personnalisé ;
  - liens courts et jetons patients (aucun lien dans les messages patients) ;
  - jours fériés, digests anti-rafale, métriques Prometheus et alertes.
- **Console web des notifications** : écrans des modèles, des paramètres (plages, translittération) et du journal d'envoi (l'API est livrée par N).
- **Consentement côté fiche patient** : saisie dans l'interface (voir Questions ouvertes). L'API est livrée par N.
- **Données de profil** :
  - téléphone des utilisateurs (SMS au personnel, relances SaaS par SMS) ;
  - langue du patient (tous les patients reçoivent du `fr`).
- **Organisation et agenda** :
  - disponibilités et absences des praticiens (US-111) ;
  - horaires, adresse et téléphone des sites ;
  - indicateur « service sensible » (US-071) ;
  - liste des sessions d'un utilisateur.
- **Audit** : vérificateur planifié quotidien et ancrage WORM (worm = stockage non modifiable), rétention par plan, vue « qui a consulté ce patient ».
- **Notifications des autres modules** : laboratoire, stock, caisse, `auth.*`.
- **Gating** du plan sur la surcharge de modèles (Professional et plus).

## 2. Décisions d'architecture (tranchées)
| # | Décision |
|---|---|
| D1 | **Pas de BullMQ.** Table outbox en PostgreSQL et dispatcher `@nestjs/schedule` (`@Interval`) avec réservation `FOR UPDATE SKIP LOCKED` et bail `locked_until`. *Justification : l'événement est écrit dans la transaction métier sans double écriture base/Redis, sans dépendance nouvelle ; c'est sûr en multi-instance et testable de façon déterministe (`runOnce(now)`). BullMQ reste la cible au-delà d'environ 1 000 établissements actifs ou 50 envois/s.* |
| D2 | **Découverte des tenants à traiter** par `platform.notification_due_tenants(p_limit int)` (`SECURITY DEFINER`, `now()` imposé, uuid seulement, `EXECUTE` à `ghmt_app`), qui parcourt les tenants en posant `app.tenant_id` comme `platform.tenants_usage`. Le dispatcher traite ensuite chaque tenant dans `TenantDb.runAs`. |
| D3 | **Déduplication** par contrainte unique `(tenant_id, dedup_key)` seule, sans Redis (aucun client Redis dans l'API ; la base résiste à tout redémarrage). `dedup_key = sha256(tenantId \| sourceKey \| typeCode \| recipientType:recipientId \| channel \| variante)`. `sourceKey` vaut : l'id de l'événement outbox (confirmation, report, annulation) ; l'id du RDV pour les rappels (variante = `startsAt` ISO) ; l'id de la facture SaaS pour les relances (variante = décalage en jours) ; `quota:<AAAA-MM>` (variante = seuil). |
| D4 | **In-app** : polling REST du compteur toutes les 60 s côté web. WebSocket en roadmap. |
| D5 | **SMS** : interface `SmsProvider` (token `SMS_PROVIDER_TOKEN`). Adaptateurs `sandbox` (mémoire ; copie vers Mailpit en développement ; interdit en production) et `http` (HTTP générique, §5.7). Choix par `SMS_PROVIDER=none\|sandbox\|http`, `none` par défaut : les SMS sont alors `suppressed / provider_unavailable`, avec repli e-mail. Un adaptateur `http` sans URL ni jeton fait échouer le démarrage. Pas de disjoncteur au MVP. |
| D6 | **Numéros et adresses** : jamais stockés en clair hors des colonnes chiffrées du patient. Ils sont déchiffrés **en mémoire au moment de l'envoi**. `notifications` ne conserve que `recipient_masked` (`+22177*****45`, `a***@e***.sn`) et `recipient_hash` (HMAC-SHA256 avec une clé dérivée `HMAC(BLIND_INDEX_KEY, 'ghmt:notifications:recipient')`). Le texte rendu n'est **jamais stocké**, sauf le titre et le corps in-app (personnel uniquement, sans PHI). Les journaux applicatifs ne portent que `notificationId`, `typeCode`, `channel`, `status`, `errorClass`, `errorCode`. |
| D7 | **Événements consommés** : `AppointmentsService` écrit dans `tenant.notification_outbox`, **dans sa transaction**, via la fonction pure `enqueueOutboxEvent(tx, tenantId, event)` (`src/common/notifications/outbox.ts`, propriété N) : `appointment.created`, `appointment.rescheduled`, `appointment.cancelled` (passage au statut `cancelled`), `appointment.deleted`. Relances SaaS : job horaire (lecture `PlatformDb`) et abonnement à `payment.succeeded` (`purpose = saas_invoice`). Invitation : **inchangée**, car elle porte un jeton à usage unique qu'il faudrait stocker dans l'outbox, et son contrat synchrone (`502 invitation_email_failed`) est conservé. |
| D8 | **Rappels** = lignes `notifications` à `scheduled_at` futur (pas de file distincte). Fraîcheur à l'envoi : RDV non supprimé, statut `scheduled` ou `confirmed`, et `starts_at = subject_version`. On ne compare pas `row_version`, qu'une confirmation incrémente sans rendre le rappel faux. Report : les rappels en attente deviennent `suppressed / stale` et de nouveaux sont créés. Un retour à l'horaire initial **réactive** la ligne supprimée (`ON CONFLICT … DO UPDATE … WHERE status = 'suppressed' AND suppression_reason = 'stale'`). Annulation ou suppression : `suppressed / appointment_cancelled`. Un balayeur de rattrapage tourne toutes les 15 min. |
| D9 | **Plages silencieuses** : appliquées aux **SMS uniquement** (l'e-mail et l'in-app ne réveillent personne). Fuseau du site du RDV, à défaut celui du tenant. |
| D10 | **Consentement** : les rappels (`clinical_reminder`) exigent un consentement **explicite** par canal (`patient_contact_consents`, dernier enregistrement accordé). Les messages transactionnels (confirmation, report, annulation) n'en exigent pas (exécution du service) mais respectent le réglage `appointmentSmsEnabled`. **STOP** : révoque le consentement SMS pour **chaque** établissement ayant écrit à ce numéro depuis 180 jours et arrête **tous** les SMS de l'établissement vers ce numéro, transactionnels compris (`channel_disabled`, repli e-mail selon les règles existantes) jusqu'à un nouveau consentement saisi. Un changement de numéro du patient réinitialise le consentement SMS (source `phone_change`, audité). Un octroi ou un retrait replanifie les rendez-vous futurs du patient (idempotent par la déduplication) ; un même rappel ne part que sur un canal. |
| D11 | **Langue** : patients `fr` ; personnel `users.locale` (`fr` ou `en`). Chaîne de repli : modèle personnalisé actif, puis modèle par défaut de la langue, puis `fr`. |
| D12 | **Modèles** : modèles par défaut versionnés **en code** (`modules/notifications/templates/default-templates.ts`, version entière par modèle) et surcharges du tenant versionnées en base (une ligne immuable par version, une seule active). Moteur maison `{{a.b}}` strict, sans logique ni dépendance : variable inconnue = erreur du linter, valeur manquante = échec du rendu (`failed / render_error`, sans envoi). |
| D13 | **Quota SMS** : `limits.smsMonthly`, compté en **segments** `sent\|delivered` du mois UTC, plus les envois en cours, sous verrou d'avis par tenant. Dépassement : `suppressed / quota_exhausted`, repli e-mail si le patient en a un (variante `quota_fallback`), alerte `quota.sms_threshold` aux administrateurs à 80 % et 100 % (une par mois et par seuil). |
| D14 | **Destinataires « propriétaire »** : utilisateurs `active` ayant `settings:establishment:update` à portée établissement. Les relances à partir de J+7 vont aussi aux titulaires du rôle système `director`. Canaux des relances SaaS : e-mail et in-app. |
| D15 | **Calendrier des relances SaaS** : `SAAS_DUNNING_OFFSETS_DAYS` (défaut `-7,-3,0,3,7,12,15`, relatif à `due_at`). Seule la dernière étape atteinte et non envoyée est créée (pas de rattrapage en rafale). Arrêt immédiat : la facture doit être `open` à la création **et** à l'envoi ; `payment.succeeded` supprime les relances en attente. |

## 3. Modèle de données

### 3.1 Équipe N — `apps/api/prisma/schema/notifications.prisma`, migration `20261005000400_notifications`
Les énumérations sont des `text` + `CHECK`. Les clés sont composites `(tenant_id, id)` avec `id uuid` v7.

**`tenant.notification_outbox`** (modèle `NotificationOutboxEvent`)

| Colonne | Type | Contraintes |
|---|---|---|
| `id`, `tenant_id` | uuid | PK `(tenant_id, id)`, FK `platform.tenants` |
| `event_type` | text | `CHECK IN ('appointment.created','appointment.rescheduled','appointment.cancelled','appointment.deleted')` |
| `aggregate_type` / `aggregate_id` | text / uuid | `CHECK aggregate_type = 'appointment'` |
| `payload` | jsonb | défaut `'{}'` ; identifiants et dates seulement (`{ startsAt, previousStartsAt? }`), validé par Zod côté code |
| `status` | text | défaut `pending`, `CHECK IN ('pending','processed','failed')` |
| `attempts` | int | défaut 0 |
| `available_at` | timestamptz | défaut `now()` |
| `processed_at` | timestamptz | — |
| `last_error_code` | text | — |
| `created_at` | timestamptz | défaut `now()` |

Index : `ix_notification_outbox_due (tenant_id, available_at) WHERE status = 'pending'`.

**`tenant.notifications`** (modèle `Notification`) : une ligne = un message, sur un canal, à un destinataire. C'est aussi le journal de livraison.

| Colonne | Type | Contraintes / sens |
|---|---|---|
| `id`, `tenant_id` | uuid | PK composite |
| `type_code` | text | code du catalogue (§7.1) |
| `category` | text | `CHECK IN ('transactional','clinical_reminder','administrative')` |
| `channel` | text | `CHECK IN ('email','sms','inapp')` |
| `recipient_type` / `recipient_id` | text / uuid | `CHECK IN ('user','patient')` ; pas de FK (polymorphe) |
| `subject_type` / `subject_id` / `subject_version` | text / uuid / text | `appointment` (version = `starts_at` ISO), `saas_invoice`, `quota` ; nullables |
| `source_event_id` | uuid | événement outbox d'origine, nullable |
| `dedup_key` | char(64) | `UNIQUE (tenant_id, dedup_key)` |
| `locale` | text | `CHECK IN ('fr','en')` |
| `context` | jsonb | défaut `'{}'`, sans PHI. Relances : `{ invoiceNumber, amount, currency, dueAt, offsetDays }`. Quota : `{ month, thresholdPercent, limit }` |
| `status` | text | défaut `queued`, `CHECK IN ('queued','sent','delivered','failed','suppressed')` |
| `suppression_reason` | text | `CHECK IN ('no_consent','no_contact','preference_disabled','channel_disabled','quota_exhausted','stale','appointment_cancelled','invoice_settled','too_late','provider_unavailable','recipient_inactive')` ; `CHECK (status <> 'suppressed' OR suppression_reason IS NOT NULL)` |
| `scheduled_at`, `next_attempt_at` | timestamptz | non nuls |
| `deadline_at` | timestamptz | au-delà : `failed / deadline_exceeded` |
| `attempts` | smallint | défaut 0 |
| `locked_until` | timestamptz | bail du dispatcher |
| `template_source` / `template_version` | text / int | `CHECK IN ('default','custom')`, renseignés au rendu |
| `recipient_masked` / `recipient_hash` | text / bytea | renseignés à l'envoi (jamais le clair) |
| `provider` / `provider_message_id` | text | — |
| `segments` / `encoding` | smallint / text | SMS ; `CHECK IN ('GSM7','UCS2')` |
| `error_class` / `error_code` | text | `CHECK error_class IN ('transient','permanent_recipient','permanent_config')` |
| `created_at`, `updated_at`, `sent_at`, `delivered_at`, `failed_at`, `suppressed_at` | timestamptz | — |

Autre contrainte : `CHECK (channel <> 'inapp' OR recipient_type = 'user')`.
Index :
- `ix_notifications_due (tenant_id, next_attempt_at) WHERE status = 'queued'`
- `ix_notifications_subject (tenant_id, subject_type, subject_id)`
- `ix_notifications_created (tenant_id, created_at DESC, id DESC)`
- `ix_notifications_sms_month (tenant_id, sent_at) WHERE channel = 'sms' AND status IN ('sent','delivered')`

**`tenant.notification_attempts`** (modèle `NotificationAttempt`, ajout seul)
- Colonnes : `id`, `tenant_id`, `notification_id` (FK composite vers `notifications`), `attempt smallint`, `outcome text CHECK IN ('sent','delivered','failed','retry_scheduled')`, `provider`, `provider_message_id`, `error_class`, `error_code`, `occurred_at`.
- Index `(tenant_id, notification_id, attempt)`.
- `REVOKE UPDATE, DELETE … FROM ghmt_app`.

**`tenant.inapp_messages`** (modèle `InAppMessage`)
- Colonnes : `id`, `tenant_id`, `user_id` (FK `(tenant_id, user_id)` vers `tenant.users`), `notification_id` (nullable, `UNIQUE (tenant_id, notification_id)`), `type_code`, `title varchar(120)`, `body varchar(500)`, `link varchar(200)`, `created_at`, `read_at`, `expires_at` (création + 30 j).
- `CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_-]*$')`.
- Index `(tenant_id, user_id, created_at DESC, id DESC)` et `ix_inapp_unread (tenant_id, user_id) WHERE read_at IS NULL`.

**`tenant.notification_templates`** (modèle `NotificationTemplate`, surcharges du tenant)
- Colonnes : `id`, `tenant_id`, `type_code`, `channel`, `locale`, `version int`, `subject varchar(150)` (nullable), `body text CHECK (length(body) <= 5000)`, `is_active bool` (défaut true), `created_by uuid`, `created_at`.
- `UNIQUE (tenant_id, type_code, channel, locale, version)`.
- `uq_notification_templates_active (tenant_id, type_code, channel, locale) WHERE is_active`.
- `REVOKE UPDATE, DELETE … FROM ghmt_app; GRANT UPDATE (is_active) … TO ghmt_app` : versions immuables.

**`tenant.notification_settings`** (modèle `NotificationSettings`, au plus une ligne par tenant ; absente = valeurs par défaut)
- Colonnes : `tenant_id` (PK), `quiet_hours_start time` (défaut `21:00`), `quiet_hours_end time` (défaut `07:00`), `sms_transliterate bool` (défaut true), `sender_display_name varchar(30)` (nullable : remplace le nom de l'établissement dans les messages), `appointment_sms_enabled bool` (défaut true), `reminder_d1_enabled bool` (défaut true), `reminder_d1_local_time time` (défaut `10:00`), `reminder_h2_enabled bool` (défaut true), `updated_by uuid`, `updated_at`.
- `CHECK (quiet_hours_start <> quiet_hours_end)`.

**`tenant.notification_preferences`** (modèle `NotificationPreference`, personnel)
- Colonnes : `tenant_id`, `user_id`, `category CHECK IN ('administrative')`, `channel CHECK IN ('email','inapp')`, `enabled bool`, `updated_at`.
- PK `(tenant_id, user_id, category, channel)`, FK utilisateur composite.

**`tenant.patient_contact_consents`** (modèle `PatientContactConsent`, historique en ajout seul)
- Colonnes : `id`, `tenant_id`, `patient_id` (FK `(tenant_id, patient_id)` vers `tenant.patients`), `channel CHECK IN ('sms','email')`, `purpose CHECK IN ('appointment_reminder')`, `granted bool`, `source CHECK IN ('front_desk','patient_request','sms_stop')`, `recorded_by uuid`, `recorded_at`.
- `CHECK (source <> 'sms_stop' OR granted = false)` et `CHECK (source = 'sms_stop' OR recorded_by IS NOT NULL)`.
- Index `(tenant_id, patient_id, channel, purpose, recorded_at DESC, id DESC)`.
- `REVOKE UPDATE, DELETE … FROM ghmt_app`.

**`platform.sms_recipient_tenants`** (modèle `SmsRecipientTenant`, `@@schema("platform")`)
- Colonnes : `phone_hmac bytea`, `tenant_id uuid` (FK `platform.tenants`), `last_sent_at timestamptz`. PK `(phone_hmac, tenant_id)`.
- Écrite et lue par `PlatformDb` uniquement (privilèges par défaut de `ghmt_platform`, aucun pour `ghmt_app`). Sert à router un STOP entrant vers les établissements concernés. Purge au-delà de 180 j par le job de rétention.

**Fonction** `platform.notification_due_tenants(p_limit int DEFAULT 500) RETURNS SETOF uuid`
- `LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp`.
- Parcourt `platform.tenants` (`deleted_at IS NULL AND status <> 'terminated'`) en posant `app.tenant_id`, puis restaure la valeur précédente.
- Renvoie les tenants ayant `tenant.notification_outbox` `pending` avec `available_at <= now()`, ou `tenant.notifications` `queued` avec `next_attempt_at <= now()` et un bail expiré.
- `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO ghmt_app`.

### 3.2 Équipe A — migration `20261005000500_admin_console` (SQL seul, pas de fichier Prisma)
1. `CREATE INDEX ix_audit_logs_action ON tenant.audit_logs (tenant_id, action, chain_seq DESC);` (index absent du schéma Prisma, documenté dans la migration).
2. `INSERT INTO platform.permissions (code, module_code, resource, action, is_sensitive) VALUES ('settings:notification_log:read','settings','notification_log','read',false) ON CONFLICT DO NOTHING;`
3. **Rattrapage des rôles système des établissements existants** : un bloc `DO` parcourt `platform.tenants`, pose `set_config('app.tenant_id', id, true)` et insère dans `tenant.role_permissions` les couples `(tenant_admin, audit:log:export)`, `(tenant_admin, settings:notification_log:read)` et `(director, settings:notification_log:read)` pour les rôles `is_system` non supprimés (jointure sur `template_code`), avec `ON CONFLICT DO NOTHING`, puis restaure le contexte. L'opération est idempotente.

## 4. Permissions
| Code | Statut | Rôles système | Usage |
|---|---|---|---|
| `settings:notification_log:read` | **nouveau** (phase 0) | tenant_admin, director | Journal des envois |
| `settings:notification_template:read` / `update` | existant | tenant_admin (r/u), director (r) | Modèles et paramètres des notifications |
| `patients:consent:read` / `create` | existant | receptionist, admin_agent, doctor, nurse, midwife | Consentement aux rappels |
| `audit:log:read` | existant | tenant_admin, director | Liste et vérification du journal d'audit |
| `audit:log:export` | existant, **ajouté à tenant_admin** (phase 0 + rattrapage A) | tenant_admin | Export CSV |
| `reports:dashboard:read` | existant | tenant_admin, director, doctor, accountant | Tableau de bord établissement (sections filtrées) |
| (aucune) `@AuthenticatedOnly` | — | tout utilisateur | Boîte in-app, préférences personnelles |

Permissions existantes réutilisées par W : `org:site:*`, `org:service:*`, `iam:user:*`, `iam:invitation`, `iam:session:delete`, `iam:assignment:*`, `iam:role:*`, `appointments:agenda:read|update`.

## 5. Contrats d'API — Équipe N (`modules/notifications`)
Format d'erreur `problem+json` enveloppé. Identifiant mal formé : `404`. Ressource d'un autre tenant ou d'un autre utilisateur : `404`.

### 5.1 Boîte in-app (`@AuthenticatedOnly`)
| Méthode | Chemin | Corps / requête | Réponse | Erreurs |
|---|---|---|---|---|
| GET | `/notifications/inbox` | `listInboxQuerySchema` `{ unreadOnly?: 'true'\|'false', limit 1..50 (20), cursor? }` | `Page<InAppMessageView>` triée `id` décroissant (UUID v7) | 422 `cursor` |
| GET | `/notifications/inbox/unread-count` | — | `{ count: number, capped: boolean }` (plafonné à 999) | — |
| POST | `/notifications/inbox/{id}/read` | — | 200 `InAppMessageView` (idempotent) | 404 |
| POST | `/notifications/inbox/read-all` | — | 200 `{ updated: number }` | — |

`InAppMessageView = { id, typeCode, title, body, link: string \| null, createdAt, readAt: string \| null }`. Les messages expirés (`expires_at`) ne sont jamais renvoyés.

### 5.2 Préférences personnelles (`@AuthenticatedOnly`)
| Méthode | Chemin | Corps | Réponse | Erreurs |
|---|---|---|---|---|
| GET | `/notifications/preferences` | — | `{ items: NotificationPreferenceView[] }` | — |
| PUT | `/notifications/preferences` | `updateNotificationPreferencesSchema` `{ items: [{ category: 'administrative', channel: 'email'\|'inapp', enabled }] (1..10) }` | idem | 422 `preference_locked` (`errors[].path = items.N`) |

`NotificationPreferenceView = { category, channel, enabled, locked, note: string \| null }`.
- `administrative/inapp` est toujours `locked: true` (activé).
- `administrative/email` est modifiable. La note précise que les relances de facturation restent envoyées aux administrateurs.
- Audit : `notification.preferences_updated` (catégorie, canal, valeur).

### 5.3 Paramètres de l'établissement
| Méthode | Chemin | Permission | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| GET | `/notifications/settings` | `settings:notification_template:read` | — | `NotificationSettingsView` | — |
| PUT | `/notifications/settings` | `settings:notification_template:update` | `updateNotificationSettingsSchema` (tous champs optionnels, au moins un) | `NotificationSettingsView` | 422 `invalid_quiet_hours`, 422 validation |

`NotificationSettingsView = { quietHoursStart 'HH:MM', quietHoursEnd, smsTransliterate, senderDisplayName \| null, appointmentSmsEnabled, reminderD1Enabled, reminderD1LocalTime 'HH:MM', reminderH2Enabled, smsProvider: 'none'\|'sandbox'\|'http', smsUsage: { month 'AAAA-MM', usedSegments, limit \| null }, updatedAt \| null }`.
Audit : `notification.settings_updated` (champs modifiés et nouvelles valeurs, toutes non sensibles).

### 5.4 Modèles
| Méthode | Chemin | Permission | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| GET | `/notifications/templates` | `settings:notification_template:read` | `?typeCode=` | `NotificationTemplateView[]` (modèle **effectif** par type × canal × langue) | — |
| PUT | `/notifications/templates/{typeCode}/{channel}/{locale}` | `…:update` | `upsertNotificationTemplateSchema` `{ subject?: ≤150, body: 1..5000 }` | 200 `NotificationTemplateView` (`source: custom`, version + 1) | 404 `template_not_found` (combinaison absente du catalogue) ; 422 `template_rejected` |
| DELETE | `/notifications/templates/{typeCode}/{channel}/{locale}` | `…:update` | — | 204 (retour au modèle par défaut) | 404 si aucune surcharge |
| POST | `/notifications/templates/preview` | `…:read` | `previewNotificationTemplateSchema` `{ typeCode, channel, locale, subject?, body }` | 200 `TemplatePreviewView` (même si le linter signale des problèmes) | 422 validation |

- `NotificationTemplateView = { typeCode, channel, locale, source: 'default'\|'custom', version, subject \| null, body, variables: string[], updatedAt \| null }`.
- `TemplatePreviewView = { subject \| null, body, characters, segments \| null, encoding \| null, issues: [{ path, code, message }] }` (rendu avec les valeurs d'exemple de longueur maximale).
- `template_rejected` (`errors[]`, codes) : `unknown_variable`, `forbidden_term`, `service_name`, `too_many_segments` (SMS > 3), `too_long`, `subject_required` (e-mail, in-app), `subject_forbidden` (SMS).
- Audit : `notification.template_updated` / `notification.template_reset` (`{ typeCode, channel, locale, version }`, jamais le texte).

**Linter de confidentialité (bloquant)** — appliqué aux surcharges (PUT) et, en CI, à tous les modèles par défaut :
1. variables limitées à la liste blanche du type (§7.1) ;
2. termes interdits, insensibles à la casse et aux accents, en FR et EN. Liste dans `domain/privacy-terms.ts`, au minimum : diagnostic, motif, pathologie, maladie, vih, hiv, sida, aids, ist, std, hépatite, tuberculose, psychiatr, santé mentale, addicto, oncolog, cancer, chimio, dialyse, diabète, grossesse, prénatal, ivg, avortement, contracept, dépistage, séropositi, résultat, result, examen, analyse, ordonnance, prescription, médicament, traitement, dr, docteur, doctor ;
3. aucun nom de service (`tenant.departments.name` de 4 caractères ou plus) du tenant ;
4. SMS : 3 segments au plus après translittération éventuelle ; longueurs maximales.

### 5.5 Journal des envois
| Méthode | Chemin | Permission | Requête | Réponse |
|---|---|---|---|---|
| GET | `/notifications/deliveries` | `settings:notification_log:read` | `listDeliveriesQuerySchema` `{ status?, channel?, typeCode?, from?, to? (7 j par défaut, 31 j au plus ⇒ 422 range_too_large), limit 1..100 (50), cursor? }` | `Page<NotificationDeliveryView>` |

- `NotificationDeliveryView = { id, typeCode, channel, status, suppressionReason, recipientType, recipientMasked \| null, subjectType, subjectId, attempts, errorClass, errorCode, provider, createdAt, scheduledAt, sentAt, deliveredAt }`.
- Jamais de `recipientId` pour un patient, ni de nom, ni de texte.
- Audit : `notification.deliveries_listed` (`{ resultCount }`).

### 5.6 Consentement du patient aux rappels
| Méthode | Chemin | Permission | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| GET | `/patients/{patientId}/contact-consents` | `patients:consent:read` | — | `ContactConsentsView` | 404 (patient inconnu, autre tenant ou hors périmètre de `patients:patient:read`) |
| POST | `/patients/{patientId}/contact-consents` | `patients:consent:create`, `@AllowWhenSuspended` | `recordContactConsentSchema` `{ channel: 'sms'\|'email', purpose: 'appointment_reminder', granted: boolean, source: 'front_desk'\|'patient_request' }` | 201 `ContactConsentsView` | 404 ; 422 |

- `ContactConsentsView = { patientId, current: [{ channel, purpose, granted, source \| null, recordedAt \| null }] (sms et email, granted: false si jamais recueilli), history: ContactConsentEntry[] (50 dernières) }`.
- Audit : `patient.consents_read` en lecture, `patient.consent_changed` en écriture (avec `patientId`).
- Une révocation `suppressed / no_consent` immédiatement, dans la même transaction, les rappels en attente du canal.

### 5.7 Webhooks SMS (`@Public`, 60 requêtes/min/IP, corps 64 Ko au plus)
| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| POST | `/webhooks/sms/http/delivery` | `smsDeliveryWebhookSchema` `{ clientRef: '<tenantId>.<notificationId>', status: 'delivered'\|'undeliverable'\|'failed', providerMessageId?, errorCode? ≤50 }` | 204 |
| POST | `/webhooks/sms/http/inbound` | `smsInboundWebhookSchema` `{ from: E.164, text: ≤1600, receivedAt? }` | 204 |
| POST | `/webhooks/sms/sandbox/delivery` · `/webhooks/sms/sandbox/inbound` | mêmes corps, **sans signature** | 204 ; **404 si `SMS_PROVIDER ≠ sandbox`** |

- **Signature `http`** : en-têtes `x-ghmt-timestamp` (secondes Unix, ± 300 s) et `x-ghmt-signature = hex(HMAC-SHA256(SMS_HTTP_WEBHOOK_SECRET, "<timestamp>.<corps brut>"))`, comparée en temps constant. Signature absente ou invalide : `401 invalid_signature`. Adaptateur ou secret non configurés : `404`.
- **Accusé de réception** : `delivered` donne `delivered`. `undeliverable` ou `failed` donnent `failed` (`permanent_recipient`). Traitement idempotent. Un `clientRef` inconnu renvoie 204 (pas d'oracle).
- **STOP** : texte normalisé (majuscules, sans accents ni ponctuation) égal à `STOP` ou `ARRET`, ou commençant par `STOP `. On cherche ensuite dans `platform.sms_recipient_tenants` les établissements des 180 derniers jours. Pour chacun (`runAs`) : patients dont `phone_bidx = blindIndex(tenantId, from)`, insertion `granted=false, source='sms_stop'`, audit `patient.consent_changed` (acteur `system`), suppression des rappels SMS en attente.
- **Adaptateur HTTP sortant** : `POST SMS_HTTP_URL`, `Authorization: Bearer SMS_HTTP_TOKEN`, JSON `{ to, from: SMS_HTTP_SENDER_ID, text, clientRef }`, délai `SMS_HTTP_TIMEOUT_MS`. Interprétation de la réponse :

  | Réponse | Effet |
  |---|---|
  | `2xx { id }` | `sent` |
  | `400` / `404` / `422` | `permanent_recipient` |
  | `401` / `402` / `403` | `permanent_config` (journal d'erreur) |
  | `408` / `429` / `5xx`, délai, réseau | `transient` |

### 5.8 Traitement (dispatcher, jobs)
**Tick** (`NotificationDispatcher.runOnce(now, { tenantIds? })`, toutes les `NOTIFICATIONS_DISPATCH_INTERVAL_MS` si le worker est actif). Pour chaque tenant dû (D2) :
1. **Relais** (une transaction `runAs`) : réservation de `NOTIFICATIONS_BATCH_SIZE` événements `pending` (`FOR UPDATE SKIP LOCKED`), planification (§5.9), `processed`. Une erreur donne `attempts+1`, `available_at = now + 1 min × 2^n`, et `failed` après 10 essais (journal d'erreur).
2. **Envoi**, en trois temps :
   - (a) transaction courte de réservation (`locked_until = now + 2 min`, SKIP LOCKED) ;
   - (b) transaction de préparation : fraîcheur, destinataire actif, consentement, préférence, plage silencieuse SMS (report : `next_attempt_at` = fin de plage + dispersion déterministe de 0 à 10 min dérivée de l'id ; H-2 annulé `too_late` si la fin de plage tombe à moins d'1 h du RDV), rendu, contrôle du quota sous `pg_advisory_xact_lock` ;
   - (c) appel au fournisseur **hors transaction** ;
   - (d) transaction de résultat : statut, `notification_attempts`, `recipient_masked/hash`, `segments`, et upsert de `platform.sms_recipient_tenants` (`PlatformDb`) après un SMS envoyé.

   L'in-app insère dans `inapp_messages` et passe directement à `delivered`.
3. **Retries**

   | Canal | Tentatives | Backoff (± 10 % déterministe) | Échéance |
   |---|---|---|---|
   | SMS | 5 | 30 s × 2^(n-1) | création + 2 h ; H-2 : `starts_at − 30 min` ; J-1 : `starts_at − 2 h` |
   | E-mail | 6 | 60 s × 2^(n-1), plafond 6 h | création + 24 h |
   | In-app | 1 | — | — |

   - Une erreur `permanent_*` donne `failed` sans retry.
   - Au-delà des tentatives : `failed / max_attempts`. Au-delà de l'échéance : `failed / deadline_exceeded`.
   - Classification SMTP : codes 4xx et erreurs réseau (`ECONNREFUSED`, `ETIMEDOUT`…) = `transient` ; codes 5xx = `permanent_recipient`.

**Jobs** (actifs seulement si `NOTIFICATIONS_WORKER_ENABLED`, chacun avec `runOnce(now, { tenantIds })`)
- `ReminderSweeperJob` (toutes les 15 min) : RDV `scheduled|confirmed` des 26 prochaines heures. Il recrée les rappels attendus manquants, encore à plus de 5 min, en utilisant `created_at` du RDV comme instant de prise. Idempotent par la clé de déduplication.
- `SaasDunningJob` (minute 15 de chaque heure, plus une passe 30 s après le démarrage) : factures `open` (`PlatformDb`), étape la plus récente atteinte, destinataires de D14, notifications e-mail et in-app.
- `NotificationRetentionJob` (03:30 UTC) : purge des `inapp_messages` expirés, de l'outbox `processed` de plus de 30 j et de `platform.sms_recipient_tenants` de plus de 180 j.
- Abonnement `payment.succeeded` (`saas_invoice`) : relances `queued` de la facture passées en `suppressed / invoice_settled`.

### 5.9 Règles de planification
| Événement | Notifications créées |
|---|---|
| `appointment.created` | `appointment.confirmed` (immédiat), `appointment.reminder_d1`, `appointment.reminder_h2` |
| `appointment.rescheduled` | rappels en attente du RDV dont la version diffère : `stale`. Puis `appointment.rescheduled` et nouveaux rappels |
| `appointment.cancelled` | rappels : `appointment_cancelled`. Puis `appointment.cancelled` |
| `appointment.deleted` | rappels : `appointment_cancelled` (aucun message, c'est une correction de saisie) |

Règles appliquées à ces notifications :
- **J-1** : la veille à `reminder_d1_local_time`, dans le fuseau du site (ou du tenant). Non planifié si le RDV est pris moins de 24 h à l'avance ou si `reminder_d1_enabled` est faux.
- **H-2** : `starts_at − 2 h`. Non planifié si le RDV est pris moins de 3 h à l'avance ou si `reminder_h2_enabled` est faux.
- **Canal patient**, si le téléphone et le consentement le permettent : SMS, sinon e-mail, sinon une ligne `suppressed` (`no_consent` ou `no_contact`) comptée au journal. Pour le transactionnel : SMS si téléphone et `appointment_sms_enabled`, sinon e-mail, sinon `no_contact` ou `channel_disabled`.
- **Variables** : formatées dans la langue et le fuseau du site. `etablissement.nom` = `sender_display_name ?? nom du tenant`.

## 6. Contrats d'API — Équipe A (`modules/admin`)
| Méthode | Chemin | Permission | Corps / requête | Réponse | Erreurs |
|---|---|---|---|---|---|
| GET | `/audit-logs` | `audit:log:read` | `listAuditLogsQuerySchema` = filtres + `{ limit 1..100 (50), cursor? }` | `Page<AuditLogView>` trié `chain_seq` décroissant | 422 (curseur, plage, filtre) |
| POST | `/audit-logs/export` | `audit:log:export`, 5 requêtes / 10 min / IP | `exportAuditLogsSchema` = filtres | 200 `text/csv; charset=utf-8` (non enveloppé) | 422 `export_too_large` (`details { count, max: 10000 }`) ; 403 `subscription_grace` (automatique) ; 429 |
| GET | `/audit-logs/verify` | `audit:log:read`, 3 requêtes / min / IP | `verifyAuditChainQuerySchema` `{ limit 1000..50000 (50000) }` | `AuditChainVerificationView` | 422 |
| GET | `/dashboards/establishment` | `reports:dashboard:read` | `dashboardQuerySchema` `{ siteId? }` | `EstablishmentDashboardView` | 422 `not_found` sur `siteId` |

**Filtres** (`auditLogFiltersSchema`) : `from?`, `to?` (ISO ; par défaut les 7 derniers jours ; 92 j au plus, 422 `range_too_large` sinon), `actorUserId?` uuid, `action?` (`^[a-z_]+(\.[a-z_]+)*(\.\*)?$`, le suffixe `.*` désigne un préfixe), `resourceType?` (`^[a-z_]{1,50}$`), `resourceId?` uuid, `outcome?` (`success|denied|failure`). Le curseur vaut `chain_seq` décimal encodé, validé par `^\d{1,19}$` (422 sinon).

**`AuditLogView`**
```
{ id, seq: string, occurredAt,
  actor: { type, userId | null, fullName | null },
  action, resourceType | null, resourceId | null, patientId | null,
  outcome, ip | null, requestId | null,
  changes: object | null }
```
`fullName` vient d'une jointure sur `tenant.users`, jamais d'un patient.

**Assainissement de `changes`** (`domain/audit-sanitizer.ts`, aussi utilisé pour l'export) :
- clés masquées par `"[masqué]"` à toute profondeur : `forceReason`, `cancelReason`, `comment`, `note`, `notes`, `description`, `label`, `printLabel`, `voidReason`, `text`, `body`, `subject`, `motif`, `diagnosis`, `address`, `phone`, `email`, `nationalId`, `firstName`, `lastName`, `fullName`, `birthDate`, `q`, `query`, `term` ;
- `reason` est conservé seulement s'il ressemble à un code (`^[a-z0-9_.:-]{1,64}$`), masqué sinon ;
- chaînes tronquées à 200 caractères ; `patientIds` limité à 50 éléments, avec `patientIdsCount`.

**Lecture auditée** : `audit.logs_read` (filtres et nombre de résultats).

**Export CSV**
- BOM UTF-8, séparateur `;`, en-tête `Content-Disposition: attachment; filename="journal-audit-AAAAMMJJ-AAAAMMJJ.csv"`.
- Colonnes : `seq;horodatage_utc;type_acteur;id_acteur;nom_acteur;action;type_ressource;id_ressource;id_patient;resultat;ip;id_requete;details_json`.
- Protection contre l'injection de formules : une cellule commençant par `= + - @ \t \r` est préfixée de `'`.
- Audit `audit.logs_exported` (filtres, nombre de lignes, SHA-256 du fichier) écrit **avant** l'envoi, dans la transaction de lecture.
- Implémentation : `@Res()` Express, `res.send(buffer)`, le gestionnaire renvoie `undefined` (l'intercepteur n'enveloppe pas).

**Vérification d'intégrité** : relit les `limit` derniers maillons par lots de 1 000, recalcule les empreintes via `auditPayload` et `verifyChain` (et `GENESIS_HASH` si la fenêtre commence à 1).
- Réponse : `AuditChainVerificationView = { status: 'intact'|'broken'|'empty', checkedCount, fromSeq, toSeq, firstBrokenSeq | null, checkedAt }`.
- Audit `audit.chain_verified` avec le résultat.

**`EstablishmentDashboardView`**
```
{ date: 'AAAA-MM-JJ' (fuseau du tenant), timezone, generatedAt, siteId | null,
  patients: { total, registeredToday } | null,
  appointments: { total, byStatus: Record<AppointmentStatus, number> (8 clés, zéros compris) } | null,
  revenue: { currency, total: "…", byMethod: { cash, mobile_money, card, other } } | null,
  cashSessions: { openCount, items: [{ id, registerCode, siteId, openedAt, openedBy: { id, fullName } }] } | null }
```

| Section | Permission requise | Module requis | Contenu |
|---|---|---|---|
| `patients` | `patients:patient:read` | — | non supprimés |
| `appointments` | `appointments:appointment:read` ou `appointments:agenda:read` | `appointments` | RDV non supprimés du jour |
| `revenue` | `cashier:payment:read` ou `billing:invoice:read` | `billing` ou `cashier` | `tenant.payments` `succeeded` dont `paid_at` tombe dans la journée, site de la facture |
| `cashSessions` | `cashier:cash_session:read` | `cashier` | sessions `open` |

Une section est `null` si la permission ou le module manque. Chaque section est filtrée par la portée de la permission qui l'ouvre (sites, et sites des services) et par `siteId` s'il est fourni. Aucune donnée nominative de patient. Pas d'audit (comptes uniquement).

**Manques d'API repérés pour l'administration web** : disponibilités et absences des praticiens, horaires / adresse / téléphone des sites, indicateur de service sensible, liste des sessions d'un utilisateur. **Aucun n'est indispensable au MVP** : non attribués, renvoyés en roadmap. Les besoins de W sont couverts par les endpoints existants (§9.4).

## 7. Schémas Zod partagés

### 7.1 `packages/shared/src/schemas/notifications.ts` (N ; aucun import de `./index`)
**Constantes** :
- `NOTIFICATION_CHANNELS = ['email','sms','inapp']`
- `NOTIFICATION_STATUSES = ['queued','sent','delivered','failed','suppressed']`
- `NOTIFICATION_CATEGORIES = ['transactional','clinical_reminder','administrative']`
- `SUPPRESSION_REASONS` (liste du §3.1)
- `NOTIFICATION_LOCALES = ['fr','en']`
- `CONSENT_CHANNELS = ['sms','email']`, `CONSENT_PURPOSES = ['appointment_reminder']`, `CONSENT_SOURCES = ['front_desk','patient_request','sms_stop']`
- `NOTIFICATION_TYPES` (catalogue figé ci-dessous) et `NOTIFICATION_TYPE_CODES`.

| `typeCode` | Catégorie | Destinataire | Canaux | Variables autorisées |
|---|---|---|---|---|
| `appointment.confirmed` · `appointment.rescheduled` · `appointment.cancelled` | transactional | patient | sms, email | `etablissement.nom`, `site.nom`, `patient.prenom`, `rdv.date`, `rdv.heure` |
| `appointment.reminder_d1` · `appointment.reminder_h2` | clinical_reminder | patient | sms, email | idem |
| `subscription.invoice_issued` (1re étape) · `subscription.payment_reminder` (étapes ≤ 0) · `subscription.payment_overdue` (étapes > 0 sauf la dernière) · `subscription.suspension_notice` (dernière étape) | administrative | user | email, inapp | `etablissement.nom`, `facture.numero`, `facture.montant`, `facture.echeance`, `facture.jours_retard`, `lien` |
| `quota.sms_threshold` | administrative | user | email, inapp | `etablissement.nom`, `quota.pourcentage`, `quota.limite`, `lien` |

**Schémas** : `listInboxQuerySchema`, `updateNotificationPreferencesSchema`, `updateNotificationSettingsSchema` (heures `^([01]\d|2[0-3]):[0-5]\d$`, `senderDisplayName` 2..30 ou `null`), `upsertNotificationTemplateSchema`, `previewNotificationTemplateSchema`, `listDeliveriesQuerySchema`, `recordContactConsentSchema` (refuse `source: 'sms_stop'`), `smsDeliveryWebhookSchema`, `smsInboundWebhookSchema`.

**Types de vues** : `InAppMessageView`, `UnreadCountView`, `NotificationPreferenceView`, `NotificationSettingsView`, `NotificationTemplateView`, `TemplatePreviewView`, `NotificationDeliveryView`, `ContactConsentEntry`, `ContactConsentsView`.

Tests : `notifications.test.ts`.

### 7.2 `packages/shared/src/schemas/admin.ts` (A)
`AUDIT_OUTCOMES`, `AUDIT_EXPORT_MAX_ROWS = 10000`, `auditLogFiltersSchema`, `listAuditLogsQuerySchema`, `exportAuditLogsSchema`, `verifyAuditChainQuerySchema`, `dashboardQuerySchema`. Types : `AuditLogView`, `AuditChainVerificationView`, `EstablishmentDashboardView`, `PaymentMethodTotals`. Tests : `admin.test.ts`.

## 8. Variables d'environnement (N : `src/infrastructure/config/env.ts`, `.env.example`, `.env.test`)
| Variable | Validation / défaut | `.env.test` |
|---|---|---|
| `NOTIFICATIONS_WORKER_ENABLED` | `'true'\|'false'`, défaut `true` | `false` |
| `NOTIFICATIONS_DISPATCH_INTERVAL_MS` | entier 2 000..300 000, défaut 10 000 | — |
| `NOTIFICATIONS_BATCH_SIZE` | entier 1..500, défaut 50 | — |
| `SMS_PROVIDER` | `none\|sandbox\|http`, défaut `none`. `sandbox` interdit en production (erreur au démarrage). `http` exige `SMS_HTTP_URL` et `SMS_HTTP_TOKEN` | `sandbox` |
| `SMS_SANDBOX_MAILBOX` | e-mail, défaut `sms-sandbox@ghmt.local` (copie Mailpit en `development` seulement) | — |
| `SMS_HTTP_URL` | URL https (http toléré hors production), optionnelle | — |
| `SMS_HTTP_TOKEN` | optionnelle, 16 caractères ou plus | — |
| `SMS_HTTP_SENDER_ID` | `^[A-Za-z0-9]{3,11}$`, défaut `GHMT` | — |
| `SMS_HTTP_WEBHOOK_SECRET` | optionnelle, 32 caractères ou plus (sans elle, webhooks `http` en 404) | — |
| `SMS_HTTP_TIMEOUT_MS` | 1 000..30 000, défaut 10 000 | — |
| `SAAS_DUNNING_OFFSETS_DAYS` | entiers entre −30 et 60 séparés par des virgules, triés et uniques, au moins un ; défaut `-7,-3,0,3,7,12,15` | — |

Aucun nouveau secret de hachage : la clé de `recipient_hash` et de `phone_hmac` est dérivée de `BLIND_INDEX_KEY`. N ajoute `x-ghmt-signature` aux en-têtes masqués de `src/common/logging/redact.ts`.

## 9. Pages web — Équipe W (`apps/web`)
Règles communes :
- français ;
- navigation calculée par `visibleNav` (permission et module) ;
- page interdite : `AccessDenied` ;
- états vides explicites ;
- erreurs via `describeApiError` (nouveaux codes ajoutés à `lib/api/messages.ts`) ;
- **aucune donnée patient dans les URL** : filtres limités à des dates, des codes d'action et des uuid ; pas de recherche patient dans cette console ;
- formulaires par Server Actions (`FormState`, `failureState`, `invalidState`) ;
- `revalidatePath` après chaque mutation.

### 9.1 Navigation (`lib/auth/nav.ts`, `components/layout/AppShell.tsx`)
`NavItem` reçoit `group?: 'administration'`.

| Libellé | Route | Exigence |
|---|---|---|
| Tableau de bord établissement | `/administration` | `reports:dashboard:read` |
| Organisation | `/administration/organisation` | `org:site:read` |
| Utilisateurs | `/administration/utilisateurs` | `iam:user:read` |
| Rôles et permissions | `/administration/roles` | `iam:role:read` |
| Praticiens | `/administration/praticiens` | module `appointments` + `appointments:agenda:read` |
| Journal d'audit | `/administration/journal` | `audit:log:read` |
| Notifications | `/notifications` | tout utilisateur |

La cloche `NotificationBell` (composant client) se place dans l'en-tête d'`AppShell`. Compteur initial lu par `app/(app)/layout.tsx` (`GET /notifications/inbox/unread-count` ; échec = cloche sans nombre), puis polling toutes les 60 s (`UNREAD_POLL_MS`), suspendu quand l'onglet est masqué, avec backoff jusqu'à 5 min en cas d'erreur et arrêt sur 401. Affichage « 99+ ».

### 9.2 Pages
| Route | Contenu | Actions serveur (fichier) | Appels API |
|---|---|---|---|
| `/administration` | Cartes : patients, RDV du jour par statut, recettes du jour par mode, sessions de caisse ouvertes ; sélecteur de site ; sections `null` masquées | — | `GET /dashboards/establishment?siteId=` |
| `/administration/organisation` | Sites (liste, création) ; services par site (liste, création) | `createSiteAction`, `createDepartmentAction` (`actions/admin-org.ts`) | `GET/POST /org/sites`, `GET/POST /org/departments` |
| `/administration/organisation/sites/[id]` · `/administration/organisation/services/[id]` | Modification et suppression (confirmation) | `updateSiteAction`, `deleteSiteAction`, `updateDepartmentAction`, `deleteDepartmentAction` | `PATCH/DELETE /org/sites/{id}`, `/org/departments/{id}` |
| `/administration/utilisateurs` | Liste (filtres `statut`, `q` = nom ou e-mail du personnel, curseur) | — | `GET /iam/users` |
| `/administration/utilisateurs/inviter` | Nom, e-mail, langue, rôle et portée initiaux | `inviteUserAction` (`actions/admin-users.ts`) | `POST /iam/users` (502 `invitation_email_failed` : message « compte créé, renvoyez l'invitation ») |
| `/administration/utilisateurs/[id]` | Fiche ; boutons selon statut et permissions : renvoyer l'invitation, désactiver/réactiver, déverrouiller, révoquer les sessions ; affectations (rôle, portée établissement/site/service, fin de validité), ajout et retrait | `updateUserAction`, `resendInvitationAction`, `disableUserAction`, `enableUserAction`, `unlockUserAction`, `revokeSessionsAction`, `addAssignmentAction`, `revokeAssignmentAction` | `GET/PATCH /iam/users/{id}`, `POST …/invitation`, `…/disable`, `…/enable`, `…/unlock`, `DELETE …/sessions`, `GET/POST …/assignments`, `DELETE …/assignments/{aid}`, `GET /iam/roles`, `/org/sites`, `/org/departments` |
| `/administration/roles` | Rôles système (badge, lecture seule) et personnalisés | — | `GET /iam/roles` |
| `/administration/roles/nouveau` · `/administration/roles/[id]` | `RoleMatrix` : modules × ressources × actions depuis le catalogue ; cases des permissions que le lecteur ne détient pas désactivées (l'API reste l'arbitre) ; suppression d'un rôle personnalisé | `createRoleAction`, `updateRoleAction`, `deleteRoleAction` (`actions/admin-roles.ts`) | `GET /iam/permissions`, `GET/POST /iam/roles`, `GET/PATCH/DELETE /iam/roles/{id}` |
| `/administration/praticiens` · `/nouveau` · `/[id]` | Liste, création, modification (service, site principal, durée, réservable, utilisateur lié si `iam:user:read`) | `createPractitionerAction`, `updatePractitionerAction` (`actions/admin-practitioners.ts`) | `GET/POST /practitioners`, `GET/PATCH /practitioners/{id}` |
| `/administration/journal` | Filtres (période, acteur, action, type et id de ressource, résultat) en query string ; tableau avec détail dépliable (`changes`) ; « Page suivante » par curseur ; bouton « Exporter en CSV » si `audit:log:export` ; bouton « Vérifier l'intégrité » | `verifyAuditChainAction` (`actions/admin-audit.ts`) | `GET /audit-logs`, `GET /audit-logs/verify` |
| `/administration/journal/export` (**Route Handler POST**) | Contrôle `Origin` = hôte (sinon 403) ; relaie les filtres du formulaire vers `POST /audit-logs/export` avec le jeton du cookie ; renvoie le CSV avec ses en-têtes | — | `POST /audit-logs/export` |
| `/notifications` | Boîte (filtre `?filtre=non-lues`, `?apres=<curseur>`), « marquer comme lu », « tout marquer comme lu », lien interne du message | `markReadAction`, `markAllReadAction` (`actions/notifications.ts`) | `GET /notifications/inbox`, `POST …/{id}/read`, `POST …/read-all` |
| `/notifications/preferences` | Interrupteurs par catégorie × canal (`locked` désactivé, avec sa note) | `updatePreferencesAction` | `GET/PUT /notifications/preferences` |
| `/notifications/compteur` (**Route Handler GET**) | JSON `{ count, capped }`, `Cache-Control: no-store`, 401 sans redirection | — | `GET /notifications/inbox/unread-count` |
| `/patients/[id]` (bloc ajouté, décision §13) | Bloc « Rappels de rendez-vous » : état actuel SMS / e-mail (accordé, refusé, jamais recueilli, date), interrupteurs avec source `front_desk`, historique replié ; visible si `patients:consent:read`, modifiable si `patients:consent:create` | `recordConsentAction` (`actions/patient-consents.ts`) | `GET/POST /patients/{patientId}/contact-consents` |

### 9.3 Composants (nouveaux)
- `components/admin/` : `DashboardCards.tsx`, `SitesPanel.tsx`, `DepartmentsPanel.tsx`, `UsersTable.tsx`, `UserActions.tsx`, `AssignmentForm.tsx`, `RoleMatrix.tsx`, `PractitionerForm.tsx`, `AuditFilters.tsx`, `AuditTable.tsx`, `IntegrityCheck.tsx`.
- `components/notifications/` : `NotificationBell.tsx` (client), `InboxList.tsx`, `PreferencesForm.tsx`.
- Mappeurs tolérants : `lib/domain/admin.ts`, `lib/domain/audit.ts`, `lib/domain/notifications.ts`. Validations locales : `lib/domain/admin-forms.ts`.

### 9.4 Endpoints existants utilisés tels quels
`/org/sites`, `/org/departments`, `/iam/users` (+ `invitation`, `disable`, `enable`, `unlock`, `sessions`, `assignments`), `/iam/roles`, `/iam/permissions` (`[{ module, name, permissions: [{ code, resource, action, isSensitive }] }]`), `/practitioners`, `/auth/me`.

## 10. Répartition des fichiers (aucun chevauchement)
| Fichier / dossier | Propriétaire | Les autres obtiennent ce dont ils ont besoin… |
|---|---|---|
| `packages/shared/src/permissions/catalog.ts`, `role-templates.ts`, `permissions.test.ts`, `schemas/index.ts`, `apps/api/src/app.module.ts` | **Orchestrateur (phase 0)** | …déjà en place au lancement |
| `apps/api/prisma/schema/notifications.prisma` | N | — |
| `apps/api/prisma/migrations/20261005000400_notifications/` (+ correctifs 0410 à 0490) | N | — |
| `apps/api/src/modules/notifications/**` (module, `controllers/`, `services/`, `jobs/`, `domain/`, `providers/`, `templates/`, `repositories/`, `mappers/`, `*.spec.ts`) | N | — |
| `apps/api/src/common/notifications/outbox.ts` (+ spec) | N | — |
| `apps/api/src/modules/appointments/services/appointments.service.ts` | N (ajout des `enqueueOutboxEvent` uniquement) | — |
| `apps/api/src/infrastructure/config/env.ts` (+ spec), `apps/api/.env.example`, `apps/api/.env.test` | N | A et W n'ajoutent aucune variable |
| `apps/api/src/common/logging/redact.ts` | N | — |
| `apps/api/test/notifications/**` | N | — |
| `packages/shared/src/schemas/notifications.ts` (+ `notifications.test.ts`) | N | W ne l'importe pas pendant la phase (§0.3) |
| `docs/07-conventions-dev.md` | N (noyau : `enqueueOutboxEvent`, dispatcher, jobs, `SMS_PROVIDER`) | — |
| `apps/api/prisma/migrations/20261005000500_admin_console/` (+ 0510 à 0590) | A | — |
| `apps/api/src/modules/admin/**` | A | — |
| `apps/api/test/admin/**` | A | — |
| `packages/shared/src/schemas/admin.ts` (+ `admin.test.ts`) | A | — |
| `docs/03-api.md` (section 4.0 : contrats N **et** A recopiés de ce document) | A | N documente dans ce document, A recopie |
| `docs/06-roadmap-mvp.md` (annexe : hors-périmètre du §1.3) | A | — |
| `apps/web/src/app/(app)/administration/**`, `apps/web/src/app/(app)/notifications/**` | W | — |
| `apps/web/src/actions/{admin-org,admin-users,admin-roles,admin-practitioners,admin-audit,notifications}.ts` (+ `.test.ts`) | W | — |
| `apps/web/src/components/admin/**`, `apps/web/src/components/notifications/**` | W | — |
| `apps/web/src/actions/patient-consents.ts` (+ test), `apps/web/src/components/patients/ContactConsents.tsx` (+ test), insertion du bloc dans `apps/web/src/app/(app)/patients/[id]/page.tsx` | W | — |
| `apps/web/src/lib/domain/{admin,admin-forms,audit,notifications}.ts` (+ tests) | W | — |
| `apps/web/src/lib/auth/nav.ts` (+ test), `components/layout/AppShell.tsx` (+ test), `app/(app)/layout.tsx`, `lib/api/messages.ts` (+ test) | W | — |
| `docs/10-phase-notifications-admin.md` | Orchestrateur | — |

## 11. Ordre TDD et critères de vérification
Pour chaque point : test rouge, puis vert, puis refactorisation. Chaque endpoint teste au minimum 403, 404 inter-tenant et 422. Exigences de fin pour chaque équipe :
- couverture ≥ 80 % sur le paquet touché (`pnpm --filter <pkg> test:cov`) ;
- `pnpm typecheck` sans erreur ; `pnpm lint` (web) ; `pnpm build` ;
- suite complète verte, y compris `rls-coverage` ;
- aucun `console.log`.

### 11.1 Équipe N
1. **Domaine pur** (`*.spec.ts`) :
   - clé de déduplication (stabilité, variantes) ;
   - encodage SMS (GSM-7 avec `é è à ù`, bascule UCS-2 sur `ê ç`, translittération, segments 160/153 et 70/67, refus au-delà de 3) ;
   - rendu strict (variable manquante en erreur, échappement HTML de l'e-mail) ;
   - linter (chaque code d'erreur, termes accentués et casse, nom de service) ;
   - plages silencieuses multi-fuseaux (`Africa/Dakar`, `Africa/Douala`, `Africa/Lubumbashi`, plage traversant minuit, dispersion déterministe) ;
   - planification J-1 / H-2 (seuils 24 h et 3 h, report à 07:00, `too_late`) ;
   - backoff et échéances ; classification SMTP et HTTP ; masquage.
2. **Schémas partagés** (`notifications.test.ts`).
3. **Migration** : `rls-coverage` vert. Fonction `notification_due_tenants` (renvoie un tenant dû, aucune autre colonne). `patient_contact_consents` et `notification_attempts` refusent UPDATE et DELETE à `ghmt_app`. Versions de modèles immuables hors `is_active`.
4. **Outbox transactionnelle** : création d'un RDV ⇒ un événement. Création en échec (409 chevauchement) ⇒ aucun événement. `enqueueOutboxEvent` suivi d'une exception dans le même `runAs` ⇒ 0 ligne. Report, annulation et suppression ⇒ événement correspondant.
5. **Planification** : confirmation et rappels créés ; rejeu d'un même événement ⇒ aucun doublon ; report ⇒ anciens rappels `stale` et nouveaux créés ; retour à l'horaire initial ⇒ réactivation ; annulation ⇒ rappels `appointment_cancelled` et SMS d'annulation ; RDV pris à moins de 3 h ou 24 h ⇒ rappels non planifiés.
6. **Dispatcher** (horloge `MutableClock`, sandbox) :
   - envoi SMS ⇒ `sent`, `segments`, `recipient_masked` ;
   - **aucune PHI** : le numéro en clair, le nom et le motif du RDV n'apparaissent dans aucune colonne de `notifications`, `notification_attempts` ou `outbox`, ni dans les arguments du `Logger` espionné ;
   - fraîcheur (RDV déplacé, annulé ou arrivé ⇒ `suppressed`) ;
   - consentement absent ou révoqué ⇒ `no_consent` ;
   - plage silencieuse ⇒ report puis envoi à la fin de plage ;
   - erreurs transitoires ⇒ retries avec backoff puis `failed / max_attempts` ;
   - erreurs permanentes ⇒ `failed` immédiat ;
   - échéance H-2 dépassée ;
   - deux dispatchers concurrents ⇒ un seul envoi (SKIP LOCKED) ;
   - fournisseur `none` ⇒ `provider_unavailable` et repli e-mail.
7. **Quota SMS** : plan à petite limite (`setFixturePlan` + dérogation) ⇒ `quota_exhausted`, repli e-mail, alerte in-app aux administrateurs à 80 % et 100 % émise une seule fois par mois.
8. **In-app et préférences** : liste, compteur, lecture, tout-lire ; message d'un autre utilisateur ⇒ 404 ; isolation inter-tenant ; message expiré invisible ; préférence verrouillée ⇒ 422 ; e-mail désactivé ⇒ `preference_disabled` sauf pour un administrateur sur `subscription.*`.
9. **Consentements** : GET et POST, 403 sans `patients:consent:*`, patient hors périmètre ⇒ 404, audit, révocation ⇒ rappels supprimés, autorisé en tenant suspendu.
10. **Webhooks** : signature valide, invalide (401) et horodatage périmé ; non configuré ⇒ 404 ; accusé `delivered` et `undeliverable` ; idempotence ; STOP via sandbox ⇒ consentement révoqué dans **chaque** établissement concerné, pas ailleurs ; sandbox en 404 si `SMS_PROVIDER ≠ sandbox`.
11. **Paramètres, modèles, journal** : 403 et 422 (`invalid_quiet_hours`, `template_rejected` par code, `template_not_found`), versionnement et réinitialisation, aperçu (segments), journal (filtres, plage de 31 j au plus, pas de `recipientId` patient, lecture auditée).
12. **Relances SaaS** (`subscription-fixtures`, `FakePaymentsGateway`) : étape J-7 ⇒ e-mail et in-app aux administrateurs ; J+7 ⇒ directeurs inclus ; pas de rafale sur les étapes manquées ; **paiement ⇒ relances en attente `invoice_settled` et aucune étape suivante** ; facture payée entre la planification et l'envoi ⇒ `suppressed` à l'envoi.
13. **Balayeur et rétention** : rappel manquant recréé, idempotent ; purge des messages in-app de plus de 30 j.
14. **Configuration et documentation** : `env.spec.ts` (sandbox interdit en production, `http` incomplet refusé, offsets invalides refusés) ; `docs/07`.

### 11.2 Équipe A
1. **Schémas partagés** (`admin.test.ts`) et domaine : assainissement de `changes` (clés masquées, `reason` code ou texte, troncature, `patientIds`) ; CSV (BOM, `;`, guillemets, injection `= + - @`) ; décodeur de curseur `chain_seq` ; bornes du jour selon le fuseau.
2. **`GET /audit-logs`** : filtres (période, acteur, action exacte et préfixe, type et id de ressource, résultat), curseur stable, 422 (curseur, plage > 92 j), 403 (médecin), isolation (l'administrateur du tenant B ne voit rien du tenant A, même avec un `resourceId` connu), méta-audit `audit.logs_read`. **Aucune donnée clinique** : un événement porteur de `forceReason`, `cancelReason`, `comment` ou `fullName` est restitué masqué.
3. **Export** : 403 (directeur sans `export`), 200 CSV conforme, 422 `export_too_large`, audit écrit avec l'empreinte, 403 `subscription_grace` en période de grâce, 429.
4. **Vérification** : chaîne intacte ⇒ `intact` ; tenant vide ⇒ `empty`. La détection de rupture se teste en unitaire, sur des maillons altérés en mémoire (le trigger empêche l'altération en base). Audit `audit.chain_verified`.
5. **Tableau de bord** : sections `null` sans permission ou sans module ; caissier limité à son site ; recettes par mode (espèces et Mobile Money succeeded, pending exclus) ; RDV par statut avec les 8 clés ; bornes du jour à 23:59 / 00:00 dans le fuseau du tenant ; `siteId` d'un autre tenant ⇒ 422.
6. **Migration** : appliquée deux fois sans erreur (idempotence du rattrapage) ; un tenant créé avant la migration voit son `tenant_admin` recevoir `audit:log:export` (vérification au test de fumée).
7. **Documentation** : `docs/03-api.md` §4.0 et `docs/06` (annexe).

### 11.3 Équipe W
1. **Domaine** : mappeurs tolérants (vues admin, audit, notifications, tableau de bord) ; `visibleNav` (groupe Administration selon les permissions et le module `appointments`) ; construction de la query string d'audit (aucun champ hors liste blanche).
2. **Actions** (API simulée, modèle `actions/*.test.ts`) : succès et `revalidatePath`, 422 vers les erreurs de champ, 403 et 409 vers un message français, 502 `invitation_email_failed`.
3. **Composants** :
   - `RoleMatrix` : cases non détenues désactivées, rôle système en lecture seule ;
   - `NotificationBell` : timers simulés, pause sur `visibilitychange`, backoff, « 99+ » ;
   - `AuditTable` : détail dépliable, état vide ;
   - `DashboardCards` : sections absentes ;
   - `PreferencesForm` : `locked`.
4. **Route Handlers** : export (`Origin` étranger ⇒ 403, transmission du CSV et des en-têtes) ; compteur (401 transmis tel quel, `no-store`).
5. **Pages** : `AccessDenied` sans permission ; états vides et erreurs ; aucun identifiant patient ni terme de recherche patient dans les liens générés.
6. Lint, typecheck, `next build`.

## 12. Test de fumée réel (fin de phase, après intégration des trois équipes)
**Préparation** : `pnpm infra:up` ; `.env` de dev avec `SMS_PROVIDER=sandbox`, `NOTIFICATIONS_WORKER_ENABLED=true` et `PAYMENTS_SANDBOX_ENABLED=true` ; `pnpm prisma:deploy && node prisma/seed.mts` ; `pnpm dev` (API et web).

1. **Établissement existant** (créé avant la phase) : l'administrateur voit « Journal d'audit » et peut exporter (rattrapage A).
2. `/administration` : les cartes affichent des comptes cohérents. Avec un compte caissier limité à un site, seule la section caisse et recettes de son site apparaît.
3. **Organisation** : création d'un site et d'un service. **Utilisateurs** : invitation (e-mail visible dans Mailpit), acceptation, affectation d'un rôle à portée site, désactivation puis réactivation, révocation des sessions (l'utilisateur est déconnecté). **Rôles** : création d'un rôle personnalisé par la matrice. **Praticiens** : création liée à l'utilisateur.
4. **Rappels** (via l'API) :
   - patient avec téléphone, puis `POST /patients/{id}/contact-consents { channel: 'sms', granted: true, … }` ;
   - RDV à J+2 : en moins de 15 s, Mailpit montre « SMS → +22177*****xx » de confirmation, sans motif ni nom de praticien ;
   - `GET /notifications/deliveries` : confirmation `sent`, J-1 et H-2 `queued` aux bonnes heures locales ;
   - report du RDV : SMS de report, anciens rappels `stale`, nouveaux rappels ;
   - `POST /webhooks/sms/sandbox/inbound { from, text: 'STOP' }` : consentement révoqué et rappels supprimés ;
   - annulation : SMS d'annulation.
5. **Relances SaaS** : établissement en essai converti avec facture `open` (console plateforme). Après la passe du job, e-mail de relance dans Mailpit et cloche incrémentée en 60 s au plus. Paiement sandbox de la facture : la passe suivante ne crée aucune relance, et une relance en attente est `invoice_settled`.
6. **Journal d'audit** : filtres, page suivante, export CSV ouvert dans un tableur (accents corrects, aucune cellule interprétée comme formule), « Vérifier l'intégrité » renvoie « intègre ».
7. **Boîte in-app** : marquer lu, tout lire, préférences e-mail.
8. **Confidentialité** : `grep` du numéro de téléphone, du nom du patient et du motif dans les journaux de l'API ⇒ aucune occurrence. Aucune URL web ne contient de nom ni de terme de recherche patient.

## 13. Questions ouvertes
Aucune. Décision de l'orchestrateur (2026-10-05) : le bloc de saisie du consentement aux rappels sur la fiche patient est **inclus** dans le périmètre de W (§9.2), sinon aucun rappel ne part en usage réel.

## 14. Correctifs des revues santé et sécurité (2026-10-05, migration `20261005000410_notifications_review_fixes`)
- **Fraîcheur** : confirmation et report sont `stale` si l'horaire du rendez-vous a changé depuis (`starts_at ≠ subject_version`).
- **J-1** : `PUT /notifications/settings` refuse (422 `invalid_reminder_time`) une heure J-1 dans la plage silencieuse (aussi quand la plage change). À l'envoi, un J-1 dont l'envoi effectif tombe le jour local du rendez-vous est `suppressed / too_late` (il dirait « demain » à tort).
- **Noms affichés** : `senderDisplayName` et les noms de site (`modules/org`) passent le linter des termes interdits (422 `forbidden_term` sur le champ) ; au rendu, une valeur existante non conforme est remplacée par le nom de l'établissement.
- **Linter** : liste de termes complétée (FR/EN), caractères de format invisibles ignorés, nouveaux codes `link_forbidden`, `phone_forbidden` (modèles patients) et `stop_required` (SMS de rappel).
- **STOP durable** : si un établissement échoue, le webhook répond 503 (`stop_processing_failed`) et le fournisseur rejoue (traitement idempotent) ; le routage `sms_recipient_tenants` est écrit AVANT l'envoi du SMS (échec ⇒ pas d'envoi, nouvel essai).
- **Double envoi** : le bail est renouvelé ligne par ligne juste avant l'appel du fournisseur (UPDATE conditionnel au bail posé ; 0 ligne ⇒ abandon) ; les écritures de résultat sont conditionnées au statut attendu ; l'adaptateur HTTP envoie `Idempotency-Key: <clientRef>`, refuse les redirections et lit au plus 4 Ko de réponse.
- **Balayeur** : horizon porté à 48 h.
- **Langue** : celle de l'établissement (`platform.tenants.default_locale`, via `platform.current_tenant_locale()`), plus `'fr'` en dur.
- **Webhooks sandbox** : enregistrés seulement si `SMS_SANDBOX_WEBHOOKS_ENABLED=true` (faux par défaut ; vrai en test et en développement).
- **Liens in-app** : motif `^/(?!/)[A-Za-z0-9/_-]*$` (SQL et web). `notification_due_tenants` : `p_limit` borné à 1..500.
- **Audit** : `GET /audit-logs/verify` limité par utilisateur (3/min) et à une vérification concurrente par établissement (429 `verification_in_progress`).
- **Registre `platform.sms_recipient_tenants`** : table de routage des STOP (HMAC du numéro × établissement × dernier envoi). La clé est globale, dérivée de `BLIND_INDEX_KEY` par `HMAC(BLIND_INDEX_KEY, 'ghmt:notifications:recipient')` (le libellé de dérivation est versionné : tout changement impose une migration de recalcul) ; elle est donc indépendante du tenant, par nécessité du routage. Accès réservé à `ghmt_platform` (`PlatformDb`), aucun droit pour `ghmt_app` ; purge au-delà de 180 jours.

## 15. Parcours de la console web dans un navigateur (2026-10-05)
Parcours réel (Chrome, trois comptes en contextes isolés) : inscription d'un établissement, enrôlement TOTP obligatoire de l'administrateur, tableau de bord, organisation (nom de site « Centre VIH » refusé), invitation d'un caissier à portée site puis d'un directeur, révocation des sessions (le caissier est renvoyé à la connexion à la navigation suivante), rôle personnalisé par la matrice (cases non détenues grisées), praticien, journal d'audit (vérification « intègre », export), boîte et préférences de notification. Aucune erreur dans la console du navigateur.

**Défauts trouvés et corrigés (tests de non-régression ajoutés)** :
- **Export CSV du journal toujours refusé (403)** : `Referrer-Policy: no-referrer` fait envoyer `Origin: null` aux formulaires POST. Le Route Handler s'appuie désormais d'abord sur Fetch Metadata (`Sec-Fetch-Site` : seul `same-origin` passe ; `same-site`, `cross-site` et `none` ⇒ 403), puis, en l'absence de cet en-tête, sur la comparaison Origin / hôte (`isSameOriginRequest`).
- **Codes de secours TOTP jamais affichés** : l'activation réécrit le cookie de session, la page serveur se rafraîchit, voit le facteur actif et démontait le composant avant l'affichage des codes. La branche « déjà active » est passée dans `TotpEnrolment` (prop `alreadyActive`), qui reste monté.
- **Code établissement introuvable pour un invité** : l'aperçu `GET /auth/invitations/{token}` renvoie `tenantSlug` ; l'e-mail d'invitation et la page d'acceptation l'affichent ; après acceptation, la connexion est pré-remplie (`/connexion?invitation=acceptee&etablissement=<slug>`, slug validé par expression régulière avant d'entrer dans l'URL).
- **Champ « Code » vidé après une erreur de validation** (sites, services, caisses, tarifs, plans, rôles) : `code` ne fait plus partie des champs jamais renvoyés au formulaire (aucune action MFA ne renvoie de valeurs).
- Coquille : « Prénom Nom, vous êtes invité(e)… ».

**Constats laissés en l'état** :
- §12.2 attend qu'un caissier voie sa section caisse dans `/administration`, mais la table des permissions (§4) ne donne pas `reports:dashboard:read` au caissier : il reçoit « Vous n'avez pas accès ». Comportement conforme à la table ; la contradiction du scénario est à trancher.
- La matrice des rôles affiche les ressources par leur code technique anglais (`entry`, `cash_session`…) : libellés français à prévoir.
- `minio/minio:latest` n'est plus disponible sur Docker Hub : `pnpm infra:up` échoue tant que l'image n'est pas remplacée (les autres services démarrent avec `docker compose up -d postgres redis mailpit`).
