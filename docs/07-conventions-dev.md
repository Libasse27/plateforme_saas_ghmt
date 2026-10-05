# 07 — Conventions de développement (API NestJS)

> Contrat de travail pour toute personne (ou agent) qui ajoute un module à `apps/api`.
> Le noyau décrit ici est en place et testé ; les modules métier s'appuient dessus.

## Démarrage local
```bash
pnpm infra:up                         # PostgreSQL 17, Redis, Mailpit (+ MinIO)
cd apps/api && cp .env.example .env   # générer les secrets (voir commentaires)
pnpm prisma:deploy && node prisma/seed.mts
pnpm dev                              # http://localhost:3000/api/v1/health
pnpm test                             # unitaires + intégration (base ghmt_test)
pnpm vitest run test/<dossier>        # une partie seulement
```

## Rôles PostgreSQL
| Rôle | Usage |
|---|---|
| `ghmt_app` | Connexion de l'API (`DATABASE_URL`). Soumis au RLS, DML seulement, aucun accès direct à `platform.tenants`. |
| `ghmt_migrator` | Migrations et seed (`MIGRATION_DATABASE_URL`). Propriétaire des tables, soumis au RLS (FORCE). |
| `ghmt_platform` | Realm plateforme et console (`PlatformDb`). CRUD sur les tables `platform.*` de la phase SaaS (utilisateurs, plans, abonnements, factures), `INSERT` seul sur `platform.audit_logs`, **aucun accès au schéma `tenant`** : les agrégats d'usage passent par `platform.tenants_usage(uuid[])` (`SECURITY DEFINER`, comptes uniquement, `now()` imposé). |

