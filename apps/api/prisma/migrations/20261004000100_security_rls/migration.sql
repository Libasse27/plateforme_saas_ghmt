-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Isolation multi-tenant (RLS), privilèges, fonctions et contraintes
-- Référence : docs/02-modele-donnees.md §4 à §6, docs/04-securite-rbac-audit.md §4.
-- Exécutée par ghmt_migrator (propriétaire). ghmt_app n'est jamais propriétaire.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Privilèges de schéma ─────────
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
REVOKE ALL ON SCHEMA tenant   FROM PUBLIC;
GRANT USAGE ON SCHEMA tenant   TO ghmt_app;
GRANT USAGE ON SCHEMA platform TO ghmt_app, ghmt_platform;

-- ghmt_app : DML sur le schéma tenant uniquement (pas de TRUNCATE, pas de DDL)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenant TO ghmt_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ghmt_migrator IN SCHEMA tenant
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ghmt_app;

-- Journal d'audit : ajout seul
REVOKE UPDATE, DELETE ON tenant.audit_logs FROM ghmt_app;

-- ghmt_app : lecture seule des référentiels plateforme ; jamais tenants/abonnements
GRANT SELECT ON platform.permissions, platform.modules TO ghmt_app;

-- ghmt_platform : CRUD sur platform, aucun accès à tenant
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO ghmt_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE ghmt_migrator IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ghmt_platform;
REVOKE ALL ON ALL TABLES IN SCHEMA tenant FROM ghmt_platform;

-- ───────── 2. Contexte tenant (fail closed) ─────────
CREATE OR REPLACE FUNCTION tenant.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
-- Sans app.tenant_id : NULL ⇒ aucune ligne visible, aucune écriture.

-- ───────── 3. RLS ENABLE + FORCE sur chaque table du schéma tenant ─────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'tenant' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON tenant.%I', r.relname);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON tenant.%I AS PERMISSIVE FOR ALL
      USING (tenant_id = (SELECT tenant.current_tenant_id()))
      WITH CHECK (tenant_id = (SELECT tenant.current_tenant_id()))$p$, r.relname);
  END LOOP;
END $$;
-- Note : la politique s'applique à tous les rôles (PUBLIC), y compris le propriétaire grâce à FORCE.

-- ───────── 4. Numérotation séquentielle par tenant (docs/02 §6) ─────────
CREATE OR REPLACE FUNCTION tenant.next_sequence(p_scope text, p_period text DEFAULT '')
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid := (SELECT tenant.current_tenant_id());
  v_value  bigint;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501'; END IF;
  INSERT INTO tenant.sequence_counters AS c (tenant_id, scope_key, period_key, last_value)
  VALUES (v_tenant, p_scope, p_period, 1)
  ON CONFLICT (tenant_id, scope_key, period_key)
  DO UPDATE SET last_value = c.last_value + 1, updated_at = now()
  RETURNING last_value INTO v_value;
  RETURN v_value;
