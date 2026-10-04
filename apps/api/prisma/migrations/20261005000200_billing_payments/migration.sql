-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Paiements (platform) et facturation patient / caisse (tenant)
-- Référence : docs/09-phase-facturation-saas.md §C, docs/02 §3.10 et §6. Exécutée par ghmt_migrator.
-- Partie 1 : tables générées par `prisma migrate diff` (base + core → base + core + billing).
-- Partie 2 : contraintes, FK, RLS, privilèges, triggers d'immutabilité.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Tables (générées) ─────────
-- CreateTable
CREATE TABLE "platform"."payment_attempts" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotency_key" TEXT NOT NULL,
    "payer_phone_hash" TEXT,
    "description" TEXT NOT NULL,
    "checkout_url" TEXT,
    "instructions" TEXT,
    "failure_reason" TEXT,
    "check_count" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMPTZ(6),
    "settled_at" TIMESTAMPTZ(6),
    "notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."payment_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "provider_reference" TEXT,
    "attempt_id" UUID,
    "raw_body" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "outcome" TEXT,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."sandbox_transactions" (
    "provider_reference" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sandbox_transactions_pkey" PRIMARY KEY ("provider_reference")
);

-- CreateTable
CREATE TABLE "tenant"."price_lists" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."price_list_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_list_items_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "patient_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "appointment_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "issued_at" TIMESTAMPTZ(6),
    "issued_by" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "voided_by" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "row_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."invoice_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "price_list_item_id" UUID,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "line_total" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "paid_at" TIMESTAMPTZ(6),
    "cash_session_id" UUID,
    "received_by" UUID,
    "attempt_id" UUID,
    "provider" TEXT,
    "provider_reference" TEXT,
    "checkout_url" TEXT,
    "reference" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."cash_registers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."cash_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cash_register_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "currency" CHAR(3) NOT NULL,
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_float" DECIMAL(18,2) NOT NULL,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "expected_total" DECIMAL(18,2),
    "closing_counted" DECIMAL(18,2),
    "variance" DECIMAL(18,2),
    "closing_note" TEXT,
    "validated_by" UUID,
    "validated_at" TIMESTAMPTZ(6),
    "validation_note" TEXT,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_idempotency_key_key" ON "platform"."payment_attempts"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_attempts_status_created_at_idx" ON "platform"."payment_attempts"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_attempts_tenant_id_purpose_reference_id_idx" ON "platform"."payment_attempts"("tenant_id", "purpose", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_provider_provider_reference_key" ON "platform"."payment_attempts"("provider", "provider_reference");

