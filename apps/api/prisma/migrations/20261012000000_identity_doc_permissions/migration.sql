-- ═══════════════════════════════════════════════════════════════════════════
-- GHMT — Documents administratifs du patient : permissions (phase « Socle de production », phase 0)
-- Référence : docs/13-phase-socle-production.md §4. Exécutée par ghmt_migrator. SQL seul, aucun modèle Prisma.
-- Idempotente : peut être rejouée sans erreur ni doublon.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Permission de suppression (catalogue : patients.identity_doc) ─────────
-- `delete` est une action sensible (catalog.ts, SENSITIVE_ACTIONS).
INSERT INTO platform.permissions (code, module_code, resource, action, is_sensitive)
VALUES ('patients:identity_doc:delete', 'patients', 'identity_doc', 'delete', true)
ON CONFLICT DO NOTHING;

-- ───────── 2. Rattrapage des rôles système des établissements existants ─────────
-- Les modèles de rôles (role-templates.ts) ne s'appliquent qu'aux nouveaux établissements. Répartition (§4, arbitrage Q5) :
--   lecture  : receptionist, admin_agent, doctor, nurse, midwife, cashier
--   dépôt    : receptionist, admin_agent
--   suppression : admin_agent (l'administrateur n'a pas la lecture : arbitrage du 2026-10-11)
-- Le RLS est FORCE : le contexte tenant est posé tenant par tenant (portée transaction) puis restauré.
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
      ('receptionist', 'patients:identity_doc:read'),
      ('receptionist', 'patients:identity_doc:create'),
      ('admin_agent', 'patients:identity_doc:read'),
      ('admin_agent', 'patients:identity_doc:create'),
      ('admin_agent', 'patients:identity_doc:delete'),
      ('doctor', 'patients:identity_doc:read'),
      ('nurse', 'patients:identity_doc:read'),
      ('midwife', 'patients:identity_doc:read'),
      ('cashier', 'patients:identity_doc:read')
    ) AS grants (template_code, permission_code) ON grants.template_code = r.template_code
    JOIN platform.permissions p ON p.code = grants.permission_code
    WHERE r.tenant_id = v_tenant AND r.is_system AND r.deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(v_previous, ''), true);
END $$;