## Noyau disponible (`apps/api/src`)
| Élément | Fichier | Usage |
|---|---|---|
| `TenantDb.run(tx => …)` | `infrastructure/prisma/tenant-db.service.ts` | **Seule** façon d'accéder aux données tenant : transaction + `SET LOCAL app.tenant_id` du principal. |
| `TenantDb.runAs(tenantId, fn, userId?)` | idem | Flux pré-authentification uniquement (login, refresh, onboarding). Le tenant est résolu côté serveur. |
| `TenantDb.runWithoutTenant(fn)` | idem | Appels aux fonctions `platform.*` SECURITY DEFINER (`resolve_tenant`, `register_tenant`). |
| `RequestContext` | `common/context/request-context.ts` | `principal`, `grants`, `requestId`, `ip`. |
| `@Public()`, `@AuthenticatedOnly()`, `@RequirePermission(...)` | `common/decorators/auth.decorators.ts` | **Refus par défaut** : toute route doit porter l'un des trois. |
| `@CurrentPrincipal()` | idem | `{ userId, tenantId, sessionId, mfa }`. |
| `scopesFor(permission, grants)` | `common/authz/authorization.service.ts` | Portées (tenant / sites / services) pour filtrer les listes. |
| `AuditService.record(tx, tenantId, event)` | `common/audit/audit.service.ts` | Dans la **même** transaction que l'action. Jamais de donnée clinique en clair dans `changes`. |
| `FieldCrypto` | `common/crypto/field-crypto.service.ts` | `encrypt/decrypt(tenantId, …)` AES-256-GCM, `blindIndex(tenantId, value)` pour la recherche exacte. |
| `PasswordService` | `common/auth/password.service.ts` | Argon2id, vérification à temps constant (hash factice). |
| `AccessTokenService` | `common/auth/access-token.service.ts` | `sign(principal)` / `verify(token)` — JWT 15 min. |
| `TenantProvisioningService` | `infrastructure/tenancy/tenant-provisioning.service.ts` | Création atomique d'un établissement (rôles clonés, site, admin). |
| `DomainError` | `common/errors/domain-error.ts` | Erreurs typées → problem+json (`notFound`, `conflict`, `forbidden`, `validation`…). |
| `ZodValidationPipe`, `UuidPipe` | `common/pipes/` | `@Body(new ZodValidationPipe(schema))`, `@Param('id', UuidPipe)`. |
| `Page.fromRows(...)` | `common/pagination/page.ts` | Pagination par curseur ; l'enveloppe place `pagination` dans `meta`. |
| `decodeUuidCursor`, `decodeDateIdCursor` | `common/pagination/page.ts` | Décodage **validé** des curseurs (UUID, ou `date\|UUID`) : curseur invalide ⇒ 422. Ne jamais utiliser `decodeCursor` brut dans une requête. |
| `requireIfMatch`, `etagOf` | `common/http/if-match.ts` | `If-Match` obligatoire (428 absent, 422 illisible) ; l'écriture compare ensuite `rowVersion` (412 si périmé, `DomainError.preconditionFailed`). |
| `Mailer` (`MAILER`) | `common/mail/` | E-mails transactionnels : SMTP (`SMTP_HOST`/`SMTP_PORT`/`MAIL_FROM`, Mailpit en dev), transport mémoire sous `NODE_ENV=test` (`MemoryMailer`). Ne jamais journaliser le contenu (jetons). |
| `Clock` | `common/time/clock.ts` | Horloge injectable pour les règles dépendantes de l'heure (tests : `vi.spyOn(app.get(Clock), 'now')`). |
| `loadTenantProfile(tx)` | `infrastructure/tenancy/tenant-profile.ts` | Profil de l'établissement courant (fuseau, devise, pays) via `platform.current_tenant_profile()`. |
| `PAYMENTS_GATEWAY` (`PaymentsGateway`) | `common/payments/payments-gateway.ts` | `initiate({ purpose, tenantId, referenceId, amount, currency, channel, payerPhone?, description, idempotencyKey })` puis `refresh(attemptId)` et `cancel(attemptId)` (abandon). Échec du fournisseur ⇒ `PaymentProviderUnavailableError` (`payment_provider_unavailable`, `attemptRetained` vrai pour un échec technique : la tentative reste `pending`). Implémenté par le module `payments` (`@Global`) ; billing et subscriptions n'utilisent **que** ce contrat. Résultat reçu par `DomainEventBus` (`payment.succeeded` / `payment.failed`), jamais par appel direct. |
| `DomainEventBus` | `common/events/domain-event-bus.ts` | `subscribe` dans `onModuleInit`, gestionnaires **idempotents** (rejeu par le job de relance), tenant de l'événement via `TenantDb.runAs(payload.tenantId, …)`. |
| `money` (`parseMoney`, `formatMoney`, `addMoney`…) | `common/money/money.ts` | Montants en `Prisma.Decimal` (jamais `number`), chaînes à 2 décimales dans l'API (schémas `moneyAmount` de `@ghmt/shared`). |
| `@AccountThrottled('login' \| 'mfa')` | `common/throttle/account-throttle.ts` | Limitation de débit par compte en plus de la limitation par IP. |
| `EntitlementService` | `common/authz/entitlement.service.ts` | **Seul** accès aux droits d'un tenant (`get(tenantId)`, `getInTx(tx)`, `usageInTx`) et aux limites : `assertCanAddUser(tx)`, `assertCanAddSite(tx)` (dures, verrou d'avis) et `assertAppointmentAllowed(tx, { source, startsAt })` (souple, 120 %) ⇒ `403 plan_limit_reached`. Lit le plan via `platform.current_tenant_subscription()` (`SECURITY DEFINER`). Ne jamais interroger `platform.plans` depuis un module tenant. |
| `@PlatformController(path)`, `@RequirePlatformPermission(...)`, `@PlatformAuthenticatedOnly()`, `@PlatformPublic()`, `@CurrentPlatformUser()` | `modules/platform/auth/platform.decorators.ts` | Routes du realm plateforme (`/platform/<path>`) : `@PlatformRealm()` (contournement explicite des guards tenant) toujours associé à `PlatformAuthGuard`. Refus par défaut, MFA vérifiée exigée, rôle relu en base. |
| `@AllowWhenSuspended()` | `common/decorators/realm.decorators.ts` | Route tenant utilisable en lecture seule (paiement de l'abonnement) ; la permission reste exigée. |
| `PlatformAuditService.record(tx, event)` | `common/audit/platform-audit.service.ts` | Audit plateforme dans la **même** transaction `PlatformDb` (acteurs `platform_user`, `tenant_user`, `system`) ; `platform.audit_logs` est en ajout seul (trigger). |
| `SubscriptionStateService.transition(tx, subscription, to, request)` | `modules/subscriptions/services/subscription-state.service.ts` | **Unique** point de modification de `subscriptions.status` (graphe de `subscription-state-machine.ts`, effet sur `platform.tenants.status`, audit) ; `publish(changes)` **après** commit. |
| `SubscriptionLifecycleService.runLifecycle(now, { tenantIds? })` | `modules/subscriptions/services/subscription-lifecycle.service.ts` | Cycle de vie déterministe (horloge en paramètre), appelé par le job horaire ; `tenantIds` restreint l'exécution (tests). |

Les guards globaux s'exécutent dans cet ordre : Throttler → JwtAuthGuard (JWT + session active) → PermissionGuard (statut tenant, module activé, permission, MFA). Les refus sont audités.

## Règles
1. **Structure** : `src/modules/<module>/{<module>.module.ts, controllers/, services/, repositories/, mappers/}`. Pas de Prisma dans les contrôleurs.
2. **Contrats** : schémas Zod dans `packages/shared/src/schemas/<module>.ts` (chaque module n'édite que son fichier), puis `pnpm --filter @ghmt/shared build`.
3. **Le tenant ne vient jamais du client** (ni corps, ni URL, ni en-tête) : il vient du principal.
4. **Une ressource d'un autre tenant ⇒ 404**, jamais 403.
5. **Sorties** : mappers explicites. Ne jamais renvoyer de colonnes `*_enc`, `*_bidx`, `password_hash`, `token_hash`, ni de `bigint` brut.
6. **Audit** : toute création, modification, suppression, et toute lecture de dossier patient.
7. **Immutabilité** : pas de mutation d'objets reçus ; retourner de nouveaux objets.
8. **Tests** (TDD, couverture ≥ 80 %) : unitaires `*.spec.ts` à côté du code ; intégration HTTP dans `test/<module>/*.e2e-spec.ts` avec `createTestApp()` et les fixtures `createTenantFixture` / `createUserWithRole` / `issueToken` (`test/helpers/fixtures.ts`). Chaque module teste **au minimum** : le refus sans permission (403), l'isolation entre deux tenants (404), la validation (422).
9. **Tables tenant** : toute nouvelle table `tenant.*` porte `tenant_id`, RLS ENABLE + FORCE et la politique `tenant_isolation` (reprendre la boucle de la migration `20261004000200`) ; le test `test/core/rls-coverage.e2e-spec.ts` échoue sinon.
10. **Pas de `console.log`**, pas de secret en dur, messages d'erreur génériques côté client.
11. **Montants** : `numeric(18,2)` en base, `Decimal` en mémoire, chaînes décimales dans l'API ; un champ de montant fourni par le client pour un total est ignoré (recalcul serveur).
12. **Pièces comptables** (factures émises, paiements, sessions de caisse) : immuables par triggers (`tenant.guard_*`), pas de `DELETE` pour `ghmt_app`, annulation = statut `void`. Numéros attribués à l'émission par `tenant.next_sequence` **après** le verrou de ligne (`SELECT … FOR UPDATE`) pour ne laisser aucun trou.
13. **Paiements en ligne** : transaction 1 = réservation (paiement `pending`, sous verrou de facture), appel de la passerelle **hors transaction**, transaction 2 = rattachement ; un refus explicite du fournisseur marque le paiement `failed` (réservation libérée) ; un échec technique le laisse `pending` (relancé par le job, abandonnable). Aucune donnée patient ni téléphone en clair dans `platform.*`.
14. **Séparation des tâches** : une règle « quatre yeux » est vérifiée dans le service **et** par contrainte SQL (ex. `ck_cash_sessions_segregation`).
15. **Realm plateforme** : jamais de `TenantDb` pour lire `platform.plans|subscriptions|saas_invoices…` (le rôle `ghmt_app` n'y a aucun droit) — utiliser `EntitlementService` côté tenant ou `PlatformDb` côté serveur avec un `tenantId` issu du jeton. Aucun accès direct de `ghmt_platform` au schéma `tenant` : toute nouvelle statistique passe par une fonction `SECURITY DEFINER` (`search_path` figé, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE` au seul rôle voulu) qui ne renvoie que des comptes.
16. **Migration de l'équipe A** (`20261005000100_platform_saas`) : DDL généré par `prisma migrate diff`, puis RLS/GRANT/contraintes/fonctions en SQL. Aucune relation Prisma vers `core.prisma` (FK en SQL). Ne jamais modifier une migration appliquée.
17. **Cycle de vie et horloge** : toute règle datée utilise `Clock` (tests : `createTestApp({}, { providerOverrides: [{ token: Clock, useValue: new MutableClock() }, { token: PAYMENTS_GATEWAY, useValue: new FakePaymentsGateway() }] })`) ou le paramètre `now` de `runLifecycle`. Les tests de cycle de vie passent `tenantIds` pour ne pas toucher les autres établissements de la base de test.
18. **Établissements de test** : `createTenantFixture` attribue le plan `enterprise` (illimité) ; `subscriptionPlan: 'trial'` conserve l'essai de l'inscription, `'basic'` / `'standard'`… applique le plan voulu. Realm plateforme : `createPlatformUser(app, role)` (`test/helpers/platform.ts`) renvoie un jeton MFA vérifié et le secret TOTP.
19. **Premier Super Administrateur** : `node scripts/create-platform-admin.mts --email … --name "…" [--role super_admin|support|billing] [--generate]` (rôle `ghmt_platform`, `PLATFORM_DATABASE_URL`) ; mot de passe saisi (invite masquée), `PLATFORM_ADMIN_PASSWORD` ou généré et affiché une seule fois ; le TOTP s'enrôle à la première connexion.

## Notifications (phase 10, équipe N)
20. **`enqueueOutboxEvent(tx, tenantId, event)`** (`common/notifications/outbox.ts`) : seule façon d'émettre un événement de notification. Elle s'appelle DANS la transaction métier (rien d'écrit si la transaction échoue) ; la charge utile (`{ startsAt, previousStartsAt? }`) est validée en `strict` : aucune donnée de santé.
21. **Dispatcher** (`NotificationDispatcher.runOnce(now, { tenantIds? })`) : relais de l'outbox (`FOR UPDATE SKIP LOCKED`, point de sauvegarde par événement), puis envoi en 4 temps (réservation avec bail, préparation en transaction, appel du fournisseur hors transaction, résultat). Découverte des tenants par `platform.notification_due_tenants`. Boucle active seulement si `NOTIFICATIONS_WORKER_ENABLED=true` (toujours `false` en test) ; horloge toujours passée en paramètre.
22. **Jobs** (`ReminderSweeperJob` 15 min, `SaasDunningJob` à :15, `NotificationRetentionJob` 03:30 UTC) : chacun expose `runOnce(now, { tenantIds })`.
23. **`SMS_PROVIDER`** = `none` (défaut : SMS supprimés `provider_unavailable`, repli e-mail) | `sandbox` (mémoire, copie Mailpit en développement, interdit en production) | `http` (URL, jeton et secret de webhook requis). Jeton d'injection `SMS_PROVIDER_TOKEN`.
24. **Aucune PHI** dans l'outbox, le journal des envois, les logs et l'audit : seuls `recipient_masked` et `recipient_hash` sont conservés, le texte rendu jamais. Tables en ajout seul (`notification_attempts`, `patient_contact_consents`) et versions de modèles protégées par triggers (et non REVOKE, pour `rls-coverage`).
