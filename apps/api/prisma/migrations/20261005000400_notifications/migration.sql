-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Notifications : outbox, journal d'envoi, in-app, modèles, paramètres, préférences, consentements
-- Référence : docs/10-phase-notifications-admin.md §3.1. Exécutée par ghmt_migrator.
-- DDL des tables généré par `prisma migrate diff`, complété en SQL (FK, CHECK, RLS, triggers, fonction SECURITY DEFINER).
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Tables (prisma migrate diff) ─────────
-- CreateTable
CREATE TABLE "tenant"."notification_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type_code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient_type" TEXT NOT NULL,
    "recipient_id" UUID NOT NULL,
    "subject_type" TEXT,
    "subject_id" UUID,
    "subject_version" TEXT,
    "source_event_id" UUID,
    "dedup_key" CHAR(64) NOT NULL,
    "locale" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "suppression_reason" TEXT,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "deadline_at" TIMESTAMPTZ(6),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "template_source" TEXT,
    "template_version" INTEGER,
    "recipient_masked" TEXT,
    "recipient_hash" BYTEA,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "segments" SMALLINT,
    "encoding" TEXT,
    "error_class" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "suppressed_at" TIMESTAMPTZ(6),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."notification_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "attempt" SMALLINT NOT NULL,
    "outcome" TEXT NOT NULL,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "error_class" TEXT,
    "error_code" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_attempts_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."inapp_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notification_id" UUID,
    "type_code" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "link" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inapp_messages_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."notification_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type_code" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" VARCHAR(150),
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant"."notification_settings" (
    "tenant_id" UUID NOT NULL,
    "quiet_hours_start" TIME(0) NOT NULL DEFAULT '21:00:00'::time,
    "quiet_hours_end" TIME(0) NOT NULL DEFAULT '07:00:00'::time,
    "sms_transliterate" BOOLEAN NOT NULL DEFAULT true,
    "sender_display_name" VARCHAR(30),
    "appointment_sms_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reminder_d1_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reminder_d1_local_time" TIME(0) NOT NULL DEFAULT '10:00:00'::time,
    "reminder_h2_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "tenant"."notification_preferences" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("tenant_id","user_id","category","channel")
);

-- CreateTable
CREATE TABLE "tenant"."patient_contact_consents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "recorded_by" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_contact_consents_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "platform"."sms_recipient_tenants" (
    "phone_hmac" BYTEA NOT NULL,
    "tenant_id" UUID NOT NULL,
    "last_sent_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sms_recipient_tenants_pkey" PRIMARY KEY ("phone_hmac","tenant_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_dedup_key_key" ON "tenant"."notifications"("tenant_id", "dedup_key");

-- CreateIndex
CREATE INDEX "notification_attempts_tenant_id_notification_id_attempt_idx" ON "tenant"."notification_attempts"("tenant_id", "notification_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "inapp_messages_tenant_id_notification_id_key" ON "tenant"."inapp_messages"("tenant_id", "notification_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_tenant_id_type_code_channel_locale_v_key" ON "tenant"."notification_templates"("tenant_id", "type_code", "channel", "locale", "version");

-- CreateIndex
CREATE INDEX "patient_contact_consents_tenant_id_patient_id_channel_purpo_idx" ON "tenant"."patient_contact_consents"("tenant_id", "patient_id", "channel", "purpose", "recorded_at" DESC, "id" DESC);

-- ───────── 2. Clés étrangères (SQL : aucune relation Prisma vers le socle) ─────────
ALTER TABLE tenant.notification_outbox ADD CONSTRAINT fk_notification_outbox_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.notifications ADD CONSTRAINT fk_notifications_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.notification_attempts
  ADD CONSTRAINT fk_notification_attempts_notification FOREIGN KEY (tenant_id, notification_id) REFERENCES tenant.notifications (tenant_id, id);
ALTER TABLE tenant.inapp_messages
  ADD CONSTRAINT fk_inapp_messages_user FOREIGN KEY (tenant_id, user_id) REFERENCES tenant.users (tenant_id, id),
  ADD CONSTRAINT fk_inapp_messages_notification FOREIGN KEY (tenant_id, notification_id) REFERENCES tenant.notifications (tenant_id, id);
ALTER TABLE tenant.notification_templates ADD CONSTRAINT fk_notification_templates_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.notification_settings ADD CONSTRAINT fk_notification_settings_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id);
ALTER TABLE tenant.notification_preferences
  ADD CONSTRAINT fk_notification_preferences_user FOREIGN KEY (tenant_id, user_id) REFERENCES tenant.users (tenant_id, id);
ALTER TABLE tenant.patient_contact_consents
  ADD CONSTRAINT fk_patient_contact_consents_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES tenant.patients (tenant_id, id);
ALTER TABLE platform.sms_recipient_tenants
  ADD CONSTRAINT fk_sms_recipient_tenants_tenant FOREIGN KEY (tenant_id) REFERENCES platform.tenants (id) ON DELETE CASCADE;

-- ───────── 3. Contraintes (énumérations en text + CHECK) ─────────
ALTER TABLE tenant.notification_outbox
  ADD CONSTRAINT ck_notification_outbox_event_type CHECK (event_type IN ('appointment.created', 'appointment.rescheduled', 'appointment.cancelled', 'appointment.deleted')),
  ADD CONSTRAINT ck_notification_outbox_aggregate CHECK (aggregate_type = 'appointment'),
  ADD CONSTRAINT ck_notification_outbox_status CHECK (status IN ('pending', 'processed', 'failed'));

ALTER TABLE tenant.notifications
  ADD CONSTRAINT ck_notifications_category CHECK (category IN ('transactional', 'clinical_reminder', 'administrative')),
  ADD CONSTRAINT ck_notifications_channel CHECK (channel IN ('email', 'sms', 'inapp')),
  ADD CONSTRAINT ck_notifications_recipient_type CHECK (recipient_type IN ('user', 'patient')),
  ADD CONSTRAINT ck_notifications_inapp_user CHECK (channel <> 'inapp' OR recipient_type = 'user'),
  ADD CONSTRAINT ck_notifications_locale CHECK (locale IN ('fr', 'en')),
  ADD CONSTRAINT ck_notifications_status CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'suppressed')),
  ADD CONSTRAINT ck_notifications_suppression_reason CHECK (
    suppression_reason IS NULL OR suppression_reason IN (
      'no_consent', 'no_contact', 'preference_disabled', 'channel_disabled', 'quota_exhausted', 'stale',
      'appointment_cancelled', 'invoice_settled', 'too_late', 'provider_unavailable', 'recipient_inactive')),
  ADD CONSTRAINT ck_notifications_suppressed_has_reason CHECK (status <> 'suppressed' OR suppression_reason IS NOT NULL),
  ADD CONSTRAINT ck_notifications_template_source CHECK (template_source IS NULL OR template_source IN ('default', 'custom')),
  ADD CONSTRAINT ck_notifications_encoding CHECK (encoding IS NULL OR encoding IN ('GSM7', 'UCS2')),
  ADD CONSTRAINT ck_notifications_error_class CHECK (error_class IS NULL OR error_class IN ('transient', 'permanent_recipient', 'permanent_config'));

