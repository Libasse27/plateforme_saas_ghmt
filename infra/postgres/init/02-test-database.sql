-- Base des tests automatisés (DEV et CI UNIQUEMENT) : mêmes rôles et mêmes droits que la base `ghmt` (01-roles.sql).
-- Exécuté seulement à la création du volume ; sur un volume existant : psql -U ghmt_owner -d ghmt -f 02-test-database.sql
CREATE DATABASE ghmt_test OWNER ghmt_owner;
GRANT CONNECT ON DATABASE ghmt_test TO ghmt_app, ghmt_migrator, ghmt_platform;
GRANT CREATE ON DATABASE ghmt_test TO ghmt_migrator;

\connect ghmt_test
GRANT ALL ON SCHEMA public TO ghmt_migrator;
GRANT USAGE ON SCHEMA public TO ghmt_app;
