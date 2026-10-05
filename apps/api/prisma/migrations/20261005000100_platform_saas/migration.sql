-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Équipe A (docs/09 §A) : realm plateforme, plans, abonnements, factures SaaS.
-- Tables du schéma platform : accessibles à ghmt_platform ; ghmt_app n'y accède QUE par les
-- fonctions SECURITY DEFINER étroites de la section 7 (tenant lu dans le contexte).
-- Partie 1 : DDL généré par `prisma migrate diff` (base+core → base+core+platform-saas).
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "platform"."platform_role" AS ENUM ('super_admin', 'support', 'billing');

-- CreateEnum
CREATE TYPE "platform"."platform_user_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "platform"."subscription_status" AS ENUM ('trial', 'active', 'past_due', 'grace', 'suspended', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "platform"."billing_period" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "platform"."plan_tier" AS ENUM ('basic', 'standard', 'professional', 'enterprise');

-- CreateEnum
CREATE TYPE "platform"."saas_invoice_status" AS ENUM ('draft', 'open', 'paid', 'void', 'uncollectible');

-- CreateEnum
CREATE TYPE "platform"."saas_invoice_kind" AS ENUM ('renewal', 'conversion', 'upgrade_prorata');

-- CreateEnum
CREATE TYPE "platform"."manual_payment_status" AS ENUM ('pending', 'validated', 'rejected');

-- CreateEnum
CREATE TYPE "platform"."manual_payment_method" AS ENUM ('bank_transfer', 'cash_reseller', 'cheque', 'other');

-- CreateTable
CREATE TABLE "platform"."platform_users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "platform"."platform_role" NOT NULL,
    "status" "platform"."platform_user_status" NOT NULL DEFAULT 'active',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "mfa_secret_enc" BYTEA,
    "mfa_last_used_step" BIGINT,
    "mfa_backup_code_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mfa_activated_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "user_agent" TEXT,
    "ip" INET,
    "mfa_verified_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,

    CONSTRAINT "platform_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_mfa_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "user_agent" TEXT,
    "ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."audit_logs" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "tenant_id" UUID,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "ip" INET,
    "request_id" TEXT,
    "changes" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "tier" "platform"."plan_tier" NOT NULL,
    "price_monthly" DECIMAL(18,2) NOT NULL,
    "price_yearly" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "entitlements" JSONB NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "platform"."subscription_status" NOT NULL,
    "billing_period" "platform"."billing_period" NOT NULL DEFAULT 'monthly',
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "trial_ends_at" TIMESTAMPTZ(6),
    "trial_extended" BOOLEAN NOT NULL DEFAULT false,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "pending_plan_id" UUID,
    "pending_billing_period" "platform"."billing_period",
    "overrides" JSONB,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "manual_suspension_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."billing_entities" (
    "id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "legal_name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "tax_rate" DECIMAL(6,4) NOT NULL,
    "tax_id" TEXT,
    "legal_mentions" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "billing_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."saas_invoice_counters" (
    "country_code" CHAR(2) NOT NULL,
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saas_invoice_counters_pkey" PRIMARY KEY ("country_code","year")
);

-- CreateTable
CREATE TABLE "platform"."saas_invoices" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "status" "platform"."saas_invoice_status" NOT NULL DEFAULT 'open',
    "kind" "platform"."saas_invoice_kind" NOT NULL,
    "billing_period" "platform"."billing_period" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "tax_rate" DECIMAL(6,4) NOT NULL,
    "tax_amount" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "paid_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "payment_channel" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saas_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."saas_invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "saas_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."manual_payments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" "platform"."manual_payment_method" NOT NULL,
    "reference" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "platform"."manual_payment_status" NOT NULL DEFAULT 'pending',
    "entered_by" UUID NOT NULL,
    "validated_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform"."platform_users"("email");

