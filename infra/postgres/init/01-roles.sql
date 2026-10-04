-- Rôles PostgreSQL GHMT (DEV UNIQUEMENT : mots de passe à remplacer via secrets en prod)
-- ghmt_migrator : propriétaire du schéma, exécute les migrations Prisma.
-- ghmt_app      : rôle applicatif, SANS BYPASSRLS, soumis aux politiques RLS.
CREATE ROLE ghmt_migrator LOGIN PASSWORD 'ghmt_migrator_dev' NOBYPASSRLS;
CREATE ROLE ghmt_app      LOGIN PASSWORD 'ghmt_app_dev'      NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE ghmt TO ghmt_app, ghmt_migrator;
GRANT ALL ON SCHEMA public TO ghmt_migrator;
GRANT USAGE ON SCHEMA public TO ghmt_app;

-- Les tables créées par le migrator sont accessibles en DML par l'app (jamais en DDL).

-- ghmt_platform : console super-admin, CRUD sur le schéma platform, AUCUN accès au schéma tenant.
CREATE ROLE ghmt_platform LOGIN PASSWORD 'ghmt_platform_dev' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE ghmt TO ghmt_platform;

-- Le migrator crée les schémas platform/tenant et les extensions « trusted » (citext, pgcrypto, btree_gist, pg_trgm).
GRANT CREATE ON DATABASE ghmt TO ghmt_migrator;
-- DEV UNIQUEMENT : base fantôme de `prisma migrate dev`.
ALTER ROLE ghmt_migrator CREATEDB;
