// Synchronisation idempotente des référentiels : catalogue de permissions, plans SaaS (version 1),
// entités de facturation, et essai des établissements existants sans abonnement (docs/09 §0, §A2, §A3).
// Exécuté avec le rôle propriétaire (MIGRATION_DATABASE_URL), après `prisma migrate deploy`.
import 'dotenv/config';
import pg from 'pg';
import { ALL_PERMISSIONS, DEFAULT_BILLING_ENTITIES, DEFAULT_PLAN_CATALOG, TRIAL_DAYS, trialPlanCodeFor } from '@ghmt/shared';
import type { EstablishmentType } from '@ghmt/shared';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) throw new Error('MIGRATION_DATABASE_URL non défini');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  for (const p of ALL_PERMISSIONS) {
    await client.query(
      `INSERT INTO platform.permissions (code, module_code, resource, action, is_sensitive)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE SET is_sensitive = EXCLUDED.is_sensitive`,
      [p.code, p.moduleCode, p.resource, p.action, p.isSensitive],
    );
  }

  // Plans : version 1 créée une seule fois ; les évolutions passent par la console (nouvelle version), jamais par le seed.
  for (const plan of DEFAULT_PLAN_CATALOG) {
    await client.query(
      `INSERT INTO platform.plans (id, code, version, name, tier, price_monthly, price_yearly, currency, entitlements)
       VALUES (gen_random_uuid(), $1, 1, $2, $3::platform.plan_tier, $4, $5, $6, $7::jsonb)
       ON CONFLICT (code, version) DO NOTHING`,
      [plan.code, plan.name, plan.tier, plan.priceMonthly, plan.priceYearly, plan.currency, JSON.stringify(plan.entitlements)],
    );
  }

  for (const entity of DEFAULT_BILLING_ENTITIES) {
    await client.query(
      `INSERT INTO platform.billing_entities (id, country_code, legal_name, currency, tax_rate, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
       ON CONFLICT (country_code) DO NOTHING`,
      [entity.countryCode, entity.legalName, entity.currency, entity.taxRate],
    );
  }

  // Établissements antérieurs à la migration (sans abonnement) : essai de 30 jours à compter d'aujourd'hui.
  const { rows: orphans } = await client.query<{ id: string; establishment_type: EstablishmentType }>(
    `SELECT t.id, t.establishment_type::text AS establishment_type
     FROM platform.tenants t
     WHERE t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM platform.subscriptions s WHERE s.tenant_id = t.id)`,
  );
  for (const tenant of orphans) {
    await client.query(
      `INSERT INTO platform.subscriptions (id, tenant_id, plan_id, status, billing_period, current_period_start, current_period_end,
                                           trial_ends_at, status_changed_at, updated_at)
       SELECT gen_random_uuid(), $1::uuid, p.id, 'trial', 'monthly', now(), now() + make_interval(days => $3::int),
              now() + make_interval(days => $3::int), now(), now()
       FROM platform.plans p WHERE p.code = $2 AND p.archived_at IS NULL ORDER BY p.version DESC LIMIT 1
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenant.id, trialPlanCodeFor(tenant.establishment_type), TRIAL_DAYS],
    );
  }
  await client.query('COMMIT');
  process.stdout.write(
    `Catalogue synchronisé : ${ALL_PERMISSIONS.length} permissions, ${DEFAULT_PLAN_CATALOG.length} plans, ${DEFAULT_BILLING_ENTITIES.length} entités de facturation, ${orphans.length} essai(s) initialisé(s)\n`,
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