-- CreateIndex
CREATE INDEX "platform_sessions_user_id_idx" ON "platform"."platform_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_refresh_tokens_token_hash_key" ON "platform"."platform_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "platform_refresh_tokens_session_id_idx" ON "platform"."platform_refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "platform_refresh_tokens_family_id_idx" ON "platform"."platform_refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_mfa_challenges_token_hash_key" ON "platform"."platform_mfa_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "platform_mfa_challenges_user_id_idx" ON "platform"."platform_mfa_challenges"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "platform"."audit_logs"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "platform"."audit_logs"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_occurred_at_idx" ON "platform"."audit_logs"("actor_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_version_key" ON "platform"."plans"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "platform"."subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "platform"."subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "billing_entities_country_code_key" ON "platform"."billing_entities"("country_code");

-- CreateIndex
CREATE UNIQUE INDEX "saas_invoices_number_key" ON "platform"."saas_invoices"("number");

-- CreateIndex
CREATE INDEX "saas_invoices_tenant_id_issued_at_idx" ON "platform"."saas_invoices"("tenant_id", "issued_at" DESC);

-- CreateIndex
CREATE INDEX "saas_invoices_status_due_at_idx" ON "platform"."saas_invoices"("status", "due_at");

-- CreateIndex
CREATE INDEX "saas_invoices_subscription_id_idx" ON "platform"."saas_invoices"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "saas_invoice_lines_invoice_id_position_key" ON "platform"."saas_invoice_lines"("invoice_id", "position");

-- CreateIndex
CREATE INDEX "manual_payments_invoice_id_idx" ON "platform"."manual_payments"("invoice_id");

-- CreateIndex
CREATE INDEX "manual_payments_status_idx" ON "platform"."manual_payments"("status");

-- AddForeignKey
ALTER TABLE "platform"."platform_sessions" ADD CONSTRAINT "platform_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform"."platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_refresh_tokens" ADD CONSTRAINT "platform_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "platform"."platform_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_mfa_challenges" ADD CONSTRAINT "platform_mfa_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform"."platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."saas_invoice_lines" ADD CONSTRAINT "saas_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "platform"."saas_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."manual_payments" ADD CONSTRAINT "manual_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "platform"."saas_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- Partie 2 : contraintes, clés étrangères vers le socle, triggers, privilèges, fonctions.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Contraintes et clés étrangères (vers platform.tenants : SQL uniquement) ─────────
ALTER TABLE platform.platform_users ALTER COLUMN mfa_backup_code_hashes SET NOT NULL;
ALTER TABLE platform.platform_users
  ADD CONSTRAINT ck_platform_users_email CHECK (position('@' IN email::text) > 1);

ALTER TABLE platform.plans
  ADD CONSTRAINT ck_plans_prices CHECK (price_monthly >= 0 AND price_yearly >= 0),
  ADD CONSTRAINT ck_plans_version CHECK (version >= 1);

ALTER TABLE platform.subscriptions
  ADD CONSTRAINT fk_subscriptions_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id),
  ADD CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES platform.plans (id),
  ADD CONSTRAINT fk_subscriptions_pending_plan FOREIGN KEY (pending_plan_id) REFERENCES platform.plans (id),
  ADD CONSTRAINT ck_subscriptions_period CHECK (current_period_end > current_period_start);

ALTER TABLE platform.billing_entities
  ADD CONSTRAINT ck_billing_entities_tax CHECK (tax_rate >= 0 AND tax_rate < 1);

ALTER TABLE platform.saas_invoices
  ADD CONSTRAINT fk_saas_invoices_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id),
  ADD CONSTRAINT fk_saas_invoices_subscription FOREIGN KEY (subscription_id) REFERENCES platform.subscriptions (id),
  ADD CONSTRAINT fk_saas_invoices_plan FOREIGN KEY (plan_id) REFERENCES platform.plans (id),
  ADD CONSTRAINT ck_saas_invoices_number CHECK (number ~ '^GHMT-[A-Z]{2}-[0-9]{4}-[0-9]{6,}$'),
  ADD CONSTRAINT ck_saas_invoices_amounts CHECK (subtotal >= 0 AND tax_amount >= 0 AND total = subtotal + tax_amount),
  ADD CONSTRAINT ck_saas_invoices_period CHECK (period_end > period_start);

-- Une seule facture de renouvellement/conversion non annulée par période d'abonnement (idempotence des jobs).
CREATE UNIQUE INDEX ux_saas_invoices_period
  ON platform.saas_invoices (subscription_id, kind, period_start)
  WHERE kind <> 'upgrade_prorata' AND status <> 'void';

ALTER TABLE platform.manual_payments
  ADD CONSTRAINT fk_manual_payments_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id),
  ADD CONSTRAINT fk_manual_payments_entered_by FOREIGN KEY (entered_by) REFERENCES platform.platform_users (id),
  ADD CONSTRAINT fk_manual_payments_validated_by FOREIGN KEY (validated_by) REFERENCES platform.platform_users (id),
  ADD CONSTRAINT ck_manual_payments_amount CHECK (amount > 0),
  -- Quatre yeux : le validateur n'est jamais le saisisseur (garanti aussi en base).
  ADD CONSTRAINT ck_manual_payments_four_eyes CHECK (validated_by IS NULL OR validated_by <> entered_by),
  ADD CONSTRAINT ck_manual_payments_decision CHECK (
    (status = 'pending' AND validated_by IS NULL AND decided_at IS NULL)
    OR (status <> 'pending' AND validated_by IS NOT NULL AND decided_at IS NOT NULL)
  );
