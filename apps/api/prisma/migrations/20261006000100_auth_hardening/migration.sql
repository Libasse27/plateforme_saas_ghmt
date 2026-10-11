-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Durcissement sécurité, équipe AUTH (docs/11-phase-durcissement-securite.md §3.1)
-- Réinitialisation de mot de passe, code e-mail d'enrôlement MFA, réseaux de confiance, politique de sécurité,
-- administrateur principal, dernière activité. Exécutée par ghmt_migrator.
-- Le DDL des sections 1 est issu de `prisma migrate diff` (security.prisma + User.lastSeenAt) ; le reste (clés étrangères
-- composites, CHECK, RLS, trigger, rattrapage) est complété en SQL : aucune relation Prisma entre fichiers.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Tables et colonne (prisma migrate diff) ─────────
-- AlterTable
ALTER TABLE "tenant"."users" ADD COLUMN     "last_seen_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "tenant"."password_reset_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "requested_ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."mfa_email_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_email_codes_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."trusted_networks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "network" INET NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "site_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "trusted_networks_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."security_settings" (
    "tenant_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "clinical_mfa_mode" TEXT NOT NULL DEFAULT 'off_network',
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE INDEX "password_reset_tokens_tenant_id_expires_at_idx" ON "tenant"."password_reset_tokens"("tenant_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tenant_id_token_hash_key" ON "tenant"."password_reset_tokens"("tenant_id", "token_hash");


-- ───────── 2. Clés étrangères (composites : (tenant_id, id) du socle) ─────────
ALTER TABLE tenant.password_reset_tokens
  ADD CONSTRAINT fk_password_reset_tokens_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id),
  ADD CONSTRAINT fk_password_reset_tokens_user FOREIGN KEY (tenant_id, user_id) REFERENCES tenant.users (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE tenant.mfa_email_codes
  ADD CONSTRAINT fk_mfa_email_codes_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id),
  ADD CONSTRAINT fk_mfa_email_codes_user FOREIGN KEY (tenant_id, user_id) REFERENCES tenant.users (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_mfa_email_codes_session FOREIGN KEY (tenant_id, session_id) REFERENCES tenant.sessions (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE tenant.trusted_networks
  ADD CONSTRAINT fk_trusted_networks_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id),
  ADD CONSTRAINT fk_trusted_networks_site FOREIGN KEY (tenant_id, site_id) REFERENCES tenant.sites (tenant_id, id),
  ADD CONSTRAINT fk_trusted_networks_created_by FOREIGN KEY (tenant_id, created_by) REFERENCES tenant.users (tenant_id, id);
ALTER TABLE tenant.security_settings
  ADD CONSTRAINT fk_security_settings_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id),
  ADD CONSTRAINT fk_security_settings_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant.users (tenant_id, id),
  ADD CONSTRAINT fk_security_settings_updated_by FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant.users (tenant_id, id);

-- ───────── 3. Contraintes ─────────
ALTER TABLE tenant.password_reset_tokens ADD CONSTRAINT ck_password_reset_tokens_attempts CHECK (attempts >= 0);
ALTER TABLE tenant.mfa_email_codes ADD CONSTRAINT ck_mfa_email_codes_attempts CHECK (attempts >= 0);
ALTER TABLE tenant.security_settings
  ADD CONSTRAINT ck_security_settings_mode CHECK (clinical_mfa_mode IN ('off_network', 'always'));
