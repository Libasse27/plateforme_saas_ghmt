-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Invitations d'utilisateurs (C6) et profil de l'établissement (A8)
-- Référence : docs/08-correctifs-revues.md. Exécutée par ghmt_migrator.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Invitations : jeton à usage unique, seule l'empreinte SHA-256 est stockée ─────────
CREATE TABLE "tenant"."invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("tenant_id","id")
);

CREATE UNIQUE INDEX "invitations_tenant_id_token_hash_key" ON "tenant"."invitations"("tenant_id", "token_hash");
CREATE INDEX "invitations_tenant_id_user_id_idx" ON "tenant"."invitations"("tenant_id", "user_id");

ALTER TABLE "tenant"."invitations"
  ADD CONSTRAINT "invitations_tenant_id_user_id_fkey"
  FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant"."users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── 2. Isolation et privilèges (même boucle que 20261004000100 : toute table tenant présente) ─────────
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

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.invitations TO ghmt_app;
REVOKE ALL ON tenant.invitations FROM ghmt_platform;

-- ───────── 3. Profil de l'établissement courant (fonction SECURITY DEFINER étroite) ─────────
-- Le tenant est lu dans le contexte (jamais en paramètre) ; seules les colonnes utiles au client sont exposées.
CREATE OR REPLACE FUNCTION platform.current_tenant_profile()
RETURNS TABLE (id uuid, slug text, name text, timezone text, country_code char(2), base_currency char(3))
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
  SELECT t.id, t.slug, COALESCE(t.trade_name, t.legal_name), t.timezone, t.country_code, t.base_currency
  FROM platform.tenants t
  WHERE t.id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND t.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION platform.current_tenant_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.current_tenant_profile() TO ghmt_app;
