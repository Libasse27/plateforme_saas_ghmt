-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Inscription vérifiée et slugs réservés (phase durcissement sécurité, équipe OPS)
-- Référence : docs/11-phase-durcissement-securite.md §3.2 (D12, D13). Exécutée par ghmt_migrator.
-- Ne référence aucune table de l'équipe AUTH.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Vérification d'inscription : jeton à usage unique, seule l'empreinte SHA-256 est stockée ─────────
CREATE TABLE "tenant"."signup_verifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_verifications_pkey" PRIMARY KEY ("tenant_id","id")
);

CREATE UNIQUE INDEX "signup_verifications_tenant_id_token_hash_key" ON "tenant"."signup_verifications"("tenant_id", "token_hash");
-- Jetons encore valides d'un utilisateur (invalidation au renvoi) et purge par échéance : index SQL seul.
CREATE INDEX ix_signup_verifications_open ON tenant.signup_verifications (tenant_id, user_id) WHERE consumed_at IS NULL;
CREATE INDEX ix_signup_verifications_expires ON tenant.signup_verifications (tenant_id, expires_at);

ALTER TABLE tenant.signup_verifications
  ADD CONSTRAINT fk_signup_verifications_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.signup_verifications
  ADD CONSTRAINT signup_verifications_tenant_id_user_id_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant.users (tenant_id, id) ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── 2. Isolation et privilèges (même boucle que 20261004000200 : toute table tenant présente) ─────────
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

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.signup_verifications TO ghmt_app;
REVOKE ALL ON tenant.signup_verifications FROM ghmt_platform;

-- ───────── 3. Slugs réservés (D13) ─────────
-- Liste exacte ; les préfixes (xn--, ghmt) sont codés dans platform.is_reserved_slug. Même contenu que
-- RESERVED_TENANT_SLUGS de @ghmt/shared (vérifié par test/onboarding/signup-migration.e2e-spec.ts).
CREATE TABLE platform.reserved_slugs (
  slug   text PRIMARY KEY CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'),
  reason text NOT NULL
);
-- Lecture par les seules fonctions SECURITY DEFINER ci-dessous : aucun droit pour ghmt_app
-- (ghmt_platform conserve les droits par défaut du schéma platform).
REVOKE ALL ON platform.reserved_slugs FROM PUBLIC;
REVOKE ALL ON platform.reserved_slugs FROM ghmt_app;

INSERT INTO platform.reserved_slugs (slug, reason) VALUES
  ('www', 'réservé : identifiant de la plateforme'),
  ('api', 'réservé : identifiant de la plateforme'),
  ('app', 'réservé : identifiant de la plateforme'),
  ('admin', 'réservé : identifiant de la plateforme'),
  ('administration', 'réservé : identifiant de la plateforme'),
  ('plateforme', 'réservé : identifiant de la plateforme'),
  ('platform', 'réservé : identifiant de la plateforme'),
  ('console', 'réservé : identifiant de la plateforme'),
  ('support', 'réservé : identifiant de la plateforme'),
  ('aide', 'réservé : identifiant de la plateforme'),
  ('help', 'réservé : identifiant de la plateforme'),
  ('status', 'réservé : identifiant de la plateforme'),
  ('statut', 'réservé : identifiant de la plateforme'),
  ('mail', 'réservé : identifiant de la plateforme'),
  ('smtp', 'réservé : identifiant de la plateforme'),
  ('imap', 'réservé : identifiant de la plateforme'),
  ('static', 'réservé : identifiant de la plateforme'),
  ('assets', 'réservé : identifiant de la plateforme'),
  ('cdn', 'réservé : identifiant de la plateforme'),
  ('docs', 'réservé : identifiant de la plateforme'),
  ('blog', 'réservé : identifiant de la plateforme'),
  ('auth', 'réservé : identifiant de la plateforme'),
  ('login', 'réservé : identifiant de la plateforme'),
  ('connexion', 'réservé : identifiant de la plateforme'),
  ('inscription', 'réservé : identifiant de la plateforme'),
  ('signup', 'réservé : identifiant de la plateforme'),
  ('compte', 'réservé : identifiant de la plateforme'),
  ('account', 'réservé : identifiant de la plateforme'),
  ('billing', 'réservé : identifiant de la plateforme'),
  ('facturation', 'réservé : identifiant de la plateforme'),
  ('paiement', 'réservé : identifiant de la plateforme'),
  ('payment', 'réservé : identifiant de la plateforme'),
  ('security', 'réservé : identifiant de la plateforme'),
  ('securite', 'réservé : identifiant de la plateforme'),
  ('dev', 'réservé : identifiant de la plateforme'),
  ('staging', 'réservé : identifiant de la plateforme'),
  ('preprod', 'réservé : identifiant de la plateforme'),
  ('prod', 'réservé : identifiant de la plateforme'),
  ('test', 'réservé : identifiant de la plateforme'),
  ('demo', 'réservé : identifiant de la plateforme'),
  ('sandbox', 'réservé : identifiant de la plateforme'),
  ('internal', 'réservé : identifiant de la plateforme'),
  ('system', 'réservé : identifiant de la plateforme'),
  ('root', 'réservé : identifiant de la plateforme'),
  ('null', 'réservé : identifiant de la plateforme'),
  ('undefined', 'réservé : identifiant de la plateforme');

