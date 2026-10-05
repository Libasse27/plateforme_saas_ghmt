# 09 — Phase « Facturation + abonnements SaaS »

> Spécification d'exécution (2026-10-04). Conforme à `05-saas-notifications.md` (partie A), `02-modele-donnees.md` §3.10,
> `04-securite-rbac-audit.md` et aux conventions `07-conventions-dev.md`. Montants : `numeric(18,2)` en base,
> **chaînes décimales** dans l'API (`"25000.00"`), jamais de flottant. Devise par défaut du tenant (`baseCurrency`).

## 0. Socle commun déjà en place (ne pas réécrire)
| Élément | Fichier | Rôle |
|---|---|---|
| Schéma Prisma multi-fichiers | `apps/api/prisma/schema/{base,core}.prisma` | Chaque équipe ajoute **son** fichier (`platform-saas.prisma`, `billing.prisma`) |
| `PlatformDb` / `PlatformPrismaService` | `src/infrastructure/prisma/platform-*.ts` | Rôle `ghmt_platform` : schéma `platform` uniquement, aucun accès `tenant` |
| `DomainEventBus` + catalogue | `src/common/events/domain-event-bus.ts`, `domain-events.ts` | `payment.succeeded`, `payment.failed`, `subscription.status_changed` |
| Contrat `PaymentsGateway` (token `PAYMENTS_GATEWAY`) | `src/common/payments/payments-gateway.ts` | Implémenté par le module `payments` ; utilisé par `billing` et `subscriptions` |
| Modules vides enregistrés | `src/modules/{platform,subscriptions,payments,billing}` | Déjà dans `app.module.ts` |
| Fichiers de schémas Zod | `packages/shared/src/schemas/{platform,subscriptions,payments,billing}.ts` | Un fichier par équipe |

