# 11 — Phase « Durcissement sécurité : authentification, front, déploiement »

> Contrat de phase (2026-10-05), branche `feat/durcissement-securite`. Référence commune des équipes **AUTH** (API d'authentification et IAM), **OPS** (déploiement, exploitation, inscription, BFF) et **WEB** (front Next.js), qui travaillent **en parallèle sans se parler**. Ce document met en œuvre les volets Authentification, Front et Exploitation/Déploiement de l'annexe « Lot 2 » de `06-roadmap-mvp.md` (revues sécurité M1, L2, H2, M4, M5, L7, re-revue N2). Il est conforme à `04-securite-rbac-audit.md` (§1.4, §1.6 à §1.8, §9.3, §9.5), `08-correctifs-revues.md` (C6 à C9), `10-phase-notifications-admin.md` et `07-conventions-dev.md`. **En cas d'écart, ce document prime pour cette phase.** Chemins réels de l'API : `/api/v1/…`. Dates en ISO 8601 UTC.

## 0. Socle, phase 0 et règles du travail parallèle

### 0.1 Socle déjà en place (à réutiliser, ne pas réécrire)
| Élément | Fichier | Usage dans cette phase |
|---|---|---|
| `TenantDb.run / runAs / runWithoutTenant`, `applyTenantContext` | `src/infrastructure/prisma/tenant-db.service.ts` | Accès tenant ; les jobs utilisent `runAs(tenantId)`. |
| `PlatformDb` | `src/infrastructure/prisma/platform-db.service.ts` | Liste des tenants (jobs), expiration des inscriptions (OPS). |
| `AuditService.record`, `PlatformAuditService` | `src/common/audit/audit.service.ts`, `src/common/audit/platform-audit.{module,service}.ts` | Audit dans la transaction ; acteur `system` pour les jobs. |
| `MAILER` (`SmtpMailer` / `MemoryMailer`), modèle `buildInvitationEmail` | `src/common/mail/{mailer,smtp-mailer,memory-mailer,invitation-email}.ts` | E-mails porteurs de jeton (réinitialisation, vérification d'inscription), envoyés **hors outbox** (même raison que docs/10 D7). |
| `issueOpaqueToken(tenantId)` (`<tenantId>.<secret>`, hash SHA-256) | `src/common/auth/opaque-token.ts` | Jetons de réinitialisation et de vérification. |
| `PasswordService` (Argon2id, `verify(undefined, …)` factice) | `src/common/auth/password.service.ts` | Réinitialisation. |
| `TotpService`, `backup-codes.ts` | `src/modules/auth/services/` | Second facteur exigé à la réinitialisation. |
| `SessionService`, `LoginCompletionService`, `LoginService`, `RefreshService`, `ProfileService`, `MfaEnrollmentService` | `src/modules/auth/services/` | Points d'insertion : délai progressif, MFA hors réseau, `lastSeenAt`. |
| `lockout.ts` (`lockoutAfter`, `registerFailedAttempt`) | `src/modules/auth/services/lockout.ts` | **Remplacé** par le délai progressif (D3). |
| `ACCOUNT_THROTTLER`, `@AccountThrottled`, `accountTracker` | `src/common/throttle/account-throttle.ts` | Étendu en phase 0 (nouveaux types d'identifiant). |
| `ThrottlerModule.forRoot([DEFAULT_RATE_LIMIT, ACCOUNT_THROTTLER])` | `src/app.module.ts` | Converti en `forRootAsync` en phase 0 (stockage Redis, D2). |
| `DomainError.tooManyRequests` + en-tête `Retry-After` | `src/common/errors/domain-error.ts`, `src/common/filters/problem-details.filter.ts` | 429 `login_delayed`. |
| `evaluateAuthorization`, `AuthorizationService.loadGrants` (`role.mfaRequired`) | `src/common/authz/authorization.service.ts` | MFA hors réseau pour les rôles cliniques (D6). |
| `PermissionGuard`, `JwtAuthGuard` | `src/common/guards/` | Vérification réseau, `last_seen_at`. |
| `RequestContext` (`state.ip`, issu de `trust proxy` = `TRUSTED_PROXIES`) | `src/common/context/request-context*.ts`, `src/bootstrap.ts` | IP cliente vue par l'API. |
| `assertCanAssign`, `isSensitiveRole`, `isAdministrativeWrite` (privé) | `src/modules/iam/services/privilege.ts` | Hiérarchie (D9) ; notification au Directeur (D10). |
| `assertAnotherActiveAdmin`, `holdsActiveAdminRole` | `src/modules/iam/services/admin-invariant.ts` | Invariant « dernier administrateur », conservé. |
| `AssignmentsService.createInTx` (audit `iam.role.sensitive_assigned`) | `src/modules/iam/services/assignments.service.ts` | Déclencheur de la notification au Directeur. |
| `UsersService` (`disable`, `enable`, `unlock`, `revokeSessions`, `update`) | `src/modules/iam/services/users.service.ts` | Contrôles hiérarchiques. |
| `NotificationsRepository.insert`, `dedupKey`, `deliveryDeadline`, `RecipientsRepository.findOwners`, modèle `QuotaAlertService` | `src/modules/notifications/{repositories,domain,services}/` | Alerte `security.sensitive_role_assigned` (e-mail + in-app). |
| `decideEarly` (exemption de préférence `subscription.*`) | `src/modules/notifications/domain/delivery-decision.ts` | Exemption étendue à `security.*`. |
| `maskEmail` | `src/modules/notifications/domain/masking.ts` | Aperçu de réinitialisation (import en lecture seule). |
| `TenantProvisioningService.provision`, `platform.register_tenant`, `platform.resolve_tenant` | `src/infrastructure/tenancy/tenant-provisioning.service.ts`, migrations `20261004000100`, `20261005000300` | Inscription en statut `pending` (OPS). |
| `TenantStatus.pending`, `users.email_verified_at` | `prisma/schema/core.prisma` (existants, inutilisés) | Vérification d'e-mail à l'inscription. |
| `Clock`, `MutableClock` | `src/common/time/clock.ts`, `test/helpers/mutable-clock.ts` | Toute règle datée (délai, expiration des jetons, jobs). |
| Web : `proxy.ts` (garde de session), `extractClientInfo` / `forwardHeaders`, `buildSecurityHeaders`, `needsMfaStep` / `requiredStepPath`, `TotpEnrolment` | `apps/web/src/proxy.ts`, `apps/web/src/lib/api/client-info.ts`, `apps/web/src/lib/security-headers.ts`, `apps/web/src/lib/auth/me.ts`, `apps/web/src/components/forms/TotpEnrolment.tsx` | CSP, profondeur de proxy, enrôlement hors réseau. |
| Guide CSP de la version installée de Next (16.3.8) | `node_modules/.pnpm/next@16.3.8_*/node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md` | **À lire par WEB avant de coder** (nonces, rendu dynamique). |
| Infra de développement | `infra/docker-compose.yml`, `infra/postgres/init/01-roles.sql` | Épinglage par digest, retrait de MinIO. |

### 0.2 Phase 0 — exécutée par l'orchestrateur **avant** le lancement des équipes (un seul commit)
Commit `chore: socle de la phase durcissement sécurité`, qui contient :
1. `packages/shared/src/schemas/primitives.ts` : export `tenantSlug` (déplacement du `slug` privé d'`index.ts`, qui l'importe désormais). Comportement inchangé.
2. `packages/shared/src/schemas/security.ts` et `packages/shared/src/schemas/onboarding.ts` : fichiers vides (en-tête + `export {};`), exportés depuis `schemas/index.ts`.
3. `apps/api/src/modules/onboarding/onboarding.module.ts` : `@Module({})` vide, importé dans `apps/api/src/app.module.ts`.
4. `apps/api/src/common/throttle/throttler-options.ts` : `buildThrottlerOptions(env: Env): ThrottlerModuleOptions` renvoyant `{ throttlers: [DEFAULT_RATE_LIMIT, ACCOUNT_THROTTLER] }` (constante déplacée depuis `app.module.ts`). `app.module.ts` passe à `ThrottlerModule.forRootAsync({ inject: [ENV], useFactory: buildThrottlerOptions })`. Comportement identique.
5. `apps/api/src/common/throttle/account-throttle.ts` : `AccountThrottleKind` complété de `'password_forgot'` (`sha256('pwd|' + slug + '|' + email)`), `'password_reset'` (`sha256('reset|' + token)`) et `'signup_resend'` (`sha256('signup|' + slug + '|' + email)`), avec les tests du traqueur.
6. Variables d'environnement (§8), avec validation et tests (`env-security.spec.ts`) : `src/infrastructure/config/env.ts`, `apps/api/.env.example`, `apps/api/.env.test` ; `apps/web/.env.example`.
7. `apps/web/src/lib/edge.ts` : bouchon `export function isFromTrustedEdge(headers: Pick<Headers, 'get'>): boolean { return true; }` (signature définitive, implémentée par OPS).
8. Vérification : `pnpm --filter @ghmt/shared build && pnpm --filter @ghmt/shared test && pnpm --filter @ghmt/api typecheck && pnpm --filter @ghmt/api test -- env && pnpm --filter @ghmt/web typecheck`.

Après la phase 0, **aucune équipe ne modifie** `schemas/index.ts`, `primitives.ts`, `app.module.ts`, `env.ts` (ni ses specs), `.env.example`, `.env.test`, `apps/web/.env.example`, `catalog.ts` ni `role-templates.ts`. Une équipe qui croit en avoir besoin s'arrête et le signale dans son compte rendu.

### 0.3 Règles du travail parallèle
1. Chaque équipe n'écrit **que** dans les fichiers listés pour elle au §10. Les autres fichiers sont en lecture seule (imports compris).
2. **Schéma Prisma** :
   - AUTH ajoute `apps/api/prisma/schema/security.prisma` et modifie `core.prisma` **uniquement** sur `User.lastSeenAt` (et le commentaire « obsolète » de `UserCredential.lockedUntil`) ;
   - OPS ajoute `apps/api/prisma/schema/onboarding.prisma` ;
   - aucun champ de relation vers les autres fichiers (FK en SQL) ;
   - chaque fichier reste valide à chaque sauvegarde (`prisma validate`).
3. **Migrations** (plages réservées) :

   | Équipe | Migration | Plage des correctifs |
   |---|---|---|
   | AUTH | `20261006000100_auth_hardening` | `20261006000110` à `20261006000190` |
   | OPS | `20261006000200_signup_hardening` | `20261006000210` à `20261006000290` |
   | WEB | aucune | — |

   Procédure inchangée (docs/10 §0.3.3) :
   - DDL par `prisma migrate diff` depuis base + core + platform-saas + billing + notifications, complété en SQL (RLS, GRANT, CHECK, fonctions, triggers) ;
   - validation sur une base jetable avant dépôt ;
   - une migration déposée n'est jamais modifiée.

   La migration OPS **ne référence aucune table AUTH**, et inversement.
4. Toute table `tenant.*` porte `tenant_id`, RLS ENABLE + FORCE et la politique `tenant_isolation`. `test/core/rls-coverage.e2e-spec.ts` reste vert. Les mises à jour de données existantes passent par un bloc `DO` par tenant (modèle `20261005000500`), car FORCE RLS s'applique au propriétaire.
5. **WEB code contre les contrats de ce document sans attendre AUTH ni OPS.** Il n'importe ni `schemas/security.ts` ni `schemas/onboarding.ts` pendant la phase (validations locales, mappeurs tolérants, API simulée). Seule exception : `isFromTrustedEdge` de `lib/edge.ts`, dont la signature est figée en phase 0.
6. Les tests n'exécutent jamais de job en tâche de fond : `SECURITY_JOBS_ENABLED=false` dans `.env.test`, et chaque job expose `runOnce(now, { tenantIds? })`. Les tests restent sur `RATE_LIMIT_STORE=memory`. Seule la spec Redis dédiée (§11.1) remplace `ENV` par `providerOverrides` avec un préfixe de clé unique par exécution.
7. Les contrats croisés AUTH ↔ OPS sont figés ici :
   - AUTH renvoie `403 email_verification_required` à la connexion d'un tenant `pending` (§5.2) ; il le teste en posant le statut directement ;
   - OPS lit `env.SECURITY_JOBS_ENABLED` (phase 0).

## 1. Objectif et périmètre

### 1.1 Objectif
Lever les prérequis sécurité « authentification, front et exploitation » d'une mise en production réelle :
- comptes récupérables sans affaiblir l'authentification ;
- limitation de débit cohérente entre instances ;
- second facteur imposé aux soignants hors des réseaux de l'établissement ;
- détection des administrateurs complices ;
- front protégé par une CSP stricte ;
- topologie de déploiement où l'IP cliente ne peut pas être usurpée.

### 1.2 Périmètre
- **AUTH** :
  - mot de passe oublié et réinitialisation ;
  - limitation de débit sur Redis (multi-instance) ;
  - délai progressif à la place du verrou ;
  - réseaux de confiance et MFA hors réseau pour les rôles cliniques, avec enrôlement hors réseau confirmé par e-mail ;
  - administrateur principal et hiérarchie entre administrateurs, réinitialisation du second facteur par un administrateur ;
  - notification au Directeur des affectations cliniques et financières ;
  - purge planifiée des jetons ;
  - `lastSeenAt`.
- **OPS** :
  - slugs réservés et vérification de l'e-mail à l'inscription (tenant `pending`), avec expiration des inscriptions non confirmées ;
  - côté BFF : `TRUSTED_PROXY_HOPS`, secret de bordure, fin du repli `X-Real-IP` ;
  - images Docker épinglées par digest, retrait de MinIO ;
  - topologie de déploiement de référence (proxy seul exposé).
- **WEB** :
  - CSP stricte à nonces avec `frame-ancestors`, et en-têtes complémentaires ;
  - pages mot de passe oublié, réinitialisation, vérification d'inscription, enrôlement hors réseau, sécurité de l'établissement ;
  - messages et affichage de `lastSeenAt`.

### 1.3 Hors périmètre (renvoyé à la roadmap, annexe de `06-roadmap-mvp.md`, rédigée par OPS)
- Identitovigilance, droits du patient, bris de glace et ABAC, chiffrement KMS et rotation des clés, audit WORM, gouvernance (inchangés dans l'annexe).
- **Authentification** :
  - WebAuthn ;
  - OTP SMS ;
  - « se souvenir de cet appareil » ;
  - notification de connexion depuis un nouvel appareil ;
  - délai de carence de 24 h après réinitialisation du MFA ;
  - pepper applicatif ;
  - CAPTCHA sur pic d'échecs par tenant ;
  - limitation par utilisateur authentifié et par tenant (docs/04 §9.3) ;
  - délai progressif et Redis pour le realm plateforme ;
  - longueur de mot de passe renforcée pour les rôles privilégiés hors inscription.
- **IAM** :
  - transfert de l'administrateur principal par la console plateforme (au MVP : script terminal, §5.7) ;
  - restriction des réseaux de confiance par site ;
  - revue périodique des affectations ;
  - liste des sessions d'un utilisateur.
- **Front** :
  - console plateforme sur sous-domaine distinct ;
  - collecteur interne de rapports CSP ;
  - règle ESLint DOMPurify (aucun `dangerouslySetInnerHTML` aujourd'hui).
- **Déploiement** :
  - Kubernetes (Traefik / CloudNativePG / Argo CD, docs/01) ;
  - stockage objet S3 (choix du remplaçant de MinIO au lot « fichiers ») ;
  - Renovate ;
  - signature des images (cosign) ;
  - fuseau par site ;
  - rétention par pays.

## 2. Décisions d'architecture
| # | Décision |
|---|---|
| D1 | **Jetons à usage unique** (réinitialisation, vérification d'inscription) : `issueOpaqueToken(tenantId)` ; seul le hash SHA-256 est stocké. Ils sont transmis dans le **corps** des requêtes POST, jamais dans une URL de l'API. Les e-mails partent par `MAILER`, hors outbox (le jeton ne doit pas être stocké, docs/10 D7). Les pages web qui reçoivent le lien exigent un clic de confirmation : un scanner d'e-mails qui précharge le lien ne consomme pas le jeton. |
| D2 | **Limitation de débit sur Redis.** `ThrottlerStorage` maison sur `ioredis` : script Lua atomique `INCR` + `PEXPIRE` + blocage, clés `${RATE_LIMIT_KEY_PREFIX}${throttler}:${tracker}`. Si Redis est indisponible, repli sur un stockage mémoire par instance (docs/04 §9.3 « jamais d'absence de limitation »), journal d'erreur au plus une fois par minute et `/health` en `redis: down`. `RATE_LIMIT_STORE=redis` est obligatoire en production (refus au démarrage). Les tests utilisent la mémoire. |
| D3 | **Délai progressif à la place du verrou dur** :<br>- compteur d'échecs **par identifiant soumis** `sha256(tenantSlug\|email)` dans le même stockage, que le compte existe ou non (aucun oracle) ;<br>- après le n-ième échec consécutif, la tentative suivante n'est examinée qu'après `LOGIN_DELAY_SECONDS[n-1]` = `[0,0,0,0,30,60,120,300,600,900]` (plafond 900 s), compté depuis le dernier échec ;<br>- pendant le délai : `429 login_delayed` avec `Retry-After`, **avant** toute résolution du tenant ou vérification du mot de passe, même si le mot de passe est juste ;<br>- compteur expiré 24 h après le dernier échec ; remis à zéro par une connexion réussie, une réinitialisation de mot de passe ou `POST /iam/users/{id}/unlock` ;<br>- `user_credentials.failed_attempts` reste incrémenté (audit, alerte) ; `locked_until` n'est plus écrit (remis à `NULL` par migration, colonne conservée).<br>Au 10e échec consécutif d'un compte existant, un e-mail « tentatives inhabituelles » part, au plus un par 24 h. |
| D4 | **Réseau de confiance** = plages réseau publiques déclarées par l'établissement (`tenant.trusted_networks`), avec un rattachement informatif facultatif à un site.<br>- Une requête est « sur réseau de confiance » si l'IP cliente vue par l'API appartient à une plage active. Cette IP est `RequestContext.state.ip`, établie par `TRUSTED_PROXIES` côté API et `TRUSTED_PROXY_HOPS` + secret de bordure côté BFF ; les adresses IPv4 encapsulées `::ffff:a.b.c.d` sont normalisées.<br>- IP absente ⇒ hors réseau.<br>- L'évaluation est faite **à chaque requête** : une session ouverte à l'hôpital puis utilisée ailleurs est réévaluée.<br>- Plages : préfixe IPv4 ≥ /16, IPv6 ≥ /32, 50 au plus par établissement.<br>- L'interface avertit qu'une IP de box 4G (CGNAT) ou une IP dynamique est partagée ou instable. |
| D5 | **Rôle clinique** = un rôle portant au moins une permission des modules `consultations`, `nursing`, `maternity`, `inpatient`, `laboratory`, `imaging`, `pharmacy` (`CLINICAL_PERMISSION_MODULES`, partagé). Le calcul se fait sur les permissions effectives, pas sur le nom du rôle : un rôle personnalisé est couvert. |
| D6 | **MFA hors réseau** :<br>- `tenant.security_settings.clinical_mfa_mode` vaut `off_network` (défaut) ou `always` ;<br>- en `off_network`, un utilisateur titulaire d'un rôle clinique dont la session n'est pas vérifiée MFA est refusé hors réseau de confiance sur toute route `@RequirePermission`, avec `403 mfa_enrollment_required` (code existant, le web redirige déjà vers `/securite/mfa`) ;<br>- **aucune plage déclarée ⇒ tous les réseaux sont hors confiance** (MFA partout pour les soignants) ;<br>- `/auth/me` (`mfa.required`) et la réponse de login (`mfaRequired`) reflètent la règle pour l'IP courante ;<br>- un utilisateur ayant un TOTP actif est, comme aujourd'hui, toujours challengé à la connexion ;<br>- les rôles `mfaRequired` (admin, directeur, comptable, RH, pharmacien) restent soumis à la MFA partout. |
| D7 | **Enrôlement TOTP hors réseau de confiance** : `POST /auth/mfa/totp/setup` exige un `emailCode` à 6 chiffres envoyé à l'adresse du compte (`POST /auth/mfa/totp/email-code` ; TTL 10 min, 5 essais, hash stocké, 3 envois par 15 min). Sur réseau de confiance, aucun code n'est exigé. La règle vaut pour **tout** utilisateur (le TOFU hors réseau est fermé). Sans TOTP ni accès à son e-mail, il faut s'enrôler sur site ou demander une réinitialisation par un administrateur (§5.6). |
| D8 | **Mot de passe oublié** :<br>- `POST /auth/password/forgot` répond **toujours** `202` juste après validation et limitation ;<br>- résolution, recherche, jeton et e-mail s'exécutent après la réponse (`BackgroundTasks`, `drain()` pour les tests), donc aucun écart de temps ni de réponse ;<br>- éligibilité : même règle de tenant que la connexion, utilisateur `active` avec mot de passe ;<br>- jeton 256 bits, TTL 30 min, une nouvelle demande invalide les précédentes ;<br>- second facteur exigé si un TOTP est actif (code TOTP ou code de secours) ;<br>- à la validation : **toutes** les sessions révoquées (`password_reset`), compteur d'échecs remis à zéro, `email_verified_at` renseigné s'il était nul, e-mail de confirmation sans jeton, pas de connexion automatique. |
| D9 | **Hiérarchie entre administrateurs** :<br>- `tenant.security_settings.owner_user_id` = **administrateur principal**, posé par trigger à la première affectation `tenant_admin` portée établissement, et rattrapé par migration pour les tenants existants (affectation `tenant_admin` active la plus ancienne) ;<br>- rang : 2 = principal ; 1 = titulaire d'un rôle d'administration en écriture (`iam:*` hors `:read`, règle `isAdministrativeWrite`) ; 0 = autres ;<br>- toute action d'un acteur sur un **autre** utilisateur de rang ≥ 1 exige `rang(acteur) > rang(cible)`, sinon `403 admin_hierarchy`. Actions concernées : `PATCH /iam/users/{id}`, `disable`, `enable`, `unlock`, `DELETE …/sessions`, `POST`/`DELETE …/assignments`, `DELETE …/mfa`, `POST …/invitation` ;<br>- accorder un rôle d'administration en écriture (affectation ou invitation) est réservé au principal (`403 owner_required`) ;<br>- le principal ne peut se désactiver ni perdre son rôle `tenant_admin` sans avoir transféré le titre (`409 owner_must_transfer`) ;<br>- transfert : `POST /iam/security/owner` par le principal seul, vers un administrateur actif ayant un TOTP actif. |
| D10 | **Notification au Directeur** : toute affectation d'un rôle sensible (`isSensitiveRole`, inchangé) crée, dans la transaction de l'affectation, des notifications `security.sensitive_role_assigned` (e-mail et in-app).<br>- Destinataires : titulaires actifs du rôle système `director` à portée établissement, hors acteur et hors cible.<br>- À défaut : l'administrateur principal, s'il n'est ni l'acteur ni la cible.<br>- À défaut : personne (l'audit reste la trace) ; `changes.notifiedCount` est ajouté à `iam.role.sensitive_assigned`.<br>- La préférence « e-mail administratif » ne supprime pas ce type (même exemption que `subscription.*`).<br>- Aucune donnée patient ; le nom du service visé n'est jamais transmis (seul le type de portée l'est). |
| D11 | **IP cliente côté BFF** :<br>- `TRUSTED_PROXY_HOPS = n` ⇒ l'IP retenue est l'entrée `length − n` de `X-Forwarded-For` (n-ième en partant de la fin) ; moins de `n` entrées ⇒ aucune IP ;<br>- plus de repli `X-Real-IP` ;<br>- **secret de bordure** `EDGE_PROXY_SECRET` : le proxy injecte `X-Ghmt-Edge-Auth` en écrasant toute valeur reçue, et le BFF le compare en temps constant ;<br>- en production, une requête sans secret valide reçoit `403` de `proxy.ts` (`isFromTrustedEdge`), et `extractClientInfo` n'en retient aucune IP ;<br>- sans cette garde, un accès direct au BFF permettrait de forger l'IP de l'hôpital et de contourner D6. |
| D12 | **Inscription vérifiée** :<br>- `POST /auth/signup` crée le tenant en statut **`pending`** ; l'administrateur est `active` avec `email_verified_at` nul ;<br>- e-mail de vérification avec jeton (TTL 24 h) ;<br>- la confirmation active le tenant via `platform.activate_pending_tenant()` (`SECURITY DEFINER`) et renseigne `email_verified_at` ;<br>- sans confirmation sous 7 jours, le tenant passe `terminated`, reçoit `deleted_at` et son slug est renommé `expired-<id>` (identifiant libéré) ;<br>- l'essai démarre toujours à la création (inchangé) ;<br>- `provision()` garde le statut `active` par défaut : les fixtures de test sont inchangées. |
| D13 | **Slugs réservés** : liste partagée `RESERVED_TENANT_SLUGS` et préfixes `xn--` et `ghmt`, recopiés dans `platform.reserved_slugs` (même contenu, vérifié par test) et contrôlés aussi par `platform.register_tenant`. La réponse est `422 slug_reserved` sur `establishment.slug`. Les tenants existants ne sont pas renommés. |
| D14 | **CSP stricte à nonces** posée par `proxy.ts` sur toute réponse couverte par le matcher (nonce de 128 bits par requête, CSP également posée sur l'en-tête de requête pour que Next l'applique). Pages en rendu dynamique (`await connection()` dans `app/layout.tsx`). `CSP_MODE=report-only` disponible pour la pré-production ; mode `enforce` par défaut. |
| D15 | **`lastSeenAt`** : `tenant.users.last_seen_at`, renseigné à la connexion et au refresh (mise à jour conditionnelle si l'ancienne valeur a plus de 5 min). La granularité est la durée du jeton d'accès (15 min) ; aucune écriture par requête. Exposé dans `GET /iam/users` et `GET /iam/users/{id}`. |
| D16 | **Purge planifiée** (`AuthTokenPurgeJob`, 03:45 UTC, plus une passe 60 s après le démarrage, si `SECURITY_JOBS_ENABLED`), par tenant via `runAs`, au plus 5 000 lignes par table et par passe :<br>- `refresh_tokens` expirés depuis plus de 1 j ;<br>- `sessions` expirées ou révoquées depuis plus de 30 j (cascade) ;<br>- `mfa_challenges` et `mfa_email_codes` expirés depuis plus de 1 j ;<br>- `invitations` consommées ou expirées depuis plus de 30 j ;<br>- `password_reset_tokens` expirés depuis plus de 1 j.<br>Journal des comptes, sans audit par ligne. Les jetons OPS sont purgés par le job OPS (§6.3). |

## 3. Modèle de données

### 3.1 Équipe AUTH — `prisma/schema/security.prisma` (+ `core.prisma` : `User.lastSeenAt`), migration `20261006000100_auth_hardening`
Clés composites `(tenant_id, id)`, `id uuid` v7, RLS sur toutes les tables.

**`tenant.password_reset_tokens`** (modèle `PasswordResetToken`)
- Colonnes : `id`, `tenant_id`, `user_id` (FK composite `tenant.users`), `token_hash bytea`, `expires_at`, `consumed_at`, `attempts smallint` (défaut 0, essais de second facteur), `requested_ip inet`, `created_at`.
- `UNIQUE (tenant_id, token_hash)`.
- Index `(tenant_id, user_id) WHERE consumed_at IS NULL` et `(tenant_id, expires_at)`.

**`tenant.mfa_email_codes`** (modèle `MfaEmailCode`)
- Colonnes : `id`, `tenant_id`, `user_id`, `session_id` (FK composite `tenant.sessions`, `ON DELETE CASCADE`), `code_hash bytea` (HMAC-SHA256 avec une clé dérivée de `BLIND_INDEX_KEY`, libellé `ghmt:auth:mfa-email-code`), `attempts smallint`, `expires_at`, `consumed_at`, `created_at`.
- Index `(tenant_id, session_id, created_at DESC)`.

**`tenant.trusted_networks`** (modèle `TrustedNetwork`)
- Colonnes : `id`, `tenant_id`, `network inet` (forme réseau normalisée, Prisma `@db.Inet`), `label varchar(80)`, `site_id uuid` (nullable, FK composite `tenant.sites`), `created_by`, `created_at`, `deleted_at`.
- `CHECK (masklen(network) >= CASE family(network) WHEN 4 THEN 16 ELSE 32 END)`.
- `CHECK (network = set_masklen(network(network)::inet, masklen(network)))`.
- `uq_trusted_networks_active (tenant_id, network) WHERE deleted_at IS NULL`.

**`tenant.security_settings`** (modèle `SecuritySettings`, au plus une ligne par tenant)
- Colonnes : `tenant_id` (PK), `owner_user_id uuid` (FK composite `tenant.users`, nullable), `clinical_mfa_mode text` (défaut `off_network`, `CHECK IN ('off_network','always')`), `updated_by`, `updated_at`.

**`tenant.users`** : ajout de `last_seen_at timestamptz NULL`.

**SQL complémentaire** :
1. Trigger `tenant.ensure_tenant_owner()` `AFTER INSERT ON tenant.user_role_assignments` : si le rôle a `template_code = 'tenant_admin'`, que `scope_type = 'tenant'` et qu'il n'existe aucune ligne `security_settings` ⇒ `INSERT … (tenant_id, owner_user_id) … ON CONFLICT DO NOTHING`. Exécuté par l'appelant (`ghmt_app`, RLS respectée).
2. Bloc `DO` par tenant : rattrapage de `security_settings` (principal = utilisateur actif de l'affectation `tenant_admin` établissement non révoquée la plus ancienne) et `UPDATE tenant.user_credentials SET locked_until = NULL`.
3. Index `ix_sessions_purge (tenant_id, expires_at)` existant réutilisé ; ajout de `ix_sessions_revoked (tenant_id, revoked_at) WHERE revoked_at IS NOT NULL` et `ix_refresh_tokens_expires (tenant_id, expires_at)`.

### 3.2 Équipe OPS — `prisma/schema/onboarding.prisma`, migration `20261006000200_signup_hardening`
**`tenant.signup_verifications`** (modèle `SignupVerification`)
- Colonnes : `id`, `tenant_id`, `user_id` (FK composite), `token_hash bytea`, `expires_at`, `consumed_at`, `created_at`.
- `UNIQUE (tenant_id, token_hash)` ; index `(tenant_id, user_id) WHERE consumed_at IS NULL`.

**`platform.reserved_slugs`** (modèle `ReservedSlug`, `@@schema("platform")`)
- Colonnes : `slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$')`, `reason text NOT NULL`.
- Alimentée par la migration avec `RESERVED_TENANT_SLUGS` (§7.2).
- Aucun droit pour `ghmt_app` (lecture via les fonctions ci-dessous) ; droits par défaut de `ghmt_platform`.

**Fonctions** (`SECURITY DEFINER`, `SET search_path = pg_catalog, platform, pg_temp`, `REVOKE ALL FROM PUBLIC`) :
- `platform.slug_status(p_slug text) RETURNS text` : `'reserved'` (table ou préfixe `xn--` / `ghmt`), `'taken'` (tenant existant, même supprimé), sinon `'available'`. `EXECUTE` à `ghmt_app`.
- `platform.register_tenant(…, p_modules text[], p_status platform.tenant_status DEFAULT 'active')` :
  - remplace l'ancienne signature (`DROP FUNCTION` puis `CREATE`) ;
  - refuse `p_status NOT IN ('active','pending')` ainsi qu'un slug réservé, avec `RAISE … ERRCODE '22023'` et un message `reserved slug` ;
  - `EXECUTE` à `ghmt_app`.
- `platform.activate_pending_tenant() RETURNS boolean` : lit `app.tenant_id` et fait `UPDATE platform.tenants SET status = 'active', updated_at = now() WHERE id = … AND status = 'pending' AND deleted_at IS NULL`. Renvoie vrai si une ligne est modifiée. `EXECUTE` à `ghmt_app`.

## 4. Permissions
Aucune nouvelle permission.

| Code | Statut | Rôles système | Usage |
|---|---|---|---|
| `iam:policy:read` / `iam:policy:update` | existant (catalogue), couvert par `iam:*:*` | tenant_admin | Politique MFA, réseaux de confiance, transfert du principal (le transfert exige en plus d'être le principal) |
| `iam:user:update` | existant | tenant_admin | `DELETE /iam/users/{id}/mfa`, `unlock` (efface aussi le délai) |
| `iam:user:read` | existant | tenant_admin, director | `lastSeenAt` dans les vues utilisateur |
| (aucune) `@Public` | — | — | Mot de passe oublié et réinitialisation, vérification et renvoi d'inscription |
| (aucune) `@AuthenticatedOnly` | — | tout utilisateur | `POST /auth/mfa/totp/email-code` |

## 5. Contrats d'API — Équipe AUTH
Format d'erreur `problem+json` enveloppé. Identifiant mal formé : `404`. Ressource d'un autre tenant : `404`.

### 5.1 Mot de passe oublié et réinitialisation (`@Public`, contrôleur `auth/password` existant)
| Méthode | Chemin | Limites | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| POST | `/auth/password/forgot` | IP 10 / 15 min ; identifiant (`password_forgot`) 3 / 15 min | `forgotPasswordSchema { tenantSlug, email }` | **202** `{ accepted: true }` dans tous les cas | 422 validation ; 429 |
| POST | `/auth/password/reset/preview` | IP 30 / 15 min | `passwordResetTokenSchema { token }` | 200 `PasswordResetPreview { tenantSlug, emailMasked, mfaRequired }` | 410 `reset_token_invalid` |
| POST | `/auth/password/reset` | IP 10 / 15 min ; jeton (`password_reset`) 6 / 15 min | `resetPasswordSchema { token, newPassword, mfaCode? }` | **204** | 410 `reset_token_invalid` ; 422 `mfa_code_required` (chemin `mfaCode`) ; 422 `invalid_code` ; 422 validation ; 429 |

Règles :
- **Jeton invalide** : inconnu, expiré, consommé, utilisateur non `active` ou tenant inéligible ⇒ même `410 reset_token_invalid`.
- **Second facteur** : `invalid_code` incrémente `attempts` ; au 5e essai, le jeton est consommé (410 ensuite). Un code de secours utilisé est retiré du lot (logique de `mfa-verify.service.ts`).
- **Consommation** : `UPDATE … WHERE consumed_at IS NULL` conditionnel ; deux requêtes concurrentes ⇒ une seule réussit.
- **Effets de la réussite** (une transaction) :
  - nouveau hash, `password_changed_at`, `must_change_password=false`, `failed_attempts=0` ;
  - autres jetons de l'utilisateur consommés ;
  - `UPDATE sessions SET revoked_at, revoked_reason='password_reset'` pour toutes ses sessions ;
  - `email_verified_at` renseigné s'il était nul ;
  - audit ;
  - puis effacement du compteur de délai (D3) et e-mail « mot de passe modifié ».
- **E-mails** (`src/common/mail/password-reset-email.ts`) :
  - lien `${WEB_URL}/reinitialiser/<token>`, TTL 30 min, code établissement, mention « si vous n'êtes pas à l'origine… » ;
  - e-mail de confirmation sans lien porteur de jeton ;
  - jamais journalisés.
- **Audit** :
  - `auth.password.reset_requested` (acteur = l'utilisateur, seulement si éligible) ;
  - `auth.password.reset_failed` (`{ reason: 'invalid_mfa' | 'token_burned' }`) ;
  - `auth.password.reset_completed` (`{ revokedSessions }`).

### 5.2 Connexion : délai progressif et inscription non vérifiée (`POST /auth/login`, contrat inchangé hors erreurs)
- **`429 login_delayed`** :
  - `detail` : « Trop de tentatives pour ce compte. Réessayez dans N secondes. » ;
  - en-tête `Retry-After: N` et `details: { retryAfterSeconds: N }` ;
  - renvoyé avant toute résolution, identique pour un identifiant inexistant.
- **Échec** : `401 invalid_credentials` comme aujourd'hui ; incrément du compteur de délai ; audit `auth.login.failed` (`changes.reason`, `delayed: false`) inchangé hors `locked`. Le motif `locked` disparaît.
- **Tenant `pending`** : avec un mot de passe correct, `403 email_verification_required` (« Confirmez l'adresse e-mail de l'administrateur pour activer l'établissement. ») ; avec un mot de passe incorrect, 401 comme d'habitude.
- **Succès** : effacement du compteur, `users.last_seen_at` et `last_login_at`, `mfaRequired` calculé avec D6.
- **Alerte** : au 10e échec consécutif d'un compte existant, e-mail « tentatives inhabituelles » avec lien vers `/mot-de-passe-oublie`, au plus un par 24 h (clé `login:alerted:{tenantId}:{userId}`) ; audit `auth.login.suspicious_activity_notified`.
- **`POST /iam/users/{id}/unlock`** : remet `failed_attempts=0` et efface le compteur de délai de `slug|email` de l'utilisateur ; audit `iam.user.unlocked` inchangé.
- **Changement de mot de passe** : `password-change.service.ts` conserve l'incrément de `failed_attempts`, sans verrou.

### 5.3 Limitation de débit multi-instance (D2)
Fichiers :
- `common/redis/redis.provider.ts` : jeton `REDIS_CLIENT` (`null` si `memory`), fermeture au `onModuleDestroy`, `lazyConnect`, `maxRetriesPerRequest: 1`, délai de commande 200 ms ;
- `common/rate-limit/` : `RateLimitStore` (`hit`, `get`, `reset`), implémentations `RedisRateLimitStore`, `MemoryRateLimitStore` et `ResilientRateLimitStore` (Redis puis repli mémoire), adaptateur `RateLimitThrottlerStorage implements ThrottlerStorage` ;
- `buildThrottlerOptions(env)` passe `storage` ;
- `LoginDelayService` utilise le même `RateLimitStore` ;
- `/health` ajoute `checks.redis: 'up' | 'down' | 'disabled'`.

Les limites existantes sont inchangées (`auth.constants.ts`).

### 5.4 Réseaux de confiance et politique MFA (`modules/iam`, contrôleur `iam/security`)
| Méthode | Chemin | Permission | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| GET | `/iam/security/policy` | `iam:policy:read` | — | `SecurityPolicyView` | — |
| PUT | `/iam/security/policy` | `iam:policy:update` | `updateSecurityPolicySchema { clinicalMfa: 'off_network'\|'always' }` | `SecurityPolicyView` | 422 |
| POST | `/iam/security/trusted-networks` | `iam:policy:update` | `createTrustedNetworkSchema { cidr, label, siteId? }` | 201 `TrustedNetworkView` | 422 `invalid_cidr`, `cidr_too_broad`, `trusted_network_limit` (50), `scope_not_found` (site) ; 409 `trusted_network_exists` |
| DELETE | `/iam/security/trusted-networks/{id}` | `iam:policy:update` | — | 204 | 404 |
| POST | `/iam/security/owner` | `iam:policy:update` **et** être le principal | `transferOwnershipSchema { userId }` | 200 `SecurityPolicyView` | 403 `owner_required` ; 422 `owner_target_invalid` (pas administrateur actif à portée établissement, ou pas de TOTP actif, ou soi-même) |

Vues :
- `SecurityPolicyView = { clinicalMfa, trustedNetworks: TrustedNetworkView[], requestIp: string | null, requestIpTrusted: boolean, owner: { id, fullName } | null, updatedAt: string | null }` ;
- `TrustedNetworkView = { id, cidr, label, siteId | null, createdAt, createdBy: { id, fullName } | null }`.

Audit :
- `iam.security.policy_updated` (`{ clinicalMfa }`) ;
- `iam.security.trusted_network_added` / `_removed` (`{ cidr, label, siteId }`) ;
- `iam.owner.transferred` (`{ fromUserId, toUserId }`).

**Évaluation** :
- `PermissionGuard` charge, dans sa transaction, `security_settings.clinical_mfa_mode` et `EXISTS (SELECT 1 FROM tenant.trusted_networks WHERE deleted_at IS NULL AND $ip::inet <<= network)`, en une requête.
- `evaluateAuthorization` reçoit `networkTrusted: boolean` et `clinicalMfaMode`. `mfaRequired = grants.some(g => g.mfaRequired) || (isClinical(grants) && (mode === 'always' || !networkTrusted))`.
- Refus : `mfa_enrollment_required` (code inchangé), audit `authz.denied` avec `changes.offNetwork: true`.
- `ProfileService.me` et `LoginCompletionService` utilisent la même fonction pure `clinicalMfaRequired(...)` (`common/authz/clinical-mfa.ts`).

### 5.5 Enrôlement TOTP hors réseau (D7)
| Méthode | Chemin | Accès | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| POST | `/auth/mfa/totp/email-code` | `@AuthenticatedOnly`, 3 / 15 min | — | 202 `{ sent: true, emailMasked }` | 409 `mfa_already_enrolled` ; 422 `email_code_not_required` (sur réseau de confiance) |
| POST | `/auth/mfa/totp/setup` | `@AuthenticatedOnly` (existant) | `mfaSetupSchema { emailCode? }` (corps facultatif) | 200 `TotpSetupResponse` (inchangé) | 403 `mfa_email_code_required` (hors réseau sans code) ; 422 `invalid_email_code` (5 essais puis code invalidé) ; 409 `mfa_already_enrolled` |

Règles :
- Le code est lié à la session et consommé à la réussite du `setup` (pas de l'`activate`, inchangé).
- Audit : `auth.mfa.email_code_sent`, `auth.mfa.email_code_failed`.

### 5.6 Réinitialisation du second facteur par un administrateur
| Méthode | Chemin | Permission | Réponse | Erreurs |
|---|---|---|---|---|
| DELETE | `/iam/users/{id}/mfa` | `iam:user:update` | 204 | 404 ; 403 `admin_hierarchy` ; 409 `mfa_not_enrolled` ; 422 `self_mfa_reset` (soi-même) |

Effets :
- suppression du facteur `totp` ;
- révocation de toutes les sessions (`mfa_reset`) ;
- audit `iam.user.mfa_reset` ;
- e-mail à l'utilisateur.

Au prochain accès, l'enrôlement suit D7.

### 5.7 Hiérarchie entre administrateurs (D9)
- Fonction pure `adminRank({ isOwner, permissions })` et garde `assertCanManage(actor, target)` dans `modules/iam/services/admin-hierarchy.ts`, appelées par `UsersService` et `AssignmentsService` (y compris `createInTx` lors d'une invitation).
- `isAdministrativeWrite` est exporté depuis `privilege.ts`.
- Codes :
  - `403 admin_hierarchy` : « Seul l'administrateur principal peut agir sur un autre administrateur. » ;
  - `403 owner_required` ;
  - `409 owner_must_transfer`.
- **Perte du principal** (personne partie) : script terminal `apps/api/scripts/transfer-tenant-owner.mts` (rôle de migration, refus si la sortie standard est redirigée, modèle `create-platform-admin.mts`). Il exige le slug et l'e-mail du nouveau principal, qui doit être un administrateur actif. Il écrit l'audit `iam.owner.transferred` avec l'acteur `system` et `changes.via: 'cli'`.

### 5.8 Notification au Directeur (D10)
- `NOTIFICATION_TYPES['security.sensitive_role_assigned']` = `{ category: 'administrative', recipient: 'user', channels: ['email','inapp'], variables: ['etablissement.nom','utilisateur.nom','role.nom','portee.type','acteur.nom','lien'] }`.
- `portee.type` ∈ « l'établissement », « un site », « un service ».
- Modèles par défaut FR/EN (validés par le linter en CI), dans `templates/default-templates.ts`.
- `SecurityAlertService.sensitiveRoleAssigned(tx, tenantId, { assignmentId, targetUserId, roleName, scopeType, actorUserId }, now)`, exporté par `NotificationsModule`, importé par `IamModule` :
  - `subjectType: 'user_role_assignment'`, `subjectId: assignmentId` ;
  - `context` : `{ targetUserId, targetName, roleName, scopeType, actorName }` ;
  - `dedupKey` : `sourceKey = assignmentId`.
- Rendu : `delivery-preparer.ts` ajoute la branche `security.*` (variables, lien in-app `/administration/utilisateurs/{targetUserId}`).
- `decideEarly` exempte `security.*` de la préférence e-mail.
- `RecipientsRepository.findDirectors(tx, tenantId, now)`.

### 5.9 Purge et `lastSeenAt`
- `AuthTokenPurgeJob.runOnce(now, { tenantIds? })` (D16) : la liste des tenants vient de `PlatformDb`. Suppression par lots `DELETE … WHERE (tenant_id, id) IN (SELECT … LIMIT 5000)`. Journal `{ tenantId, table, deleted }`.
- `last_seen_at` (D15) est ajouté à `USER_SELECT` / `toUserDto` (`lastSeenAt: string | null`).

## 6. Contrats d'API et d'exploitation — Équipe OPS

### 6.1 Inscription (`POST /auth/signup`, chemin, corps et réponse 201 `{ tenantId, slug }` inchangés)
- `SignupService` :
  - appelle `platform.slug_status` : `reserved` ⇒ `422 slug_reserved` (`errors[].path = establishment.slug`), `taken` ⇒ `409 slug_taken` (inchangé) ;
  - provisionne avec `initialStatus: 'pending'` (`provision(input, hash, modules, { initialStatus })`) ;
  - crée la vérification dans la même transaction ;
  - envoie l'e-mail **après** la validation : un échec SMTP est journalisé (`errorClass` seul) et la réponse reste 201, l'utilisateur dispose du renvoi.
- E-mail `src/common/mail/signup-verification-email.ts` : lien `${WEB_URL}/inscription/confirmer/<token>`, TTL 24 h, code établissement.
- Audit `tenant.signup_verification_sent` (acteur : l'administrateur).

### 6.2 Vérification et renvoi (`modules/onboarding`, contrôleur `@Controller('auth/signup')`, `@Public`)
| Méthode | Chemin | Limites | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| POST | `/auth/signup/verify` | IP 20 / 15 min | `verifySignupSchema { token }` | 200 `SignupVerificationResult { tenantSlug }` | 410 `verification_token_invalid` (inconnu, expiré, consommé, tenant non `pending` ou supprimé) |
| POST | `/auth/signup/resend` | IP 5 / h ; identifiant (`signup_resend`) 3 / h | `resendSignupVerificationSchema { tenantSlug, email }` | **202** `{ accepted: true }` dans tous les cas (traitement après la réponse) | 422 validation ; 429 |

Vérification :
- dans `runAs(tenantId)` : consommation conditionnelle, `users.email_verified_at = now()`, `platform.activate_pending_tenant()`, audit `tenant.signup_verified` ;
- la vérification n'ouvre pas de session ;
- un renvoi valide (tenant `pending` non expiré, e-mail de l'administrateur fondateur) invalide les jetons précédents.

### 6.3 Expiration des inscriptions non confirmées
`PendingSignupExpiryJob` (04:00 UTC, plus une passe 60 s après le démarrage, si `SECURITY_JOBS_ENABLED`), avec `runOnce(now)` :
- traite, par `PlatformDb`, les tenants `pending` créés il y a plus de `PENDING_SIGNUP_EXPIRY_DAYS` (7) jours : `status='terminated'`, `deleted_at=now()`, `slug='expired-'||id` ;
- audit plateforme `tenant.signup_expired` (`{ tenantId, previousSlug }`) ;
- purge aussi les `signup_verifications` expirées depuis plus de 1 j (par `runAs`).

### 6.4 IP cliente côté BFF (`apps/web`, fichiers OPS)
- `lib/config.ts` :
  - `getTrustedProxyHops(env)` : entier 0..5 ; absent hors production ⇒ 1 (compatibilité) ; absent ou nul en production ⇒ erreur ;
  - `getEdgeProxySecret(env)` : 32 caractères ou plus, obligatoire en production.
- `lib/api/client-info.ts` — `extractClientInfo(headers, options?)` :
  - secret configuré et `x-ghmt-edge-auth` invalide ⇒ `ip: undefined` ;
  - entrées de `x-forwarded-for` découpées et nettoyées ; `chain.length < hops` ⇒ `undefined` ;
  - IP = `chain[chain.length − hops]` validée par `isIP`, `::ffff:` normalisé ;
  - **plus de lecture de `x-real-ip`** ;
  - `forwardHeaders` inchangé (le secret n'est jamais transmis à l'API).
- `lib/edge.ts` : `isFromTrustedEdge(headers)` renvoie vrai si aucun secret n'est configuré, sinon fait la comparaison en temps constant (`timingSafeEqual` sur des tampons de même longueur).
- `src/instrumentation.ts` : `register()` valide `TRUSTED_PROXY_HOPS` et `EDGE_PROXY_SECRET` au démarrage du serveur Next (échec immédiat en production).

### 6.5 Images et infrastructure
- `infra/docker-compose.yml` :
  - chaque image est épinglée `nom:version@sha256:<digest>` (digest relevé par `docker buildx imagetools inspect`, version lisible en commentaire) : `postgres:17.x-alpine`, `redis:7.x-alpine`, `axllent/mailpit:v1.x` ;
  - **MinIO est retiré** (aucun code n'utilise S3 ; `minio/minio:latest` n'est plus publié) ;
  - un commentaire renvoie au lot « fichiers » de la roadmap ;
  - ports toujours liés à `127.0.0.1`.
- `pnpm infra:up` doit réussir.
- README et docs/07 mis à jour (`PostgreSQL 17, Redis, Mailpit`).

### 6.6 Topologie de déploiement de référence (`infra/deploy/`)
- `apps/api/Dockerfile` et `apps/web/Dockerfile` :
  - multi-étapes, base `node:22-alpine@sha256:…` ;
  - `pnpm deploy --prod` ;
  - utilisateur non root, `NODE_ENV=production` ;
  - `HEALTHCHECK` sur `/api/v1/health` et `/connexion`.
- `.dockerignore` à la racine.
- `infra/deploy/compose.prod.yml` :
  - Traefik épinglé par digest, seul service publiant 80/443 ;
  - `web` et `api` sans `ports:`, sur un réseau `edge` interne ;
  - aucun Postgres (base gérée), Redis interne ;
  - variables : `TRUSTED_PROXY_HOPS=1`, `EDGE_PROXY_SECRET` et `TRUSTED_PROXIES` = sous-réseau du réseau `edge`.
- `infra/deploy/traefik/` :
  - routeur `/{api/v1}` vers l'API, le reste vers `web` ;
  - middleware `headers.customRequestHeaders.X-Ghmt-Edge-Auth` (valeur issue d'une variable, écrase la valeur reçue) ;
  - `forwardedHeaders.trustedIPs` vide (aucun amont) ;
  - redirection HTTPS, TLS ACME ;
  - limite de débit d'entrée.
- `infra/deploy/README.md` (« topologie documentée ») :
  - chaîne des proxys, valeurs de `TRUSTED_PROXY_HOPS` par topologie (1 = Traefik seul ; 2 = CDN/LB + Traefik) ;
  - interdiction d'exposer `web` ;
  - rotation du secret de bordure ;
  - vérifications post-déploiement.

## 7. Schémas Zod partagés

### 7.1 `packages/shared/src/schemas/security.ts` (AUTH ; importe `./password` et `./primitives`, jamais `./index`)
**Constantes** :
- `CLINICAL_MFA_MODES = ['off_network','always']` ;
- `CLINICAL_PERMISSION_MODULES` (D5) ;
- `TRUSTED_NETWORK_MAX = 50`, `TRUSTED_NETWORK_MIN_PREFIX = { v4: 16, v6: 32 }` ;
- `LOGIN_DELAY_SECONDS` (D3) ;
- `PASSWORD_RESET_TTL_MINUTES = 30`, `MFA_EMAIL_CODE_TTL_MINUTES = 10`.

**Schémas** :
- `forgotPasswordSchema` ;
- `passwordResetTokenSchema` (`token` 32..256, motif `^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$`) ;
- `resetPasswordSchema` (`newPassword: passwordSchema`, `mfaCode` au motif de `mfaVerifySchema`) ;
- `mfaSetupSchema` (`emailCode` `^\d{6}$` facultatif) ;
- `updateSecurityPolicySchema` ;
- `createTrustedNetworkSchema` (`cidr` validé par `parseCidr`, `label` 2..80, `siteId` uuid facultatif) ;
- `transferOwnershipSchema`.

**Fonction pure** : `parseCidr(value) ⇒ { family, prefix, network } | null` (sans dépendance).

**Types** : `PasswordResetPreview`, `SecurityPolicyView`, `TrustedNetworkView`, `MfaEmailCodeResponse`.

Tests : `security.test.ts`.

### 7.2 `packages/shared/src/schemas/onboarding.ts` (OPS)
**Liste réservée** : `RESERVED_TENANT_SLUGS`, au minimum :

```
www, api, app, admin, administration, plateforme, platform, console, support, aide, help, status, statut, mail, smtp, imap, static, assets, cdn, docs, blog, auth, login, connexion, inscription, signup, compte, account, billing, facturation, paiement, payment, security, securite, dev, staging, preprod, prod, test, demo, sandbox, internal, system, root, null, undefined
```

**Autres constantes** : `RESERVED_SLUG_PREFIXES = ['xn--','ghmt']`, `isReservedTenantSlug(slug)`, `SIGNUP_VERIFICATION_TTL_HOURS = 24`, `PENDING_SIGNUP_EXPIRY_DAYS = 7`.

**Schémas** : `verifySignupSchema`, `resendSignupVerificationSchema`. **Type** : `SignupVerificationResult`.

Tests : `onboarding.test.ts`.

### 7.3 `packages/shared/src/schemas/notifications.ts` (AUTH, ajout seul)
Type `security.sensitive_role_assigned` (§5.8) et ses variables ; `notifications.test.ts` complété.

## 8. Variables d'environnement (phase 0)
**API** (`env.ts`, `.env.example`, `.env.test`)

| Variable | Validation / défaut | `.env.test` |
|---|---|---|
| `REDIS_URL` | URL `redis://` ou `rediss://`, facultative | `redis://localhost:6379/15` |
| `RATE_LIMIT_STORE` | `memory\|redis`, défaut `memory`. `redis` exige `REDIS_URL`. En production, `redis` est obligatoire (erreur au démarrage) | `memory` |
| `RATE_LIMIT_KEY_PREFIX` | `^[a-z0-9:_-]{1,32}$`, défaut `ghmt:rl:` | — |
| `SECURITY_JOBS_ENABLED` | `'true'\|'false'`, défaut `true` | `false` |

`.env.example` : `REDIS_URL=redis://localhost:6379/0`, `RATE_LIMIT_STORE=redis`.

**Web** (`apps/web/.env.example` ; lecture : OPS pour les deux premières, WEB pour les CSP)

| Variable | Validation / défaut |
|---|---|
| `TRUSTED_PROXY_HOPS` | entier 0..5 ; absent hors production ⇒ 1 ; production : obligatoire, 1 ou plus |
| `EDGE_PROXY_SECRET` | 32 caractères ou plus ; obligatoire en production |
| `CSP_MODE` | `enforce\|report-only`, défaut `enforce` |
| `CSP_REPORT_URI` | URL https, facultative (`report-uri` et `report-to`) |
| `CSP_FORM_ACTION_ORIGINS` | origines https séparées par des virgules, facultatives (passerelles de paiement vers lesquelles une Server Action redirige, cf. `checkoutRedirectTarget`) |

`redact.ts` : AUTH ajoute `req.headers["x-ghmt-edge-auth"]` aux chemins masqués.

## 9. Front — Équipe WEB (`apps/web`)
Règles communes de docs/10 §9 :
- français ;
- `describeApiError` (nouveaux codes dans `lib/api/messages.ts`) ;
- Server Actions (`FormState`) ;
- aucun jeton ni identifiant dans les journaux.

### 9.1 CSP et en-têtes
**`lib/csp.ts`** (pur, testé) :
- `generateNonce()` : 16 octets aléatoires en base64 ;
- `buildContentSecurityPolicy({ nonce, dev, reportUri, formActionOrigins })`.

```
default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' [dev: 'unsafe-eval'];
style-src 'self' 'nonce-…'; img-src 'self' data: blob:; font-src 'self';
connect-src 'self' [dev: ws:]; object-src 'none'; base-uri 'none'; frame-src 'none';
frame-ancestors 'none'; form-action 'self' [CSP_FORM_ACTION_ORIGINS]; manifest-src 'self';
worker-src 'self'; [prod: upgrade-insecure-requests]; [report-uri …]
```

**`proxy.ts`** :
- `isFromTrustedEdge(request.headers)` faux en production ⇒ `403` texte brut ;
- nonce par requête ; CSP posée sur l'en-tête de **requête** (avec `x-nonce`) et sur la **réponse**, pour `next()` comme pour les redirections ;
- `Content-Security-Policy-Report-Only` si `CSP_MODE=report-only` ;
- `Cache-Control: private, no-store` sur toute page non publique ;
- matcher inchangé.

**`app/layout.tsx`** : `await connection()` (rendu dynamique, guide Next installé, §« Forcing dynamic rendering »).

**`lib/security-headers.ts`** (statiques, `next.config.ts`) :
- existants : `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS en production ;
- ajouts : `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Origin-Agent-Cluster: ?1`, `X-DNS-Prefetch-Control: off` ;
- `Permissions-Policy` étendue : `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`.

**`eslint.config.mjs`** : interdit les props `style` et `dangerouslySetInnerHTML` (`react/forbid-dom-props`, `react/no-danger`).

### 9.2 Pages et parcours
| Route | Contenu | Actions (fichier) | Appels API |
|---|---|---|---|
| `/connexion` | Lien « Mot de passe oublié ? » ; `login_delayed` : « Réessayez dans N s » (compte à rebours, bouton désactivé) ; `email_verification_required` : message + lien vers `/inscription/verifier?etablissement=` ; bandeaux `?reinitialise=1`, `?confirme=1` | `loginAction` (`actions/auth.ts`) | `POST /auth/login` |
| `/mot-de-passe-oublie` (public) | Code établissement + e-mail ; message unique « Si un compte correspond, un e-mail a été envoyé » | `forgotPasswordAction` (`actions/password-reset.ts`) | `POST /auth/password/forgot` |
| `/reinitialiser/[token]` (public, même connecté) | Aperçu (e-mail masqué) ; nouveau mot de passe + confirmation ; champ « code de vérification » si `mfaRequired` ; 410 ⇒ « lien invalide ou expiré » + lien vers `/mot-de-passe-oublie` ; succès ⇒ `/connexion?etablissement=<slug>&reinitialise=1` | `resetPasswordAction` | `POST /auth/password/reset/preview`, `POST /auth/password/reset` |
| `/inscription` | Après succès ⇒ `/inscription/verifier?etablissement=<slug>` (au lieu de `/connexion…&inscrit=1`) ; `slug_reserved` sur le champ | `signupAction` | `POST /auth/signup` |
| `/inscription/verifier` (public) | « Consultez votre boîte » + formulaire de renvoi (code établissement, e-mail) | `resendSignupVerificationAction` (`actions/signup-verification.ts`) | `POST /auth/signup/resend` |
| `/inscription/confirmer/[token]` (public) | Bouton « Confirmer mon adresse » (aucun appel au chargement) ; 410 ⇒ « lien invalide, déjà utilisé ou expiré » ; succès ⇒ `/connexion?etablissement=<slug>&confirme=1` | `verifySignupAction` | `POST /auth/signup/verify` |
| `/securite/mfa` | `TotpEnrolment` : sur `403 mfa_email_code_required`, étape « Recevoir un code par e-mail » puis saisie du code, puis QR (inchangé) ; `invalid_email_code` sur le champ | `startTotpSetupAction` (`actions/mfa-setup.ts`), `sendMfaEmailCodeAction` | `POST /auth/mfa/totp/email-code`, `POST /auth/mfa/totp/setup` |
| `/administration/securite` | Politique (`off_network` / `always`, lecture seule sans `iam:policy:update`) ; « Votre adresse actuelle : x (réseau de confiance : oui/non) » + bouton « Ajouter ce réseau (/32) » ; liste et ajout des plages (CIDR, libellé, site facultatif), suppression confirmée ; encadré CGNAT / IP dynamique ; administrateur principal et formulaire de transfert si le lecteur est le principal | `updateSecurityPolicyAction`, `addTrustedNetworkAction`, `removeTrustedNetworkAction`, `transferOwnershipAction` (`actions/admin-security.ts`) | `GET/PATCH /iam/security/policy`, `POST/DELETE /iam/security/trusted-networks`, `POST /iam/security/owner` |
| `/administration/utilisateurs` · `/[id]` | Colonne et champ « Dernière activité » (`lastSeenAt`, « jamais ») ; badge « Administrateur principal » ; bouton « Réinitialiser le second facteur » (confirmation) ; messages `admin_hierarchy`, `owner_required`, `owner_must_transfer` | `resetUserMfaAction` (`actions/admin-users.ts`) | `DELETE /iam/users/{id}/mfa` |
| Console plateforme (établissements) | Libellé « En attente de confirmation » pour `pending` | — | — |

**Navigation** : « Sécurité » dans le groupe Administration, avec l'exigence `iam:policy:read` (`lib/auth/nav.ts`).

**`proxy.ts`** : `publicPrefixes` complétés de `/mot-de-passe-oublie` et `/reinitialiser` (`/inscription/*` est déjà couvert). `authOnlyPages` inchangé.

### 9.3 Composants et domaine
- `components/security/` : `TrustedNetworksPanel.tsx`, `SecurityPolicyForm.tsx`, `OwnerTransferForm.tsx`.
- `components/forms/` : `ForgotPasswordForm.tsx`, `ResetPasswordForm.tsx`, `SignupVerificationForms.tsx`, `TotpEnrolment.tsx` (étape e-mail), `LoginForm.tsx` (délai).
- Mappeurs tolérants : `lib/domain/security.ts` (`SecurityPolicyView`, `TrustedNetworkView`) et `lib/domain/admin.ts` (`lastSeenAt`, `isOwner`).
- Validation locale du CIDR et du préfixe minimal : `lib/domain/security-forms.ts`.

## 10. Répartition des fichiers (aucun chevauchement)
| Fichier / dossier | Propriétaire |
|---|---|
| `packages/shared/src/schemas/{index,primitives}.ts`, `apps/api/src/app.module.ts`, `apps/api/src/infrastructure/config/env.ts` (+ specs), `apps/api/.env.example`, `apps/api/.env.test`, `apps/web/.env.example`, `docs/11-phase-durcissement-securite.md` | **Orchestrateur** (phase 0) |
| `apps/api/prisma/schema/security.prisma`, `core.prisma` (`User.lastSeenAt` seulement) | AUTH |
| `apps/api/prisma/migrations/20261006000100_auth_hardening/` (+ 0110 à 0190) | AUTH |
| `apps/api/src/modules/auth/**` **sauf** `services/signup.service.ts` (+ spec) | AUTH |
| `apps/api/src/modules/iam/**` | AUTH |
| `apps/api/src/common/{throttle,rate-limit,redis,authz,guards,tasks}/**`, `common/errors/domain-error.ts`, `common/logging/redact.ts`, `common/mail/{password-reset-email,security-emails}.ts` (+ specs) | AUTH |
| `apps/api/src/core.module.ts`, `apps/api/src/health.controller.ts`, `apps/api/scripts/transfer-tenant-owner.mts` | AUTH |
| `apps/api/src/modules/notifications/`, fichiers suivants uniquement : `services/security-alert.service.ts` (nouveau), `services/delivery-preparer.ts`, `domain/delivery-decision.ts`, `domain/message-variables.ts`, `domain/sample-values.ts`, `templates/default-templates.ts`, `repositories/recipients.repository.ts`, `notifications.module.ts` (+ specs) | AUTH |
| `packages/shared/src/schemas/security.ts` (+ `security.test.ts`), `schemas/notifications.ts` (+ test, ajout du type) | AUTH |
| `apps/api/package.json`, `pnpm-lock.yaml` (`ioredis`) | AUTH |
| `apps/api/test/auth/**` **sauf** `signup.e2e-spec.ts` ; `test/iam/**` ; `test/security/**` ; `test/helpers/redis.ts` | AUTH |
| `docs/03-api.md` (§4.0 : contrats AUTH **et** OPS recopiés), `docs/04-securite-rbac-audit.md` (§1.4, §1.7, §1.8, §2/§3.6 hiérarchie, §9.3, §9.5 CSP recopiée de §9.1) | AUTH |
| `apps/api/prisma/schema/onboarding.prisma`, migration `20261006000200_signup_hardening/` (+ 0210 à 0290) | OPS |
| `apps/api/src/modules/onboarding/**`, `modules/auth/services/signup.service.ts` (+ spec), `infrastructure/tenancy/tenant-provisioning.service.ts`, `common/mail/signup-verification-email.ts` (+ spec) | OPS |
| `packages/shared/src/schemas/onboarding.ts` (+ `onboarding.test.ts`) | OPS |
| `apps/api/test/onboarding/**`, `apps/api/test/auth/signup.e2e-spec.ts` | OPS |
| `apps/web/src/lib/api/client-info.ts` (+ test), `apps/web/src/lib/config.ts` (+ test), `apps/web/src/lib/edge.ts` (+ test), `apps/web/src/instrumentation.ts`, `apps/web/src/server/api.ts` (commentaire C9) | OPS |
| `infra/docker-compose.yml`, `infra/deploy/**`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`, `README.md`, `docs/07-conventions-dev.md`, `docs/06-roadmap-mvp.md` (annexe : hors-périmètre du §1.3) | OPS |
| `apps/web/src/proxy.ts` (+ test), `lib/csp.ts` (+ test), `lib/security-headers.ts` (+ test), `next.config.ts`, `app/layout.tsx`, `eslint.config.mjs` | WEB |
| `apps/web/src/app/(public)/{mot-de-passe-oublie,reinitialiser,inscription}/**`, `(public)/connexion/page.tsx`, `(secure)/securite/mfa/**`, `(app)/administration/securite/**`, `(app)/administration/utilisateurs/**`, page établissements de la console plateforme | WEB |
| `apps/web/src/actions/{auth,password-reset,signup-verification,mfa-setup,admin-security,admin-users}.ts` (+ tests) | WEB |
| `apps/web/src/components/security/**`, `components/forms/{LoginForm,SignupWizard,TotpEnrolment,ForgotPasswordForm,ResetPasswordForm,SignupVerificationForms}.tsx` (+ tests), `components/admin/{UsersTable,UserActions}.tsx` (+ tests) | WEB |
| `apps/web/src/lib/domain/{security,security-forms,admin}.ts` (+ tests), `lib/auth/nav.ts` (+ test), `lib/api/messages.ts` (+ tests), mappeur de statut de la console plateforme | WEB |

## 11. Ordre TDD et critères de vérification
Pour chaque point : test rouge, puis vert, puis refactorisation. Chaque endpoint teste au minimum 403, 404 inter-tenant et 422.

Exigences de fin pour chaque équipe :
- couverture ≥ 80 % sur le paquet touché ;
- `pnpm typecheck`, `pnpm lint` (web), `pnpm build` ;
- suite complète verte, y compris `rls-coverage` ;
- aucun `console.log`.

### 11.1 Équipe AUTH
1. **Domaine pur** :
   - `LOGIN_DELAY_SECONDS` (paliers, plafond, expiration 24 h) ;
   - `parseCidr` (IPv4 et IPv6, normalisation réseau, préfixes trop larges, `::ffff:`) ;
   - `clinicalMfaRequired` (rôle personnalisé clinique, mode `always`, aucune plage) ;
   - `adminRank` / `assertCanManage` (toutes les combinaisons de rang, soi-même) ;
   - masquage et contenu des e-mails (aucun jeton dans le texte journalisé, échappement HTML).
2. **Stockage de débit** :
   - `MemoryRateLimitStore` et adaptateur `ThrottlerStorage` ;
   - repli `ResilientRateLimitStore` (Redis en erreur ⇒ mémoire, journal limité) ;
   - **spec Redis** `test/security/throttle-redis.e2e-spec.ts` : deux applications sur le même Redis, préfixe unique ⇒ compteur partagé (la 21e tentative de login est refusée tous appels confondus), délai partagé, `/health` à `up`.
3. **Migration** :
   - `rls-coverage` vert ;
   - trigger du principal (tenant créé par `provision` ⇒ principal = administrateur) ;
   - rattrapage des tenants existants ;
   - `locked_until` remis à `NULL` ;
   - CHECK de préfixe refusé en SQL.
4. **Délai progressif** (`MutableClock`) :
   - 5 échecs ⇒ 429 `login_delayed` + `Retry-After`, **identique** pour un e-mail inexistant et pour un tenant inexistant ;
   - bon mot de passe pendant le délai ⇒ 429 ;
   - après le délai ⇒ succès et remise à zéro ;
   - `unlock` et réinitialisation remettent à zéro ;
   - alerte e-mail au 10e échec, une seule fois par 24 h.
   - Adapter `throttle.e2e-spec.ts` (e-mails distincts pour la limite IP) et `login.e2e-spec.ts` (suppression des tests de verrou).
5. **Tenant `pending`** : bon mot de passe ⇒ 403 `email_verification_required` ; mauvais ⇒ 401.
6. **Mot de passe oublié** (`BackgroundTasks.drain()`, `MemoryMailer`) :
   - 202 pour un compte existant, inexistant, invité ou désactivé, et un tenant inconnu : réponses octet pour octet identiques, e-mail seulement pour l'éligible ;
   - nouvelle demande ⇒ ancien jeton invalide ;
   - aperçu (e-mail masqué, `mfaRequired`) ;
   - réinitialisation : expiré (`MutableClock` + 31 min), consommé, concurrente (une seule réussite) ⇒ 410 ;
   - TOTP exigé (422 `mfa_code_required`) ; code de secours accepté puis retiré ; 5 codes faux ⇒ jeton brûlé ;
   - succès ⇒ toutes les sessions révoquées (le jeton d'accès d'une autre session ⇒ 401), connexion avec le nouveau mot de passe, e-mail de confirmation, audit ;
   - limites 429.
7. **Réseaux de confiance et MFA** (`TRUSTED_PROXIES=loopback`, `X-Forwarded-For` simulé) :
   - CRUD, 403 sans `iam:policy:*` (directeur), 422 (CIDR invalide ou trop large, limite 50, site d'un autre tenant), 409 doublon ;
   - médecin sans TOTP : IP dans une plage ⇒ 200 ; IP hors plage ⇒ 403 `mfa_enrollment_required` ; **même session**, IP qui change ⇒ réévaluation ;
   - aucune plage ⇒ 403 ;
   - mode `always` ⇒ 403 même sur réseau ;
   - caissier (non clinique) jamais concerné ; le réceptionniste, qui porte `inpatient:admission:*`, est clinique (décision 19 du §13) ;
   - `/auth/me` `mfa.required` cohérent ;
   - audit `authz.denied` avec `offNetwork`.
8. **Enrôlement hors réseau** :
   - `setup` sans code ⇒ 403 `mfa_email_code_required` ;
   - code envoyé (Mailpit mémoire), faux code ⇒ 422 puis invalidation au 5e ;
   - bon code ⇒ secret, puis `activate` (inchangé) ;
   - sur réseau de confiance, pas de code (et `email-code` ⇒ 422) ;
   - code d'une autre session refusé.
9. **Hiérarchie** :
   - un administrateur non principal ne peut ni désactiver, ni déverrouiller, ni révoquer les sessions, ni retirer le rôle, ni réinitialiser le MFA du principal ni d'un autre administrateur ⇒ 403 `admin_hierarchy` ; il le peut sur un médecin ;
   - il ne peut ni affecter ni inviter avec `tenant_admin` ⇒ 403 `owner_required` ;
   - le principal peut tout faire ;
   - auto-désactivation du principal ⇒ 409 `owner_must_transfer` ;
   - transfert (cible sans TOTP ⇒ 422) ; après transfert, les rangs s'inversent ;
   - invariant « dernier administrateur » inchangé ;
   - script CLI (refus sans terminal).
10. **Réinitialisation du MFA par un administrateur** : sessions révoquées, facteur supprimé, e-mail, 409 si aucun facteur, 422 sur soi-même.
11. **Notification au Directeur** (`runOnce` du dispatcher de docs/10) :
    - affectation `doctor` ⇒ notifications e-mail et in-app aux directeurs, hors acteur et cible ;
    - sans directeur ⇒ au principal ; acteur = principal sans directeur ⇒ aucune, `notifiedCount: 0` ;
    - rôle non sensible ⇒ aucune ;
    - **aucun nom de service** dans le contexte ni le rendu ;
    - préférence e-mail désactivée ⇒ envoi quand même ;
    - linter des modèles par défaut vert.
12. **Purge et `lastSeenAt`** :
    - `runOnce` supprime uniquement les lignes au-delà des seuils, isolation par tenant, plafond de lot ;
    - `last_seen_at` mis à jour au login et au refresh, pas deux fois en moins de 5 min ;
    - présent dans `GET /iam/users`.
13. **Documentation** : `docs/03-api.md` §4.0 (AUTH et OPS), `docs/04`.

### 11.2 Équipe OPS
1. **Schémas partagés** (`onboarding.test.ts`) : réservés, préfixes, casse.
2. **Migration** :
   - `slug_status` (`available` / `taken` / `reserved`, y compris pour un tenant supprimé) ;
   - `register_tenant` refuse le statut `terminated` et un slug réservé ;
   - `activate_pending_tenant` n'agit que sur le tenant courant et `pending` ;
   - `platform.reserved_slugs` = `RESERVED_TENANT_SLUGS` (test e2e) ;
   - `rls-coverage` vert.
3. **Inscription** :
   - 201 ⇒ tenant `pending`, e-mail de vérification (`MemoryMailer`), audit ;
   - `admin` ⇒ 422 `slug_reserved` ; `xn--abc` ⇒ 422 ; slug pris ⇒ 409 ;
   - échec SMTP simulé ⇒ 201 et renvoi possible.
4. **Vérification** :
   - confirmation ⇒ tenant `active`, `email_verified_at`, connexion réussie ;
   - jeton rejoué, expiré ou d'un tenant expiré ⇒ 410 ;
   - renvoi : 202 identique quel que soit le compte, ancien jeton invalidé, 429.
5. **Expiration** : `runOnce(now + 8 j)` ⇒ `terminated`, slug renommé et réutilisable par une nouvelle inscription, audit plateforme ; tenant actif jamais touché.
6. **BFF** (vitest web) :
   - `hops` 1 et 2, chaîne trop courte, entrées invalides, IPv6, `::ffff:` ;
   - `x-real-ip` ignoré ;
   - secret absent ou faux ⇒ aucune IP ;
   - `isFromTrustedEdge` en temps constant ;
   - `getTrustedProxyHops` / `getEdgeProxySecret` (exigences de production) ;
   - `instrumentation` en échec en production sans variables.
7. **Infra** :
   - `docker compose -f infra/docker-compose.yml config` : chaque `image:` contient `@sha256:` (test scripté dans `infra/deploy/check-pinned-images.sh`, exécuté en CI) ;
   - `pnpm infra:up` réussit ;
   - construction des deux images ;
   - `compose.prod.yml` : `docker compose config` sans `ports` sur `web` ni `api`.
8. **Documentation** : docs/07, README, `infra/deploy/README.md`, annexe docs/06.

### 11.3 Équipe WEB
1. **Domaine** :
   - `buildContentSecurityPolicy` (directives exactes, dev ou production, origines de `form-action`, mode report-only) ;
   - `generateNonce` unique et de longueur fixe ;
   - mappeurs tolérants ;
   - validation locale du CIDR ;
   - `visibleNav` (Sécurité).
2. **`proxy.ts`** :
   - CSP présente sur `next()` et sur les redirections, nonce différent à chaque requête et présent dans l'en-tête de requête ;
   - `Cache-Control: no-store` hors pages publiques ;
   - 403 si `isFromTrustedEdge` est faux en production ;
   - nouvelles routes publiques ;
   - tests existants (refresh, XFF) toujours verts.
3. **Actions** (API simulée) :
   - mot de passe oublié (message identique en cas de succès ou de 404 simulé) ;
   - réinitialisation (410, 422 `mfa_code_required`, redirection) ;
   - vérification et renvoi ;
   - `login_delayed` (secondes extraites de `details`) ;
   - `email_verification_required` ;
   - étape e-mail de l'enrôlement ;
   - sécurité de l'établissement ;
   - réinitialisation du MFA ;
   - codes de hiérarchie.
4. **Composants** :
   - compte à rebours de `LoginForm` (timers simulés) ;
   - `TotpEnrolment` en trois étapes ;
   - `TrustedNetworksPanel` (lecture seule sans `update`, ajout de l'IP courante) ;
   - formulaire de transfert visible pour le principal seulement.
5. **Pages** : aucun jeton dans un lien généré autre que celui du lien reçu ; la confirmation exige un clic ; `AccessDenied` sans permission.
6. Lint (nouvelles règles), typecheck, `next build` (aucune page statique ne casse la CSP).

## 12. Test de fumée réel (fin de phase, après intégration des trois équipes)
**Préparation** :
- `pnpm infra:up` (doit réussir sans MinIO) ;
- `.env` de dev avec `RATE_LIMIT_STORE=redis`, `SECURITY_JOBS_ENABLED=true`, `SMS_PROVIDER=sandbox` ;
- `pnpm prisma:deploy && node prisma/seed.mts` ; `pnpm dev`.

Navigateur Chrome, console ouverte :
1. **Infra** : `docker compose -f infra/docker-compose.yml config | grep image:` ⇒ uniquement des images `@sha256:`.
2. **Inscription** :
   - slug `admin` refusé sur le champ ;
   - inscription valide ⇒ page « vérifiez votre e-mail » ;
   - connexion avant confirmation ⇒ message dédié avec lien de renvoi ;
   - renvoi ⇒ deux e-mails dans Mailpit, seul le dernier lien fonctionne ;
   - clic ⇒ page avec bouton ⇒ confirmation ⇒ connexion, enrôlement TOTP de l'administrateur (sur réseau de confiance ou avec code e-mail) ;
   - lien rejoué ⇒ « déjà utilisé ».
3. **Mot de passe oublié** :
   - demande pour un e-mail inconnu, puis pour l'administrateur ⇒ même message ; un seul e-mail dans Mailpit ;
   - réinitialisation avec le code TOTP ⇒ la session ouverte dans un second navigateur est renvoyée à la connexion ;
   - connexion avec le nouveau mot de passe ; lien rejoué ⇒ invalide.
4. **Délai progressif** :
   - 5 mauvais mots de passe ⇒ « réessayez dans 30 s », aussi pour un e-mail inexistant ;
   - bon mot de passe pendant le délai ⇒ refusé ; après le délai ⇒ connexion ;
   - avec une seconde API (`PORT=3002`) sur le même Redis : `curl` des tentatives sur les deux ports ⇒ compteur commun (429 partagé).
5. **MFA hors réseau** :
   - invitation d'un médecin (sans TOTP) ;
   - l'administrateur ajoute « Votre adresse actuelle » (127.0.0.1/32) dans `/administration/securite` ⇒ le médecin accède à l'agenda ;
   - suppression de la plage ⇒ à la navigation suivante, redirection vers `/securite/mfa`, étape « code par e-mail », code reçu dans Mailpit, QR, activation, accès ;
   - un caissier n'est jamais concerné ; un réceptionniste l'est (admissions, décision 19 du §13).
6. **Notification au Directeur** : avec un directeur actif, l'affectation du rôle Médecin ⇒ cloche du directeur incrémentée sous 60 s et e-mail dans Mailpit (nom, rôle, « un site » ; aucun nom de service ni donnée patient).
7. **Hiérarchie** :
   - un second administrateur tente de désactiver le principal ⇒ message « Seul l'administrateur principal… » ;
   - le principal transfère le titre au second (qui a un TOTP) ⇒ badge déplacé, l'ancien principal ne peut plus agir sur le nouveau ;
   - réinitialisation du MFA du médecin ⇒ sessions coupées, nouvel enrôlement demandé.
8. **Purge et activité** :
   - après la passe de démarrage, `SELECT count(*)` des jetons expirés antérieurs aux seuils = 0 ;
   - « Dernière activité » renseignée dans la liste des utilisateurs.
9. **CSP** :
   - sur tout le parcours (connexion, MFA avec QR `data:`, administration, journal et export CSV, cloche, facture et reçu, redirection vers le paiement sandbox), **aucune violation CSP** dans la console ;
   - `curl -I` ⇒ en-têtes CSP (nonce différent à chaque appel), COOP, CORP, `no-store` sur les pages authentifiées ;
   - une page HTML locale qui met `/connexion` dans une iframe ⇒ chargement bloqué (`frame-ancestors`).
10. **Topologie de référence** : `docker compose -f infra/deploy/compose.prod.yml up` (domaine `*.localhost`, certificat local) :
    - le port 3001 de `web` n'est pas joignable depuis l'hôte ;
    - via Traefik, `curl -H 'X-Forwarded-For: 203.0.113.50'` ⇒ l'audit de connexion porte l'IP réelle du client, pas 203.0.113.50 ;
    - `docker compose exec api wget -qO- http://web:3001/connexion` (sans en-tête de bordure) ⇒ 403.
11. **Confidentialité** : un `grep` des jetons (réinitialisation, vérification, code e-mail) et du secret de bordure dans les journaux de l'API et du web ne renvoie aucune occurrence.

## 13. Questions ouvertes
Toutes arbitrées par l'utilisateur le 2026-10-05, conformément aux recommandations :
1. Aucun réseau de confiance déclaré ⇒ tous les réseaux sont hors confiance (MFA partout pour les soignants, D6).
2. Enrôlement TOTP hors réseau : code envoyé par e-mail exigé (D7).
3. Rôles cliniques = modules `consultations`, `nursing`, `maternity`, `inpatient`, `laboratory`, `imaging`, `pharmacy` (D5) ; `patients:patient:read` seul n'en fait pas partie.
4. Modes `off_network` et `always` seulement, sans mode `disabled`.
5. Barème du délai progressif `[0,0,0,0,30,60,120,300,600,900]` s, compteur par identifiant seul, `429 login_delayed` (D3).
6. Administrateur principal unique, rangs 2/1/0, promotion d'un administrateur réservée au principal, transfert explicite, script terminal en cas de départ (D9).
7. Réinitialisation du second facteur par un administrateur (`DELETE /iam/users/{id}/mfa`) incluse.
8. Notification des affectations sensibles aux directeurs, à défaut au principal, jamais à l'acteur ni à la cible ; rôles financiers inclus via `isSensitiveRole` (D10).
9. Inscription `pending` jusqu'à la confirmation, expiration à 7 jours avec slug libéré, essai démarré à la création, 201 même si l'envoi SMTP échoue, renvoi possible (D12).
10. Slugs réservés du §7.2 et préfixes `xn--` et `ghmt` ; les établissements existants ne sont pas touchés (D13).
11. `lastSeenAt` mis à jour à la connexion et au refresh (D15).
12. Client `ioredis` ; repli en mémoire par instance avec alerte si Redis est indisponible ; image `redis:7.x`.
13. MinIO retiré du compose de développement ; remplaçant choisi au lot « fichiers ».
14. Secret de bordure obligatoire en production, refus 403 du BFF sans lui ; `X-Real-IP` supprimé (D11).
15. Livrables : Dockerfiles API et web, `compose.prod.yml` Traefik de référence et runbook.
16. CSP en mode `enforce` en dev et en test, `report-only` pour la pré-production, `style-src` à nonces, origines `form-action` configurables ; pas de collecteur interne (`CSP_REPORT_URI` externe facultatif).
17. Pas de connexion automatique après réinitialisation ; aucun e-mail de réinitialisation pour un compte « invité ».
18. Phase 0 élargie (variables d'environnement, identifiants du limiteur, throttler `forRootAsync`, bouchon `isFromTrustedEdge`) validée.
19. (2026-10-06) Le réceptionniste porte `inpatient:admission:read|create` : il est **clinique** au sens de D5 et soumis à la MFA hors réseau. Les scénarios §11 et §12 sont corrigés en conséquence (le rôle non clinique de référence est le caissier).
20. (2026-10-06) L'expiration d'une inscription non confirmée (D12) **annule aussi l'abonnement d'essai** du tenant, dans la même transaction et avec un audit plateforme : aucune relance SaaS ni facture pour un établissement jamais confirmé.
21. (2026-10-06) Délai progressif : depuis un réseau de confiance, le délai est **plafonné à 60 s** ; ailleurs, le barème est inchangé. Les refus `login_delayed` sont audités (`auth.login.delayed`, au plus un par compte et par heure), l'administrateur principal et les administrateurs sont prévenus au 10e échec, la fiche utilisateur indique « connexion ralentie ».
22. (2026-10-06) L'agent administratif (admissions) est clinique ; les permissions de stock pharmacie (`pharmacy:drug:read`, `pharmacy:stock_movement:*`) **ne rendent pas** clinique.
23. (2026-10-06) Opérations de pouvoir : réseaux de confiance et politique MFA réservés au principal ; modifier un rôle affecté pour lui ajouter une permission d'administration en écriture est réservé au principal ; code TOTP récent exigé pour le transfert, les réseaux et la politique ; motif obligatoire pour la réinitialisation MFA et le déverrouillage ; alertes aux directeurs et au principal ; modèles `security.*` non personnalisables ; plages ≥ /24 (IPv4) et ≥ /48 (IPv6), plages privées et spéciales refusées.

24. (2026-10-10) Panne ou latence de Redis : **repli prudent** du délai progressif. La mémoire par instance reste le repli, mais pendant la panne toute nouvelle tentative sur un identifiant déjà en échec dans cette instance est refusée (`429 login_delayed`) et les admissions de l'instance sont plafonnées. L'état dégradé est exposé dans `/health/ready` et journalisé à l'entrée et à la sortie. Remplace le « repli fermé » du §14.3.6.
25. (2026-10-10) Blocage ciblé d'un compte (conséquence de D3) : depuis un réseau de confiance de l'établissement, ou une IP déjà utilisée avec succès par ce compte, le délai dû aux échecs venus d'ailleurs ne s'applique pas (compteur secondaire compte + IP). Le compteur par compte seul reste la règle partout ailleurs.
26. (2026-10-10) `siteId` des réseaux de confiance **retiré** du contrat, du stockage applicatif et de la console : une plage vaut pour tout l'établissement. Le rattachement par site reviendra avec le lot multi-sites.

## 14. Correctifs des revues sécurité et santé (2026-10-06)

Revues du 2026-10-06 sur le travail non commité. Mêmes règles qu'au §0.3 : chaque équipe n'écrit que dans ses fichiers du §10, sauf autorisation explicite ci-dessous. Correctifs de migration dans les plages réservées (AUTH `20261006000110`…, OPS `20261006000210`…).

### 14.1 Contrats modifiés (figés, AUTH ↔ WEB)
- **Connexion d'un établissement `suspended`** : autorisée (connexion, refresh, mot de passe oublié) ; le guard applique déjà le mode continuité.
- `GET /iam/security/policy` ajoute `clinicalUsersWithoutMfa: number` (utilisateurs actifs à rôle clinique sans TOTP actif) et `canManage: boolean` (vrai pour le principal seul).
- `PATCH /iam/security/policy`, `POST /iam/security/trusted-networks`, `DELETE /iam/security/trusted-networks/{id}`, `POST /iam/security/owner` : principal seul (`403 owner_required`) et corps avec `totpCode` (6 chiffres) exigé ⇒ `401 mfa_step_up_required` si absent, `401 mfa_code_invalid` si faux. Pour `DELETE`, `totpCode` est dans le corps JSON.
- `POST /iam/trusted-networks` : `422 cidr_too_broad` sous /24 (IPv4) ou /48 (IPv6), `422 cidr_reserved` pour RFC 1918, 100.64/10, 127/8, 169.254/16, 0/8, 224/4, ::1, fc00::/7, fe80::/10, ::ffff:0:0/96 hors IPv4 publique, plages de documentation.
- `DELETE /iam/users/{id}/mfa` et `POST /iam/users/{id}/unlock` : corps `{ reason: string (10..500) }` obligatoire, repris dans `changes.reason`.
- `GET /iam/users` et `GET /iam/users/{id}` ajoutent `mfaEnrolled: boolean` et `loginDelayed: boolean`.
- Modification d'un rôle (`PATCH /iam/roles/{id}`, `POST /iam/roles`) qui ajoute une permission d'administration en écriture à un rôle affecté : principal seul (`403 owner_required`).
- `PUT|PATCH` d'un modèle de notification `security.*` : `422 template_locked`.
- `403 mfa_enrollment_required` porte `offNetwork: boolean` dans `extra` (contexte établissement).
- Nouveaux types de notification (e-mail + in-app, exemptés de préférence) : `security.trusted_network_changed`, `security.policy_changed`, `security.mfa_reset`, `security.owner_transferred`, `security.director_removed`, `security.login_delay_alert`.

### 14.2 AUTH
1. **C1 (santé)** : `suspended` accepté à la connexion, au refresh et au mot de passe oublié, avec un e2e de connexion réelle d'un médecin et d'un administrateur sur un tenant suspendu, puis lecture d'un dossier.
2. **H2 (sécurité)** : un échec `mfa/verify` alimente le délai progressif ; contrôle du délai en tête de `mfa/verify` et à la création du challenge.
3. **H3 (sécurité)** : contrôle hiérarchique dans `RolesService.create/update` (§14.1) et `assertCanManage` sur les titulaires du rôle modifié.
4. Décision 21 : plafond 60 s sur réseau de confiance, audit `auth.login.delayed`, alerte `security.login_delay_alert` aux administrateurs au 10e échec, `loginDelayed` exposé.
5. Décision 22 : exclusion des permissions de stock pharmacie dans le calcul clinique. **H5 (santé)** : `SENSITIVE_ROLE_MODULES` couvre tous les modules cliniques et `patients:*:export`, avec un test d'inclusion.
6. Décision 23 : principal seul, code TOTP, motif, alertes (§14.1), modèles `security.*` verrouillés, notification des directeurs quand un directeur est désactivé ou perd son rôle, plages ≥ /24 / ≥ /48 et plages réservées refusées ; `normalizeClientIp` traite les IP privées et spéciales comme absentes.
7. **M6 (sécurité)** : `/api/v1/health` public réduit à `{ status }` ; détail sur `/api/v1/health/ready`, non routé par le proxy.
8. **M2 (sécurité)** : `forgot` n'invalide pas un jeton émis il y a moins de 10 min et n'envoie alors aucun nouvel e-mail.
9. Script `transfer-tenant-owner.mts` : rôle système (`is_system`), TOTP actif exigé (sauf `--allow-without-totp`, journalisé), `--operator` et `--reason` obligatoires (avec utilisateur OS et hôte dans l'audit), option `--grant-admin` (affectation `tenant_admin` auditée quand aucun administrateur n'existe), notification des directeurs.
10. **M7 (santé)** : la purge des jetons couvre aussi les tenants `terminated`.
11. Points mineurs : délai progressif sur l'échec du mot de passe actuel (changement de mot de passe) ; vérification et enregistrement de l'échec atomiques (Lua) ; jetons de réinitialisation invalidés au changement de mot de passe et à la désactivation ; clé du limiteur `password_reset` normalisée comme `parseOpaqueToken` ; comptage atomique des envois du code e-mail ; e-mail « tentatives inhabituelles » : « jusqu'à 15 minutes ; votre administrateur peut lever ce délai » ; aucune alerte vers un compte désactivé ; `offNetwork` dans l'audit des lectures cliniques hors réseau.

### 14.3 OPS
1. **M1 (sécurité)** : `.dockerignore` récursif (`**/.env`, `**/.env.*`, `!**/.env.example`), vérifié dans l'image construite.
2. `compose.prod.yml` : Redis avec mot de passe (`REDIS_URL` authentifiée), `cap_drop: [ALL]` et `read_only` partout où c'est possible, routeur public de l'API limité à `/api/v1/webhooks` et `/api/v1/health` (le BFF joint l'API en interne), secrets Docker pour les secrets.
3. **M7 (santé)** : purge des `signup_verifications` des tenants expirés ; anonymisation de l'utilisateur fondateur 30 jours après l'expiration (nom, e-mail remplacés, mot de passe et sessions supprimés), avec un audit plateforme.
4. **B6 (sécurité)** : e-mail de vérification avec un libellé fixe (sans nom d'établissement ni nom saisi) et limite par adresse de destination.
5. Runbook : procédure d'astreinte (téléphone perdu la nuit, au moins deux administrateurs avec un TOTP actif), procédure de transfert du principal (demande écrite de la direction, second opérateur, options du script).
6. Annexe de docs/06 : repli fermé du délai progressif si Redis est indisponible, changement d'e-mail par un administrateur, code d'enrôlement remis en main propre, revue des accès hors réseau.

### 14.4 WEB
1. **H1 (sécurité)** : `matcher` de `proxy.ts` qui couvre les chemins à jeton (exclusion par liste d'extensions statiques), avec un test qui évalue le `matcher` sur `/reinitialiser/<uuid>.<secret>`.
2. Textes d'aide : « téléphone perdu ? code de secours ou administrateur » sur `MfaVerifyForm.tsx` (autorisé) et `ResetPasswordForm.tsx` ; « pas d'accès à votre e-mail ? contactez votre administrateur » sur l'étape e-mail de `TotpEnrolment.tsx`.
3. Console : bannière persistante tant qu'aucun réseau n'est déclaré ; recommandation « au moins deux administrateurs avec un second facteur » ; explication des rôles comptés comme « soignants » ; confirmation avec « N soignants n'ont pas encore de second facteur » avant le mode `always` ou la suppression d'une plage ; formulaires réservés au principal (`canManage`) avec le champ `totpCode`.
4. Fiche et liste des utilisateurs : `mfaEnrolled` et `loginDelayed` affichés ; « Réinitialiser le second facteur » masqué sans facteur ; champ motif obligatoire et rappel « vérifiez l'identité de la personne en face à face ou par rappel sur un numéro connu » pour la réinitialisation MFA et le déverrouillage.
5. `mfa_enrollment_required` : message propre à l'établissement (« Vous n'êtes plus sur le réseau de l'établissement : activez le second facteur pour continuer. »), et redirection vers `/securite/mfa` depuis une action serveur, sans perte des valeurs saisies quand c'est possible.
6. Messages des nouveaux codes : `mfa_step_up_required`, `cidr_reserved`, `template_locked`.
