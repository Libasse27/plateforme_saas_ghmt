-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Console d'administration de l'établissement (phase « Notifications + administration », équipe A)
-- Référence : docs/10-phase-notifications-admin.md §3.2. Exécutée par ghmt_migrator. SQL seul, aucun modèle Prisma.
-- Idempotente : peut être rejouée sans erreur ni doublon.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Index du filtre « action » du journal d'audit ─────────
-- Absent du schéma Prisma (core.prisma) : documenté ici seulement. Sert `GET /audit-logs?action=…` (exact et préfixe).
CREATE INDEX IF NOT EXISTS ix_audit_logs_action ON tenant.audit_logs (tenant_id, action, chain_seq DESC);

-- ───────── 2. Permission « journal des envois » (catalogue : settings.notification_log) ─────────
INSERT INTO platform.permissions (code, module_code, resource, action, is_sensitive)
VALUES ('settings:notification_log:read', 'settings', 'notification_log', 'read', false)
ON CONFLICT DO NOTHING;

-- ───────── 3. Rattrapage des rôles système des établissements existants ─────────
-- Les modèles de rôles (role-templates.ts) ne s'appliquent qu'aux nouveaux établissements : on ajoute ici
--   tenant_admin : audit:log:export, settings:notification_log:read
--   director     : settings:notification_log:read
-- aux rôles système non supprimés (jointure sur template_code). Le RLS est FORCE : le contexte tenant est posé
-- tenant par tenant (portée transaction) puis restauré.
DO $$
DECLARE
  v_previous text := current_setting('app.tenant_id', true);
  v_tenant uuid;
BEGIN
  FOR v_tenant IN SELECT id FROM platform.tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    INSERT INTO tenant.role_permissions (tenant_id, role_id, permission_code)
    SELECT r.tenant_id, r.id, grants.permission_code
    FROM tenant.roles r
    JOIN (VALUES
      ('tenant_admin', 'audit:log:export'),
      ('tenant_admin', 'settings:notification_log:read'),
      ('director', 'settings:notification_log:read')
    ) AS grants (template_code, permission_code) ON grants.template_code = r.template_code
    JOIN platform.permissions p ON p.code = grants.permission_code
    WHERE r.tenant_id = v_tenant AND r.is_system AND r.deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(v_previous, ''), true);
END $$;