ALTER TABLE tenant.notification_attempts
  ADD CONSTRAINT ck_notification_attempts_outcome CHECK (outcome IN ('sent', 'delivered', 'failed', 'retry_scheduled')),
  ADD CONSTRAINT ck_notification_attempts_error_class CHECK (error_class IS NULL OR error_class IN ('transient', 'permanent_recipient', 'permanent_config'));

ALTER TABLE tenant.inapp_messages
  ADD CONSTRAINT ck_inapp_messages_link CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_-]*$');

ALTER TABLE tenant.notification_templates
  ADD CONSTRAINT ck_notification_templates_channel CHECK (channel IN ('email', 'sms', 'inapp')),
  ADD CONSTRAINT ck_notification_templates_locale CHECK (locale IN ('fr', 'en')),
  ADD CONSTRAINT ck_notification_templates_body CHECK (length(body) <= 5000);
CREATE UNIQUE INDEX uq_notification_templates_active
  ON tenant.notification_templates (tenant_id, type_code, channel, locale) WHERE is_active;

ALTER TABLE tenant.notification_settings
  ADD CONSTRAINT ck_notification_settings_quiet_hours CHECK (quiet_hours_start <> quiet_hours_end);

ALTER TABLE tenant.notification_preferences
  ADD CONSTRAINT ck_notification_preferences_category CHECK (category IN ('administrative')),
  ADD CONSTRAINT ck_notification_preferences_channel CHECK (channel IN ('email', 'inapp'));

ALTER TABLE tenant.patient_contact_consents
  ADD CONSTRAINT ck_patient_contact_consents_channel CHECK (channel IN ('sms', 'email')),
  ADD CONSTRAINT ck_patient_contact_consents_purpose CHECK (purpose IN ('appointment_reminder')),
  ADD CONSTRAINT ck_patient_contact_consents_source CHECK (source IN ('front_desk', 'patient_request', 'sms_stop')),
  ADD CONSTRAINT ck_patient_contact_consents_stop_revokes CHECK (source <> 'sms_stop' OR granted = false),
  ADD CONSTRAINT ck_patient_contact_consents_recorded_by CHECK (source = 'sms_stop' OR recorded_by IS NOT NULL);

