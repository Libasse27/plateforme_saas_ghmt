# GHMT — Plateforme SaaS de gestion hospitalière

Plateforme **multi-tenant, multi-utilisateur et modulaire** permettant à des établissements de santé
(hôpitaux N1-N3, centres, cliniques, cabinets, laboratoires, pharmacies…) d'Afrique francophone de créer
et gérer leur propre système d'information hospitalier, avec une isolation stricte des données.

## Dossier de conception (`docs/`)
| Document | Contenu |
|---|---|
| [00-decisions](docs/00-decisions.md) | Décisions structurantes (stack, multi-tenant, marché) |
| [01-architecture](docs/01-architecture.md) | Architecture générale, multi-tenant, modules, Web/Desktop/Mobile, fichiers, déploiement, ADR |
| [02-modele-donnees](docs/02-modele-donnees.md) | Modèle de données par domaine, RLS, indexation, numérotation |
| [03-api](docs/03-api.md) | Conventions REST, pipeline, endpoints par module, temps réel, webhooks |
| [04-securite-rbac-audit](docs/04-securite-rbac-audit.md) | Authentification, MFA, RBAC à portées, audit, chiffrement, sauvegardes, conformité |
| [05-saas-notifications](docs/05-saas-notifications.md) | Plans, quotas, Mobile Money, licences, onboarding, notifications |
| [06-roadmap-mvp](docs/06-roadmap-mvp.md) | Phases, MVP, backlog, versions suivantes |
| [07-conventions-dev](docs/07-conventions-dev.md) | Contrat du noyau API et règles pour ajouter un module |
| [08-correctifs-revues](docs/08-correctifs-revues.md) | Correctifs des revues sécurité / santé / contrat, contrats API modifiés |

## Structure
```
apps/api         API NestJS (monolithe modulaire, Prisma, PostgreSQL RLS)
apps/web         Console web établissement (Next.js, BFF à cookies httpOnly)
packages/shared  Catalogue de permissions, modèles de rôles, schémas Zod
infra/           docker-compose de développement, rôles PostgreSQL
docs/            conception
```

## Démarrage rapide
```bash
corepack enable pnpm            # ou pnpm installé
pnpm install
pnpm infra:up                   # PostgreSQL 17, Redis, MinIO, Mailpit
cd apps/api && cp .env.example .env   # renseigner les secrets (commandes openssl indiquées)
pnpm prisma:generate && pnpm prisma:deploy && node prisma/seed.mts
pnpm dev                        # API : http://localhost:3000/api/v1/health
pnpm test                       # tests (base ghmt_test)
```

## Principes de sécurité appliqués dans le code
- **Isolation des tenants en profondeur** : tenant issu du JWT uniquement → transaction `SET LOCAL app.tenant_id`
  → **Row-Level Security PostgreSQL forcée** sur toutes les tables, rôle applicatif sans `BYPASSRLS`.
- **RBAC à portées** (établissement / site / service), refus par défaut, double contrôle par module souscrit, MFA imposée par rôle.
- **Audit append-only chaîné** (SHA-256) écrit dans la même transaction que l'action ; lectures de dossiers patients tracées.
- **Chiffrement applicatif** des données identifiantes (AES-256-GCM lié au tenant) + index aveugles HMAC.
- Argon2id, JWT 15 min, refresh tokens rotatifs avec détection de réutilisation, sessions révocables.
