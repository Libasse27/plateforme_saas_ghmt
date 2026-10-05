-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Correctifs de la revue santé et de la revue sécurité de la phase « Facturation + abonnements SaaS »
-- Référence : docs/09-phase-facturation-saas.md §R. Exécutée par ghmt_migrator. Ne modifie aucune migration existante.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Colonnes (R2, R6, R8, paiements en ligne, webhooks) ─────────
ALTER TABLE tenant.price_list_items ADD COLUMN is_sensitive BOOLEAN NOT NULL DEFAULT false, ADD COLUMN print_label TEXT;
ALTER TABLE tenant.invoice_lines    ADD COLUMN is_sensitive BOOLEAN NOT NULL DEFAULT false, ADD COLUMN print_label TEXT;
ALTER TABLE tenant.invoices         ADD COLUMN void_reason_code TEXT;
ALTER TABLE tenant.payments         ADD COLUMN anomaly TEXT;
ALTER TABLE tenant.cash_sessions    ADD COLUMN force_closed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE platform.payment_events ADD COLUMN body_sha256 TEXT;

ALTER TABLE tenant.invoices
  ADD CONSTRAINT ck_invoices_void_reason_code CHECK (void_reason_code IS NULL OR void_reason_code IN ('duplicate', 'wrong_price', 'wrong_patient', 'service_not_rendered', 'other'));
ALTER TABLE tenant.payments
  ADD CONSTRAINT ck_payments_anomaly CHECK (anomaly IS NULL OR anomaly IN ('overpaid'));

-- Statut « cancelled » d'un paiement (abandon par l'encaisseur, R4).
ALTER TABLE tenant.payments DROP CONSTRAINT ck_payments_status;
ALTER TABLE tenant.payments ADD CONSTRAINT ck_payments_status CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled'));

-- Clôture contradictoire : jamais par l'ouvreur ; un écart exige une note (contrainte non validée sur l'existant).
ALTER TABLE tenant.cash_sessions
  ADD CONSTRAINT ck_cash_sessions_force_close CHECK (NOT force_closed OR closed_by <> opened_by),
  ADD CONSTRAINT ck_cash_sessions_variance_note CHECK (variance IS NULL OR variance = 0 OR closing_note IS NOT NULL) NOT VALID;

-- ───────── 2. Échelle monétaire par devise (R7) : XOF, XAF, GNF, CDF sans décimales ─────────
-- NOT VALID : les lignes antérieures ne sont pas réécrites, toute nouvelle écriture est contrôlée.
ALTER TABLE tenant.invoices
  ADD CONSTRAINT ck_invoices_scale CHECK (
    currency NOT IN ('XOF', 'XAF', 'GNF', 'CDF')
    OR (total = trunc(total) AND subtotal = trunc(subtotal) AND amount_paid = trunc(amount_paid))
  ) NOT VALID;
ALTER TABLE tenant.payments
  ADD CONSTRAINT ck_payments_scale CHECK (currency NOT IN ('XOF', 'XAF', 'GNF', 'CDF') OR amount = trunc(amount)) NOT VALID;
ALTER TABLE tenant.cash_sessions
  ADD CONSTRAINT ck_cash_sessions_scale CHECK (
    currency NOT IN ('XOF', 'XAF', 'GNF', 'CDF')
    OR (opening_float = trunc(opening_float) AND COALESCE(closing_counted, 0) = trunc(COALESCE(closing_counted, 0)))
  ) NOT VALID;

-- Total de ligne : arrondi à 2 décimales, ou à l'unité pour les devises sans subdivision (arrondi du service).
ALTER TABLE tenant.invoice_lines DROP CONSTRAINT ck_invoice_lines_amounts;
ALTER TABLE tenant.invoice_lines ADD CONSTRAINT ck_invoice_lines_amounts CHECK (
  quantity > 0 AND unit_price >= 0
  AND (line_total = round(quantity * unit_price, 2) OR (line_total = round(quantity * unit_price, 0) AND line_total = trunc(line_total))));

-- ───────── 3. Garde des factures patient : motif codé d'annulation ─────────
CREATE OR REPLACE FUNCTION tenant.guard_invoice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'amount_paid', 'voided_at', 'voided_by', 'void_reason', 'void_reason_code', 'updated_at', 'updated_by', 'row_version'];
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

-- ───────── 4. Garde des paiements : abandon (cancelled), succès tardif et anomalie ─────────
-- Un paiement en attente peut être réglé. Un paiement en ligne échoué ou abandonné peut encore devenir « succeeded » :
-- l'agrégateur a confirmé l'encaissement (succès tardif, jamais perdu). Tout autre paiement réglé est définitif.
CREATE OR REPLACE FUNCTION tenant.guard_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'paid_at', 'attempt_id', 'provider', 'provider_reference', 'checkout_url', 'failure_reason', 'anomaly', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments: suppression interdite' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'pending' AND NOT (OLD.status IN ('failed', 'cancelled') AND NEW.status = 'succeeded' AND OLD.method IN ('mobile_money', 'card')) THEN
    RAISE EXCEPTION 'payments: paiement % définitif', OLD.status USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'payments: champ immuable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ───────── 5. Webhooks de paiement : corps expurgés, journal en ajout seul (L8) ─────────
-- Empreinte calculée AVANT l'expurgation des corps déjà stockés (ils contiennent des numéros de téléphone).
UPDATE platform.payment_events SET body_sha256 = encode(sha256(convert_to(raw_body, 'UTF8')), 'hex') WHERE body_sha256 IS NULL;
UPDATE platform.payment_events SET raw_body = '[corps purgé]' WHERE raw_body <> '[corps purgé]';