-- CreateIndex
CREATE INDEX "payment_events_attempt_id_idx" ON "platform"."payment_events"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_provider_event_id_key" ON "platform"."payment_events"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_tenant_id_code_key" ON "tenant"."price_lists"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "price_list_items_tenant_id_price_list_id_category_idx" ON "tenant"."price_list_items"("tenant_id", "price_list_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_items_tenant_id_price_list_id_code_key" ON "tenant"."price_list_items"("tenant_id", "price_list_id", "code");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_patient_id_created_at_idx" ON "tenant"."invoices"("tenant_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invoices_tenant_id_site_id_status_idx" ON "tenant"."invoices"("tenant_id", "site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_number_key" ON "tenant"."invoices"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_tenant_id_invoice_id_line_no_key" ON "tenant"."invoice_lines"("tenant_id", "invoice_id", "line_no");

-- CreateIndex
CREATE INDEX "payments_tenant_id_invoice_id_idx" ON "tenant"."payments"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_cash_session_id_idx" ON "tenant"."payments"("tenant_id", "cash_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_attempt_id_key" ON "tenant"."payments"("tenant_id", "attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_registers_tenant_id_site_id_code_key" ON "tenant"."cash_registers"("tenant_id", "site_id", "code");

-- CreateIndex
CREATE INDEX "cash_sessions_tenant_id_cash_register_id_opened_at_idx" ON "tenant"."cash_sessions"("tenant_id", "cash_register_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "cash_sessions_tenant_id_opened_by_status_idx" ON "tenant"."cash_sessions"("tenant_id", "opened_by", "status");

-- AddForeignKey
ALTER TABLE "tenant"."price_list_items" ADD CONSTRAINT "price_list_items_tenant_id_price_list_id_fkey" FOREIGN KEY ("tenant_id", "price_list_id") REFERENCES "tenant"."price_lists"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "tenant"."invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."payments" ADD CONSTRAINT "payments_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "tenant"."invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_cash_register_id_fkey" FOREIGN KEY ("tenant_id", "cash_register_id") REFERENCES "tenant"."cash_registers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────── 2. Paiements (schéma platform) : privilèges, contraintes ─────────
-- ghmt_platform uniquement ; ghmt_app n'a AUCUN accès direct (le tenant ne lit jamais ces tables).
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.payment_attempts, platform.payment_events, platform.sandbox_transactions TO ghmt_platform;
REVOKE ALL ON platform.payment_attempts, platform.payment_events, platform.sandbox_transactions FROM ghmt_app;

ALTER TABLE platform.payment_attempts
  ADD CONSTRAINT ck_payment_attempts_purpose CHECK (purpose IN ('saas_invoice', 'patient_invoice')),
  ADD CONSTRAINT ck_payment_attempts_channel CHECK (channel IN ('mobile_money', 'card')),
  ADD CONSTRAINT ck_payment_attempts_status CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  ADD CONSTRAINT ck_payment_attempts_amount CHECK (amount > 0),
  ADD CONSTRAINT fk_payment_attempts_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE platform.sandbox_transactions
  ADD CONSTRAINT ck_sandbox_transactions_status CHECK (status IN ('pending', 'succeeded', 'failed'));

-- Une tentative réglée est définitive ; montant, devise, tenant et référence ne changent jamais.
CREATE OR REPLACE FUNCTION platform.guard_payment_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, platform AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.purpose <> OLD.purpose OR NEW.reference_id <> OLD.reference_id
     OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'payment_attempts: champ immuable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'payment_attempts: statut % définitif', OLD.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_guard BEFORE UPDATE ON platform.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION platform.guard_payment_attempt();

-- ───────── 3. Clés étrangères (composites, vers core) et contraintes métier ─────────
ALTER TABLE tenant.price_lists        ADD CONSTRAINT fk_price_lists_tenant        FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.price_list_items   ADD CONSTRAINT fk_price_list_items_tenant   FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.invoices           ADD CONSTRAINT fk_invoices_tenant           FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.invoice_lines      ADD CONSTRAINT fk_invoice_lines_tenant      FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.payments           ADD CONSTRAINT fk_payments_tenant           FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.cash_registers     ADD CONSTRAINT fk_cash_registers_tenant     FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.cash_sessions      ADD CONSTRAINT fk_cash_sessions_tenant      FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);

ALTER TABLE tenant.invoices
  ADD CONSTRAINT fk_invoices_patient     FOREIGN KEY (tenant_id, patient_id)     REFERENCES tenant.patients (tenant_id, id),
  ADD CONSTRAINT fk_invoices_site        FOREIGN KEY (tenant_id, site_id)        REFERENCES tenant.sites (tenant_id, id),
  ADD CONSTRAINT fk_invoices_appointment FOREIGN KEY (tenant_id, appointment_id) REFERENCES tenant.appointments (tenant_id, id),
  ADD CONSTRAINT ck_invoices_status CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'void')),
  ADD CONSTRAINT ck_invoices_amounts CHECK (subtotal >= 0 AND total = subtotal AND amount_paid >= 0),
  ADD CONSTRAINT ck_invoices_number CHECK (number IS NOT NULL OR status IN ('draft', 'void')),
  ADD CONSTRAINT ck_invoices_void CHECK (status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND amount_paid = 0));

ALTER TABLE tenant.invoice_lines
  ADD CONSTRAINT fk_invoice_lines_item FOREIGN KEY (tenant_id, price_list_item_id) REFERENCES tenant.price_list_items (tenant_id, id),
  ADD CONSTRAINT ck_invoice_lines_amounts CHECK (quantity > 0 AND unit_price >= 0 AND line_total = round(quantity * unit_price, 2)),
  ADD CONSTRAINT ck_invoice_lines_category CHECK (category IN ('consultation', 'acte', 'examen', 'medicament', 'autre'));

ALTER TABLE tenant.price_list_items
  ADD CONSTRAINT ck_price_list_items_category CHECK (category IN ('consultation', 'acte', 'examen', 'medicament', 'autre')),
  ADD CONSTRAINT ck_price_list_items_price CHECK (unit_price >= 0);
-- Une seule grille par défaut par établissement.
CREATE UNIQUE INDEX ux_price_lists_default ON tenant.price_lists (tenant_id) WHERE is_default;

ALTER TABLE tenant.cash_registers
  ADD CONSTRAINT fk_cash_registers_site FOREIGN KEY (tenant_id, site_id) REFERENCES tenant.sites (tenant_id, id);

ALTER TABLE tenant.cash_sessions
  ADD CONSTRAINT ck_cash_sessions_status CHECK (status IN ('open', 'closed', 'validated')),
  ADD CONSTRAINT ck_cash_sessions_float CHECK (opening_float >= 0),
  ADD CONSTRAINT ck_cash_sessions_closing CHECK ((status = 'open') = (closed_at IS NULL)),
  -- Séparation des tâches garantie en base : le validateur n'est ni l'ouvreur ni celui qui a clôturé.
  ADD CONSTRAINT ck_cash_sessions_segregation CHECK (validated_by IS NULL OR (validated_by <> opened_by AND validated_by <> closed_by));
