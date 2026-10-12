-- docs/13 §3.2, D9 : rôle de sauvegarde logique `ghmt_backup` (pg_dump -Fc), LECTURE SEULE.
--
-- Le rôle lui-même N'EST PAS créé ici : `ghmt_migrator` n'a pas CREATEROLE, et seul un superutilisateur (ou un rôle
-- lui-même BYPASSRLS) peut attribuer BYPASSRLS. Il est créé par l'administrateur de la base, avec son mot de passe,
-- AVANT cette migration :
--   dev et CI : infra/postgres/init/01-roles.sql ;
--   production (base gérée) : runbook de infra/deploy/README.md (« Rôle ghmt_backup »), mot de passe dans le secret
--   `backup_database_url`, jamais dans une migration.
-- Cette migration vérifie ses attributs et lui accorde SELECT, sans aucune écriture. Elle est idempotente (GRANT et
-- ALTER DEFAULT PRIVILEGES peuvent être rejoués). CONNECT sur la base : accordé par défaut à PUBLIC (sinon, par
-- l'administrateur de la base : `ghmt_migrator` n'en est pas propriétaire).

DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'ghmt_backup';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rôle ghmt_backup absent : le créer en superutilisateur avant la migration (LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE, voir infra/deploy/README.md)';
  END IF;
  IF NOT r.rolbypassrls THEN
    RAISE EXCEPTION 'ghmt_backup doit avoir BYPASSRLS (sinon pg_dump échoue sur les tables à RLS forcée)';
  END IF;
  IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication THEN
    RAISE EXCEPTION 'ghmt_backup doit être NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION';
  END IF;
END
$$;

-- Schémas : USAGE seul (jamais CREATE).
GRANT USAGE ON SCHEMA platform, tenant TO ghmt_backup;
GRANT USAGE ON SCHEMA public TO ghmt_backup;

-- Tables existantes (dont public._prisma_migrations, nécessaire à `prisma migrate status` après restauration)
-- et séquences : SELECT seul. Sur une séquence, USAGE ou UPDATE permettraient nextval/setval : non accordés.
GRANT SELECT ON ALL TABLES IN SCHEMA platform, tenant, public TO ghmt_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA platform, tenant, public TO ghmt_backup;

-- Tables et séquences futures créées par le propriétaire des migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE ghmt_migrator IN SCHEMA platform, tenant, public GRANT SELECT ON TABLES TO ghmt_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE ghmt_migrator IN SCHEMA platform, tenant, public GRANT SELECT ON SEQUENCES TO ghmt_backup;