CREATE OR REPLACE FUNCTION platform.forbid_payment_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, platform AS $$
BEGIN
  RAISE EXCEPTION '% sur % interdit', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

-- Tentatives et événements : jamais supprimés (traçabilité financière).
CREATE TRIGGER payment_attempts_no_delete BEFORE DELETE ON platform.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_payment_mutation();
CREATE TRIGGER payment_attempts_no_truncate BEFORE TRUNCATE ON platform.payment_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_payment_mutation();
CREATE TRIGGER payment_events_no_delete BEFORE DELETE ON platform.payment_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_payment_mutation();
CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON platform.payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_payment_mutation();

-- Événements : seules les colonnes de traitement (rattachement, issue, date) évoluent ; le corps reçu est figé.
CREATE OR REPLACE FUNCTION platform.guard_payment_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, platform AS $$
DECLARE
  v_mutable constant text[] := ARRAY['attempt_id', 'outcome', 'processed_at'];
BEGIN
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'payment_events: événement reçu immuable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_events_guard BEFORE UPDATE ON platform.payment_events
  FOR EACH ROW EXECUTE FUNCTION platform.guard_payment_event();

-- Succès tardif : une tentative expirée, abandonnée ou sans réponse technique peut encore devenir « succeeded » quand
-- l'agrégateur confirme l'encaissement (jamais après un refus pour montant différent ni un refus explicite).
CREATE OR REPLACE FUNCTION platform.guard_payment_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, platform AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.purpose <> OLD.purpose OR NEW.reference_id <> OLD.reference_id
     OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'payment_attempts: champ immuable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status AND NOT (
       OLD.status IN ('failed', 'cancelled') AND NEW.status = 'succeeded'
       AND OLD.failure_reason IN ('expired', 'provider_unavailable', 'abandoned')
     ) THEN
    RAISE EXCEPTION 'payment_attempts: statut % définitif', OLD.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Une seule tentative en attente par facture SaaS (M5).
CREATE UNIQUE INDEX ux_payment_attempts_one_pending_saas ON platform.payment_attempts (reference_id)
  WHERE purpose = 'saas_invoice' AND status = 'pending';

-- ───────── 6. Factures SaaS : brouillon → payé interdit ; compteur de numéros protégé (L8) ─────────
CREATE OR REPLACE FUNCTION platform.guard_saas_invoice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, platform AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'issued SaaS invoices are immutable' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    -- Un brouillon ne peut être payé sans avoir été émis (open).
    IF NEW.status = 'paid' THEN RAISE EXCEPTION 'a draft SaaS invoice cannot be paid before issuance' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
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

-- Le compteur ne se supprime ni ne recule : un numéro de facture ne serait plus unique dans le temps.
-- (L'unicité reste garantie par l'index unique saas_invoices_number_key.)
CREATE OR REPLACE FUNCTION platform.guard_saas_invoice_counter() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, platform AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'saas_invoice_counters: suppression interdite' USING ERRCODE = '42501';
  END IF;
  IF NEW.last_value < OLD.last_value THEN
    RAISE EXCEPTION 'saas_invoice_counters: le compteur ne recule jamais' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_invoice_counters_guard BEFORE UPDATE OR DELETE ON platform.saas_invoice_counters
  FOR EACH ROW EXECUTE FUNCTION platform.guard_saas_invoice_counter();
CREATE TRIGGER saas_invoice_counters_no_truncate BEFORE TRUNCATE ON platform.saas_invoice_counters
  FOR EACH STATEMENT EXECUTE FUNCTION platform.guard_saas_invoice_counter();

-- ───────── 7. search_path des fonctions SECURITY DEFINER : pg_temp en dernier (L8) ─────────
ALTER FUNCTION platform.resolve_tenant(text)                SET search_path = pg_catalog, platform, pg_temp;
ALTER FUNCTION platform.current_tenant_modules()            SET search_path = pg_catalog, platform, pg_temp;
ALTER FUNCTION platform.current_tenant_profile()            SET search_path = pg_catalog, platform, pg_temp;
ALTER FUNCTION platform.current_tenant_subscription()       SET search_path = pg_catalog, platform, pg_temp;
ALTER FUNCTION platform.start_trial(text, int, timestamptz) SET search_path = pg_catalog, platform, pg_temp;
ALTER FUNCTION platform.register_tenant(text, text, text, platform.establishment_type, char, char, text, text[])
  SET search_path = pg_catalog, platform, pg_temp;

-- ───────── 8. Usage des établissements sans instant libre ─────────
-- L'ancienne signature acceptait un instant arbitraire : remplacée par une fonction qui impose now().
DROP FUNCTION platform.tenants_usage(uuid[], timestamptz);
CREATE OR REPLACE FUNCTION platform.tenants_usage(p_tenant_ids uuid[])
RETURNS TABLE (tenant_id uuid, users int, sites int, patients int, appointments_month int, appointments_30d int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp AS $$
DECLARE
  v_now timestamptz := now();
  v_previous text := COALESCE(current_setting('app.tenant_id', true), '');
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
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
        AND a.starts_at > v_now - interval '30 days' AND a.starts_at <= v_now;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.tenant_id', v_previous, true);
END $$;
REVOKE ALL ON FUNCTION platform.tenants_usage(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.tenants_usage(uuid[]) TO ghmt_platform;

-- ───────── 9. Abonnement résilié = lecture seule : aligner les établissements existants ─────────
UPDATE platform.tenants t SET status = 'suspended'
 WHERE t.status = 'active'
   AND EXISTS (SELECT 1 FROM platform.subscriptions s WHERE s.tenant_id = t.id AND s.status = 'cancelled');
