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
| `ghmt_platform` | Console super-admin (phase 2). CRUD `platform`, aucun accès `tenant`. |

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
| `@AccountThrottled('login' \| 'mfa')` | `common/throttle/account-throttle.ts` | Limitation de débit par compte en plus de la limitation par IP. |

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
