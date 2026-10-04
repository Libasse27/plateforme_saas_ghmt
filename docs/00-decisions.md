# 00 — Décisions structurantes (socle commun)

> Document de référence. Tous les autres documents de conception doivent s'y conformer.
> Nom de code produit : **GHMT** (plateforme SaaS de gestion hospitalière multi-tenant).

## Contexte
- SaaS multi-tenant, multi-utilisateur, modulaire, pour établissements de santé (hôpitaux niveaux 1-3, centres médicalisés, centres de santé, cliniques, cabinets, laboratoires, pharmacies, centres de diagnostic, centres spécialisés…).
- Marché cible : **Afrique francophone** (Sénégal, Côte d'Ivoire, Cameroun, RDC, Bénin, Togo, Burkina, Mali, Gabon…).
  - Connectivité instable → Desktop avec mode hors-ligne, payloads légers, mobile Android d'entrée de gamme prioritaire.
  - Paiement : **Mobile Money** (Orange Money, MTN MoMo, Moov, Wave) via agrégateurs (CinetPay, PayDunya, Flutterwave), + virement/espèces.
  - Devises : XOF, XAF, CDF, USD (multi-devise par tenant).
  - SMS comme canal principal de rappel (fournisseurs interchangeables).
  - Lois nationales de protection des données personnelles (CDP Sénégal, ARTCI Côte d'Ivoire, loi camerounaise de 2024…) + Convention de Malabo. Données de santé = données sensibles.
  - Comptabilité : référentiel **SYSCOHADA révisé** (OHADA).
  - Langues : français par défaut, anglais ; extensible.

## Choix techniques validés
| Domaine | Choix |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Langage | TypeScript partout |
| API | **NestJS 12** (monolithe modulaire, un module Nest par module métier), REST + OpenAPI 3.1, versionnée `/api/v1` |
| ORM / BDD | **Prisma** + **PostgreSQL 17** |
| Multi-tenant | **Base partagée, colonne `tenant_id` sur toutes les tables métier + Row-Level Security PostgreSQL** (`SET LOCAL app.tenant_id` par transaction, rôle applicatif sans BYPASSRLS). Option future : base dédiée pour clients Enterprise. |
| Cache / files de tâches | Redis 7 + BullMQ |
| Web | Next.js (App Router) + Tailwind + shadcn/ui + TanStack Query |
| Desktop | Tauri 2 réutilisant l'app web, cache SQLite local + synchronisation (phase ultérieure) |
| Mobile patients | Expo (React Native) |
| Validation / contrats | Zod partagé dans `packages/shared` |
| Auth | Maison dans NestJS : Argon2id, JWT d'accès court (15 min) + refresh token rotatif opaque, TOTP 2FA, sessions révocables |
| Fichiers | Stockage objet S3-compatible (MinIO en dev), URLs signées |
| Notifications | Service interne + workers BullMQ, fournisseurs : SMTP, SMS (adapter), FCM/Expo push, in-app (WebSocket) |
| Observabilité | Pino (logs JSON), OpenTelemetry, Prometheus/Grafana, Sentry |
| Déploiement | Docker Compose (MVP) → Kubernetes (montée en charge) |

## Hiérarchie organisationnelle
`Plateforme → Groupe (optionnel) → Établissement (= tenant) → Site → Service → Utilisateurs`
- Le **tenant** est l'établissement (ou le groupe s'il souscrit en tant que groupe) : c'est la frontière d'isolation des données et de facturation SaaS.
- Les permissions sont attribuées avec une **portée** : groupe, établissement, site ou service.
- Le Super Administrateur n'accède aux données d'un tenant que via un **accès délégué explicite, limité dans le temps et audité** (« break-glass »).

## Structure du dépôt
```
apps/api        NestJS
apps/web        Next.js (console plateforme + console établissement)
apps/desktop    Tauri (phase 3)
apps/mobile     Expo patients (phase 2)
packages/shared schémas Zod, catalogue de permissions, types
packages/config eslint/tsconfig partagés
docs/           conception
infra/          docker-compose, k8s, scripts de sauvegarde
```

## Documents de conception
| Fichier | Contenu |
|---|---|
| 01-architecture.md | Architecture générale, multi-tenant, web/desktop/mobile, fichiers, déploiement, recommandations techno |
| 02-modele-donnees.md | Modèle de données, tables principales, relations, politiques RLS |
| 03-api.md | Architecture API, conventions, endpoints |
| 04-securite-rbac-audit.md | Authentification, 2FA, RBAC, modèle de permissions, rôles, audit, sauvegardes, sécurité |
| 05-saas-notifications.md | Abonnements, plans, quotas, facturation SaaS, notifications |
| 06-roadmap-mvp.md | Phases, MVP, versions suivantes |