CREATE UNIQUE INDEX ux_manual_payments_pending ON platform.manual_payments (invoice_id) WHERE status = 'pending';

-- ───────── 2. Journal d'audit plateforme : ajout seul, même pour le propriétaire ─────────
CREATE OR REPLACE FUNCTION platform.forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform.audit_logs is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER platform_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON platform.audit_logs
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_audit_mutation();
CREATE TRIGGER platform_audit_logs_no_truncate
  BEFORE TRUNCATE ON platform.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_audit_mutation();

-- ───────── 3. Factures SaaS : numérotation sans trou et immutabilité une fois émises ─────────
-- Le compteur est verrouillé par ligne jusqu'à la fin de la transaction qui insère la facture :
-- une annulation de transaction annule aussi l'incrément (aucun trou), deux émissions concurrentes sont sérialisées.
CREATE OR REPLACE FUNCTION platform.next_saas_invoice_number(p_country char(2), p_year int)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, platform AS $$
DECLARE v_value int;
BEGIN
  INSERT INTO platform.saas_invoice_counters AS c (country_code, year, last_value)
  VALUES (p_country, p_year, 1)
  ON CONFLICT (country_code, year) DO UPDATE SET last_value = c.last_value + 1, updated_at = now()
  RETURNING last_value INTO v_value;
  RETURN format('GHMT-%s-%s-%s', p_country, p_year, lpad(v_value::text, 6, '0'));
END $$;
REVOKE ALL ON FUNCTION platform.next_saas_invoice_number(char, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.next_saas_invoice_number(char, int) TO ghmt_platform;

CREATE OR REPLACE FUNCTION platform.guard_saas_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'issued SaaS invoices are immutable' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  -- Facture émise : identité et montants figés ; seules les transitions de statut légitimes sont permises.
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.billing_period IS DISTINCT FROM OLD.billing_period OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.subtotal IS DISTINCT FROM OLD.subtotal OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate
     OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'issued SaaS invoices are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('paid', 'void', 'uncollectible'))
    OR (OLD.status = 'uncollectible' AND NEW.status IN ('paid', 'void'))
  ) THEN
    RAISE EXCEPTION 'invalid SaaS invoice status transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_invoices_guard
  BEFORE UPDATE OR DELETE ON platform.saas_invoices
  FOR EACH ROW EXECUTE FUNCTION platform.guard_saas_invoice();

CREATE OR REPLACE FUNCTION platform.guard_saas_invoice_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_invoice uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
        v_status platform.saas_invoice_status;