-- Contrôle interne (liste exacte ou préfixe) : exécuté uniquement depuis les fonctions SECURITY DEFINER.
CREATE FUNCTION platform.is_reserved_slug(p_slug text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM platform.reserved_slugs r WHERE r.slug = lower(btrim(p_slug)))
      OR lower(btrim(p_slug)) LIKE 'xn--%'
      OR lower(btrim(p_slug)) LIKE 'ghmt%'
$$;
REVOKE ALL ON FUNCTION platform.is_reserved_slug(text) FROM PUBLIC;

-- État d'un identifiant d'établissement : 'reserved' | 'taken' (même pour un tenant supprimé) | 'available'.
CREATE FUNCTION platform.slug_status(p_slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp AS $$
  SELECT CASE
    WHEN platform.is_reserved_slug(p_slug) THEN 'reserved'
    WHEN EXISTS (SELECT 1 FROM platform.tenants t WHERE t.slug = p_slug) THEN 'taken'
    ELSE 'available'
  END
$$;
REVOKE ALL ON FUNCTION platform.slug_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.slug_status(text) TO ghmt_app;

-- ───────── 4. register_tenant : statut initial (active | pending) et refus des slugs réservés ─────────
DROP FUNCTION platform.register_tenant(text, text, text, platform.establishment_type, char, char, text, text[]);
CREATE FUNCTION platform.register_tenant(
  p_slug text,
  p_legal_name text,
  p_trade_name text,
  p_type platform.establishment_type,
  p_country char(2),
  p_currency char(3),
  p_timezone text,
  p_modules text[],
  p_status platform.tenant_status DEFAULT 'active'
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_slug !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' OR length(p_slug) NOT BETWEEN 3 AND 48 THEN
    RAISE EXCEPTION 'invalid slug' USING ERRCODE = '22023';
  END IF;
  IF platform.is_reserved_slug(p_slug) THEN
    RAISE EXCEPTION 'reserved slug' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'pending') THEN
    RAISE EXCEPTION 'invalid initial status' USING ERRCODE = '22023';
  END IF;
  INSERT INTO platform.tenants (id, slug, legal_name, trade_name, establishment_type, status,
                                country_code, base_currency, timezone, updated_at)
  VALUES (v_id, p_slug, p_legal_name, p_trade_name, p_type, p_status,
          p_country, p_currency, p_timezone, now());

  INSERT INTO platform.tenant_modules (tenant_id, module_code)
  SELECT v_id, m.code FROM platform.modules m
  WHERE m.is_core OR m.code = ANY (p_modules);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION platform.register_tenant(text, text, text, platform.establishment_type, char, char, text, text[], platform.tenant_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.register_tenant(text, text, text, platform.establishment_type, char, char, text, text[], platform.tenant_status) TO ghmt_app;

-- ───────── 5. Activation du tenant courant après vérification de l'e-mail (D12) ─────────
-- Le tenant est lu dans le contexte (jamais en paramètre) ; seule la transition pending → active est possible.
CREATE FUNCTION platform.activate_pending_tenant() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp AS $$
DECLARE v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN RETURN false; END IF;
  UPDATE platform.tenants
     SET status = 'active', updated_at = now()
   WHERE id = v_tenant AND status = 'pending' AND deleted_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION platform.activate_pending_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.activate_pending_tenant() TO ghmt_app;