END $$;
REVOKE ALL ON FUNCTION tenant.next_sequence(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant.next_sequence(text, text) TO ghmt_app;
GRANT EXECUTE ON FUNCTION tenant.current_tenant_id() TO ghmt_app;

-- ───────── 5. Fonctions SECURITY DEFINER étroites (accès contrôlé à platform) ─────────
-- Résolution du tenant par slug, avant authentification.
CREATE OR REPLACE FUNCTION platform.resolve_tenant(p_slug text)
RETURNS TABLE (id uuid, status platform.tenant_status, base_currency char(3), timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
  SELECT t.id, t.status, t.base_currency, t.timezone
  FROM platform.tenants t
  WHERE t.slug = p_slug AND t.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION platform.resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.resolve_tenant(text) TO ghmt_app;

-- Modules actifs du tenant courant (le tenant est lu dans le contexte, jamais en paramètre).
CREATE OR REPLACE FUNCTION platform.current_tenant_modules()
RETURNS TABLE (module_code text, tenant_status platform.tenant_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
  SELECT tm.module_code, t.status
  FROM platform.tenants t
  JOIN platform.tenant_modules tm ON tm.tenant_id = t.id
  WHERE t.id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND t.deleted_at IS NULL
    AND tm.disabled_at IS NULL
$$;
REVOKE ALL ON FUNCTION platform.current_tenant_modules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.current_tenant_modules() TO ghmt_app;

-- Inscription self-service d'un établissement (onboarding). Crée le tenant et active les modules
-- demandés parmi le catalogue. Appelée dans la même transaction que la création des données tenant.
CREATE OR REPLACE FUNCTION platform.register_tenant(
  p_slug text,
  p_legal_name text,
  p_trade_name text,
  p_type platform.establishment_type,
  p_country char(2),
  p_currency char(3),
  p_timezone text,
  p_modules text[]
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_slug !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' OR length(p_slug) NOT BETWEEN 3 AND 48 THEN
    RAISE EXCEPTION 'invalid slug' USING ERRCODE = '22023';
  END IF;
  INSERT INTO platform.tenants (id, slug, legal_name, trade_name, establishment_type, status,
                                country_code, base_currency, timezone, updated_at)
  VALUES (v_id, p_slug, p_legal_name, p_trade_name, p_type, 'active', p_country, p_currency, p_timezone, now());

  INSERT INTO platform.tenant_modules (tenant_id, module_code)
  SELECT v_id, m.code FROM platform.modules m
  WHERE m.is_core OR m.code = ANY (p_modules);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION platform.register_tenant(text, text, text, platform.establishment_type, char, char, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.register_tenant(text, text, text, platform.establishment_type, char, char, text, text[]) TO ghmt_app;

-- ───────── 6. Audit : ajout seul, même pour le propriétaire ─────────
CREATE OR REPLACE FUNCTION tenant.forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON tenant.audit_logs
  FOR EACH ROW EXECUTE FUNCTION tenant.forbid_audit_mutation();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON tenant.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION tenant.forbid_audit_mutation();

-- ───────── 7. Contraintes métier non exprimables en Prisma ─────────
-- Portée d'affectation : scope_id obligatoire sauf pour la portée établissement.
ALTER TABLE tenant.user_role_assignments
  ADD CONSTRAINT ck_assignment_scope
  CHECK ((scope_type = 'tenant' AND scope_id IS NULL) OR (scope_type <> 'tenant' AND scope_id IS NOT NULL));

-- FK composites optionnelles (MATCH SIMPLE : ignorées si la colonne est NULL)
ALTER TABLE tenant.departments
  ADD CONSTRAINT fk_departments_parent FOREIGN KEY (tenant_id, parent_id) REFERENCES tenant.departments (tenant_id, id);
ALTER TABLE tenant.practitioners
  ADD CONSTRAINT fk_practitioners_user FOREIGN KEY (tenant_id, user_id) REFERENCES tenant.users (tenant_id, id),
  ADD CONSTRAINT fk_practitioners_department FOREIGN KEY (tenant_id, department_id) REFERENCES tenant.departments (tenant_id, id),
  ADD CONSTRAINT fk_practitioners_site FOREIGN KEY (tenant_id, primary_site_id) REFERENCES tenant.sites (tenant_id, id);
ALTER TABLE tenant.patients
  ADD CONSTRAINT fk_patients_primary_site FOREIGN KEY (tenant_id, primary_site_id) REFERENCES tenant.sites (tenant_id, id);

-- Rendez-vous : bornes cohérentes et aucun chevauchement pour un même praticien.
ALTER TABLE tenant.appointments
  ADD CONSTRAINT ck_appointments_range CHECK (ends_at > starts_at),
  ADD COLUMN time_range tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED;
ALTER TABLE tenant.appointments
  ADD CONSTRAINT ex_appointments_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, practitioner_id WITH =, time_range WITH &&
  ) WHERE (status NOT IN ('cancelled', 'no_show') AND deleted_at IS NULL);

-- Recherche patient (trigram)
CREATE INDEX ix_patients_search_name ON tenant.patients USING gin (search_name gin_trgm_ops);

-- ───────── 8. Référentiel des modules ─────────
INSERT INTO platform.modules (code, name, is_core, description) VALUES
  ('iam',           'Utilisateurs et droits',        true,  'Utilisateurs, rôles, permissions, sessions'),
  ('org',           'Organisation',                  true,  'Établissement, sites, services'),
  ('settings',      'Paramètres',                    true,  'Paramètres de l’établissement'),
  ('audit',         'Journal d’audit',               true,  'Traçabilité des accès et modifications'),
  ('reports',       'Tableaux de bord',              true,  'Tableaux de bord et rapports'),
  ('patients',      'Patients',                      true,  'Identification et dossier administratif'),
  ('appointments',  'Rendez-vous',                   false, 'Agendas, rendez-vous, files d’attente'),
  ('consultations', 'Consultations / DME',           false, 'Consultations, diagnostics, prescriptions'),
  ('nursing',       'Soins infirmiers',              false, 'Plans de soins, constantes'),
  ('maternity',     'Maternité',                     false, 'Suivi de grossesse, accouchements'),
  ('inpatient',     'Hospitalisation',               false, 'Admissions, lits, sorties'),
  ('laboratory',    'Laboratoire',                   false, 'Demandes, prélèvements, résultats'),
  ('imaging',       'Imagerie',                      false, 'Demandes et comptes rendus'),
  ('pharmacy',      'Pharmacie',                     false, 'Médicaments, dispensation, ventes'),
  ('inventory',     'Stocks',                        false, 'Produits, commandes, inventaires'),
  ('billing',       'Facturation et assurance',      false, 'Factures, tarifs, prises en charge'),
  ('cashier',       'Caisse',                        false, 'Encaissements, sessions de caisse'),
  ('accounting',    'Comptabilité SYSCOHADA',        false, 'Écritures, journaux, états financiers'),
  ('hr',            'Ressources humaines',           false, 'Personnel, plannings, congés, paie'),
  ('breakglass',    'Accès d’urgence',               true,  'Bris de glace clinique')
ON CONFLICT (code) DO NOTHING;