-- Plage réseau : préfixe minimal /16 (IPv4) ou /32 (IPv6), et forme réseau normalisée (bits d'hôte à zéro).
ALTER TABLE tenant.trusted_networks
  ADD CONSTRAINT ck_trusted_networks_prefix CHECK (masklen(network) >= CASE family(network) WHEN 4 THEN 16 ELSE 32 END),
  ADD CONSTRAINT ck_trusted_networks_normalized CHECK (network = set_masklen(network(network)::inet, masklen(network)));

-- ───────── 4. Index ─────────
CREATE INDEX ix_password_reset_tokens_pending ON tenant.password_reset_tokens (tenant_id, user_id) WHERE consumed_at IS NULL;
CREATE INDEX ix_mfa_email_codes_session ON tenant.mfa_email_codes (tenant_id, session_id, created_at DESC);
CREATE INDEX ix_mfa_email_codes_expires ON tenant.mfa_email_codes (tenant_id, expires_at);
CREATE UNIQUE INDEX uq_trusted_networks_active ON tenant.trusted_networks (tenant_id, network) WHERE deleted_at IS NULL;
-- Purge planifiée (docs/11 D16) : ix_sessions_purge (tenant_id, expires_at) existe déjà.
CREATE INDEX ix_sessions_revoked ON tenant.sessions (tenant_id, revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX ix_refresh_tokens_expires ON tenant.refresh_tokens (tenant_id, expires_at);

-- ───────── 5. Isolation (même politique que 20261004000200, limitée aux tables de cette migration) ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['password_reset_tokens', 'mfa_email_codes', 'trusted_networks', 'security_settings'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE tenant.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON tenant.%I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON tenant.%I AS PERMISSIVE FOR ALL
      USING (tenant_id = (SELECT tenant.current_tenant_id()))
      WITH CHECK (tenant_id = (SELECT tenant.current_tenant_id()))$p$, t);
  END LOOP;
END $$;
-- ghmt_app : DML par les privilèges par défaut du schéma tenant ; ghmt_platform n'a aucun accès au schéma tenant.
REVOKE ALL ON tenant.password_reset_tokens, tenant.mfa_email_codes, tenant.trusted_networks, tenant.security_settings FROM ghmt_platform;

-- ───────── 6. Administrateur principal (docs/11 D9) ─────────
-- Posé à la première affectation `tenant_admin` portée par l'établissement. Exécuté par l'appelant (RLS respectée).
-- Une ligne existante sans principal (politique modifiée avant toute affectation) reçoit le principal.
CREATE OR REPLACE FUNCTION tenant.ensure_tenant_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant, pg_temp AS $$
BEGIN
  IF NEW.scope_type = 'tenant' AND EXISTS (
    SELECT 1 FROM tenant.roles r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.role_id AND r.is_system AND r.template_code = 'tenant_admin'
  ) THEN
    INSERT INTO tenant.security_settings (tenant_id, owner_user_id) VALUES (NEW.tenant_id, NEW.user_id)
    ON CONFLICT (tenant_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, updated_at = now()
    WHERE tenant.security_settings.owner_user_id IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_role_assignments_ensure_owner
  AFTER INSERT ON tenant.user_role_assignments FOR EACH ROW EXECUTE FUNCTION tenant.ensure_tenant_owner();

-- ───────── 7. Rattrapage des établissements existants ─────────
-- Principal = utilisateur actif de l'affectation `tenant_admin` (portée établissement, non révoquée) la plus ancienne ;
-- le verrou dur de connexion est abandonné (docs/11 D3) : locked_until est remis à NULL (colonne conservée).
-- Le RLS est FORCE : le contexte tenant est posé tenant par tenant (portée transaction) puis restauré.
DO $$
DECLARE
  v_previous text := current_setting('app.tenant_id', true);
  v_tenant uuid;
BEGIN
  FOR v_tenant IN SELECT id FROM platform.tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    INSERT INTO tenant.security_settings (tenant_id, owner_user_id)
    SELECT v_tenant, a.user_id
    FROM tenant.user_role_assignments a
    JOIN tenant.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
    JOIN tenant.users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id
    WHERE a.tenant_id = v_tenant AND a.scope_type = 'tenant' AND a.revoked_at IS NULL
      AND r.is_system AND r.template_code = 'tenant_admin' AND r.deleted_at IS NULL
      AND u.status = 'active' AND u.deleted_at IS NULL
    ORDER BY a.created_at, a.id
    LIMIT 1
    ON CONFLICT (tenant_id) DO NOTHING;
    UPDATE tenant.user_credentials SET locked_until = NULL WHERE tenant_id = v_tenant AND locked_until IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(v_previous, ''), true);
END $$;