BEGIN
  SELECT status INTO v_status FROM platform.saas_invoices WHERE id = v_invoice;
  -- Facture absente (suppression en cascade d'un brouillon) ou brouillon : modification libre.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'lines of an issued SaaS invoice are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER saas_invoice_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON platform.saas_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION platform.guard_saas_invoice_line();

-- ───────── 4. Privilèges : ghmt_platform uniquement (ghmt_app : aucun accès direct) ─────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  platform.platform_users, platform.platform_sessions, platform.platform_refresh_tokens, platform.platform_mfa_challenges,
  platform.plans, platform.subscriptions, platform.billing_entities, platform.saas_invoice_counters,
  platform.saas_invoices, platform.saas_invoice_lines, platform.manual_payments
  TO ghmt_platform;
GRANT SELECT, INSERT ON platform.audit_logs TO ghmt_platform;
REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_logs FROM ghmt_platform;
REVOKE ALL ON
  platform.platform_users, platform.platform_sessions, platform.platform_refresh_tokens, platform.platform_mfa_challenges,
  platform.audit_logs, platform.plans, platform.subscriptions, platform.billing_entities, platform.saas_invoice_counters,
  platform.saas_invoices, platform.saas_invoice_lines, platform.manual_payments
  FROM ghmt_app;

-- ───────── 5. Abonnement du tenant courant (SECURITY DEFINER, tenant lu dans le contexte) ─────────
CREATE OR REPLACE FUNCTION platform.current_tenant_subscription()
RETURNS TABLE (
  subscription_id uuid, status text, billing_period text,
  current_period_start timestamptz, current_period_end timestamptz, trial_ends_at timestamptz,
  cancel_at_period_end boolean, overrides jsonb,
  plan_id uuid, plan_code text, plan_version int, plan_name text, plan_tier text,
  price_monthly numeric, price_yearly numeric, currency char(3), entitlements jsonb,
  pending_plan_code text, pending_billing_period text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
  SELECT s.id, s.status::text, s.billing_period::text,
         s.current_period_start, s.current_period_end, s.trial_ends_at,
         s.cancel_at_period_end, s.overrides,
         p.id, p.code, p.version, p.name, p.tier::text,
         p.price_monthly, p.price_yearly, p.currency, p.entitlements,
         pp.code, s.pending_billing_period::text
  FROM platform.subscriptions s
  JOIN platform.plans p ON p.id = s.plan_id
  LEFT JOIN platform.plans pp ON pp.id = s.pending_plan_id
  WHERE s.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION platform.current_tenant_subscription() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.current_tenant_subscription() TO ghmt_app;

-- Démarre l'essai du tenant courant (inscription). Idempotent : sans effet si un abonnement existe déjà.
-- Défense en profondeur : plan plafonné à Standard et durée d'essai bornée, même si l'appelant est compromis.
CREATE OR REPLACE FUNCTION platform.start_trial(p_plan_code text, p_days int, p_now timestamptz)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_plan platform.plans%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501'; END IF;
  IF p_days NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'invalid trial duration' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.tenants WHERE id = v_tenant AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'unknown tenant' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_plan FROM platform.plans
   WHERE code = p_plan_code AND archived_at IS NULL AND tier IN ('basic', 'standard')
   ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'trial plan % not found', p_plan_code USING ERRCODE = '22023'; END IF;

  INSERT INTO platform.subscriptions (id, tenant_id, plan_id, status, billing_period,
                                      current_period_start, current_period_end, trial_ends_at, status_changed_at, updated_at)
  VALUES (gen_random_uuid(), v_tenant, v_plan.id, 'trial', 'monthly',
          p_now, p_now + make_interval(days => p_days), p_now + make_interval(days => p_days), p_now, now())
  ON CONFLICT (tenant_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION platform.start_trial(text, int, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.start_trial(text, int, timestamptz) TO ghmt_app;

-- ───────── 6. Agrégats d'usage pour la console (ghmt_platform) : des COMPTES uniquement ─────────
-- Les tables tenant sont protégées par RLS (FORCE, y compris pour le propriétaire de la fonction) :
-- la fonction se place successivement dans chaque tenant, compte, puis restaure le contexte initial.
-- Aucune donnée patient n'est lue ni renvoyée ; ghmt_platform n'a toujours aucun droit sur le schéma tenant.
CREATE OR REPLACE FUNCTION platform.tenants_usage(p_tenant_ids uuid[], p_now timestamptz)
RETURNS TABLE (tenant_id uuid, users int, sites int, patients int, appointments_month int, appointments_30d int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
DECLARE
  v_previous text := COALESCE(current_setting('app.tenant_id', true), '');
  v_month_start timestamptz := date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  r record;
BEGIN
  FOR r IN
    SELECT t.id FROM platform.tenants t
    WHERE t.deleted_at IS NULL AND (p_tenant_ids IS NULL OR t.id = ANY (p_tenant_ids))
    ORDER BY t.id
  LOOP
    PERFORM set_config('app.tenant_id', r.id::text, true);
    tenant_id := r.id;
    SELECT count(*)::int INTO users FROM tenant.users u
      WHERE u.deleted_at IS NULL AND u.status IN ('active', 'invited', 'locked');
    SELECT count(*)::int INTO sites FROM tenant.sites s WHERE s.deleted_at IS NULL;
    SELECT count(*)::int INTO patients FROM tenant.patients p WHERE p.deleted_at IS NULL;
    SELECT count(*)::int INTO appointments_month FROM tenant.appointments a
      WHERE a.deleted_at IS NULL AND a.status NOT IN ('cancelled', 'no_show')
        AND a.starts_at >= v_month_start AND a.starts_at < v_month_start + interval '1 month';
    SELECT count(*)::int INTO appointments_30d FROM tenant.appointments a
      WHERE a.deleted_at IS NULL AND a.status NOT IN ('cancelled', 'no_show')
        AND a.starts_at > p_now - interval '30 days' AND a.starts_at <= p_now;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.tenant_id', v_previous, true);
END $$;
REVOKE ALL ON FUNCTION platform.tenants_usage(uuid[], timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.tenants_usage(uuid[], timestamptz) TO ghmt_platform;
