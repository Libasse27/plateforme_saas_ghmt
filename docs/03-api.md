# 03 — Conception de l'API GHMT

> Document de conception (aucun code existant). Conforme à `00-decisions.md` : NestJS 12 (monolithe modulaire), REST + OpenAPI 3.1 versionnée `/api/v1`, Prisma, PostgreSQL 17 avec RLS, Zod partagé (`packages/shared`), Redis/BullMQ, cible Afrique francophone (connectivité instable, mobile Android d'entrée de gamme, Mobile Money).
> Documents liés : `02-modele-donnees.md` (tables, RLS), `04-securite-rbac-audit.md` (auth, RBAC, audit), `05-saas-notifications.md` (plans, quotas, notifications).

---

## Sommaire

1. Architecture API
2. Conventions
3. Séparation des surfaces
4. Endpoints par module
5. Temps réel (WebSocket)
6. Webhooks sortants et événements de domaine
7. Documentation OpenAPI et SDK client
8. GraphQL : position
9. Limitation de débit et quotas par plan
10. Exemples de requêtes et réponses

---

## 1. Architecture API

### 1.1 Principes

- **Un module Nest par module métier** (patients, appointments, lab, pharmacy…), activable/désactivable par tenant selon le plan (guard « module activé »).
- **Trois couches strictes** : `controller → service → repository`. Aucune logique métier dans le controller, aucun accès Prisma hors repository.
- **Contrats Zod partagés** : chaque DTO d'entrée/sortie est un schéma Zod défini dans `packages/shared` et consommé par l'API (validation, OpenAPI), le web, le desktop et le mobile.
- **Le tenant n'est jamais fourni par le client** dans le corps ou l'URL : il est résolu depuis le JWT (ou la clé API, ou le sous-domaine pour la surface publique).
- **Isolation défensive** : le repository s'exécute toujours dans une transaction Prisma qui exécute `SET LOCAL app.tenant_id = '<uuid>'` ; la RLS PostgreSQL est le dernier rempart (rôle applicatif sans `BYPASSRLS`).
- **Erreurs métier typées** : les services lèvent des `DomainError` (code stable), traduites par le filtre d'erreurs en `problem+json`.
- **Effets de bord asynchrones** : les services publient des événements de domaine (outbox transactionnelle) ; notifications, webhooks sortants, audit lourd et temps réel sont consommés par des workers BullMQ.

### 1.2 Couches

| Couche | Responsabilité | Interdit |
|---|---|---|
| Controller | Routage, décorateurs (`@RequirePermission`, `@RequireModule`), extraction de `RequestContext`, mapping vers le DTO de réponse | Logique métier, Prisma |
| Service | Règles métier, orchestration, transactions, publication d'événements, vérification de portée (site/service) | Connaissance HTTP (`req`, `res`) |
| Repository | Requêtes Prisma, filtres de portée, pagination, verrouillage optimiste (`version`) | Règles métier, appels à d'autres modules |
| Mapper (optionnel) | Entité Prisma → DTO de sortie (masquage de champs sensibles) | — |

Règles de dépendances entre modules : un module n'importe **jamais** le repository d'un autre. Il utilise le **service exporté** ou écoute un **événement de domaine**. Les dépendances circulaires sont interdites (vérifiées par `eslint-plugin-boundaries` / `dependency-cruiser` en CI).

### 1.3 Structure d'un module NestJS type

Exemple : module `patients` dans `apps/api/src/modules/patients/`.

```
apps/api/src/
├── main.ts                         # bootstrap, versioning, Swagger, helmet, CORS
├── app.module.ts
├── common/                         # transversal (aucune logique métier)
│   ├── context/                    # RequestContext (AsyncLocalStorage) : tenantId, userId, scopes, requestId
│   ├── middleware/                 # tenant-resolver, request-id, locale
│   ├── guards/                     # jwt-auth, module-enabled, permission, api-key, platform-admin
│   ├── pipes/                      # zod-validation.pipe
│   ├── interceptors/               # audit, idempotency, etag, response-envelope, timeout
│   ├── filters/                    # problem-details.filter
│   ├── decorators/                 # @RequirePermission, @RequireModule, @Public, @Idempotent, @Audit
│   ├── pagination/                 # cursor & offset helpers
│   ├── i18n/                       # catalogues fr/en des messages d'erreur
│   └── events/                     # outbox, EventBus, schéma d'événement
├── infrastructure/
│   ├── prisma/                     # PrismaService, extension tenant (SET LOCAL), transaction helper
│   ├── redis/ queue/ storage/ mail/ sms/ push/
│   └── payments/                   # adapters CinetPay, PayDunya, Flutterwave
└── modules/
    └── patients/
        ├── patients.module.ts
        ├── controllers/
        │   ├── patients.controller.ts
        │   ├── patient-allergies.controller.ts
        │   └── patient-documents.controller.ts
        ├── services/
        │   ├── patients.service.ts
        │   └── patient-merge.service.ts
        ├── repositories/
        │   └── patients.repository.ts
        ├── dto/                    # createZodDto(...) à partir de packages/shared
        │   └── patients.dto.ts
        ├── mappers/
        │   └── patient.mapper.ts
        ├── events/
        │   ├── patient.events.ts   # patient.created, patient.merged…
        │   └── patient.listeners.ts
        ├── patients.permissions.ts # re-export du catalogue partagé (patients.read, patients.write…)
        └── __tests__/              # unit (service), integration (repository + RLS), e2e (HTTP)
packages/shared/src/
├── schemas/patients.ts             # Zod : PatientCreate, PatientUpdate, PatientResponse…
├── permissions.ts                  # catalogue de permissions (source unique)
├── errors.ts                       # catalogue des codes d'erreur
└── events.ts                       # catalogue des événements de domaine + payloads Zod
```

### 1.4 Pipeline d'une requête

Ordre d'exécution (tenant surface `/api/v1/*`) :

| # | Étape | Type Nest | Rôle |
|---|---|---|---|
| 1 | Request-ID, locale, logging | Middleware | `X-Request-Id` (généré si absent), `Accept-Language` → `fr`/`en`, log Pino |
| 2 | Rate limiting (IP / utilisateur / clé) | Guard global (Redis) | Rejette en `429` avant tout travail coûteux |
| 3 | **Middleware tenant** | Middleware | Extrait le contexte brut (sous-domaine/en-tête pour surface publique) ; pour l'authentifié, le tenant est confirmé à l'étape 5 |
| 4 | **Guard auth** | Guard | Vérifie le JWT (signature, expiration, `jti` non révoqué, session active) ou la clé API ; alimente `RequestContext` (`tenantId`, `userId`, `sessionId`) |
| 5 | **Guard module activé** | Guard | Vérifie que le module du contrôleur est inclus dans la licence du tenant et que l'abonnement est actif (sinon `403 module_not_enabled` ou `402`/`403 subscription_suspended`) |
| 6 | **Guard permission** | Guard | Évalue `@RequirePermission('patients.write')` avec la portée (groupe, établissement, site, service) issue du rôle ; supporte l'accès délégué |
| 7 | **Pipe Zod** | Pipe | Valide `body`, `query`, `params` ; transforme (coercion, trim) ; échec → `422` |
| 8 | Interceptor idempotence / ETag | Interceptor | Rejoue la réponse si `Idempotency-Key` connue ; vérifie `If-Match` |
| 9 | **Interceptor audit** | Interceptor | Enregistre acteur, action, ressource, avant/après (champs sensibles masqués), IP, résultat (succès **et** refus) |
| 10 | Ouverture transaction tenant | Interceptor | `BEGIN; SET LOCAL app.tenant_id = …; SET LOCAL app.user_id = …` pour la durée du handler |
| 11 | **Handler** | Controller → Service → Repository | Logique métier |
| 12 | Enveloppe de réponse | Interceptor | Formate `{ success, data, error: null, meta }`, pose `ETag`, `X-Request-Id`, en-têtes de débit |
| 13 | **Filtre d'erreurs** | ExceptionFilter | Convertit toute exception en `application/problem+json` (RFC 9457), traduit selon la locale, journalise, ne divulgue rien de sensible |

Remarque : en NestJS le cycle réel est Middleware → Guards → Interceptors (avant) → Pipes → Handler → Interceptors (après) → Filtres. L'ordre du tableau est fonctionnel ; la validation Zod s'exécute techniquement après les interceptors « avant » lorsqu'elle est liée au paramètre. Pour garantir qu'un payload invalide soit tout de même audité comme tentative et que la validation précède les effets de bord, les interceptors d'idempotence et d'audit sont écrits pour fonctionner sur la requête brute (empreinte du corps) et finaliser à la sortie (y compris sur exception).

### 1.5 Diagramme de séquence

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (web/desktop/mobile)
    participant MW as Middleware (request-id, locale, tenant)
    participant GA as Guard Auth (JWT)
    participant GM as Guard Module activé
    participant GP as Guard Permission
    participant PZ as Pipe Zod
    participant IA as Interceptor Audit/Idempotence
    participant H as Handler (Controller → Service → Repository)
    participant DB as PostgreSQL (RLS)
    participant Q as Outbox / BullMQ
    participant EF as Filtre d'erreurs

    C->>MW: POST /api/v1/appointments (Bearer JWT, Idempotency-Key)
    MW->>GA: contexte (requestId, locale)
    GA->>GA: vérifie signature, exp, session, révocation
    alt JWT invalide
        GA-->>EF: UnauthorizedException
        EF-->>C: 401 problem+json
    end
    GA->>GM: RequestContext (tenantId, userId)
    GM->>GM: licence/abonnement du tenant ? module "appointments" ?
    alt module non activé
        GM-->>EF: ForbiddenException(module_not_enabled)
        EF-->>C: 403 problem+json
    end
    GM->>GP: permission requise : appointments.write
    GP->>GP: rôles + portée (site/service) ou accès délégué
    alt permission absente
        GP-->>EF: ForbiddenException(permission_denied)
        EF-->>C: 403 problem+json (+ audit du refus)
    end
    GP->>PZ: validation body/query/params
    alt payload invalide
        PZ-->>EF: ZodValidationException
        EF-->>C: 422 problem+json (errors[])
    end
    PZ->>IA: DTO validé
    IA->>IA: Idempotency-Key déjà vue ? rejouer la réponse
    IA->>H: exécution
    H->>DB: BEGIN; SET LOCAL app.tenant_id; INSERT...
    DB-->>H: ligne (tenant_id vérifié par RLS)
    H->>Q: écrit l'événement appointment.created (outbox, même transaction)
    H-->>IA: résultat
    IA->>IA: écrit l'audit + stocke la réponse idempotente
    IA-->>C: 201 { success: true, data, meta } + ETag
    Q-->>Q: worker : SMS de confirmation, webhook sortant, WebSocket
```

---

## 2. Conventions

### 2.1 Nommage des ressources

- URLs en **minuscules, kebab-case, pluriel** : `/patients`, `/lab-orders`, `/queue-tickets`.
- Identifiants : **UUID v7** (triables par date) dans le chemin : `/patients/{patientId}`.
- Sous-ressources pour les relations de composition (max 2 niveaux) : `/patients/{id}/allergies`.
- **Actions non CRUD** via un verbe en sous-chemin `POST` : `/appointments/{id}/confirm`, `/lab-results/{id}/validate`, `/tenants/{id}/suspend`.
- Champs JSON en **camelCase** ; énumérations en `snake_case` minuscule (`status: "checked_in"`).
- Les noms exposés sont en **anglais** (API) ; les libellés affichables sont traduits côté client ou via `Accept-Language`.
- Pas de verbes dans les collections, pas de `/getXxx`.

### 2.2 Enveloppe de réponse

Toutes les réponses JSON (succès comme erreur de validation d'enveloppe) suivent la forme :

```json
{
  "success": true,
  "data": { },
  "error": null,
  "meta": { "requestId": "01J...", "timestamp": "2026-10-04T09:30:00.000Z" }
}
```

| Champ | Succès | Erreur |
|---|---|---|
| `success` | `true` | `false` |
| `data` | objet ou tableau | `null` |
| `error` | `null` | objet problem+json (voir 2.5) |
| `meta` | `requestId`, `timestamp`, `pagination` (listes), `warnings[]` | `requestId`, `timestamp` |

Exception documentée : en cas d'erreur, le corps est servi avec `Content-Type: application/problem+json`. Il contient les membres standards RFC 9457 **à la racine** (pour les outils compatibles) **et** est enveloppé dans la structure ci-dessus uniquement si le client envoie `Accept: application/json` (mode par défaut des SDK). Les clients tiers qui envoient `Accept: application/problem+json` reçoivent le problem+json nu. `204 No Content` : aucun corps. Téléchargements de fichiers : flux binaire sans enveloppe (URL signée).

### 2.3 Pagination

Deux modes, choisis par ressource (documenté dans OpenAPI) :

**Curseur (par défaut pour les listes volumineuses : patients, consultations, audit, mouvements de stock, notifications)**

- Requête : `?limit=25&cursor=eyJpZCI6Ii4uLiJ9` ; `limit` max 100 (défaut 25).
- Le curseur est **opaque** (base64url d'un JSON signé : clé de tri + id).
- Réponse : `meta.pagination = { "mode": "cursor", "limit": 25, "nextCursor": "…" | null, "hasMore": true }`.
- Stable en cas d'insertions concurrentes, adapté au mobile et au hors-ligne.

**Offset (petites listes d'administration : rôles, services, plans, sites)**

- Requête : `?page=2&pageSize=25` (pageSize max 100).
- Réponse : `meta.pagination = { "mode": "offset", "page": 2, "pageSize": 25, "totalItems": 143, "totalPages": 6 }`.
- `totalItems` calculé seulement si `?includeTotal=true` pour les tables volumineuses (évite un `COUNT(*)` coûteux).

Liens : en-tête `Link` (RFC 8288, `rel="next"`) en complément.

### 2.4 Filtres, tri, recherche, champs

| Besoin | Syntaxe | Exemple |
|---|---|---|
| Égalité | `?status=confirmed` | `?status=confirmed&serviceId=…` |
| Multi-valeurs | virgule | `?status=confirmed,checked_in` |
| Intervalle | `field[gte]`, `field[lte]`, `field[gt]`, `field[lt]` | `?startsAt[gte]=2026-10-04T00:00:00Z&startsAt[lt]=2026-10-05T00:00:00Z` |
| Recherche plein texte | `?q=` (nom, n° dossier, téléphone ; insensible aux accents via `unaccent` + `pg_trgm`) | `?q=diallo` |
| Tri | `?sort=-createdAt,lastName` (`-` = décroissant) ; liste blanche par ressource | |
| Projection | `?fields=id,firstName,lastName` | allège les payloads mobiles |
| Expansion | `?include=allergies,primaryInsurance` (liste blanche) | |
| Suppression logique | `?includeDeleted=true` (permission dédiée) | |

Les paramètres inconnus sont **rejetés** (`422 unknown_parameter`) pour éviter les filtres silencieusement ignorés (risque de fuite de données).

### 2.5 Format d'erreur (RFC 9457 `problem+json` étendu)

Membres standards : `type`, `title`, `status`, `detail`, `instance`. Extensions GHMT :

| Extension | Description |
|---|---|
| `code` | Code stable machine (`permission_denied`, `validation_failed`, `patient_duplicate`…), issu de `packages/shared/errors.ts` |
| `requestId` | Corrélation avec les logs et Sentry |
| `errors[]` | Détail par champ pour les validations : `{ path, code, message, params? }` |
| `requiredPermission` | (403) permission manquante, jamais la liste des permissions de l'utilisateur |
| `retryAfterSeconds` | (429, 503) |
| `docs` | Lien documentation (`https://docs.ghmt.example/errors/<code>`) |

`type` est une URI stable : `https://api.ghmt.example/problems/<code>`. `detail` est **traduit** (voir 2.11) ; `title` et `code` restent stables. Aucune trace de pile, requête SQL ni donnée d'un autre tenant ne sort jamais ; une ressource d'un autre tenant renvoie `404` (pas `403`) pour ne pas révéler son existence.

### 2.6 Codes HTTP

| Code | Usage |
|---|---|
| 200 | Lecture, mise à jour réussie |
| 201 | Création (`Location` renseigné) |
| 202 | Traitement asynchrone accepté (exports, rapports, envoi en masse) ; `Location` vers `/jobs/{id}` |
| 204 | Suppression, action sans retour |
| 304 | `If-None-Match` correspondant |
| 400 | Requête malformée (JSON invalide, en-tête mal formé) |
| 401 | Non authentifié, jeton expiré/invalide |
| 402 | Réservé : paiement requis (abonnement impayé, selon politique `403 subscription_suspended` par défaut) |
| 403 | Authentifié mais interdit (permission, module non activé, portée, abonnement suspendu) |
| 404 | Inexistant **ou** hors tenant |
| 405 / 406 / 415 | Méthode, `Accept`, `Content-Type` non supportés |
| 409 | Conflit métier (doublon, créneau déjà pris, transition d'état invalide, clé d'idempotence en cours) |
| 410 | Ressource expirée (lien d'invitation, URL signée) |
| 412 | `If-Match` ne correspond pas (concurrence optimiste) |
| 422 | Validation Zod / règle de validation métier |
| 423 | Ressource verrouillée (dossier clôturé, période comptable fermée) |
| 428 | `If-Match` ou `Idempotency-Key` requis et absent |
| 429 | Limite de débit ou quota de plan dépassé |
| 500 | Erreur interne (message générique + `requestId`) |
| 503 | Indisponibilité / maintenance (`Retry-After`) |

### 2.7 Idempotence

- En-tête **`Idempotency-Key`** (UUID v4 généré par le client, 8 à 64 caractères) **obligatoire** (`428` si absent) sur :
  - `POST /payments`, `POST /invoices/{id}/payments`, `POST /cash-sessions/{id}/movements`, remboursements ;
  - `POST /appointments` (le mobile en réseau instable peut réessayer) et `POST /patient/appointments` ;
  - `POST /subscriptions/{id}/payments` (facturation SaaS).
- Optionnel mais supporté sur tous les autres `POST` créant une ressource.
- Stockage Redis (TTL 24 h) + table `idempotency_keys` (tenant, clé, empreinte SHA-256 de méthode + chemin + corps, statut, réponse).
- Comportement :
  - même clé + même empreinte, requête terminée → **rejeu** de la réponse initiale avec l'en-tête `Idempotent-Replayed: true` ;
  - même clé, requête en cours → `409 idempotency_in_progress` (+ `Retry-After`) ;
  - même clé, empreinte différente → `422 idempotency_key_reuse`.
- Les webhooks entrants sont dédupliqués par l'identifiant de transaction du fournisseur (clé unique en base).

### 2.8 Concurrence optimiste (ETag / If-Match)

- Chaque ressource modifiable porte une colonne `version` (entier) ; l'**ETag fort** est `"<resourceType>-<id>-v<version>"` (ou hash).
- `GET` renvoie `ETag`. `PATCH` / `PUT` / `DELETE` sur les ressources sensibles (patient, dossier, prescription, facture, stock, rendez-vous) exigent **`If-Match`** : absent → `428`, différent → `412 precondition_failed` avec la version courante dans `errors`.
- Le repository applique `UPDATE … WHERE id = $1 AND version = $2` ; 0 ligne → `412`.
- Le client desktop hors-ligne conserve l'ETag lu et gère les conflits à la synchronisation (stratégie détaillée dans `01-architecture.md`).
- `If-None-Match` supporté sur les `GET` de référentiels (cache mobile, économie de données).

### 2.9 Versionnement

- Version majeure dans l'URL : **`/api/v1`**. Une version majeure n'est créée qu'en cas de rupture ; changements additifs (nouveaux champs optionnels, endpoints) sont non cassants.
- Politique de dépréciation : en-têtes `Deprecation` et `Sunset` (RFC 8594), annonce 6 mois avant retrait ; v1 et v2 coexistent au moins 12 mois.
- Clients mobiles anciens : en-tête `X-Client-Version` (ex. `mobile/1.4.2`) ; endpoint `GET /api/v1/public/app-config` renvoie `minSupportedVersion` pour forcer une mise à jour.
- Versionnement Nest : `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`.

### 2.10 Dates, montants, identifiants, formats

- **Dates/heures** : ISO 8601 en **UTC** avec `Z` (`2026-10-04T09:30:00.000Z`). Dates calendaires pures (naissance) : `YYYY-MM-DD`. Les créneaux de rendez-vous portent en plus `timezone` (IANA, ex. `Africa/Dakar`, `Africa/Kinshasa`) du site pour l'affichage ; le client convertit, le serveur ne stocke que l'UTC.
- **Montants** : **chaînes décimales** (`"15000.00"`) jamais des nombres flottants ; accompagnés de `currency` ISO 4217 (`XOF`, `XAF`, `CDF`, `USD`). Précision par devise (XOF/XAF : 0 décimale, USD : 2) validée par Zod ; stockage `NUMERIC(18,4)`. Objet type : `{ "amount": "15000", "currency": "XOF" }`.
- **Quantités de stock** : chaînes décimales également (unités fractionnables).
- **Téléphones** : E.164 (`+221771234567`). **Pays** : ISO 3166-1 alpha-2. **Langues** : BCP 47 (`fr`, `en`).
- **Identifiants** : UUID v7 en chaîne. Les numéros fonctionnels (n° dossier patient `P-2026-000123`, n° facture) sont des champs distincts, générés par séquence par tenant.
- **Compression** : `gzip`/`br` activés ; `fields=` et pagination pour limiter le poids.

### 2.11 Internationalisation des messages d'erreur

- Langue déterminée par : paramètre `?lang=` (rare) > `Accept-Language` > préférence utilisateur (`user.locale`) > défaut du tenant > `fr`.
- Catalogues `fr` (défaut) et `en` dans `packages/shared/i18n/errors.{fr,en}.json`, indexés par `code`, avec interpolation (`{field}`, `{min}`).
- `code` et `errors[].code` ne sont **jamais** traduits ; seuls `detail` et `errors[].message` le sont. L'en-tête de réponse `Content-Language` est renseigné.
- Les contenus générés pour les patients (SMS, e-mails) utilisent la langue du patient, pas celle de l'agent.
- Ajout d'une langue = ajout d'un fichier de catalogue, sans changement d'API.

---

## 3. Séparation des surfaces

| Surface | Préfixe | Acteurs | Authentification | Résolution du tenant | Modules de garde |
|---|---|---|---|---|---|
| Plateforme | `/api/v1/platform/*` | Super admin, support GHMT | JWT « plateforme » (audience `ghmt-platform`), 2FA **obligatoire**, restriction IP optionnelle | Aucune (global) ; accès tenant uniquement par accès délégué | `PlatformAdminGuard` |
| Établissement (tenant) | `/api/v1/*` | Personnel de l'établissement | JWT (audience `ghmt-tenant`) | Claim `tid` du JWT | auth + module + permission |
| Public | `/api/v1/public/*` | Anonymes (app mobile, site web) | Aucune (clé d'application publique + captcha/limites) | Explicite et non sensible : `tenantSlug` dans le chemin | Cache CDN, lecture seule |
| Patient | `/api/v1/patient/*` | Compte patient mobile | JWT (audience `ghmt-patient`), OTP SMS | Le compte patient est **global** ; accès aux données d'un tenant via `patientLinks` (consentement) | Guard patient + vérification du lien |
| Webhooks entrants | `/api/v1/webhooks/*` | Mobile Money, SMS | Signature HMAC du fournisseur + liste d'IP | Retrouvé par référence de transaction | Aucun JWT, corps brut conservé |
| Intégrations | `/api/v1/*` (mêmes ressources) ou `/api/v1/integrations/*` | Systèmes tiers (ERP, assurances, labos externes) | Clé API (`X-API-Key`) | Rattachée à la clé | Scopes + quotas |

### 3.1 Surface plateforme (`/api/v1/platform/*`)

- Jeton distinct, audience distincte : un JWT tenant ne peut jamais appeler la plateforme et inversement.
- Pas de lecture des données cliniques d'un tenant. L'**accès délégué** (break-glass) : `POST /platform/delegated-access` avec motif, durée (max 4 h, renouvelable), périmètre (lecture seule par défaut) et, optionnellement, approbation d'un administrateur du tenant. Il émet un JWT tenant spécial (`act` = super admin, `delegated: true`, `exp` court) ; **toutes** les actions sont auditées avec marquage « accès délégué » et notification à l'admin du tenant.
- Les tables de plateforme (plans, tenants) sont hors RLS tenant mais protégées par un rôle SQL distinct (`ghmt_platform`).

### 3.2 Surface tenant (`/api/v1/*`)

- Le `tenantId` provient exclusivement du JWT. Tout `tenantId` présent dans un corps ou paramètre est ignoré/rejeté.
- Les permissions portent une **portée** (groupe, établissement, site, service). Le contexte de site courant est transmis par l'en-tête `X-Site-Id` (validé : l'utilisateur doit être affecté à ce site) ; les listes sont filtrées automatiquement par les sites/services autorisés.
- Un groupe (tenant « groupe ») peut agréger ses établissements via les endpoints de reporting avec `scope=group`.

### 3.3 Surface publique (`/api/v1/public/*`)

Annuaire des établissements pour l'app mobile : lecture seule, cacheable (`Cache-Control: public, max-age=300, stale-while-revalidate=600`), ETag, limite par IP, uniquement les établissements ayant opté pour la publication (`publicDirectory.enabled`). Aucune donnée personnelle. Champs exposés strictement listés (nom, adresse, géolocalisation, services, horaires, spécialités, téléphone, langues, assurances acceptées, modes de paiement).

### 3.4 Surface patient (`/api/v1/patient/*`)

- Inscription par **numéro de téléphone + OTP SMS** (pas de mot de passe obligatoire), PIN/biométrie côté appareil.
- Un compte patient peut être lié à plusieurs dossiers dans plusieurs établissements (`patient_links`), chaque lien créé avec **consentement explicite** et vérification par l'établissement (code remis à l'accueil ou concordance identité).
- Périmètre limité : rendez-vous, résultats publiés par l'établissement, ordonnances, factures et paiements Mobile Money, rappels, consentements. Jamais le dossier médical complet.
- Rate limiting plus strict sur OTP (anti-fraude SMS coûteux).

### 3.5 Webhooks entrants (`/api/v1/webhooks/*`)

- `POST /webhooks/payments/{provider}` (cinetpay, paydunya, flutterwave), `POST /webhooks/sms/{provider}/delivery-reports`.
- Vérification de signature HMAC sur le **corps brut** (`rawBody`), horodatage (tolérance 5 min), liste blanche d'IP, déduplication par identifiant d'événement, **réponse `200` rapide** puis traitement asynchrone (BullMQ). Toujours réconcilier en interrogeant l'API du fournisseur avant de marquer un paiement réussi (ne jamais se fier au seul contenu du webhook).

### 3.6 API publique d'intégration (clés API par tenant)

- Gestion : `/api/v1/integrations/api-keys` (voir 4.22). La clé en clair n'est affichée **qu'une fois** ; stockage du seul hash (SHA-256 + préfixe lisible `ghmt_live_ab12…`).
- Authentification : `X-API-Key: ghmt_live_…` (ou `Authorization: Bearer ghmt_live_…`). La clé est rattachée à un tenant, éventuellement un site, et à une liste de **scopes**.
- **Scopes** de la forme `<ressource>:<read|write>` : `patients:read`, `patients:write`, `appointments:read`, `appointments:write`, `lab_results:read`, `invoices:read`, `stock:read`, `claims:write`, `webhooks:manage`. Un scope ne donne **jamais** plus que les permissions d'un rôle de service associé à la clé.
- Seul un sous-ensemble d'endpoints est exposé aux clés API (marqué `🔑` dans les tableaux du chapitre 4 ou listé dans la spec OpenAPI avec le tag `integration`). Les endpoints d'administration, d'auth et de plateforme leur sont fermés.
- Options de sécurité : restriction IP (CIDR), expiration, rotation avec recouvrement (deux clés actives), révocation immédiate, journal d'usage par clé.
- Quotas et débit par clé selon le plan (chapitre 9).

---

## 4. Endpoints par module

Légende :

- Les chemins sont relatifs à `/api/v1`.
- **Permission** : code du catalogue partagé (`packages/shared/permissions.ts`, détaillé dans `04-securite-rbac-audit.md`). `public` = aucune ; `auth` = tout utilisateur authentifié ; `platform:*` = permissions de la surface plateforme.
- `🔑` : endpoint accessible aussi avec une clé API (scope correspondant requis).
- `Idem` : `Idempotency-Key` obligatoire ; `ETag` : `If-Match` obligatoire.
- Toutes les listes supportent pagination, filtres et tri (section 2).

### 4.0 Contrats implémentés au lot 1 (priment sur les tableaux ci-dessous)

Référence d'exécution : [08-correctifs-revues.md](./08-correctifs-revues.md) (contrats C1 à C9). Les chemins réels de l'API sont préfixés `/api/v1` ; l'IAM est servi sous `/iam/*`.

**Recherche patient (C1)** — `POST /patients/search`, permission `patients:patient:read`.
Corps `{ q?: string(2..100), phone?: E.164, ipp?: /^P\d{2}-\d{7}$/, limit?: 1..100 (20), cursor?: UUID encodé }`. Aucun critère ⇒ `422 search_criteria_required`. Réponse : liste paginée (`meta.pagination`) de `{ id, ipp, firstName, lastName, sex, birthDate, birthDateEstimated, city }`. Périmètre : seuls les patients du site de la portée (et ceux sans site principal) sont renvoyés. Audit `patient.searched` : critères utilisés, volume et `patientIds`, jamais le terme.

**Création et doublons (C3)** — `POST /patients` : `409 patient_duplicate` avec `details.candidates: [{ id, ipp, fullName, birthYear }]` (5 au plus, limités au périmètre de l'appelant). Détection : nom/prénom (y compris inversés) + date de naissance (± 2 ans si l'une des dates est estimée), « nom seul » (même nom normalisé dont l'une des deux fiches n'a pas de date de naissance), même téléphone, même pièce d'identité (index aveugles, n° normalisé : sans espaces ni tirets, en majuscules). Forçage : `?force=true` avec `forceReason` (3..500) dans le corps, audité. Aucune correspondance visible mais au moins une hors périmètre ⇒ `409 patient_duplicate_out_of_scope` (aucun `details`, forçable de la même façon). Chaque 409 est audité dans une transaction séparée : `patient.duplicate_detected` / `patient.duplicate_out_of_scope` (`changes.patientIds`, `changes.criteria` = types de critères, jamais les valeurs). Date de naissance : le schéma partagé tolère aujourd'hui+1 jour UTC, le service refuse `422 validation_failed` (`birth_date_in_future`) au-delà du jour courant dans le fuseau du tenant.

**Concurrence (C5)** — `GET /patients/{id}` renvoie `ETag: "<rowVersion>"`. `PATCH` et `DELETE` exigent `If-Match` : absent ⇒ `428 precondition_required`, périmé ⇒ `412 precondition_failed`. Projection « identité seule » (téléphone, e-mail, pièce, adresse à `null`, `contactRedacted: true`) décidée **par patient** : les coordonnées ne sont déchiffrées que si le dossier est dans la portée de `patients:patient:update` (site principal, ou sans site). La fiche expose aussi `deceasedAt` (ISO ou `null`). `fullName` s'écrit « Prénom NOM » partout (candidats de doublon, `AppointmentView.patient`). `DELETE /patients/{id}` annule dans la même transaction les rendez-vous futurs non terminés (`cancelReason: patient_record_deleted`) ; l'audit `patient.deleted` liste `cancelledAppointmentIds`.

**Rendez-vous (C2)** — `AppointmentView` ajoute `patient { id, ipp, fullName, birthYear|null }` et `practitioner { id, fullName, specialty|null }` ; `patient` expose aussi `deceasedAt` (ISO ou `null`) et `fullName` « Prénom NOM » ; `reason` et `cancelReason` n'existent que pour les rendez-vous situés dans la portée de `consultations:consultation:read` (décision par ligne : site du rendez-vous ou service du praticien). Prise de rendez-vous : un patient hors du périmètre de `patients:patient:read` est traité comme inexistant (même `422 not_found` sur `patientId`) ; reprogrammer le rendez-vous d'un tel patient ⇒ `404`. Un patient décédé n'empêche plus `checked_in → in_progress` ni `in_progress → completed`. Règles : absence (`no_show`) seulement après `startsAt` ; arrivée (`checked_in`) seulement le jour J dans le fuseau du tenant ; suppression seulement en `scheduled`/`confirmed` (`409 invalid_transition` sinon) ; patient décédé ⇒ `422 patient_deceased` ; créneau passé ⇒ `422 slot_in_past`. Audit `appointment.listed` (avec `patientIds`) et `appointment.read`.

**Invitations (C6)** — `POST /iam/users` `{ fullName, email, locale?, roleAssignments[] }` crée un utilisateur `invited` (sans mot de passe) et envoie un e-mail contenant `${WEB_URL}/invitation/<tenantId>.<secret>` (jeton 256 bits, empreinte SHA-256 stockée, TTL 72 h, jamais renvoyé par l'API ni journalisé). `POST /iam/users/{id}/invitation` renvoie l'e-mail (204) et invalide le précédent. `GET /auth/invitations/{token}` puis `POST /auth/invitations/{token}/accept` sont publics et limités. Échec SMTP ⇒ `502 invitation_email_failed` (le compte existe, l'invitation se renvoie). Transport : SMTP via `SMTP_HOST`/`SMTP_PORT`/`MAIL_FROM` (Mailpit `localhost:1025` en dev), mémoire sous `NODE_ENV=test`.

**Mot de passe, déconnexion, déverrouillage (C7, C8)** — voir 4.1 ; `POST /iam/users/{id}/unlock` (`iam:user:update`) ⇒ 200 avec l'utilisateur.

**IP cliente et limitation de débit (C9)** — le BFF transmet `X-Forwarded-For` et `User-Agent` ; l'API ne les croit que si la source figure dans `TRUSTED_PROXIES` (CIDR ou mot-clé Express, défaut `loopback`). `login` et `mfa/verify` sont limités par IP **et** par compte (`sha256(tenantSlug|email)` ; `sha256(challengeId)` pour `mfa/verify`).

**Pagination** — les curseurs sont validés (UUID, ou `date|UUID` pour l'agenda) : curseur invalide ⇒ `422` (`errors[0].path = "cursor"`).

**Authentification** — seul `Authorization: Bearer` authentifie ; aucun cookie n'est lu.

**Facturation patient, caisse et paiements (docs/09 §C, priment sur 4.12 et 4.23)** — chemins sous `/api/v1`, montants en chaînes décimales à 2 décimales (`"25000.00"`), quantités en chaînes (≤ 3 décimales), devise = `baseCurrency` du tenant. Identifiants mal formés ⇒ `404`. Ressource d'un autre tenant ou hors périmètre de site ⇒ `404`.

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET / POST | `/billing/price-lists` | `billing:price_list:read` / `update` | Grilles ; `isDefault` unique par tenant (en désigner une retire l'ancienne) ; `409 price_list_code_taken` |
| PATCH | `/billing/price-lists/{id}` | `billing:price_list:update` | `name`, `isDefault`, `isActive` |
| GET / POST | `/billing/price-lists/{id}/items` | `read` / `update` | Articles (`category`, `q`, `includeInactive`, `limit`, `cursor` = code) ; `409 price_list_item_code_taken` |
| PATCH | `/billing/price-list-items/{id}` | `billing:price_list:update` | Le changement de prix est audité (`unitPrice.from/to`) ; les factures existantes gardent leur prix figé |
| POST | `/billing/invoices` | `billing:invoice:create` | Brouillon `{ patientId, siteId, appointmentId?, notes?, lines[] }` ; ligne = `{ priceListItemId, quantity? }` ou ligne libre `{ description, category?, unitPrice, quantity? }` (`403 free_line_forbidden` sans `billing:invoice:update`) ; totaux calculés côté serveur ; `422` sur `lines.N.priceListItemId` (inconnu, inactif, autre devise) |
| GET | `/billing/invoices` | `billing:invoice:read` | Filtres `status`, `patientId`, `siteId` ; curseur UUID ; sans lignes |
| GET | `/billing/invoices/{id}` | `billing:invoice:read` | Détail (lignes, paiements, `patient { id, ipp, fullName }`) ; audit `invoice.read` avec le patient |
| PUT | `/billing/invoices/{id}/lines` | `billing:invoice:create` | Remplace les lignes d'un brouillon (`409 invoice_not_draft` sinon) |
| POST | `/billing/invoices/{id}/issue` | `billing:invoice:create` | Émission : numéro `FAC-{AAAA}-{000001}` via `tenant.next_sequence('invoice', AAAA)` (année civile locale du tenant, sans trou sous concurrence : verrou de ligne puis numéro, une émission perdante ne consomme rien) ; total nul ⇒ `paid` ; facture émise immuable (trigger) |
| POST | `/billing/invoices/{id}/void` | `billing:invoice:validate` | Annulation `{ reason }` (`409 invoice_has_payments` si encaissement réussi ou en attente, `409 invoice_already_void`) ; le numéro n'est jamais réattribué |
| GET | `/billing/invoices/{id}/receipt` | `billing:invoice:print` | Reçu `{ establishment, site, invoice, printedAt }` ; audit `invoice.printed` |
| POST | `/billing/invoices/{id}/payments` | `cashier:payment:create` | `{ method: cash \| mobile_money \| card \| other, amount, cashSessionId?, payerPhone?, reference? }` (voir ci-dessous) |
| POST | `/billing/payments/{id}/refresh` | `cashier:payment:create` | Reprise manuelle d'un paiement en ligne (webhook perdu) : re-vérification serveur à serveur, renvoie le paiement |
| GET / POST | `/cashier/registers` | `cashier:cash_session:read` / `validate` | Caisses d'un site ; `409 cash_register_code_taken` |
| GET / POST | `/cashier/sessions` | `read` / `create` | Ouverture `{ cashRegisterId, openingFloat }` ; une seule session ouverte par caisse (`409 cash_session_already_open`, garanti par index unique partiel) ; filtres `status`, `mine` |
| GET | `/cashier/sessions/{id}` | `cashier:cash_session:read` | `expectedTotal` = fond + espèces encaissées (figé à la clôture) |
| POST | `/cashier/sessions/{id}/close` | `cashier:cash_session:create` | `{ countedAmount, note? }` par l'ouvreur seul (`403 cash_session_not_owner`, `409 cash_session_not_open`) ; `variance` = compté − attendu |
| POST | `/cashier/sessions/{id}/validate` | `cashier:cash_session:validate` | Par un autre utilisateur que l'ouvreur et le clôturant (`403 separation_of_duties`, aussi garanti par contrainte SQL) ; `409 cash_session_not_closed` |
| POST | `/webhooks/payments/{provider}` | `@Public`, signature | Webhook agrégateur : signature à temps constant sur le corps brut, événement stocké (`UNIQUE (provider, provider_event_id)`), re-vérification du statut auprès du fournisseur, contrôle exact montant + devise, transition idempotente, publication de `payment.succeeded` / `payment.failed` ; limité en débit |
| POST | `/webhooks/payments/sandbox/simulate` | `@Public` | `{ attemptId, outcome: success \| failure }` ; fournisseur simulé, **404 si `PAYMENTS_SANDBOX_ENABLED` est faux** (refusé au démarrage en production) |

Encaissement : le montant ne peut dépasser le reste dû, déduction faite des paiements en ligne `pending` (qui réservent leur montant : `422 amount_exceeds_balance`, `details.balance`). Facture non émise, soldée ou annulée ⇒ `409 invoice_not_payable`. Espèces : `cashSessionId` obligatoire (`422`), session ouverte (`409 cash_session_not_open`) et ouverte par l'encaisseur (`403 cash_session_not_owned`) ; la base refuse un paiement en espèces sans session. Réponse `201` : espèces/autre ⇒ `InvoicePaymentView` ; Mobile Money/carte ⇒ `{ payment (pending), checkoutUrl, instructions }` (une seule demande en attente par facture : `409 payment_already_pending`). La confirmation arrive par `payment.succeeded` (réaction du module billing dans `TenantDb.runAs(tenantId)`) : paiement `succeeded`, facture recalculée (`partially_paid` / `paid`), audit `payment.succeeded` (acteur `system`, `anomaly: overpaid` si excédent). `payment.failed` ⇒ paiement `failed` avec motif. Aucune donnée patient dans `platform.*` : libellé `Facture FAC-…`, téléphone haché (HMAC) uniquement. Les paiements et sessions validées sont immuables (triggers) ; aucune suppression par l'application.

Variables d'environnement : `PAYMENTS_SANDBOX_ENABLED`, `PAYMENTS_ROUTES` (JSON `PAYS:DEVISE` / `DEVISE` / `*` ⇒ fournisseurs par ordre, repli sur le suivant), `CINETPAY_API_KEY`, `CINETPAY_SITE_ID`, `CINETPAY_SECRET_KEY`, `CINETPAY_BASE_URL`, `CINETPAY_NOTIFY_URL`, `CINETPAY_RETURN_URL` (adaptateur inactif tant qu'elles ne sont pas toutes renseignées). Job de relance : toutes les 10 min, tentatives `pending` > 10 min re-vérifiées pendant 24 h puis expirées (`expired`), règlements non notifiés republiés.

**Realm plateforme, abonnements et factures SaaS (docs/09 §A, priment sur 4.2)** — chemins sous `/api/v1`. Montants en chaînes décimales (`"88500.00"`), taux en chaînes (`"0.1800"`), dates ISO 8601 UTC. Le tenant d'une route `/subscription/*` vient du jeton ; un identifiant mal formé ⇒ `404`.

*Authentification plateforme* — JWT `realm: 'platform'` (claims `{ sub, sid, role, mfa }`, audience `<JWT_AUDIENCE>-platform`), refresh tokens opaques `p.<secret>` (rotation, tolérance de rejeu 10 s, réutilisation ⇒ session révoquée). Sessions de 12 h, refresh glissant de 2 h. **Un jeton tenant est refusé (401) sur `/platform/*` et un jeton plateforme sur toute route tenant (401).** Les routes `/platform/*` portent `@PlatformController()` (= `@PlatformRealm()` + `PlatformAuthGuard`, indissociables) ; refus par défaut sans `@RequirePlatformPermission`, `@PlatformAuthenticatedOnly` ou `@PlatformPublic`. Le rôle est relu en base à chaque requête (rétrogradation immédiate). Aucun endpoint de création de compte : script `apps/api/scripts/create-platform-admin.mts`.

| Méthode | Chemin | Accès | Description |
|---|---|---|---|
| POST | `/platform/auth/login` | public, 10/15 min/IP | `{ email, password }` ⇒ **toujours** une étape MFA : compte enrôlé ⇒ `{ mfaRequired: true, challengeId, methods: ['totp','backup_code'] }` ; compte sans TOTP ⇒ `{ accessToken, refreshToken, expiresIn, mfaEnrolled: false, mfaRequired: true }` (jeton limité à l'enrôlement). `401 invalid_credentials` identique pour compte inconnu / mauvais mot de passe / désactivé / verrouillé (5 échecs ⇒ 1, 5, 15, 60 min) |
| POST | `/platform/auth/mfa/verify` | public | `{ challengeId, code }` (TOTP 6 chiffres ou code de secours) ⇒ jetons `mfa: true` ; 5 essais par challenge (TTL 5 min) ; `401 invalid_mfa_code` |
| POST | `/platform/auth/mfa/totp/setup` · `/activate` | session sans MFA | Enrôlement ; `activate { code }` ⇒ `{ accessToken, expiresIn, backupCodes[10] }` (codes affichés une fois) |
| POST | `/platform/auth/refresh` · `/logout` | public | Rotation ; `logout` (204, idempotent) par refresh token ou jeton d'accès |
| GET | `/platform/auth/me` | session | `{ id, email, fullName, role, mfaEnrolled, mfaVerified, permissions[] }` |

*Matrice* : `super_admin` = tout ; `support` = `tenants:read`, `subscriptions:read`, `plans:read`, `dashboard:read` ; `billing` = `tenants:read`, `plans:read|write`, `subscriptions:read|write`, `invoices:read|write|validate`, `dashboard:read`. Toute route métier exige la MFA vérifiée (`403 mfa_enrollment_required`), un refus de permission est audité (`platform.authz.denied`).

*Console* (`PlatformDb`, rôle `ghmt_platform`) :

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/platform/tenants` | `tenants:read` | Liste paginée (`q`, `status`, `subscriptionStatus`, `limit`, `cursor` UUID) : `{ id, slug, name, establishmentType, countryCode, status, createdAt, subscription: { status, planCode, currentPeriodEnd } \| null }` |
| GET | `/platform/tenants/{id}` | `tenants:read` | Détail : `tenant` (+ `legalName`, `baseCurrency`, `timezone`, `suspensionReason`), `subscription` (vue plateforme), `usage { users, sites, patients, appointmentsThisMonth, appointmentsLast30Days }` (comptes uniquement), `modules[]`, `invoices { open, overdue }` |
| POST | `/platform/tenants/{id}/suspend` | `tenants:suspend` | `{ reason (5..500) }` ⇒ lecture seule ; `409 already_suspended`. Le motif est conservé : un paiement ne lève pas cette suspension |
| POST | `/platform/tenants/{id}/reactivate` | `tenants:suspend` | `409 not_manually_suspended` ; l'établissement reste en lecture seule si l'abonnement est lui-même `suspended` / `expired` |
| GET / POST | `/platform/plans` | `plans:read` / `plans:write` | Liste (`includeArchived`) ; `POST` crée la **version suivante** d'un code (ou la v1 d'un nouveau code) et archive la précédente ; `422` si `billing`/`cashier` manquent ou module inconnu ; `409 plan_version_conflict` |
| GET | `/platform/subscriptions/{tenantId}` | `subscriptions:read` | `SubscriptionView` + `tenantId`, `trialExtended`, `suspensionReason` |
| POST | `/platform/subscriptions/{tenantId}/change` | `subscriptions:write` | `{ planCode, billingPeriod, overrides? }` (plans non publics autorisés, dérogations `{ modules?, limits?, features? }` ; `overrides: null` les efface) ⇒ `{ effect, subscription, invoice }` |
| POST | `/platform/subscriptions/{tenantId}/extend-trial` | `subscriptions:write` | +15 jours, une seule fois (`409 trial_already_extended`, `409 not_in_trial`) |
| GET | `/platform/invoices` · `/{id}` | `invoices:read` | Factures SaaS (`status`, `tenantId`, curseur `issuedAt\|id`), `tenantSlug` inclus, jamais les brouillons |
| POST | `/platform/invoices/{id}/manual-payments` | `invoices:write` | `{ amount, method: bank_transfer \| cash_reseller \| cheque \| other, reference, receivedAt }` ⇒ `201` paiement `pending` ; montant **exactement** celui de la facture (`422 amount_mismatch`), facture payable (`409 invoice_not_payable`), un seul paiement en attente par facture (`409 manual_payment_pending`) |
| GET | `/platform/invoices/manual-payments` | `invoices:read` | Filtre `status` |
| POST | `/platform/invoices/manual-payments/{id}/validate` · `/reject` | `invoices:validate` | **Quatre yeux** : le décideur ≠ le saisisseur (`403 four_eyes_required`, tracé `manual_payment.four_eyes_denied`, aussi garanti par CHECK SQL) ; `validate` règle la facture et active l'abonnement dans la même transaction ; `reject { reason }` ; `409 manual_payment_decided` |
| GET | `/platform/dashboard` | `dashboard:read` | `{ tenants { total, active, trial, suspended }, users, patients, appointmentsLast30Days, mrr { XOF: "…" }, arr, overdueInvoices }` (agrégats via `platform.tenants_usage`, `SECURITY DEFINER`, comptes uniquement) |
| GET | `/platform/dashboard/audit-logs` | `audit:read` | Journal `platform.audit_logs` (`tenantId`, `action`, curseur UUID) |

*Surface tenant* (`settings:establishment:read` / `update`) :

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/subscription` | `read` | `{ id, status, billingPeriod, currentPeriodStart/End, trialEndsAt, cancelAtPeriodEnd, plan, pendingChange, entitlements, usage { users, sites, appointmentsThisMonth } }` |
| GET | `/subscription/plans` | `read` | Offres publiques en vigueur `PlanSummary + entitlements` |
| POST | `/subscription/change` | `update` | `{ planCode, billingPeriod }` ⇒ `{ effect: immediate \| scheduled \| pending_payment, subscription, invoice \| null }`. Essai : immédiat + facture de conversion. Upgrade : immédiat + facture de prorata. Downgrade / périodicité : fin de période, `409 downgrade_incompatible` (`details.violations: [{ metric: users \| sites, limit, current }]`). Expiré / suspendu / résilié : `pending_payment`. `409 no_change`, `404` plan inconnu ou non public. Autorisé même tenant suspendu |
| POST | `/subscription/cancel` · `/resume` | `update` | Résiliation à l'échéance (`409 invalid_state` hors `active`) |
| GET | `/subscription/invoices` | `read` | Factures (jamais les brouillons), `status`, curseur |
| POST | `/subscription/invoices/{id}/pay` | `update` | `{ payerPhone (E.164) }` ⇒ `PAYMENTS_GATEWAY.initiate({ purpose: 'saas_invoice', … })` ⇒ `{ attemptId, status, provider, checkoutUrl, instructions }` ; `404` facture d'un autre tenant, `409 invoice_not_payable`, `503 payments_unavailable`. Autorisé tenant suspendu. Clé d'idempotence stable 5 min |

*Limites du plan* : refus `403 plan_limit_reached` avec `details { metric: users \| sites \| appointmentsMonthly, limit, current }` — utilisateurs (actifs + invités + verrouillés, y compris la réactivation d'un compte désactivé) et sites : limites **dures** (verrou d'avis par tenant) ; rendez-vous du mois : limite **souple**, au-delà de 120 % seules les sources `web` / `mobile_app` sont refusées (guichet et téléphone jamais). Patients actifs : informatif. Tenant sans abonnement (historique) : aucune limite.

*Cycle de vie* (`SubscriptionStateMachine`, job horaire `runLifecycle(now)`) : `trial → active | expired` ; `active → active | past_due | cancelled` ; `past_due → active | grace` (J+7 après la fin de période) ; `grace → active | suspended` (J+15) ; `suspended → active | expired` (J+75) ; `cancelled → active | expired` (90 j après la résiliation) ; `expired → active`. Factures émises à J-7 (renouvellement ou conversion d'essai), prorata à l'upgrade ; numéro `GHMT-{PAYS}-{AAAA}-{000001}` sans trou (compteur verrouillé dans la transaction d'émission), TVA de `platform.billing_entities` (repli `ZZ`). `payment.succeeded` (`saas_invoice`) ou validation d'un paiement manuel ⇒ facture `paid`, abonnement `active`, nouvelle période = ancienne fin + durée (réactivation : à partir du paiement), idempotent. `suspended` / `expired` ⇒ `platform.tenants.status = 'suspended'` (lecture seule ; `403 subscription_suspended` sauf création de patient, encaissement, ouverture de caisse, lectures, exports et impressions, et les routes `@AllowWhenSuspended` d'abonnement). `grace` ⇒ `403 subscription_grace` pour la création / invitation d'utilisateurs et les exports. Événement `subscription.status_changed` publié après commit.

### 4.1 Auth (`/auth`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| POST | `/auth/login` | public (limité) | Identifiant + mot de passe ; retourne jetons ou `mfaRequired` + `mfaToken` |
| POST | `/auth/login/2fa` | public (mfaToken) | Valide le code TOTP ou un code de secours, retourne les jetons |
| POST | `/auth/refresh` | public (refresh token) | Rotation du refresh token ; détection de réutilisation (révoque la famille) |
| POST | `/auth/logout` | **public** (limité) | Corps `{ refreshToken? }` : révoque la session de ce jeton, 204 même s'il est inconnu ; sans corps, révoque la session du jeton d'accès fourni (C8) |
| POST | `/auth/logout-all` | auth | Révoque toutes les sessions de l'utilisateur |
| GET | `/auth/me` | auth | Profil (`user.mustChangePassword`), `tenant { id, slug, name, timezone, countryCode, baseCurrency }`, permissions effectives, modules activés, état MFA (C4) |
| POST | `/auth/2fa/enroll` | auth | Démarre l'enrôlement TOTP (secret + URI `otpauth://`) |
| POST | `/auth/2fa/verify` | auth | Confirme l'enrôlement avec un premier code ; renvoie les codes de secours |
| POST | `/auth/2fa/disable` | auth (+ mot de passe + code) | Désactive la 2FA (interdit si imposée par politique) |
| POST | `/auth/2fa/backup-codes/regenerate` | auth | Régénère les codes de secours |
| GET | `/auth/sessions` | auth | Liste des sessions actives (appareil, IP, dernière activité) |
| DELETE | `/auth/sessions/{sessionId}` | auth | Révoque une session |
| POST | `/auth/password/forgot` | public (limité) | Envoie un lien/code de réinitialisation (réponse identique que le compte existe ou non) |
| POST | `/auth/password/reset` | public (jeton) | Réinitialise avec jeton à usage unique |
| POST | `/auth/password/change` | auth (`@AuthenticatedOnly`) | `{ currentPassword, newPassword }` ⇒ 204 ; révoque les autres sessions ; levée du blocage `mustChangePassword` ; `422 invalid_current_password` / `password_unchanged` (C7) |
| GET | `/auth/invitations/{token}` | public (limité) | `{ email, fullName, tenantName }` ou `410 invitation_expired` (jeton inconnu, expiré ou déjà utilisé : même réponse) |
| POST | `/auth/invitations/{token}/accept` | public (jeton, limité) | `{ password }` ⇒ 204 ; statut `active` ; usage unique (410 ensuite) |

Les invitations sont créées par `POST /iam/users` et renvoyées par `POST /iam/users/{id}/invitation` (4.0 et 4.4). Tant que `mustChangePassword` est vrai, toute route à permission répond `403 password_change_required` (seules les routes `@AuthenticatedOnly` restent ouvertes).

### 4.2 Plateforme (`/platform`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| POST | `/platform/auth/login` | public (limité) | Connexion super admin (2FA obligatoire) |
| GET | `/platform/tenants` | `platform:tenants.read` | Liste des tenants (filtres : statut, plan, pays) |
| POST | `/platform/tenants` | `platform:tenants.write` | Crée un tenant (+ admin initial, plan d'essai, jeu de rôles par défaut) |
| GET | `/platform/tenants/{tenantId}` | `platform:tenants.read` | Détail, état d'abonnement, usage |
| PATCH | `/platform/tenants/{tenantId}` | `platform:tenants.write` | Met à jour (ETag) |
| POST | `/platform/tenants/{tenantId}/suspend` | `platform:tenants.suspend` | Suspend (motif obligatoire) ; sessions invalidées, lecture seule ou blocage total |
| POST | `/platform/tenants/{tenantId}/reactivate` | `platform:tenants.suspend` | Réactive |
| DELETE | `/platform/tenants/{tenantId}` | `platform:tenants.delete` | Clôture logique ; purge différée après délai légal (export préalable) |
| GET | `/platform/tenants/{tenantId}/usage` | `platform:tenants.read` | Utilisation vs quotas |
| GET | `/platform/plans` | `platform:plans.read` | Liste des plans |
| POST | `/platform/plans` | `platform:plans.write` | Crée un plan (prix par devise, quotas, modules inclus) |
| GET | `/platform/plans/{planId}` | `platform:plans.read` | Détail |
| PATCH | `/platform/plans/{planId}` | `platform:plans.write` | Modifie (versionné : n'affecte pas les abonnements en cours sauf migration) |
| POST | `/platform/plans/{planId}/archive` | `platform:plans.write` | Archive |
| GET | `/platform/subscriptions` | `platform:subscriptions.read` | Liste (filtres : statut, échéance) |
| POST | `/platform/subscriptions` | `platform:subscriptions.write` | Souscrit un tenant à un plan |
| GET | `/platform/subscriptions/{subscriptionId}` | `platform:subscriptions.read` | Détail |
| POST | `/platform/subscriptions/{subscriptionId}/change-plan` | `platform:subscriptions.write` | Changement de plan (prorata) |
| POST | `/platform/subscriptions/{subscriptionId}/renew` | `platform:subscriptions.write` | Renouvelle |
| POST | `/platform/subscriptions/{subscriptionId}/cancel` | `platform:subscriptions.write` | Résilie (fin de période ou immédiate) |
| GET | `/platform/subscriptions/{subscriptionId}/invoices` | `platform:billing.read` | Factures SaaS |
| POST | `/platform/subscriptions/{subscriptionId}/payments` | `platform:billing.write` | Enregistre un paiement SaaS (Idem) |
| GET | `/platform/modules` | `platform:modules.read` | Catalogue des modules |
| PATCH | `/platform/modules/{moduleKey}` | `platform:modules.write` | Métadonnées/disponibilité d'un module |
| GET | `/platform/tenants/{tenantId}/modules` | `platform:modules.read` | Modules activés pour un tenant |
| PUT | `/platform/tenants/{tenantId}/modules/{moduleKey}` | `platform:modules.write` | Active/désactive un module (surcharge du plan) |
| GET | `/platform/licenses` | `platform:licenses.read` | Licences (sièges, sites, modules, période) |
| POST | `/platform/licenses` | `platform:licenses.write` | Émet une licence (ex. déploiement Enterprise) |
| PATCH | `/platform/licenses/{licenseId}` | `platform:licenses.write` | Ajuste limites |
| POST | `/platform/licenses/{licenseId}/revoke` | `platform:licenses.write` | Révoque |
| GET | `/platform/stats/overview` | `platform:stats.read` | KPI globaux : tenants actifs, MRR, utilisateurs, volume |
| GET | `/platform/stats/usage` | `platform:stats.read` | Usage par module/tenant sur période |
| GET | `/platform/stats/revenue` | `platform:stats.read` | Revenus SaaS par devise/pays |
| GET | `/platform/audit-logs` | `platform:audit.read` | Journal d'audit plateforme (curseur) |
| GET | `/platform/audit-logs/{id}` | `platform:audit.read` | Détail d'une entrée |
| POST | `/platform/audit-logs/exports` | `platform:audit.export` | Export asynchrone (202) |
| POST | `/platform/delegated-access` | `platform:delegated_access.request` | Demande d'accès délégué (motif, durée, périmètre) |
| GET | `/platform/delegated-access` | `platform:delegated_access.read` | Liste des accès délégués (actifs, historiques) |
| POST | `/platform/delegated-access/{id}/revoke` | `platform:delegated_access.revoke` | Révocation immédiate |
| GET | `/platform/settings` | `platform:settings.read` | Paramètres globaux (devises, taxes, fournisseurs SMS/paiement, maintenance) |
| PATCH | `/platform/settings` | `platform:settings.write` | Met à jour (ETag) |
| GET | `/platform/admins` | `platform:admins.read` | Administrateurs de plateforme |
| POST | `/platform/admins` | `platform:admins.write` | Invite un administrateur plateforme |
| GET | `/platform/jobs/{jobId}` | `platform:stats.read` | Statut d'un traitement asynchrone |

Côté tenant, la validation d'un accès délégué demandée : `GET /tenancy/delegated-access` et `POST /tenancy/delegated-access/{id}/approve|deny` (4.3).

### 4.3 Tenancy / organisation (`/tenancy`, `/sites`, `/departments`, `/beds`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/tenancy/establishment` | `organization.read` | Fiche de l'établissement (raison sociale, type, niveau, pays, devises, fuseau) |
| PATCH | `/tenancy/establishment` | `organization.write` | Modifie (ETag) |
| PUT | `/tenancy/establishment/logo` | `organization.write` | Logo (via fichier, 4.21) |
| GET | `/tenancy/establishment/settings` | `organization.settings.read` | Paramètres : devises, numérotation, rappels, politique 2FA |
| PATCH | `/tenancy/establishment/settings` | `organization.settings.write` | Met à jour |
| GET | `/tenancy/establishment/public-profile` | `organization.read` | Profil de l'annuaire public |
| PATCH | `/tenancy/establishment/public-profile` | `organization.public_profile.write` | Publication/modification pour l'annuaire public |
| GET | `/tenancy/subscription` | `organization.subscription.read` | Plan, modules, quotas et consommation du tenant |
| GET | `/tenancy/delegated-access` | `organization.delegated_access.read` | Accès délégués reçus de la plateforme |
| POST | `/tenancy/delegated-access/{id}/approve` | `organization.delegated_access.approve` | Approuve |
| POST | `/tenancy/delegated-access/{id}/deny` | `organization.delegated_access.approve` | Refuse |
| GET | `/sites` | `organization.read` | Liste des sites |
| POST | `/sites` | `organization.sites.write` | Crée un site (contrôle quota plan) |
| GET | `/sites/{siteId}` | `organization.read` | Détail |
| PATCH | `/sites/{siteId}` | `organization.sites.write` | Modifie (ETag) |
| POST | `/sites/{siteId}/deactivate` | `organization.sites.write` | Désactive |
| GET | `/departments` | `organization.read` | Services (filtre `siteId`) |
| POST | `/departments` | `organization.departments.write` | Crée un service (type : consultation, urgences, maternité, labo, pharmacie…) |
| GET | `/departments/{departmentId}` | `organization.read` | Détail |
| PATCH | `/departments/{departmentId}` | `organization.departments.write` | Modifie |
| DELETE | `/departments/{departmentId}` | `organization.departments.write` | Archive |
| GET | `/departments/{departmentId}/members` | `organization.read` | Personnel affecté |
| PUT | `/departments/{departmentId}/members/{userId}` | `organization.departments.write` | Affecte un utilisateur |
| DELETE | `/departments/{departmentId}/members/{userId}` | `organization.departments.write` | Retire l'affectation |
| GET | `/wards` | `beds.read` | Unités d'hospitalisation / chambres |
| POST | `/wards` | `beds.write` | Crée une unité/chambre |
| PATCH | `/wards/{wardId}` | `beds.write` | Modifie |
| GET | `/beds` | `beds.read` | Lits (filtres : site, service, statut `free/occupied/cleaning/out_of_service`) |
| POST | `/beds` | `beds.write` | Crée un lit |
| PATCH | `/beds/{bedId}` | `beds.write` | Modifie |
| POST | `/beds/{bedId}/status` | `beds.manage_status` | Change le statut (nettoyage, hors service) |
| GET | `/beds/occupancy` | `beds.read` | Taux d'occupation temps réel |

### 4.4 Utilisateurs (`/users`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/users` | `users.read` | Liste (filtres : rôle, site, service, statut) |
| POST | `/users` | `users.write` | Crée un utilisateur **invité** sans mot de passe et lui envoie l'e-mail d'invitation (C6) |
| GET | `/users/{userId}` | `users.read` | Détail |
| PATCH | `/users/{userId}` | `users.write` | Modifie (ETag) |
| POST | `/users/{userId}/deactivate` | `users.deactivate` | Désactive (sessions révoquées) |
| POST | `/users/{userId}/reactivate` | `users.deactivate` | Réactive |
| POST | `/users/{userId}/reset-password` | `users.reset_password` | Force un reset (envoie un lien) |
| POST | `/users/{userId}/2fa/reset` | `users.reset_2fa` | Réinitialise la 2FA (audit renforcé) |
| GET | `/users/{userId}/sessions` | `users.sessions.read` | Sessions d'un utilisateur |
| DELETE | `/users/{userId}/sessions/{sessionId}` | `users.sessions.revoke` | Révoque |
| GET | `/users/{userId}/role-assignments` | `users.read` | Attributions de rôles avec portée |
| GET | `/users/invitations` | `users.invite` | Invitations en attente |
| POST | `/users/invitations` | `users.invite` | Invite (e-mail/téléphone, rôle, portée) |
| POST | `/users/{userId}/invitation` | `users.invite` | Renvoie l'e-mail d'invitation ; invalide le jeton précédent (implémenté : `POST /iam/users/{id}/invitation`) |
| POST | `/users/{userId}/unlock` | `users.write` | Remet à zéro `failedAttempts` / `lockedUntil` (implémenté : `POST /iam/users/{id}/unlock`, audit `iam.user.unlocked`) |
| DELETE | `/users/invitations/{id}` | `users.invite` | Annule |
| GET | `/users/me/profile` | auth | Profil personnel |
| PATCH | `/users/me/profile` | auth | Modifie (nom, langue, préférences de notification) |
| GET | `/practitioners` | `users.read` | Annuaire des praticiens (spécialité, service) 🔑 |
| GET | `/practitioners/{userId}` | `users.read` | Fiche praticien (n° d'ordre, spécialités) |

### 4.5 Rôles et permissions (`/roles`, `/permissions`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/permissions` | `roles.read` | Catalogue des permissions (regroupées par module) |
| GET | `/roles` | `roles.read` | Rôles (système + personnalisés) |
| POST | `/roles` | `roles.write` | Crée un rôle personnalisé |
| GET | `/roles/{roleId}` | `roles.read` | Détail et permissions |
| PATCH | `/roles/{roleId}` | `roles.write` | Modifie (les rôles système ne sont pas modifiables, ETag) |
| DELETE | `/roles/{roleId}` | `roles.write` | Supprime (refus si attribué) |
| POST | `/roles/{roleId}/duplicate` | `roles.write` | Duplique un rôle (point de départ) |
| PUT | `/roles/{roleId}/permissions` | `roles.permissions.write` | Remplace l'ensemble des permissions |
| GET | `/role-assignments` | `roles.assignments.read` | Attributions (filtres : utilisateur, rôle, portée) |
| POST | `/role-assignments` | `roles.assignments.write` | Attribue un rôle avec portée (`scopeType`: group/tenant/site/department, `scopeId`) |
| DELETE | `/role-assignments/{assignmentId}` | `roles.assignments.write` | Retire |
| POST | `/permissions/check` | auth | Vérifie une liste de permissions pour l'utilisateur courant (UI) |

### 4.6 Patients (`/patients`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| POST | `/patients/search` | `patients.read` | Recherche par **corps JSON** `{ q?, phone?, ipp?, limit?, cursor? }` (au moins un critère, sinon `422 search_criteria_required`) ; `GET /patients` n'existe plus : aucun terme de recherche dans une URL 🔑 |
| POST | `/patients` | `patients.create` | Crée un patient (détection de doublons : `409 patient_duplicate` avec `details.candidates`, contournable par `?force=true` + `forceReason` dans le corps, sinon `422 force_reason_required` ; `409 patient_duplicate_out_of_scope` sans détail quand seuls des homonymes hors périmètre existent) 🔑 |
| GET | `/patients/{patientId}` | `patients.read` | Dossier administratif 🔑 |
| PATCH | `/patients/{patientId}` | `patients.update` | Modifie ; `If-Match` obligatoire (`428` absent, `412` périmé) ; `null` efface téléphone, e-mail, pièce, adresse, ville, groupe sanguin 🔑 |
| DELETE | `/patients/{patientId}` | `patients.delete` | Archivage logique ; `If-Match` obligatoire et corps `{ reason }` (3..500), motif audité |
| POST | `/patients/{patientId}/merge` | `patients.merge` | Fusionne un doublon (irréversible hors rollback audité) |
| GET | `/patients/duplicates` | `patients.merge` | Doublons potentiels |
| GET | `/patients/{patientId}/summary` | `patients.read` | Résumé clinique (allergies, antécédents majeurs, derniers passages) |
| GET | `/patients/{patientId}/history` | `patients.history.read` | Historique chronologique (passages, consultations, examens, factures) |
| GET | `/patients/{patientId}/allergies` | `patients.medical.read` | Allergies |
| POST | `/patients/{patientId}/allergies` | `patients.medical.write` | Ajoute |
| PATCH | `/patients/{patientId}/allergies/{allergyId}` | `patients.medical.write` | Modifie |
| DELETE | `/patients/{patientId}/allergies/{allergyId}` | `patients.medical.write` | Retire (suppression logique + motif) |
| GET | `/patients/{patientId}/medical-history` | `patients.medical.read` | Antécédents (médicaux, chirurgicaux, familiaux, obstétricaux) |
| POST | `/patients/{patientId}/medical-history` | `patients.medical.write` | Ajoute un antécédent |
| PATCH | `/patients/{patientId}/medical-history/{entryId}` | `patients.medical.write` | Modifie |
| DELETE | `/patients/{patientId}/medical-history/{entryId}` | `patients.medical.write` | Retire logiquement |
| GET | `/patients/{patientId}/vitals` | `patients.medical.read` | Constantes (poids, TA, température…) |
| POST | `/patients/{patientId}/vitals` | `nursing.vitals.write` | Enregistre des constantes |
| GET | `/patients/{patientId}/documents` | `patients.documents.read` | Documents (pièces d'identité, comptes rendus, imagerie) |
| POST | `/patients/{patientId}/documents` | `patients.documents.write` | Rattache un fichier (après envoi via `/files`) |
| GET | `/patients/{patientId}/documents/{documentId}` | `patients.documents.read` | Métadonnées + URL signée courte durée |
| DELETE | `/patients/{patientId}/documents/{documentId}` | `patients.documents.delete` | Retire |
| GET | `/patients/{patientId}/insurances` | `patients.read` | Couvertures assurance du patient |
| POST | `/patients/{patientId}/insurances` | `patients.update` | Ajoute une couverture |
| GET | `/patients/{patientId}/consents` | `patients.consents.read` | Consentements (traitement de données, partage, SMS) |
| POST | `/patients/{patientId}/consents` | `patients.consents.write` | Enregistre un consentement |
| POST | `/patients/{patientId}/consents/{consentId}/withdraw` | `patients.consents.write` | Retrait de consentement |
| POST | `/patients/{patientId}/data-export` | `patients.data_export` | Export des données du patient (droit d'accès), asynchrone |
| POST | `/patients/{patientId}/link-code` | `patients.link_mobile` | Génère un code de liaison avec l'app mobile patient |
| GET | `/patients/{patientId}/access-log` | `patients.access_log.read` | Qui a consulté ce dossier (traçabilité) |

### 4.7 Rendez-vous (`/appointments`, `/schedules`, `/queues`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/appointments/slots` | `appointments.read` | Créneaux libres (filtres : service, praticien, site, plage de dates, type) 🔑 |
| GET | `/appointments` | `appointments.read` | Liste/agenda (filtres : date, praticien, service, statut, patient) ; forme `AppointmentView` ; audit `appointment.listed` avec `patientIds` 🔑 |
| POST | `/appointments` | `appointments.create` | Crée un rendez-vous (**Idem** ; `409 slot_unavailable` si créneau pris) 🔑 |
| GET | `/appointments/{appointmentId}` | `appointments.read` | Détail 🔑 |
| PATCH | `/appointments/{appointmentId}` | `appointments.update` | Modifie (ETag) |
| POST | `/appointments/{appointmentId}/reschedule` | `appointments.update` | Reprogramme (ETag) |
| POST | `/appointments/{appointmentId}/confirm` | `appointments.confirm` | Confirme (par l'établissement ou après confirmation patient) |
| POST | `/appointments/{appointmentId}/cancel` | `appointments.cancel` | Annule avec motif ; libère le créneau |
| POST | `/appointments/{appointmentId}/check-in` | `appointments.checkin` | Enregistre l'arrivée ; émet un ticket de file |
| POST | `/appointments/{appointmentId}/no-show` | `appointments.update` | Marque absent |
| POST | `/appointments/{appointmentId}/complete` | `appointments.update` | Clôture le rendez-vous |
| GET | `/appointments/{appointmentId}/confirmations` | `appointments.read` | Historique des rappels/confirmations (SMS, push, réponse patient) |
| POST | `/appointments/{appointmentId}/confirmations/resend` | `appointments.confirm` | Renvoie un rappel |
| POST | `/appointment-confirmations/{token}/respond` | public (jeton à usage unique) | Réponse patient par lien/SMS (`confirm` / `cancel`) |
| GET | `/schedules` | `appointments.schedules.read` | Disponibilités des praticiens (modèles hebdomadaires) |
| POST | `/schedules` | `appointments.schedules.write` | Crée un modèle de disponibilité (jours, plages, durée de créneau, capacité) |
| PATCH | `/schedules/{scheduleId}` | `appointments.schedules.write` | Modifie |
| DELETE | `/schedules/{scheduleId}` | `appointments.schedules.write` | Supprime/archive |
| GET | `/schedules/exceptions` | `appointments.schedules.read` | Congés, jours fériés, fermetures |
| POST | `/schedules/exceptions` | `appointments.schedules.write` | Ajoute une indisponibilité (impact sur les RDV existants signalé en `warnings`) |
| DELETE | `/schedules/exceptions/{exceptionId}` | `appointments.schedules.write` | Supprime |
| GET | `/appointment-types` | `appointments.read` | Types de rendez-vous (durée, tarif par défaut) |
| POST | `/appointment-types` | `appointments.schedules.write` | Crée un type |
| PATCH | `/appointment-types/{typeId}` | `appointments.schedules.write` | Modifie |
| GET | `/queues` | `queues.read` | Files d'attente par service (état courant) |
| GET | `/queues/{queueId}/tickets` | `queues.read` | Tickets en attente/en cours |
| POST | `/queues/{queueId}/tickets` | `queues.write` | Crée un ticket (passage sans RDV) |
| POST | `/queues/tickets/{ticketId}/call` | `queues.call` | Appelle le patient suivant/ce patient |
| POST | `/queues/tickets/{ticketId}/start` | `queues.call` | Début de prise en charge |
| POST | `/queues/tickets/{ticketId}/complete` | `queues.call` | Fin |
| POST | `/queues/tickets/{ticketId}/skip` | `queues.call` | Passe/absent |
| POST | `/queues/tickets/{ticketId}/transfer` | `queues.write` | Transfère vers un autre service/praticien |
| PATCH | `/queues/tickets/{ticketId}/priority` | `queues.prioritize` | Change la priorité (urgence, personne vulnérable) |
| GET | `/queues/{queueId}/stats` | `queues.read` | Temps d'attente moyen, effectif |
| GET | `/queues/display/{queueId}` | `queues.display` | Données pour écran d'affichage (jeton d'écran dédié, lecture seule) |

### 4.8 Médical (`/encounters`, `/consultations`, `/prescriptions`, `/admissions`, `/nursing`)

#### Consultations et diagnostics

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/encounters` | `consultations.read` | Passages/épisodes (consultation, urgence, hospitalisation) |
| POST | `/encounters` | `consultations.create` | Ouvre un passage (idempotent par rendez-vous) |
| GET | `/encounters/{encounterId}` | `consultations.read` | Détail |
| POST | `/encounters/{encounterId}/close` | `consultations.close` | Clôture (verrouille le dossier du passage) |
| GET | `/consultations` | `consultations.read` | Liste (filtres : patient, praticien, date) |
| POST | `/consultations` | `consultations.create` | Crée une consultation (motif, anamnèse, examen clinique) |
| GET | `/consultations/{consultationId}` | `consultations.read` | Détail |
| PATCH | `/consultations/{consultationId}` | `consultations.update` | Modifie tant que non signée (ETag) |
| POST | `/consultations/{consultationId}/sign` | `consultations.sign` | Signe et verrouille ; modifications ultérieures par addendum |
| POST | `/consultations/{consultationId}/addenda` | `consultations.update` | Ajoute un addendum à une consultation signée |
| GET | `/consultations/{consultationId}/diagnoses` | `consultations.read` | Diagnostics (CIM-10) |
| POST | `/consultations/{consultationId}/diagnoses` | `diagnoses.write` | Ajoute un diagnostic (code CIM-10, type principal/secondaire) |
| PATCH | `/consultations/{consultationId}/diagnoses/{diagnosisId}` | `diagnoses.write` | Modifie |
| DELETE | `/consultations/{consultationId}/diagnoses/{diagnosisId}` | `diagnoses.write` | Retire (avant signature) |
| GET | `/reference/icd10` | auth | Recherche CIM-10 (`q`) ; cache `ETag` |
| GET | `/consultations/{consultationId}/procedures` | `consultations.read` | Actes réalisés |
| POST | `/consultations/{consultationId}/procedures` | `procedures.write` | Enregistre un acte (code nomenclature, tarif, exécutant) |
| PATCH | `/consultations/{consultationId}/procedures/{procedureId}` | `procedures.write` | Modifie |
| DELETE | `/consultations/{consultationId}/procedures/{procedureId}` | `procedures.write` | Annule |
| GET | `/procedure-catalog` | `procedures.read` | Catalogue d'actes et tarifs |
| POST | `/procedure-catalog` | `procedures.catalog.write` | Ajoute un acte au catalogue |
| PATCH | `/procedure-catalog/{procedureCode}` | `procedures.catalog.write` | Modifie |
| GET | `/consultations/{consultationId}/documents` | `consultations.read` | Certificats, comptes rendus |
| POST | `/consultations/{consultationId}/documents/generate` | `consultations.documents.generate` | Génère un certificat, un arrêt de travail, un courrier (PDF) |
| POST | `/consultations/{consultationId}/referrals` | `consultations.update` | Lettre d'orientation/référence vers un autre établissement |

#### Prescriptions

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/prescriptions` | `prescriptions.read` | Liste (filtres : patient, statut, prescripteur) |
| POST | `/prescriptions` | `prescriptions.create` | Crée (alertes allergies/interactions en `warnings`, bloquantes si `severity=contraindicated` sans `override`) |
| GET | `/prescriptions/{prescriptionId}` | `prescriptions.read` | Détail |
| PATCH | `/prescriptions/{prescriptionId}` | `prescriptions.update` | Modifie tant que non délivrée (ETag) |
| POST | `/prescriptions/{prescriptionId}/sign` | `prescriptions.sign` | Signe (déclenche `prescription.signed`) |
| POST | `/prescriptions/{prescriptionId}/cancel` | `prescriptions.cancel` | Annule (motif) |
| POST | `/prescriptions/{prescriptionId}/renew` | `prescriptions.create` | Renouvelle |
| GET | `/prescriptions/{prescriptionId}/pdf` | `prescriptions.read` | Ordonnance PDF (URL signée) |
| POST | `/prescriptions/{prescriptionId}/check` | `prescriptions.read` | Vérifie allergies/interactions/posologie sans enregistrer |
| GET | `/reference/drugs` | auth | Référentiel médicaments (DCI, forme, dosage) |

#### Hospitalisations et sorties

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/admissions` | `admissions.read` | Hospitalisations (filtres : statut, service, lit) |
| POST | `/admissions` | `admissions.create` | Admet un patient (affecte un lit, motif, médecin responsable) |
| GET | `/admissions/{admissionId}` | `admissions.read` | Détail (dossier d'hospitalisation) |
| PATCH | `/admissions/{admissionId}` | `admissions.update` | Modifie (ETag) |
| POST | `/admissions/{admissionId}/transfer-bed` | `admissions.transfer` | Change de lit/service |
| GET | `/admissions/{admissionId}/progress-notes` | `admissions.read` | Notes d'évolution |
| POST | `/admissions/{admissionId}/progress-notes` | `admissions.update` | Ajoute une note |
| POST | `/admissions/{admissionId}/discharge` | `discharges.create` | Prépare/valide la sortie (type : guérison, transfert, décès, sortie contre avis médical, fugue) ; libère le lit |
| GET | `/admissions/{admissionId}/discharge` | `admissions.read` | Détail de sortie |
| GET | `/admissions/{admissionId}/discharge/summary` | `admissions.read` | Compte rendu d'hospitalisation PDF |
| GET | `/admissions/{admissionId}/bill-preview` | `billing.read` | Pré-facture du séjour |

#### Soins infirmiers

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/nursing/care-plans` | `nursing.read` | Plans de soins |
| POST | `/nursing/care-plans` | `nursing.write` | Crée un plan de soins pour une admission |
| PATCH | `/nursing/care-plans/{carePlanId}` | `nursing.write` | Modifie |
| GET | `/nursing/tasks` | `nursing.read` | Tâches de soins du poste (filtres : service, heure, statut) |
| POST | `/nursing/tasks/{taskId}/perform` | `nursing.perform` | Marque un soin réalisé (horodaté, auteur) |
| POST | `/nursing/tasks/{taskId}/skip` | `nursing.perform` | Soin non réalisé (motif) |
| GET | `/nursing/medication-administrations` | `nursing.read` | Administrations médicamenteuses (MAR) |
| POST | `/nursing/medication-administrations` | `nursing.administer` | Enregistre une administration (décrémente le stock du service si configuré) |
| GET | `/nursing/observations` | `nursing.read` | Observations (surveillances) |
| POST | `/nursing/observations` | `nursing.write` | Ajoute une observation |
| POST | `/nursing/shift-handovers` | `nursing.write` | Transmission de relève |
| GET | `/nursing/shift-handovers` | `nursing.read` | Liste des relèves |

### 4.9 Laboratoire (`/lab`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/lab/tests` | `lab.catalog.read` | Catalogue des examens (tarif, délai, échantillon) |
| POST | `/lab/tests` | `lab.catalog.write` | Ajoute un examen |
| PATCH | `/lab/tests/{testId}` | `lab.catalog.write` | Modifie (valeurs de référence, unités) |
| GET | `/lab/orders` | `lab.orders.read` | Demandes d'examens (filtres : statut, patient, prescripteur) 🔑 |
| POST | `/lab/orders` | `lab.orders.create` | Crée une demande d'examens (prescripteur interne ou externe) 🔑 |
| GET | `/lab/orders/{orderId}` | `lab.orders.read` | Détail |
| POST | `/lab/orders/{orderId}/cancel` | `lab.orders.cancel` | Annule |
| POST | `/lab/orders/{orderId}/samples` | `lab.samples.write` | Enregistre un prélèvement (code-barres, préleveur, heure) |
| GET | `/lab/samples` | `lab.samples.read` | Échantillons (filtres : statut, paillasse) |
| POST | `/lab/samples/{sampleId}/receive` | `lab.samples.write` | Réception au labo |
| POST | `/lab/samples/{sampleId}/reject` | `lab.samples.write` | Rejette (motif) |
| GET | `/lab/worklists` | `lab.results.read` | Listes de travail par paillasse |
| GET | `/lab/results` | `lab.results.read` | Résultats (filtres : patient, statut, période) 🔑 |
| POST | `/lab/orders/{orderId}/results` | `lab.results.write` | Saisit les résultats (valeurs, unités, drapeaux anormal/critique calculés) |
| PATCH | `/lab/results/{resultId}` | `lab.results.write` | Corrige avant validation (ETag) |
| POST | `/lab/results/{resultId}/validate` | `lab.results.validate` | Validation biologique (déclenche `lab_result.validated`, notification du prescripteur et du patient si publié) |
| POST | `/lab/results/{resultId}/amend` | `lab.results.amend` | Rectification après validation (version tracée, notification) |
| POST | `/lab/results/{resultId}/publish` | `lab.results.publish` | Rend le résultat visible dans l'app patient |
| GET | `/lab/results/{resultId}/pdf` | `lab.results.read` | Compte rendu PDF |
| POST | `/lab/results/import` | `lab.results.import` | Import depuis automate/fichier (asynchrone) |
| GET | `/lab/critical-alerts` | `lab.results.read` | Valeurs critiques non acquittées |
| POST | `/lab/critical-alerts/{alertId}/acknowledge` | `lab.results.validate` | Acquittement par le clinicien |
| GET | `/lab/quality-controls` | `lab.qc.read` | Contrôles qualité |
| POST | `/lab/quality-controls` | `lab.qc.write` | Enregistre un contrôle qualité |

### 4.10 Pharmacie (`/pharmacy`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/pharmacy/products` | `pharmacy.products.read` | Catalogue produits (médicaments, consommables ; prix, DCI) |
| POST | `/pharmacy/products` | `pharmacy.products.write` | Ajoute un produit |
| GET | `/pharmacy/products/{productId}` | `pharmacy.products.read` | Détail et stock agrégé |
| PATCH | `/pharmacy/products/{productId}` | `pharmacy.products.write` | Modifie (ETag) |
| GET | `/pharmacy/prescriptions/pending` | `pharmacy.dispense.read` | Ordonnances à délivrer (file pharmacie) |
| POST | `/pharmacy/dispensations` | `pharmacy.dispense` | Délivre (totale/partielle) ; sélection de lots FEFO, décrément de stock, ligne de facture (**Idem**) |
| GET | `/pharmacy/dispensations` | `pharmacy.dispense.read` | Historique des délivrances |
| GET | `/pharmacy/dispensations/{dispensationId}` | `pharmacy.dispense.read` | Détail |
| POST | `/pharmacy/dispensations/{dispensationId}/return` | `pharmacy.returns` | Retour/annulation de délivrance |
| POST | `/pharmacy/sales` | `pharmacy.sales.create` | Vente comptoir (sans ordonnance, si autorisée) (**Idem**) |
| GET | `/pharmacy/sales` | `pharmacy.sales.read` | Ventes |
| GET | `/pharmacy/pricing` | `pharmacy.pricing.read` | Tarification (marge, listes de prix, assurances) |
| PUT | `/pharmacy/pricing/{productId}` | `pharmacy.pricing.write` | Met à jour le prix |
| GET | `/pharmacy/controlled-substances/register` | `pharmacy.controlled.read` | Registre des stupéfiants/psychotropes |
| GET | `/pharmacy/interactions/check` | `pharmacy.dispense.read` | Contrôle d'interactions sur une liste de produits |

### 4.11 Stocks (`/stock`)

Transverse (médicaments, consommables, matériel, réactifs) : la pharmacie en est cliente.

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/stock/locations` | `stock.read` | Magasins/dépôts/pharmacies de service |
| POST | `/stock/locations` | `stock.locations.write` | Crée un emplacement |
| PATCH | `/stock/locations/{locationId}` | `stock.locations.write` | Modifie |
| GET | `/stock/items` | `stock.read` | Articles de stock (filtres : emplacement, catégorie, `lowStock=true`) 🔑 |
| POST | `/stock/items` | `stock.items.write` | Crée un article |
| PATCH | `/stock/items/{itemId}` | `stock.items.write` | Modifie (seuils min/max, unité) |
| GET | `/stock/items/{itemId}/lots` | `stock.read` | Lots (péremption) |
| GET | `/stock/levels` | `stock.read` | Niveaux courants par article/emplacement/lot |
| GET | `/stock/movements` | `stock.read` | Mouvements (curseur) |
| POST | `/stock/movements` | `stock.movements.write` | Mouvement manuel : entrée, sortie, perte, casse (motif obligatoire) (**Idem**) |
| POST | `/stock/transfers` | `stock.transfers.write` | Transfert inter-emplacements |
| POST | `/stock/transfers/{transferId}/receive` | `stock.transfers.write` | Réception d'un transfert |
| GET | `/stock/inventories` | `stock.inventories.read` | Inventaires physiques |
| POST | `/stock/inventories` | `stock.inventories.write` | Ouvre un inventaire |
| PUT | `/stock/inventories/{inventoryId}/counts` | `stock.inventories.write` | Saisit les comptages |
| POST | `/stock/inventories/{inventoryId}/validate` | `stock.inventories.validate` | Valide et génère les écarts (mouvements d'ajustement) |
| GET | `/stock/suppliers` | `stock.suppliers.read` | Fournisseurs |
| POST | `/stock/suppliers` | `stock.suppliers.write` | Crée un fournisseur |
| PATCH | `/stock/suppliers/{supplierId}` | `stock.suppliers.write` | Modifie |
| GET | `/stock/purchase-orders` | `stock.purchases.read` | Bons de commande |
| POST | `/stock/purchase-orders` | `stock.purchases.write` | Crée un bon de commande |
| POST | `/stock/purchase-orders/{orderId}/approve` | `stock.purchases.approve` | Approuve |
| POST | `/stock/purchase-orders/{orderId}/send` | `stock.purchases.write` | Envoie au fournisseur |
| POST | `/stock/purchase-orders/{orderId}/receipts` | `stock.receipts.write` | Réception (partielle possible, lots, péremption) |
| GET | `/stock/alerts` | `stock.read` | Alertes : stock bas, rupture, péremption proche |
| GET | `/stock/expiring` | `stock.read` | Lots expirant sous N jours |
| GET | `/stock/valuation` | `stock.valuation.read` | Valorisation (CMUP/FIFO) |

### 4.12 Facturation, caisse, paiements (`/billing`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/billing/price-lists` | `billing.pricing.read` | Grilles tarifaires (actes, examens, hospitalisation) |
| POST | `/billing/price-lists` | `billing.pricing.write` | Crée une grille |
| PATCH | `/billing/price-lists/{priceListId}` | `billing.pricing.write` | Modifie |
| GET | `/billing/invoices` | `billing.read` | Factures (filtres : patient, statut, période, assureur) 🔑 |
| POST | `/billing/invoices` | `billing.create` | Crée une facture (lignes issues d'actes, examens, délivrances ; part patient / part assurance) |
| GET | `/billing/invoices/{invoiceId}` | `billing.read` | Détail 🔑 |
| PATCH | `/billing/invoices/{invoiceId}` | `billing.update` | Modifie tant que brouillon (ETag) |
| POST | `/billing/invoices/{invoiceId}/issue` | `billing.issue` | Émet (numérotation légale séquentielle, verrouillage) |
| POST | `/billing/invoices/{invoiceId}/cancel` | `billing.cancel` | Annule par avoir (jamais de suppression) |
| POST | `/billing/invoices/{invoiceId}/credit-notes` | `billing.credit_note` | Émet un avoir |
| GET | `/billing/invoices/{invoiceId}/pdf` | `billing.read` | PDF (URL signée) |
| POST | `/billing/invoices/{invoiceId}/discounts` | `billing.discount` | Remise (plafond par rôle, motif) |
| GET | `/billing/invoices/{invoiceId}/payments` | `billing.read` | Paiements de la facture |
| POST | `/billing/invoices/{invoiceId}/payments` | `payments.create` | Encaisse (espèces, carte, Mobile Money, virement, chèque) (**Idem**) |
| POST | `/billing/invoices/{invoiceId}/payment-links` | `payments.create` | Génère un lien/demande de paiement Mobile Money (push USSD/lien) (**Idem**) |
| GET | `/billing/payments` | `payments.read` | Paiements (curseur) |
| GET | `/billing/payments/{paymentId}` | `payments.read` | Détail et statut (`pending`, `succeeded`, `failed`, `refunded`) |
| POST | `/billing/payments/{paymentId}/refund` | `payments.refund` | Remboursement total/partiel (**Idem**, approbation selon seuil) |
| POST | `/billing/payments/{paymentId}/reconcile` | `payments.reconcile` | Force la réconciliation avec le fournisseur |
| GET | `/billing/cash-registers` | `cash.read` | Caisses |
| POST | `/billing/cash-registers` | `cash.registers.write` | Crée une caisse |
| POST | `/billing/cash-sessions` | `cash.open` | Ouvre une session de caisse (fond de caisse) |
| GET | `/billing/cash-sessions` | `cash.read` | Sessions |
| GET | `/billing/cash-sessions/{sessionId}` | `cash.read` | Détail et solde théorique |
| POST | `/billing/cash-sessions/{sessionId}/movements` | `cash.movements.write` | Entrée/sortie de caisse hors facture (**Idem**) |
| POST | `/billing/cash-sessions/{sessionId}/close` | `cash.close` | Clôture (comptage, écart, justification) |
| GET | `/billing/cash-sessions/{sessionId}/report` | `cash.read` | État de caisse (Z) PDF |
| GET | `/billing/receivables` | `billing.receivables.read` | Créances (balance âgée) |
| POST | `/billing/payment-plans` | `billing.payment_plans.write` | Échéancier de paiement pour un patient |
| GET | `/billing/exchange-rates` | `billing.read` | Taux de change multi-devises du tenant |
| PUT | `/billing/exchange-rates/{currency}` | `billing.rates.write` | Fixe un taux |

### 4.13 Assurance (`/insurance`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/insurance/payers` | `insurance.read` | Assureurs/mutuelles/programmes (INPS, CNPS, mutuelles, entreprises) |
| POST | `/insurance/payers` | `insurance.payers.write` | Crée un payeur |
| PATCH | `/insurance/payers/{payerId}` | `insurance.payers.write` | Modifie |
| GET | `/insurance/contracts` | `insurance.read` | Contrats/conventions (taux de couverture, plafonds, exclusions) |
| POST | `/insurance/contracts` | `insurance.contracts.write` | Crée un contrat/convention |
| GET | `/insurance/contracts/{contractId}` | `insurance.read` | Détail |
| PATCH | `/insurance/contracts/{contractId}` | `insurance.contracts.write` | Modifie (ETag) |
| POST | `/insurance/contracts/{contractId}/terminate` | `insurance.contracts.write` | Résilie |
| PUT | `/insurance/contracts/{contractId}/coverage-rules` | `insurance.contracts.write` | Règles de couverture par catégorie d'actes |
| POST | `/insurance/eligibility-checks` | `insurance.eligibility.check` | Vérifie les droits d'un patient (manuel ou via connecteur) |
| GET | `/insurance/pre-authorizations` | `insurance.preauth.read` | Prises en charge / accords préalables |
| POST | `/insurance/pre-authorizations` | `insurance.preauth.write` | Demande une prise en charge |
| GET | `/insurance/pre-authorizations/{id}` | `insurance.preauth.read` | Détail |
| POST | `/insurance/pre-authorizations/{id}/approve` | `insurance.preauth.decide` | Enregistre l'accord (montant, validité) |
| POST | `/insurance/pre-authorizations/{id}/reject` | `insurance.preauth.decide` | Enregistre le refus (motif) |
| GET | `/insurance/claims` | `insurance.claims.read` | Demandes de remboursement (claims) 🔑 |
| POST | `/insurance/claims` | `insurance.claims.write` | Crée un claim depuis une ou plusieurs factures 🔑 |
| GET | `/insurance/claims/{claimId}` | `insurance.claims.read` | Détail et statut |
| POST | `/insurance/claims/{claimId}/submit` | `insurance.claims.submit` | Soumet à l'assureur (export/connecteur) |
| POST | `/insurance/claims/{claimId}/responses` | `insurance.claims.write` | Enregistre la réponse (accepté, partiel, rejeté + motifs) |
| POST | `/insurance/claims/{claimId}/resubmit` | `insurance.claims.submit` | Re-soumission après rejet |
| POST | `/insurance/claims/batches` | `insurance.claims.submit` | Lot de claims par assureur/période (export PDF/CSV, asynchrone) |
| POST | `/insurance/remittances` | `insurance.remittances.write` | Enregistre un règlement assureur et le lettre aux factures |
| GET | `/insurance/remittances` | `insurance.claims.read` | Règlements reçus |
| GET | `/insurance/aging` | `insurance.claims.read` | Balance âgée par assureur |

### 4.14 Ressources humaines (`/hr`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/hr/employees` | `hr.read` | Employés (dossier RH, distinct de `users`) |
| POST | `/hr/employees` | `hr.write` | Crée un employé (lien optionnel vers un utilisateur) |
| GET | `/hr/employees/{employeeId}` | `hr.read` | Détail (données sensibles : permission `hr.sensitive.read` pour salaire/pièces) |
| PATCH | `/hr/employees/{employeeId}` | `hr.write` | Modifie (ETag) |
| POST | `/hr/employees/{employeeId}/terminate` | `hr.terminate` | Fin de contrat |
| GET | `/hr/employees/{employeeId}/contracts` | `hr.contracts.read` | Contrats de travail |
| POST | `/hr/employees/{employeeId}/contracts` | `hr.contracts.write` | Ajoute un contrat/avenant |
| GET | `/hr/employees/{employeeId}/documents` | `hr.documents.read` | Pièces du dossier |
| POST | `/hr/employees/{employeeId}/documents` | `hr.documents.write` | Ajoute une pièce |
| GET | `/hr/positions` | `hr.read` | Postes et grades |
| POST | `/hr/positions` | `hr.write` | Crée un poste |
| GET | `/hr/shifts` | `hr.planning.read` | Plannings de garde/poste (filtres : service, période) |
| POST | `/hr/shifts` | `hr.planning.write` | Crée un poste de garde |
| POST | `/hr/shifts/{shiftId}/assignments` | `hr.planning.write` | Affecte un employé |
| POST | `/hr/shifts/{shiftId}/swap-requests` | `hr.planning.request` | Demande d'échange de garde |
| POST | `/hr/shift-swaps/{id}/approve` | `hr.planning.write` | Approuve l'échange |
| GET | `/hr/attendance` | `hr.attendance.read` | Pointages/présences |
| POST | `/hr/attendance/clock-in` | `hr.attendance.clock` | Pointage d'arrivée |
| POST | `/hr/attendance/clock-out` | `hr.attendance.clock` | Pointage de départ |
| GET | `/hr/leave-types` | `hr.read` | Types de congés |
| GET | `/hr/leave-requests` | `hr.leave.read` | Demandes de congés |
| POST | `/hr/leave-requests` | `hr.leave.request` | Demande de congé |
| POST | `/hr/leave-requests/{requestId}/approve` | `hr.leave.approve` | Approuve |
| POST | `/hr/leave-requests/{requestId}/reject` | `hr.leave.approve` | Refuse |
| GET | `/hr/payroll/periods` | `hr.payroll.read` | Périodes de paie |
| POST | `/hr/payroll/periods` | `hr.payroll.write` | Ouvre une période |
| POST | `/hr/payroll/periods/{periodId}/compute` | `hr.payroll.write` | Calcule les bulletins (asynchrone) |
| GET | `/hr/payroll/periods/{periodId}/payslips` | `hr.payroll.read` | Bulletins |
| POST | `/hr/payroll/periods/{periodId}/validate` | `hr.payroll.validate` | Valide et verrouille (écritures comptables générées) |
| GET | `/hr/payslips/{payslipId}/pdf` | `hr.payroll.read` | Bulletin PDF |
| GET | `/hr/me/payslips` | auth | Mes bulletins (self-service) |
| GET | `/hr/trainings` | `hr.trainings.read` | Formations et habilitations |
| POST | `/hr/trainings` | `hr.trainings.write` | Enregistre une formation |
| GET | `/hr/licenses-expiring` | `hr.read` | Habilitations/diplômes/autorisations d'exercice proches de l'échéance |

### 4.15 Comptabilité (`/accounting`, SYSCOHADA)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/accounting/chart-of-accounts` | `accounting.read` | Plan comptable SYSCOHADA révisé (comptes du tenant) |
| POST | `/accounting/accounts` | `accounting.accounts.write` | Ajoute un compte auxiliaire/divisionnaire |
| PATCH | `/accounting/accounts/{accountId}` | `accounting.accounts.write` | Modifie |
| GET | `/accounting/journals` | `accounting.read` | Journaux (ventes, achats, banque, caisse, OD, paie) |
| POST | `/accounting/journals` | `accounting.journals.write` | Crée un journal |
| GET | `/accounting/fiscal-years` | `accounting.read` | Exercices |
| POST | `/accounting/fiscal-years` | `accounting.fiscal_years.write` | Ouvre un exercice |
| POST | `/accounting/fiscal-years/{yearId}/close` | `accounting.fiscal_years.close` | Clôture (verrouille, report à nouveau) |
| GET | `/accounting/periods` | `accounting.read` | Périodes comptables |
| POST | `/accounting/periods/{periodId}/lock` | `accounting.periods.lock` | Verrouille une période (`423` ensuite) |
| GET | `/accounting/entries` | `accounting.entries.read` | Écritures comptables (curseur ; filtres : journal, compte, période, pièce) |
| POST | `/accounting/entries` | `accounting.entries.write` | Saisit une écriture (équilibre débit = crédit validé) (**Idem**) |
| GET | `/accounting/entries/{entryId}` | `accounting.entries.read` | Détail |
| POST | `/accounting/entries/{entryId}/validate` | `accounting.entries.validate` | Valide (irréversible) |
| POST | `/accounting/entries/{entryId}/reverse` | `accounting.entries.write` | Extourne (aucune modification d'une écriture validée) |
| POST | `/accounting/postings/generate` | `accounting.postings.generate` | Génère les écritures depuis facturation, paie, stocks (asynchrone, par période) |
| GET | `/accounting/ledgers/general` | `accounting.reports.read` | Grand livre |
| GET | `/accounting/ledgers/auxiliary` | `accounting.reports.read` | Grand livre auxiliaire (clients, fournisseurs) |
| GET | `/accounting/trial-balance` | `accounting.reports.read` | Balance |
| GET | `/accounting/financial-statements/balance-sheet` | `accounting.reports.read` | Bilan |
| GET | `/accounting/financial-statements/income-statement` | `accounting.reports.read` | Compte de résultat |
| GET | `/accounting/financial-statements/cash-flow` | `accounting.reports.read` | Tableau des flux de trésorerie |
| GET | `/accounting/vat-return` | `accounting.reports.read` | Déclaration de TVA |
| POST | `/accounting/bank-accounts` | `accounting.bank.write` | Compte bancaire / Mobile Money |
| POST | `/accounting/bank-reconciliations` | `accounting.bank.reconcile` | Rapprochement bancaire |
| POST | `/accounting/exports` | `accounting.export` | Export (FEC-like, CSV, Excel), asynchrone |
| GET | `/accounting/tax-rates` | `accounting.read` | Taux de TVA/taxes du pays |
| GET | `/accounting/cost-centers` | `accounting.read` | Centres analytiques (service/site) |
| POST | `/accounting/cost-centers` | `accounting.cost_centers.write` | Crée un centre analytique |

### 4.16 Notifications (`/notifications`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/notifications` | auth | Notifications in-app de l'utilisateur (curseur ; `?unread=true`) |
| GET | `/notifications/unread-count` | auth | Compteur |
| POST | `/notifications/{notificationId}/read` | auth | Marque lue |
| POST | `/notifications/read-all` | auth | Tout marquer lu |
| DELETE | `/notifications/{notificationId}` | auth | Supprime |
| GET | `/notifications/preferences` | auth | Préférences (canaux par type d'événement) |
| PUT | `/notifications/preferences` | auth | Met à jour |
| POST | `/notifications/devices` | auth | Enregistre un jeton push (FCM/Expo) |
| DELETE | `/notifications/devices/{deviceId}` | auth | Retire un appareil |
| GET | `/notifications/templates` | `notifications.templates.read` | Modèles SMS/e-mail/push (par langue) |
| PUT | `/notifications/templates/{templateKey}/{locale}` | `notifications.templates.write` | Modifie un modèle |
| POST | `/notifications/templates/{templateKey}/preview` | `notifications.templates.read` | Aperçu avec données d'exemple |
| GET | `/notifications/outbox` | `notifications.logs.read` | Journal des envois (SMS/e-mail/push ; statut, coût) |
| POST | `/notifications/outbox/{id}/retry` | `notifications.send` | Renvoie un message en échec |
| POST | `/notifications/send` | `notifications.send` | Envoi manuel à un patient/utilisateur (soumis aux quotas SMS) |
| POST | `/notifications/broadcasts` | `notifications.broadcast` | Campagne vers un segment (asynchrone, quota) |
| GET | `/notifications/sender-ids` | `notifications.settings.read` | Identifiants d'expéditeur SMS |
| GET | `/notifications/credits` | `notifications.settings.read` | Solde/quota SMS du plan |

### 4.17 Fichiers (`/files`)

Stockage S3-compatible ; l'API ne transite pas les gros binaires : **URL pré-signées**.

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| POST | `/files/uploads` | `files.upload` | Demande d'envoi : déclare nom, type MIME, taille, empreinte SHA-256 ; retourne `fileId` + URL PUT pré-signée (ou multipart pour gros fichiers). Contrôles : liste blanche MIME, taille max par plan, quota de stockage |
| POST | `/files/uploads/{fileId}/complete` | `files.upload` | Confirme l'envoi ; déclenche antivirus (ClamAV) et extraction de métadonnées ; statut `scanning` → `available` / `quarantined` |
| GET | `/files/{fileId}` | `files.read` | Métadonnées |
| GET | `/files/{fileId}/download-url` | `files.read` | URL de téléchargement signée, courte durée (60-300 s), journalisée |
| DELETE | `/files/{fileId}` | `files.delete` | Suppression logique (rétention légale) |
| GET | `/files` | `files.read` | Liste (filtres : entité liée, type) |
| GET | `/files/usage` | `files.read` | Espace utilisé vs quota |

Les droits d'accès à un fichier dérivent de l'entité à laquelle il est attaché (dossier patient, employé…) et sont revérifiés à chaque génération d'URL.

### 4.18 Rapports et tableaux de bord (`/reports`, `/dashboards`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/dashboards/overview` | `dashboards.read` | Indicateurs de direction (activité, recettes, occupation, rendez-vous) |
| GET | `/dashboards/clinical` | `dashboards.clinical.read` | Indicateurs cliniques (consultations, pathologies fréquentes, délais) |
| GET | `/dashboards/financial` | `dashboards.financial.read` | Recettes, créances, caisse |
| GET | `/dashboards/pharmacy-stock` | `dashboards.stock.read` | Ruptures, péremptions, rotations |
| GET | `/dashboards/hr` | `dashboards.hr.read` | Effectifs, absentéisme |
| GET | `/dashboards/me` | auth | Tableau de bord personnel selon le rôle |
| GET | `/reports/catalog` | `reports.read` | Liste des rapports disponibles pour le plan/rôle |
| POST | `/reports/{reportKey}/runs` | `reports.run` | Lance un rapport (paramètres validés) ; 202 + `jobId` |
| GET | `/reports/runs/{runId}` | `reports.read` | Statut |
| GET | `/reports/runs/{runId}/download` | `reports.read` | Résultat (PDF, XLSX, CSV) via URL signée |
| GET | `/reports/scheduled` | `reports.schedule` | Rapports planifiés |
| POST | `/reports/scheduled` | `reports.schedule` | Planifie (cron, destinataires) |
| DELETE | `/reports/scheduled/{id}` | `reports.schedule` | Supprime |
| GET | `/reports/statutory/health-statistics` | `reports.statutory` | États statistiques réglementaires (ministère de la santé, format du pays) |
| GET | `/reports/group/overview` | `reports.group` | Consolidation multi-établissements pour un groupe |

### 4.19 Journal d'audit tenant (`/audit-logs`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/audit-logs` | `audit.read` | Journal d'audit du tenant (filtres : acteur, action, ressource, période, résultat) |
| GET | `/audit-logs/{id}` | `audit.read` | Détail (avant/après masqués selon permission) |
| POST | `/audit-logs/exports` | `audit.export` | Export asynchrone |
| GET | `/audit-logs/security-events` | `audit.security.read` | Connexions échouées, changements de rôles, accès délégués |

### 4.20 Référentiels transverses (`/reference`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/reference/countries` | auth | Pays, indicatifs |
| GET | `/reference/currencies` | auth | Devises supportées et décimales |
| GET | `/reference/icd10` | auth | CIM-10 (voir 4.8) |
| GET | `/reference/drugs` | auth | Médicaments (voir 4.8) |
| GET | `/reference/insurers` | auth | Payeurs nationaux préchargés |
| GET | `/reference/enums` | auth | Énumérations traduites (statuts, types) |

### 4.21 Public (`/public`) — annuaire pour l'app mobile

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/public/app-config` | public | Version minimale d'app, drapeaux de fonctionnalités, pays supportés |
| GET | `/public/establishments` | public | Recherche (filtres : pays, ville, `lat/lng/radiusKm`, type, spécialité, service, assurance acceptée, ouvert maintenant) ; cache CDN |
| GET | `/public/establishments/{tenantSlug}` | public | Fiche détaillée |
| GET | `/public/establishments/{tenantSlug}/sites` | public | Sites et horaires |
| GET | `/public/establishments/{tenantSlug}/services` | public | Services et spécialités |
| GET | `/public/establishments/{tenantSlug}/practitioners` | public | Praticiens publiés (nom, spécialité) |
| GET | `/public/establishments/{tenantSlug}/slots` | public | Créneaux publiés (réservation en ligne activée) |
| GET | `/public/specialties` | public | Référentiel des spécialités |
| GET | `/public/cities` | public | Villes avec établissements |

### 4.22 Patient mobile (`/patient`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| POST | `/patient/auth/register` | public (limité) | Démarre l'inscription (téléphone E.164) ; envoie un OTP SMS |
| POST | `/patient/auth/verify-otp` | public (limité) | Valide l'OTP ; retourne jetons (accès court + refresh rotatif) |
| POST | `/patient/auth/login` | public (limité) | Connexion par OTP (ou PIN selon configuration) |
| POST | `/patient/auth/refresh` | public (refresh) | Rotation |
| POST | `/patient/auth/logout` | patient | Déconnexion |
| GET | `/patient/me` | patient | Profil du compte |
| PATCH | `/patient/me` | patient | Modifie (langue, notifications) |
| DELETE | `/patient/me` | patient | Suppression du compte (droit à l'effacement du compte, hors dossiers médicaux conservés légalement) |
| GET | `/patient/links` | patient | Établissements/dossiers liés |
| POST | `/patient/links` | patient | Lie un dossier via code de liaison remis par l'établissement (consentement enregistré) |
| DELETE | `/patient/links/{linkId}` | patient | Délie un établissement |
| GET | `/patient/appointments` | patient | Mes rendez-vous (tous établissements liés) |
| POST | `/patient/appointments` | patient | Prend rendez-vous (**Idem**) |
| GET | `/patient/appointments/{id}` | patient | Détail |
| POST | `/patient/appointments/{id}/cancel` | patient | Annule (délai minimal configurable) |
| POST | `/patient/appointments/{id}/reschedule` | patient | Reprogramme |
| GET | `/patient/lab-results` | patient | Résultats publiés |
| GET | `/patient/prescriptions` | patient | Ordonnances actives |
| GET | `/patient/invoices` | patient | Factures et reste à payer |
| POST | `/patient/invoices/{invoiceId}/pay` | patient | Initie un paiement Mobile Money (**Idem**) ; retourne l'URL/état de paiement |
| GET | `/patient/payments/{paymentId}` | patient | Statut du paiement (interrogeable, complète les webhooks) |
| GET | `/patient/documents` | patient | Documents partagés |
| GET | `/patient/consents` | patient | Consentements |
| PUT | `/patient/consents/{type}` | patient | Accorde/retire |
| GET | `/patient/notifications` | patient | Notifications |
| POST | `/patient/devices` | patient | Jeton push |
| GET | `/patient/queue-status` | patient | Position dans la file d'un établissement (aussi via WebSocket) |
| POST | `/patient/data-export` | patient | Exporte ses données |

### 4.23 Webhooks entrants (`/webhooks`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| POST | `/webhooks/payments/cinetpay` | signature HMAC | Notification de paiement CinetPay |
| POST | `/webhooks/payments/paydunya` | signature HMAC | Notification PayDunya |
| POST | `/webhooks/payments/flutterwave` | signature (`verif-hash`) | Notification Flutterwave |
| POST | `/webhooks/payments/{provider}/saas` | signature | Paiements d'abonnement SaaS (compte marchand plateforme) |
| POST | `/webhooks/sms/{provider}/delivery-reports` | signature/IP | Accusés de réception SMS |
| POST | `/webhooks/sms/{provider}/inbound` | signature/IP | SMS entrants (réponse OUI/NON à un rappel) |

### 4.24 Intégrations (`/integrations`)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/integrations/api-keys` | `integrations.api_keys.read` | Clés API du tenant (préfixe, scopes, dernière utilisation) |
| POST | `/integrations/api-keys` | `integrations.api_keys.write` | Crée une clé (secret affiché une seule fois ; scopes, expiration, IP autorisées) |
| GET | `/integrations/api-keys/{keyId}` | `integrations.api_keys.read` | Détail |
| PATCH | `/integrations/api-keys/{keyId}` | `integrations.api_keys.write` | Modifie scopes/IP/nom |
| POST | `/integrations/api-keys/{keyId}/rotate` | `integrations.api_keys.write` | Rotation avec période de recouvrement |
| DELETE | `/integrations/api-keys/{keyId}` | `integrations.api_keys.write` | Révoque |
| GET | `/integrations/api-keys/{keyId}/usage` | `integrations.api_keys.read` | Consommation et erreurs |
| GET | `/integrations/webhook-endpoints` | `integrations.webhooks.read` | Endpoints de webhooks sortants |
| POST | `/integrations/webhook-endpoints` | `integrations.webhooks.write` | Crée (URL HTTPS, événements souscrits, secret de signature généré) |
| GET | `/integrations/webhook-endpoints/{endpointId}` | `integrations.webhooks.read` | Détail |
| PATCH | `/integrations/webhook-endpoints/{endpointId}` | `integrations.webhooks.write` | Modifie |
| DELETE | `/integrations/webhook-endpoints/{endpointId}` | `integrations.webhooks.write` | Supprime |
| POST | `/integrations/webhook-endpoints/{endpointId}/rotate-secret` | `integrations.webhooks.write` | Rotation du secret |
| POST | `/integrations/webhook-endpoints/{endpointId}/test` | `integrations.webhooks.write` | Envoie un événement de test |
| GET | `/integrations/webhook-deliveries` | `integrations.webhooks.read` | Historique des livraisons (statut, tentatives, code de réponse) |
| POST | `/integrations/webhook-deliveries/{deliveryId}/redeliver` | `integrations.webhooks.write` | Rejoue une livraison |
| GET | `/integrations/events` | `integrations.webhooks.read` | Catalogue des événements disponibles |
| GET | `/integrations/connectors` | `integrations.read` | Connecteurs préconfigurés (SMS, paiement, assureurs) et état |
| PUT | `/integrations/connectors/{connectorKey}` | `integrations.write` | Configure un connecteur (clés fournisseur chiffrées, jamais renvoyées en clair) |

### 4.25 Santé et exploitation (hors surface métier)

| Méthode | Chemin | Permission | Description |
|---|---|---|---|
| GET | `/health/live` | public (réseau interne) | Liveness |
| GET | `/health/ready` | public (réseau interne) | Readiness (PostgreSQL, Redis, S3) |
| GET | `/metrics` | réseau interne uniquement | Prometheus |
| GET | `/openapi.json` | public (selon environnement) | Spécification OpenAPI 3.1 |
| GET | `/docs` | public (dev/staging) | Interface de documentation |

(`/health`, `/metrics`, `/openapi.json` ne sont pas préfixés par `/api/v1`.)

---

## 5. Temps réel (WebSocket)

### 5.1 Choix

- **Socket.IO** via `@nestjs/websockets` + `@nestjs/platform-socket.io`, sur le même processus que l'API au MVP, avec l'adaptateur **Redis** (`@socket.io/redis-adapter`) pour la montée en charge horizontale.
- Namespace unique `/realtime`. Transport : WebSocket avec repli sur long-polling (réseaux mobiles instables en Afrique francophone, proxys d'entreprise).
- Le temps réel est **un canal de poussée uniquement** : la source de vérité reste l'API REST ; au (re)connexion le client resynchronise par REST. Pas d'écriture métier via WebSocket.

### 5.2 Authentification et autorisation

- Connexion : `io(url, { auth: { token: <JWT d'accès> } })`. Le gateway valide le JWT (même validation que le guard HTTP), rattache `tenantId`, `userId`, permissions.
- Expiration : à l'expiration du JWT, le serveur émet `auth:expiring` ; le client envoie `auth:refresh` avec le nouveau jeton (pas de reconnexion). Révocation de session → déconnexion forcée.
- **Salles (rooms)** : le serveur seul décide des salles auxquelles un socket peut s'abonner ; les demandes `subscribe` sont validées par permission et portée.

| Salle | Format | Contenu | Permission d'abonnement |
|---|---|---|---|
| Tenant | `t:{tenantId}` | Annonces établissement, alertes globales | auth (tenant) |
| Service | `t:{tenantId}:dept:{departmentId}` | Événements d'un service | membre du service ou `queues.read` sur ce service |
| File d'attente | `t:{tenantId}:queue:{queueId}` | Tickets, appels, positions | `queues.read` |
| Utilisateur | `t:{tenantId}:user:{userId}` | Notifications in-app personnelles | automatique |
| Patient (app) | `p:{patientAccountId}` | Position dans la file, résultat disponible, RDV | automatique (jeton patient) |
| Écran d'affichage | `t:{tenantId}:display:{queueId}` | Appels en salle d'attente | jeton d'écran dédié, lecture seule |

Isolation : le nom de salle inclut toujours le `tenantId` issu du JWT, jamais fourni par le client. Les tests d'intégration vérifient qu'un client du tenant A ne peut recevoir aucun message du tenant B.

### 5.3 Événements serveur → client

| Événement | Salle | Charge utile (résumé) |
|---|---|---|
| `queue.ticket_created` | queue | `{ ticketId, number, priority, position }` |
| `queue.ticket_called` | queue, display, patient | `{ ticketId, number, room, practitioner }` |
| `queue.ticket_updated` | queue | statut, priorité, transfert |
| `queue.stats` | queue | `{ waiting, avgWaitSeconds }` (throttlé à 1 par 5 s) |
| `appointment.checked_in` | service | `{ appointmentId, patientName }` (minimisation : pas de donnée clinique) |
| `notification.created` | user | `{ id, type, title, body, link }` |
| `notification.unread_count` | user | `{ count }` |
| `lab_result.ready` | user (prescripteur), patient | `{ orderId }` |
| `stock.alert` | tenant/service | `{ itemId, level }` |
| `bed.status_changed` | service | `{ bedId, status }` |
| `session.revoked` | user | déconnexion forcée |
| `tenant.maintenance` | tenant | annonce de maintenance |

Les charges utiles sont **minimales** (identifiants + champs d'affichage non sensibles) : le client rappelle l'API REST pour le détail, ce qui réapplique les contrôles de permission. Chaque message porte `eventId` et `occurredAt` pour dédupliquer et ordonner.

### 5.4 Événements client → serveur

| Événement | Description |
|---|---|
| `subscribe` `{ room }` | Abonnement à une salle autorisée (accusé ou erreur `forbidden`) |
| `unsubscribe` `{ room }` | Désabonnement |
| `auth:refresh` `{ token }` | Renouvelle l'authentification |
| `ping` | Contrôle applicatif (en plus du heartbeat Socket.IO) |

### 5.5 Résilience

- Reconnexion automatique avec backoff exponentiel + jitter ; à la reconnexion, `GET /notifications?since=…` et `GET /queues/{id}/tickets` resynchronisent l'état.
- **Récupération d'état de connexion** de Socket.IO activée pour les coupures brèves ; au-delà, resynchronisation REST.
- Limites : 5 connexions simultanées par utilisateur, 20 abonnements par socket, 30 messages/min client → serveur.
- Mobile (Expo) : socket uniquement app au premier plan ; en arrière-plan, notifications **push FCM/Expo** et SMS (canal principal fiable).
- Observabilité : métriques Prometheus (connexions, salles, messages/s), traces corrélées par `requestId`.

---

## 6. Webhooks sortants et événements de domaine

### 6.1 Principe

1. Les services métier émettent un **événement de domaine** dans la même transaction que la modification, via une table **`outbox_events`** (garantie « au moins une fois », pas de perte si Redis tombe).
2. Un relais (poller/`LISTEN/NOTIFY`) publie dans BullMQ. Les consommateurs sont indépendants : notifications, temps réel, webhooks sortants, comptabilité (écritures auto), audit analytique.
3. Le consommateur « webhooks sortants » filtre selon les abonnements des `webhook_endpoints` du tenant, construit l'enveloppe signée et livre en HTTP.

### 6.2 Enveloppe d'événement

```json
{
  "id": "evt_01JAB...",
  "type": "appointment.created",
  "apiVersion": "2026-10-01",
  "occurredAt": "2026-10-04T09:30:00.000Z",
  "tenantId": "0192a3b4-...",
  "siteId": "0192a3b4-...",
  "data": {
    "object": { "id": "...", "status": "scheduled", "startsAt": "2026-10-10T08:00:00.000Z" }
  },
  "links": { "resource": "https://api.ghmt.example/api/v1/appointments/..." }
}
```

- `data.object` est **minimal** (identifiants, statuts, dates) : pas de données cliniques dans les webhooks par défaut ; le destinataire récupère le détail via l'API avec sa clé (permissions revérifiées). Un indicateur `includeSensitive` n'existe pas : choix volontaire.
- Les versions de charge utile sont figées par `apiVersion` du endpoint.

### 6.3 Livraison et sécurité

| Aspect | Spécification |
|---|---|
| Transport | HTTPS obligatoire (TLS ≥ 1.2), URL publique uniquement (protection SSRF : refus des IP privées/loopback/metadata cloud, résolution DNS vérifiée à l'envoi) |
| Signature | En-tête `GHMT-Signature: t=<timestamp>,v1=<hmac_sha256(secret, t + "." + corps_brut)>` ; rejet côté destinataire si l'horodatage dépasse 5 min |
| En-têtes | `GHMT-Event-Id`, `GHMT-Event-Type`, `GHMT-Delivery-Id`, `User-Agent: GHMT-Webhooks/1` |
| Succès | Toute réponse `2xx` en moins de 10 s |
| Reprises | Backoff exponentiel : 30 s, 2 min, 10 min, 1 h, 6 h, 24 h (6 tentatives max) |
| Désactivation | Après 50 échecs consécutifs ou 3 jours d'échec : endpoint passé en `disabled`, e-mail à l'administrateur |
| Ordre | Non garanti ; utiliser `occurredAt` et l'`id` pour dédupliquer (livraison au moins une fois) |
| Rejeu | Manuel via `POST /integrations/webhook-deliveries/{id}/redeliver` ; conservation des livraisons 30 jours |
| Secrets | Générés par GHMT, chiffrés au repos, affichés une seule fois, rotation avec double signature pendant 24 h |

### 6.4 Catalogue des événements

Convention : `<ressource>.<verbe_au_passé>`, ressource en `snake_case`.

**Rendez-vous et files**

| Événement | Déclencheur |
|---|---|
| `appointment.created` | Création d'un rendez-vous |
| `appointment.confirmed` | Confirmation (établissement ou patient) |
| `appointment.rescheduled` | Reprogrammation |
| `appointment.cancelled` | Annulation |
| `appointment.checked_in` | Arrivée du patient |
| `appointment.no_show` | Patient absent |
| `appointment.completed` | Rendez-vous terminé |
| `appointment.reminder_due` | Rappel à envoyer (interne, consommé par notifications) |
| `queue.ticket_called` | Patient appelé |

**Patients et dossier médical**

| Événement | Déclencheur |
|---|---|
| `patient.created` | Nouveau dossier patient |
| `patient.updated` | Modification administrative |
| `patient.merged` | Fusion de doublons |
| `patient.consent_changed` | Consentement accordé/retiré |
| `consultation.signed` | Consultation signée |
| `prescription.signed` | Ordonnance signée |
| `prescription.cancelled` | Ordonnance annulée |
| `admission.created` | Admission |
| `admission.discharged` | Sortie |
| `bed.status_changed` | Changement de statut d'un lit |

**Laboratoire**

| Événement | Déclencheur |
|---|---|
| `lab_order.created` | Demande d'examens créée |
| `lab_sample.received` | Échantillon reçu |
| `lab_result.entered` | Résultat saisi |
| `lab_result.validated` | Résultat validé biologiquement |
| `lab_result.amended` | Résultat rectifié |
| `lab_result.critical` | Valeur critique détectée |
| `lab_result.published` | Publié au patient |

**Pharmacie et stocks**

| Événement | Déclencheur |
|---|---|
| `dispensation.completed` | Délivrance effectuée |
| `stock.low` | Stock sous le seuil minimal |
| `stock.out` | Rupture |
| `stock.expiring` | Lot proche de la péremption |
| `stock.movement_recorded` | Mouvement de stock |
| `purchase_order.approved` | Bon de commande approuvé |
| `purchase_order.received` | Réception enregistrée |

**Facturation, paiements, assurance**

| Événement | Déclencheur |
|---|---|
| `invoice.issued` | Facture émise |
| `invoice.cancelled` | Facture annulée (avoir) |
| `invoice.overdue` | Facture en retard de paiement |
| `payment.initiated` | Paiement initié (Mobile Money) |
| `payment.succeeded` | Paiement confirmé |
| `payment.failed` | Paiement échoué/expiré |
| `payment.refunded` | Remboursement |
| `cash_session.closed` | Clôture de caisse |
| `claim.submitted` | Claim soumis |
| `claim.accepted` / `claim.rejected` | Réponse de l'assureur |
| `pre_authorization.decided` | Décision sur prise en charge |

**Utilisateurs, sécurité, SaaS**

| Événement | Déclencheur |
|---|---|
| `user.invited` | Invitation envoyée |
| `user.created` / `user.deactivated` | Cycle de vie |
| `security.login_failed_threshold` | Seuil d'échecs de connexion dépassé |
| `security.delegated_access_started` | Accès délégué plateforme actif |
| `subscription.created` | Abonnement créé |
| `subscription.expiring` | Échéance dans N jours (7, 3, 1) |
| `subscription.expired` | Expiré (passage en période de grâce) |
| `subscription.renewed` | Renouvelé |
| `subscription.suspended` | Suspendu pour impayé |
| `subscription.plan_changed` | Changement de plan |
| `quota.threshold_reached` | Seuil de quota atteint (80 %, 100 %) |
| `tenant.suspended` / `tenant.reactivated` | Statut du tenant (plateforme) |
| `hr.leave_requested` / `hr.leave_decided` | Congés |
| `accounting.period_locked` | Période comptable verrouillée |

Les événements `security.*`, `tenant.*` et `subscription.*` ne sont exposés en webhooks sortants qu'aux administrateurs du tenant concerné (scope `webhooks:manage`).

---

## 7. Documentation OpenAPI et SDK client

### 7.1 Génération de la spécification

- Stack : **`@nestjs/swagger`** (version générant OpenAPI **3.1**) + **`nestjs-zod`** (`createZodDto`, `ZodValidationPipe`, `patchNestJsSwagger()`/`cleanupOpenApiDoc`) pour dériver les schémas JSON de **la même source Zod** que la validation. Zéro duplication DTO/spec.
- Les schémas Zod vivent dans `packages/shared` ; le module Nest ne fait que `createZodDto(PatientCreateSchema)`.
- Décorateurs obligatoires par endpoint : `@ApiTags(module)`, `@ApiOperation({ operationId })` (identifiants stables en `camelCase` : `patientsCreate`), `@ApiBearerAuth()` / `@ApiSecurity('apiKey')`, réponses d'erreur standard (`ProblemDetails`) via un décorateur composite `@ApiStandardErrors()`, extension `x-required-permission`, `x-required-module`, `x-idempotent`.
- Génération au build : un script `pnpm --filter api openapi:generate` écrit `apps/api/openapi/openapi.v1.json` (versionné dans Git). **La CI échoue si le fichier diffère de la génération** (détection de rupture de contrat) et exécute `oasdiff`/`openapi-diff` contre la branche principale pour détecter les changements cassants.
- Découpage de la documentation par audience, générée en trois documents : `tenant` (par défaut), `platform` (interne), `public-integration` (clés API + webhooks, publié sur le portail développeurs). Les endpoints sont inclus/exclus par tag.
- `/docs` (Scalar ou Swagger UI) exposé en dev/staging ; en production, seule la documentation d'intégration est publique.
- Exemples : chaque schéma Zod porte `.meta({ examples })`/`describe()` afin d'alimenter les exemples de la spec (et les tests de contrat).

### 7.2 SDK client TypeScript généré

- Package `packages/api-client` (publié en interne, éventuellement npm pour les intégrateurs) généré depuis `openapi.v1.json` avec **`@hey-api/openapi-ts`** (ou `orval`), produisant :
  - types TypeScript, fonctions client typées par `operationId` ;
  - validation optionnelle des réponses avec les schémas Zod partagés (activée en dev/test, désactivée en production mobile pour la performance) ;
  - hooks **TanStack Query** (`@tanstack/react-query`) pour web/desktop/mobile.
- Couche manuelle mince au-dessus (`packages/api-client/src/runtime`) :
  - injection du jeton, **rafraîchissement automatique** sur 401 (file d'attente unique pour éviter les refresh concurrents) ;
  - ajout automatique de `Idempotency-Key` sur les opérations marquées `x-idempotent`, **conservée entre les reprises** ;
  - gestion de `ETag`/`If-Match` (cache de version par ressource) ;
  - mapping `problem+json` → classe `ApiError` typée (`code`, `status`, `errors[]`, `requestId`) ;
  - en-têtes `Accept-Language`, `X-Client-Version`, `X-Site-Id` ;
  - retries avec backoff uniquement sur les requêtes idempotentes (GET, PUT, ou POST avec clé) ;
  - file d'attente **hors-ligne** (desktop Tauri et mobile) : mutations stockées localement avec leur clé d'idempotence, rejouées au retour du réseau.
- Régénération : tâche Turborepo `generate:api-client` dépendante de `openapi:generate`, exécutée avant le build des applications ; le SDK est versionné avec l'API (semver mineur pour ajouts, majeur pour `v2`).
- Variantes : `@ghmt/api-client` (tenant), `@ghmt/api-client-patient` (surface patient pour Expo, plus léger), `@ghmt/api-client-platform` (console plateforme). SDK d'intégration public (clés API) généré à partir de la spec `public-integration`.
- Tests de contrat : Schemathesis (ou Dredd) en CI contre l'API de test pour vérifier que les réponses respectent la spec.

---

## 8. GraphQL : position

**Décision : pas de GraphQL pour le MVP.** Éventuel **BFF GraphQL de reporting en lecture seule** ultérieurement (phase 3+), sans remplacer REST.

Justification :

| Critère | Analyse |
|---|---|
| Cohérence des décisions | `00-decisions.md` fige REST + OpenAPI 3.1 ; une seconde surface double la dette de sécurité, de tests et de documentation |
| Sécurité et RBAC | Les permissions par route, la portée site/service, l'audit par action et la RLS se mappent naturellement sur des endpoints. En GraphQL, l'autorisation au niveau de chaque champ/résolveur, la profondeur de requêtes et l'explosion de coût demandent une infrastructure supplémentaire (limiteurs de complexité, persisted queries) |
| Audit de données de santé | Les accès doivent être tracés par ressource consultée ; une requête GraphQL composée complique la traçabilité précise « qui a lu quoi » |
| Réseaux instables / mobiles d'entrée de gamme | REST avec `fields=`, `include=`, ETag, cache HTTP/CDN et `If-None-Match` répond au besoin d'économie de bande passante ; le cache HTTP standard est difficile en GraphQL (POST) |
| Idempotence, ETag, rate limiting par plan | Mécanismes HTTP natifs, directs en REST |
| Équipe et délai | Un seul paradigme à maîtriser ; SDK généré OpenAPI déjà prévu |
| Sur-/sous-récupération | Atténuée par projection, expansion et endpoints agrégés « vue » (`/patients/{id}/summary`, `/dashboards/*`) |

**Réévaluation** : si des besoins de reporting croisés (analytique multi-modules, tableaux de bord à agrégations libres, consolidation de groupe) dépassent les endpoints agrégés, ajouter un **BFF GraphQL séparé, en lecture seule**, adossé à des **vues matérialisées / réplica de lecture**, avec : authentification identique (JWT), RLS conservée, limite de profondeur et de coût, requêtes persistées uniquement, audit par requête, quotas dédiés. Il resterait optionnel et non utilisé pour les écritures.

---

## 9. Limitation de débit et quotas par plan

### 9.1 Deux mécanismes distincts

| Mécanisme | Objet | Fenêtre | Réponse |
|---|---|---|---|
| **Rate limiting** (débit) | Protéger la plateforme contre abus et pics | secondes/minutes | `429 rate_limited` + `Retry-After` |
| **Quotas** (consommation du plan) | Appliquer l'offre commerciale (sites, utilisateurs, stockage, SMS, appels API) | jour/mois/volume total | `403 quota_exceeded` (ou `429` pour quotas à fenêtre d'appel) avec `limit`, `used`, `resetAt` |

### 9.2 Implémentation

- Rate limiting : `@nestjs/throttler` avec stockage **Redis** (`@nest-lab/throttler-storage-redis`), algorithme à fenêtre glissante / token bucket, clés composées : `ip`, `user:{id}`, `tenant:{id}`, `apikey:{id}`.
- Les limites par défaut dépendent de la **surface** et du **plan du tenant** (lues depuis un cache Redis du plan, invalidé sur `subscription.plan_changed`).
- En-têtes renvoyés (draft IETF `RateLimit`) : `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, et `Retry-After` en `429`.
- Quotas : compteurs Redis (`INCRBY`) synchronisés périodiquement en base (`usage_counters`), autorité = base ; vérification dans un guard `QuotaGuard` (décorateur `@ConsumesQuota('sms', 1)`) et dans les services pour les quotas d'inventaire (nombre de sites/utilisateurs vérifié en base à la création).
- Seuils d'alerte : événement `quota.threshold_reached` à 80 % et 100 %, notification à l'administrateur du tenant.
- Dépassement : **jamais de coupure de soins** — les actions cliniques critiques (consultation, admission, résultats, urgence) ne sont pas bloquées par un quota commercial ; seuls les services périphériques (SMS en masse, exports, appels API d'intégration, stockage) le sont, avec période de grâce.

### 9.3 Limites de débit par surface (valeurs initiales, configurables)

| Surface / endpoint | Clé | Limite |
|---|---|---|
| `POST /auth/login`, `/auth/login/2fa` | IP + identifiant | 5 / min / identifiant, 20 / min / IP ; verrouillage progressif du compte après 10 échecs |
| `POST /auth/password/forgot` | IP + identifiant | 3 / 15 min |
| `POST /patient/auth/register`, OTP | IP + téléphone | 3 OTP / 15 min / numéro, 10 / h / IP (coût SMS) |
| `/public/*` | IP | 60 / min (cache CDN en amont) |
| `/api/v1/*` utilisateur authentifié | user | 300 / min (rafales 60 / 10 s) |
| Écritures (`POST/PUT/PATCH/DELETE`) | user | 120 / min |
| Exports/rapports | tenant | 10 / h simultanés ≤ 3 |
| `/patient/*` | compte patient | 120 / min |
| `/webhooks/*` entrants | IP fournisseur | 600 / min (liste blanche) |
| `/platform/*` | admin | 300 / min |
| WebSocket | utilisateur | 5 connexions, 30 msg / min |

### 9.4 Limites et quotas par plan

Valeurs indicatives (la source de vérité commerciale est `05-saas-notifications.md` ; ici le mapping technique). `∞` = illimité sous politique d'usage raisonnable.

| Dimension | Essai (14 j) | Starter (cabinet / centre de santé) | Pro (clinique) | Enterprise (hôpital / groupe) |
|---|---|---|---|---|
| Débit API utilisateur (req/min) | 120 | 300 | 600 | 1 200 (personnalisable) |
| Débit par tenant (req/min) | 600 | 1 500 | 6 000 | 30 000 |
| Accès API d'intégration (clés API) | non | 1 clé, lecture seule | 5 clés | 50 clés |
| Quota d'appels API intégration / mois | — | 10 000 | 500 000 | 10 M |
| Débit par clé API (req/min) | — | 60 | 300 | 1 200 |
| Webhooks sortants (endpoints) | 0 | 1 | 5 | 25 |
| Utilisateurs | 5 | 10 | 50 | ∞ (contractuel) |
| Sites | 1 | 1 | 3 | ∞ (contractuel) |
| SMS inclus / mois | 50 | 300 | 3 000 | contractuel (pré-payé) |
| Stockage fichiers | 1 Go | 10 Go | 100 Go | contractuel |
| Taille max d'un fichier | 10 Mo | 25 Mo | 50 Mo | 100 Mo |
| Exports/rapports asynchrones / jour | 5 | 20 | 100 | 500 |
| Connexions WebSocket simultanées | 10 | 30 | 150 | 1 000 |
| Rapports planifiés | 0 | 3 | 20 | 100 |

Comportements de dépassement :

- **Rate limit** : `429`, rejouable après `Retry-After` ; les SDK appliquent un backoff automatique.
- **Quota SMS** : après épuisement, les rappels de rendez-vous basculent vers push/in-app ; l'achat de crédits supplémentaires est proposé (Mobile Money). Les SMS d'authentification (OTP, 2FA) restent prioritaires.
- **Quota utilisateurs/sites** : création refusée (`403 quota_exceeded`, `meta` indiquant la mise à niveau possible).
- **Stockage** : nouveaux envois refusés ; lecture et téléchargement restent possibles.
- **Abonnement expiré** : période de grâce (7 jours, lecture/écriture complètes avec bandeau), puis lecture seule 30 jours, puis suspension (`403 subscription_suspended` ; données conservées, export possible).

### 9.5 Protection complémentaire

- Limites de taille de corps (JSON 1 Mo ; webhooks entrants 256 Ko ; fichiers via URL pré-signée).
- Timeouts serveur par route (30 s par défaut ; traitements longs en asynchrone `202`).
- Plafond de pagination (`limit` ≤ 100) et de profondeur d'`include`.
- Détection d'abus (scraping de l'annuaire public, énumération de patients) : alertes Prometheus et blocage temporaire par IP/clé.
- `helmet`, CORS en liste blanche par surface (origines web de la console, schémas d'app Tauri/Expo), `Cache-Control: no-store` sur toutes les réponses authentifiées.

---

## 10. Exemples de requêtes et réponses

Les identifiants sont abrégés pour la lisibilité. Les en-têtes non essentiels sont omis. Tous les exemples utilisent l'enveloppe du § 2.2.

### 10.1 Login avec 2FA

**Étape 1 — identifiants**

```http
POST /api/v1/auth/login HTTP/1.1
Host: api.ghmt.example
Content-Type: application/json
Accept-Language: fr
X-Client-Version: web/1.0.0

{
  "email": "dr.diallo@clinique-almadies.sn",
  "password": "M0t-de-passe-Tres-Solide!",
  "tenantSlug": "clinique-almadies",
  "device": { "name": "Chrome / Windows", "platform": "web" }
}
```

Réponse (2FA requise) :

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
X-Request-Id: 01JB8Z3K1Q9X2M7V5N4T6R8W0A

{
  "success": true,
  "data": {
    "mfaRequired": true,
    "mfaToken": "mfa_eyJhbGciOiJFZERTQSJ9...",
    "mfaTokenExpiresInSeconds": 300,
    "methods": ["totp", "backup_code"]
  },
  "error": null,
  "meta": {
    "requestId": "01JB8Z3K1Q9X2M7V5N4T6R8W0A",
    "timestamp": "2026-10-04T09:30:00.000Z"
  }
}
```

Le `tenantSlug` sert uniquement à lever l'ambiguïté d'une adresse e-mail présente dans plusieurs établissements ; le tenant est ensuite scellé dans le JWT.

**Étape 2 — code TOTP**

```http
POST /api/v1/auth/login/2fa HTTP/1.1
Content-Type: application/json

{
  "mfaToken": "mfa_eyJhbGciOiJFZERTQSJ9...",
  "method": "totp",
  "code": "482913",
  "trustDevice": false
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJFZERTQSIsImtpZCI6IjIwMjYtMTAifQ...",
    "accessTokenExpiresInSeconds": 900,
    "refreshToken": "rt_7Qx2mV9...opaque...",
    "refreshTokenExpiresAt": "2026-11-03T09:30:12.000Z",
    "sessionId": "0192b5c1-7a31-7c2e-9f10-3d4e5a6b7c8d",
    "user": {
      "id": "0192a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
      "firstName": "Aminata",
      "lastName": "Diallo",
      "email": "dr.diallo@clinique-almadies.sn",
      "locale": "fr",
      "roles": [
        { "id": "0192a3b4-0001-7000-8000-000000000001", "key": "doctor", "scope": { "type": "site", "id": "0192a3b4-0002-7000-8000-000000000002" } }
      ],
      "mustChangePassword": false
    },
    "tenant": {
      "id": "0192a3b4-0000-7000-8000-000000000000",
      "slug": "clinique-almadies",
      "name": "Clinique des Almadies",
      "timezone": "Africa/Dakar",
      "defaultCurrency": "XOF",
      "modules": ["patients", "appointments", "consultations", "lab", "pharmacy", "billing"]
    }
  },
  "error": null,
  "meta": { "requestId": "01JB8Z3N...", "timestamp": "2026-10-04T09:30:12.000Z" }
}
```

Code incorrect :

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json

{
  "type": "https://api.ghmt.example/problems/invalid_mfa_code",
  "title": "Invalid verification code",
  "status": 401,
  "code": "invalid_mfa_code",
  "detail": "Le code de vérification est incorrect ou expiré. Il vous reste 4 tentatives.",
  "instance": "/api/v1/auth/login/2fa",
  "requestId": "01JB8Z3P...",
  "remainingAttempts": 4
}
```

### 10.2 Création d'un patient

```http
POST /api/v1/patients HTTP/1.1
Authorization: Bearer eyJhbGciOiJFZERTQSIs...
X-Site-Id: 0192a3b4-0002-7000-8000-000000000002
Content-Type: application/json
Accept-Language: fr

{
  "firstName": "Moussa",
  "lastName": "Traoré",
  "sex": "male",
  "birthDate": "1988-03-14",
  "birthDateIsEstimated": false,
  "phone": "+22507123456",
  "email": null,
  "address": {
    "line1": "Quartier Cocody Riviera 3",
    "city": "Abidjan",
    "country": "CI"
  },
  "nationalId": { "type": "cni", "number": "CI0012345678" },
  "bloodGroup": "O+",
  "emergencyContact": { "name": "Fatoumata Traoré", "relationship": "spouse", "phone": "+22507654321" },
  "preferredLocale": "fr",
  "consents": [
    { "type": "data_processing", "granted": true },
    { "type": "sms_reminders", "granted": true }
  ],
  "insurance": {
    "payerId": "0192a3b4-1111-7000-8000-000000000011",
    "memberNumber": "MUT-884201",
    "validUntil": "2027-06-30"
  }
}
```

```http
HTTP/1.1 201 Created
Location: /api/v1/patients/0192b6d2-2a4b-7f10-8c3d-9e0f1a2b3c4d
ETag: "patient-0192b6d2-v1"
Content-Type: application/json

{
  "success": true,
  "data": {
    "id": "0192b6d2-2a4b-7f10-8c3d-9e0f1a2b3c4d",
    "medicalRecordNumber": "P-2026-004217",
    "firstName": "Moussa",
    "lastName": "Traoré",
    "sex": "male",
    "birthDate": "1988-03-14",
    "ageYears": 38,
    "phone": "+22507123456",
    "email": null,
    "address": { "line1": "Quartier Cocody Riviera 3", "city": "Abidjan", "country": "CI" },
    "bloodGroup": "O+",
    "status": "active",
    "primaryInsurance": {
      "payerId": "0192a3b4-1111-7000-8000-000000000011",
      "payerName": "Mutuelle Santé CI",
      "memberNumber": "MUT-884201",
      "validUntil": "2027-06-30"
    },
    "createdAt": "2026-10-04T09:42:10.512Z",
    "updatedAt": "2026-10-04T09:42:10.512Z",
    "createdBy": "0192a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
    "version": 1
  },
  "error": null,
  "meta": {
    "requestId": "01JB8Z4A...",
    "timestamp": "2026-10-04T09:42:10.520Z",
    "warnings": []
  }
}
```

Doublon suspecté (même téléphone, nom et date de naissance proches) :

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://api.ghmt.example/problems/patient_duplicate_suspected",
  "title": "Possible duplicate patient",
  "status": 409,
  "code": "patient_duplicate_suspected",
  "detail": "Un patient très proche existe déjà. Vérifiez avant de créer un nouveau dossier.",
  "instance": "/api/v1/patients",
  "requestId": "01JB8Z4B...",
  "candidates": [
    { "id": "0192a0aa-...", "medicalRecordNumber": "P-2025-001873", "fullName": "Moussa Traoré", "birthDate": "1988-03-14", "score": 0.97 }
  ],
  "hint": "Renvoyez la requête avec \"forceCreate\": true si vous disposez de la permission patients.create_duplicate."
}
```

### 10.3 Création d'un rendez-vous

```http
POST /api/v1/appointments HTTP/1.1
Authorization: Bearer eyJhbGciOiJFZERTQSIs...
Idempotency-Key: 5b1f2d3e-8c4a-4f6b-9a7d-2e1c0b9a8f77
Content-Type: application/json

{
  "patientId": "0192b6d2-2a4b-7f10-8c3d-9e0f1a2b3c4d",
  "practitionerId": "0192a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
  "departmentId": "0192a3b4-0003-7000-8000-000000000003",
  "siteId": "0192a3b4-0002-7000-8000-000000000002",
  "appointmentTypeId": "0192a3b4-0004-7000-8000-000000000004",
  "startsAt": "2026-10-10T08:30:00.000Z",
  "endsAt": "2026-10-10T09:00:00.000Z",
  "reason": "Consultation de suivi - hypertension",
  "channel": "front_desk",
  "reminders": { "sms": true, "pushIfAvailable": true },
  "estimatedFee": { "amount": "10000", "currency": "XOF" }
}
```

```http
HTTP/1.1 201 Created
Location: /api/v1/appointments/0192b7e4-9d10-7a3c-b1e2-4f5a6b7c8d9e
ETag: "appointment-0192b7e4-v1"
Content-Type: application/json

{
  "success": true,
  "data": {
    "id": "0192b7e4-9d10-7a3c-b1e2-4f5a6b7c8d9e",
    "reference": "RDV-2026-010382",
    "status": "scheduled",
    "patient": { "id": "0192b6d2-2a4b-7f10-8c3d-9e0f1a2b3c4d", "fullName": "Moussa Traoré", "phone": "+22507123456" },
    "practitioner": { "id": "0192a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b", "fullName": "Dr Aminata Diallo", "specialty": "Cardiologie" },
    "department": { "id": "0192a3b4-0003-7000-8000-000000000003", "name": "Cardiologie" },
    "site": { "id": "0192a3b4-0002-7000-8000-000000000002", "name": "Site Almadies", "timezone": "Africa/Dakar" },
    "startsAt": "2026-10-10T08:30:00.000Z",
    "endsAt": "2026-10-10T09:00:00.000Z",
    "reason": "Consultation de suivi - hypertension",
    "channel": "front_desk",
    "estimatedFee": { "amount": "10000", "currency": "XOF" },
    "confirmation": { "status": "pending", "requestedVia": ["sms"], "expiresAt": "2026-10-09T08:30:00.000Z" },
    "createdAt": "2026-10-04T09:50:03.100Z",
    "version": 1
  },
  "error": null,
  "meta": { "requestId": "01JB8Z5C...", "timestamp": "2026-10-04T09:50:03.115Z", "warnings": [] }
}
```

Rejeu avec la même `Idempotency-Key` : même corps de réponse, statut `201`, avec l'en-tête `Idempotent-Replayed: true`.

Créneau déjà pris :

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://api.ghmt.example/problems/slot_unavailable",
  "title": "Slot no longer available",
  "status": 409,
  "code": "slot_unavailable",
  "detail": "Ce créneau vient d'être réservé. Choisissez un autre horaire.",
  "instance": "/api/v1/appointments",
  "requestId": "01JB8Z5D...",
  "alternatives": [
    { "startsAt": "2026-10-10T09:00:00.000Z", "endsAt": "2026-10-10T09:30:00.000Z" },
    { "startsAt": "2026-10-10T09:30:00.000Z", "endsAt": "2026-10-10T10:00:00.000Z" }
  ]
}
```

### 10.4 Erreur de permission

Un agent d'accueil tente de signer une consultation.

```http
POST /api/v1/consultations/0192b8f0-1111-7000-8000-00000000aaaa/sign HTTP/1.1
Authorization: Bearer eyJhbGciOiJFZERTQSIs...
If-Match: "consultation-0192b8f0-v3"
Accept-Language: fr
```

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json
Content-Language: fr
X-Request-Id: 01JB8Z6E7F8G9H0J1K2M3N4P5Q

{
  "type": "https://api.ghmt.example/problems/permission_denied",
  "title": "Permission denied",
  "status": 403,
  "code": "permission_denied",
  "detail": "Vous n'avez pas l'autorisation de signer une consultation. Contactez l'administrateur de votre établissement si vous pensez que c'est une erreur.",
  "instance": "/api/v1/consultations/0192b8f0-1111-7000-8000-00000000aaaa/sign",
  "requestId": "01JB8Z6E7F8G9H0J1K2M3N4P5Q",
  "requiredPermission": "consultations.sign",
  "docs": "https://docs.ghmt.example/errors/permission_denied"
}
```

Remarques : le refus est **audité** (action, acteur, permission manquante). La réponse ne dit pas si la consultation existe : un identifiant d'un autre tenant donnerait un `404 not_found`. Module non activé :

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{
  "type": "https://api.ghmt.example/problems/module_not_enabled",
  "title": "Module not enabled",
  "status": 403,
  "code": "module_not_enabled",
  "detail": "Le module Laboratoire n'est pas activé pour votre abonnement.",
  "instance": "/api/v1/lab/orders",
  "requestId": "01JB8Z6F...",
  "module": "lab",
  "upgradeUrl": "https://app.ghmt.example/settings/subscription"
}
```

### 10.5 Erreur de validation

```http
POST /api/v1/patients HTTP/1.1
Authorization: Bearer eyJhbGciOiJFZERTQSIs...
Content-Type: application/json
Accept-Language: fr

{
  "firstName": "",
  "lastName": "Traoré",
  "sex": "m",
  "birthDate": "14/03/1988",
  "phone": "0707",
  "address": { "country": "Côte d'Ivoire" }
}
```

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
Content-Language: fr

{
  "type": "https://api.ghmt.example/problems/validation_failed",
  "title": "Validation failed",
  "status": 422,
  "code": "validation_failed",
  "detail": "La requête contient 5 champs invalides.",
  "instance": "/api/v1/patients",
  "requestId": "01JB8Z7G...",
  "errors": [
    {
      "path": "firstName",
      "code": "too_small",
      "message": "Le prénom est obligatoire.",
      "params": { "minimum": 1 }
    },
    {
      "path": "sex",
      "code": "invalid_enum_value",
      "message": "Valeur invalide. Valeurs acceptées : male, female, other, unknown.",
      "params": { "options": ["male", "female", "other", "unknown"] }
    },
    {
      "path": "birthDate",
      "code": "invalid_format",
      "message": "La date doit être au format AAAA-MM-JJ.",
      "params": { "format": "YYYY-MM-DD" }
    },
    {
      "path": "phone",
      "code": "invalid_phone",
      "message": "Le numéro doit être au format international E.164 (ex. +22507123456)."
    },
    {
      "path": "address.country",
      "code": "invalid_country",
      "message": "Utilisez un code pays ISO 3166-1 alpha-2 (ex. CI)."
    }
  ]
}
```

Dans le mode enveloppé (`Accept: application/json`, défaut des SDK), le même contenu est livré sous `error`, avec `success: false`, `data: null` :

```json
{
  "success": false,
  "data": null,
  "error": {
    "type": "https://api.ghmt.example/problems/validation_failed",
    "title": "Validation failed",
    "status": 422,
    "code": "validation_failed",
    "detail": "La requête contient 5 champs invalides.",
    "instance": "/api/v1/patients",
    "errors": [ { "path": "firstName", "code": "too_small", "message": "Le prénom est obligatoire." } ]
  },
  "meta": { "requestId": "01JB8Z7G...", "timestamp": "2026-10-04T09:55:40.210Z" }
}
```

Autres erreurs fréquentes (formes abrégées) :

```json
// 412 — conflit de version
{ "code": "precondition_failed", "status": 412,
  "detail": "La ressource a été modifiée par un autre utilisateur. Rechargez-la puis réappliquez vos changements.",
  "currentVersion": 4, "currentEtag": "\"patient-0192b6d2-v4\"" }

// 429 — débit
{ "code": "rate_limited", "status": 429,
  "detail": "Trop de requêtes. Réessayez dans 12 secondes.", "retryAfterSeconds": 12 }

// 403 — quota de plan
{ "code": "quota_exceeded", "status": 403,
  "detail": "Le nombre maximal d'utilisateurs de votre plan (10) est atteint.",
  "quota": "users", "limit": 10, "used": 10, "resetAt": null }
```

---

## Annexe — Points ouverts et décisions à confirmer

| # | Sujet | Proposition |
|---|---|---|
| 1 | Forme de l'erreur : enveloppe vs problem+json nu | Enveloppe par défaut (`Accept: application/json`), problem+json nu pour `Accept: application/problem+json` ; à confirmer côté SDK |
| 2 | Granularité des permissions du catalogue | Les codes listés ici sont indicatifs ; `04-securite-rbac-audit.md` et `packages/shared/permissions.ts` font foi, ce document doit être aligné à la validation du catalogue |
| 3 | Périmètre exposé aux clés API | Sous-ensemble marqué 🔑 ; extension par scope sur demande de clients Enterprise |
| 4 | Synchronisation hors-ligne desktop | Endpoints dédiés `/sync/pull` et `/sync/push` (changements par curseur de version) à spécifier en phase 3 |
| 5 | Intégrations assureurs nationaux | Connecteurs à définir par pays ; interface `/integrations/connectors` générique |
| 6 | Rétention des clés d'idempotence et des livraisons webhook | 24 h / 30 jours proposés |