### Règles de schéma et de migration (deux équipes en parallèle)
1. Un fichier `.prisma` par équipe ; **aucun champ de relation vers les modèles de `core.prisma`** (ni ajout de relation inverse dans `core.prisma`) : colonnes scalaires + FK en SQL dans la migration.
2. Générer sa migration par diff de dossiers temporaires : `prisma migrate diff --from-schema <tmp avec base+core> --to-schema <tmp avec base+core+son fichier> --script`, puis compléter le SQL (RLS, GRANT, contraintes, fonctions). Ne jamais modifier une migration existante.
3. Plages de noms : équipe A `20261005000100_*`, équipe C `20261005000200_*`.
4. Toute table `tenant.*` : `tenant_id`, RLS ENABLE + FORCE + politique `tenant_isolation` (le test `rls-coverage` l'exige). Tables `platform.*` : GRANT à `ghmt_platform` ; à `ghmt_app` **seulement** via fonctions `SECURITY DEFINER` étroites (search_path figé, tenant lu dans le contexte).

## A. Équipe Plateforme SaaS (`modules/platform`, `modules/subscriptions`)
### A1. Realm plateforme (Super Administrateur)
- Table `platform.platform_users` (email citext unique, password_hash Argon2id, full_name, role `super_admin|support|billing`, status, MFA TOTP **obligatoire**, verrouillage), sessions et refresh tokens plateforme (même mécanique que le realm tenant : rotation, réutilisation, révocation).
- JWT `realm: 'platform'`, claims `{ sub, sid, role, mfa }` ; le `JwtAuthGuard` tenant rejette déjà tout jeton non `tenant`. Les routes `/api/v1/platform/*` sont protégées par un guard plateforme dédié (et contournent les guards tenant de façon explicite et testée). Un jeton tenant est refusé sur `/platform/*` et inversement.
- `POST /platform/auth/login` → toujours une étape MFA (enrôlement TOTP imposé à la première connexion) ; `mfa/verify`, `refresh`, `logout`, `me`.
- Création du premier Super Administrateur : script CLI `apps/api/scripts/create-platform-admin.mts` (mot de passe saisi ou généré et affiché une fois), jamais d'endpoint public.
- Journal d'audit plateforme `platform.audit_logs` append-only (trigger) ; toute action plateforme est auditée.
- Matrice : `super_admin` = tout ; `support` = lecture tenants/abonnements ; `billing` = plans, abonnements, factures, paiements manuels.

### A2. Plans et droits (entitlements)
- `platform.plans` versionnés (`code`, `version`, `name`, `tier`, `price_monthly`, `price_yearly`, `currency`, `entitlements jsonb`, `is_public`, `archived_at`) ; `UNIQUE (code, version)`. Seed : Basic, Standard, Professional, Enterprise (prix XOF de docs/05 A2).
- `entitlements` : `{ modules: string[], limits: { users, sites, appointmentsMonthly, activePatients, smsMonthly, storageGb } (null = illimité), features: { customRoles, export, api } }`. Tous les plans incluent `billing` et `cashier`.
- `EntitlementService.get(tenantId)` (plan de l'abonnement courant + `overrides jsonb` de l'abonnement). Synchronisation de `platform.tenant_modules` à chaque changement de plan.
- Limites **dures** : utilisateurs actifs + invités (création/invitation ⇒ 403 `plan_limit_reached`, détail `{ limit, current }`), sites. Limite **souple** : RDV/mois — au-delà de 120 %, seules les sources `mobile_app`/`web` sont refusées (le guichet n'est jamais bloqué). Patients actifs : jamais bloquant.
- `GET /api/v1/subscription` (tenant, `settings:establishment:read`) : plan, statut, période, essai, entitlements, usage `{ users, sites, appointmentsThisMonth }`.

### A3. Abonnements et cycle de vie
- `platform.subscriptions` : `tenant_id`, `plan_id`, `status` (`trial|active|past_due|grace|suspended|cancelled|expired`), `billing_period` (`monthly|yearly`), `current_period_start/end`, `trial_ends_at`, `cancel_at_period_end`, `overrides`. Un seul abonnement courant par tenant.
- À l'inscription (`TenantProvisioningService`) : essai 30 jours, plan selon le type d'établissement (docs/05 A3, plafonné à Standard).
- `SubscriptionStateMachine` unique (transitions de docs/05 A6), `Clock` injectable, publication de `subscription.status_changed`, audit. Job planifié horaire (`@nestjs/schedule`) + méthode testable `runLifecycle(now)`.
- Effets : `suspended`/`expired` ⇒ `platform.tenants.status = 'suspended'` (lecture seule déjà appliquée par `PermissionGuard`, **sauf** création de patient et encaissement autorisés — continuité des soins) ; `grace` ⇒ blocage des actions administratives non essentielles (création/invitation d'utilisateurs, exports, changement d'add-ons). Ces règles vivent dans `evaluateAuthorization` : l'équipe A est **seule** autorisée à modifier `common/authz` et `common/guards`.
- Changement de plan tenant : `POST /api/v1/subscription/change { planCode, billingPeriod }` (`settings:establishment:update`) — upgrade immédiat avec facture de prorata ; downgrade en fin de période avec contrôle de compatibilité (409 `downgrade_incompatible` + liste des dépassements).

### A4. Factures SaaS
- `platform.saas_invoices` (+ lignes) : numérotation **sans trou** `GHMT-{PAYS}-{AAAA}-{000001}` (compteur plateforme verrouillé), statuts `draft|open|paid|void|uncollectible`, immuables une fois émises. Émission à J-7 de la fin de période, à la conversion d'essai et au prorata d'upgrade. TVA par pays configurable (`platform.billing_entities` : pays, raison sociale, taux, mentions).
- Tenant : `GET /api/v1/subscription/invoices`, `POST /api/v1/subscription/invoices/:id/pay { payerPhone }` ⇒ `PAYMENTS_GATEWAY.initiate({ purpose: 'saas_invoice', … })`.
- Écoute de `payment.succeeded` (`purpose = 'saas_invoice'`) ⇒ facture `paid` ⇒ abonnement `active` (nouvelle période = ancienne fin + durée) ; idempotent.
- Paiement manuel (virement, espèces revendeur) : saisi par un utilisateur `billing`, **validé par un autre** (quatre yeux), audité.

### A5. Console plateforme (API)
`/api/v1/platform/` : `tenants` (liste paginée, détail avec usage agrégé, `suspend`/`reactivate` avec motif), `plans` (liste, nouvelle version), `subscriptions/:tenantId` (changer de plan, prolonger l'essai une fois de 15 j), `invoices` (liste, paiement manuel + validation), `dashboard` (établissements total/actifs/essai/suspendus, utilisateurs, patients, RDV 30 j, MRR, ARR, factures en retard). Les agrégats sur le schéma `tenant` passent par des fonctions `SECURITY DEFINER` renvoyant **des comptes uniquement** (aucune donnée patient), exécutables par `ghmt_platform`.

## C. Équipe Facturation patient, caisse et paiements (`modules/billing`, `modules/payments`)
### C1. Paiements (`modules/payments`, module `@Global` exportant `PAYMENTS_GATEWAY`)
- `platform.payment_attempts` (`purpose`, `tenant_id`, `reference_id`, `amount numeric(18,2)`, `currency`, `channel`, `provider`, `provider_reference`, `status`, `idempotency_key` UNIQUE, `payer_phone_hash` — **jamais le numéro en clair**, horodatages) et `platform.payment_events` (corps brut du webhook, `UNIQUE (provider, provider_event_id)`), via `PlatformDb`.
- Fournisseurs : `sandbox` (développement/tests : URL de paiement simulée, endpoint `POST /api/v1/webhooks/payments/sandbox/simulate` **désactivé en production**) et `cinetpay` (adaptateur HTTP, variables `CINETPAY_*`, inactif si non configuré). Routage par pays/devise configurable ; repli possible.
- Webhook `POST /api/v1/webhooks/payments/:provider` (`@Public`, limité en débit) : vérification de signature en temps constant, stockage de l'événement, **re-vérification serveur à serveur** du statut, contrôle exact montant + devise, transition idempotente, publication de `payment.succeeded`/`payment.failed`. Job de relance des tentatives `pending` > 10 min (toutes les 10 min pendant 24 h).

### C2. Facturation patient (`modules/billing`, schéma `tenant`)
- `price_lists` / `price_list_items` (code, libellé, catégorie `consultation|acte|examen|medicament|autre`, prix unitaire, devise, actif) — `billing:price_list:read|update`.
- `invoices` + `invoice_lines` : patient (périmètre patient appliqué), site, rendez-vous optionnel ; statuts `draft|issued|partially_paid|paid|void` ; lignes depuis la grille (ligne libre seulement avec `billing:invoice:update`) ; totaux calculés côté serveur ; **numéro attribué à l'émission** `FAC-{AAAA}-{000001}` via `tenant.next_sequence('invoice', AAAA)` (sans trou) ; facture émise immuable ; annulation (`void`) seulement sans paiement, avec motif ; reçu imprimable (`billing:invoice:print`).
- `payments` (tenant) : `method` `cash|mobile_money|card|other`, montant ≤ reste dû, `status`, `cash_session_id` **obligatoire** pour les espèces, `attempt_id` pour le Mobile Money ; append-only. Mobile Money ⇒ `PAYMENTS_GATEWAY.initiate({ purpose: 'patient_invoice', … })` puis écoute de `payment.succeeded` (`TenantDb.runAs(tenantId)`) ⇒ paiement enregistré, statut de facture recalculé. L'encaissement reste autorisé si le tenant est suspendu (continuité des soins — règle implémentée par l'équipe A dans `evaluateAuthorization`).
- Caisse : `cash_registers` (site, code) et `cash_sessions` (ouverture avec fond de caisse, une seule session ouverte par caisse, clôture par l'ouvreur avec montant compté ⇒ attendu, écart ; validation par un autre utilisateur `cashier:cash_session:validate` — séparation des tâches).
- Audit de toute action (montants et identifiants uniquement, aucune donnée clinique).

## W. Console web (vague 2, après A et C)
Pages tenant : abonnement (plan, usage, factures SaaS, paiement Mobile Money, changement de plan), grille tarifaire, factures patient (création depuis un RDV ou une fiche, émission, paiement espèces/Mobile Money, reçu), caisse (ouverture, encaissements, clôture, validation). Console plateforme séparée (`/plateforme/*`, connexion du realm plateforme) : tableau de bord, établissements, plans, factures SaaS, paiements manuels.

## Vérification attendue
- API : tests unitaires + e2e par point (refus 403/404/422/409, isolation entre tenants, jeton tenant refusé sur `/platform/*` et inversement, numérotation sans trou sous concurrence, idempotence des webhooks, re-vérification serveur, transitions du cycle de vie avec horloge simulée, limites dures/souples, quatre yeux, séparation des tâches de caisse). Couverture ≥ 80 %, `tsc` sans erreur, suite complète verte.
- Test de fumée réel : abonnement en essai → facture → paiement sandbox par webhook → abonnement actif ; facture patient → encaissement espèces + Mobile Money sandbox → clôture de caisse.

---

## R. Correctifs de la revue santé de la phase (2026-10-05)

### Contrats modifiés (référence commune API ↔ Web)
| # | Contrat |
|---|---|
| R1 | `GET /api/v1/subscription/status` (`@AuthenticatedOnly`, tout utilisateur du tenant) → `{ status, trialEndsAt \| null, daysLeft \| null, mode: 'normal' \| 'restricted' \| 'continuity' }` (`restricted` = grâce, `continuity` = suspendu, résilié ou expiré). Aucune donnée financière. |
| R2 | `price_list_items` : `isSensitive: boolean` (défaut false) et `printLabel: string \| null`. Les lignes de facture conservent `label` + `isSensitive` + `printLabel`. Pour un lecteur sans `consultations:consultation:read`, et **toujours sur le reçu**, une ligne sensible est rendue avec `printLabel` (ou un libellé neutre par catégorie : « Consultation », « Acte médical », « Examen », « Médicament », « Prestation ») et `labelMasked: true`. |
| R3 | Identité patient dans la facturation : pour un lecteur sans `patients:patient:read`, `patient` = `{ id, ipp, fullName: null, identityMasked: true }`. La lecture d'une facture applique le **périmètre patient** (comme la création). |
| R4 | `POST /api/v1/billing/payments/:id/abandon` (`cashier:payment:create`) : re-vérifie le statut chez le fournisseur ; s'il n'y a pas de succès, passe le paiement en `cancelled` et libère le montant (200 `{ status }`) ; s'il y a eu succès, enregistre le paiement (200 `{ status: 'succeeded' }`). Audité. Expiration des tentatives `patient_invoice` : 30 min. |
| R5 | Reçu : `GET …/invoices/:id/receipt` refusé pour `draft` (409 `invoice_not_issued`) ; pour `void`, `voided: true` (filigrane « ANNULÉE » côté web). |
| R6 | Annulation de facture : `{ reasonCode: 'duplicate' \| 'wrong_price' \| 'wrong_patient' \| 'service_not_rendered' \| 'other', comment?: string(≤ 300) }` ; seul `reasonCode` va dans l'audit. |
| R7 | Devises sans subdivision (XOF, XAF, GNF, CDF) : montants et prix entiers (422 `amount_scale` sinon), totaux de ligne arrondis à l'unité. Code d'erreur fournisseur unifié `payment_provider_unavailable` (message web dédié). |
| R8 | `POST /api/v1/cashier/sessions/:id/force-close { countedAmount, reason }` (`cashier:cash_session:validate`, interdit à l'ouvreur) : clôture contradictoire auditée. La clôture normale exige `note` si l'écart ≠ 0. |
| R9 | Encaissement `other` (chèque, virement) : `cashSessionId` obligatoire comme pour les espèces. La caisse de la session doit être sur le **même site** que la facture (422 `cash_register_site_mismatch`). |

### Règles d'autorisation (continuité des soins)
- Suspension, résiliation et expiration (`mode: 'continuity'`) : lecture seule **sauf** création de patient, facturation (`billing:invoice:create`), encaissement et sessions de caisse, et mise à jour de rendez-vous (`appointments:appointment:update`, arrivée du patient). Règle durable : un impayé ne bloque jamais l'accueil, la facturation ni la saisie clinique.
- Grâce (`restricted`) : bloque création/invitation d'utilisateurs et exports **de masse** ; les exports relevant des droits du patient (`patients:patient:export`, `consultations:medical_record:export`) restent permis.

### Paiements en ligne
- Échec **technique** (délai dépassé, erreur réseau, 5xx) lors de l'initiation : la tentative reste `pending` et le job de relance l'interroge ; seul un **refus explicite** du fournisseur la passe à `failed`.
- Un succès confirmé par le fournisseur aboutit **toujours** à un paiement enregistré, y compris tardif ; s'il dépasse le reste dû, le paiement est marqué `anomaly: 'overpaid'` et audité (remboursement : roadmap).
- Les webhooks sont stockés **expurgés** (champs téléphone et identifiants personnels du payeur retirés), avec l'empreinte SHA-256 du corps brut pour l'anti-rejeu. Purge des corps déjà stockés.
- Audit des passages en échec et des actions `refresh`.

### Plateforme
- `platform.tenants_usage` ne prend plus d'instant libre (`now()` imposé, nouvelle migration).

### Reporté (roadmap, avant production réelle)
Avoirs et remboursements, remises et exonérations validées, tiers payant / garant, responsable payeur des mineurs, mentions légales et factures normalisées par pays (e-MECeF, FNE…), conservation OHADA de 10 ans exclue de la purge, rapport Z et reçu 80 mm.

### Revue sécurité (contrats modifiés utiles au web)
| # | Contrat |
|---|---|
| H3 | `POST /subscription/change` : une **montée en gamme** n'applique plus le plan avant paiement. Réponse `effect: 'pending_payment'`, `invoice` = facture de prorata `open`, `subscription.plan` inchangé, `subscription.pendingChange` = offre demandée ; le plan, les droits et les modules s'appliquent au règlement du prorata (`payment.succeeded` ou paiement manuel validé). Une nouvelle demande annule le prorata précédent. Pendant l'essai : seules basic et standard (`409 plan_not_allowed_in_trial`) ; `GET /subscription/plans` ajoute `selectable: boolean` à chaque offre. La console plateforme applique toujours le plan tout de suite. |
| M1 | Avant d'expirer une tentative, le job interroge une dernière fois le fournisseur. Montant ou devise différents ⇒ audit plateforme `payment.amount_mismatch` + journal d'erreur (alerte de rapprochement). |
| M2 | Comptes plateforme : le TOTP est enrôlé **par le script** `scripts/create-platform-admin.mts` (URI otpauth, codes de secours et mot de passe généré affichés **uniquement sur un terminal**, refus si stdout est redirigé). `POST /platform/auth/login` d'un compte sans TOTP ⇒ `403 mfa_enrollment_required_cli` (plus aucune session). Les routes web `POST /platform/auth/mfa/totp/setup` et `/activate` sont **supprimées** (le web ne doit plus proposer l'enrôlement). |
| M4 | `POST /appointments` : `source` limitée à `front_desk` ou `phone` pour le personnel (`422`, erreur `source_not_allowed` sur `source`). La reprogrammation vers un autre mois applique le contrôle de quota. |
| M5 | Facture SaaS : clé d'idempotence dérivée d'un index aveugle HMAC du numéro (jamais un SHA-256 non salé) ; une seule tentative `pending` par facture (index unique partiel ; une nouvelle demande abandonne la précédente). |
| M6 | Second paiement d'une facture SaaS déjà payée ⇒ audit `saas_invoice.duplicate_payment` (le rejeu de la tentative payante n'en génère pas). |
| M7 | `POST /platform/subscriptions/{tenantId}/change` : dérogations (`overrides`) et plans non publics réservés au `super_admin` (`403 super_admin_required`). |
| L1 | JWT du realm plateforme signés avec `JWT_PLATFORM_SECRET` (≥ 32 caractères ; obligatoire et distinct de `JWT_ACCESS_SECRET` en production, dérivé hors production s'il est absent). |
| L2 | `POST /platform/auth/password/change { currentPassword, newPassword }` ⇒ `{ changed, revokedSessions }` : mot de passe actuel exigé, session MFA, autres sessions révoquées, audit. |
| L7 | `POST /subscription/change` : 10 appels par minute et par IP (`429`). |
| L8 | Migration 0300 : `search_path` des fonctions `SECURITY DEFINER` terminé par `pg_temp` ; `platform.payment_attempts` et `payment_events` sans suppression ni troncature (événements : seuls rattachement, issue et date de traitement évoluent) ; compteur de numéros de factures SaaS protégé (ni suppression ni recul) ; une facture SaaS `draft` ne passe pas à `paid`. |
| L9 | `PAYMENTS_SANDBOX_ENABLED` vaut `false` par défaut (à activer explicitement dans `.env` de dev et `.env.test`). |
| L10 | Journaux : masquage des en-têtes `x-token`, `x-sandbox-signature` et autres signatures ; reprise manuelle d'un paiement limitée à une par 10 s (`429`). |

### Contrats complémentaires R (précisions d'implémentation)
- Lignes de facture : `description` porte le libellé rendu (masqué si `labelMasked`), `isSensitive` et `labelMasked` sont exposés ; `price_list_items` : `isSensitive`, `printLabel`.
- Annulation : `voidReasonCode` (code) et `voidReason` (commentaire libre ou `null`) sur le détail ; le commentaire n'est jamais dans l'audit.
- `InvoicePaymentView` : statut `cancelled` possible, `anomaly: 'overpaid' | null`. `CashSessionView.forceClosed`.
- Échec technique à l'initiation d'un paiement en ligne : `502 payment_provider_unavailable` mais le paiement reste `pending` (visible dans le détail de la facture, abandonnable). Code unifié aussi pour « aucun fournisseur disponible » (`503`).
- Périmètre patient en lecture : appliqué au détail et au reçu d'une facture (pas à la liste, qui ne renvoie que des identifiants).

