-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Correctifs des revues santé et sécurité de la phase notifications (docs/10). Exécutée par ghmt_migrator.
-- ═══════════════════════════════════════════════════════════════════════════

-- Lien in-app : chemin interne uniquement (« // » = URL relative au protocole, donc externe : refusé).
ALTER TABLE tenant.inapp_messages DROP CONSTRAINT ck_inapp_messages_link;
ALTER TABLE tenant.inapp_messages
  ADD CONSTRAINT ck_inapp_messages_link CHECK (link IS NULL OR link ~ '^/(?!/)[A-Za-z0-9/_-]*$');

-- Découverte des tenants : p_limit borné (1..500, 500 par défaut).
CREATE OR REPLACE FUNCTION platform.notification_due_tenants(p_limit int DEFAULT 500)
RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp AS $$
DECLARE
  v_previous text := COALESCE(current_setting('app.tenant_id', true), '');
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 500);
  v_returned int := 0;
  v_due boolean;
  r record;
BEGIN
  FOR r IN
    SELECT t.id FROM platform.tenants t
    WHERE t.deleted_at IS NULL AND t.status <> 'terminated'
    ORDER BY t.id
  LOOP
    EXIT WHEN v_returned >= v_limit;
    PERFORM set_config('app.tenant_id', r.id::text, true);
    SELECT EXISTS (
             SELECT 1 FROM tenant.notification_outbox o WHERE o.status = 'pending' AND o.available_at <= now())
        OR EXISTS (
             SELECT 1 FROM tenant.notifications n
             WHERE n.status = 'queued' AND n.next_attempt_at <= now() AND (n.locked_until IS NULL OR n.locked_until < now()))
      INTO v_due;
    IF v_due THEN
      v_returned := v_returned + 1;
      RETURN NEXT r.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', v_previous, true);
END $$;

-- Consentement : nouvelle source « phone_change » (changement de numéro : le consentement SMS repart de zéro, par un utilisateur).
ALTER TABLE tenant.patient_contact_consents DROP CONSTRAINT ck_patient_contact_consents_source;
ALTER TABLE tenant.patient_contact_consents
  ADD CONSTRAINT ck_patient_contact_consents_source CHECK (source IN ('front_desk', 'patient_request', 'sms_stop', 'phone_change')),
  ADD CONSTRAINT ck_patient_contact_consents_phone_change_revokes CHECK (source <> 'phone_change' OR granted = false);

-- Langue par défaut de l'établissement courant (le tenant est lu dans le contexte, jamais en paramètre).
CREATE OR REPLACE FUNCTION platform.current_tenant_locale() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp AS $$
  SELECT t.default_locale FROM platform.tenants t
  WHERE t.id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AND t.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION platform.current_tenant_locale() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.current_tenant_locale() TO ghmt_app;