-- Une seule session ouverte par caisse.
CREATE UNIQUE INDEX ux_cash_sessions_one_open ON tenant.cash_sessions (tenant_id, cash_register_id) WHERE closed_at IS NULL;

ALTER TABLE tenant.payments
  ADD CONSTRAINT fk_payments_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES tenant.patients (tenant_id, id),
  ADD CONSTRAINT fk_payments_session FOREIGN KEY (tenant_id, cash_session_id) REFERENCES tenant.cash_sessions (tenant_id, id),
  ADD CONSTRAINT ck_payments_method CHECK (method IN ('cash', 'mobile_money', 'card', 'other')),
  ADD CONSTRAINT ck_payments_status CHECK (status IN ('pending', 'succeeded', 'failed')),
  ADD CONSTRAINT ck_payments_amount CHECK (amount > 0),
  ADD CONSTRAINT ck_payments_cash_session CHECK (method <> 'cash' OR cash_session_id IS NOT NULL);
-- Au plus un paiement en ligne en attente par facture.
CREATE UNIQUE INDEX ux_payments_one_pending_online ON tenant.payments (tenant_id, invoice_id)
  WHERE status = 'pending' AND method IN ('mobile_money', 'card');

-- ───────── 4. Isolation (RLS ENABLE + FORCE + tenant_isolation) et privilèges ─────────
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

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant.price_lists, tenant.price_list_items, tenant.invoices, tenant.invoice_lines,
  tenant.payments, tenant.cash_registers, tenant.cash_sessions TO ghmt_app;
-- Pièces comptables : jamais de suppression (annulation = statut `void`). Le DELETE reste accordé (contrat du test rls-coverage) mais
-- les triggers `tenant.guard_invoice|payment|cash_session` le refusent (42501), y compris pour le propriétaire.
REVOKE ALL ON
  tenant.price_lists, tenant.price_list_items, tenant.invoices, tenant.invoice_lines,
  tenant.payments, tenant.cash_registers, tenant.cash_sessions FROM ghmt_platform;

-- ───────── 5. Immutabilité (valable aussi pour le propriétaire) ─────────
-- Facture émise : seuls statut, montant payé, annulation et métadonnées de mise à jour peuvent changer.
CREATE OR REPLACE FUNCTION tenant.guard_invoice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'amount_paid', 'voided_at', 'voided_by', 'void_reason', 'updated_at', 'updated_by', 'row_version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices: suppression interdite' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'invoices: facture annulée immuable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'invoices: facture émise immuable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'invoices: retour au brouillon interdit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON tenant.invoices
  FOR EACH ROW EXECUTE FUNCTION tenant.guard_invoice();

-- Lignes : modifiables uniquement tant que la facture est un brouillon.
CREATE OR REPLACE FUNCTION tenant.guard_invoice_line() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant AS $$
DECLARE
  v_invoice uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  v_tenant  uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  v_status  text;
BEGIN
  SELECT i.status INTO v_status FROM tenant.invoices i WHERE i.tenant_id = v_tenant AND i.id = v_invoice;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'invoice_lines: facture non modifiable' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON tenant.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION tenant.guard_invoice_line();

-- Paiements : ajout seul. Un paiement en attente peut être réglé (statut, références fournisseur), jamais autrement modifié.
CREATE OR REPLACE FUNCTION tenant.guard_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'paid_at', 'attempt_id', 'provider', 'provider_reference', 'checkout_url', 'failure_reason', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments: suppression interdite' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'payments: paiement % définitif', OLD.status USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'payments: champ immuable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON tenant.payments
  FOR EACH ROW EXECUTE FUNCTION tenant.guard_payment();

-- Sessions de caisse : ouverture figée ; transitions open → closed → validated uniquement.
CREATE OR REPLACE FUNCTION tenant.guard_cash_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash_sessions: suppression interdite' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.cash_register_id <> OLD.cash_register_id OR NEW.opened_by <> OLD.opened_by
     OR NEW.opened_at <> OLD.opened_at OR NEW.opening_float <> OLD.opening_float OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'cash_sessions: ouverture immuable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'validated' THEN
    RAISE EXCEPTION 'cash_sessions: session validée immuable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'open' AND NEW.status = 'closed') OR (OLD.status = 'closed' AND NEW.status = 'validated')) THEN
    RAISE EXCEPTION 'cash_sessions: transition % → % interdite', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' AND NEW.status = 'closed' AND (NEW.closing_counted IS DISTINCT FROM OLD.closing_counted OR NEW.expected_total IS DISTINCT FROM OLD.expected_total) THEN
    RAISE EXCEPTION 'cash_sessions: clôture immuable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_sessions_guard BEFORE UPDATE OR DELETE ON tenant.cash_sessions
  FOR EACH ROW EXECUTE FUNCTION tenant.guard_cash_session();