-- ───────── 4. Index de travail ─────────
CREATE INDEX ix_notification_outbox_due ON tenant.notification_outbox (tenant_id, available_at) WHERE status = 'pending';
CREATE INDEX ix_notifications_due ON tenant.notifications (tenant_id, next_attempt_at) WHERE status = 'queued';
CREATE INDEX ix_notifications_subject ON tenant.notifications (tenant_id, subject_type, subject_id);
CREATE INDEX ix_notifications_created ON tenant.notifications (tenant_id, created_at DESC, id DESC);
CREATE INDEX ix_notifications_sms_month ON tenant.notifications (tenant_id, sent_at) WHERE channel = 'sms' AND status IN ('sent', 'delivered');
CREATE INDEX ix_inapp_messages_user ON tenant.inapp_messages (tenant_id, user_id, created_at DESC, id DESC);
CREATE INDEX ix_inapp_unread ON tenant.inapp_messages (tenant_id, user_id) WHERE read_at IS NULL;
CREATE INDEX ix_sms_recipient_tenants_last_sent ON platform.sms_recipient_tenants (last_sent_at);

-- ───────── 5. Isolation (même boucle que 20261004000200 : toute table tenant présente) ─────────
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

-- ghmt_app : DML par les privilèges par défaut du schéma tenant ; ghmt_platform n'a aucun accès au schéma tenant.
REVOKE ALL ON tenant.notification_outbox, tenant.notifications, tenant.notification_attempts, tenant.inapp_messages,
  tenant.notification_templates, tenant.notification_settings, tenant.notification_preferences, tenant.patient_contact_consents
  FROM ghmt_platform;
-- platform.sms_recipient_tenants : écrite et lue par PlatformDb uniquement (privilèges par défaut de ghmt_platform).
REVOKE ALL ON platform.sms_recipient_tenants FROM ghmt_app;

-- ───────── 6. Tables en ajout seul et versions de modèles immuables ─────────
-- Écart au contrat (REVOKE UPDATE, DELETE) : test/core/rls-coverage exige le DML table par table pour ghmt_app (hors audit_logs).
-- Des triggers produisent le même refus (42501) pour ghmt_app ET pour le propriétaire, sans retirer de privilège de table.
CREATE OR REPLACE FUNCTION tenant.forbid_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE TRIGGER notification_attempts_append_only
  BEFORE UPDATE OR DELETE ON tenant.notification_attempts FOR EACH ROW EXECUTE FUNCTION tenant.forbid_append_only_mutation();
CREATE TRIGGER notification_attempts_no_truncate
  BEFORE TRUNCATE ON tenant.notification_attempts FOR EACH STATEMENT EXECUTE FUNCTION tenant.forbid_append_only_mutation();
CREATE TRIGGER patient_contact_consents_append_only
  BEFORE UPDATE OR DELETE ON tenant.patient_contact_consents FOR EACH ROW EXECUTE FUNCTION tenant.forbid_append_only_mutation();
CREATE TRIGGER patient_contact_consents_no_truncate
  BEFORE TRUNCATE ON tenant.patient_contact_consents FOR EACH STATEMENT EXECUTE FUNCTION tenant.forbid_append_only_mutation();

-- Versions de modèles : seule la colonne is_active est modifiable ; aucune suppression.
CREATE OR REPLACE FUNCTION tenant.guard_notification_template() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, tenant AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notification_templates: suppression interdite' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.type_code, NEW.channel, NEW.locale, NEW.version, NEW.subject, NEW.body, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.type_code, OLD.channel, OLD.locale, OLD.version, OLD.subject, OLD.body, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'notification_templates: version immuable (seul is_active est modifiable)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_templates_guard
  BEFORE UPDATE OR DELETE ON tenant.notification_templates FOR EACH ROW EXECUTE FUNCTION tenant.guard_notification_template();
CREATE TRIGGER notification_templates_no_truncate
  BEFORE TRUNCATE ON tenant.notification_templates FOR EACH STATEMENT EXECUTE FUNCTION tenant.forbid_append_only_mutation();

-- ───────── 7. Découverte des tenants à traiter (D2) ─────────
-- Les tables tenant sont protégées par RLS (FORCE, y compris pour le propriétaire de la fonction) : la fonction se place
-- successivement dans chaque tenant, puis restaure le contexte initial. Elle ne renvoie que des identifiants de tenant.
CREATE OR REPLACE FUNCTION platform.notification_due_tenants(p_limit int DEFAULT 500)
RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, pg_temp AS $$
DECLARE
  v_previous text := COALESCE(current_setting('app.tenant_id', true), '');
  v_returned int := 0;
  v_due boolean;
  r record;
BEGIN
  FOR r IN
    SELECT t.id FROM platform.tenants t
    WHERE t.deleted_at IS NULL AND t.status <> 'terminated'
    ORDER BY t.id
  LOOP
    EXIT WHEN v_returned >= p_limit;
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
REVOKE ALL ON FUNCTION platform.notification_due_tenants(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.notification_due_tenants(int) TO ghmt_app;
